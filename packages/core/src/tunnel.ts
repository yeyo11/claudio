import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { AuthMode, Localized, LocalizedParams, TailscaleReadiness, TunnelSettings, TunnelState, TunnelStatus } from '@claudio/shared';
import { writeAtomic } from './config/files.ts';
import type { ClaudioEventInput } from './events.ts';
import type { RuntimeHostOptions } from './app-settings.ts';

/*
 * Reaching Claudio from a phone or another computer on the person's tailnet, through the Tailscale
 * CLI (docs/plans/tunnel.md). Claudio adds one `tailscale serve` rule (tailnet-only, never Funnel)
 * on a port of its own, and takes exactly that rule away again. Tailscale is reached only through
 * its CLI's flags and `--json` output: no LocalAPI socket, no tsnet. A machine's own Tailscale is
 * used with the session the person gave it; only the `tailscaled` the Docker image starts for
 * Claudio (`managed`) is signed in from the app, through `tailscale up` (setup/logins.ts). What has to hold before a byte crosses: no tunnel without
 * authentication, only the node's exact name joins the allowlist and only while the rule holds, and
 * nothing in the node's Serve config that Claudio did not add is ever changed.
 */

/** The HTTPS port of Claudio's Serve rule unless `CLAUDIO_TUNNEL_PORT` says otherwise: not 443, which the person's own `tailscale serve` takes by default. */
export const DEFAULT_TUNNEL_PORT = 8444;

/** `tailscale serve` took its current arguments (`--bg`, `--https=<port>`, `off`) in 1.52 */
export const MIN_TAILSCALE_VERSION: readonly [number, number] = [1, 52];

/**
 * Tailscale Serve sets `Tailscale-User-Login` and friends, and is documented to replace a client's
 * own copies, but whether it also sets `X-Forwarded-For` could not be measured here (the node's
 * Serve settings need an operator this machine's user is not). Trusting an unmeasured header would
 * let a client pick whose failure budget they spend, so the host is registered without one, and
 * all tunnel traffic shares one backoff bucket of its own, apart from loopback.
 */
export const TUNNEL_HOST_OPTIONS: RuntimeHostOptions = {};

export interface TunnelTiming {
  /** How often an active tunnel re-reads Tailscale's state and its Serve rule */
  monitorMs: number;
  /** How long one `tailscale` call may take before it counts as failed */
  commandTimeoutMs: number;
  /** How long a readiness probe is reused before `refresh` asks the CLI again */
  probeTtlMs: number;
  /** Readings in a row that find Tailscale down or the rule gone before an active tunnel gives up */
  maxMisses: number;
  /** The longest wait between two readings while the CLI does not answer (the wait doubles from `monitorMs`) */
  maxBackoffMs: number;
  /** How long an active tunnel may go on getting no answer before the status says Tailscale is not answering */
  stalledAfterMs: number;
}

const DEFAULT_TIMING: TunnelTiming = {
  monitorMs: 30_000,
  commandTimeoutMs: 10_000,
  probeTtlMs: 2_000,
  maxMisses: 2,
  maxBackoffMs: 300_000,
  stalledAfterMs: 600_000,
};

export interface TunnelDeps {
  dataDir: string;
  /** The `tailscale` CLI, from `TAILSCALE_BIN` */
  tailscaleBin: string;
  /** The HTTPS port on the node's tailnet name; `DEFAULT_TUNNEL_PORT` when left out */
  port?: number;
  /**
   * Whether this deploy offers the tunnel (`CoreConfig.tunnelEnabled`); true when left out. False
   * refuses every start, "start with Claudio" included, and the status says so.
   */
  enabled?: boolean;
  /**
   * Whether the daemon is Claudio's own (`CoreConfig.tailscaleManaged`): the reasons then send the
   * person to the app's sign-in instead of a terminal they do not have
   */
  managed?: boolean;
  /** Read on every decision rather than copied: the mode can change while the tunnel is open */
  security: { readonly mode: AuthMode };
  /** Where the node's name is registered for the guard, and removed from again */
  hosts: { add(host: string, options?: RuntimeHostOptions): void; remove(host: string): void };
  emit?: (event: ClaudioEventInput) => void;
  /** One row in the security history; the routes' own requests are audited by the API already */
  audit?: (row: { method: string; path: string; summary: string }) => void;
  timing?: Partial<TunnelTiming>;
}

/** A refusal the API answers with `409`: the request was understood, the wrapper's state forbids it. */
export class TunnelRefusedError extends Error {
  constructor(
    readonly reason: Localized,
    readonly statusCode = 409,
  ) {
    super(reason.text);
  }
}

