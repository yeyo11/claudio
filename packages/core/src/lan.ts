import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIPv4, type Socket } from 'node:net';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { AppSettingSource, AuthMode, LanAddress, LanInterface, LanSettings, LanState, LanStatus, Localized, LocalizedParams, TunnelPortTaken } from '@claudio/shared';
import type { RuntimeHostOptions } from './app-settings.ts';
import { writeAtomic } from './config/files.ts';
import type { ClaudioEventInput } from './events.ts';
import type { LanSwitch } from './paths.ts';

/*
 * Claudio on the local network (docs/plans/lan-access.md). The main listener stays on loopback as it
 * is; this is a second `http.Server` per address, on a fixed port, that hands every request and
 * every upgrade to the same app, so the guard, the host allowlist and the routes are the ones the
 * main listener has. What has to hold: it listens only while the guard asks for a credential and
 * closes before the first unguarded request, only the addresses it listens on (and the machine's
 * `.local` name) join the allowlist and only while it listens, and each device is its own back-off
 * bucket (`peerIsClient`). Plain HTTP, no TLS.
 */

/** The port devices open Claudio at unless the settings or `CLAUDIO_LAN_PORT` say otherwise */
export const DEFAULT_LAN_PORT = 8791;
/** The ports the setting accepts: none of the privileged ones */
export const MIN_LAN_PORT = 1024;
export const MAX_LAN_PORT = 65535;
/** More addresses than any machine has interfaces: a longer list is a mistake, not a choice */
const MAX_BIND = 32;
/** How many ports above a taken one are tried for `nextFree` */
const NEXT_FREE_SPAN = 20;
/** How long `<hostname>.local` may take to resolve: mDNS that does not answer must not hold a start */
const LOCAL_NAME_TIMEOUT_MS = 1_500;
/** How often a listening wildcard re-reads the interfaces, so a new DHCP lease joins the allowlist */
const REFRESH_MS = 30_000;
/** How long the reply of the request that closed the listener (a stop from a phone) gets to leave */
const REPLY_GRACE_MS = 1_000;

/** Every connection on a LAN address is the device itself: its own address is its own budget */
export const LAN_HOST_OPTIONS: RuntimeHostOptions = { peerIsClient: true };

const SETTING_KEYS = ['enabled', 'port', 'bind'] as const;
type LanSettingKey = (typeof SETTING_KEYS)[number];

export type LanRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;
export type LanUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * What the listener reads of the machine. Replaced by tests, the way `terminals.peer.check` is: a
 * test listens on loopback and pretends the machine has a LAN address, so nothing binds a real one.
 */
export interface LanNetwork {
  /** Where `bind: 'all'` listens */
  wildcard: string;
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** `<hostname>.local` and the IPv4 address it resolves to, or null when it does not */
  localName: () => Promise<{ host: string; ip: string } | null>;
}

export interface LanDeps {
  dataDir: string;
  /** `CLAUDIO_LAN`; null when unset */
  switch: LanSwitch | null;
  /** `CLAUDIO_LAN_PORT`: the setting is read-only then. 0 is whatever is free (tests) */
  port?: number;
  /** `CLAUDIO_LAN_BIND`: the setting is read-only then */
  bind?: string[];
  /** Read on every decision rather than copied: the mode can change while it listens */
  security: { readonly mode: AuthMode };
  /** Where its addresses are registered for the guard, and removed from again */
  hosts: { add(host: string, options?: RuntimeHostOptions): void; remove(host: string): void };
  emit?: (event: ClaudioEventInput) => void;
  /** One row in the security history for what it does by itself; the routes are audited by the API */
  audit?: (row: { method: string; path: string; summary: string }) => void;
}

/**
 * A refusal the API answers with `409`: the request was understood, the wrapper's state forbids it.
 * `reason` is the code the answer carries (`lan.authRequired`), which a client translates.
 */
