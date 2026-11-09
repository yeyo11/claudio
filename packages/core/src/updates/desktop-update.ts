import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  DesktopUpdateReasonCode,
  DesktopUpdateRefusalCode,
  DesktopUpdateState,
  DesktopUpdateStatus,
  LiveWork,
  RestartRequest,
  RestartResult,
} from '@claudio/shared';
import type { EventBus } from '../events.ts';
import { RELAUNCH_EXIT_CODE, RESTART_EXIT_CODE, VERSION } from '../launcher/protocol.ts';
import { liveWorkBusy, shellFromEnv } from './server-update.ts';

/** The root oneshot unit the `.deb` ships (docs/plans/remote-updates.md, D1) */
export const UPDATE_UNIT = 'claudio-update.service';
/** What the unit writes as it ends: root-owned and world-readable, so this process only reads it */
export const UPDATE_STATUS_FILE = '/var/lib/claudio-update/status.json';

/** How often a started unit is looked at until it ends, and for how long at most */
const POLL_MS = 2_000;
const POLL_FOR_MS = 30 * 60_000;
/**
 * `--no-block` answers once the job is queued, so the unit may still read `inactive` for a moment.
 * A start not seen running yet counts as running for this long, unless its status file came first.
 */
const START_GRACE_MS = 15_000;
/** How often a restart that waits for idleness looks at what is live (the payload update's pace) */
const IDLE_CHECK_MS = 15_000;
/** Long enough for the answer to reach the person before the process goes */
const RELAUNCH_DELAY_MS = 250;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `systemctl` with these arguments as this process's user, never through a shell; tests hand in a fake */
export type SystemctlRunner = (args: readonly string[]) => Promise<CommandResult>;

