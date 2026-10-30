import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChangedFile, ChangedFileStatus, Commit } from '@claudio/shared';

/**
 * The few git operations orchestrations need to hand back one branch instead of a pile of
 * worktrees. Everything runs through `execFileSync` with arguments, never a shell string, and
 * throws with git's own message so a caller can show it as-is.
 */
export function git(cwd: string, args: string[], timeout = 60_000): string {
  return gitRaw(cwd, args, { timeout }).trim();
}

/** Like {@link git} but leaves the output as git wrote it: a `-z` list or a diff loses meaning when trimmed. */
export function gitRaw(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      stdio: 'pipe',
      timeout: opts.timeout ?? 60_000,
      encoding: 'utf8',
      ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
    });
  } catch (err) {
    throw gitFailure(args, err);
  }
}

/** The error a failed git call becomes, whether it ran sync or async: git's own words, trimmed. */
function gitFailure(args: string[], err: unknown): Error {
  const e = err as { stderr?: string; stdout?: string; message: string; code?: string };
  // Output past `maxBuffer` is not git's failure: say so plainly, and keep the code a caller checks
  if (e.code === 'ENOBUFS' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return Object.assign(new Error(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]}: output too large`), { code: 'ENOBUFS' });
  }
  const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || e.message;
  // A leading global option (`--literal-pathspecs`) is not what failed
  return new Error(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]}: ${detail.split('\n').slice(0, 6).join('\n')}`);
}

/**
 * {@link git} for a repository whose owner did not ask for an eval: none of their hooks
 * (`post-checkout` included) and no fsmonitor daemon may start because Claudio checked something out.
 */
export function evalGit(cwd: string, args: string[], timeout = 60_000): string {
  return git(cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], timeout);
}

export function isGitRepo(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--git-dir'], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** The checkout `dir` belongs to, which is where the CLI keeps its worktrees whatever subdirectory it runs in. */
export function topLevel(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel'], 10_000);
}

/**
 * The top level of the main checkout `dir` belongs to. Inside a linked worktree `topLevel` is that
 * worktree, but the CLI keeps the checkouts it makes for `--worktree` under the main one.
 */
export function mainTopLevel(dir: string): string {
  return dirname(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000));
}

/**
 * The main checkout's top level as a person sees it, which `mainTopLevel` is not for a submodule: its
 * git directory lives under the superproject's `.git/modules/`, and a directory next to that is no
 * checkout at all. Only for worktrees Claudio makes and opens itself; a `--worktree` the CLI adopts
 * stays where `mainTopLevel` says, which is where the CLI looks.
 */
export function mainCheckout(dir: string): string {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000);
  // In the main checkout its own top level is the answer, and the only right one for a submodule,
  // whose git directory lives under the superproject's `.git/modules/`
  if (resolve(git(dir, ['rev-parse', '--absolute-git-dir'], 10_000)) === resolve(common)) return topLevel(dir);
  // A linked worktree of a submodule: the main checkout is where its common directory says it is
  let configured = '';
  try {
    configured = git(dir, ['config', '--file', join(common, 'config'), 'core.worktree'], 10_000);
  } catch {
    /* not set: the main checkout holds its `.git` */
  }
  return configured ? resolve(common, configured) : dirname(common);
}

export interface WorktreeEntry {
  path: string;
  /** The branch checked out there, without `refs/heads/`; null when detached */
  branch: string | null;
  /** The reason it was locked with, `''` when locked with none; null when not locked */
  locked: string | null;
  /** The bare repository itself, listed first where a main checkout would be */
  bare: boolean;
  detached: boolean;
  /** Its directory is gone: git would prune it */
  prunable: boolean;
}

/**
 * Every worktree git knows of in `repo`'s repository, the main checkout first. The list path reads
 * git's files instead (`worktreesOf` in `repos.ts`); this is its oracle and its fallback.
 */
