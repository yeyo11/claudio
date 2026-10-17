import type * as IrohModule from '@number0/iroh';
import { ALPN, ALPN_BYTES, FrameParser, MAX_REPLY_FRAME, MAX_REQUEST_FRAME, PIECE_BYTES, decodeFrameBody, encodeFrame, frameLength, rawLength } from '../wire.ts';
import type { CoreToHost, HostConnection, HostStartOptions, HostTarget, HostToCore, HostUnavailableCode } from './protocol.ts';

/*
 * The Collaborators host: the iroh endpoint, in a process of its own (docs/plans/collaborators.md
 * §3.2). `@number0/iroh` 1.1.0 aborts the whole process from any `watch*` method (a Rust panic no
 * `try/catch` sees) and ends it on an unhandled rejection, so it is loaded only here, lazily, and:
 *
 * - nothing is watched: addresses, the home relay and paths are polled;
 * - every promise from the binding is awaited inside a `try/catch`, or has a `catch` attached;
 * - bytes cross the binding as `Array<number>`, in pieces of at most 1 MiB (§7.2).
 *
 * The host decides nothing. A request a peer sends goes to the core as `incoming`, and what the core
 * answers goes back on the same stream; a request the core makes is dialled and its replies relayed.
 */

type Iroh = typeof IrohModule;
type Endpoint = IrohModule.Endpoint;
type Connection = IrohModule.Connection;
type SendStream = IrohModule.SendStream;
type RecvStream = IrohModule.RecvStream;

export interface CollabHostDeps {
  send(message: HostToCore): void;
  /** The lazy `import()` of `@number0/iroh` */
  load(): Promise<Iroh>;
  log(message: string): void;
  platform?: string;
  arch?: string;
}

/** The targets `@number0/iroh` 1.1.0 ships a prebuild for (its `napi.targets`); there is no macOS Intel one */
const PREBUILDS = new Set(['linux-x64', 'linux-arm64', 'linux-arm', 'win32-x64', 'win32-arm64', 'darwin-arm64', 'android-arm64', 'android-arm']);

const DEFAULT_ONLINE_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 1000;
const DIAL_TIMEOUT_MS = 20_000;

