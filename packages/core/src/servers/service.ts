import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { hostname } from 'node:os';
import {
  API_VERSION,
  isRecord,
  type ClaudioServer,
  type PairServerAgainResult,
  type RemoveServerResult,
  type ServerAddress,
  type ServerCheck,
  type ServerHealth,
  type ServerLinkGrant,
  type ServerMeta,
  type ServerPairing,
  type ServersSettings,
  type ServerTestResult,
} from '@claudio/shared';
import type { Agent } from 'undici';
import type { SecretVault } from '../secret-vault.ts';
import { parseAddresses } from './addresses.ts';
import { ServersError, disabled, notFound, serversErrorOf } from './errors.ts';
import { ServerRegistry, type StoredServer } from './registry.ts';
import { checkEvents, checkRest, checkSocket, pair, readMeta, revokeSelf, type HubName } from './remote.ts';
import { agentFor, dial, peek, sameFingerprint, systemLookup, type DialOptions, type Lookup, type PeerPins, type PeerSeen, type Trust } from './transport.ts';

/**
 * The hub (docs/plans/claudio-servers.md, §4.2): the servers this Claudio drives, how it pairs with
 * them, which of a server's addresses it uses, how each is doing, and what the gateway needs to send
 * a request on. Only the selected server is probed (§1): a probe happens when the person selects or
 * tests a server, and when the gateway has to find an address; nothing polls in the background.
 */

/** Failures in a row of the address in use before the next request looks for another (hysteresis) */
export const FAILURES_BEFORE_MOVE = 2;
/** A list a person picks from; far more than the selector shows */
export const MAX_SERVERS = 32;

const MAX_NAME = 60;
const COLOR = /^[a-z][a-z0-9-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface ServersOptions {
  dataDir: string;
  vault: SecretVault;
  /** This hub's own `instanceId`: sent when it pairs, and never paired with */
  instanceId: string;
  /** The name a remote lists this hub's token under; the machine's name by default */
  hubName?: () => string;
  lookup?: Lookup;
  timeouts?: Partial<Timeouts>;
}

export interface Timeouts {
  /** TCP and TLS together */
  connectMs: number;
  /** `GET /api/meta` on one address */
  probeMs: number;
  /** A pairing, which a remote's back-off may slow */
  pairMs: number;
  /** Each check of a connection test */
  checkMs: number;
}

const DEFAULT_TIMEOUTS: Timeouts = { connectMs: 4_000, probeMs: 4_000, pairMs: 15_000, checkMs: 8_000 };

interface Route {
  address: string | null;
  failures: number;
}

interface Chosen {
  address: ServerAddress;
  /** Set when this choice probed the address just now */
  meta: ServerMeta | null;
  latencyMs: number | null;
}

type Probe = { ok: true; address: ServerAddress; meta: ServerMeta; latencyMs: number } | { ok: false; address: ServerAddress; reason: string };

/** What the gateway sends one request on */
export interface GatewayTarget {
  server: StoredServer;
  /** The address chosen, as an origin */
  origin: URL;
  agent: Agent;
  token: string;
  /** A connection to the chosen address, for a WebSocket the gateway relays */
  open: () => Promise<Socket>;
}

/** How a request the gateway relayed went, as far as the address is concerned */
export type GatewayOutcome = { kind: 'ok'; latencyMs: number } | { kind: 'failed'; reason: string } | { kind: 'needs-pairing' };

const now = (): string => new Date().toISOString();

/** Whether this hub's web, which speaks `API_VERSION`, can drive a remote (D3): its range must hold it */
export function apiCompatibility(meta: ServerMeta): string | null {
  if (API_VERSION > meta.apiVersion.current) return 'servers.remote-too-old';
  if (API_VERSION < meta.apiVersion.min) return 'servers.hub-too-old';
  return null;
}

function healthOf(probe: Extract<Probe, { ok: true }>): ServerHealth {
  const incompatible = apiCompatibility(probe.meta);
  return {
    status: incompatible ? 'needs-update' : 'connected',
    address: probe.address.url,
    version: probe.meta.version,
    apiVersion: probe.meta.apiVersion.current,
    latencyMs: probe.latencyMs,
    checkedAt: now(),
    ...(incompatible ? { reason: { code: incompatible } } : {}),
  };
}

const badRequest = (reason: string, message: string): ServersError => new ServersError(400, reason, message);

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_NAME || CONTROL.test(name)) throw badRequest('servers.name-invalid', `name must be 1 to ${String(MAX_NAME)} characters`);
  return name;
}