export const systemctl: SystemctlRunner = (args) =>
  new Promise((resolve) => {
    // C locale, so polkit's and systemd's refusals read the same everywhere; no pager, no agent
    execFile('systemctl', [...args], { timeout: 15_000, env: { ...process.env, LC_ALL: 'C', SYSTEMD_PAGER: '' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** A refusal the routes answer as `{ error, code }` with its status; `live` goes with `update.live-work` */
export class DesktopUpdateRefusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: DesktopUpdateRefusalCode,
    message: string,
    readonly live?: LiveWork,
  ) {
    super(message);
  }
}

export interface DesktopUpdatesOptions {
  /** This server's version: what `running` says where no desktop shell does */
  version: string;
  env?: NodeJS.ProcessEnv;
  systemctl?: SystemctlRunner;
  /** A file's text, or null when it cannot be read */
  readFile?: (path: string) => string | null;
  statusFile?: string;
  liveWork: () => Promise<LiveWork>;
  /** What the server did by itself, as an audit row */
  audit: (row: { method: string; path: string; summary: string }) => void;
  events?: EventBus;
  now?: () => number;
  pollMs?: number;
  idleCheckMs?: number;
}

/** The unit as `systemctl show` describes it */
interface UnitFacts {
  loaded: boolean;
  active: string;
  /**
   * systemd's `Result` of the unit's last activation: `success`, or why it failed (`exit-code`,
   * `timeout`, `signal`, `start-limit-hit`, …); empty when systemd did not say
   */
  result: string;
  /** When its last run began, ms since the epoch */
  startedAt: number | null;
}

/** The unit's last outcome, as its status file says */
interface LastRun {
  from: string | null;
  to: string | null;
  result: 'installed' | 'up-to-date' | 'failed';
  startedAt: string | null;
  endedAt: string | null;
  code: DesktopUpdateReasonCode | null;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const versionOr = (value: unknown): string | null => (typeof value === 'string' && VERSION.test(value) ? value : null);
const dateOr = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

/** `@1731071234` (with `--timestamp=unix`) or a date systemd printed in its own words; null when unset */
function systemdTime(value: string | undefined): number | null {
  if (!value || value === 'n/a' || value === '0') return null;
  if (value.startsWith('@')) {
    const seconds = Number(value.slice(1));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The unit's status file, read defensively: the unit is another package's script and the file
 * could be half written. `result` is `installed`, `up-to-date` or `failed`; a `code` (with or
 * without its `update.` prefix) or the error text tells a busy package manager from a failed one.
 */
export function parseUnitStatus(text: string | null): LastRun | null {
  if (text === null) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const from = versionOr(raw.from);
  const to = versionOr(raw.to);
  const result = raw.result === 'installed' || raw.result === 'up-to-date' || raw.result === 'failed' ? raw.result : null;
  if (!result) return null;
  let code: DesktopUpdateReasonCode | null = null;
  if (result === 'failed') {
    const named = typeof raw.code === 'string' ? raw.code.replace(/^update\./, '') : '';
    const error = typeof raw.error === 'string' ? raw.error : '';
    // Only the codes the contract declares leave this function: anything else the script might
    // write reads as a failed apt, never as an undeclared code a client cannot word
    code = named === 'source-missing' ? 'update.source-missing' : named === 'apt-locked' || /lock/i.test(error) ? 'update.apt-locked' : 'update.apt-failed';
  }
  return { from, to, result, startedAt: dateOr(raw.startedAt), endedAt: dateOr(raw.endedAt), code };
}

/** What a failed `systemctl start` means: polkit said no, the unit is not installed, or something else */
export function startRefusal(res: CommandResult): 'needs-login' | 'unit-missing' | 'other' {
  const text = `${res.stderr}\n${res.stdout}`;
  // LSB codes systemctl uses: 4 insufficient privilege, 5 not installed
  if (res.code === 4 || /access denied|interactive authentication required|not authorized|authentication is required/i.test(text)) return 'needs-login';
  if (res.code === 5 || /not found|not loaded|no such file/i.test(text)) return 'unit-missing';
  return 'other';
}

/**
 * The desktop app's package update and its restart, from any device (docs/plans/remote-updates.md,
 * D3, D4). The server starts Claudio's root unit as the person's user with `systemctl`, which polkit
 * authorises for the members of `claudio-update` and for that unit's start alone; nothing here
 * escalates, asks for a password or passes an argument to root. Its state is read from `systemctl
 * show` and the status file the unit writes. A restart is the server exiting with 76, which the
 * desktop shell turns into a relaunch of the whole app, so the shell apt put on disk starts.
 */
export class DesktopUpdates {
  /** Set by the server: closes everything and exits with `code` */
  onRelaunch: (code: number) => Promise<void> | void = (code) => process.exit(code);
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: SystemctlRunner;
  private readonly read: (path: string) => string | null;
  private readonly statusFile: string;
  private readonly now: () => number;
  /** The start this process made, until the unit is seen to end it */
  private started: { at: number; seen: boolean } | null = null;
  /** Polkit refused the last start: the group is not in effect for this session yet */
  private refused = false;
  private poll: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private relaunching = false;
  private lastSent = '';

  constructor(private readonly o: DesktopUpdatesOptions) {
    this.env = o.env ?? process.env;
    this.run = o.systemctl ?? systemctl;
    this.read = o.readFile ?? readText;
    this.statusFile = o.statusFile ?? UPDATE_STATUS_FILE;
    this.now = o.now ?? Date.now;
  }

  private get shell() {
    return shellFromEnv(this.env);
  }

  /** Only a `.deb` under its desktop shell has the unit to start: elsewhere `systemctl` is never run */
  private get applicable(): boolean {
    return this.shell?.package === 'deb';
  }

  /** The shell version this process started under */
  private get running(): string {
    return this.shell?.version ?? this.o.version;
  }

  /**
   * The desktop app's version on disk now: apt replaces `<resources>/shell.json` with the package.
   * The shell names the file; an older shell only names its keys, which sit beside it.
   */
  private get installed(): string {
    if (!this.shell) return this.running;
    const keys = this.env.CLAUDIO_BUNDLE_KEYS_DIR;
    const file = this.env.CLAUDIO_SHELL_JSON || (keys ? join(dirname(keys), 'shell.json') : null);
    const text = file ? this.read(file) : null;
    if (text === null) return this.running;
    try {
      return versionOr((JSON.parse(text) as { version?: unknown } | null)?.version) ?? this.running;
    } catch {
      return this.running;
    }
  }

  /**
   * How a relaunch is asked of the host: 76 where the shell says it relaunches on it; 75 under an
   * older shell, which relaunches the app on it once it saw apt replace the package (and otherwise
   * starts the server again); null with no desktop shell at all.
   */
  private get relaunchCode(): number | null {
    if (this.env.CLAUDIO_LAUNCHER !== 'desktop') return null;
    return this.env.CLAUDIO_SHELL_RELAUNCH === '1' ? RELAUNCH_EXIT_CODE : RESTART_EXIT_CODE;
  }

  private async unit(): Promise<UnitFacts> {
    const res = await this.run(['show', UPDATE_UNIT, '--property=LoadState,ActiveState,Result,ExecMainStartTimestamp', '--timestamp=unix']);
    const props = new Map<string, string>();
    for (const line of res.stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    const load = props.get('LoadState');
    // `systemctl show` of an unknown unit still answers 0, with `LoadState=not-found`
    return {
      loaded: res.code === 0 && load === 'loaded',
      active: props.get('ActiveState') ?? 'inactive',
      result: props.get('Result') ?? '',
      startedAt: systemdTime(props.get('ExecMainStartTimestamp')),
    };
  }

  async status(): Promise<DesktopUpdateStatus> {
    const installed = this.installed;
    const running = this.running;
    const facts = { installed, running, restartNeeded: installed !== running };
    const blank = { from: null, to: null, startedAt: null, endedAt: null };
    if (!this.applicable) return { state: 'unavailable', ...facts, ...blank, reason: { code: 'update.unit-missing' } };
    const unit = await this.unit();
    if (!unit.loaded) return { state: 'unavailable', ...facts, ...blank, reason: { code: 'update.unit-missing' } };
    const last = parseUnitStatus(this.read(this.statusFile));
    const lastRun = last ? { from: last.from, to: last.to, startedAt: last.startedAt, endedAt: last.endedAt } : blank;
    // A oneshot is `activating` while its script runs; `active` would only be a unit that stays so
    // after it ended (`RemainAfterExit`), which is no run in progress
    const working = unit.active === 'activating' || unit.active === 'deactivating' || unit.active === 'reloading';
    if (working) {
      if (this.started) this.started.seen = true;
      return { state: 'installing', ...facts, from: null, to: null, startedAt: new Date(unit.startedAt ?? this.started?.at ?? this.now()).toISOString(), endedAt: null };
    }
    if (this.started) {
      const endedAfter = last?.endedAt ? Date.parse(last.endedAt) >= this.started.at : false;
      if (!this.started.seen && !endedAfter && this.now() - this.started.at < START_GRACE_MS) {
        return { state: 'installing', ...facts, from: null, to: null, startedAt: new Date(this.started.at).toISOString(), endedAt: null };
      }
      this.started = null;
    }
    if (this.refused) return { state: 'needs-login', ...facts, ...lastRun, reason: { code: 'update.needs-login' } };
    // StartLimitBurst refused the start: the helper never ran, so neither ExecMainStartTimestamp nor the
    // status file moved, and both still describe the run before it. Reading them would show that
    // run's outcome (often a green "up to date") for a start that did nothing
    if (unit.result === 'start-limit-hit') return { state: 'failed', ...facts, ...lastRun, reason: { code: 'update.start-limited' } };
    // systemd ended the run after its status file was last written (a timeout, a signal, the OOM
    // killer, the script dying early): the script never got to say why
    const fileAt = last?.endedAt ? Date.parse(last.endedAt) : null;
    const failedRun = unit.active === 'failed' || (unit.result !== '' && unit.result !== 'success');
    if (failedRun && (fileAt === null || (unit.startedAt !== null && unit.startedAt > fileAt))) {
      return { state: 'failed', ...facts, ...lastRun, reason: { code: 'update.unit-failed' } };
    }
    if (!last) return { state: 'idle', ...facts, ...blank };
    const state: DesktopUpdateState = last.result === 'failed' ? 'failed' : last.result === 'installed' && facts.restartNeeded ? 'installed' : 'up-to-date';
    return { state, ...facts, ...lastRun, ...(last.code ? { reason: { code: last.code } } : {}) };
  }

  /** Starts the unit (D3); answers once systemd queued it, and the feed follows it to its end */
  async start(): Promise<DesktopUpdateStatus> {
    if (!this.applicable) throw new DesktopUpdateRefusal(412, 'update.unit-missing', 'only the desktop app installed from its .deb package updates itself this way');
    const before = await this.status();
    if (before.state === 'unavailable') throw new DesktopUpdateRefusal(412, 'update.unit-missing', `${UPDATE_UNIT} is not installed; this package is older than the update unit`);
    if (before.state === 'installing') throw new DesktopUpdateRefusal(409, 'update.busy', 'the desktop app is being updated already');
    // `--no-ask-password`: a refusal is an answer, never a password prompt on some terminal
    const res = await this.run(['start', '--no-block', '--no-ask-password', UPDATE_UNIT]);
    if (res.code !== 0) {
      const why = startRefusal(res);
      if (why === 'needs-login') {
        this.refused = true;
        await this.changed();
        throw new DesktopUpdateRefusal(403, 'update.needs-login', 'the system refused to start the update: sign out and back in so the claudio-update group applies');
      }
      if (why === 'unit-missing') throw new DesktopUpdateRefusal(412, 'update.unit-missing', `${UPDATE_UNIT} is not installed`);
      throw new DesktopUpdateRefusal(500, 'update.start-failed', `systemctl could not start ${UPDATE_UNIT}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    }
    this.refused = false;
    this.started = { at: this.now(), seen: false };
    this.watch();
    return this.changed();
  }

  /** Looks at the unit until it ends, sending each change on the feed */
  private watch(): void {
    this.stopPoll();
    const until = this.now() + POLL_FOR_MS;
    this.poll = setInterval(() => {
      void this.changed().then(
        (status) => {
          if (status.state !== 'installing' || this.now() > until) this.stopPoll();
        },
        () => this.stopPoll(),
      );
    }, this.o.pollMs ?? POLL_MS);
    this.poll.unref();
  }

  /** The status now, sent on the feed when it differs from the last one sent */
  private async changed(): Promise<DesktopUpdateStatus> {
    const status = await this.status();
    const key = JSON.stringify(status);
    if (key !== this.lastSent) {
      this.lastSent = key;
      this.o.events?.emit({ type: 'desktop-update.changed', title: `Desktop app update: ${status.state}`, status });
    }
    return status;
  }

  /**
   * Restarts the whole desktop app (D4), only because a person asked: over live work it answers
   * `409 update.live-work` unless `whenIdle`, which waits until nothing is live. `412 update.no-shell`
   * when no desktop shell runs this server: there is no app to start again.
   */
  async restart(request: RestartRequest = {}): Promise<RestartResult> {
    const code = this.relaunchCode;
    if (code === null) throw new DesktopUpdateRefusal(412, 'update.no-shell', 'no desktop app runs this server, so there is no app to restart');
    if (this.relaunching) return { scheduled: 'now' };
    const live = await this.o.liveWork();
    if (liveWorkBusy(live)) {
      if (!request.whenIdle) throw new DesktopUpdateRefusal(409, 'update.live-work', 'chats, orchestrations or terminals are running; a restart would stop them', live);
      this.relaunchWhenIdle(code);
      return { scheduled: 'when-idle' };
    }
    this.relaunchNow(code, false);
    return { scheduled: 'now' };
  }

  private relaunchWhenIdle(code: number): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.o.liveWork().then((live) => {
        if (!liveWorkBusy(live)) this.relaunchNow(code, true);
      }, () => undefined);
    }, this.o.idleCheckMs ?? IDLE_CHECK_MS);
    this.idleTimer.unref();
  }

  private relaunchNow(code: number, waited: boolean): void {
    if (this.relaunching) return;
    this.relaunching = true;
    this.stopIdle();
    // The route's own row covers a restart made at once; one that waited happens later, by itself
    if (waited) this.o.audit({ method: 'POST', path: '/api/system/restart', summary: 'restarting the desktop app now that nothing is running' });
    setTimeout(() => void this.onRelaunch(code), RELAUNCH_DELAY_MS).unref();
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private stopIdle(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  close(): void {
    this.stopPoll();
    this.stopIdle();
  }
}
