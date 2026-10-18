// The desktop shell's host of the payload machine (docs/plans/unified-updates.md, D1, D6, D8). The rules
// are core's `launcher/machine.ts`, the same ones the container's launcher runs: which payload boots
// (an overlay in `<dataDir>/app/<version>`, verified at every boot against the keys in the shell's
// read-only resources, or the payload bundled in the shell), a trial kept only once it proved
// itself, two failed boots and it rolls back, exit 75 starts the server again. This file only adds
// what the desktop has and the container has not: the server is the shell's `ServerProcess`, and a
// trial proves itself when `/api/health` answers **and** the window rendered the payload's web
// (`claudio:page-ready`), so a payload whose server starts but whose page never draws is rolled
// back too. Free of Electron, so its rules are tested with fakes. Part of `shellInputs`: a change
// here needs a new shell.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_FILES, TRIAL_MS, run, stateFileOf, type Boot, type MachineFiles, type Running } from '@claudio/core/launcher/machine';
import { RESTART_EXIT_CODE, VERSION, loadKeys } from '@claudio/core/launcher/protocol';

/** After the window starts loading a trial's page, how long its web has to say it rendered */
export const PAGE_READY_MS = 30_000;
const POLL_MS = 250;
/** A server asked to stop that is still there after this is killed */
const STOP_GRACE_MS = 5_000;

/** `<resources>/shell.json`, written by the package: what the shell is, and the marker apt replaces */
export interface ShellIdentity {
  version: string;
  shellInputs: string;
}

/** The shell's identity, or null when the file is missing, half written or not a version (a dev build, an older package) */
export function readShellJson(file: string): ShellIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const { version, shellInputs } = raw;
    if (typeof version !== 'string' || !VERSION.test(version) || typeof shellInputs !== 'string') return null;
    return { version, shellInputs };
  } catch {
    return null;
  }
}

/** A boot as the shell starts it: where its server and its web are */
export interface PayloadBoot extends Boot {
  /** `<dir>/server.mjs` */
  entry: string;
  /** The bundled payload's `<resources>/web`, or the overlay's own `web/` */
  webDist: string;
  /** The payload the shell bundles, not an overlay */
  bundled: boolean;
}

/** A server the host started, as `ServerProcess` runs it */
export interface ServerHandle {
  /** The server's URL once it printed its READY line; rejects when it exited or failed first */
  ready: Promise<string>;
  /** Its exit code, 128 + the signal's number when a signal ended it */
  exited: Promise<number>;
  /** SIGTERM */
  stop(): void;
  /** SIGKILL */
  kill(): void;
  /** What it said before it went: the exit and the end of its stderr */
  detail(): string;
}

export interface PayloadHostOptions {
  /** `<resources>/server`: the payload the shell bundles, and the fallback */
  bundledDir: string;
  /** `<resources>/web` */
  bundledWeb: string;
  /** `<resources>/keys`: the only keys an overlay is verified against */
  keysDir: string;
  /** `<userData>/data`; the overlays and `state.json` are in its `app/` */
  dataDir: string;
  /** Null boots the bundled payload as it is: a dev build or a package without `shell.json` has no base to judge an overlay against */
  shell: ShellIdentity | null;
  /** `CLAUDIO_PAYLOAD=bundled`: the person's recovery for one launch */
  ignoreOverlays?: boolean;
  spawn(boot: PayloadBoot): ServerHandle;
  /** The server is listening: the window loads it */
  onReady(url: string, boot: PayloadBoot): void;
  /** One `GET /api/health`; true on a 200 */
  health(origin: string): Promise<boolean>;
  /**
   * Asked before every start but the first: true makes the start a full relaunch of the app. Once apt
   * replaced the package underneath (`shell-replaced`), `process.execPath` and `<resources>` are
   * the new version's, so a server restarted by this Electron would run another shell's payload.
   */
  relaunchInstead?(): boolean;
  log(line: string): void;
  files?: MachineFiles;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  trialMs?: number;
  pageReadyMs?: number;
  pollMs?: number;
}