function parseColor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !COLOR.test(value)) throw badRequest('servers.color-invalid', 'color is the name of a colour token (`violet`, `accent-2`), not a hex value');
  return value;
}

function parseMonogram(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const monogram = typeof value === 'string' ? value.trim() : '';
  const length = Array.from(monogram).length;
  if (length < 1 || length > 2 || /\s/.test(monogram) || CONTROL.test(monogram)) throw badRequest('servers.monogram-invalid', 'monogram is one or two characters');
  return monogram;
}

/**
 * A SHA-256 fingerprint as a person copies it: hex, with or without colons or spaces, in either
 * case. Kept as Node spells `fingerprint256`, upper case with colons, so the 409 and the pin read
 * the same.
 */
function parseFingerprint(value: unknown): string {
  const hex = typeof value === 'string' ? value.replace(/[\s:]/g, '') : '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw badRequest('servers.pairing-invalid', 'expectedFingerprint is the SHA-256 the server shows: 64 hex digits, with or without colons');
  return (hex.toUpperCase().match(/../g) ?? []).join(':');
}

function parsePairing(value: unknown): ServerPairing {
  if (isRecord(value) && value.kind === 'code' && typeof value.code === 'string' && value.code.trim() && value.code.length <= 64) return { kind: 'code', code: value.code.trim() };
  if (isRecord(value) && value.kind === 'token' && typeof value.token === 'string' && value.token.trim() && value.token.length <= 4096) {
    const token = value.token.trim();
    return value.expectedFingerprint === undefined ? { kind: 'token', token } : { kind: 'token', token, expectedFingerprint: parseFingerprint(value.expectedFingerprint) };
  }
  throw badRequest('servers.pairing-invalid', "pairing is { kind: 'code', code } with the code the server shows, or { kind: 'token', token, expectedFingerprint? } with its owner token");
}

/**
 * Whether a pasted owner token may go to an address that showed `seen` (D13). The person confirms the
 * certificate before the token leaves the hub: the one they typed must be it, and with none typed
 * the answer is the seen one for them to confirm. Nothing has been sent to the address either way.
 */
function confirmFingerprint(expected: string | undefined, seen: PeerSeen, address: string): void {
  const details = { fingerprint: seen.fingerprint, address };
  if (expected === undefined) {
    throw new ServersError(
      409,
      'servers.confirm-fingerprint',
      `${address} shows the certificate ${seen.fingerprint}: check it against that server's LAN card, then send the pairing again with it as expectedFingerprint; nothing was sent to it yet`,
      details,
    );
  }
  if (!sameFingerprint(expected, seen.fingerprint)) {
    throw new ServersError(409, 'servers.fingerprint-unexpected', `${address} shows the certificate ${seen.fingerprint}, not ${expected}: the owner token was not sent to it`, details);
  }
}

function onlyKeys(body: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !known.includes(key));
  if (unknown.length) throw badRequest('servers.unknown-field', `unknown fields: ${unknown.join(', ')}; the known ones are ${known.join(', ')}`);
}

export class Servers {
  private readonly registry: ServerRegistry;
  private readonly instanceId: string;
  private readonly hubName: () => string;
  /** How names resolve and how long a connection may take: replaced by a test, as `LanListener.network` is */
  readonly network: DialOptions;
  /** Each deadline, which a test shortens */
  readonly timeouts: Timeouts;
  private readonly agents = new Map<string, Agent>();
  private readonly routes = new Map<string, Route>();
  private readonly health = new Map<string, ServerHealth>();
  private readonly probing = new Map<string, Promise<Chosen>>();
  /** What the gateway holds open per server (relayed sockets), closed when the server goes or the feature is turned off */
  private readonly held = new Map<string, Set<() => void>>();

  constructor(options: ServersOptions) {
    this.registry = new ServerRegistry(options.dataDir, options.vault);
    this.instanceId = options.instanceId;
    this.hubName = options.hubName ?? (() => hostname().trim().slice(0, 100) || 'Claudio');
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.network = { lookup: options.lookup ?? systemLookup, timeoutMs: this.timeouts.connectMs };
  }

  get enabled(): boolean {
    return this.registry.settings.enabled;
  }

  settings(): ServersSettings {
    return this.registry.settings;
  }