const reason = (code: string, text: string, params?: LocalizedParams): Localized => (params ? { code, params, text } : { code, text });

const REASONS = {
  disabled: () => reason('tunnel.disabled', 'This Claudio does not offer the tunnel. Whoever runs it can turn it on with CLAUDIO_TUNNEL=on.'),
  authRequired: () => reason('tunnel.authRequired', 'The tunnel needs authentication: turn on a token or OIDC in Security first.'),
  noPort: () => reason('tunnel.noPort', 'Claudio is not listening yet, so there is nothing to open a tunnel to.'),
  missing: () => reason('tunnel.tailscaleMissing', 'The Tailscale CLI (tailscale) was not found. Install Tailscale on this machine and sign in, then try again.'),
  unsupported: (version: string) =>
    reason('tunnel.tailscaleUnsupported', `Tailscale ${version} is too old: the tunnel needs 1.52 or later. Update Tailscale, then try again.`, { version }),
  daemonDown: () => reason('tunnel.tailscaleDaemonDown', 'The tailscale CLI could not reach the Tailscale service (tailscaled). Start it, then try again.'),
  loggedOut: () => reason('tunnel.tailscaleLoggedOut', 'This machine is not signed in to a tailnet. Run tailscale up in a terminal, then try again.'),
  notConnected: (state: string) =>
    reason('tunnel.tailscaleNotConnected', `Tailscale is not connected on this machine (${state}). Run tailscale up in a terminal, then try again.`, { state }),
  // Shown on an active tunnel whose rule is still in place: only the answers are missing
  notAnswering: () => reason('tunnel.tailscaleNotAnswering', 'Tailscale is not answering. The tunnel keeps its rule and checks again.'),
  magicDnsOff: () => reason('tunnel.magicDnsOff', 'MagicDNS is off for this tailnet. Turn it on in the DNS page of the Tailscale admin console, then try again.'),
  httpsOff: () => reason('tunnel.httpsOff', 'HTTPS certificates are off for this tailnet. Turn them on in the DNS page of the Tailscale admin console, then try again.'),
  permission: () =>
    reason('tunnel.servePermission', "Tailscale refused to change this machine's Serve settings for this user. Run sudo tailscale set --operator=$USER once, then try again."),
  // A string, so the page does not group its digits as it would a count
  portTaken: (port: number) =>
    reason('tunnel.portTaken', `Port ${port} of this machine's tailnet name is already served by something else, and Claudio leaves it alone. Free it, or set CLAUDIO_TUNNEL_PORT to another port.`, { port: String(port) }),
  serveFailed: (detail: string) => reason('tunnel.serveFailed', `tailscale serve did not accept the rule: ${detail}`, { detail }),
  unverified: () => reason('tunnel.unverified', "The Serve rule was sent, but this machine's Serve config does not show it pointing at Claudio."),
  ruleRemoved: () => reason('tunnel.ruleRemoved', "Claudio's Serve rule was removed or changed outside Claudio, so the tunnel is closed."),
  // Where Claudio runs tailscaled itself (the Docker image) there is no terminal to send anyone to
  managedDaemonDown: () =>
    reason('tunnel.managedDaemonDown', "The Tailscale service this container starts for Claudio is not answering. Restart the container; its log is tailscaled.log in the data volume's tailscale folder."),
  managedLoggedOut: () => reason('tunnel.managedLoggedOut', "This Claudio's Tailscale is not signed in to a tailnet. Sign in from Settings → Access & safety → Remote access."),
  managedNotConnected: (state: string) =>
    reason('tunnel.managedNotConnected', `This Claudio's Tailscale is not connected (${state}). Sign in again from Settings → Access & safety → Remote access.`, { state }),
};

interface CliResult {
  ok: boolean;
  /** The CLI could not be run at all */
  missing: boolean;
  /** The call timed out or could not be spawned: no answer, which says nothing about Tailscale itself */
  unanswered: boolean;
  stdout: string;
  stderr: string;
}

function runCli(bin: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, missing: false, unanswered: false, stdout, stderr });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      const missing = code === 'ENOENT' || code === 'EACCES';
      // `execFile` kills a call that outlives its timeout; a string code is a spawn failure, a number is the CLI's own exit status
      const unanswered = !missing && (error.killed === true || typeof code === 'string');
      resolve({ ok: false, missing, unanswered, stdout, stderr: stderr || error.message });
    });
  });
}

/** The first line a CLI wrote on stderr, short enough to show; it never carries a secret here. */
const firstLine = (text: string): string => (text.split('\n').find((line) => line.trim())?.trim() ?? '').slice(0, 200);

