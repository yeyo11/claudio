import { DIFF_SAFE, gitRaw, diffFiles } from './git.ts';

/**
 * What the review gate's reviewers are given to read: the diff between the orchestration's base and
 * the integration head, classified, cut into chunks and indexed by hunk. Plan: review-gate.md,
 * "Diff collection". Only committed content is read, from the two commits and never the working
 * tree, and every git call goes through `gitRaw` (no shell, no pager).
 */

/** Text of diff a chunk may hold, about 30k tokens */
export const CHUNK_BYTES = 120 * 1024;
/** At `light`, chunks are twice as large */
export const LIGHT_CHUNK_BYTES = 240 * 1024;
/** Past this many chunks, the files left are not reviewable */
export const MAX_CHUNKS = 8;
/** A deleted file shows this many removed lines */
export const DELETED_LINES = 200;

const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'Cargo.lock', 'poetry.lock',
  'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
]);

/** Generated output, in gitignore syntax like the graph's own `exclude` */
export const DEFAULT_REVIEW_EXCLUDES = [
  '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '**/node_modules/**', '**/vendor/**',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.snap', '**/__snapshots__/**',
];

export type ReviewFileClass = 'excluded' | 'binary' | 'submodule' | 'renamed-pure' | 'deleted' | 'reviewable';

/** A hunk's side as the `@@` header gives it: `count` lines from `start` (count 0: a point between lines) */
export interface HunkRange {
  start: number;
  count: number;
}

export interface HunkRanges {
  /** `-a,b` of every hunk */
  old: HunkRange[];
  /** `+c,d` of every hunk */
  new: HunkRange[];
}

export interface AddedLine {
  /** Line number on the new side */
  line: number;
  text: string;
}

export interface ReviewDiffFile {
  path: string;
  /** Where a rename came from */
  previousPath?: string;
  /** git's status letter and score: `M`, `A`, `D`, `R087` */
  status: string;
  class: ReviewFileClass;
  /** Why the file is excluded (class `excluded`) */
  excludedBy?: string;
  /** Set when the file should be reviewed and cannot be: the round is then incomplete */
  notReviewable?: string;
  additions: number;
  deletions: number;
  /** Lines the change added, for the scans; empty for binary files and submodules */
  added: AddedLine[];
  hunks: HunkRanges;
  /** Submodule pointer, short ids */
  submodule?: { from: string | null; to: string | null };
}

/** One file, or part of one, inside a chunk */
export interface ReviewChunkItem {
  path: string;
  /** "part 2 of 3" of a file split at hunk boundaries */
  part: { index: number; of: number } | null;
  text: string;
  bytes: number;
}

export interface ReviewChunk {
  index: number;
  items: ReviewChunkItem[];
  bytes: number;
}

export interface ReviewDiffNote {
  kind: 'binary' | 'submodule' | 'lockfile';
  path: string;
  /** English, Claudio's own sentence; advisory */
  message: string;
}

export interface ReviewSkipped {
  path: string;
  kind: 'excluded' | 'not-reviewable';
  reason: string;
}

/** What the deterministic scans (review-scan.ts) are given for each file with added lines */
export interface ReviewScanFile {
  path: string;
  class: ReviewFileClass;
  added: AddedLine[];
}

export interface ReviewDiffOptions<H extends { blocking: boolean }> {
  worktree: string;
  base: string;
  head: string;
  /** Globs added to the built-in exclusions */
  exclude?: string[];
  depth?: 'light' | 'full';
  /** Replaces the depth's chunk size; tests use it to avoid megabyte fixtures */
  chunkBytes?: number;
  maxChunks?: number;
  /** The scans: given every file that has added lines, excluded ones included */
  scan?: (files: ReviewScanFile[]) => H[];
}

export interface ReviewDiff<H extends { blocking: boolean } = { blocking: boolean }> {
  files: ReviewDiffFile[];
  chunks: ReviewChunk[];
  skipped: ReviewSkipped[];
  notes: ReviewDiffNote[];
  /** The hunk ranges of each file with a diff, keyed by path: what finding anchoring reads */
  anchors: Record<string, HunkRanges>;
  /** What the scan hook returned */
  hits: H[];
  /** Set when the round passes without a review, with Claudio's reason */
  empty: { reason: string } | null;
  stats: {
    files: number;
    reviewable: number;
    notReviewable: number;
    excluded: number;
    additions: number;
    deletions: number;
    bytes: number;
    chunks: number;
  };
}

// ---------- exclusions ----------

/** A gitignore-style pattern as a regular expression over a `/`-separated path */
function globRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  // Without a slash, the pattern matches at any depth, like gitignore
  const floating = !anchored && !p.includes('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern naming a directory also covers what is inside it
  const tail = dirOnly ? '/.*' : '(?:/.*)?';
  return new RegExp(`^${floating ? '(?:.*/)?' : ''}${re}${tail}$`);
}

function matcher(globs: string[]): (path: string) => string | null {
  const compiled = globs.filter((g) => g.trim() && !g.trim().startsWith('#')).map((g) => ({ g, re: globRegExp(g) }));
  return (path) => compiled.find((c) => c.re.test(path))?.g ?? null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// ---------- classification ----------

export interface RawEntry {
  /** `M`, `A`, `D`, `T`, `R087`… */
  status: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  path: string;
  previousPath?: string;
}

/** The class a file takes, given whether it is excluded and whether numstat called it binary */
export function classify(entry: Pick<RawEntry, 'status' | 'oldMode' | 'newMode'>, binary: boolean, excluded: boolean): ReviewFileClass {
  if (excluded) return 'excluded';
  if (entry.oldMode === '160000' || entry.newMode === '160000') return 'submodule';
  if (binary) return 'binary';
  if (entry.status === 'R100') return 'renamed-pure';
  if (entry.status.startsWith('D')) return 'deleted';
  return 'reviewable';
}

/** `git diff --raw -z` entries: `:old new oldsha newsha STATUS\0path\0[path\0]` */
function parseRaw(out: string): RawEntry[] {
  const parts = out.split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(parts[i] ?? '');
    if (!m) continue;
    const status = m[5] as string;
    const renamed = status.startsWith('R') || status.startsWith('C');
    const first = parts[++i];
    if (first === undefined) break;
    const base = { status, oldMode: m[1] as string, newMode: m[2] as string, oldSha: m[3] as string, newSha: m[4] as string };
    if (renamed) {
      const second = parts[++i];
      if (second === undefined) break;
      entries.push({ ...base, path: second, previousPath: first });
    } else entries.push({ ...base, path: first });
  }
  return entries;
}

// ---------- hunks ----------

function range(start: string | undefined, count: string | undefined): HunkRange {
  return { start: Number(start), count: count === undefined || count === '' ? 1 : Number(count) };
}

/** The old and new line ranges every hunk of a unified diff covers */
export function hunkRanges(diff: string): HunkRanges {
  const out: HunkRanges = { old: [], new: [] };
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    out.old.push(range(m[1], m[2]));
    out.new.push(range(m[3], m[4]));
  }
  return out;
}