export class LanRefusedError extends Error {
  readonly reason: string;
  constructor(
    readonly localized: Localized,
    readonly statusCode = 409,
  ) {
    super(localized.text);
    this.reason = localized.code;
  }
}

const reason = (code: string, text: string, params?: LocalizedParams): Localized => (params ? { code, params, text } : { code, text });

const REASONS = {
  disabled: () => reason('lan.disabled', 'This Claudio does not listen on the local network. Whoever runs it can turn it on with CLAUDIO_LAN=on.'),
  authRequired: () => reason('lan.authRequired', 'Listening on the local network needs a sign-in method: turn on a token or OIDC in Security first.'),
  notReady: () => reason('lan.notReady', 'Claudio is not serving yet, so there is nothing to listen for.'),
  // A string, so the page does not group its digits as it would a count
  portInUse: (port: number) => reason('lan.portInUse', `Another program holds port ${port}. Choose another port, or free this one.`, { port: String(port) }),
  addressMissing: (address: string) => reason('lan.addressMissing', `This machine has no address ${address} now, so Claudio cannot listen on it. Choose the interfaces again.`, { address }),
  listenFailed: (detail: string) => reason('lan.listenFailed', `Claudio could not listen on the local network: ${detail}`, { detail }),
  enabledFromEnv: () => reason('lan.enabledFromEnv', 'Whether Claudio listens on the local network is set by CLAUDIO_LAN where it runs, so it cannot be changed here.'),
  portFromEnv: () => reason('lan.portFromEnv', 'The port is set by CLAUDIO_LAN_PORT where Claudio runs, so it cannot be changed here.'),
  bindFromEnv: () => reason('lan.bindFromEnv', 'The interfaces are set by CLAUDIO_LAN_BIND where Claudio runs, so they cannot be changed here.'),
};

const LOOPBACK_V4 = /^127\./;
const UNSPECIFIED_V4 = '0.0.0.0';

const validPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_LAN_PORT && value <= MAX_LAN_PORT;

function parseBind(value: unknown): 'all' | string[] {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length === 0) throw new Error("bind must be 'all' or a list of IPv4 addresses");
  if (value.length > MAX_BIND) throw new Error(`bind takes at most ${String(MAX_BIND)} addresses`);
  const addresses = value.map((each) => (typeof each === 'string' ? each.trim() : each));
  for (const address of addresses) if (typeof address !== 'string' || !isIPv4(address)) throw new Error(`bind: '${String(address)}' is not an IPv4 address`);
  // Every interface at once, which is `all`; listed, it would join the allowlist as a name
  if (addresses.includes(UNSPECIFIED_V4)) throw new Error(`bind: '${UNSPECIFIED_V4}' is every interface: choose 'all' instead`);
  return [...new Set(addresses as string[])];
}

const sameBind = (a: 'all' | string[], b: 'all' | string[]): boolean => (a === 'all' || b === 'all' ? a === b : a.length === b.length && a.every((each, i) => each === b[i]));

/** The machine's `.local` name, when the resolver (nss-mdns, systemd-resolved) answers for it */
async function resolveLocalName(): Promise<{ host: string; ip: string } | null> {
  const label = hostname().trim().toLowerCase().split('.')[0] ?? '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  const host = `${label}.local`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await Promise.race([
      lookup(host, { family: 4 }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LOCAL_NAME_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return found ? { host, ip: found.address } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The error code of a failed `listen`, which says whether the port, the address or something else was the problem */
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen({ port, host }, () => {
      server.removeListener('error', failed);
      resolve();
    });
  });
}

/** Whether nothing holds `port` on every one of `hosts`, by binding and letting go */
async function portFree(port: number, hosts: readonly string[]): Promise<boolean> {
  for (const host of hosts) {
    const probe = createServer();
    try {
      await listen(probe, port, host);
    } catch {
      return false;
    } finally {
      await new Promise<void>((resolve) => (probe.listening ? probe.close(() => resolve()) : resolve()));
    }
  }
  return true;
}