export type PayloadEnd =
  /** Stopped by the shell (quit, restart, update) */
  | { why: 'stopped'; code: number }
  /** The shell must relaunch itself instead of starting the server again */
  | { why: 'relaunch'; code: number }
  /** The server went on its own; `ready` says whether it ever listened */
  | { why: 'exited'; code: number; ready: boolean; detail: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PayloadHost {
  private readonly files: MachineFiles;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopRequested = false;
  private relaunch = false;
  private boots = 0;
  private handle: ServerHandle | null = null;
  private boot: PayloadBoot | null = null;
  private origin: string | null = null;
  private everReady = false;
  private loadingAt: number | null = null;
  private pageSeen = false;
  private running: Promise<PayloadEnd> | null = null;
  /** What the last server said as it went */
  private lastDetail = '';

  constructor(private readonly o: PayloadHostOptions) {
    this.files = o.files ?? NODE_FILES;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
  }

  /** What runs now, or null between two boots */
  get current(): PayloadBoot | null {
    return this.boot;
  }

  /** Runs the server until it ends on its own or the shell stops it. One run at a time. */
  run(): Promise<PayloadEnd> {
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<PayloadEnd> {
    this.stopRequested = false;
    this.relaunch = false;
    this.boots = 0;
    const o = this.o;
    const code = await run({
      baseDir: o.bundledDir,
      dataDir: o.dataDir,
      files: this.files,
      now: this.now,
      log: o.log,
      trialMs: o.trialMs ?? TRIAL_MS,
      ignoreOverlays: o.ignoreOverlays,
      // The shell's version is the bundled payload's: an overlay must be newer and fit it (`minShell`)
      base: () => (o.shell ? { base: { kind: 'shell', version: o.shell.version, shellInputs: o.shell.shellInputs }, keys: loadKeys(o.keysDir) } : null),
      start: (boot) => this.start(boot),
      trialCheck: (_boot, until, gone) => this.trialCheck(until, gone),
      stopping: () => this.stopRequested,
      after: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    this.boot = null;
    if (this.relaunch) return { why: 'relaunch', code };
    if (this.stopRequested) return { why: 'stopped', code };
    return { why: 'exited', code, ready: this.everReady, detail: this.handle?.detail() ?? this.lastDetail };
  }

  private start(boot: Boot): Running {
    const first = this.boots === 0;
    this.boots += 1;
    if (!first && this.o.relaunchInstead?.()) {
      this.o.log('the desktop app was replaced underneath; relaunching it instead of restarting the server');
      this.relaunch = true;
      this.stopRequested = true;
      return { exited: Promise.resolve(RESTART_EXIT_CODE), stop: () => undefined, kill: () => undefined };
    }
    const bundled = boot.dir === this.o.bundledDir;
    const next: PayloadBoot = { ...boot, entry: join(boot.dir, 'server.mjs'), webDist: bundled ? this.o.bundledWeb : join(boot.dir, 'web'), bundled };
    this.boot = next;
    this.origin = null;
    this.everReady = false;
    this.loadingAt = null;
    this.pageSeen = false;
    const handle = this.o.spawn(next);
    this.handle = handle;
    handle.ready.then(
      (url) => {
        if (this.handle !== handle) return;
        this.origin = new URL(url).origin;
        this.everReady = true;
        this.o.onReady(url, next);
      },
      () => undefined,
    );
    const exited = handle.exited.then((code) => {
      this.lastDetail = handle.detail();
      if (this.handle === handle) this.handle = null;
      return code;
    });
    return { exited, stop: () => handle.stop(), kill: () => handle.kill() };
  }

  /**
   * A trial proves itself when the server answers `/api/health` before `until`, and then the window,
   * once it starts loading the page, hears from the payload's web within `PAGE_READY_MS`.
   */
  private async trialCheck(until: number, gone: () => boolean): Promise<boolean> {
    const poll = this.o.pollMs ?? POLL_MS;
    for (;;) {
      if (gone() || this.now() >= until) return false;
      if (this.origin !== null && (await this.o.health(this.origin).catch(() => false))) break;
      await this.sleep(poll);
    }
    while (this.loadingAt === null) {
      if (gone() || this.now() >= until) return false;
      await this.sleep(poll);
    }
    const deadline = this.loadingAt + (this.o.pageReadyMs ?? PAGE_READY_MS);
    for (;;) {
      if (gone()) return false;
      if (this.pageSeen) return true;
      if (this.now() >= deadline) {
        this.o.log(`Claudio ${this.boot?.version ?? '?'} answered, but its page did not render within ${String(Math.round((this.o.pageReadyMs ?? PAGE_READY_MS) / 1000))} s`);
        return false;
      }
      await this.sleep(poll);
    }
  }

  /** The window started loading the server's page */
  windowLoading(): void {
    if (this.boot && this.loadingAt === null) this.loadingAt = this.now();
  }

  /** The page in the window rendered (`claudio:page-ready`); only counts for the boot that runs now */
  pageReady(): void {
    if (this.boot) this.pageSeen = true;
  }

  /** Stops the server and waits for the run to end; a server that ignores SIGTERM is killed */
  async stop(): Promise<void> {
    this.stopRequested = true;
    const handle = this.handle;
    const running = this.running;
    if (handle) {
      handle.stop();
      const timer = setTimeout(() => handle.kill(), STOP_GRACE_MS);
      await handle.exited.catch(() => undefined);
      clearTimeout(timer);
    }
    await running;
  }
}

/**
 * Help → Use the bundled Claudio, when the server cannot be asked: forgets every overlay in
 * `state.json`, the way the server's own revert does, so the next boot is the bundled payload.
 * Nothing is deleted here; the machine collects what nobody points at.
 */
export function forgetOverlays(dataDir: string, log: (line: string) => void, files: MachineFiles = NODE_FILES): void {
  const file = stateFileOf({ dataDir });
  if (!files.exists(file)) return;
  const state = files.readState(file);
  state.trial = null;
  state.active = null;
  state.previous = null;
  state.attempts = 0;
  state.scheduled = null;
  files.writeState(file, state);
  log('every overlay forgotten; the next start boots the bundled Claudio');
}

/**
 * What the shell reads of `GET /api/system/server-update` for its tray and menus, checked rather
 * than trusted (the server may be another version's payload). The page has the whole status.
 */
export interface PayloadFacts {
  unsupportedReason: string | null;
  /** The base payload's version: the shell's */
  base: string;
  running: string;
  source: 'image' | 'overlay';
  state: string;
  target: string | null;
  needsShell: { version: string; minShell: string } | null;
  offer: { version: string; installable: boolean; blocked: string | null } | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const ver = (v: unknown): string | null => (typeof v === 'string' && VERSION.test(v) ? v : null);

export function parsePayloadFacts(raw: unknown): PayloadFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const base = ver(r.image);
  const running = ver(r.running);
  const state = str(r.state);
  if (!base || !running || !state) return null;
  const ns = r.needsShell && typeof r.needsShell === 'object' ? (r.needsShell as Record<string, unknown>) : null;
  const nsVersion = ver(ns?.version);
  const nsMin = ver(ns?.minShell);
  const of = r.offer && typeof r.offer === 'object' ? (r.offer as Record<string, unknown>) : null;
  const offerVersion = ver(of?.version);
  return {
    unsupportedReason: str(r.unsupportedReason),
    base,
    running,
    source: r.source === 'overlay' ? 'overlay' : 'image',
    state,
    target: ver(r.target),
    needsShell: nsVersion && nsMin ? { version: nsVersion, minShell: nsMin } : null,
    offer: offerVersion ? { version: offerVersion, installable: of?.installable === true, blocked: str(of?.blocked) } : null,
  };
}

/** What the page asks the shell to do with the payload over `claudio:payload` (D8) */
export type PayloadAction =
  | { action: 'download'; version?: string }
  | { action: 'apply' | 'revert'; force?: boolean; whenIdle?: boolean }
  | { action: 'cancel-scheduled' };

/** The page's request reduced to what each action may carry; null for anything else */
export function parsePayloadAction(value: unknown): PayloadAction | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.action === 'download') {
    const version = ver(r.version);
    return version ? { action: 'download', version } : { action: 'download' };
  }
  if (r.action === 'apply' || r.action === 'revert') return { action: r.action, force: r.force === true, whenIdle: r.whenIdle === true };
  if (r.action === 'cancel-scheduled') return { action: 'cancel-scheduled' };
  return null;
}

/** The phase-1 route each action is, called with the shell's own credential */
export function payloadRequest(action: PayloadAction): { method: 'POST' | 'DELETE'; path: string; body?: Record<string, unknown> } {
  switch (action.action) {
    case 'download':
      return { method: 'POST', path: '/api/system/server-update/download', body: action.version ? { version: action.version } : {} };
    case 'apply':
    case 'revert':
      return { method: 'POST', path: `/api/system/server-update/${action.action}`, body: { force: action.force === true, whenIdle: action.whenIdle === true } };
    case 'cancel-scheduled':
      return { method: 'DELETE', path: '/api/system/server-update/scheduled' };
  }
}

/**
 * The answer the page gets: the route's JSON when it succeeded, else `{ status, code, live }`. The
 * server's `error` text is left out on purpose: the web shows a refusal from its code only.
 */
export async function payloadAnswer(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return body;
  const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return { status: res.status, code: str(r.code), ...(r.live && typeof r.live === 'object' ? { live: r.live } : {}) };
}