  /**
   * `{ enabled }` and nothing else. Off keeps the list and the tokens (D8) and closes every connection
   * to a remote at once, the gateway's streams and sockets included: no credential is used until it is
   * on again.
   */
  async updateSettings(body: unknown): Promise<ServersSettings> {
    if (!isRecord(body)) throw badRequest('servers.settings-invalid', 'the body is { enabled: boolean }');
    onlyKeys(body, ['enabled']);
    if (typeof body.enabled !== 'boolean') throw badRequest('servers.settings-invalid', 'enabled must be true or false');
    await this.registry.setEnabled(body.enabled);
    if (!body.enabled) await this.disconnectAll();
    return this.registry.settings;
  }

  /** Every server, with its last health reading; none while the feature is off */
  list(): ClaudioServer[] {
    return this.enabled ? this.registry.list().map((server) => this.view(server)) : [];
  }

  /**
   * Pairs with a remote and keeps it (§4.1, §9.2): the first address that answers as a Claudio is
   * where the code or the owner token goes, the certificate it showed must be the one the grant
   * names (D5), and every other address is checked against the identity pinned. Anything that fails
   * after the remote handed its token over gives the token back, so a failed add leaves no orphan (R8).
   */
  async add(body: unknown): Promise<ClaudioServer> {
    this.requireEnabled();
    if (!isRecord(body)) throw badRequest('servers.add-invalid', 'the body is { name, addresses, pairing, color?, monogram? }');
    onlyKeys(body, ['name', 'color', 'monogram', 'addresses', 'pairing']);
    const name = parseName(body.name);
    const color = parseColor(body.color);
    const monogram = parseMonogram(body.monogram);
    const addresses = parseAddresses(body.addresses);
    const pairing = parsePairing(body.pairing);
    if (this.registry.list().length >= MAX_SERVERS) throw new ServersError(409, 'servers.too-many', `a hub keeps at most ${String(MAX_SERVERS)} servers`);

    const paired = await this.pairOn(addresses, pairing, { hubInstanceId: this.instanceId, hubName: this.hubName() });
    const { grant, agent } = paired;
    try {
      if (grant.instanceId !== paired.meta.instanceId) throw new ServersError(502, 'servers.identity-changed', 'the server paired is not the one whose meta answered: something between the two answered in its place');
      const pins = this.pinsFrom(grant, paired.seen);
      const server: StoredServer = {
        id: randomBytes(6).toString('hex'),
        name,
        color,
        monogram,
        addresses,
        identity: { instanceId: grant.instanceId, tlsFingerprint: pins.fingerprint, publicKey: pins.publicKey },
        tokenId: grant.tokenId,
        createdAt: now(),
        lastUsedAt: null,
      };
      await this.checkOtherAddresses(server, paired.address);
      await this.registry.put(server, grant.token);
      this.routes.set(server.id, { address: paired.address.url, failures: 0 });
      this.health.set(server.id, healthOf({ ok: true, address: paired.address, meta: paired.meta, latencyMs: paired.latencyMs }));
      return this.view(server);
    } catch (error) {
      await revokeSelf(agent, paired.address.url, grant.token, this.timeouts.probeMs);
      throw error;
    } finally {
      await agent.destroy();
    }
  }

  /**
   * Pairs a server on the list again, in place (§12.2 E3): one whose identity changed (reinstalled)
   * or whose token the remote revoked. The id, name, colour, monogram and addresses stay, so its
   * pages, recents and per-server browser keys still name it; the identity and the token become the
   * new pairing's, with the same rules as an add (D13 for a pasted owner token, D5 for every address).
   *
   * The earlier token is given back only after the new one is stored, so a pairing that fails leaves
   * the server as it was, and only to an address that still proves the earlier identity: a token is
   * never shown to a machine that did not issue it. A remote paired with again replaces its earlier
   * token for this hub anyway; a reinstalled one never had it.
   */
  async pairAgain(id: string, body: unknown): Promise<PairServerAgainResult> {
    this.requireEnabled();
    const server = this.stored(id);
    // A `ServerPairing`, or `{ pairing }` as `POST /servers` takes it
    const pairing = parsePairing(isRecord(body) && body.kind === undefined && 'pairing' in body ? body.pairing : body);
    const previousToken = this.registry.tokenOf(id);

    const paired = await this.pairOn(server.addresses, pairing, { hubInstanceId: this.instanceId, hubName: this.hubName() }, id);
    const { grant, agent } = paired;
    let saved: StoredServer;
    try {
      if (grant.instanceId !== paired.meta.instanceId) throw new ServersError(502, 'servers.identity-changed', 'the server paired is not the one whose meta answered: something between the two answered in its place');
      const pins = this.pinsFrom(grant, paired.seen);
      const identity: StoredServer['identity'] = { instanceId: grant.instanceId, tlsFingerprint: pins.fingerprint, publicKey: pins.publicKey };
      await this.checkOtherAddresses({ ...server, identity }, paired.address);
      // Applied to the server as it is now, so a rename while the pairing ran is kept
      saved = await this.registry.change(id, (current) => ({ ...current, identity, tokenId: grant.tokenId }), grant.token);
    } catch (error) {
      await revokeSelf(agent, paired.address.url, grant.token, this.timeouts.probeMs);
      throw error;
    } finally {
      await agent.destroy();
    }

    const given = await this.revokePrevious(server, previousToken);
    // The pool and the sockets were opened on the earlier identity and token
    await this.forgetConnections(id);
    this.routes.set(id, { address: paired.address.url, failures: 0 });
    this.health.set(id, healthOf({ ok: true, address: paired.address, meta: paired.meta, latencyMs: paired.latencyMs }));
    return { ...this.view(saved), previousToken: given };
  }