interface Listening {
  servers: Server[];
  sockets: Set<Socket>;
  /** Sockets with a reply still being written: a stop asked for over the LAN answers before its socket goes */
  busy: Map<Socket, ServerResponse>;
  /** The port bound, which is the asked one unless that was 0 */
  port: number;
}

/**
 * The listener on the local network: one `http.Server` per address (one on the wildcard for
 * `bind: 'all'`), each handing its requests and upgrades to the app's own. Every change of state
 * goes through one queue, so a stop racing a start never leaves a server nobody owns.
 */
export class LanListener {
  private readonly settingsFile: string;
  private stored: Partial<LanSettings> = {};
  private state: LanState = 'off';
  private reason: Localized | null = null;
  private taken: TunnelPortTaken | null = null;
  private handlers: { request: LanRequestHandler; upgrade: LanUpgradeHandler } | null = null;
  private listening: Listening | null = null;
  /** The names lent to the guard while it listens */
  private lent = new Set<string>();
  private addresses: LanAddress[] = [];
  private localName: { host: string; ip: string } | null = null;
  /** Whether it should be listening: the setting at start, then the person's start and stop */
  private wanted = false;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshTimer: NodeJS.Timeout | null = null;
  private closed = false;

  readonly network: LanNetwork = { wildcard: '0.0.0.0', interfaces: networkInterfaces, localName: resolveLocalName };

  constructor(private readonly deps: LanDeps) {
    this.settingsFile = join(deps.dataDir, 'lan-settings.json');
    this.stored = this.readSettings();
  }

  /** Whether this deploy lets it listen at all */
  get available(): boolean {
    return this.deps.switch !== 'off';
  }

  /** What `enabled` is when the person set nothing: the launcher's word */
  private get launcherDefault(): boolean {
    return this.deps.switch === 'on' || this.deps.switch === 'auto';
  }

  private get enabledFromEnv(): boolean {
    return this.deps.switch === 'on' || this.deps.switch === 'off';
  }

  /** The settings in effect: the environment's, else the person's, else the defaults */
  private get settings(): { enabled: boolean; port: number; bind: 'all' | string[] } {
    return {
      enabled: this.enabledFromEnv ? this.deps.switch === 'on' : (this.stored.enabled ?? this.launcherDefault),
      port: this.deps.port ?? this.stored.port ?? DEFAULT_LAN_PORT,
      bind: this.deps.bind ?? this.stored.bind ?? 'all',
    };
  }

  /** Where each setting comes from, for the settings registry */
  sources(): Record<LanSettingKey, AppSettingSource> {
    this.stored = this.readSettings();
    return {
      enabled: this.enabledFromEnv ? 'env' : this.stored.enabled !== undefined ? 'file' : 'default',
      port: this.deps.port !== undefined ? 'env' : this.stored.port !== undefined ? 'file' : 'default',
      bind: this.deps.bind !== undefined ? 'env' : this.stored.bind !== undefined ? 'file' : 'default',
    };
  }

  /** The values the settings take when nothing is stored */
  defaultSettings(): LanSettings {
    return { enabled: this.launcherDefault, port: DEFAULT_LAN_PORT, bind: 'all' };
  }

  status(): LanStatus {
    const settings = this.settings;
    const listening = this.state === 'listening';
    return {
      state: this.state,
      reason: this.state === 'off' || listening ? null : this.reason,
      port: this.listening?.port ?? settings.port,
      addresses: listening ? this.addresses.map((each) => ({ ...each })) : [],
      interfaces: this.interfaces(),
      settings: { enabled: settings.enabled, port: settings.port, bind: settings.bind === 'all' ? 'all' : [...settings.bind] },
      available: this.available,
      portTaken: this.state === 'port-in-use' && this.taken ? { ...this.taken } : null,
    };
  }

