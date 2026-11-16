// The desktop's daemon (layer 1 of docs/plans/survive-restarts.md): the process that supervises the
// server outside Electron, so closing the window, or quitting it with work live, stops nothing. The
// window starts it in a transient user unit (D2, `daemon-launch.ts`) and is from then on a client:
// it finds it through `<dataDir>/daemon.json` and speaks to it over a Unix socket.
//
// It runs the same payload machine the window used to run (`PayloadHost`, core's `launcher/machine.ts`):
// overlays, trials, rollbacks, exit 75. What it adds is what a process outliving the window needs:
// the window's facts and keyring key handed over its socket, a crash restarted with a bounded backoff,
// "stop all work" against "let it run on", and an end of its own once no window is attached and
// nothing has been live for a while. Free of Electron, so it runs on the desktop binary as plain Node
// and is tested with fakes.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { ADOPTED_PORT_TAKEN_EXIT_CODE, DATA_DIR_LOCKED_EXIT_CODE } from '@claudio/core/launcher/protocol';
import {
  DAEMON_PROTOCOL,
  DAEMON_SOCKET,
  lineReader,
  parseToDaemon,
  processStarted,
  removeDaemonRecord,
  writeDaemonRecord,
  type DaemonBoot,
  type DaemonPhase,
  type DaemonState,
  type FromDaemon,
  type LaunchFacts,
  type ToDaemon,
} from './daemon-protocol.ts';
import type { LiveSnapshot } from './live.ts';
import { PayloadHost, forgetOverlays, readShellJson, type PayloadBoot, type PayloadEnd, type PayloadHostOptions, type ServerHandle } from './payload.ts';

/** A server that crashed after it listened is started again after 1, 2, 4… seconds, at most this long */
export const CRASH_DELAY_MAX_MS = 30_000;
/** This many crashes inside `CRASH_WINDOW_MS` and the daemon stops trying until a window asks */
export const CRASH_LIMIT = 5;
export const CRASH_WINDOW_MS = 10 * 60_000;
/** With no window attached, nothing live for this long ends the daemon and its server */
export const IDLE_STOP_MS = 2 * 60_000;
/** A daemon no window ever handed its facts to (a unit restarted by systemd at night) ends after this */
export const WAITING_MAX_MS = 10 * 60_000;
/** A server asked to stop all work has this long to stop its chats before it is killed */
export const STOP_WORK_GRACE_MS = 20_000;

/**
 * How long to wait before starting a server that crashed again, given when the earlier crashes were;
 * null once it crashed `CRASH_LIMIT` times within `CRASH_WINDOW_MS`, so a server that dies on every
 * start is not restarted for ever.
 */
export function crashDelay(earlier: readonly number[], now: number): number | null {
  const recent = earlier.filter((at) => now - at < CRASH_WINDOW_MS).length;
  if (recent >= CRASH_LIMIT) return null;
  return Math.min(1000 * 2 ** recent, CRASH_DELAY_MAX_MS);
}

/** What the window's error page says when the port the running chats hold is taken */
export function portTakenDetail(log: string | null): string {
  const line = log?.split('\n').find((l) => l.includes('is taken'))?.trim();
  return line ?? 'The port the running chats reach Claudio on is taken by another program. Free it, then try again.';
}

/** The idle clock: when nothing has been live since, or null while something is */
export function idleSince(snapshot: LiveSnapshot | null, since: number | null, now: number): number | null {
  if (!snapshot) return since;
  const live = snapshot.working > 0 || snapshot.waiting > 0 || snapshot.running > 0;
  return live ? null : (since ?? now);
}

/** The server the daemon starts for one boot, as `ServerProcess` runs it */
export interface DaemonServer extends ServerHandle {
  /** Asks it to close and stop its parked work; false when it did not say it would */
  stopWork(): Promise<boolean>;
}

/** The payload machine's host, as the daemon drives it */
export type DaemonHost = Pick<PayloadHost, 'run' | 'stop' | 'windowLoading' | 'pageReady'>;

/** What the daemon watches while no window is attached; `LiveMonitor` in the real one */
export interface IdleWatch {
  start(): void;
  stop(): void;
}

