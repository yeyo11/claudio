// The container's PID-1 program after the init (docs/plans/container-polish.md, D4): it starts the
// server from a verified overlay in /data/app/<version> or from the image's /app, restarts it when it
// exits 75, keeps an overlay only once /api/health answers, and rolls back on its own. The rules are
// the machine's (`machine.ts`), shared with the desktop shell; this file is the container's host of
// it: a `node` child, a health poll, the process's signals. Bundled alone as /app/launcher.mjs,
// root-owned: it is the one thing an update cannot fix, so it stays small and imports `node:*` only.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_FILES, TRIAL_MS, run, type Boot, type Running } from './machine.ts';
import { VERSION, compareVersions, imageBase, loadKeys, readImageInfo, withServerThreadpool, type ImageInfo } from './protocol.ts';

const POLL_MS = 1000;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as Record<string, number>;

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
  let image: ImageInfo | null = null;
  try {
    return await run({
      baseDir: o.appDir,
      dataDir: o.dataDir,
      files: NODE_FILES,
      now: Date.now,
      log: o.log,
      trialMs: o.trialMs,
      // The person's recovery for one start: the image's own server, whatever state.json says. A
      // headless image, and any image built without keys, has no updates (docs/plans/headless-image.md,
      // D6): the image is the version, so nothing under /data/app may run, whoever wrote it there
      ignoreOverlays: env.CLAUDIO_PAYLOAD === 'bundled' || env.CLAUDIO_PROFILE?.trim().toLowerCase() === 'headless' || loadKeys(join(o.appDir, 'keys')).length === 0,
      base: () => {
        image = readImageInfo(join(o.appDir, 'image.json'));
        // The server runs on this launcher's Node, so its ABI is the one a bundle must be built for
        return image ? { base: imageBase(image, process.versions.modules), keys: loadKeys(join(o.appDir, 'keys')) } : null;
      },
      beforeBoot: () => {
        if (image) collectCli(join(o.dataDir, 'cli'), image, o.log);
      },
      start: (boot: Boot): Running => {
        const running = spawn(o.node, [join(boot.dir, 'api.mjs')], {
          stdio: 'inherit',
          env: {
            ...withServerThreadpool(env),
            CLAUDIO_LAUNCHER: '1',
            CLAUDIO_APP_DIR: boot.dir,
            // The guard is always the image's, never an overlay's
            CLAUDIO_GUARD_ENTRY: join(o.appDir, 'guard.mjs'),
            ...(boot.dir === o.appDir ? {} : { CLAUDIO_WEB_DIST: join(boot.dir, 'web') }),
          },
        });
        child = running;
        const ended = exited(running).finally(() => {
          if (child === running) child = null;
        });
        return { exited: ended, stop: () => running.kill('SIGTERM'), kill: () => running.kill('SIGKILL') };
      },
      trialCheck: (_boot, until, gone) => healthy(env.PORT || '8797', until, o.pollMs, gone),
      stopping: () => stopping,
      after: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
  } finally {
    process.off('SIGTERM', forward);
    process.off('SIGINT', forward);
  }
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