  /** `GET /lan`: the interfaces and the `.local` name read again, so a new address shows without a restart */
  refresh(): Promise<LanStatus> {
    return this.serial(async () => {
      if (this.state === 'listening') await this.reconcileAddresses();
      return this.status();
    });
  }

  /** The machine's IPv4 interfaces, loopback left out */
  private interfaces(): LanInterface[] {
    const found: LanInterface[] = [];
    for (const [name, entries] of Object.entries(this.network.interfaces())) {
      for (const entry of entries ?? []) {
        // Node before 18.4 said 4 instead of 'IPv4'
        const v4 = entry.family === 'IPv4' || (entry.family as unknown) === 4;
        if (v4 && !entry.internal && !LOOPBACK_V4.test(entry.address)) found.push({ name, ip: entry.address });
      }
    }
    return found;
  }

  /**
   * Where requests and upgrades go: the app's own router and the main server's upgrade listener,
   * which `@fastify/websocket` listens on. Opens the listener when it should listen.
   */
  attach(request: LanRequestHandler, upgrade: LanUpgradeHandler): void {
    this.handlers = { request, upgrade };
    if (!this.available || !this.settings.enabled) return;
    this.wanted = true;
    void this.serial(async () => {
      if (!this.wanted) return;
      if (this.deps.security.mode === 'none') {
        this.refuse();
        this.deps.audit?.({ method: 'POST', path: '/api/lan/start', summary: 'Did not listen on the local network: no sign-in method is on' });
        return;
      }
      if (await this.open()) this.deps.audit?.({ method: 'POST', path: '/api/lan/start', summary: 'Listen on the local network with Claudio' });
    });
  }

  /**
   * Opens the listener now. Refused under `mode: 'none'`: whoever on the network reached the port
   * would own the machine. Refused as well where the deploy turned it off. A taken port is a state.
   */
  start(): Promise<LanStatus> {
    return this.serial(async () => {
      if (!this.available) throw new LanRefusedError(REASONS.disabled());
      if (this.deps.security.mode === 'none') throw new LanRefusedError(REASONS.authRequired());
      if (!this.handlers) throw new LanRefusedError(REASONS.notReady());
      this.wanted = true;
      if (this.state !== 'listening') await this.open();
      return this.status();
    });
  }

  /**
   * Closes the listener: its names leave the allowlist first, then every connection on it ends,
   * upgraded ones included. `unguarded` keeps it wanted, so it opens again once a guard is back.
   */
  stop(why: 'request' | 'unguarded' = 'request'): Promise<LanStatus> {
    return this.serial(async () => {
      if (why === 'request') this.wanted = false;
      const was = this.listening !== null;
      // Turning the guard off ends every connection at once; a person's stop lets its own reply out
      await this.close(why === 'request');
      if (why === 'unguarded') {
        if (was) this.deps.audit?.({ method: 'POST', path: '/api/lan/stop', summary: 'Stop listening on the local network: authentication was turned off' });
        if (this.wanted) this.refuse();
        else this.set('off');
      } else {
        this.set('off');
      }
      return this.status();
    });
  }

  /** The guard asks for a credential again: what was refused for the lack of one opens */
  guarded(): void {
    void this.serial(async () => {
      if (!this.wanted || !this.handlers || this.closed || this.state === 'listening') return;
      if (await this.open()) this.deps.audit?.({ method: 'POST', path: '/api/lan/start', summary: 'Listen on the local network: authentication was turned on' });
    });
  }