  /** Name, colour, monogram and the addresses; an address not on the list before must prove the identity now (D5) */
  async update(id: string, body: unknown): Promise<ClaudioServer> {
    this.requireEnabled();
    const server = this.stored(id);
    if (!isRecord(body)) throw badRequest('servers.update-invalid', 'the body is { name?, color?, monogram?, addresses? }');
    onlyKeys(body, ['name', 'color', 'monogram', 'addresses']);
    const next: StoredServer = { ...server };
    if (body.name !== undefined) next.name = parseName(body.name);
    if (body.color !== undefined) next.color = parseColor(body.color);
    if (body.monogram !== undefined) next.monogram = parseMonogram(body.monogram);
    if (body.addresses !== undefined) {
      next.addresses = parseAddresses(body.addresses);
      for (const address of next.addresses) {
        if (server.addresses.some((kept) => kept.url === address.url)) continue;
        const probe = await this.probeAddress(server, address, this.agentOf(id));
        if (!probe.ok) {
          const other = probe.reason === 'servers.identity-changed';
          throw new ServersError(400, other ? 'servers.address-identity' : 'servers.address-unverified', `${address.url} did not prove it is ${server.name} (${probe.reason}): a new address is kept only once it answers as that server`);
        }
      }
    }
    const saved = await this.registry.change(id, (current) => ({ ...current, name: next.name, color: next.color, monogram: next.monogram, addresses: next.addresses }));
    const route = this.routes.get(id);
    if (route?.address && !saved.addresses.some((each) => each.url === route.address)) this.routes.set(id, { address: null, failures: 0 });
    return this.view(saved);
  }

  /**
   * Gives the token back to the remote, then forgets the server (R8). A remote that cannot be told
   * keeps the server here (`502 servers.revoke-failed`) unless `force`, which removes it anyway and
   * says the token may still work there.
   */
  async remove(id: string, options: { force?: boolean } = {}): Promise<RemoveServerResult> {
    this.requireEnabled();
    const server = this.stored(id);
    const token = this.registry.tokenOf(id);
    let result: RemoveServerResult;
    if (token === null) {
      result = { revoked: false, reason: { code: 'servers.no-token' } };
    } else {
      let outcome: Awaited<ReturnType<typeof revokeSelf>>;
      try {
        const chosen = await this.choose(server);
        outcome = await revokeSelf(this.agentOf(id), chosen.address.url, token, this.timeouts.probeMs);
      } catch (error) {
        outcome = { kind: 'failed', code: serversErrorOf(error)?.reason ?? 'servers.unreachable' };
      }
      if (outcome.kind === 'failed' && !options.force) {
        throw new ServersError(502, 'servers.revoke-failed', `${server.name} did not take its token back (${outcome.code}); try again, or remove it with ?force=true and revoke the token on that server`);
      }
      result = outcome.kind === 'revoked' ? { revoked: true } : { revoked: false, reason: { code: outcome.kind === 'unknown' ? 'servers.token-unknown' : outcome.code } };
    }
    await this.registry.remove(id);
    await this.forget(id);
    return result;
  }

