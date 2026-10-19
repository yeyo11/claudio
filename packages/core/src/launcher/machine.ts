// The launcher's state machine (docs/plans/unified-updates.md, D1): which payload boots, a trial that
// is kept only once it answers, two failed boots and it rolls back, and the overlays nobody points at
// go. One machine for both hosts: the container's launcher (`main.ts`) drives it around a `node`
// child, the desktop shell around its `ServerProcess`. Spawning, the health check, the clock and file
// access are the host's, handed in, so the same rules run, and are tested, everywhere. Like
// `protocol.ts` it imports `node:*` only: the launcher is bundled alone and an update cannot fix it.
import type { KeyObject } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR_LOCKED_EXIT_CODE,
  RESTART_EXIT_CODE,
  VERSION,
  checkOverlay,
  compareVersions,
  overlayDir,
  readState,
  writeState,
  type LauncherState,
  type OverlayCheck,
  type PayloadBase,
} from './protocol.ts';

/** How long a trial boot has to prove itself, and how many boots it gets */
export const TRIAL_MS = 60_000;
export const TRIAL_ATTEMPTS = 2;
/** A trial that never answered is asked to stop, then killed */
export const KILL_AFTER_MS = 10_000;

export interface Boot {
  /** The base payload's directory, or `<dataDir>/app/<version>` */
  dir: string;
  version: string;
  /** Booted on trial: kept only once it answers */
  trial: boolean;
}

/** What the machine reads and writes on disk; the real one is `NODE_FILES`, a test may hand in another */
export interface MachineFiles {
  exists(path: string): boolean;
  list(dir: string): string[];
  remove(path: string): void;
  readState(file: string): LauncherState;
  writeState(file: string, state: LauncherState): void;
  /** Signature, version, base and every file's hash: why the overlay must not boot, or null */
  checkOverlay(check: OverlayCheck): string | null;
}

export const NODE_FILES: MachineFiles = {
  exists: existsSync,
  list: (dir) => readdirSync(dir),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  readState,
  writeState,
  checkOverlay,
};

export interface Machine {
  /** Where the base payload lives: the image's `/app`, or the shell's `<resources>/server` */
  baseDir: string;
  /** `<dataDir>/app` holds the overlays and `state.json` on every host */
  dataDir: string;
  files: MachineFiles;
  /** Milliseconds since the epoch */
  now: () => number;
  log: (line: string) => void;
}

const rootOf = (m: Pick<Machine, 'dataDir'>) => join(m.dataDir, 'app');
export const stateFileOf = (m: Pick<Machine, 'dataDir'>): string => join(rootOf(m), 'state.json');

/** The overlays nobody points at, and what a download left half done, go; only names that are versions are touched */
export function collectOverlays(m: Machine, state: LauncherState): void {
  const root = rootOf(m);
  if (!m.files.exists(root)) return;
  const keep = new Set([state.active, state.previous, state.trial].filter((v): v is string => v !== null));
  for (const name of m.files.list(root)) {
    if ((VERSION.test(name) && !keep.has(name)) || name.startsWith('.staging-')) m.files.remove(join(root, name));
  }
}

/**
 * What to boot: the trial, else the active overlay, else the previous one, else the base payload. A
 * candidate that fails its checks is marked bad and never booted again. `ignoreOverlays` is the
 * person's recovery (`CLAUDIO_PAYLOAD=bundled`): the base boots and nothing on disk changes.
 */
export function pick(m: Machine, base: PayloadBase, keys: readonly KeyObject[], { ignoreOverlays = false }: { ignoreOverlays?: boolean } = {}): Boot {
  const root = rootOf(m);
  const file = stateFileOf(m);
  const fallback: Boot = { dir: m.baseDir, version: base.version, trial: false };
  if (ignoreOverlays) {
    m.log(`booting the bundled Claudio ${base.version}; overlays are ignored for this launch`);
    return fallback;
  }
  if (!m.files.exists(file)) return fallback;
  const state = m.files.readState(file);
  let changed = false;
  for (const role of ['trial', 'active', 'previous'] as const) {
    const v = state[role];
    if (v === null) continue;
    // A trial must be newer than what runs now as well as the base: the agents' user can write
    // state.json, and pointing the trial at an older signed bundle would be a downgrade
    const failed = state.bad.includes(v)
      ? 'it failed before'
      : role === 'trial' && state.active !== null && compareVersions(v, state.active) <= 0
        ? `${v} is not newer than the active ${state.active}`
        : m.files.checkOverlay({ dir: overlayDir(root, v), version: v, keys, base });
    if (failed === null) {
      if (role === 'previous') {
        state.active = v;
        state.previous = null;
        changed = true;
      }
      if (changed) m.files.writeState(file, state);
      collectOverlays(m, state);
      return { dir: overlayDir(root, v), version: v, trial: role === 'trial' };
    }
    m.log(`overlay ${v} refused: ${failed}`);
    if (!state.bad.includes(v)) state.bad.push(v);
    // A refused trial falls back to the active overlay, a refused active one to the previous
    if (role !== 'previous') state.lastRollback = { from: v, to: (role === 'trial' ? state.active : state.previous) ?? base.version, at: new Date(m.now()).toISOString() };
    state[role] = null;
    if (role === 'trial') state.attempts = 0;
    changed = true;
  }
  if (changed) m.files.writeState(file, state);
  collectOverlays(m, state);
  return fallback;
}