  /**
   * `PUT /lan/settings`. `enabled` opens or closes it now as well; a new port or interfaces move a
   * listener that is open, or retry one that failed. `null` for `enabled` goes back to the launcher's default.
   */
  updateSettings(input: unknown): Promise<LanStatus> {
    return this.serial(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('LAN settings must be a JSON object');
      const body = input as Record<string, unknown>;
      const unknownKeys = Object.keys(body).filter((key) => !(SETTING_KEYS as readonly string[]).includes(key));
      if (unknownKeys.length) throw new Error(`unknown LAN settings: ${unknownKeys.join(', ')}; the known ones are enabled, port and bind`);
      const before = this.settings;
      const next: Partial<LanSettings> = { ...this.stored };
      if (body.enabled !== undefined) {
        if (body.enabled !== null && typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean, or null for the default');
        if (this.enabledFromEnv && body.enabled !== before.enabled) throw new LanRefusedError(REASONS.enabledFromEnv());
        if (!this.enabledFromEnv) {
          if (body.enabled === null) delete next.enabled;
          else next.enabled = body.enabled;
        }
      }
      if (body.port !== undefined) {
        if (!validPort(body.port)) throw new Error(`port must be a whole number from ${String(MIN_LAN_PORT)} to ${String(MAX_LAN_PORT)}`);
        if (this.deps.port !== undefined && body.port !== before.port) throw new LanRefusedError(REASONS.portFromEnv());
        if (this.deps.port === undefined) next.port = body.port;
      }
      if (body.bind !== undefined) {
        const bind = parseBind(body.bind);
        if (this.deps.bind !== undefined && !sameBind(bind, before.bind)) throw new LanRefusedError(REASONS.bindFromEnv());
        if (this.deps.bind === undefined) next.bind = bind;
      }
      await this.writeSettings(next);
      await this.apply(before);
      this.changed();
      return this.status();
    });
  }

  /** The keys `lan-settings.json` holds now: the settings page reads it as it is, whoever wrote it last */
  storedKeys(): Set<LanSettingKey> {
    this.stored = this.readSettings();
    return new Set(SETTING_KEYS.filter((key) => this.stored[key] !== undefined));
  }

  /** Removes the stored values of `keys`, so their defaults apply again, and applies the result as `updateSettings` does */
  resetSettings(keys: readonly LanSettingKey[]): Promise<LanStatus> {
    return this.serial(async () => {
      this.stored = this.readSettings();
      const drop = keys.filter((key) => this.stored[key] !== undefined);
      if (!drop.length) return this.status();
      const before = this.settings;
      const next: Partial<LanSettings> = { ...this.stored };
      for (const key of drop) delete next[key];
      await this.writeSettings(next);
      await this.apply(before);
      this.changed();
      return this.status();
    });
  }

  /** For the process that is going away: the names leave the allowlist and every connection ends */
  shutdown(): Promise<void> {
    this.closed = true;
    this.wanted = false;
    return this.serial(() => this.close(false)).then(() => undefined);
  }

  /** What a change of settings means for the listener as it is */
  private async apply(before: { enabled: boolean; port: number; bind: 'all' | string[] }): Promise<void> {
    const after = this.settings;
    if (after.enabled !== before.enabled) this.wanted = after.enabled && this.available;
    if (!this.wanted) {
      await this.close(true);
      this.set('off');
      return;
    }
    const moved = after.port !== before.port || !sameBind(after.bind, before.bind);
    if (this.state === 'listening' && !moved) return;
    await this.close(true);
    if (this.deps.security.mode === 'none') this.refuse();
    else if (this.handlers) await this.open();
  }