interface ParsedDiff {
  /** Everything before the first hunk: `diff --git`, mode, rename and `---`/`+++` lines */
  header: string;
  /** Each hunk with its `@@` line, ending in a newline */
  hunks: string[];
  added: AddedLine[];
}

function parseDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header: string[] = [];
  const hunks: string[][] = [];
  const added: AddedLine[] = [];
  let newLine = 0;
  for (const line of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      hunks.push([line]);
      newLine = Number(m[1]);
      continue;
    }
    const current = hunks[hunks.length - 1];
    if (!current) {
      header.push(line);
      continue;
    }
    current.push(line);
    if (line.startsWith('+')) added.push({ line: newLine++, text: line.slice(1) });
    else if (!line.startsWith('-') && !line.startsWith('\\')) newLine++;
  }
  return {
    header: header.length ? `${header.join('\n')}\n` : '',
    hunks: hunks.map((h) => `${h.join('\n')}\n`),
    added,
  };
}

/** The sections of a multi-file diff, in the order git wrote them */
function splitSections(out: string): string[] {
  if (!out) return [];
  const sections: string[] = [];
  let start = 0;
  for (let at = out.indexOf('\ndiff --git ', 0); at !== -1; at = out.indexOf('\ndiff --git ', at + 1)) {
    sections.push(out.slice(start, at + 1));
    start = at + 1;
  }
  sections.push(out.slice(start));
  return sections;
}

