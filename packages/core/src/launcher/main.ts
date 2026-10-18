// The container's PID-1 program after the init (docs/plans/container-polish.md, D4): it starts the
// server from a verified overlay in /data/app/<version> or from the image's /app, restarts it when it
// exits 75, keeps an overlay only once /api/health answers, and rolls back on its own. Bundled alone
// as /app/launcher.mjs, root-owned: it is the one thing an update cannot fix, so it stays small and
// imports `node:*` only.
import { spawn, type ChildProcess } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESTART_EXIT_CODE,
  VERSION,
  checkOverlay,
  compareVersions,
  loadKeys,
  overlayDir,
  readImageInfo,
  readState,
  writeState,
  type ImageInfo,
  type LauncherState,
} from './protocol.ts';

/** How long a trial boot has to answer `/api/health`, and how many boots it gets */
const TRIAL_MS = 60_000;
const TRIAL_ATTEMPTS = 2;
const POLL_MS = 1000;
/** A trial that never answered is asked to stop, then killed */
const KILL_AFTER_MS = 10_000;

export interface LauncherOptions {
  /** Where the launcher, `image.json`, `keys/`, `guard.mjs` and the base server live: `/app` */
  appDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  /** The Node binary the server runs on */
  node?: string;
  trialMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

interface Boot {
  dir: string;
  version: string;
  /** Booted on trial: kept only once `/api/health` answers */
  trial: boolean;
}

interface Exit {
  code: number;
  /** The trial answered `/api/health` before it exited */
  healthy: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as Record<string, number>;

/** The overlays nobody points at, and what a download left half done, go; only names that are versions are touched */
function collectOverlays(root: string, state: LauncherState): void {
  if (!existsSync(root)) return;
  const keep = new Set([state.active, state.previous, state.trial].filter((v): v is string => v !== null));
  for (const name of readdirSync(root)) {
    if ((VERSION.test(name) && !keep.has(name)) || name.startsWith('.staging-')) rmSync(join(root, name), { recursive: true, force: true });
  }
}

/** A CLI installed in-app gives way to a newer image's pin, and versions nobody uses go */
function collectCli(root: string, image: ImageInfo, log: (line: string) => void): void {
  if (!existsSync(root)) return;
  const link = join(root, 'current');
  let current: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink()) {
      const target = basename(readlinkSync(link));
      if (VERSION.test(target) && (!image.claudeCode || compareVersions(target, image.claudeCode) > 0)) current = target;
      else log(`Claude Code ${target} from /data is not newer than the image's ${image.claudeCode ?? 'pin'}; using the image's`);
    }
    if (current === null) rmSync(link, { recursive: true, force: true });
  } catch {
    // No link: the image's CLI is in use
  }
  for (const name of readdirSync(root)) {
    if ((VERSION.test(name) && name !== current) || name.startsWith('.staging-') || name.startsWith('.current-')) rmSync(join(root, name), { recursive: true, force: true });
  }
}

/** What to boot: the trial, else the active overlay, else the previous one, else `/app`. A candidate that fails its checks is marked bad. */
function pick(o: Required<Omit<LauncherOptions, 'env'>>, image: ImageInfo, keys: readonly KeyObject[]): Boot {
  const root = join(o.dataDir, 'app');
  const file = join(root, 'state.json');
  const base: Boot = { dir: o.appDir, version: image.version, trial: false };
  if (!existsSync(file)) return base;
  const state = readState(file);
  let changed = false;
  for (const role of ['trial', 'active', 'previous'] as const) {
    const v = state[role];
    if (v === null) continue;
    // A trial must be newer than what runs now as well as the image: the agents' user can write
    // state.json, and pointing the trial at an older signed bundle would be a downgrade
    const failed = state.bad.includes(v)
      ? 'it failed before'
      : role === 'trial' && state.active !== null && compareVersions(v, state.active) <= 0
        ? `${v} is not newer than the active ${state.active}`
        : checkOverlay({ dir: overlayDir(root, v), version: v, keys, image, nodeAbi: process.versions.modules });
    if (failed === null) {
      if (role === 'previous') {
        state.active = v;
        state.previous = null;
        changed = true;
      }
      if (changed) writeState(file, state);
      collectOverlays(root, state);
      return { dir: overlayDir(root, v), version: v, trial: role === 'trial' };
    }
    o.log(`overlay ${v} refused: ${failed}`);
    if (!state.bad.includes(v)) state.bad.push(v);
    // A refused trial falls back to the active overlay, a refused active one to the previous
    if (role !== 'previous') state.lastRollback = { from: v, to: (role === 'trial' ? state.active : state.previous) ?? image.version, at: new Date().toISOString() };
    state[role] = null;
    if (role === 'trial') state.attempts = 0;
    changed = true;
  }
  if (changed) writeState(file, state);
  collectOverlays(root, state);
  return base;
}

