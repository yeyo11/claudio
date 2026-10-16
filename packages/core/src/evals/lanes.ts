import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { evalGit } from '../git.js';

/**
 * Throwaway worktrees an eval run samples in. A lane is detached, locked while its run is live, and
 * reused between samples; the sweep is the floor under every path that forgets to remove one.
 */

export class LanesError extends Error {
  constructor(
    readonly code: 'lanes-root-contaminated' | 'lane-failed',
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** What the CLI loads from a directory as instructions (F1): every ancestor of a lane is read. */
const MEMORY_ENTRIES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude'];

/** `CLAUDIO_EVALS_DIR`, else `<dataDir>/eval-lanes`. Nothing here falls back to a fixed `/tmp`. */
export function lanesRoot(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CLAUDIO_EVALS_DIR?.trim();
  return resolve(set ? set : join(dataDir, 'eval-lanes'));
}

/** Creates the root (0700) and refuses it when it or an ancestor carries instructions the agent would read. */
export function ensureLanesRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (let dir = realpathSync(root); ; dir = dirname(dir)) {
    for (const entry of MEMORY_ENTRIES) {
      const found = join(dir, entry);
      if (existsSync(found)) {
        throw new LanesError(
          'lanes-root-contaminated',
          `${found} would be loaded into every eval sample; set CLAUDIO_EVALS_DIR to a directory outside it`,
          found,
        );
      }
    }
    if (dirname(dir) === dir) break;
  }
}

// ---------- serialisation ----------

const queues = new Map<string, Promise<unknown>>();

/** Git's own `.git/worktrees` lock fails a second concurrent add instead of waiting, so wait here. */
function serial<T>(repo: string, job: () => T): Promise<T> {
  let key = repo;
  try {
    key = realpathSync(repo);
  } catch {
    /* a missing repo fails in the job */
  }
  const run = (queues.get(key) ?? Promise.resolve()).then(job);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

// ---------- lanes ----------

export const runDirName = (runId: string): string => runId.slice(0, 8);

export interface Lane {
  repo: string;
  path: string;
  runId: string;
}

/** Files written over the checkout after a reset: relative path → content. */
export type Overlay = Record<string, string>;

/**
 * Throws unless `target` resolves inside `lane`. The pinned tree is repository content, so a
 * directory or file on the way may be a committed symlink that leads out of the lane.
 */
export function assertInsideLane(lane: string, target: string): void {
  const root = realpathSync(lane);
  let dir = dirname(target);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const real = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep)) throw new LanesError('lane-failed', `path leaves the lane through a link: ${target}`, lane);
}

export function writeOverlay(lane: string, overlay: Overlay): void {
  for (const [rel, content] of Object.entries(overlay)) {
    const target = resolve(lane, rel);
    if (isAbsolute(rel) || !target.startsWith(lane + sep)) {
      throw new LanesError('lane-failed', `overlay path outside the lane: ${rel}`, lane);
    }
    assertInsideLane(lane, target);
    // A link at the target itself is replaced, never written through
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target, { force: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function createLane(repo: string, root: string, runId: string, n: number, pin: string): Promise<Lane> {
  return serial(repo, () => {
    const runDir = join(root, runDirName(runId));
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const path = join(runDir, `lane${n}`);
    try {
      evalGit(repo, ['worktree', 'add', '--detach', path, pin], 120_000);
      // A person's `git worktree prune` skips a locked worktree while the run is live
      evalGit(repo, ['worktree', 'lock', '--reason', `claudio eval ${runDirName(runId)}`, path], 10_000);
    } catch (err) {
      rmSync(path, { recursive: true, force: true });
      throw new LanesError('lane-failed', (err as Error).message, path);
    }
    return { repo, path, runId };
  });
}

/** Between samples: back to the pin, nothing untracked or ignored left, then the overlay. */
export function resetLane(lane: Lane, pin: string, overlay: Overlay = {}): Promise<void> {
  return serial(lane.repo, () => {
    try {
      evalGit(lane.path, ['checkout', '--detach', '--force', pin], 120_000);
      evalGit(lane.path, ['clean', '-ffdx'], 120_000);
    } catch (err) {
      throw new LanesError('lane-failed', (err as Error).message, lane.path);
    }
    writeOverlay(lane.path, overlay);
  });
}

function removeOne(gitDir: string | null, path: string): void {
  if (gitDir) {
    try {
      evalGit(gitDir, ['worktree', 'unlock', path], 30_000);
    } catch {
      /* not locked */
    }
    try {
      evalGit(gitDir, ['worktree', 'remove', '--force', '--force', path], 60_000);
    } catch {
      /* the directory fallback below */
    }
  }
  // Never `git worktree prune`: it would also drop the person's own worktrees on an unmounted disk
  rmSync(path, { recursive: true, force: true });
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isDirectory());
  } catch {
    return [];
  }
}

/** Removes every lane of a run, whatever its outcome. */
export function removeRunLanes(repo: string, root: string, runId: string): Promise<void> {
  return serial(repo, () => {
    const runDir = join(root, runDirName(runId));
    for (const name of safeDirs(runDir)) removeOne(repo, join(runDir, name));
    rmSync(runDir, { recursive: true, force: true });
  });
}

/** The repository's git dir behind a lane, read from the lane itself so a sweep needs no run row. */
function commonDirOf(lane: string): string | null {
  try {
    return evalGit(lane, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000) || null;
  } catch {
    return null;
  }
}

/** Removes the lanes of every run that is not live, and their worktree registrations. */
export async function sweepLanes(root: string, isLive: (runDir: string) => boolean): Promise<string[]> {
  const swept: string[] = [];
  for (const runDir of safeDirs(root)) {
    if (isLive(runDir)) continue;
    const base = join(root, runDir);
    for (const name of safeDirs(base)) {
      const lane = join(base, name);
      const common = commonDirOf(lane);
      await (common ? serial(common, () => removeOne(common, lane)) : Promise.resolve(removeOne(null, lane)));
      swept.push(lane);
    }
    rmSync(base, { recursive: true, force: true });
  }
  return swept;
}

const HOUR_MS = 60 * 60 * 1000;

/** Sweeps now and every hour; the timer does not keep the process alive. Returns the stopper. */
export function startLaneSweep(root: string, isLive: (runDir: string) => boolean, onError: (err: unknown) => void = () => {}): () => void {
  const tick = () => void sweepLanes(root, isLive).catch(onError);
  tick();
  const timer = setInterval(tick, HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------- disk ----------

export const DISK_WARN_FILES = 50_000;
export const DISK_WARN_BYTES = 2 * 1024 ** 3;

export interface DiskEstimate {
  files: number;
  bytes: number;
  warning: boolean;
}

/** What each lane checks out at the pin: the file count from its tree, the size from the repository's objects. */
export function estimateDisk(repo: string, pin: string): DiskEstimate {
  const files = evalGit(repo, ['ls-tree', '-r', '--name-only', pin], 120_000).split('\n').filter(Boolean).length;
  let bytes = 0;
  try {
    for (const line of evalGit(repo, ['count-objects', '-v'], 30_000).split('\n')) {
      const m = /^(size|size-pack):\s*(\d+)/.exec(line);
      if (m) bytes += Number(m[2]) * 1024;
    }
  } catch {
    /* the file count alone still warns */
  }
  return { files, bytes, warning: files > DISK_WARN_FILES || bytes > DISK_WARN_BYTES };
}
