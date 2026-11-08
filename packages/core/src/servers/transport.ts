import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Agent, type buildConnector } from 'undici';
import { bareHost, isLoopbackName, refusedIp } from './addresses.ts';
import { ServersError } from './errors.ts';

/**
 * How the hub reaches a remote (docs/plans/claudio-servers.md, §4.2, R2): one connection at a time,
 * each to an IP the hub resolved and checked itself, over TLS whose certificate is judged by the
 * identity pinned at pairing rather than by a CA. Everything the hub sends a remote (pairing, probes,
 * the gateway's requests and sockets) goes through `dial`, so there is one place these rules live.
 */

/** Every IP a name resolves to, in the resolver's order. A parameter so a test can name its own */
export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemLookup: Lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** What the hub pinned of a remote's certificate: its SHA-256 (the grant's) and its public key's */
export interface PeerPins {
  fingerprint: string | null;
  publicKey: string | null;
}

/** What one TLS handshake showed */
export interface PeerSeen {
  /** SHA-256 of the certificate's DER, upper-case hex with colons (Node's `fingerprint256`) */
  fingerprint: string;
  /** SHA-256 of the SubjectPublicKeyInfo, base64 */
  publicKey: string;
  /** Whether a CA in the trust store vouches for it under the name dialled */
  caValid: boolean;
}

/**
 * Which certificates a connection accepts.
 *
 * `pinned`: the pinned fingerprint, or the pinned public key (the remote remakes its certificate when
 * it gains an address, but keeps its key: `lan-tls.ts`), or, for a name off the LAN only
 * (`caMayVouchFor`, D15), a certificate a CA vouches for under the name dialled. The last is how
 * Tailscale's `*.ts.net` names and a tunnel's proxy present themselves: TLS ends there with a
 * certificate of their own, which no pin could know in advance. The `instanceId` of `/api/meta`
 * binds whatever answers to the server paired.
 *
 * `first-use`: pairing, when nothing is pinned yet. The first certificate is taken as it is and every
 * later connection of the same agent must show that one, so the code goes where the meta came from.
 */
export type Trust = { kind: 'pinned'; pins: () => PeerPins; matched?: (seen: PeerSeen) => void } | { kind: 'first-use'; seen: PeerSeen | null };

export interface DialOptions {
  lookup: Lookup;
  /** Until the TCP connection, and the TLS handshake on it, are done */
  timeoutMs: number;
}

export interface DialTarget {
  protocol: string;
  hostname: string;
  port: number;
}

export const sameFingerprint = (a: string, b: string): boolean => a.replace(/:/g, '').toUpperCase() === b.replace(/:/g, '').toUpperCase();

const identityChanged = (message: string): ServersError => new ServersError(409, 'servers.identity-changed', message);

/**
 * Whether a CA's word may stand in for the pin on this host (D15): a DNS name off the LAN, such as a
 * tailnet's `*.ts.net` or a tunnel's. Never an IP literal, a `.local` name or a single-label one:
 * those are the LAN's, where the remote's own certificate is the only one that may answer. A CA
 * that signed for them (one an administrator added to the trust store, or a public CA's certificate
 * for a public IP) would otherwise let whoever holds it stand in for the remote.
 */
export function caMayVouchFor(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase().replace(/\.$/, '');
  if (!host || isIP(host) !== 0) return false;
  if (!host.includes('.')) return false;
  return host !== 'local' && !host.endsWith('.local');
}

/** What the handshake of an open socket showed, for pairing's check against the grant */
const seenOn = new WeakMap<Socket, PeerSeen>();
export const peerOf = (socket: Socket): PeerSeen | null => seenOn.get(socket) ?? null;

