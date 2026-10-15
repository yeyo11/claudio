import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TerminalHostCore, type HostDeps } from './host/host.ts';
import type { HostFailure, HostReply, HostRequest, SpawnMessage } from './host/protocol.ts';

/** `CLAUDIO_TERMINAL_HOST`: the bundled host's path, for a layout where it is not beside the server's own bundle */
export const TERMINAL_HOST_ENV = 'CLAUDIO_TERMINAL_HOST';

export interface HostSnapshot {
  snapshot: string;
  tail: Buffer;
  cols: number;
  rows: number;
}

/** What the host says unprompted */
export interface HostListener {
  data(id: string, data: Buffer): void;
  exit(id: string, code: number | null, signal: string | null): void;
  /** The host process died, or could not be started: every shell it held is gone */
  failed(reason: string): void;
}

export class HostSpawnError extends Error {
  constructor(
    readonly reason: HostFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HostSpawnError';
  }
}

/** The service's side of the host: an interface, so a test can put a host of its own behind it */
export interface TerminalHost {
  spawn(message: Omit<SpawnMessage, 'type'>): Promise<{ pid: number; pidStarted: number | null }>;
  write(id: string, data: Buffer): void;
  resize(id: string, cols: number, rows: number): void;
  pause(id: string): void;
  resume(id: string): void;
  snapshot(id: string, replayLines: number, maxBytes: number): Promise<HostSnapshot>;
  kill(id: string, graceMs: number): void;
  killAll(graceMs: number): void;
  forget(id: string): void;
  /** Lets the host go: it ends every shell it holds and exits */
  dispose(): void;
}

export type HostFactory = (listener: HostListener) => TerminalHost;

/** What a request waits for, whichever way the host is reached */
class Pending {
  private nextRequest = 1;
  private readonly spawns = new Map<string, { ok: (r: { pid: number; pidStarted: number | null }) => void; fail: (e: Error) => void }>();
  private readonly snapshots = new Map<number, { ok: (r: HostSnapshot) => void; fail: (e: Error) => void }>();

  spawn(id: string): Promise<{ pid: number; pidStarted: number | null }> {
    return new Promise((ok, fail) => this.spawns.set(id, { ok, fail }));
  }

  snapshot(): { reqId: number; promise: Promise<HostSnapshot> } {
    const reqId = this.nextRequest++;
    return { reqId, promise: new Promise((ok, fail) => this.snapshots.set(reqId, { ok, fail })) };
  }

  /** Settles what a reply answers; returns whether it was one */
  reply(message: HostReply): boolean {
    switch (message.type) {
      case 'spawned':
        this.spawns.get(message.id)?.ok({ pid: message.pid, pidStarted: message.pidStarted });
        this.spawns.delete(message.id);
        return true;
      case 'spawn-error':
        this.spawns.get(message.id)?.fail(new HostSpawnError(message.reason, message.message));
        this.spawns.delete(message.id);
        return true;
      case 'snapshot':
        this.snapshots.get(message.reqId)?.ok({ snapshot: message.snapshot, tail: message.tail, cols: message.cols, rows: message.rows });
        this.snapshots.delete(message.reqId);
        return true;
      case 'snapshot-error':
        this.snapshots.get(message.reqId)?.fail(new Error('the terminal has no screen'));
        this.snapshots.delete(message.reqId);
        return true;
      default:
        return false;
    }
  }

  failAll(error: Error): void {
    for (const pending of this.spawns.values()) pending.fail(error);
    for (const pending of this.snapshots.values()) pending.fail(error);
    this.spawns.clear();
    this.snapshots.clear();
  }
}

/** A host that answers through a function: the one transport the two implementations differ in */
function hostOver(send: (message: HostRequest) => void, pending: Pending, dispose: () => void): TerminalHost {
  return {
    spawn: (message) => {
      const result = pending.spawn(message.id);
      send({ type: 'spawn', ...message });
      return result;
    },
    write: (id, data) => send({ type: 'write', id, data }),
    resize: (id, cols, rows) => send({ type: 'resize', id, cols, rows }),
    pause: (id) => send({ type: 'pause', id }),
    resume: (id) => send({ type: 'resume', id }),
    snapshot: (id, replayLines, maxBytes) => {
      const { reqId, promise } = pending.snapshot();
      send({ type: 'snapshot', id, reqId, replayLines, maxBytes });
      return promise;
    },
    kill: (id, graceMs) => send({ type: 'kill', id, graceMs }),
    killAll: (graceMs) => send({ type: 'killAll', graceMs }),
    forget: (id) => send({ type: 'forget', id }),
    dispose,
  };
}