/** The trial answered: it is the version in use now, and the one before it the first fallback. False when the state moved on since it booted. */
export function promoteTrial(m: Machine, v: string): boolean {
  // Read again: the server may have written the file since this boot began
  const file = stateFileOf(m);
  const state = m.files.readState(file);
  if (state.trial !== v) return false;
  if (state.active !== v) state.previous = state.active;
  state.active = v;
  state.trial = null;
  state.attempts = 0;
  m.files.writeState(file, state);
  m.log(`Claudio ${v} answered; it is the version in use now`);
  return true;
}

/** A trial boot did not prove itself: once more, or after `TRIAL_ATTEMPTS` it is bad and the rollback is recorded */
export function failTrial(m: Machine, v: string, baseVersion: string): void {
  const file = stateFileOf(m);
  const state = m.files.readState(file);
  if (state.trial !== v) return;
  state.attempts += 1;
  if (state.attempts >= TRIAL_ATTEMPTS) {
    const to = state.active ?? baseVersion;
    m.log(`Claudio ${v} did not answer in ${String(TRIAL_ATTEMPTS)} boots; going back to ${to}`);
    state.bad.push(v);
    state.trial = null;
    state.attempts = 0;
    state.lastRollback = { from: v, to, at: new Date(m.now()).toISOString() };
  } else {
    m.log(`Claudio ${v} did not answer; trying it once more`);
  }
  m.files.writeState(file, state);
}

/** A server the host started */
export interface Running {
  /** Resolves with its exit code (128 + the signal's number when a signal ended it) */
  exited: Promise<number>;
  /** Asks it to stop (SIGTERM) */
  stop(): void;
  /** Ends it (SIGKILL) */
  kill(): void;
}

export interface RunOptions extends Machine {
  /** Read before every boot: the base payload and the keys that verify an overlay; null boots `baseDir` as it is */
  base(): { base: PayloadBase; keys: readonly KeyObject[] } | null;
  /** Called before every boot, with what `base()` answered (the container collects its CLI versions here) */
  beforeBoot?: (base: PayloadBase | null) => void;
  start(boot: Boot): Running;
  /**
   * Whether a trial proved itself before `until`: the container waits for `/api/health`, the
   * desktop also for its window to render. Resolves false at the deadline or once `gone()` is true.
   */
  trialCheck(boot: Boot, until: number, gone: () => boolean): Promise<boolean>;
  /** True once the host was told to stop: the server is not started again */
  stopping(): boolean;
  /** Runs `fn` after `ms`; the answer cancels it */
  after(ms: number, fn: () => void): () => void;
  trialMs?: number;
  ignoreOverlays?: boolean;
}

interface Exit {
  code: number;
  /** The trial proved itself before it exited */
  healthy: boolean;
}

/** Runs the server until it exits with anything but `RESTART_EXIT_CODE`, or until the host stops. Resolves to the exit code the host ends with. */
export async function run(o: RunOptions): Promise<number> {
  for (;;) {
    if (o.stopping()) return 0;
    const facts = o.base();
    // A host without its facts runs the plain server, as before the launcher existed
    const boot = facts ? pick(o, facts.base, facts.keys, { ignoreOverlays: o.ignoreOverlays }) : { dir: o.baseDir, version: 'unknown', trial: false };
    o.beforeBoot?.(facts?.base ?? null);
    o.log(`starting Claudio ${boot.version} from ${boot.dir}${boot.trial ? ' (trial)' : ''}`);
    const running = o.start(boot);
    const exit: Exit = boot.trial ? await trial(o, running, boot) : { code: await running.exited, healthy: true };
    if (o.stopping()) return exit.code;
    // Another server holds the data directory: the payload is not at fault, and starting it again changes nothing
    if (exit.code === DATA_DIR_LOCKED_EXIT_CODE) return exit.code;
    if (boot.trial && !exit.healthy) {
      failTrial(o, boot.version, facts?.base.version ?? 'unknown');
      continue;
    }
    if (exit.code === RESTART_EXIT_CODE) continue;
    return exit.code;
  }
}

async function trial(o: RunOptions, running: Running, boot: Boot): Promise<Exit> {
  let gone = false;
  void running.exited.then(() => {
    gone = true;
  });
  const ok = await o.trialCheck(boot, o.now() + (o.trialMs ?? TRIAL_MS), () => gone || o.stopping());
  if (ok) {
    promoteTrial(o, boot.version);
    return { code: await running.exited, healthy: true };
  }
  if (!gone) {
    running.stop();
    const cancel = o.after(KILL_AFTER_MS, () => running.kill());
    await running.exited;
    cancel();
  }
  return { code: await running.exited, healthy: o.stopping() };
}