// ---------- packing ----------

interface Unit {
  items: ReviewChunkItem[];
  bytes: number;
}

const bytesOf = (text: string): number => Buffer.byteLength(text);

function packageOf(path: string): string {
  const segments = path.split('/');
  return segments.slice(0, Math.min(2, segments.length - 1)).join('/');
}

/** `x.test.ts`, `x.spec.ts` and `test/x.ts` are the tests of `x.ts`: what they are tests of, or null */
function testedStem(path: string): string | null {
  const name = basename(path);
  const m = /^(.*)\.(?:test|spec)(\.[^.]+)?$/.exec(name);
  if (m) return `${packageOf(path)}:${m[1]}`;
  if (/(^|\/)(tests?|__tests__)\//.test(path)) return `${packageOf(path)}:${name.replace(/\.[^.]+$/, '')}`;
  return null;
}

function sourceStem(path: string): string {
  return `${packageOf(path)}:${basename(path).replace(/\.[^.]+$/, '')}`;
}

interface FileText {
  path: string;
  header: string;
  hunks: string[];
}

/**
 * Cuts a file's diff into parts of at most `limit` bytes at hunk boundaries. Null when one hunk,
 * with the header, is larger than a chunk: it cannot be reviewed.
 */
function splitFile(file: FileText, limit: number): ReviewChunkItem[] | null {
  const whole = file.header + file.hunks.join('');
  if (bytesOf(whole) <= limit) return [{ path: file.path, part: null, text: whole, bytes: bytesOf(whole) }];
  const groups: string[][] = [];
  let current: string[] = [];
  let size = bytesOf(file.header);
  for (const hunk of file.hunks) {
    const b = bytesOf(hunk);
    if (bytesOf(file.header) + b > limit) return null;
    if (size + b > limit && current.length) {
      groups.push(current);
      current = [];
      size = bytesOf(file.header);
    }
    current.push(hunk);
    size += b;
  }
  if (current.length) groups.push(current);
  return groups.map((g, i) => {
    const text = file.header + g.join('');
    return { path: file.path, part: { index: i + 1, of: groups.length }, text, bytes: bytesOf(text) };
  });
}

/**
 * Greedy packing in path order, packages together, a source with its test in the same chunk when the
 * pair fits. Returns every chunk (the caller applies `MAX_CHUNKS`) and the files that cannot be put in
 * any chunk.
 */
export function pack(files: FileText[], limit: number): { chunks: ReviewChunk[]; unfit: Map<string, string> } {
  const unfit = new Map<string, string>();
  const sorted = [...files].sort((a, b) => {
    const pa = packageOf(a.path);
    const pb = packageOf(b.path);
    return pa === pb ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : pa < pb ? -1 : 1;
  });

  const itemsOf = new Map<string, ReviewChunkItem[]>();
  for (const f of sorted) {
    const parts = splitFile(f, limit);
    if (parts) itemsOf.set(f.path, parts);
    else unfit.set(f.path, 'a single change is larger than a review chunk');
  }

  // A test is packed with its source: one unit while both are whole and fit together, else one after the other
  const unitFor = (items: ReviewChunkItem[]): Unit => ({ items, bytes: items.reduce((n, i) => n + i.bytes, 0) });
  const hasSource = new Set<string>();
  for (const f of sorted) if (itemsOf.has(f.path) && testedStem(f.path) === null) hasSource.add(sourceStem(f.path));
  const units: Unit[] = [];
  for (const f of sorted) {
    const items = itemsOf.get(f.path);
    if (!items) continue;
    const stem = testedStem(f.path);
    // Handled with its source, which is in the diff
    if (stem !== null && hasSource.has(stem)) continue;
    const tests = stem === null ? sorted.filter((t) => itemsOf.has(t.path) && testedStem(t.path) === sourceStem(f.path)) : [];
    const testItems = tests.flatMap((t) => itemsOf.get(t.path) as ReviewChunkItem[]);
    const all = [...items, ...testItems];
    if (testItems.length && items.length === 1 && tests.every((t) => itemsOf.get(t.path)?.length === 1) && unitFor(all).bytes <= limit) units.push(unitFor(all));
    else units.push(...all.map((i) => unitFor([i])));
  }

  const chunks: ReviewChunk[] = [];
  let open: ReviewChunk | null = null;
  for (const unit of units) {
    if (!open || open.bytes + unit.bytes > limit) {
      open = { index: chunks.length, items: [], bytes: 0 };
      chunks.push(open);
    }
    open.items.push(...unit.items);
    open.bytes += unit.bytes;
  }
  return { chunks, unfit };
}

// ---------- collection ----------

const ATTR_BATCH = 200;
const PATH_BATCH = 200;
const DIFF_BUFFER = 16 * 1024 * 1024;

/** Paths git's attributes call generated, read from the head commit and not from the working tree */
function generatedByAttribute(worktree: string, head: string, paths: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < paths.length; i += ATTR_BATCH) {
    const batch = paths.slice(i, i + ATTR_BATCH);
    const raw = gitRaw(worktree, ['--literal-pathspecs', 'check-attr', '--source', head, '-z', 'linguist-generated', '--', ...batch], { timeout: 30_000 });
    const parts = raw.split('\0');
    for (let j = 0; j + 2 < parts.length; j += 3) if (parts[j + 2] === 'true' || parts[j + 2] === 'set') out.add(parts[j] as string);
  }
  return out;
}