  /** Test connection (§4.2): meta, REST, the event stream and a WebSocket upgrade, each on its own, on a fresh choice of address */
  async test(id: string): Promise<ServerTestResult> {
    this.requireEnabled();
    const server = this.stored(id);
    const token = this.registry.tokenOf(id);
    let chosen: Chosen;
    try {
      chosen = await this.choose(server, { fresh: true });
    } catch (error) {
      const code = serversErrorOf(error)?.reason ?? 'servers.unreachable';
      const down: ServerCheck = { ok: false, code };
      return { address: null, meta: down, rest: down, events: down, socket: down };
    }
    const meta: ServerCheck = { ok: true, ...(chosen.latencyMs !== null ? { latencyMs: chosen.latencyMs } : {}) };
    const incompatible = chosen.meta ? apiCompatibility(chosen.meta) : null;
    if (incompatible) Object.assign(meta, { ok: false, code: incompatible });
    if (token === null) {
      const missing: ServerCheck = { ok: false, code: 'servers.needs-pairing' };
      this.setStatus(id, 'needs-pairing', 'servers.needs-pairing');
      return { address: chosen.address.url, meta, rest: missing, events: missing, socket: missing };
    }
    const agent = this.agentOf(id);
    const origin = new URL(chosen.address.url);
    const [rest, events, socket] = await Promise.all([
      checkRest(agent, chosen.address.url, token, this.timeouts.checkMs),
      checkEvents(agent, chosen.address.url, token, this.timeouts.checkMs),
      checkSocket(origin, token, () => this.openTo(id, origin), this.timeouts.checkMs),
    ]);
    if (rest.code === 'servers.needs-pairing') this.setStatus(id, 'needs-pairing', 'servers.needs-pairing');
    return { address: chosen.address.url, meta, rest, events, socket };
  }

  /**
   * The person selected the server: `lastUsedAt` now, and its health read again on the address in use
   * (or, failing that, the first that answers), with an authenticated read so a revoked token shows
   * as `needs-pairing` before the first page asks. Never fails for a server that is down: the reading
   * says so.
   */
  async use(id: string): Promise<ClaudioServer> {
    this.requireEnabled();
    this.stored(id);
    const server = await this.registry.change(id, (current) => ({ ...current, lastUsedAt: now() }));
    try {
      const chosen = await this.freshen(server);
      const token = this.registry.tokenOf(id);
      const rest = token === null ? ({ ok: false, code: 'servers.needs-pairing' } satisfies ServerCheck) : await checkRest(this.agentOf(id), chosen.address.url, token, this.timeouts.probeMs);
      if (rest.code === 'servers.needs-pairing') this.setStatus(id, 'needs-pairing', 'servers.needs-pairing');
    } catch {
      // `choose` wrote the reading down: offline, or the identity changed
    }
    return this.view(this.registry.get(id) ?? server);
  }

  /**
   * Where the gateway sends a request now. A server whose API this hub's web cannot speak answers
   * only its meta (D3); one whose identity no address proves is not reached at all (D5).
   */
  async target(id: string, path: string): Promise<GatewayTarget> {
    const server = this.stored(id);
    const token = this.registry.tokenOf(id);
    if (token === null) throw new ServersError(409, 'servers.needs-pairing', `the hub holds no token for ${server.name}: pair it again`);
    const chosen = await this.choose(server);
    const health = this.health.get(id);
    if (health?.status === 'needs-update' && path !== '/api/meta') {
      throw new ServersError(409, 'servers.needs-update', `${server.name} speaks API ${String(health.apiVersion)}, which this hub's web does not (${health.reason?.code ?? 'servers.needs-update'})`);
    }
    const origin = new URL(chosen.address.url);
    return { server, origin, agent: this.agentOf(id), token, open: () => this.openTo(id, origin) };
  }

  /**
   * What a relayed request taught about the address in use. A failure counts towards moving
   * (hysteresis); a certificate that no longer matches moves at once, since every later connection
   * to that address would be refused the same way.
   */
  report(id: string, address: string, outcome: GatewayOutcome): void {
    const route = this.routes.get(id);
    if (!route || route.address !== address) return;
    const last = this.health.get(id);
    if (outcome.kind === 'ok') {
      route.failures = 0;
      if (last && (last.status === 'reconnecting' || last.status === 'needs-pairing' || last.status === 'offline')) {
        const { reason: _reason, ...rest } = last;
        this.health.set(id, { ...rest, status: 'connected', address, latencyMs: outcome.latencyMs, checkedAt: now() });
      }
      return;
    }
    if (outcome.kind === 'needs-pairing') {
      this.setStatus(id, 'needs-pairing', 'servers.needs-pairing');
      return;
    }
    route.failures += 1;
    if (outcome.reason === 'servers.identity-changed' || route.failures >= FAILURES_BEFORE_MOVE) {
      this.routes.set(id, { address: null, failures: 0 });
      this.setStatus(id, outcome.reason === 'servers.identity-changed' ? 'identity-changed' : 'offline', outcome.reason);
    } else {
      this.setStatus(id, 'reconnecting', outcome.reason);
    }
  }