function start(o: Required<Omit<LauncherOptions, 'env'>>, env: NodeJS.ProcessEnv, boot: Boot): ChildProcess {
  o.log(`starting Claudio ${boot.version} from ${boot.dir}${boot.trial ? ' (trial)' : ''}`);
  return spawn(o.node, [join(boot.dir, 'api.mjs')], {
    stdio: 'inherit',
    env: {
      ...env,
      CLAUDIO_LAUNCHER: '1',
      CLAUDIO_APP_DIR: boot.dir,
      // The guard is always the image's, never an overlay's
      CLAUDIO_GUARD_ENTRY: join(o.appDir, 'guard.mjs'),
      ...(boot.dir === o.appDir ? {} : { CLAUDIO_WEB_DIST: join(boot.dir, 'web') }),
    },
  });
}

const exited = (child: ChildProcess): Promise<number> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode ?? 128 + (SIGNALS[child.signalCode ?? ''] ?? 1));
    else child.once('exit', (code, signal) => resolve(code ?? 128 + (SIGNALS[signal ?? ''] ?? 1)));
  });

async function healthy(port: string, until: number, pollMs: number, gone: () => boolean): Promise<boolean> {
  while (Date.now() < until && !gone()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(pollMs * 2) });
      if (res.status === 200) return true;
    } catch {
      // Not listening yet
    }
    await sleep(pollMs);
  }
  return false;
}

/** Runs the server until it exits, or until the launcher is told to stop. Resolves to the exit code the launcher ends with. */
export async function launch(options: LauncherOptions): Promise<number> {
  const o = { node: process.execPath, trialMs: TRIAL_MS, pollMs: POLL_MS, log: (line: string) => process.stderr.write(`claudio-launcher: ${line}\n`), ...options };
  const { env } = o;
  let child: ChildProcess | null = null;
  let stopping = false;
  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    child?.kill(signal);
  };
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);
  try {
    for (;;) {
      if (stopping) return 0;
      const image = readImageInfo(join(o.appDir, 'image.json'));
      // An image without its facts runs the plain server, as before the launcher existed
      const boot = image ? pick(o, image, loadKeys(join(o.appDir, 'keys'))) : { dir: o.appDir, version: 'unknown', trial: false };
      if (image) collectCli(join(o.dataDir, 'cli'), image, o.log);
      const running = start(o, env, boot);
      child = running;
      const ended = exited(running);
      const exit: Exit = boot.trial ? await trial(o, running, ended, boot.version, () => stopping) : { code: await ended, healthy: true };
      child = null;
      if (stopping) return exit.code;
      if (boot.trial && !exit.healthy) {
        failedTrial(o, boot.version, image);
        continue;
      }
      if (exit.code === RESTART_EXIT_CODE) continue;
      return exit.code;
    }
  } finally {
    process.off('SIGTERM', forward);
    process.off('SIGINT', forward);
  }
}

async function trial(o: Required<Omit<LauncherOptions, 'env'>> & { env: NodeJS.ProcessEnv }, running: ChildProcess, ended: Promise<number>, v: string, stopping: () => boolean): Promise<Exit> {
  let gone = false;
  void ended.then(() => {
    gone = true;
  });
  const ok = await healthy(o.env.PORT || '8797', Date.now() + o.trialMs, o.pollMs, () => gone || stopping());
  if (ok) {
    // Read again: the server may have written the file since this boot began
    const file = join(o.dataDir, 'app', 'state.json');
    const state = readState(file);
    if (state.trial === v) {
      if (state.active !== v) state.previous = state.active;
      state.active = v;
      state.trial = null;
      state.attempts = 0;
      writeState(file, state);
      o.log(`Claudio ${v} answered; it is the version in use now`);
    }
    return { code: await ended, healthy: true };
  }
  if (!gone) {
    running.kill('SIGTERM');
    const killer = setTimeout(() => running.kill('SIGKILL'), KILL_AFTER_MS);
    await ended;
    clearTimeout(killer);
  }
  return { code: await ended, healthy: stopping() };
}

function failedTrial(o: { dataDir: string; log: (line: string) => void }, v: string, image: ImageInfo | null): void {
  const file = join(o.dataDir, 'app', 'state.json');
  const state = readState(file);
  if (state.trial !== v) return;
  state.attempts += 1;
  if (state.attempts >= TRIAL_ATTEMPTS) {
    const to = state.active ?? image?.version ?? 'unknown';
    o.log(`Claudio ${v} did not answer /api/health in ${String(TRIAL_ATTEMPTS)} boots; going back to ${to}`);
    state.bad.push(v);
    state.trial = null;
    state.attempts = 0;
    state.lastRollback = { from: v, to, at: new Date().toISOString() };
  } else {
    o.log(`Claudio ${v} did not answer /api/health; trying it once more`);
  }
  writeState(file, state);
}

const self = fileURLToPath(import.meta.url);
const isEntry = (): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return false;
  }
};
if (isEntry()) {
  // The launcher lives in /app beside what it trusts; nothing in the environment moves that
  const code = await launch({ appDir: dirname(self), dataDir: process.env.CLAUDIO_DATA_DIR || '/data', env: process.env });
  process.exit(code);
}