function isGeneratedHeader(added: AddedLine[]): boolean {
  return added.slice(0, 5).some((l) => /@generated|DO NOT EDIT/.test(l.text));
}

function diffArgs(paths: string[]): string[] {
  return ['--literal-pathspecs', ...DIFF_SAFE, 'diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=5'].concat(paths);
}

/** The diff text of each entry in `entries`' order, or null for an entry whose diff could not be read */
function readDiffs(worktree: string, base: string, head: string, entries: RawEntry[]): (string | null)[] {
  const result: (string | null)[] = [];
  for (let i = 0; i < entries.length; i += PATH_BATCH) {
    const batch = entries.slice(i, i + PATH_BATCH);
    const paths = batch.flatMap((e) => (e.previousPath ? [e.previousPath, e.path] : [e.path]));
    const args = [...diffArgs([base, head, '--', ...paths])];
    let sections: string[] | null = null;
    try {
      sections = splitSections(gitRaw(worktree, args, { timeout: 120_000, maxBuffer: DIFF_BUFFER }));
    } catch {
      sections = null;
    }
    // One section per entry, in the order the raw listing gave; if that does not hold, ask one by one
    if (sections && sections.length === batch.length) {
      result.push(...sections);
      continue;
    }
    for (const e of batch) {
      try {
        const own = e.previousPath ? [e.previousPath, e.path] : [e.path];
        result.push(gitRaw(worktree, diffArgs([base, head, '--', ...own]), { timeout: 120_000, maxBuffer: DIFF_BUFFER }));
      } catch {
        result.push(null);
      }
    }
  }
  return result;
}

function deletedText(parsed: ParsedDiff): string {
  const removed: string[] = [];
  let total = 0;
  for (const hunk of parsed.hunks) {
    for (const line of hunk.split('\n')) {
      if (!line.startsWith('-')) continue;
      total++;
      if (removed.length < DELETED_LINES) removed.push(line);
    }
  }
  const first = parsed.hunks[0]?.split('\n', 1)[0] ?? '';
  const more = total > removed.length ? `… ${total - removed.length} more lines removed\n` : '';
  return `${parsed.header}${first}\n${removed.join('\n')}\n${more}`;
}