export function worktrees(repo: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const line of git(repo, ['worktree', 'list', '--porcelain'], 10_000).split('\n')) {
    if (line.startsWith('worktree ')) entries.push({ path: line.slice('worktree '.length), branch: null, locked: null, bare: false, detached: false, prunable: false });
    const last = entries[entries.length - 1];
    if (!last) continue;
    if (line.startsWith('branch ')) last.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'locked') last.locked = '';
    else if (line.startsWith('locked ')) last.locked = line.slice('locked '.length);
    else if (line === 'bare') last.bare = true;
    else if (line === 'detached') last.detached = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) last.prunable = true;
  }
  return entries;
}

/** Whether git ignores `path`, relative to the top level of `repo`, or anything above it. */
export function isIgnored(repo: string, path: string): boolean {
  try {
    git(repo, ['check-ignore', '-q', path], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Locks a worktree so `git worktree prune` leaves it alone, as the CLI does with the ones it runs in. */
export function lockWorktree(repo: string, path: string, reason: string): void {
  try {
    git(repo, ['worktree', 'lock', '--reason', reason, path], 10_000);
  } catch {
    /* already locked */
  }
}

export function headCommit(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']);
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Whether `commit` is already contained in what `dir` has checked out. */
export function contains(dir: string, commit: string): boolean {
  try {
    git(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks `branch` out at `path`, creating the branch from `base` unless it already exists — a
 * resumed task finds the branch its first attempt left and carries on from there.
 */
export function addWorktree(repo: string, path: string, branch: string, base: string): void {
  if (existsSync(path)) return;
  try {
    if (branchExists(repo, branch)) git(repo, ['worktree', 'add', path, branch]);
    else git(repo, ['worktree', 'add', '-b', branch, path, base]);
  } finally {
    worktreesChanged();
  }
}

/** What caches a repository's worktrees (`RepoIndex`), held weakly so a finished Core is not kept alive. */
const worktreeCaches = new Set<WeakRef<{ invalidate(): void }>>();

export function watchWorktrees(cache: { invalidate(): void }): void {
  worktreeCaches.add(new WeakRef(cache));
}

/**
 * Says a worktree was added or removed, so every cache of worktree lists and placements reads them
 * again. `addWorktree` and `removeWorktree` call it; so does anything else that makes or removes
 * one (a chat the CLI starts with `--worktree`, a forced `git worktree remove`).
 */
export function worktreesChanged(): void {
  for (const ref of worktreeCaches) {
    const cache = ref.deref();
    if (cache) cache.invalidate();
    else worktreeCaches.delete(ref);
  }
}

/** Paths git left unmerged, i.e. the ones someone has to resolve. */
export function conflictedPaths(dir: string): string[] {
  const out = git(dir, [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '--name-only', '--diff-filter=U']);
  return out ? out.split('\n') : [];
}

export function mergeInProgress(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges `branch` into what `dir` has checked out with a merge commit, so each task's work stays
 * visible as a unit in the history. On a conflict the merge is left in progress for whoever resolves
 * it, and the conflicting paths are returned; `null` means it went in cleanly.
 */
export function merge(dir: string, branch: string, message: string): string[] | null {
  try {
    git(dir, ['merge', '--no-ff', '--no-edit', '-m', message, branch], 120_000);
    return null;
  } catch (err) {
    const paths = conflictedPaths(dir);
    if (paths.length === 0) throw err; // not a conflict: a missing branch, a dirty tree…
    return paths;
  }
}

export function abortMerge(dir: string): void {
  try {
    git(dir, ['merge', '--abort']);
  } catch {
    /* nothing to abort */
  }
}

/** Git needs an author; the repository's own identity when it has one, a neutral one otherwise. */
export function identity(dir: string): string[] {
  try {
    if (git(dir, ['config', 'user.email'])) return [];
  } catch {
    /* unset */
  }
  return ['-c', 'user.name=Claudio', '-c', 'user.email=claudio@localhost'];
}

/**
 * Commits whatever is left uncommitted in `dir` and returns the new commit, or `null` when there
 * was nothing to commit. Hooks are skipped on purpose: this is a safety net so finished work is never
 * stranded in a worktree, not a review of it.
 */
export function commitAll(dir: string, message: string): string | null {
  if (!existsSync(dir)) return null;
  git(dir, ['add', '-A']);
  try {
    git(dir, [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '--cached', '--quiet']);
    return null; // nothing staged
  } catch {
    /* there are changes */
  }
  execFileSync('git', ['-C', dir, ...identity(dir), 'commit', '--no-verify', '-q', '-m', message], { stdio: 'pipe', timeout: 60_000 });
  return headCommit(dir);
}

/**
 * Commits these paths, relative to `dir`, and nothing else: whatever else is staged or changed there
 * stays as it was, since `commit -- <paths>` records only the paths it is given. Same identity and
 * hooks as {@link commitAll}. Returns the new commit.
 */
export function commitPaths(dir: string, message: string, paths: string[]): string {
  git(dir, ['--literal-pathspecs', 'add', '--', ...paths]);
  try {
    execFileSync('git', ['-C', dir, '--literal-pathspecs', ...identity(dir), 'commit', '--no-verify', '-q', '-m', message, '--', ...paths], { stdio: 'pipe', timeout: 60_000 });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message: string };
    const detail = `${String(e.stderr ?? '')}\n${String(e.stdout ?? '')}`.trim() || e.message;
    throw new Error(`git commit: ${detail.split('\n').slice(0, 6).join('\n')}`);
  }
  return headCommit(dir);
}

/** Deletes a branch whose work is being thrown away; one that is not there is already gone. */
export function deleteBranch(repo: string, branch: string): void {
  if (branchExists(repo, branch)) git(repo, ['branch', '-D', branch]);
}

/** `git worktree remove`, unlocking first: the CLI locks the worktrees it runs in. */
export function removeWorktree(repo: string, path: string, force = false): void {
  try {
    git(repo, ['worktree', 'unlock', path], 30_000);
  } catch {
    /* not locked */
  }
  try {
    git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  } finally {
    worktreesChanged();
  }
}

// ---------- what a branch has changed ----------

/**
 * Set on the command line of every diff, so a repository's own config cannot run a program through
 * a diff (`diff.external`) or a file watcher (`core.fsmonitor`). `--no-textconv` and `--no-ext-diff`
 * switch off the drivers `.gitattributes` assigns.
 */
export const DIFF_SAFE = ['-c', 'diff.external=', '-c', 'core.fsmonitor=false'];

/** A diff is shown whole, but one file must not be able to fill the server's memory. */
const DIFF_LIMIT = 8 * 1024 * 1024;
/** The log shows the newest commits; `ahead` still counts them all. */
const COMMIT_LIMIT = 200;
/** Untracked files are counted by reading them, so a huge one is left uncounted. */
const COUNT_LIMIT = 1024 * 1024;

/** The branch `dir` has checked out, or null on a detached head. */
export function currentBranch(dir: string): string | null {
  try {
    return git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], 10_000) || null;
  } catch {
    return null;
  }
}

/** The commit `a` and `b` last had in common, or null when they share none. */
export function mergeBase(dir: string, a: string, b: string): string | null {
  try {
    return git(dir, ['merge-base', a, b], 10_000) || null;
  } catch {
    return null;
  }
}

/** How many commits `ref` has that `base` does not. */
export function aheadCount(dir: string, base: string, ref = 'HEAD'): number {
  return Number(git(dir, ['rev-list', '--count', `${base}..${ref}`], 30_000)) || 0;
}

/** The commits on `ref` that `base` lacks, newest first, merges included. */
export function commitsBetween(dir: string, base: string, ref = 'HEAD', limit = COMMIT_LIMIT): Commit[] {
  return parseCommits(gitRaw(dir, logArgs(base, ref, limit), { timeout: 30_000 }));
}

const logArgs = (base: string, ref: string, limit: number): string[] => ['log', `--max-count=${limit}`, '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${base}..${ref}`];

function parseCommits(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of out.split('\x1e')) {
    const [hash, subject, author, at] = record.trim().split('\x1f');
    if (hash && at) commits.push({ hash, subject: subject ?? '', author: author ?? '', at });
  }
  return commits;
}

const NAME_STATUS: Record<string, ChangedFileStatus> = { A: 'added', D: 'deleted', R: 'renamed', C: 'added' };

/**
 * What differs between `from` and `to`, or between `from` and the working tree when `to` is left
 * out. `-z` on both listings because a path may hold any byte git allows, and git quotes the ones it
 * finds odd in the plain format.
 */
export function diffFiles(dir: string, from: string, to?: string): ChangedFile[] {
  const [statusArgs, numstatArgs] = diffListArgs(from, to);
  return parseDiffFiles(gitRaw(dir, statusArgs, DIFF_LIST_OPTS), gitRaw(dir, numstatArgs, DIFF_LIST_OPTS));
}

const DIFF_LIST_OPTS = { timeout: 60_000, maxBuffer: DIFF_LIMIT };

function diffListArgs(from: string, to?: string): [string[], string[]] {
  const range = [from, ...(to ? [to] : []), '--'];
  const list = (kind: '--name-status' | '--numstat') => [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '-M', kind, '-z', ...range];
  return [list('--name-status'), list('--numstat')];
}

function parseDiffFiles(statusOut: string, numstatOut: string): ChangedFile[] {
  const status = statusOut.split('\0');
  const numstat = numstatOut.split('\0');

  const counts = new Map<string, { additions: number; deletions: number; binary?: boolean }>();
  for (let i = 0; i < numstat.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numstat[i] ?? '');
    if (!m) continue;
    // A rename lists the old and the new path as the next two entries, and leaves this one empty
    const path = m[3] === '' ? (numstat[(i += 2)] ?? '') : (m[3] as string);
    // `-` is what git prints for a binary file
    counts.set(path, {
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      ...(m[1] === '-' && m[2] === '-' ? { binary: true } : {}),
    });
  }

  const files: ChangedFile[] = [];
  for (let i = 0; i < status.length; i++) {
    const letter = status[i]?.[0];
    if (!letter) continue;
    const renamed = letter === 'R' || letter === 'C';
    const previousPath = renamed ? status[++i] : undefined;
    const path = status[++i];
    if (path === undefined) break;
    const { binary, ...count } = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status: NAME_STATUS[letter] ?? 'modified',
      ...count,
      ...(previousPath !== undefined ? { previousPath } : {}),
      ...(binary ? { binary } : {}),
    });
  }
  return files;
}

/** Files git does not track yet and does not ignore. */
export function untrackedPaths(dir: string): string[] {
  return gitRaw(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 30_000, maxBuffer: DIFF_LIMIT })
    .split('\0')
    .filter(Boolean);
}

/** Lines in a buffer, a last line without its newline included. */
function linesIn(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 10) lines++;
  return buf[buf.length - 1] === 10 ? lines : lines + 1;
}