/** Whether a connection to `host` that showed `seen` goes on under `trust`; exported for the tests of the rule */
export function accepts(trust: Trust, seen: PeerSeen, host: string): ServersError | null {
  if (trust.kind === 'first-use') {
    if (trust.seen === null) {
      trust.seen = seen;
      return null;
    }
    return sameFingerprint(trust.seen.fingerprint, seen.fingerprint) ? null : identityChanged('the server showed another certificate than the one it was first reached with');
  }
  const pins = trust.pins();
  const byFingerprint = pins.fingerprint !== null && sameFingerprint(pins.fingerprint, seen.fingerprint);
  const byKey = pins.publicKey !== null && pins.publicKey === seen.publicKey;
  if (byFingerprint || byKey) {
    // Either pin vouches for the other half: the caller keeps both up to date (a renewal, or a key not seen at pairing)
    trust.matched?.(seen);
    return null;
  }
  if (seen.caValid && caMayVouchFor(host)) return null;
  return identityChanged(`the server's certificate (${seen.fingerprint}) is not the one pinned when it was paired`);
}

function judge(socket: TLSSocket, trust: Trust, host: string): ServersError | null {
  const cert = socket.getPeerX509Certificate();
  if (!cert) return identityChanged('the server showed no certificate');
  const seen: PeerSeen = {
    fingerprint: cert.fingerprint256,
    publicKey: createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    // With `rejectUnauthorized: false` Node still checks the chain and the name, and says so here
    caValid: socket.authorized,
  };
  seenOn.set(socket, seen);
  return accepts(trust, seen, host);
}

/**
 * Every IP of a name the hub may dial, in the resolver's order, which are then the only ones it
 * connects to: no second lookup a rebinding could answer. All of them, not the first: a name often
 * resolves to an IPv6 and an IPv4 address (a tailnet name, `localhost` on many systems) while
 * Claudio's LAN listener answers on IPv4 only, so the first may simply not be listening.
 */
async function resolveAllowed(host: string, loopbackAllowed: boolean, lookup: Lookup): Promise<string[]> {
  if (isIP(host)) {
    const refused = refusedIp(host, loopbackAllowed);
    if (refused) throw new ServersError(400, 'servers.address-refused', refused);
    return [host];
  }
  let found: Array<{ address: string }>;
  try {
    found = await lookup(host);
  } catch {
    throw new ServersError(502, 'servers.unreachable', `${host} does not resolve`);
  }
  if (found.length === 0) throw new ServersError(502, 'servers.unreachable', `${host} does not resolve`);
  const allowed: string[] = [];
  let reason: string | null = null;
  for (const each of found) {
    const refused = refusedIp(each.address, loopbackAllowed);
    if (refused === null) {
      if (!allowed.includes(each.address)) allowed.push(each.address);
    } else reason ??= refused;
  }
  if (allowed.length === 0) throw new ServersError(400, 'servers.address-refused', `${host} resolves to what the hub never dials: ${reason ?? ''}`);
  return allowed;
}

/** Whether a failed attempt at one IP says nothing about the next one (nothing listened, no route), so the next is worth trying */
function worthNextIp(error: unknown): boolean {
  return !(error instanceof ServersError && error.reason !== 'servers.unreachable');
}

/** One TCP or TLS connection to one already-checked IP, its certificate judged before it is handed over */
function connectOnce(ip: string, host: string, target: DialTarget, trust: Trust, tls: boolean, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket: Socket = tls
      ? tlsConnect({ host: ip, port: target.port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
      : netConnect({ host: ip, port: target.port });
    const timer = setTimeout(() => socket.destroy(new ServersError(504, 'servers.unreachable', `${target.hostname}:${String(target.port)} did not answer in time`)), timeoutMs);
    const failed = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', failed);
    socket.once(tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', failed);
      const refused = tls ? judge(socket as TLSSocket, trust, host) : null;
      if (refused) {
        socket.destroy();
        reject(refused);
        return;
      }
      resolve(socket);
    });
  });
}

/**
 * One connection to a remote: the name resolved and its IPs checked (R2), plain TCP only to an address
 * recorded as loopback, and over TLS the certificate judged by `trust` before a byte is written. The
 * IPs are tried in order within one time budget; an identity refusal ends it at once, since another
 * IP of the same name showing another certificate is no reason to keep looking.
 */