const short = (sha: string | null): string | null => (sha && !/^0+$/.test(sha) ? sha.slice(0, 8) : null);

export function collectReviewDiff<H extends { blocking: boolean } = { blocking: boolean }>(opts: ReviewDiffOptions<H>): ReviewDiff<H> {
  const { worktree, base, head } = opts;
  const limit = opts.chunkBytes ?? (opts.depth === 'light' ? LIGHT_CHUNK_BYTES : CHUNK_BYTES);
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
  const result: ReviewDiff<H> = {
    files: [], chunks: [], skipped: [], notes: [], anchors: {}, hits: [], empty: null,
    stats: { files: 0, reviewable: 0, notReviewable: 0, excluded: 0, additions: 0, deletions: 0, bytes: 0, chunks: 0 },
  };

  const sha = (ref: string) => gitRaw(worktree, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { timeout: 30_000 }).trim();
  if (base === head || sha(base) === sha(head)) {
    result.empty = { reason: 'no change against the base' };
    return result;
  }

  // 1. List the files
  const entries = parseRaw(gitRaw(worktree, ['-c', 'core.quotePath=false', ...DIFF_SAFE, 'diff', '--raw', '--no-abbrev', '-z', '-M', '--no-ext-diff', '--no-textconv', base, head, '--'], { timeout: 60_000, maxBuffer: DIFF_BUFFER }));
  const counts = new Map(diffFiles(worktree, base, head).map((f) => [f.path, f]));

  // 2-3. Classify; the exclusions that need no content first
  const excludedBy = matcher([...DEFAULT_REVIEW_EXCLUDES, ...(opts.exclude ?? [])]);
  const custom = new Set(opts.exclude ?? []);
  const pathExclusion = (path: string): string | null => {
    if (LOCKFILES.has(basename(path))) return 'lockfile';
    const g = excludedBy(path);
    if (!g) return null;
    return custom.has(g) ? `excluded by the graph: ${g}` : `generated output (${g})`;
  };
  const candidates = entries.filter((e) => e.oldMode !== '160000' && e.newMode !== '160000' && !e.status.startsWith('D'));
  const attrGenerated = generatedByAttribute(worktree, head, candidates.filter((e) => !pathExclusion(e.path)).map((e) => e.path));

  // 4. Read the diffs of every file with text, excluded ones too (the secret scan reads them)
  const readable = entries.filter((e) => {
    const c = counts.get(e.path);
    return e.oldMode !== '160000' && e.newMode !== '160000' && !c?.binary && e.status !== 'R100';
  });
  const texts = new Map<string, string | null>();
  readDiffs(worktree, base, head, readable).forEach((t, i) => texts.set((readable[i] as RawEntry).path, t));

  const bodies = new Map<string, FileText>();
  const unread: string[] = [];
  for (const e of entries) {
    const c = counts.get(e.path);
    const binary = c?.binary === true;
    const text = texts.get(e.path) ?? null;
    const parsed = text === null ? null : parseDiff(text);
    let reason = pathExclusion(e.path);
    if (!reason && attrGenerated.has(e.path)) reason = 'marked linguist-generated';
    if (!reason && parsed && isGeneratedHeader(parsed.added)) reason = 'generated file header';
    const cls = classify(e, binary, reason !== null);
    const file: ReviewDiffFile = {
      path: e.path,
      ...(e.previousPath !== undefined ? { previousPath: e.previousPath } : {}),
      status: e.status,
      class: cls,
      ...(reason ? { excludedBy: reason } : {}),
      additions: c?.additions ?? 0,
      deletions: c?.deletions ?? 0,
      added: parsed?.added ?? [],
      hunks: parsed ? hunkRanges(text as string) : { old: [], new: [] },
    };
    if (cls === 'submodule') file.submodule = { from: short(e.oldSha), to: short(e.newSha) };
    result.files.push(file);
    if (parsed && cls !== 'excluded') result.anchors[e.path] = file.hunks;

    // Advisory notes
    if (cls === 'binary' && (e.status.startsWith('A') || e.status.startsWith('M'))) {
      result.notes.push({ kind: 'binary', path: e.path, message: `binary file ${e.status.startsWith('A') ? 'added' : 'modified'}: ${e.path}; its contents were not reviewed` });
    } else if (cls === 'submodule') {
      result.notes.push({ kind: 'submodule', path: e.path, message: `submodule moved from ${file.submodule?.from ?? 'nothing'} to ${file.submodule?.to ?? 'nothing'}; its contents were not reviewed` });
    } else if (reason === 'lockfile') {
      result.notes.push({ kind: 'lockfile', path: e.path, message: `${file.additions + file.deletions} dependency lines changed in ${e.path}` });
    }

    if (cls === 'reviewable' || cls === 'deleted') {
      if (!parsed) {
        unread.push(e.path);
        file.notReviewable = 'its diff could not be read';
      } else if (cls === 'deleted') {
        bodies.set(e.path, { path: e.path, header: '', hunks: [deletedText(parsed)] });
      } else if (parsed.hunks.length > 0) {
        // A mode change or an empty file has no hunk: nothing to read, and not a gap in the review
        bodies.set(e.path, { path: e.path, header: parsed.header, hunks: parsed.hunks });
      }
    }
  }

  // 7. Chunking
  const { chunks, unfit } = pack([...bodies.values()], limit);
  const kept = chunks.slice(0, maxChunks);
  const dropped = new Set(chunks.slice(maxChunks).flatMap((c) => c.items.map((i) => i.path)));
  for (const f of result.files) {
    const reason = unfit.get(f.path) ?? (dropped.has(f.path) ? "over the review's size budget" : undefined);
    if (reason) f.notReviewable = reason;
  }
  const notReviewable = new Set(result.files.filter((f) => f.notReviewable).map((f) => f.path));
  result.chunks = kept
    .map((c) => {
      const items = c.items.filter((i) => !notReviewable.has(i.path));
      return { index: c.index, items, bytes: items.reduce((n, i) => n + i.bytes, 0) };
    })
    .filter((c) => c.items.length > 0)
    .map((c, index) => ({ ...c, index }));

  for (const f of result.files) {
    if (f.class === 'excluded') result.skipped.push({ path: f.path, kind: 'excluded', reason: f.excludedBy ?? 'excluded' });
    else if (f.notReviewable) result.skipped.push({ path: f.path, kind: 'not-reviewable', reason: f.notReviewable });
  }

  // 6. The scans are the caller's: they see every file with added lines
  if (opts.scan) result.hits = opts.scan(result.files.filter((f) => f.added.length > 0).map((f) => ({ path: f.path, class: f.class, added: f.added })));

  // 8. Empty
  const toRead = result.files.filter((f) => f.class === 'reviewable' || f.class === 'deleted');
  if (toRead.length === 0 && !result.hits.some((h) => h.blocking)) {
    const nonExcluded = result.files.filter((f) => f.class !== 'excluded');
    if (result.files.length > 0 && nonExcluded.length === 0) {
      const names = result.files.map((f) => f.path);
      result.empty = { reason: `only excluded files changed: ${names.slice(0, 5).join(', ')}${names.length > 5 ? `, … ${names.length - 5} more` : ''}` };
    } else result.empty = { reason: 'nothing to review' };
  }

  result.stats = {
    files: result.files.length,
    reviewable: result.files.filter((f) => (f.class === 'reviewable' || f.class === 'deleted') && !f.notReviewable).length,
    notReviewable: notReviewable.size,
    excluded: result.files.filter((f) => f.class === 'excluded').length,
    additions: result.files.reduce((n, f) => n + f.additions, 0),
    deletions: result.files.reduce((n, f) => n + f.deletions, 0),
    bytes: result.chunks.reduce((n, c) => n + c.bytes, 0),
    chunks: result.chunks.length,
  };
  return result;
}