  /** Listens on every address of the settings, or on none: one that fails closes the others */
  private async open(): Promise<boolean> {
    if (!this.handlers || this.closed) return false;
    const { port, bind } = this.settings;
    const hosts = bind === 'all' ? [this.network.wildcard] : bind;
    const sockets = new Set<Socket>();
    const busy = new Map<Socket, ServerResponse>();
    const servers: Server[] = [];
    let bound = port;
    let at = hosts[0] ?? this.network.wildcard;
    try {
      for (const host of hosts) {
        at = host;
        const server = this.serverFor(sockets, busy);
        servers.push(server);
        // Every address on the one port: the first bind settles it when the port is 0
        await listen(server, bound, host);
        if (bound === 0) bound = (server.address() as { port: number }).port;
      }
    } catch (error) {
      await closeServers(servers, sockets, null);
      const code = codeOf(error);
      if (code === 'EADDRINUSE') {
        this.taken = { port, holder: `${at}:${String(port)}`, nextFree: await this.nextFree(port, hosts) };
        this.reason = REASONS.portInUse(port);
        this.set('port-in-use');
      } else if (code === 'EADDRNOTAVAIL') {
        this.fail(REASONS.addressMissing(at));
      } else {
        this.fail(REASONS.listenFailed(code ? `${code}: ${(error as Error).message}` : String(error)));
      }
      return false;
    }
    // The hook that closes it runs before the mode turns to none, so a start queued behind that close
    // checked the mode while it was still a guard: read again once bound, and give the port back
    if (this.deps.security.mode === 'none') {
      await closeServers(servers, sockets, null);
      this.refuse();
      return false;
    }
    this.listening = { servers, sockets, busy, port: bound };
    this.taken = null;
    await this.reconcileAddresses(true);
    this.startRefresh();
    this.set('listening');
    return true;
  }

