import type { ReviewFinding } from '@claudio/shared';
import { cutToBytes, maskSecrets } from './decisions/redact.ts';

/*
 * The review gate's deterministic scans (docs/plans/review-gate.md, "Diff collection" step 6 and
 * "Security"). They run over the diff text Claudio already holds, so they cost no model turn and
 * an injected reviewer cannot talk them out of a finding.
 */

/** One file of the review diff, reduced to what the scans read */
export interface ScanFile {
  path: string;
  /** Excluded files (lockfiles, generated output) are scanned for secrets only */
  excluded?: boolean;
  /** The added lines with their line number on the new side */
  added: ReadonlyArray<{ line: number; text: string }>;
}

/** A finding Claudio itself raised; the store gives it an id, a round and a fingerprint */
export type ScanFinding = Pick<
  ReviewFinding,
  | 'source'
  | 'rule'
  | 'dimensions'
  | 'severity'
  | 'confidence'
  | 'title'
  | 'path'
  | 'line'
  | 'side'
  | 'anchor'
  | 'evidence'
  | 'failureScenario'
  | 'suggestion'
  | 'verdict'
  | 'blocking'
>;

/** A conflict marker at the start of a line: seven characters, then a space or the end of the line */
export const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>)( |$)/;

/** Changed paths that make the security dimension run under `security: 'auto'` (case-insensitive) */
export const SECURITY_PATH_TRIGGER =
  /(^|\/)(auth|login|logout|session|token|secret|credential|crypt|password|permission|policy|acl|oauth|oidc|jwt|sql|db|database|migration|exec|spawn|shell|upload|download|fs|path|sanit|escape|cookie|cors|csrf|webhook|security|redact|proxy|tunnel|ssh|deploy|docker|\.github\/workflows)/i;

/** Added lines that make the security dimension run under `security: 'auto'` */
export const SECURITY_LINE_TRIGGER =
  /\b(exec|execSync|execFile|spawn|child_process|eval|new Function|innerHTML|dangerouslySetInnerHTML|readFile|writeFile|createWriteStream|unlink|rmSync|chmod|chown|setuid|sudo|createHash|createCipher|randomBytes|crypto\.|jwt|bcrypt|argon|Authorization|Bearer|password|secret|apiKey|api_key|token|cookie|SELECT\s|INSERT\s|UPDATE\s|DELETE\s+FROM|\.prepare\(|\.query\(|fetch\(|https?\.request|axios|XMLHttpRequest|postMessage|deserializ|pickle|yaml\.load|--no-verify|curl\s|wget\s)\b/;

/**
 * Added text addressed to an agent. A tripwire, not a filter: a hit becomes a high finding for the
 * verifier, which judges whether the text is an attempt or legitimate.
 */
export const INJECTION_TRIPWIRE =
  /(ignore (all |the )?(previous|prior|above) (instructions|rules)|disregard (the )?(instructions|rules)|you are (now )?(an? )?(ai|assistant|reviewer|language model)|as an ai\b|system prompt|<\/?pasted_content|\b(reviewers?|verifiers?|claude|the agent)\b.{0,40}\b(approve|pass|ignore|skip|report no|return no|zero findings)\b|structured_?output)/i;

/** Where a conflict marker is expected text: documentation, and the fixtures that hold examples of one */
const MARKER_EXEMPT_PATH = /\.md$|(^|\/)(fixtures?|__fixtures__)\//i;
const REVIEWER_FILE = /(^|\/)\.claude\/agents\/claudio-review-[^/]+\.md$/;
const FENCE = /^\s*(?:\*|\/\/|#)?\s*(?:```|~~~)/;
/** More than a finding needs to quote; the evidence is read by people and later prompts */
const EVIDENCE_BYTES = 400;

const EVIDENCE_NOTE = 'the line is quoted masked';

const system = (
  rule: string,
  fields: Pick<ScanFinding, 'severity' | 'title' | 'path' | 'failureScenario' | 'blocking'> &
    Partial<Pick<ScanFinding, 'line' | 'evidence' | 'verdict' | 'dimensions'>>,
): ScanFinding => ({
  source: 'claudio',
  rule,
  dimensions: ['correctness'],
  confidence: 1,
  line: null,
  side: fields.line === undefined ? null : 'right',
  anchor: fields.line === undefined ? 'file' : 'line',
  evidence: '',
  suggestion: null,
  verdict: 'deterministic',
  ...fields,
});

const evidenceOf = (text: string): string => cutToBytes(maskSecrets(text.trim()), EVIDENCE_BYTES);

/**
 * Lines inside a fenced example (a Markdown block in a comment or a template string) are skipped by
 * the conflict scan: the fence is told from its own line, and only added lines are seen, so an
 * example whose fence is not in the diff is still reported.
 */
function* unfencedLines(file: ScanFile): Generator<{ line: number; text: string }> {
  let inFence = false;
  for (const added of file.added) {
    if (FENCE.test(added.text)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) yield added;
  }
}

/**
 * The four scans over the added lines of a review diff. Findings are ordered by file, then line,
 * then rule, so the same diff always gives the same list.
 */
export function scanDiff(files: readonly ScanFile[]): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // Secrets are checked everywhere, generated and locked files included: a key does not become
    // harmless because a tool wrote it
    for (const added of file.added) {
      if (maskSecrets(added.text) === added.text) continue;
      found.push(
        system('secret', {
          severity: 'critical',
          blocking: true,
          dimensions: ['security'],
          title: 'A secret is committed in this change',
          path: file.path,
          line: added.line,
          evidence: evidenceOf(added.text),
          failureScenario: `An added line holds what looks like a credential (${EVIDENCE_NOTE}). Once merged it is in the history for everyone with read access.`,
        }),
      );
    }
    if (REVIEWER_FILE.test(file.path)) {
      found.push(
        system('reviewer-file', {
          severity: 'high',
          blocking: false,
          dimensions: ['security'],
          title: "This change edits a reviewer's role",
          path: file.path,
          failureScenario: "This change edits a reviewer's role; the review used the checkout's version, not this one.",
        }),
      );
    }
    if (file.excluded === true) continue;
    if (!MARKER_EXEMPT_PATH.test(file.path)) {
      for (const added of unfencedLines(file)) {
        if (!CONFLICT_MARKER.test(added.text)) continue;
        found.push(
          system('conflict-marker', {
            severity: 'critical',
            blocking: true,
            title: 'A merge conflict marker is committed',
            path: file.path,
            line: added.line,
            evidence: evidenceOf(added.text),
            failureScenario: 'The file still holds a conflict marker, so it does not parse or build as intended.',
          }),
        );
      }
    }
    for (const added of file.added) {
      if (!INJECTION_TRIPWIRE.test(added.text)) continue;
      found.push(
        system('injection-tripwire', {
          severity: 'high',
          blocking: false,
          dimensions: ['security'],
          title: 'Added text addresses an agent',
          path: file.path,
          line: added.line,
          evidence: evidenceOf(added.text),
          failureScenario: 'An added line reads as an instruction to an AI reviewer or agent, which may try to steer the review.',
          verdict: 'not-asked',
        }),
      );
    }
  }
  return found.sort(
    (a, b) =>
      (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || (a.rule ?? '').localeCompare(b.rule ?? ''),
  );
}

/** Whether the diff touches security-sensitive paths or adds lines that do, for `security: 'auto'` */
export function securityTriggered(files: readonly ScanFile[]): boolean {
  return files.some(
    (file) => SECURITY_PATH_TRIGGER.test(file.path) || file.added.some((added) => SECURITY_LINE_TRIGGER.test(added.text)),
  );
}