/** `1.102.4` from the first line of `tailscale version`, as numbers; null when it is not a version. */
export function parseTailscaleVersion(output: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** What `tailscale status --json` says, reduced to what the tunnel needs. */
interface StatusJson {
  BackendState?: unknown;
  Self?: { DNSName?: unknown } | null;
  CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
  CertDomains?: unknown;
}

/**
 * Readiness from `tailscale status --json` (measured on 1.102.4): `BackendState` says whether the
 * node is signed in and connected, `Self.DNSName` is its name with a trailing dot, and
 * `CertDomains` is only filled while HTTPS certificates are on for the tailnet.
 */
export function readinessFromStatus(json: StatusJson, version: string, managed = false): TailscaleReadiness {
  const state = typeof json.BackendState === 'string' ? json.BackendState : 'NoState';
  const dns = typeof json.Self?.DNSName === 'string' ? json.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  const host = dns || null;
  if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') return { state: 'loggedOut', version, host, reason: managed ? REASONS.managedLoggedOut() : REASONS.loggedOut() };
  if (state !== 'Running') return { state: 'stopped', version, host, reason: managed ? REASONS.managedNotConnected(state) : REASONS.notConnected(state) };
  if (json.CurrentTailnet?.MagicDNSEnabled !== true) return { state: 'httpsDisabled', version, host, reason: REASONS.magicDnsOff() };
  const certs = Array.isArray(json.CertDomains) ? json.CertDomains.filter((name): name is string => typeof name === 'string').map((name) => name.toLowerCase()) : [];
  if (!host || !certs.includes(host)) return { state: 'httpsDisabled', version, host, reason: REASONS.httpsOff() };
  return { state: 'ready', version, host, reason: null };
}

/** The parts of `tailscale serve status --json` (an `ipn.ServeConfig`) the tunnel reads. */
interface ServeConfigJson {
  TCP?: Record<string, unknown> | null;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | null> | null } | null> | null;
  Foreground?: Record<string, ServeConfigJson | null> | null;
}

/** Whether a port of the node's Serve config is free, holds exactly the rule Claudio would add, or holds anything else. */
export type ServePortUse = 'free' | 'match' | 'other';

const sameTarget = (a: unknown, b: string): boolean => typeof a === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * How `port` is used in a Serve config. Only one shape is Claudio's: an HTTPS listener on the port
 * with a single `/` handler that proxies to this server. A path the person added beside it, a TCP
 * forwarder, or a foreground `tailscale serve` on the port is theirs.
 */
export function servePortUse(config: ServeConfigJson, port: number, host: string, target: string): ServePortUse {
  const key = String(port);
  const uses = (c: ServeConfigJson | null | undefined): boolean => !!c && (c.TCP?.[key] !== undefined || Object.keys(c.Web ?? {}).some((name) => name.endsWith(`:${key}`)));
  const foreground = Object.values(config.Foreground ?? {}).some(uses);
  if (!uses(config) && !foreground) return 'free';
  if (foreground) return 'other';
  const webKeys = Object.keys(config.Web ?? {}).filter((name) => name.endsWith(`:${key}`));
  const handlers = config.Web?.[`${host}:${key}`]?.Handlers ?? {};
  const tcp = config.TCP?.[key] as { HTTPS?: unknown } | undefined;
  const paths = Object.keys(handlers);
  const only = webKeys.length === 1 && paths.length === 1 && paths[0] === '/';
  return only && tcp?.HTTPS === true && sameTarget(handlers['/']?.Proxy, target) ? 'match' : 'other';
}

/** The rule Claudio added, kept on disk so a crash cannot leave it behind unnoticed. */
interface ServeRecord {
  port: number;
  host: string;
  target: string;
  /**
   * The data directory's lock (`data-dir-lock.ts`) the server that wrote it held. A server that
   * holds the lock now knows that one is gone. A record without it was written before the lock
   * existed, perhaps by a Claudio that still runs.
   */
  lock?: string;
}

const sameRule = (a: ServeRecord, b: ServeRecord): boolean => a.port === b.port && a.host === b.host && a.target === b.target && a.lock === b.lock;

/** Whether something accepts connections at `target` (`http://host:port`): a live server behind a rule */
function targetAnswers(target: string, timeoutMs = 1_000): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) });
    const done = (answers: boolean) => {
      socket.destroy();
      resolve(answers);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const DEFAULT_SETTINGS: TunnelSettings = { startWithClaudio: false };
/** `startWithClaudio` as it was called before the rename, read from old settings files and old clients */
const LEGACY_START_KEY = 'startWithAgentry';

/** What the status says before the CLI was first asked: nothing is known, so nothing is offered. */
const UNPROBED: TailscaleReadiness = { state: 'missing', version: null, host: null, reason: null };

const versionAtLeast = (version: [number, number, number], min: readonly [number, number]): boolean =>
  version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);