/** Routes what the host says to the listener, or to the requests that wait for it */
function route(message: HostReply, pending: Pending, listener: HostListener): void {
  if (pending.reply(message)) return;
  if (message.type === 'data') listener.data(message.id, message.data);
  else if (message.type === 'exit') listener.exit(message.id, message.code, message.signal);
}

/** The host in this process, over a PTY backend of the caller's: for tests, which put a fake one behind it. */
export function inProcessHost(deps: Omit<HostDeps, 'send'>): HostFactory {
  return (listener) => {
    const pending = new Pending();
    const core = new TerminalHostCore({ ...deps, send: (message) => queueMicrotask(() => route(message, pending, listener)) });
    return hostOver(
      (message) => queueMicrotask(() => core.handle(message)),
      pending,
      () => core.close(),
    );
  };
}

/**
 * How the host is started. A bundled server has `terminal-host.mjs` beside its own file (or where
 * `CLAUDIO_TERMINAL_HOST` says), and a source tree runs `host/main.ts` through `tsx`, found from this
 * file, the way the MCP server is. Null when neither is there.
 */
export function terminalHostLaunch(env: NodeJS.ProcessEnv = process.env): { entry: string; execArgv: string[] } | null {
  const bundled = env[TERMINAL_HOST_ENV] ?? fileURLToPath(new URL('./terminal-host.mjs', import.meta.url));
  if (existsSync(bundled)) return { entry: bundled, execArgv: [] };
  const source = fileURLToPath(new URL('./host/main.ts', import.meta.url));
  if (!existsSync(source)) return null;
  try {
    const tsx = join(dirname(createRequire(source).resolve('tsx/package.json')), 'dist', 'loader.mjs');
    return { entry: source, execArgv: ['--import', pathToFileURL(tsx).href] };
  } catch {
    return null;
  }
}

/**
 * The host as a child process of the server (`fork`, not detached) started at the first terminal. Its
 * environment is empty but for what its runtime needs: it holds no `CLAUDIO_*` secret, and each shell
 * gets the environment `env.ts` builds for it. Under the desktop app the server runs on Electron's
 * Node, so the host is forked with `process.execPath` and `ELECTRON_RUN_AS_NODE=1` in its own
 * environment only, never in a shell's.
 */
export function forkedHost(options: { launch?: () => { entry: string; execArgv: string[] } | null } = {}): HostFactory {
  return (listener) => {
    const pending = new Pending();
    let child: ChildProcess | null = null;
    let disposed = false;

    const start = (): ChildProcess | null => {
      if (child) return child;
      const launch = (options.launch ?? terminalHostLaunch)();
      if (!launch) {
        queueMicrotask(() => listener.failed('the terminal host is not there'));
        return null;
      }
      const env: NodeJS.ProcessEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
      const started = fork(launch.entry, [], { execPath: process.execPath, execArgv: launch.execArgv, env, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      started.on('message', (message: HostReply) => route(message, pending, listener));
      started.on('error', () => undefined);
      started.on('exit', (code, signal) => {
        child = null;
        pending.failAll(new Error('the terminal host stopped'));
        if (!disposed) listener.failed(`the terminal host exited (${signal ?? String(code)})`);
      });
      child = started;
      return started;
    };

    const send = (message: HostRequest): void => {
      // Nothing is started for a message that needs no host: a write to a shell it no longer holds
      const target = message.type === 'spawn' ? start() : child;
      if (!target?.connected) {
        if (message.type === 'spawn') pending.failAll(new Error('the terminal host is not there'));
        return;
      }
      try {
        target.send(message);
      } catch {
        // The channel closed between the check and the send; the exit handler reports it
      }
    };

    return hostOver(send, pending, () => {
      disposed = true;
      const target = child;
      child = null;
      // The host sees the channel close and ends its shells itself, whether or not this process lives on
      if (target?.connected) target.disconnect();
    });
  };
}