  private serverFor(sockets: Set<Socket>, busy: Map<Socket, ServerResponse>): Server {
    const server = createServer();
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    // Defence in depth: the hook closes the listener before the mode turns to none, and a request
    // already in flight then is still refused rather than served unguarded
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (this.deps.security.mode === 'none') {
        res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: REASONS.authRequired().text, code: 'lan.authRequired' }));
        return;
      }
      const socket = req.socket;
      busy.set(socket, res);
      res.once('close', () => {
        if (busy.get(socket) === res) busy.delete(socket);
      });
      this.handlers?.request(req, res);
    });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (this.deps.security.mode === 'none' || !this.handlers) {
        socket.destroy();
        return;
      }
      this.handlers.upgrade(req, socket, head);
    });
    return server;
  }

  /** The first port above a taken one that is free on every address, or null */
  private async nextFree(port: number, hosts: readonly string[]): Promise<number | null> {
    if (port === 0) return null;
    for (let candidate = port + 1; candidate <= Math.min(MAX_LAN_PORT, port + NEXT_FREE_SPAN); candidate += 1) {
      if (await portFree(candidate, hosts)) return candidate;
    }
    return null;
  }

  /**
   * The addresses it answers on and the names lent for them, read again from the interfaces.
   * Loopback is never lent: a loopback name in the runtime hosts would make every local request look
   * relayed (`fromLocalMachineStrict`), and loopback is answered already.
   */
  private async reconcileAddresses(quiet = false): Promise<void> {
    const listening = this.listening;
    if (!listening) return;
    const { bind } = this.settings;
    const machine = this.interfaces().map((each) => each.ip);
    const ips = (bind === 'all' ? machine : bind).filter((ip) => !LOOPBACK_V4.test(ip));
    this.localName = await this.network.localName().catch(() => null);
    if (this.listening !== listening) return;
    const port = listening.port;
    const next: LanAddress[] = ips.map((ip) => ({ ip, host: null, url: `http://${ip}:${String(port)}` }));
    const local = this.localName;
    if (local && ips.includes(local.ip)) next.push({ ip: local.ip, host: local.host, url: `http://${local.host}:${String(port)}` });
    const names = new Set(next.map((each) => each.host ?? each.ip));
    for (const name of this.lent) {
      if (names.has(name)) continue;
      this.deps.hosts.remove(name);
      this.lent.delete(name);
      this.deps.audit?.({ method: 'PUT', path: '/api/lan', summary: `LAN address ${name} left the allowlist` });
    }
    for (const name of names) {
      if (this.lent.has(name)) continue;
      try {
        this.deps.hosts.add(name, LAN_HOST_OPTIONS);
        this.lent.add(name);
      } catch {
        // A name the allowlist cannot hold exactly is not advertised either
        const at = next.findIndex((each) => (each.host ?? each.ip) === name);
        if (at >= 0) next.splice(at, 1);
      }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.addresses);
    this.addresses = next;
    if (changed && !quiet && this.state === 'listening') this.changed();
  }

  private startRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setInterval(() => {
      void this.serial(() => this.reconcileAddresses());
    }, REFRESH_MS);
    this.refreshTimer.unref();
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Takes the names back from the guard, then closes every server and ends every connection,
   * upgraded ones included. `graceful` spares a reply still being written for a moment: the request
   * that asked for the stop may have come over this very listener.
   */
  private async close(graceful: boolean): Promise<void> {
    this.stopRefresh();
    for (const name of this.lent) {
      this.deps.hosts.remove(name);
      this.deps.audit?.({ method: 'PUT', path: '/api/lan', summary: `LAN address ${name} left the allowlist` });
    }
    this.lent.clear();
    this.addresses = [];
    const listening = this.listening;
    this.listening = null;
    if (!listening) return;
    await closeServers(listening.servers, listening.sockets, graceful ? listening.busy : null);
  }

  private refuse(): void {
    this.reason = REASONS.authRequired();
    this.set('refused');
  }

  private fail(why: Localized): void {
    this.reason = why;
    this.set('failed');
  }

  private set(state: LanState): void {
    if (state === this.state && state === 'off') return;
    this.state = state;
    if (state === 'off' || state === 'listening') {
      this.reason = null;
      if (state === 'off') this.taken = null;
    }
    this.changed();
  }

  private changed(): void {
    const lan = this.status();
    // The title stays generic: the addresses travel in `lan` only
    this.deps.emit?.({ type: 'lan.changed', title: `LAN ${lan.state}`, lan });
  }

  /** One change at a time; a failure answers its caller and leaves the queue going */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private readSettings(): Partial<LanSettings> {
    if (!existsSync(this.settingsFile)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const doc = raw as Record<string, unknown>;
      // A value nobody could have saved through the API is dropped: its default applies
      const out: Partial<LanSettings> = {};
      if (typeof doc.enabled === 'boolean') out.enabled = doc.enabled;
      if (validPort(doc.port)) out.port = doc.port;
      try {
        if (doc.bind !== undefined) out.bind = parseBind(doc.bind);
      } catch {
        // Dropped
      }
      return out;
    } catch {
      // A file nobody can read holds nothing: the defaults apply
      return {};
    }
  }

  /** Writes only the keys the person set, so a default that changes later still applies to the rest */
  private async writeSettings(next: Partial<LanSettings>): Promise<void> {
    const doc: Partial<LanSettings> = {};
    for (const key of SETTING_KEYS) if (next[key] !== undefined) Object.assign(doc, { [key]: next[key] });
    await writeAtomic(this.settingsFile, `${JSON.stringify(doc, null, 2)}\n`);
    this.stored = doc;
  }
}

/**
 * Stops the servers accepting and ends their connections. `close()` alone would wait for every
 * connection, upgraded ones included, and the port is free again as soon as the listening handle
 * is, so nothing waits for them: a socket in `spare` ends once its reply is out, or after a moment.
 */
async function closeServers(servers: readonly Server[], sockets: ReadonlySet<Socket>, spare: ReadonlyMap<Socket, ServerResponse> | null): Promise<void> {
  for (const server of servers) if (server.listening) server.close();
  for (const socket of sockets) {
    const reply = spare?.get(socket);
    if (!reply) {
      socket.destroy();
      continue;
    }
    const timer = setTimeout(() => socket.destroy(), REPLY_GRACE_MS);
    timer.unref();
    // Ended on its way out, so a keep-alive connection is not served again by a closed listener
    reply.once('close', () => {
      clearTimeout(timer);
      socket.destroy();
    });
  }
  // The listening handles close on the next turn of the loop; after it the port can be bound again
  await new Promise<void>((resolve) => setImmediate(resolve));
}