/**
 * The tunnel: one Serve rule at a time, its state, and the host it lends the guard.
 *
 * `stopped → starting → verifying → active`, with `failed` and `stopping`. Tailscale keeps a
 * background Serve rule in the node's own config, beyond Claudio's life, so the rule is recorded in
 * `<dataDir>/tunnel/serve-rule.json` before it is added, removed on stop and on shutdown, and a
 * rule a crash left behind is reconciled away when Claudio starts again. Removal only ever touches
 * a port that still holds exactly the rule Claudio added, and only the rule this process added, or
 * one a previous holder of the data directory's lock left: a record is not proof that its writer
 * is gone (on 2026-10-18 a second server on the desktop's data directory took the desktop's live
 * rule for a leftover and closed its tunnel).
 */
export class TunnelManager {
  private readonly dir: string;
  private readonly recordFile: string;
  private readonly settingsFile: string;
  private readonly timing: TunnelTiming;
  private readonly port: number;
  private settings: TunnelSettings = { ...DEFAULT_SETTINGS };
  private state: TunnelState = 'stopped';
  private reason: Localized | null = null;
  private tailscale: TailscaleReadiness = UNPROBED;
  private probedAt = 0;
  private probing: Promise<TailscaleReadiness | null> | null = null;
  /** The host lent to the guard: set only while `active` */
  private lent: string | null = null;
  private since: string | null = null;
  private target: { host: string; port: number } | null = null;
  /** The data directory's lock this server holds, written into the record */
  private lockId: string | null = null;
  /** The rule this process added and has not taken away: the only one stop, give-up and shutdown remove */
  private rule: ServeRecord | null = null;
  /** Whether the person wants the tunnel open */
  private wanted = false;
  /** Aborted whenever the tunnel stops or gives up, so a call still in flight changes nothing after it */
  private run = new AbortController();
  private opening: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  /** A leftover rule being taken away; a start waits for it, so it never removes the new one */
  private cleaning: Promise<void> = Promise.resolve();
  private monitor: NodeJS.Timeout | null = null;
  /** A monitor reading is in flight */
  private monitoring = false;
  private misses = 0;
  /** Since when the monitor has had no answer from the CLI; null while it answers */
  private unknownSince: number | null = null;
  /** Readings in a row without an answer, for the back-off */
  private unknowns = 0;
  /** The tunnel failed because Tailscale was down or signed out after the person opened it: it opens again when Tailscale is ready */
  private recovering = false;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: TunnelDeps) {
    this.dir = join(deps.dataDir, 'tunnel');
    this.recordFile = join(this.dir, 'serve-rule.json');
    this.settingsFile = join(deps.dataDir, 'tunnel-settings.json');
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.port = deps.port ?? DEFAULT_TUNNEL_PORT;
    this.settings = this.readSettings();
  }

  status(): TunnelStatus {
    const active = this.state === 'active';
    return {
      state: this.state,
      url: active && this.lent ? this.urlOf(this.lent) : null,
      since: active ? this.since : null,
      reason: this.state === 'failed' ? this.reason : this.stalled ? REASONS.notAnswering() : null,
      checking: this.checking,
      enabled: this.enabled,
      managed: this.deps.managed ?? false,
      tailscale: { ...this.tailscale },
      port: this.port,
      settings: { ...this.settings },
    };
  }

  /** An active tunnel whose last readings got no answer: its rule and host stay, the tab says "Checking…" */
  private get checking(): boolean {
    return this.state === 'active' && this.unknownSince !== null;
  }

  /** Nothing but unknowns for longer than `stalledAfterMs` */
  private get stalled(): boolean {
    return this.checking && this.unknownSince !== null && Date.now() - this.unknownSince >= this.timing.stalledAfterMs;
  }

  private get enabled(): boolean {
    return this.deps.enabled ?? true;
  }

  private urlOf(host: string): string {
    return this.port === 443 ? `https://${host}` : `https://${host}:${this.port}`;
  }

  /**
   * Asks the CLI again when the last answer is older than a moment, and says so on the feed when
   * the answer changed. The routes call it before answering, so the tab reflects a `tailscale up`
   * run in a terminal without a restart. Where the deploy does not offer the tunnel, the CLI is
   * never run.
   */
  async refresh(force = false): Promise<TunnelStatus> {
    if (this.enabled && (force || Date.now() - this.probedAt > this.timing.probeTtlMs)) {
      const before = JSON.stringify(this.tailscale);
      await this.probe();
      if (JSON.stringify(this.tailscale) !== before) this.changed();
    }
    return this.status();
  }

  /** Null when the CLI gave no answer (a timeout or a spawn failure): the last reading stands. */
  private probe(): Promise<TailscaleReadiness | null> {
    this.probing ??= this.readReadiness()
      .then((readiness) => {
        if (!readiness) return null;
        this.tailscale = readiness;
        this.probedAt = Date.now();
        return readiness;
      })
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  private async readReadiness(): Promise<TailscaleReadiness | null> {
    const version = await this.cli(['version']);
    if (version.unanswered) return null;
    if (version.missing || !version.ok) return { state: 'missing', version: null, host: null, reason: REASONS.missing() };
    const text = firstLine(version.stdout);
    const parsed = parseTailscaleVersion(text);
    if (!parsed || !versionAtLeast(parsed, MIN_TAILSCALE_VERSION)) return { state: 'unsupported', version: text || null, host: null, reason: REASONS.unsupported(text || 'unknown') };
    const shown = parsed.join('.');
    const status = await this.cli(['status', '--json']);
    if (status.unanswered) return null;
    // `--json` prints the state even when the node is stopped; only a daemon that does not answer leaves no JSON
    let json: StatusJson | null = null;
    try {
      json = JSON.parse(status.stdout) as StatusJson;
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object') return { state: 'daemonDown', version: shown, host: null, reason: this.deps.managed ? REASONS.managedDaemonDown() : REASONS.daemonDown() };
    return readinessFromStatus(json, shown, this.deps.managed ?? false);
  }

  private cli(args: string[]): Promise<CliResult> {
    return runCli(this.deps.tailscaleBin, args, this.timing.commandTimeoutMs);
  }

  /**
   * Where the tunnel forwards to: the port the server actually bound to, which is not always the
   * one it asked for. Takes away a rule a crash left behind, then opens the tunnel when "start with
   * Claudio" is on. `lock` is the id of the data directory's lock the server holds.
   */
  attach(port: number, host = '127.0.0.1', lock: string | null = null): void {
    this.target = { host, port };
    this.lockId = lock;
    if (existsSync(this.recordFile)) this.cleaning = this.reconcile().catch(() => undefined);
    // A setting saved before the operator turned the tunnel off is not a reason to open it
    if (!this.settings.startWithClaudio || !this.enabled) return;
    this.start('claudio').catch((error: unknown) => {
      // Not thrown at startup: a tunnel that cannot open must not keep Claudio from starting
      if (error instanceof TunnelRefusedError) this.fail(error.reason);
    });
  }

  /**
   * Opens the tunnel. Refused under `mode: 'none'`: the tunnel would turn "whoever reaches the port
   * owns the machine" into "whoever on the tailnet has the URL does". Refused as well where the
   * deploy does not offer it. A Tailscale that is not ready is a state, not an error.
   */
  async start(actor: 'request' | 'claudio' | 'recovery' = 'request'): Promise<TunnelStatus> {
    if (!this.enabled) throw new TunnelRefusedError(REASONS.disabled());
    if (this.deps.security.mode === 'none') throw new TunnelRefusedError(REASONS.authRequired());
    if (!this.target) throw new TunnelRefusedError(REASONS.noPort());
    await this.stopping;
    await this.cleaning;
    if (this.wanted) return this.status();
    const readiness = await this.probe();
    if (!readiness) {
      this.fail(REASONS.notAnswering());
      return this.status();
    }
    if (readiness.state !== 'ready' || !readiness.host) {
      this.fail(readiness.reason ?? REASONS.missing());
      return this.status();
    }
    this.cancelRecovery();
    this.wanted = true;
    this.misses = 0;
    this.run = new AbortController();
    if (actor !== 'request') {
      const summary = actor === 'recovery' ? 'Start the tunnel again: Tailscale is ready' : 'Start the tunnel with Claudio';
      this.deps.audit?.({ method: 'POST', path: '/api/tunnel/start', summary });
    }
    this.set('starting');
    const run = this.run;
    this.opening = this.open(readiness.host, run).finally(() => {
      if (this.run === run) this.opening = null;
    });
    return this.status();
  }

  /** Closes the tunnel: its host leaves the allowlist first, then Claudio's Serve rule goes. */
  async stop(why: 'request' | 'unguarded' = 'request'): Promise<TunnelStatus> {
    // A tunnel the person stopped never restarts
    this.cancelRecovery();
    if (!this.wanted && !this.opening && !this.stopping) {
      if (this.state === 'failed') this.set('stopped');
      return this.status();
    }
    this.wanted = false;
    if (why === 'unguarded') this.deps.audit?.({ method: 'POST', path: '/api/tunnel/stop', summary: 'Stop the tunnel: authentication was turned off' });
    this.stopping ??= (async () => {
      this.run.abort();
      this.stopMonitor();
      this.withdraw();
      this.set('stopping');
      await this.opening;
      await this.removeOwnRule();
      this.set('stopped');
    })().finally(() => {
      this.stopping = null;
    });
    await this.stopping;
    return this.status();
  }

  async updateSettings(input: unknown): Promise<TunnelStatus> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tunnel settings must be a JSON object');
    const body = input as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => key !== 'startWithClaudio' && key !== LEGACY_START_KEY);
    if (unknownKeys.length) throw new Error(`unknown tunnel settings: ${unknownKeys.join(', ')}; the known one is startWithClaudio`);
    // A client built before the rename still sends the old name; the new one wins when both are sent
    const start = body.startWithClaudio ?? body[LEGACY_START_KEY];
    if (start === undefined) return this.refresh();
    if (typeof start !== 'boolean') throw new Error('startWithClaudio must be a boolean');
    const next = { ...this.settings, startWithClaudio: start };
    await writeAtomic(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
    // The event carries the whole status, readiness included, so it is read first
    await this.refresh();
    this.changed();
    return this.status();
  }

  /**
   * Synchronous, for the process that is going away: there is no later to wait in. The Serve rule
   * outlives the process unless it is taken away now; when that fails, the record stays for the
   * next start to reconcile.
   */
  shutdown(): void {
    this.wanted = false;
    this.cancelRecovery();
    this.run.abort();
    this.stopMonitor();
    this.withdraw();
    // Only the rule this process added: a server that never opened the tunnel (one that failed to
    // bind its port, say) has nothing to take away, whatever the record says
    const record = this.rule;
    if (!record) return;
    const run = (args: string[]) => spawnSync(this.deps.tailscaleBin, args, { encoding: 'utf8', timeout: this.timing.commandTimeoutMs });
    try {
      const status = run(['serve', 'status', '--json']);
      if (status.status !== 0) return;
      const use = servePortUse(JSON.parse(status.stdout) as ServeConfigJson, record.port, record.host, record.target);
      if (use === 'match') {
        const off = run(['serve', '--yes', `--https=${record.port}`, 'off']);
        if (off.status !== 0 && !/handler does not exist/i.test(off.stderr)) return;
      }
      this.rule = null;
      this.dropRecord(record);
    } catch {
      // The record stays: the next start takes the rule away
    }
  }

  private readSettings(): TunnelSettings {
    if (!existsSync(this.settingsFile)) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<TunnelSettings> & { [LEGACY_START_KEY]?: unknown };
      // A file written before the rename holds the old key; the next save writes the new one only
      return { startWithClaudio: (raw.startWithClaudio ?? raw[LEGACY_START_KEY]) === true };
    } catch {
      // Off is the safe reading of a file nobody can read: the tunnel only opens when asked
      return { ...DEFAULT_SETTINGS };
    }
  }

  private readRecord(): ServeRecord | null {
    try {
      const raw = JSON.parse(readFileSync(this.recordFile, 'utf8')) as Partial<ServeRecord>;
      if (typeof raw.port === 'number' && typeof raw.host === 'string' && typeof raw.target === 'string') {
        return { port: raw.port, host: raw.host, target: raw.target, ...(typeof raw.lock === 'string' ? { lock: raw.lock } : {}) };
      }
    } catch {
      // No record, or one nobody can read: nothing is known to be Claudio's
    }
    return null;
  }

  private writeRecord(record: ServeRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  /** Removes the record, if it still describes `rule`: one another server wrote since is not this one's to drop */
  private dropRecord(rule: ServeRecord): void {
    const onDisk = this.readRecord();
    if (!onDisk || sameRule(onDisk, rule)) rmSync(this.recordFile, { force: true });
  }

  private async serveConfig(): Promise<ServeConfigJson | null> {
    const result = await this.cli(['serve', 'status', '--json']);
    if (!result.ok) return null;
    try {
      const json = JSON.parse(result.stdout) as unknown;
      return json && typeof json === 'object' ? (json as ServeConfigJson) : null;
    } catch {
      return null;
    }
  }

  private targetUrl(): string | null {
    return this.target ? `http://${this.target.host}:${this.target.port}` : null;
  }

  /**
   * Adds the rule, unless the port is already someone else's, and reads the config back before the
   * host is lent to the guard. The record is written before the rule is sent, so a crash in between
   * leaves something to reconcile rather than a rule nobody knows about.
   */
  private async open(host: string, run: AbortController): Promise<void> {
    const target = this.targetUrl();
    if (!target) return;
    const live = (): boolean => !run.signal.aborted && this.wanted;
    const before = await this.serveConfig();
    if (!live()) return;
    if (!before) return this.giveUp(REASONS.daemonDown());
    if (servePortUse(before, this.port, host, target) !== 'free') return this.giveUp(REASONS.portTaken(this.port));
    const rule: ServeRecord = { port: this.port, host, target, ...(this.lockId ? { lock: this.lockId } : {}) };
    this.rule = rule;
    this.writeRecord(rule);
    const added = await this.cli(['serve', '--bg', '--yes', `--https=${this.port}`, target]);
    if (!added.ok) {
      const detail = firstLine(added.stderr);
      return this.giveUp(/access denied/i.test(added.stderr) ? REASONS.permission() : REASONS.serveFailed(detail || 'no output'));
    }
    if (!live()) return;
    this.set('verifying');
    const after = await this.serveConfig();
    if (!live()) return;
    if (!after || servePortUse(after, this.port, host, target) !== 'match') return this.giveUp(REASONS.unverified());
    if (this.deps.security.mode === 'none') {
      void this.stop('unguarded');
      return;
    }
    this.lend(host);
    this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${host} joined the allowlist` });
    this.set('active');
    this.startMonitor(run);
  }

  private lend(host: string): void {
    this.deps.hosts.add(host, TUNNEL_HOST_OPTIONS);
    this.lent = host;
    this.since = new Date().toISOString();
  }

  /**
   * At start, the record a previous run left. One written under this data directory's lock is a
   * previous holder's, and the lock this server holds says that holder is gone: its rule is taken
   * away. One written before the lock existed may be a Claudio's that still runs on this directory:
   * its rule is left alone while something answers at its target, which a crashed server does not.
   */
  private async reconcile(): Promise<void> {
    const record = this.readRecord();
    if (!record) {
      rmSync(this.recordFile, { force: true });
      return;
    }
    const own = this.targetUrl();
    if (!record.lock && record.target !== own && (await targetAnswers(record.target))) return;
    await this.removeRecorded(record);
  }

  /** Takes away the rule this process added, if any */
  private async removeOwnRule(): Promise<void> {
    const rule = this.rule;
    if (!rule) return;
    if (await this.removeRecorded(rule)) this.rule = null;
  }

  /**
   * Takes `record`'s rule away, if the port still holds exactly it. A port that is free, or that
   * someone else took over, is not Claudio's any more: the record goes and nothing is touched. When
   * Tailscale cannot be asked, the record stays for the next try. True once the rule is gone.
   */
  private async removeRecorded(record: ServeRecord): Promise<boolean> {
    const config = await this.serveConfig();
    if (!config) return false;
    if (servePortUse(config, record.port, record.host, record.target) === 'match') {
      const off = await this.cli(['serve', '--yes', `--https=${record.port}`, 'off']);
      if (!off.ok && !/handler does not exist/i.test(off.stderr)) return false;
    }
    this.dropRecord(record);
    return true;
  }

  /**
   * While active, Tailscale is read again now and then: a `tailscale down`, a sign-out or a
   * `tailscale serve reset` in a terminal would otherwise leave the tab saying open over an address
   * that no longer answers. A node renamed in the admin console moves the lent host with it.
   */
  private startMonitor(run: AbortController): void {
    this.stopMonitor();
    this.scheduleCheck(run, this.timing.monitorMs);
  }

  private scheduleCheck(run: AbortController, delayMs: number): void {
    this.monitor = setTimeout(() => void this.check(run), delayMs);
    this.monitor.unref();
  }

  private stopMonitor(): void {
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = null;
    this.unknownSince = null;
    this.unknowns = 0;
  }

  /**
   * One reading. A reading the CLI did not answer (a busy machine, a spawn failure) is unknown, not
   * down: the tunnel stays active, says it is checking, and tries again later and later. Only an
   * answer closes it.
   */
  private async check(run: AbortController): Promise<void> {
    if (this.monitoring || run.signal.aborted || this.state !== 'active') return;
    this.monitoring = true;
    try {
      const outcome = await this.reading(run);
      if (run.signal.aborted || this.state !== 'active') return;
      if (outcome === 'unknown') this.noAnswer();
      else this.answered();
    } finally {
      this.monitoring = false;
    }
    if (!run.signal.aborted && this.state === 'active') this.scheduleCheck(run, this.nextDelay());
  }

  private nextDelay(): number {
    return Math.min(this.timing.monitorMs * 2 ** this.unknowns, Math.max(this.timing.maxBackoffMs, this.timing.monitorMs));
  }

  private noAnswer(): void {
    const before = JSON.stringify([this.checking, this.stalled]);
    this.unknownSince ??= Date.now();
    this.unknowns++;
    if (JSON.stringify([this.checking, this.stalled]) !== before) this.changed();
  }

  private answered(): void {
    if (this.unknownSince === null) return;
    this.unknownSince = null;
    this.unknowns = 0;
    this.changed();
  }

  /** Reads Tailscale and the rule once; `unknown` when either call got no answer, and nothing was changed then. */
  private async reading(run: AbortController): Promise<'answered' | 'unknown'> {
    const readiness = await this.probe();
    if (run.signal.aborted || this.state !== 'active') return 'answered';
    if (!readiness) return 'unknown';
    if (readiness.state !== 'ready' || !readiness.host) {
      // Down, signed out or disconnected is an answer. It counts twice in a row before the tunnel closes, and it opens again when Tailscale is back
      if (++this.misses >= this.timing.maxMisses) {
        this.giveUp(readiness.reason ?? REASONS.daemonDown(), readiness.state === 'daemonDown' || readiness.state === 'loggedOut' || readiness.state === 'stopped');
      }
      return 'answered';
    }
    const record = this.rule;
    const result = await this.cli(['serve', 'status', '--json']);
    if (run.signal.aborted || this.state !== 'active') return 'answered';
    if (result.unanswered) return 'unknown';
    let config: ServeConfigJson | null = null;
    try {
      const json = result.ok ? (JSON.parse(result.stdout) as unknown) : null;
      config = json && typeof json === 'object' ? (json as ServeConfigJson) : null;
    } catch {
      config = null;
    }
    if (!config) {
      // No Serve config at all is the CLI failing to reach tailscaled, the one case that is the daemon's
      if (++this.misses >= this.timing.maxMisses) this.giveUp(REASONS.daemonDown());
      return 'answered';
    }
    // Tailscale answered: a rule that is not there, or not Claudio's, was removed or changed. What
    // is on disk does not decide it; the record is only how a crash is reconciled
    if (!record || servePortUse(config, record.port, readiness.host, record.target) !== 'match') {
      this.giveUp(REASONS.ruleRemoved());
      return 'answered';
    }
    this.misses = 0;
    // A record someone deleted while the rule stands is written again, so a crash can still be reconciled
    if (!existsSync(this.recordFile)) this.writeRecord(record);
    if (readiness.host !== this.lent) {
      // The node was renamed: the rule follows the node, and the old name stops answering
      this.withdraw();
      this.lend(readiness.host);
      this.rule = { ...record, host: readiness.host };
      this.writeRecord(this.rule);
      this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${readiness.host} joined the allowlist` });
      this.changed();
    }
    return 'answered';
  }

  /**
   * Closes the tunnel on an answer that says it cannot hold. With `recover`, a tunnel the person
   * opened is opened again once a later reading finds Tailscale ready. The rule is only taken away
   * if it still is Claudio's, and never because of an unknown.
   */
  private giveUp(why: Localized, recover = false): void {
    this.wanted = false;
    this.run.abort();
    this.stopMonitor();
    this.withdraw();
    this.fail(why);
    this.cleaning = this.removeOwnRule().catch(() => undefined);
    if (recover) this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    this.recovering = true;
    this.recoveryTimer = setTimeout(() => void this.tryRecovery(), this.timing.monitorMs);
    this.recoveryTimer.unref();
  }

  private cancelRecovery(): void {
    this.recovering = false;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private async tryRecovery(): Promise<void> {
    this.recoveryTimer = null;
    if (!this.recovering) return;
    const readiness = await this.probe().catch(() => null);
    if (!this.recovering) return;
    if (readiness?.state === 'ready') {
      this.cancelRecovery();
      try {
        await this.start('recovery');
      } catch {
        // Refused (authentication off, no port): it stays failed with its reason
      }
      return;
    }
    // An unknown or a Tailscale still down: wait for the next reading
    this.scheduleRecovery();
  }

  /** Takes the lent host back from the guard, and writes down that it left. */
  private withdraw(): void {
    if (!this.lent) return;
    this.deps.hosts.remove(this.lent);
    this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${this.lent} left the allowlist` });
    this.lent = null;
    this.since = null;
  }

  private fail(why: Localized): void {
    this.reason = why;
    this.set('failed');
  }

  private set(state: TunnelState): void {
    if (state === this.state && state !== 'failed') return;
    this.state = state;
    if (state === 'stopped') this.reason = null;
    this.changed();
  }

  private changed(): void {
    const tunnel = this.status();
    // The title stays generic: the address travels in `tunnel` only, never in a line that a
    // notification or a log could carry somewhere else
    this.deps.emit?.({ type: 'tunnel.changed', title: `Tunnel ${tunnel.state}`, tunnel });
  }
}