export interface DaemonOptions {
  dataDir: string;
  /** The desktop version this daemon is */
  version: string;
  followsShell: boolean;
  unit: string | null;
  socketPath?: string;
  /** Starts the server of a boot with the env the daemon built for it */
  spawnServer(boot: PayloadBoot, env: NodeJS.ProcessEnv, launch: LaunchFacts): DaemonServer;
  /** The env of a boot's server, from the window's facts (`serverEnv`) */
  serverEnv(launch: LaunchFacts, boot: PayloadBoot, token: string): NodeJS.ProcessEnv;
  health(origin: string): Promise<boolean>;
  watchIdle(origin: string, token: string, onSnapshot: (snapshot: LiveSnapshot) => void): IdleWatch;
  log(line: string): void;
  /** Where the server writes, for the window's error page */
  serverLogPath?: string;
  /** Builds the payload machine's host; a test hands in a fake */
  newHost?: (options: PayloadHostOptions) => DaemonHost;
  now?: () => number;
  pid?: number;
  started?: number;
  idleStopMs?: number;
  waitingMaxMs?: number;
  /** How often the idle and waiting clocks are looked at */
  tickMs?: number;
}

export class Daemon {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly started: number;
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  /** The clients that said hello: the windows */
  private readonly windows = new Set<Socket>();
  private launch: LaunchFacts | null = null;
  private launched: (() => void) | null = null;
  private host: DaemonHost | null = null;
  private phase: DaemonPhase = 'waiting';
  private url: string | null = null;
  private boot: DaemonBoot | null = null;
  private detail: string | null = null;
  private crashes: number[] = [];
  private stopMode: 'stop-work' | 'detach' | null = null;
  private restartRequested = false;
  private forgetOverlaysNext = false;
  /** Wakes a supervisor waiting after a failure or during a crash pause */
  private wake: (() => void) | null = null;
  private watch: IdleWatch | null = null;
  private idleFrom: number | null = null;
  private readonly bornAt: number;
  private ticker: NodeJS.Timeout | null = null;
  private finished: Promise<number> | null = null;
  private finish: (code: number) => void = () => undefined;

  constructor(private readonly o: DaemonOptions) {
    this.socketPath = o.socketPath ?? join(o.dataDir, DAEMON_SOCKET);
    this.now = o.now ?? Date.now;
    this.pid = o.pid ?? process.pid;
    this.started = o.started ?? processStarted(this.pid) ?? 0;
    this.bornAt = this.now();
  }

  /**
   * Listens on the socket and supervises until it is told to stop, or ends on its own (idle, or
   * never handed its facts). Resolves to the exit code; 0 when another daemon already serves this
   * data directory.
   */
  run(): Promise<number> {
    this.finished ??= new Promise<number>((resolve) => {
      this.finish = resolve;
      void this.begin();
    });
    return this.finished;
  }

  private async begin(): Promise<void> {
    mkdirSync(this.o.dataDir, { recursive: true });
    if (!(await this.listen())) {
      this.o.log('another daemon already answers on this data directory; leaving it be');
      this.finish(0);
      return;
    }
    this.writeRecord();
    this.ticker = setInterval(() => this.tick(), this.o.tickMs ?? 15_000);
    this.ticker.unref();
    this.o.log(`daemon ${this.o.version} (pid ${String(this.pid)}${this.o.unit ? `, unit ${this.o.unit}` : ', setsid'}) waiting for a window`);
    await new Promise<void>((resolve) => {
      this.launched = resolve;
    });
    if (this.stopMode === null) await this.supervise();
    await this.end();
  }