/** The first `limit` bytes of a file; null when it cannot be read. */
function readHead(file: string, limit: number): Buffer | null {
  try {
    const size = Math.min(statSync(file).size, limit);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return buf;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Lines in a file nobody added yet, and whether it is binary (git's own test: a NUL in the first
 * 8000 bytes). A file too large to be worth reading is left uncounted.
 */
function textStats(file: string): { lines: number; binary: boolean } {
  const buf = readHead(file, COUNT_LIMIT + 1);
  if (!buf) return { lines: 0, binary: false };
  if (buf.subarray(0, 8000).includes(0)) return { lines: 0, binary: true };
  return { lines: buf.length > COUNT_LIMIT ? 0 : linesIn(buf), binary: false };
}

/**
 * What differs between `from` and the working tree: tracked changes, staged or not, and the files
 * nobody added yet, counted by reading them.
 */
export function workingFiles(dir: string, from: string): ChangedFile[] {
  return withCreated(dir, diffFiles(dir, from), untrackedPaths(dir));
}

function withCreated(dir: string, tracked: ChangedFile[], untracked: string[]): ChangedFile[] {
  const known = new Set(tracked.map((f) => f.path));
  const created = untracked
    .filter((path) => !known.has(path))
    .map((path): ChangedFile => {
      const { lines, binary } = textStats(join(dir, path));
      return { path, status: 'added', additions: lines, deletions: 0, ...(binary ? { binary } : {}) };
    });
  return [...tracked, ...created];
}

/** What the worker has not committed: tracked changes, staged or not, and the files it created. */
export function uncommittedFiles(dir: string): ChangedFile[] {
  return workingFiles(dir, 'HEAD');
}

/**
 * Lines of `path` at `ref`, or in the working tree of `dir` when `ref` is left out: 0 when it is
 * not there, Infinity when it is too large to read.
 */
export function lineCount(dir: string, ref: string | undefined, path: string): number {
  if (ref === undefined) {
    const buf = readHead(join(dir, path), DIFF_LIMIT + 1);
    if (!buf) return 0;
    return buf.length > DIFF_LIMIT ? Infinity : linesIn(buf);
  }
  try {
    return linesIn(Buffer.from(gitRaw(dir, ['cat-file', '-p', `${ref}:${path}`], { timeout: 30_000, maxBuffer: DIFF_LIMIT })));
  } catch (err) {
    return (err as { code?: string }).code === 'ENOBUFS' ? Infinity : 0;
  }
}

/** What a commit is measured against: its first parent, or the empty tree for a root commit. */
export function parentOf(dir: string, commit: string): string {
  try {
    return git(dir, ['rev-parse', '--verify', '--quiet', `${commit}^`], 10_000);
  } catch {
    return git(dir, ['hash-object', '-t', 'tree', '/dev/null'], 10_000);
  }
}

/**
 * A path from a request, as git takes it: relative to `dir` and inside it. Anything that climbs out
 * or is absolute is refused before git sees it.
 */
export function pathInside(dir: string, path: string): string {
  const inside = path && !path.includes('\0') && !isAbsolute(path) ? relative(dir, resolve(dir, path)) : '';
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`path must be a file inside the checkout: ${path}`);
  return inside.split(sep).join('/');
}

const fileDiffArgs = (from: string, to: string | undefined, paths: string[], unified: number): string[] => [
  '--literal-pathspecs',
  ...DIFF_SAFE,
  'diff',
  '--no-textconv',
  '--no-ext-diff',
  '-M',
  '--no-color',
  `--unified=${unified}`,
  from,
  ...(to ? [to] : []),
  '--',
  ...paths,
];

const UNTRACKED_DIFF_ARGS = [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '--no-index', '--no-color', '--', '/dev/null'];

function capped(out: string): string {
  return out.length > DIFF_LIMIT ? `${out.slice(0, DIFF_LIMIT)}\n… diff truncated\n` : out;
}

/**
 * The unified diff of `paths` between `from` and `to` (the working tree when it is left out), with
 * `unified` lines of context. A renamed file is asked for by both names, or git shows the new one
 * as created from nothing. `--literal-pathspecs` so a file called `*.ts` is that file and not a
 * pattern.
 */
export function fileDiff(dir: string, from: string, to: string | undefined, paths: string[], unified = 3): string {
  try {
    return capped(gitRaw(dir, fileDiffArgs(from, to, paths, unified), { timeout: 60_000, maxBuffer: DIFF_LIMIT * 2 }));
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOBUFS') return '… diff too large to show\n';
    throw err;
  }
}

/** The diff of a file git does not track yet: all of it is new. `--no-index` exits 1 when files differ. */
export function untrackedDiff(dir: string, path: string): string {
  try {
    return capped(execFileSync('git', ['-C', dir, ...UNTRACKED_DIFF_ARGS, path], { stdio: 'pipe', timeout: 30_000, encoding: 'utf8', maxBuffer: DIFF_LIMIT * 2 }));
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && typeof e.stdout === 'string') return capped(e.stdout);
    throw new Error(`git diff: could not read ${path}`);
  }
}

