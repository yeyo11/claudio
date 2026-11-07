import type { ReviewFinding } from '@claudio/shared';
import { cutToBytes, maskKnown, maskSecrets, SECRET_MASK } from './decisions/redact.ts';

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

// ---------- credentials ----------

/**
 * Values that are credentials by their own shape, whatever they are called. The `random` ones have
 * a prefix that ordinary text can carry too (`sk-`, `Bearer`), so their body must also look random.
 */
export const CREDENTIAL_SHAPES: ReadonlyArray<{ kind: string; pattern: RegExp; random?: true }> = [
  { kind: 'private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'provider API key', pattern: /\bsk-(?:ant-[a-z0-9]{2,8}-|proj-|svcacct-|admin-)?([A-Za-z0-9_-]{24,})/g, random: true },
  { kind: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { kind: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { kind: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[0-9]{6,}-[A-Za-z0-9-]{6,}/g },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'Stripe key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}/g },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: 'bearer token', pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, random: true },
  // A chat's API token: Claudio gives it the prefix so a leaked one is recognised
  { kind: 'Claudio chat token', pattern: /\bagc_([A-Za-z0-9_-]{20,})/g, random: true },
];

/**
 * A name that says its value is a secret. It only counts with a quoted literal after it, or alone
 * on an environment or YAML line: a type annotation (`token: string`), a counter
 * (`input_tokens: 12`) or a flag (`secrets: false`) has no value that looks random, so it never is one.
 */
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|signing[_-]?key)[A-Za-z0-9_.-]*';
/** `name: "value"`, `"name": "value"`, `name = 'value'`, `name := "value"`, `name => 'value'` */
const NAMED_LITERAL = new RegExp(`(?:^|[^A-Za-z0-9_])(${SECRET_NAME})["']?\\s*(?::=|=>|[:=])\\s*(["'\`])([^"'\`\\s]{16,})\\2`, 'gi');
/** `API_KEY=value` or `api_key: value` alone on its line: a `.env`, a shell script, YAML */
const NAMED_LINE = new RegExp(`^\\s*(?:export\\s+)?(${SECRET_NAME})\\s*[:=]\\s*([^\\s"'\`#]{16,})\\s*(?:#.*)?$`, 'i');
/** What a generated key or token is made of */
const TOKEN_CHARS = /^[A-Za-z0-9+/=_.~-]+$/;
/** Words a made-up value carries */
const PLACEHOLDER = /x{4,}|\.{3}|example|placeholder|your[-_]|changeme|redacted|dummy|sample|fake|mock|test/i;

/** Bits per character of a string's own distribution of characters */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/**
 * Whether a value looks generated rather than written: long, letters and digits, varied, no
 * placeholder words, and not words joined by separators (`claudio-session-v2-refresh`).
 */
export function looksRandom(value: string): boolean {
  if (value.length < 16 || !TOKEN_CHARS.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  const segments = value.split(/[-_.]/).filter(Boolean);
  if (segments.length > 1 && segments.every((s) => s.length <= 2 || /^[A-Za-z]+$/.test(s))) return false;
  return entropy(value) >= 3;
}

/** The credential-shaped values of one line, each with what it looks like; a name alone is never one */
export function credentialsIn(text: string): Array<{ kind: string; value: string }> {
  const found: Array<{ kind: string; value: string }> = [];
  for (const { kind, pattern, random } of CREDENTIAL_SHAPES) {
    for (const m of text.matchAll(pattern)) {
      if (random && !looksRandom(m[1] ?? '')) continue;
      found.push({ kind, value: m[0] });
    }
  }
  for (const m of text.matchAll(NAMED_LITERAL)) {
    const value = m[3] ?? '';
    if (looksRandom(value)) found.push({ kind: `value of ${m[1] ?? 'a secret'}`, value });
  }
  const line = NAMED_LINE.exec(text);
  if (line && looksRandom(line[2] ?? '')) found.push({ kind: `value of ${line[1] ?? 'a secret'}`, value: line[2] ?? '' });
  // A secret Claudio holds itself (its owner's token, a webhook secret), recognised by its value
  if (maskKnown(text) !== text) found.push({ kind: 'a secret Claudio holds', value: '' });
  return found;
}

/**
 * Tests and fixtures hold made-up credentials on purpose, so a hit there is advisory: a directory of
 * that name anywhere in the path, or a file named as a test.
 */
export const TEST_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|specs?|e2e|fixtures?|__fixtures__|testdata|recordings)\/|\.(test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$/i;

/** The line with every detected value replaced by the mask, then masked the usual way on top */
function maskedLine(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value) out = out.split(value).join(SECRET_MASK);
  return maskSecrets(out);
}

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
    // harmless because a tool wrote it. In a test or a fixture it is most likely made up: advisory.
    const advisory = TEST_PATH.test(file.path);
    for (const added of file.added) {
      const hits = credentialsIn(added.text);
      if (hits.length === 0) continue;
      const kinds = [...new Set(hits.map((h) => h.kind))].join(', ');
      found.push(
        system('secret', {
          severity: advisory ? 'medium' : 'critical',
          blocking: !advisory,
          dimensions: ['security'],
          title: advisory ? 'A credential-shaped value is in a test or fixture' : 'A secret is committed in this change',
          path: file.path,
          line: added.line,
          evidence: cutToBytes(maskedLine(added.text.trim(), hits.map((h) => h.value)), EVIDENCE_BYTES),
          failureScenario: advisory
            ? `An added line of a test or fixture holds what looks like a credential (${kinds}; ${EVIDENCE_NOTE}). Tests usually hold made-up ones; if this one is real, it is in the history for everyone with read access once merged.`
            : `An added line holds what looks like a credential (${kinds}; ${EVIDENCE_NOTE}). Once merged it is in the history for everyone with read access.`,
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