  /** True once this daemon listens; false when a live daemon answers there already */
  private async listen(): Promise<boolean> {
    const server = createServer((socket) => this.accept(socket));
    const attempt = () =>
      new Promise<NodeJS.ErrnoException | null>((resolve) => {
        server.once('error', (err: NodeJS.ErrnoException) => resolve(err));
        // Owner-only from the first instant: the socket hands out the desktop credential
        const mask = process.umask(0o077);
        server.listen(this.socketPath, () => resolve(null));
        process.umask(mask);
      });
    let err = await attempt();
    if (err?.code === 'EADDRINUSE') {
      if (await answers(this.socketPath)) return false;
      // A daemon that died left its socket file behind
      rmSync(this.socketPath, { force: true });
      err = await attempt();
    }
    if (err) throw err;
    chmodSync(this.socketPath, 0o600);
    this.server = server;
    return true;
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.on(
      'data',
      lineReader((line) => {
        const message = parseToDaemon(line);
        if (message) void this.handle(socket, message);
      }),
    );
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.clients.delete(socket);
      if (this.windows.delete(socket) && this.windows.size === 0) this.noWindow();
    });
  }

  private async handle(socket: Socket, message: ToDaemon): Promise<void> {
    switch (message.type) {
      case 'hello':
        this.windows.add(socket);
        this.stopIdleWatch();
        if (message.protocol !== DAEMON_PROTOCOL) this.o.log(`a window of protocol ${String(message.protocol)} attached; this daemon speaks ${String(DAEMON_PROTOCOL)}`);
        if (!this.launch) {
          this.launch = message.launch;
          this.o.log(`window ${message.version} handed over its facts; starting the server`);
          this.launched?.();
        }
        this.send(socket, { type: 'state', state: this.state() });
        return;
      case 'window-loading':
        this.host?.windowLoading();
        return;
      case 'page-ready':
        this.host?.pageReady();
        return;
      case 'restart-server':
        await this.restart(false);
        return;
      case 'use-bundled':
        await this.restart(true);
        return;
      case 'stop':
        await this.stop(message.work);
        return;
    }
  }

  /** The server starts again: at once after a failure, or after the running one closed (letting parked work go) */
  private async restart(useBundled: boolean): Promise<void> {
    if (this.stopMode !== null || !this.launch) return;
    this.forgetOverlaysNext ||= useBundled;
    this.crashes = [];
    if (this.host && this.phase !== 'failed' && this.phase !== 'restarting') {
      this.restartRequested = true;
      this.setPhase('starting', null);
      await this.host.stop();
    } else {
      this.wake?.();
    }
  }

  /** Ends the daemon: every chat stopped (`stop-work`), or parked work let go for the next one (`detach`) */
  async stop(work: 'stop-work' | 'detach'): Promise<void> {
    if (this.stopMode !== null) return;
    this.stopMode = work;
    this.o.log(work === 'stop-work' ? 'stopping the server and all its work' : 'stopping the server; parked work runs on for the next one');
    this.setPhase('stopping', null);
    this.wake?.();
    this.launched?.();
    await this.host?.stop();
  }

  private async supervise(): Promise<void> {
    for (;;) {
      if (this.stopMode !== null || !this.launch) return;
      const launch = this.launch;
      if (this.forgetOverlaysNext) {
        this.forgetOverlaysNext = false;
        forgetOverlays(launch.dataDir, (line) => this.o.log(`payload: ${line}`));
      }
      this.restartRequested = false;
      this.setPhase('starting', null);
      const host = this.newHost(launch);
      this.host = host;
      const end = await host.run();
      this.host = null;
      this.url = null;
      this.boot = null;
      if (this.stopMode !== null) return;
      if (this.restartRequested) continue;
      if (end.why === 'relaunch') {
        // The person asked for the whole app to start again: the window relaunches itself, and the
        // server starts again here, on what the shell's files now are
        this.o.log('the server asked for the app to start again (exit 76)');
        this.broadcast({ type: 'relaunch-window' });
        continue;
      }
      if (end.why === 'stopped') return;
      await this.afterExit(end);
    }
  }

  /** A server that went on its own: started again after a pause, unless it never listened or keeps dying */
  private async afterExit(end: Extract<PayloadEnd, { why: 'exited' }>): Promise<void> {
    if (end.code === ADOPTED_PORT_TAKEN_EXIT_CODE) {
      // The CLIs that outlived the last server reach the API only on their port: another one would
      // strand them, and the same one is still taken a second later
      this.o.log('the port the running chats hold is taken; waiting for a window to ask again');
      this.setPhase('failed', portTakenDetail(end.detail));
      await this.pause(null);
      return;
    }
    if (!end.ready || end.code === DATA_DIR_LOCKED_EXIT_CODE) {
      // Another server on the data dir, a broken payload: starting it again changes nothing, so a
      // window shows why and offers to try
      this.setPhase('failed', end.detail);
      await this.pause(null);
      return;
    }
    const now = this.now();
    const delay = crashDelay(this.crashes, now);
    this.crashes.push(now);
    if (delay === null) {
      this.o.log(`the server stopped ${String(CRASH_LIMIT)} times in ${String(CRASH_WINDOW_MS / 60_000)} minutes; waiting for a window to ask again`);
      this.setPhase('failed', end.detail);
      await this.pause(null);
      return;
    }
    this.o.log(`the server stopped unexpectedly (code ${String(end.code)}); starting it again in ${String(delay / 1000)} s`);
    this.setPhase('restarting', end.detail);
    await this.pause(delay);
  }

  /** Waits `ms`, or until a window asks or a stop comes; null waits for those only */
  private pause(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      function done(): void {
        if (timer) clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  private newHost(launch: LaunchFacts): DaemonHost {
    // Read at every start: where the shell's files sit on a stable path, a newer shell installed
    // under a running daemon is what its next server runs (`followsShell`)
    const read = readShellJson(launch.shellJson);
    const shell = read && (this.o.followsShell || read.version === launch.version) ? read : null;
    const options: PayloadHostOptions = {
      bundledDir: launch.bundledDir,
      bundledWeb: launch.bundledWeb,
      keysDir: launch.keysDir,
      dataDir: launch.dataDir,
      shell,
      ignoreOverlays: launch.ignoreOverlays,
      spawn: (boot) => this.spawn(boot, launch, shell?.version),
      onReady: (url, boot) => this.ready(url, boot),
      health: (origin) => this.o.health(origin),
      needsPage: () => this.windows.size > 0,
      stopGraceMs: STOP_WORK_GRACE_MS,
      log: (line) => this.o.log(`payload: ${line}`),
    };
    return this.o.newHost ? this.o.newHost(options) : new PayloadHost(options);
  }

  private spawn(boot: PayloadBoot, launch: LaunchFacts, shellVersion: string | undefined): ServerHandle {
    this.boot = { version: boot.version, bundled: boot.bundled, trial: boot.trial };
    this.url = null;
    this.setPhase('starting', null);
    const facts = shellVersion ? { ...launch, version: shellVersion } : launch;
    const server = this.o.spawnServer(boot, this.o.serverEnv(facts, boot, this.token), launch);
    return {
      ready: server.ready,
      exited: server.exited,
      detail: () => server.detail(),
      kill: () => server.kill(),
      stop: () => {
        if (this.stopMode !== 'stop-work') {
          server.stop();
          return;
        }
        void server.stopWork().then((acked) => {
          if (!acked) {
            this.o.log('the server did not take the request to stop its work; stopping it as on a restart');
            server.stop();
          }
        });
      },
    };
  }

  private ready(url: string, boot: PayloadBoot): void {
    this.url = url;
    this.boot = { version: boot.version, bundled: boot.bundled, trial: boot.trial };
    this.o.log(`server ready at ${url}: Claudio ${boot.version}${boot.bundled ? '' : ' from the data dir'}${boot.trial ? ', on trial' : ''}`);
    this.setPhase('ready', null);
    if (this.windows.size === 0) this.startIdleWatch();
  }

  private setPhase(phase: DaemonPhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    if (phase !== 'ready') this.stopIdleWatch();
    this.writeRecord();
    this.broadcast({ type: 'state', state: this.state() });
  }

  state(): DaemonState {
    return {
      protocol: DAEMON_PROTOCOL,
      version: this.o.version,
      followsShell: this.o.followsShell,
      phase: this.phase,
      url: this.phase === 'ready' ? this.url : null,
      token: this.token,
      boot: this.boot,
      detail: this.detail,
      serverLog: this.o.serverLogPath ?? null,
    };
  }

  private writeRecord(): void {
    if (!this.server) return;
    try {
      writeDaemonRecord(this.o.dataDir, {
        protocol: DAEMON_PROTOCOL,
        pid: this.pid,
        started: this.started,
        version: this.o.version,
        followsShell: this.o.followsShell,
        unit: this.o.unit,
        socket: this.socketPath,
        url: this.phase === 'ready' ? this.url : null,
        token: this.token,
      });
    } catch (err) {
      this.o.log(`daemon.json not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private send(socket: Socket, message: FromDaemon): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  private broadcast(message: FromDaemon): void {
    for (const socket of this.windows) this.send(socket, message);
  }

  /** The last window went (it quit leaving the work running, or it died): the idle clock starts */
  private noWindow(): void {
    this.o.log('no window attached; the server runs on until nothing is live');
    if (this.phase === 'ready') this.startIdleWatch();
  }

  private startIdleWatch(): void {
    if (this.watch || !this.url || this.stopMode !== null) return;
    this.idleFrom = null;
    this.watch = this.o.watchIdle(new URL(this.url).origin, this.token, (snapshot) => {
      this.idleFrom = idleSince(snapshot, this.idleFrom, this.now());
      this.tick();
    });
    this.watch.start();
  }

  private stopIdleWatch(): void {
    this.watch?.stop();
    this.watch = null;
    this.idleFrom = null;
  }

  private tick(): void {
    if (this.stopMode !== null) return;
    const now = this.now();
    if (!this.launch && this.windows.size === 0 && now - this.bornAt >= (this.o.waitingMaxMs ?? WAITING_MAX_MS)) {
      this.o.log('no window came to hand over its facts; ending');
      void this.stop('detach');
      return;
    }
    if (this.watch && this.windows.size === 0 && this.idleFrom !== null && now - this.idleFrom >= (this.o.idleStopMs ?? IDLE_STOP_MS)) {
      this.o.log(`nothing live for ${String(Math.round((now - this.idleFrom) / 1000))} s with no window; stopping`);
      void this.stop('stop-work');
    }
  }

  private async end(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.stopIdleWatch();
    removeDaemonRecord(this.o.dataDir, this.pid);
    this.broadcast({ type: 'stopped' });
    for (const socket of this.clients) socket.end();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // A window that keeps its connection open does not hold the exit
      setTimeout(resolve, 2_000).unref();
    });
    rmSync(this.socketPath, { force: true });
    this.o.log('daemon stopped');
    this.finish(0);
  }
}

/** Whether something answers on a Unix socket now */
export function answers(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