function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 30_000, encoding: 'utf8', maxBuffer: DIFF_LIMIT }, (err, stdout) => (err ? reject(err) : resolveOut(stdout)));
  });
}

export interface ChangeProbe {
  head: string;
  ahead: number;
  /** Uncommitted files, tracked and new */
  dirty: number;
  /** Changes whenever a commit lands or the uncommitted work moves, and only then */
  fingerprint: string;
}

/**
 * The cheap question a watcher asks over and over: has this worktree moved? It does not block the
 * server while git answers, and it reads no diffs, only their sizes.
 */
export async function probeChanges(dir: string, base: string | null): Promise<ChangeProbe> {
  const [head, ahead, numstat, others] = await Promise.all([
    gitAsync(dir, ['rev-parse', 'HEAD']),
    base ? gitAsync(dir, ['rev-list', '--count', `${base}..HEAD`]) : Promise.resolve('0'),
    gitAsync(dir, [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '--numstat', '-z', 'HEAD', '--']),
    gitAsync(dir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const created = others.split('\0').filter(Boolean);
  // A new file that keeps being edited never shows in the numstat, so its size and time do
  const stamps = created.slice(0, 500).map((path) => {
    try {
      const s = statSync(join(dir, path));
      return `${path}:${s.size}:${Math.trunc(s.mtimeMs)}`;
    } catch {
      return path;
    }
  });
  const tracked = numstat.split('\0').filter((entry) => /^(\d+|-)\t(\d+|-)\t/.test(entry)).length;
  return {
    head: head.trim(),
    ahead: Number(ahead.trim()) || 0,
    dirty: tracked + created.length,
    fingerprint: [head.trim(), ahead.trim(), numstat, ...stamps].join('\n'),
  };
}

/** Whether `ref` (a full ref such as `refs/remotes/origin/main`) names a commit in `dir`'s repository. */
export function refExists(dir: string, ref: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` has staged or unstaged changes to tracked files; files git does not track do not count. */
export function hasTrackedChanges(dir: string): boolean {
  return git(dir, ['status', '--porcelain', '--untracked-files=no'], 30_000) !== '';
}

// ---------- async twins, for what an API request reaches ----------
//
// The functions above block the event loop for as long as git takes: a diff of a big branch held
// every other request, the event stream included. A request handler uses the `...Async` twin of
// each; the sync ones stay for code that runs outside a request (a worker's setup, a hook, the
// orchestrator's own steps), where there is nothing else to hold up. Each twin builds the same
// arguments and parses with the same function as its sync original, so the two cannot drift.

/** {@link gitRaw} without blocking: the same arguments, the same errors, the same output. */
export function gitRawAsync(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: opts.timeout ?? 60_000, encoding: 'utf8', maxBuffer: opts.maxBuffer ?? 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(gitFailure(args, Object.assign(err, { stdout, stderr }))) : resolveOut(stdout)),
    );
  });
}

/** {@link git} without blocking. */
export async function gitAsyncText(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return (await gitRawAsync(cwd, args, { timeout })).trim();
}

export async function isGitRepoAsync(dir: string): Promise<boolean> {
  try {
    await gitAsyncText(dir, ['rev-parse', '--git-dir'], 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function topLevelAsync(dir: string): Promise<string> {
  return gitAsyncText(dir, ['rev-parse', '--show-toplevel'], 10_000);
}

export async function mainTopLevelAsync(dir: string): Promise<string> {
  return dirname(await gitAsyncText(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000));
}

export async function mainCheckoutAsync(dir: string): Promise<string> {
  const common = await gitAsyncText(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000);
  if (resolve(await gitAsyncText(dir, ['rev-parse', '--absolute-git-dir'], 10_000)) === resolve(common)) return topLevelAsync(dir);
  let configured = '';
  try {
    configured = await gitAsyncText(dir, ['config', '--file', join(common, 'config'), 'core.worktree'], 10_000);
  } catch {
    /* not set: the main checkout holds its `.git` */
  }
  return configured ? resolve(common, configured) : dirname(common);
}

export function headCommitAsync(dir: string): Promise<string> {
  return gitAsyncText(dir, ['rev-parse', 'HEAD']);
}

export async function branchExistsAsync(repo: string, branch: string): Promise<boolean> {
  try {
    await gitAsyncText(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// The worktree and merge steps of an orchestration's integration, which a request (a retried
// integration) reaches and which can each take as long as a merge does.

export async function isIgnoredAsync(repo: string, path: string): Promise<boolean> {
  try {
    await gitAsyncText(repo, ['check-ignore', '-q', path], 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function lockWorktreeAsync(repo: string, path: string, reason: string): Promise<void> {
  try {
    await gitAsyncText(repo, ['worktree', 'lock', '--reason', reason, path], 10_000);
  } catch {
    /* already locked */
  }
}

export async function containsAsync(dir: string, commit: string): Promise<boolean> {
  try {
    await gitAsyncText(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function addWorktreeAsync(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path)) return;
  try {
    if (await branchExistsAsync(repo, branch)) await gitAsyncText(repo, ['worktree', 'add', path, branch]);
    else await gitAsyncText(repo, ['worktree', 'add', '-b', branch, path, base]);
  } finally {
    worktreesChanged();
  }
}

export async function removeWorktreeAsync(repo: string, path: string, force = false): Promise<void> {
  try {
    await gitAsyncText(repo, ['worktree', 'unlock', path], 30_000);
  } catch {
    /* not locked */
  }
  try {
    await gitAsyncText(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  } finally {
    worktreesChanged();
  }
}

export async function conflictedPathsAsync(dir: string): Promise<string[]> {
  const out = await gitAsyncText(dir, [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '--name-only', '--diff-filter=U']);
  return out ? out.split('\n') : [];
}

export async function mergeInProgressAsync(dir: string): Promise<boolean> {
  return (await mergeHeadAsync(dir)) !== null;
}

/** The commit a merge left in progress is bringing in, or null when no merge is in progress. */
export async function mergeHeadAsync(dir: string): Promise<string | null> {
  try {
    return (await gitAsyncText(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) || null;
  } catch {
    return null;
  }
}

/** The commit a local branch points at, or null when there is no such branch. */
export async function branchHeadAsync(repo: string, branch: string): Promise<string | null> {
  try {
    return (await gitAsyncText(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) || null;
  } catch {
    return null;
  }
}

export async function mergeAsync(dir: string, branch: string, message: string): Promise<string[] | null> {
  try {
    await gitAsyncText(dir, ['merge', '--no-ff', '--no-edit', '-m', message, branch], 120_000);
    return null;
  } catch (err) {
    const paths = await conflictedPathsAsync(dir);
    if (paths.length === 0) throw err; // not a conflict: a missing branch, a dirty tree…
    return paths;
  }
}

export async function abortMergeAsync(dir: string): Promise<void> {
  try {
    await gitAsyncText(dir, ['merge', '--abort']);
  } catch {
    /* nothing to abort */
  }
}

async function identityAsync(dir: string): Promise<string[]> {
  try {
    if (await gitAsyncText(dir, ['config', 'user.email'])) return [];
  } catch {
    /* unset */
  }
  return ['-c', 'user.name=Claudio', '-c', 'user.email=claudio@localhost'];
}

export async function commitAllAsync(dir: string, message: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  await gitAsyncText(dir, ['add', '-A']);
  try {
    await gitAsyncText(dir, [...DIFF_SAFE, 'diff', '--no-textconv', '--no-ext-diff', '--cached', '--quiet']);
    return null; // nothing staged
  } catch {
    /* there are changes */
  }
  await gitAsyncText(dir, [...(await identityAsync(dir)), 'commit', '--no-verify', '-q', '-m', message]);
  return headCommitAsync(dir);
}

export async function currentBranchAsync(dir: string): Promise<string | null> {
  try {
    return (await gitAsyncText(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], 10_000)) || null;
  } catch {
    return null;
  }
}

export async function mergeBaseAsync(dir: string, a: string, b: string): Promise<string | null> {
  try {
    return (await gitAsyncText(dir, ['merge-base', a, b], 10_000)) || null;
  } catch {
    return null;
  }
}

export async function aheadCountAsync(dir: string, base: string, ref = 'HEAD'): Promise<number> {
  return Number(await gitAsyncText(dir, ['rev-list', '--count', `${base}..${ref}`], 30_000)) || 0;
}

export async function commitsBetweenAsync(dir: string, base: string, ref = 'HEAD', limit = COMMIT_LIMIT): Promise<Commit[]> {
  return parseCommits(await gitRawAsync(dir, logArgs(base, ref, limit), { timeout: 30_000 }));
}

export async function diffFilesAsync(dir: string, from: string, to?: string): Promise<ChangedFile[]> {
  const [statusArgs, numstatArgs] = diffListArgs(from, to);
  const [status, numstat] = await Promise.all([gitRawAsync(dir, statusArgs, DIFF_LIST_OPTS), gitRawAsync(dir, numstatArgs, DIFF_LIST_OPTS)]);
  return parseDiffFiles(status, numstat);
}

export async function untrackedPathsAsync(dir: string): Promise<string[]> {
  return (await gitRawAsync(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 30_000, maxBuffer: DIFF_LIMIT })).split('\0').filter(Boolean);
}

export async function workingFilesAsync(dir: string, from: string): Promise<ChangedFile[]> {
  const [tracked, untracked] = await Promise.all([diffFilesAsync(dir, from), untrackedPathsAsync(dir)]);
  return withCreated(dir, tracked, untracked);
}

export function uncommittedFilesAsync(dir: string): Promise<ChangedFile[]> {
  return workingFilesAsync(dir, 'HEAD');
}

export async function lineCountAsync(dir: string, ref: string | undefined, path: string): Promise<number> {
  // The working tree is read from disk, as the sync one does: a bounded read of one file
  if (ref === undefined) return lineCount(dir, undefined, path);
  try {
    return linesIn(Buffer.from(await gitRawAsync(dir, ['cat-file', '-p', `${ref}:${path}`], { timeout: 30_000, maxBuffer: DIFF_LIMIT })));
  } catch (err) {
    return (err as { code?: string }).code === 'ENOBUFS' ? Infinity : 0;
  }
}

export async function isAncestorAsync(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await gitAsyncText(dir, ['merge-base', '--is-ancestor', ancestor, descendant], 30_000);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommitAsync(dir: string, sha: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return null;
  try {
    return (await gitAsyncText(dir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], 10_000)) || null;
  } catch {
    return null;
  }
}

export async function parentOfAsync(dir: string, commit: string): Promise<string> {
  try {
    return await gitAsyncText(dir, ['rev-parse', '--verify', '--quiet', `${commit}^`], 10_000);
  } catch {
    return gitAsyncText(dir, ['hash-object', '-t', 'tree', '/dev/null'], 10_000);
  }
}

export async function fileDiffAsync(dir: string, from: string, to: string | undefined, paths: string[], unified = 3): Promise<string> {
  try {
    return capped(await gitRawAsync(dir, fileDiffArgs(from, to, paths, unified), { timeout: 60_000, maxBuffer: DIFF_LIMIT * 2 }));
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOBUFS') return '… diff too large to show\n';
    throw err;
  }
}

export function untrackedDiffAsync(dir: string, path: string): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile('git', ['-C', dir, ...UNTRACKED_DIFF_ARGS, path], { timeout: 30_000, encoding: 'utf8', maxBuffer: DIFF_LIMIT * 2 }, (err, stdout) => {
      if (!err) return resolveOut(capped(stdout));
      // `--no-index` exits 1 when the files differ, which is the answer here
      if ((err as { code?: unknown }).code === 1 && typeof stdout === 'string') return resolveOut(capped(stdout));
      reject(new Error(`git diff: could not read ${path}`));
    });
  });
}

export async function isUntrackedAsync(dir: string, path: string): Promise<boolean> {
  return (await untrackedPathsAsync(dir)).includes(path);
}