  /** Keeps a relayed connection to a server until it ends; `close` runs if the server goes or the feature is turned off first */
  hold(id: string, close: () => void): () => void {
    let set = this.held.get(id);
    if (!set) {
      set = new Set();
      this.held.set(id, set);
    }
    set.add(close);
    return () => {
      this.held.get(id)?.delete(close);
    };
  }

  async close(): Promise<void> {
    await this.disconnectAll();
  }

  private requireEnabled(): void {
    if (!this.enabled) throw disabled();
  }

  private stored(id: string): StoredServer {
    const server = this.registry.get(id);
    if (!server) throw notFound(id);
    return server;
  }

  private view(server: StoredServer): ClaudioServer {
    return {
      id: server.id,
      name: server.name,
      color: server.color,
      monogram: server.monogram,
      addresses: server.addresses.map((each) => ({ ...each })),
      identity: { instanceId: server.identity.instanceId, tlsFingerprint: server.identity.tlsFingerprint },
      createdAt: server.createdAt,
      lastUsedAt: server.lastUsedAt,
      health: this.health.get(server.id) ?? null,
    };
  }

  private setStatus(id: string, status: ServerHealth['status'], code: string): void {
    const last = this.health.get(id);
    this.health.set(id, {
      status,
      address: status === 'offline' || status === 'identity-changed' ? null : (last?.address ?? null),
      version: last?.version ?? null,
      apiVersion: last?.apiVersion ?? null,
      latencyMs: status === 'connected' ? (last?.latencyMs ?? null) : null,
      checkedAt: now(),
      reason: { code },
    });
  }

  /**
   * What the pins are after a pairing. A certificate no CA vouches for (the LAN listener's) must be
   * the one the grant names, or something between hub and remote answered in the remote's place. One
   * a CA vouches for (a tailnet name, a proxy) is not the remote's own, so the grant's fingerprint is
   * pinned for the remote's LAN addresses and its key is learnt there on first use of the pin.
   */
  private pinsFrom(grant: ServerLinkGrant, seen: PeerSeen | null): PeerPins {
    if (seen && !seen.caValid) {
      if (grant.tlsFingerprint === null || !sameFingerprint(grant.tlsFingerprint, seen.fingerprint)) {
        throw new ServersError(502, 'servers.fingerprint-mismatch', `the server showed the certificate ${seen.fingerprint}, but says its own is ${grant.tlsFingerprint ?? 'none'}: something between the hub and the server answered in its place`);
      }
      return { fingerprint: seen.fingerprint, publicKey: seen.publicKey };
    }
    return { fingerprint: grant.tlsFingerprint, publicKey: null };
  }

  private pinnedTrust(pins: () => PeerPins, matched?: (seen: PeerSeen) => void): Trust {
    return { kind: 'pinned', pins, ...(matched ? { matched } : {}) };
  }