const hex = (bytes: readonly number[]): string => Buffer.from(bytes).toString('hex');
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** A promise from the binding that nobody awaits still must not reject unhandled */
function quiet(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  quiet(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface IncomingStream {
  send: SendStream;
  from: string;
  conn: Connection;
  /** Writes in order: a reply frame, its bytes, the end */
  queue: Promise<void>;
  closed: boolean;
}

interface OutgoingRequest {
  recv: RecvStream | null;
  cancelled: boolean;
}

interface PeerState {
  connections: Set<Connection>;
  reported: string;
}

export class CollabHostCore {
  private iroh: Iroh | null = null;
  private endpoint: Endpoint | null = null;
  private generation = 0;
  private poller: NodeJS.Timeout | null = null;
  /** `online()` answered or timed out: from then on, no home relay means none is reachable */
  private settled = false;
  private lastStatus = '';
  private readonly peers = new Map<string, PeerState>();
  private readonly dialing = new Map<string, Promise<Connection>>();
  private readonly streams = new Map<number, IncomingStream>();
  private readonly requests = new Map<number, OutgoingRequest>();
  private nextStream = 1;

  constructor(private readonly deps: CollabHostDeps) {}

  handle(message: CoreToHost): void {
    switch (message.type) {
      case 'start':
        void this.start(message.options);
        return;
      case 'stop':
        void this.stop().then(() => this.deps.send({ type: 'stopped' }));
        return;
      case 'reply':
        this.write(message.stream, () => encodeFrame(message.frame, MAX_REPLY_FRAME));
        return;
      case 'reply-bytes':
        this.write(message.stream, () => message.data);
        return;
      case 'reply-end':
        this.end(message.stream);
        return;
      case 'request':
        void this.request(message.req, message.to, message.frame);
        return;
      case 'cancel':
        this.cancel(message.req);
        return;
      case 'disconnect':
        this.disconnect(message.endpointId);
        return;
    }
  }

  /** Loads the binding once; a failure is reported, and the host stays up and idle */
  private async loaded(): Promise<Iroh | null> {
    if (this.iroh) return this.iroh;
    const target = `${this.deps.platform ?? process.platform}-${this.deps.arch ?? process.arch}`;
    const unavailable = (code: HostUnavailableCode, why: string): null => {
      this.deps.send({ type: 'unavailable', code, message: why });
      return null;
    };
    if (!PREBUILDS.has(target)) return unavailable('platform', `@number0/iroh has no build for ${target}`);
    try {
      this.iroh = await this.deps.load();
      return this.iroh;
    } catch (error) {
      return unavailable('load', message(error));
    }
  }

  private async start(options: HostStartOptions): Promise<void> {
    await this.stop();
    const generation = ++this.generation;
    const iroh = await this.loaded();
    if (!iroh || generation !== this.generation) return;
    let endpoint: Endpoint;
    try {
      const builder = iroh.Endpoint.builder();
      if (options.preset === 'minimal') iroh.presetMinimal(builder);
      else iroh.presetN0(builder);
      builder.alpns([[...ALPN_BYTES]]);
      if (options.relayUrls.length) builder.relayMode(iroh.RelayMode.customFromUrls(options.relayUrls));
      builder.secretKey(options.secretKey);
      if (options.bindAddr) builder.bindAddr(options.bindAddr);
      endpoint = await builder.bind();
    } catch (error) {
      if (generation === this.generation) this.deps.send({ type: 'start-error', message: message(error) });
      return;
    }
    if (generation !== this.generation) {
      quiet(endpoint.close());
      return;
    }
    this.endpoint = endpoint;
    this.settled = false;
    this.lastStatus = '';
    this.status('starting');
    void this.acceptLoop(endpoint, generation);
    this.poller = setInterval(() => this.poll(), options.pollMs ?? DEFAULT_POLL_MS);
    this.poller.unref?.();
    if (options.preset === 'minimal') {
      this.settled = true;
      this.poll();
      return;
    }
    // `online()` never resolves without a reachable relay: it is raced, and the poll takes over after
    try {
      await within(endpoint.online(), options.onlineTimeoutMs ?? DEFAULT_ONLINE_TIMEOUT_MS);
    } catch (error) {
      this.deps.log(`online() failed: ${message(error)}`);
    }
    if (generation !== this.generation) return;
    this.settled = true;
    this.poll();
  }

  private async stop(): Promise<void> {
    this.generation++;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const request of this.requests.values()) request.cancelled = true;
    for (const [req, request] of this.requests) {
      if (request.recv) quiet(request.recv.stop(0n));
      this.deps.send({ type: 'response-error', req, message: 'the endpoint stopped' });
    }
    this.requests.clear();
    for (const id of [...this.streams.keys()]) this.closeStream(id);
    for (const [endpointId, peer] of this.peers) {
      for (const conn of peer.connections) this.closeConnection(conn);
      this.deps.send({ type: 'peer', endpointId, connected: false, path: null, rttMs: null });
    }
    this.peers.clear();
    this.dialing.clear();
    const endpoint = this.endpoint;
    this.endpoint = null;
    if (endpoint) {
      try {
        await endpoint.close();
      } catch (error) {
        this.deps.log(`close failed: ${message(error)}`);
      }
    }
  }

  /** Ends the host's work before the process exits */
  async shutdown(): Promise<void> {
    await this.stop();
  }

  // ---------- Status, polled ----------

  private status(connection: HostConnection): void {
    const endpoint = this.endpoint;
    const iroh = this.iroh;
    if (!endpoint || !iroh) return;
    try {
      const addr = endpoint.addr();
      const homeRelay = addr.relayUrl();
      const directAddresses = addr.directAddresses();
      const ticket = iroh.EndpointTicket.fromAddr(addr).toString();
      const endpointId = hex(endpoint.id().toBytes());
      const key = JSON.stringify([connection, homeRelay, directAddresses]);
      if (key === this.lastStatus) return;
      this.lastStatus = key;
      this.deps.send({ type: 'status', endpointId, connection, homeRelay, ticket, directAddresses });
    } catch (error) {
      this.deps.log(`status failed: ${message(error)}`);
    }
  }

  private poll(): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    let homeRelay: string | null = null;
    try {
      homeRelay = endpoint.addr().relayUrl();
    } catch {
      return;
    }
    this.status(homeRelay ? 'online' : this.settled ? 'no-relay' : 'starting');
    for (const [endpointId, peer] of this.peers) this.reportPeer(endpointId, peer);
  }

  private reportPeer(endpointId: string, peer: PeerState): void {
    let path: 'direct' | 'relay' | null = null;
    let rttMs: number | null = null;
    for (const conn of peer.connections) {
      try {
        const selected = conn.paths().find((p) => p.isSelected);
        if (selected) path = selected.isRelay ? 'relay' : 'direct';
        rttMs = conn.rtt();
      } catch {
        // A connection closing between two polls; its `closed()` handler drops it
      }
    }
    const connected = peer.connections.size > 0;
    const key = JSON.stringify([connected, path]);
    if (key === peer.reported) return;
    peer.reported = key;
    this.deps.send({ type: 'peer', endpointId, connected, path, rttMs: rttMs === null ? null : Math.round(rttMs) });
  }

  // ---------- Connections ----------

  private async acceptLoop(endpoint: Endpoint, generation: number): Promise<void> {
    for (;;) {
      let incoming: IrohModule.Incoming | null;
      try {
        incoming = await endpoint.acceptNext();
      } catch (error) {
        if (generation === this.generation) this.deps.log(`accept failed: ${message(error)}`);
        return;
      }
      if (!incoming || generation !== this.generation) return;
      void this.accept(incoming, generation);
    }
  }

  private async accept(incoming: IrohModule.Incoming, generation: number): Promise<void> {
    try {
      const accepting = await incoming.accept();
      const alpn = Buffer.from(await accepting.alpn()).toString('utf8');
      const conn = await accepting.connect();
      if (alpn !== ALPN) {
        conn.close(0n, []);
        return;
      }
      if (generation !== this.generation) {
        conn.close(0n, []);
        return;
      }
      this.adopt(conn);
    } catch (error) {
      this.deps.log(`handshake failed: ${message(error)}`);
    }
  }

  /** Takes a connection, whichever side opened it: either side may open streams on it */
  private adopt(conn: Connection): string {
    const endpointId = hex(conn.remoteId().toBytes());
    let peer = this.peers.get(endpointId);
    if (!peer) {
      peer = { connections: new Set(), reported: '' };
      this.peers.set(endpointId, peer);
    }
    peer.connections.add(conn);
    this.reportPeer(endpointId, peer);
    const generation = this.generation;
    void (async () => {
      try {
        await conn.closed();
      } catch {
        // Closed with an error: the same as closed
      }
      this.dropConnection(endpointId, conn);
    })();
    void this.streamLoop(conn, endpointId, generation);
    return endpointId;
  }

  private dropConnection(endpointId: string, conn: Connection): void {
    for (const [id, stream] of this.streams) if (stream.conn === conn) this.closeStream(id);
    const peer = this.peers.get(endpointId);
    if (!peer) return;
    peer.connections.delete(conn);
    this.reportPeer(endpointId, peer);
    if (peer.connections.size === 0) this.peers.delete(endpointId);
  }

  private closeConnection(conn: Connection): void {
    try {
      conn.close(0n, []);
    } catch {
      // Already closed
    }
  }

  private disconnect(endpointId: string): void {
    const peer = this.peers.get(endpointId);
    if (!peer) return;
    for (const conn of [...peer.connections]) {
      this.closeConnection(conn);
      this.dropConnection(endpointId, conn);
    }
  }

  private async streamLoop(conn: Connection, from: string, generation: number): Promise<void> {
    for (;;) {
      let bi: IrohModule.BiStream;
      try {
        bi = await conn.acceptBi();
      } catch {
        return; // The connection closed
      }
      if (generation !== this.generation) return;
      void this.readRequest(conn, from, bi);
    }
  }

  private async readRequest(conn: Connection, from: string, bi: IrohModule.BiStream): Promise<void> {
    const send = bi.send;
    let frame: unknown;
    try {
      const header = Uint8Array.from(await bi.recv.readExact(4));
      const length = frameLength(header, MAX_REQUEST_FRAME);
      frame = decodeFrameBody(Uint8Array.from(await bi.recv.readExact(length)));
    } catch (error) {
      this.deps.log(`a request from ${from.slice(0, 10)} was refused: ${message(error)}`);
      quiet(send.reset(1n));
      quiet(bi.recv.stop(1n));
      return;
    }
    const stream = this.nextStream++;
    this.streams.set(stream, { send, from, conn, queue: Promise.resolve(), closed: false });
    this.deps.send({ type: 'incoming', stream, from, frame });
  }

  /** Queues a write on an incoming stream; the bytes are made lazily so a closed stream costs nothing */
  private write(id: number, bytes: () => Uint8Array): void {
    const stream = this.streams.get(id);
    if (!stream || stream.closed) return;
    stream.queue = stream.queue.then(async () => {
      if (stream.closed) return;
      try {
        const data = bytes();
        for (let at = 0; at < data.length; at += PIECE_BYTES) {
          await stream.send.writeAll(Array.from(data.subarray(at, Math.min(data.length, at + PIECE_BYTES))));
        }
      } catch (error) {
        this.deps.log(`a write to ${stream.from.slice(0, 10)} failed: ${message(error)}`);
        this.closeStream(id);
      }
    });
  }

  private end(id: number): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.queue = stream.queue.then(async () => {
      if (!stream.closed) {
        try {
          await stream.send.finish();
        } catch {
          // The peer went away; there was nothing more to say
        }
      }
      stream.closed = true;
      this.streams.delete(id);
    });
  }

  private closeStream(id: number): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.closed = true;
    this.streams.delete(id);
    quiet(stream.send.reset(0n));
    this.deps.send({ type: 'incoming-closed', stream: id });
  }

  // ---------- Requests this install makes ----------

  private connectionTo(endpointId: string): Connection | null {
    const peer = this.peers.get(endpointId);
    if (!peer) return null;
    let last: Connection | null = null;
    for (const conn of peer.connections) last = conn;
    return last;
  }

  private async dial(target: HostTarget): Promise<Connection> {
    const existing = this.connectionTo(target.endpointId);
    if (existing) return existing;
    const pending = this.dialing.get(target.endpointId);
    if (pending) return pending;
    const endpoint = this.endpoint;
    const iroh = this.iroh;
    if (!endpoint || !iroh) throw new Error('the endpoint is not running');
    const attempt = (async () => {
      const addr = target.ticket
        ? iroh.EndpointTicket.fromString(target.ticket).endpointAddr()
        : new iroh.EndpointAddr(iroh.EndpointId.fromBytes([...Buffer.from(target.endpointId, 'hex')]), null, []);
      if (hex(addr.id().toBytes()) !== target.endpointId) throw new Error('the ticket is for another endpoint');
      const outcome = await within(endpoint.connect(addr, [...ALPN_BYTES]), DIAL_TIMEOUT_MS);
      if (outcome === 'timeout') throw new Error('the peer did not answer');
      this.adopt(outcome);
      return outcome;
    })();
    this.dialing.set(target.endpointId, attempt);
    try {
      return await attempt;
    } finally {
      this.dialing.delete(target.endpointId);
    }
  }

  private async request(req: number, to: HostTarget, frame: unknown): Promise<void> {
    const state: OutgoingRequest = { recv: null, cancelled: false };
    this.requests.set(req, state);
    const fail = (why: string): void => {
      if (this.requests.get(req) !== state) return;
      this.requests.delete(req);
      this.deps.send({ type: 'response-error', req, message: why });
    };
    try {
      const conn = await this.dial(to);
      if (state.cancelled) return;
      const bi = await conn.openBi();
      state.recv = bi.recv;
      await bi.send.writeAll(Array.from(encodeFrame(frame, MAX_REQUEST_FRAME)));
      await bi.send.finish();
      const parser = new FrameParser(MAX_REPLY_FRAME, (value) => rawLength(value as { type?: unknown; bytes?: unknown }));
      for (;;) {
        if (state.cancelled) return;
        const part = await bi.recv.read(PIECE_BYTES);
        if (part === null || part.length === 0) break;
        for (const piece of parser.push(Uint8Array.from(part))) {
          if ('frame' in piece) this.deps.send({ type: 'response', req, frame: piece.frame });
          else this.deps.send({ type: 'response-bytes', req, data: piece.bytes });
        }
      }
      if (parser.partial) {
        fail('the reply was cut short');
        return;
      }
      if (this.requests.get(req) === state) {
        this.requests.delete(req);
        this.deps.send({ type: 'response-end', req });
      }
    } catch (error) {
      if (!state.cancelled) fail(message(error));
    }
  }

  private cancel(req: number): void {
    const state = this.requests.get(req);
    if (!state) return;
    state.cancelled = true;
    this.requests.delete(req);
    if (state.recv) quiet(state.recv.stop(0n));
  }
}
