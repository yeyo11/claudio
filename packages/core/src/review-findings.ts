import { createHash } from 'node:crypto';
import type { ReviewAnchor, ReviewDimension, ReviewGateStatus, ReviewSeverity, ReviewSide, ReviewVerdict } from '@claudio/shared';

/**
 * What the gate does with findings once they are parsed: where each one sits in the diff, which are
 * the same, which block. All of it is deterministic and independent of the order the reviewers
 * finished in (docs/plans/review-gate.md, "Findings: anchoring and deduplication").
 */

/** An inclusive range of lines */
export type LineRange = readonly [start: number, end: number];

/** Per file of the diff, the line ranges its hunks cover on each side */
export type AnchorIndex = ReadonlyMap<string, { right: readonly LineRange[]; left: readonly LineRange[] }>;

export interface Locatable {
  path: string | null;
  line: number | null;
  side: ReviewSide | null;
}

/** Where a finding sits against the diff; severity and blocking never depend on it */
export function anchor(finding: Locatable, index: AnchorIndex): ReviewAnchor {
  if (!finding.path) return 'none';
  const ranges = index.get(finding.path);
  if (!ranges) return 'outside';
  if (finding.line === null) return 'file';
  const inside = (finding.side === 'left' ? ranges.left : ranges.right).some(([start, end]) => finding.line !== null && finding.line >= start && finding.line <= end);
  return inside ? 'line' : 'file';
}

/** Words that carry no meaning for telling two findings apart */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'are', 'was', 'were', 'not', 'but', 'can', 'will', 'has',
  'have', 'had', 'its', 'from', 'when', 'which', 'what', 'where', 'then', 'than', 'there', 'their', 'they',
  'them', 'into', 'out', 'any', 'all', 'one', 'also', 'only', 'does', 'did', 'been', 'being', 'would', 'could',
  'should', 'may', 'might', 'must', 'because', 'while', 'about', 'over', 'under', 'such', 'some', 'every', 'each',
  'more', 'most', 'other', 'here', 'just', 'still',
]);

const SEVERITY_RANK: Record<ReviewSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** The lowercase alphanumeric words of a text without the stop words and the words of two characters or fewer */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export interface DedupInput extends Locatable {
  source: 'model' | 'claudio';
  dimensions: readonly ReviewDimension[];
  severity: ReviewSeverity;
  confidence: number;
  title: string;
  evidence: string;
}

export type Deduped<T extends DedupInput> = T & { dimensions: ReviewDimension[]; reportedBy: number };

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function sameSpot(a: DedupInput, b: DedupInput): boolean {
  if (a.source !== b.source || a.path !== b.path || a.side !== b.side) return false;
  if (a.line === null || b.line === null) return a.line === b.line;
  return Math.abs(a.line - b.line) <= 3;
}

/** Strongest first: severity, then confidence, then the longest evidence, then text so ties are not order-dependent */
function strongerFirst(a: DedupInput, b: DedupInput): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    b.confidence - a.confidence ||
    b.evidence.length - a.evidence.length ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
    (a.evidence < b.evidence ? -1 : a.evidence > b.evidence ? 1 : 0)
  );
}

function place(a: DedupInput, b: DedupInput): number {
  return (
    (a.path ?? '').localeCompare(b.path ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) ||
    strongerFirst(a, b)
  );
}

/**
 * Findings that are the same collapse into one: same file, same side, lines within 3 (or both
 * without a line) and word sets with a Jaccard similarity of at least 0.5. A system finding only
 * merges with system findings. The kept one is the strongest of its group, with the group's
 * dimensions, its size as `reportedBy` and its largest confidence.
 */
export function dedupe<T extends DedupInput>(items: readonly T[]): Deduped<T>[] {
  const words = items.map((f) => new Set(wordsOf(`${f.title} ${f.evidence}`)));
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    return root;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const wa = words[i];
      const wb = words[j];
      if (!a || !b || !wa || !wb) continue;
      if (sameSpot(a, b) && jaccard(wa, wb) >= 0.5) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  const merged: Deduped<T>[] = [];
  for (const group of groups.values()) {
    const [kept] = [...group].sort(strongerFirst);
    if (!kept) continue;
    merged.push({
      ...kept,
      dimensions: [...new Set(group.flatMap((f) => f.dimensions))].sort(),
      reportedBy: group.length,
      confidence: Math.max(...group.map((f) => f.confidence)),
    });
  }
  return merged.sort(place);
}

/**
 * Identifies a finding across rounds: the file, the side, the line in buckets of four and its eight
 * most frequent words. Sixteen hex digits.
 */
export function fingerprint(finding: Locatable & { title: string; evidence: string }): string {
  const counts = new Map<string, number>();
  for (const w of wordsOf(`${finding.title} ${finding.evidence}`)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([w]) => w)
    .sort();
  const bucket = finding.line === null ? 'none' : String(Math.round(finding.line / 4));
  return createHash('sha256')
    .update(`${finding.path ?? ''}|${finding.side ?? ''}|${bucket}|${top.join(' ')}`)
    .digest('hex')
    .slice(0, 16);
}

export interface BlockingInput {
  source: 'model' | 'claudio';
  /** A rule of Claudio's own that blocks by itself: conflict markers, secrets */
  blockingByRule?: boolean;
  severity: ReviewSeverity;
  verdict: ReviewVerdict;
}

/** A system finding blocks by its rule; a model finding blocks when critical or high and not refuted. Medium and low are advisory. */
export function isBlocking(f: BlockingInput): boolean {
  if (f.source === 'claudio' && f.blockingByRule) return true;
  return (f.severity === 'critical' || f.severity === 'high') && (f.verdict === 'confirmed' || f.verdict === 'uncertain' || f.verdict === 'unverified');
}

/** The outcome of a round's findings and runs: blocked first, then incomplete, otherwise passed */
export function roundStatus(input: {
  blocking: number;
  /** Runs that did not end well */
  runsNotOk: number;
  /** Files that should be reviewed and could not be */
  filesNotReviewable: number;
  overBudget: boolean;
}): Extract<ReviewGateStatus, 'blocked' | 'incomplete' | 'passed'> {
  if (input.blocking > 0) return 'blocked';
  if (input.runsNotOk > 0 || input.filesNotReviewable > 0 || input.overBudget) return 'incomplete';
  return 'passed';
}

/**
 * Whether a fix made the review worse: the next round has more blocking findings than the last, or
 * a blocking finding that was not there before sits in a file the fixer changed.
 */
export function worseAfterFix(
  previous: readonly { fingerprint: string }[],
  next: readonly { fingerprint: string; path: string | null }[],
  changedByFixer: ReadonlySet<string>,
): boolean {
  if (next.length > previous.length) return true;
  const before = new Set(previous.map((f) => f.fingerprint));
  return next.some((f) => !before.has(f.fingerprint) && f.path !== null && changedByFixer.has(f.path));
}