  /** The pool of one server, whose connections each check the identity on record at the time they open */
  private agentOf(id: string): Agent {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = agentFor(this.trustOf(id), this.network);
      this.agents.set(id, agent);
    }
    return agent;
  }

  private trustOf(id: string): Trust {
    return this.pinnedTrust(
      () => {
        const server = this.registry.get(id);
        return { fingerprint: server?.identity.tlsFingerprint ?? null, publicKey: server?.identity.publicKey ?? null };
      },
      (seen) => void this.learn(id, seen),
    );
  }

  /**
   * A connection matched one pin: the other is brought in line. The certificate remade on the same
   * key (the remote gained an address) becomes the pinned one, and a key never seen at pairing (it
   * paired through a tailnet name) is learnt from the certificate the grant named.
   */
  private async learn(id: string, seen: PeerSeen): Promise<void> {
    const server = this.registry.get(id);
    if (!server) return;
    const { tlsFingerprint, publicKey } = server.identity;
    if (tlsFingerprint !== null && sameFingerprint(tlsFingerprint, seen.fingerprint) && publicKey === seen.publicKey) return;
    try {
      await this.registry.change(id, (current) => ({ ...current, identity: { ...current.identity, tlsFingerprint: seen.fingerprint, publicKey: seen.publicKey } }));
    } catch {
      // Learnt again on the next connection
    }
  }

  /**
   * After a pairing on `paired`: an address that answers as another Claudio is refused now; one that
   * does not answer yet is kept, since nothing is ever sent on it until it proves the identity at a probe
   */
  private async checkOtherAddresses(server: StoredServer, paired: ServerAddress): Promise<void> {
    const check = agentFor(this.pinnedTrust(() => ({ fingerprint: server.identity.tlsFingerprint, publicKey: server.identity.publicKey })), this.network);
    try {
      for (const address of server.addresses) {
        if (address.url === paired.url) continue;
        const probe = await this.probeAddress(server, address, check);
        if (!probe.ok && probe.reason === 'servers.identity-changed') {
          throw new ServersError(409, 'servers.address-identity', `${address.url} answers as another Claudio than the one paired on ${paired.url}`);
        }
      }
    } finally {
      await check.destroy();
    }
  }

  /**
   * Gives a replaced token back to the server that issued it: over connections pinned to the
   * identity it had (`previous`), on the first address whose meta still says it is that server.
   * Gone already (a `401`) counts as given back.
   */
  private async revokePrevious(previous: StoredServer, token: string | null): Promise<RemoveServerResult> {
    if (token === null) return { revoked: false, reason: { code: 'servers.no-token' } };
    const pins: PeerPins = { fingerprint: previous.identity.tlsFingerprint, publicKey: previous.identity.publicKey };
    const check = agentFor(this.pinnedTrust(() => pins), this.network);
    let reason = 'servers.unreachable';
    try {
      for (const address of previous.addresses) {
        const probe = await this.probeAddress(previous, address, check);
        if (!probe.ok) {
          if (probe.reason === 'servers.identity-changed') reason = probe.reason;
          continue;
        }
        const outcome = await revokeSelf(check, address.url, token, this.timeouts.probeMs);
        return outcome.kind === 'failed' ? { revoked: false, reason: { code: outcome.code } } : { revoked: true };
      }
      return { revoked: false, reason: { code: reason } };
    } finally {
      await check.destroy();
    }
  }

  private openTo(id: string, origin: URL): Promise<Socket> {
    return dial({ protocol: origin.protocol, hostname: origin.hostname, port: Number(origin.port) || (origin.protocol === 'https:' ? 443 : 80) }, this.trustOf(id), this.network);
  }

  private async probeAddress(server: StoredServer, address: ServerAddress, agent: Agent): Promise<Probe> {
    const started = Date.now();
    try {
      const meta = await readMeta(agent, address.url, this.timeouts.probeMs);
      if (meta.instanceId !== server.identity.instanceId) return { ok: false, address, reason: 'servers.identity-changed' };
      return { ok: true, address, meta, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, address, reason: serversErrorOf(error)?.reason ?? 'servers.unreachable' };
    }
  }

  /** The address in use while it holds, else the first in the owner's order that proves the identity; one probe at a time per server */
  private choose(server: StoredServer, options: { fresh?: boolean } = {}): Promise<Chosen> {
    const route = this.routes.get(server.id);
    if (!options.fresh && route?.address && route.failures < FAILURES_BEFORE_MOVE) {
      const address = server.addresses.find((each) => each.url === route.address);
      if (address) return Promise.resolve({ address, meta: null, latencyMs: null });
    }
    const running = this.probing.get(server.id);
    if (running) return running;
    const probe = this.probeInOrder(server).finally(() => this.probing.delete(server.id));
    this.probing.set(server.id, probe);
    return probe;
  }

  private async probeInOrder(server: StoredServer): Promise<Chosen> {
    const agent = this.agentOf(server.id);
    const failures: Array<Extract<Probe, { ok: false }>> = [];
    for (const address of server.addresses) {
      const probe = await this.probeAddress(server, address, agent);
      if (probe.ok) {
        this.routes.set(server.id, { address: address.url, failures: 0 });
        this.health.set(server.id, healthOf(probe));
        return { address, meta: probe.meta, latencyMs: probe.latencyMs };
      }
      failures.push(probe);
    }
    this.routes.set(server.id, { address: null, failures: 0 });
    const changed = failures.some((each) => each.reason === 'servers.identity-changed');
    const reason = changed ? 'servers.identity-changed' : (failures[0]?.reason ?? 'servers.unreachable');
    this.setStatus(server.id, changed ? 'identity-changed' : 'offline', reason);
    throw changed
      ? new ServersError(409, 'servers.identity-changed', `no address of ${server.name} answers as the server paired: pair it again if it was reinstalled`)
      : new ServersError(502, reason === 'servers.address-refused' ? reason : 'servers.unreachable', `no address of ${server.name} answered`);
  }

  /** The address in use, read again; if it fails, the hysteresis decides whether another is looked for */
  private async freshen(server: StoredServer): Promise<Chosen> {
    const route = this.routes.get(server.id);
    const current = route?.address ? server.addresses.find((each) => each.url === route.address) : undefined;
    if (current) {
      const probe = await this.probeAddress(server, current, this.agentOf(server.id));
      if (probe.ok) {
        this.routes.set(server.id, { address: current.url, failures: 0 });
        this.health.set(server.id, healthOf(probe));
        return { address: current, meta: probe.meta, latencyMs: probe.latencyMs };
      }
      this.report(server.id, current.url, { kind: 'failed', reason: probe.reason });
    }
    return this.choose(server);
  }

  /**
   * Pairs on the first address that answers as a Claudio, over an agent that trusts the first
   * certificate it sees and then only that one. An address that answers is where the pairing
   * happens or fails: the code is never tried on a second machine.
   *
   * An owner token is worth more than a code (it is not single-use, and it mints any number of
   * links), so over TLS the address is first only shaken hands with, and its certificate must be the
   * one the person confirmed before any request goes there (D13); the agent then takes that one
   * certificate only, so the token cannot land on another that answered in between.
   */
  private async pairOn(
    addresses: ServerAddress[],
    pairing: ServerPairing,
    hub: HubName,
    /** The server being paired again, which may be the one that answers */
    again?: string,
  ): Promise<{ address: ServerAddress; meta: ServerMeta; latencyMs: number; grant: ServerLinkGrant; agent: Agent; seen: PeerSeen | null }> {
    let unreachable: ServersError | null = null;
    for (const address of addresses) {
      const trust: Extract<Trust, { kind: 'first-use' }> = { kind: 'first-use', seen: null };
      const url = new URL(address.url);
      if (pairing.kind === 'token' && url.protocol === 'https:') {
        let seen: PeerSeen | null;
        try {
          seen = await peek({ protocol: url.protocol, hostname: url.hostname, port: Number(url.port) || 443 }, this.network);
        } catch (error) {
          unreachable ??= serversErrorOf(error) ?? new ServersError(502, 'servers.unreachable', `${address.url} did not answer`);
          continue;
        }
        if (seen) {
          confirmFingerprint(pairing.expectedFingerprint, seen, address.url);
          trust.seen = seen;
        }
      }
      const agent = agentFor(trust, this.network);
      const started = Date.now();
      let meta: ServerMeta;
      try {
        meta = await readMeta(agent, address.url, this.timeouts.probeMs);
      } catch (error) {
        await agent.destroy();
        unreachable ??= serversErrorOf(error) ?? new ServersError(502, 'servers.unreachable', `${address.url} did not answer`);
        continue;
      }
      const latencyMs = Date.now() - started;
      try {
        if (meta.instanceId === this.instanceId) throw new ServersError(400, 'servers.self', `${address.url} is this Claudio`);
        const existing = this.registry.list().find((each) => each.identity.instanceId === meta.instanceId && each.id !== again);
        if (existing) throw new ServersError(409, 'servers.already-paired', `that server is on the list already, as ${existing.name}`);
        const grant = await pair(agent, address.url, pairing, hub, this.timeouts.pairMs);
        return { address, meta, latencyMs, grant, agent, seen: trust.seen };
      } catch (error) {
        await agent.destroy();
        throw error;
      }
    }
    throw unreachable ?? new ServersError(502, 'servers.unreachable', 'no address answered');
  }

  /** Closes what the hub holds open to one server, and forgets how it was reached */
  private async forget(id: string): Promise<void> {
    this.health.delete(id);
    await this.forgetConnections(id);
  }

  private async disconnectAll(): Promise<void> {
    const ids = new Set([...this.agents.keys(), ...this.held.keys()]);
    await Promise.all([...ids].map((id) => this.forgetConnections(id)));
  }

  /** As `forget`, but the readings stay: the server is still on the list */
  private async forgetConnections(id: string): Promise<void> {
    for (const close of this.held.get(id) ?? []) close();
    this.held.delete(id);
    this.routes.delete(id);
    const agent = this.agents.get(id);
    this.agents.delete(id);
    await agent?.destroy();
  }
}