export async function dial(target: DialTarget, trust: Trust, options: DialOptions): Promise<Socket> {
  const host = bareHost(target.hostname);
  const loopback = isLoopbackName(host);
  const tls = target.protocol === 'https:';
  if (!tls && (target.protocol !== 'http:' || !loopback)) throw new ServersError(400, 'servers.address-insecure', `${target.protocol}//${target.hostname} is not dialled: only https://, or http:// on loopback`);
  const ips = await resolveAllowed(host, loopback, options.lookup);
  const deadline = Date.now() + options.timeoutMs;
  let last: unknown = null;
  for (const ip of ips) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      return await connectOnce(ip, host, target, trust, tls, left);
    } catch (error) {
      if (!worthNextIp(error)) throw error;
      last = error;
    }
  }
  if (last instanceof Error) throw last;
  throw new ServersError(504, 'servers.unreachable', `${target.hostname}:${String(target.port)} did not answer in time`);
}

/**
 * The certificate an address shows, read from a TLS handshake after which the socket is closed with
 * nothing written on it (D13): what a person confirms before their owner token is sent there. Null
 * over plain HTTP, which `dial` allows on loopback only, where no certificate exists to check.
 */
export async function peek(target: DialTarget, options: DialOptions): Promise<PeerSeen | null> {
  const socket = await dial(target, { kind: 'first-use', seen: null }, options);
  try {
    return peerOf(socket);
  } finally {
    socket.destroy();
  }
}

const portOf = (protocol: string, port: string): number => Number(port) || (protocol === 'https:' ? 443 : 80);

/** `dial` as undici's `connect` option, so every pooled connection goes through it */
export function connector(trust: Trust, options: DialOptions): buildConnector.connector {
  return (target, callback) => {
    dial({ protocol: target.protocol, hostname: target.hostname, port: portOf(target.protocol, target.port) }, trust, options).then(
      (socket) => callback(null, socket),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  };
}

/**
 * The pool of one remote. No `bodyTimeout`, since an event stream is a body that never ends (R4); a
 * remote that sends no headers in five minutes is given up on. undici follows no redirect unless
 * asked to, and nothing here asks.
 */
export function agentFor(trust: Trust, options: DialOptions): Agent {
  return new Agent({ connect: connector(trust, options), bodyTimeout: 0, headersTimeout: 5 * 60_000, keepAliveTimeout: 30_000, connections: 64 });
}

export type UpgradeOutcome =
  | { upgraded: true; headers: IncomingHttpHeaders; socket: Duplex; head: Buffer }
  | { upgraded: false; status: number; headers: IncomingHttpHeaders; body: Buffer };

/** What the hub reads of a refused upgrade: the remote's JSON refusal, never a page */
const REFUSAL_LIMIT = 16 * 1024;

/**
 * A WebSocket upgrade sent on a socket `open` makes. Node's client and not undici's `upgrade`, which
 * turns every answer but 101 into one error: the remote's refusal (its status and `code`) is what a
 * connection test reports. The caller owns the socket it gets back.
 */
export function upgrade(origin: URL, path: string, headers: Record<string, string>, open: () => Promise<Socket>, timeoutMs: number): Promise<UpgradeOutcome> {
  return new Promise<UpgradeOutcome>((resolve, reject) => {
    const req = httpRequest({
      method: 'GET',
      path,
      setHost: false,
      headers: { ...headers, host: origin.host, connection: 'Upgrade', upgrade: 'websocket' },
      createConnection: (_options, created) => {
        // Node reads no socket beside an error, though the type asks for one
        const failed = created as (error: Error) => void;
        open().then(
          (socket) => created(null, socket),
          (error: unknown) => failed(error instanceof Error ? error : new Error(String(error))),
        );
        return undefined;
      },
    });
    const timer = setTimeout(() => req.destroy(new ServersError(504, 'servers.unreachable', 'the upgrade was not answered in time')), timeoutMs);
    req.once('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      resolve({ upgraded: true, headers: res.headers, socket, head });
    });
    req.once('response', (res) => {
      clearTimeout(timer);
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= REFUSAL_LIMIT) chunks.push(chunk);
        else res.destroy();
      });
      const done = (): void => resolve({ upgraded: false, status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) });
      res.once('end', done);
      res.once('close', done);
    });
    req.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}
