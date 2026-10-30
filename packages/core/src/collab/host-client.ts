import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CollaboratorsUnavailableCode } from '@claudio/shared';
import { IROH_MODULE_ENV, type CoreToHost, type HostStartOptions, type HostTarget, type HostToCore } from './host/protocol.ts';
import type { ReplySink } from './serve.ts';
import type { WireReply } from './wire.ts';

/*
 * The core's side of the Collaborators host (docs/plans/collaborators.md §3.2): forks
 * `collab-host.mjs` the way `terminals/host-client.ts` forks the terminal host, hands every request a
 * peer sends to the serving side, relays the requests this install makes, and restarts the host when
 * it dies. The API process never loads `@number0/iroh`; only the host does.
 */

/** `CLAUDIO_COLLAB_HOST`: the bundled host's path, for a layout where it is not beside the server's own bundle */
export const COLLAB_HOST_ENV = 'CLAUDIO_COLLAB_HOST';

export interface HostLaunch {
  entry: string;
  execArgv: string[];
}

/**
 * How the host is started: `collab-host.mjs` beside the bundled server (or where
 * `CLAUDIO_COLLAB_HOST` says), else `host/main.ts` of a source tree through `tsx`. Null when neither
 * is there.
 */
export function collabHostLaunch(env: NodeJS.ProcessEnv = process.env): HostLaunch | null {
  const bundled = env[COLLAB_HOST_ENV] ?? fileURLToPath(new URL('./collab-host.mjs', import.meta.url));
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

/** What a reply of a request this install made is made of, in order */
export type HostReplyPart = { frame: unknown } | { bytes: Uint8Array };

export type HostStatus = Extract<HostToCore, { type: 'status' }>;
export type HostPeer = Extract<HostToCore, { type: 'peer' }>;

export interface HostUnavailable {
  code: CollaboratorsUnavailableCode;
  message: string;
}

export interface CollabHostListener {
  status?(status: HostStatus): void;
  peer?(peer: HostPeer): void;
  /** The binding cannot load here, or the host kept dying: Collaborators stays off with this reason */
  unavailable?(reason: HostUnavailable): void;
  /** The host died and was started again: its connections were lost, and the status starts over */
  restarted?(info: { reason: string; attempt: number }): void;
  startError?(message: string): void;
  log?(message: string): void;
}

/** What answers a request a peer sent: `serve.ts`'s `CollabServer.handle` */
export type IncomingHandler = (from: string, frame: unknown, sink: ReplySink) => Promise<void>;

export interface CollabHostOptions {
  serve: IncomingHandler;
  listener?: CollabHostListener;
  launch?: () => HostLaunch | null;
  /** Restarts allowed within `restartWindowMs` before the host is given up as `unavailable: host` */
  maxRestarts?: number;
  restartWindowMs?: number;
  restartDelayMs?: (attempt: number) => number;
  /** How long after the endpoint failed to bind it is asked to bind again; doubles from 1 s up to a minute by default */
  rebindDelayMs?: (failures: number) => number;
  /** Variables passed to the host on top of what its runtime needs; for tests */
  env?: NodeJS.ProcessEnv;
}

const STOP_TIMEOUT_MS = 3000;

/** A queue a request's replies are pushed into and read out of with `for await` */
class ReplyQueue implements AsyncIterableIterator<HostReplyPart> {
  private readonly parts: HostReplyPart[] = [];
  private waiting: { resolve: (r: IteratorResult<HostReplyPart>) => void; reject: (e: Error) => void } | null = null;
  private done = false;
  private error: Error | null = null;

  constructor(private readonly onReturn: () => void) {}

  push(part: HostReplyPart): void {
    if (this.done) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting.resolve({ value: part, done: false });
    } else {
      this.parts.push(part);
    }
  }

  end(error?: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = error ?? null;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      if (error) waiting.reject(error);
      else waiting.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<HostReplyPart>> {
    const part = this.parts.shift();
    if (part) return Promise.resolve({ value: part, done: false });
    if (this.done) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  return(): Promise<IteratorResult<HostReplyPart>> {
    if (!this.done) {
      this.done = true;
      this.parts.length = 0;
      this.onReturn();
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<HostReplyPart> {
    return this;
  }
}

/** Why the endpoint did not bind, and when it is asked again: a port taken, a relay URL that does not parse */
export interface HostBindError {
  message: string;
  /** When the next bind is tried; null while none is planned (the host is restarting, or stopped) */
  retryAt: string | null;
}

export class CollabHost {
  private child: ChildProcess | null = null;
  private ready = false;
  private readonly outbox: CoreToHost[] = [];
  /** What the host was last asked to bind; resent after a restart. Null while Collaborators is off */
  private options: HostStartOptions | null = null;
  private disposed = false;
  private failure: HostUnavailable | null = null;
  private readonly restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private nextRequest = 1;
  private readonly requests = new Map<number, ReplyQueue>();
  private readonly incoming = new Map<number, AbortController>();
  private stopped: (() => void) | null = null;
  private lastStatus: HostStatus | null = null;
  /** The last bind failed: said on the page as an error, and tried again with a backoff until a status comes */
  private bindError: HostBindError | null = null;
  private bindFailures = 0;
  private rebindTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CollabHostOptions) {}

  /** Why Collaborators cannot run, once that is known; null while it can */
  get unavailable(): HostUnavailable | null {
    return this.failure;
  }

  /** The endpoint's last polled status while it is bound */
  get status(): HostStatus | null {
    return this.lastStatus;
  }

  /** Why the last bind failed, while no bind has worked since */
  get startError(): HostBindError | null {
    return this.bindError ? { ...this.bindError } : null;
  }

  /**
   * Binds the endpoint, forking the host first; again with new options rebinds it. A host that is
   * not running is forked now, even inside a restart's backoff: the person asked, and the fork
   * sends `start` before anything else.
   */
  start(options: HostStartOptions): void {
    if (this.disposed || this.failure) return;
    this.options = options;
    this.clearBindError();
    if (this.child) {
      this.post({ type: 'start', options });
      return;
    }
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.spawn();
  }

  /** Closes the endpoint and lets the host go: with Collaborators off, nothing of iroh is loaded */
  async stop(): Promise<void> {
    this.options = null;
    this.lastStatus = null;
    this.clearBindError();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    if (child.connected && this.ready) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
        this.stopped = () => {
          clearTimeout(timer);
          resolve();
        };
        this.post({ type: 'stop' });
      });
      this.stopped = null;
    }
    this.release(child);
  }

  /**
   * Sends one request to a peer and yields its reply: frames, and the raw bytes after a frame that
   * announces them. Leaving the loop early cancels the stream; a lost host or peer throws.
   */
  request(to: HostTarget, frame: unknown): AsyncIterableIterator<HostReplyPart> {
    const req = this.nextRequest++;
    const queue = new ReplyQueue(() => {
      this.requests.delete(req);
      // A cancel is for the host that took the request; it never forks one
      if (this.child) this.post({ type: 'cancel', req });
    });
    if (!this.options || this.failure) {
      queue.end(new Error('Collaborators is not running'));
      return queue;
    }
    this.requests.set(req, queue);
    if (!this.post({ type: 'request', req, to, frame })) {
      // Inside a restart's backoff nothing is forked for a request: the peer reads as unreachable,
      // and the timer brings the host back with its `start`
      this.requests.delete(req);
      queue.end(new Error('unreachable: the Collaborators host is restarting'));
    }
    return queue;
  }

  /** Closes every connection to a peer, for a member just removed */
  disconnect(endpointId: string): void {
    if (this.child) this.post({ type: 'disconnect', endpointId });
  }

  dispose(): void {
    this.disposed = true;
    this.options = null;
    this.clearBindError();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child) this.release(this.child);
  }

  /** The host's pid, for a test that kills it */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  // ---------- The process ----------

  /**
   * Hands a message to the host, forking it when none runs. False when it could not be handed: the
   * host is gone for good, or is inside a restart's backoff, which only its timer ends.
   */
  private post(message: CoreToHost): boolean {
    if (!this.child) {
      if (this.restartTimer) return false;
      if (!this.spawn()) return false;
    }
    if (!this.ready) {
      this.outbox.push(message);
      return true;
    }
    this.deliver(message);
    return true;
  }

  private deliver(message: CoreToHost, done?: () => void): void {
    const child = this.child;
    if (!child?.connected) {
      done?.();
      return;
    }
    try {
      child.send(message, () => done?.());
    } catch {
      // The channel closed between the check and the send; the exit handler reports it
      done?.();
    }
  }

  /** Sends and resolves once the message left, so a large blob is not piled up in the channel */
  private deliverAsync(message: CoreToHost): Promise<void> {
    return new Promise((resolve) => this.deliver(message, resolve));
  }

  private spawn(): ChildProcess | null {
    if (this.disposed || this.failure) return null;
    const launch = (this.opts.launch ?? collabHostLaunch)();
    if (!launch) {
      this.giveUp({ code: 'host', message: 'the Collaborators host is not there' });
      return null;
    }
    // Its environment is what its runtime needs and nothing of the server's: it holds no CLAUDIO_* secret
    const env: NodeJS.ProcessEnv = { ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...this.opts.env };
    if (process.env[IROH_MODULE_ENV] && !env[IROH_MODULE_ENV]) env[IROH_MODULE_ENV] = process.env[IROH_MODULE_ENV];
    const child = fork(launch.entry, [], { execPath: process.execPath, execArgv: launch.execArgv, env, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child = child;
    this.ready = false;
    // Whatever forked it, a host with options to bind binds first: a request that forked it must
    // not leave it running with no endpoint
    if (this.options) this.outbox.push({ type: 'start', options: this.options });
    child.on('message', (message: HostToCore) => {
      if (this.child === child) this.receive(message);
    });
    child.on('error', (error) => this.opts.listener?.log?.(`collab host: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.lost(`the Collaborators host exited (${signal ?? String(code)})`);
    });
    return child;
  }

  /** Lets a host go on purpose: it closes its endpoint itself when the channel closes */
  private release(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.ready = false;
    }
    this.outbox.length = 0;
    this.failPending(new Error('the Collaborators host stopped'));
    if (child.connected) child.disconnect();
  }

  private failPending(error: Error): void {
    for (const queue of this.requests.values()) queue.end(error);
    this.requests.clear();
    for (const controller of this.incoming.values()) controller.abort();
    this.incoming.clear();
  }

  /** The host died with nobody asking it to */
  private lost(reason: string): void {
    this.failPending(new Error(reason));
    this.lastStatus = null;
    // What was queued for the dead host is not replayed into the next one: it gets its own `start`
    this.outbox.length = 0;
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    this.rebindTimer = null;
    if (this.bindError) this.bindError = { ...this.bindError, retryAt: null };
    if (this.disposed || this.failure || !this.options) return;
    const now = Date.now();
    const window = this.opts.restartWindowMs ?? 60_000;
    while (this.restarts.length && (this.restarts[0] ?? 0) < now - window) this.restarts.shift();
    if (this.restarts.length >= (this.opts.maxRestarts ?? 5)) {
      this.giveUp({ code: 'host', message: `${reason}, and kept dying` });
      return;
    }
    this.restarts.push(now);
    const attempt = this.restarts.length;
    this.opts.listener?.restarted?.({ reason, attempt });
    const delay = (this.opts.restartDelayMs ?? ((n) => Math.min(30_000, 500 * 2 ** (n - 1))))(attempt);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.options && !this.child) this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private giveUp(reason: HostUnavailable): void {
    if (this.failure) return;
    this.failure = reason;
    this.options = null;
    this.clearBindError();
    this.opts.listener?.unavailable?.(reason);
  }

  private clearBindError(): void {
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    this.rebindTimer = null;
    this.bindError = null;
    this.bindFailures = 0;
  }

  /** The endpoint did not bind: said as an error, and asked again later and later until it binds */
  private bindFailed(message: string): void {
    if (!this.options || this.disposed) return;
    this.bindFailures += 1;
    const delay = (this.opts.rebindDelayMs ?? ((n) => Math.min(60_000, 1_000 * 2 ** Math.min(n - 1, 6))))(this.bindFailures);
    this.bindError = { message, retryAt: new Date(Date.now() + delay).toISOString() };
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    this.rebindTimer = setTimeout(() => {
      this.rebindTimer = null;
      if (this.options && this.child) this.post({ type: 'start', options: this.options });
    }, delay);
    this.rebindTimer.unref?.();
  }

  // ---------- Messages ----------

  private receive(message: HostToCore): void {
    switch (message.type) {
      case 'ready': {
        this.ready = true;
        const queued = this.outbox.splice(0);
        for (const m of queued) this.deliver(m);
        return;
      }
      case 'unavailable':
        this.giveUp({ code: message.code, message: message.message });
        if (this.child) this.release(this.child);
        return;
      case 'start-error':
        this.bindFailed(message.message);
        this.opts.listener?.startError?.(message.message);
        return;
      case 'status':
        if (this.bindError) this.clearBindError();
        this.lastStatus = message;
        this.opts.listener?.status?.(message);
        return;
      case 'stopped':
        this.stopped?.();
        return;
      case 'peer':
        this.opts.listener?.peer?.(message);
        return;
      case 'log':
        this.opts.listener?.log?.(`collab host: ${message.message}`);
        return;
      case 'incoming':
        this.serve(message.stream, message.from, message.frame);
        return;
      case 'incoming-closed':
        this.incoming.get(message.stream)?.abort();
        this.incoming.delete(message.stream);
        return;
      case 'response':
        this.requests.get(message.req)?.push({ frame: message.frame });
        return;
      case 'response-bytes':
        this.requests.get(message.req)?.push({ bytes: message.data });
        return;
      case 'response-end':
        this.requests.get(message.req)?.end();
        this.requests.delete(message.req);
        return;
      case 'response-error':
        this.requests.get(message.req)?.end(new Error(message.message));
        this.requests.delete(message.req);
        return;
    }
  }

  private serve(stream: number, from: string, frame: unknown): void {
    const controller = new AbortController();
    this.incoming.set(stream, controller);
    const sink: ReplySink = {
      frame: (reply: WireReply) => (controller.signal.aborted ? Promise.reject(new Error('the stream closed')) : this.deliverAsync({ type: 'reply', stream, frame: reply })),
      bytes: (data: Uint8Array) => (controller.signal.aborted ? Promise.reject(new Error('the stream closed')) : this.deliverAsync({ type: 'reply-bytes', stream, data })),
      signal: controller.signal,
    };
    void this.opts
      .serve(from, frame, sink)
      .catch((error: unknown) => this.opts.listener?.log?.(`collab: serving ${from.slice(0, 10)} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.incoming.get(stream) !== controller) return;
        this.incoming.delete(stream);
        if (!controller.signal.aborted) this.deliver({ type: 'reply-end', stream });
      });
  }
}
