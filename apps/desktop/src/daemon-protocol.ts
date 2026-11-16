// What the desktop window and its daemon agree on (layer 1 of docs/plans/survive-restarts.md): the
// record the daemon leaves in the data directory so a window can find it, and the newline-delimited
// JSON both speak over its Unix socket. Free of Electron, so both sides and their tests share it.
// Versioned from the first day: a window that speaks another protocol replaces the daemon instead of
// guessing what it understands.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bumped whenever a message or the record changes shape; a mismatch makes the window replace the daemon */
export const DAEMON_PROTOCOL = 1;
/** In `<dataDir>`, mode 0600: how a window finds the daemon and the credential it reads the server with */
export const DAEMON_RECORD = 'daemon.json';
export const DAEMON_SOCKET = 'daemon.sock';
/** The argument that turns the desktop binary into the daemon (the AppImage, whose files live in its own mount) */
export const DAEMON_FLAG = '--claudio-daemon';
/** Asked of the server over its IPC channel: close, and stop the parked work instead of letting it go */
export const STOP_WORK_MESSAGE = { type: 'claudio:stop-work' } as const;
export const STOP_WORK_ACK = 'claudio:stopping-work';

/**
 * The transient user unit's name. One per data directory, as the data-dir lock allows one server per
 * directory, so the dev build and the installed app never share a unit.
 */
export function daemonUnitName(dataDir: string): string {
  return `claudio-daemon-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}.service`;
}

export interface DaemonRecord {
  protocol: number;
  pid: number;
  /** Clock ticks after boot when the daemon started (`/proc/<pid>/stat`): with the pid, it is the same process */
  started: number;
  /** The desktop version the daemon itself runs */
  version: string;
  /**
   * Whether the daemon re-reads the shell's files on every server start: true where they sit on a
   * stable path (`/opt/Claudio`, a checkout), so a newer shell installed underneath is what its next
   * server runs. False for the AppImage, whose files are in the daemon's own mount
   */
  followsShell: boolean;
  /** The user unit it runs in, or null under `setsid` */
  unit: string | null;
  socket: string;
  /** The server's URL while one listens */
  url: string | null;
  /** The desktop credential (`CLAUDIO_DESKTOP_TOKEN`), new for each daemon */
  token: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function parseDaemonRecord(raw: unknown): DaemonRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.protocol) || !isInt(r.pid) || typeof r.started !== 'number' || !isStr(r.version) || typeof r.followsShell !== 'boolean') return null;
  if (!isStr(r.socket) || !isStr(r.token) || (r.unit !== null && !isStr(r.unit)) || (r.url !== null && !isStr(r.url))) return null;
  return { protocol: r.protocol, pid: r.pid, started: r.started, version: r.version, followsShell: r.followsShell, unit: r.unit, socket: r.socket, url: r.url, token: r.token };
}

export function readDaemonRecord(dataDir: string): DaemonRecord | null {
  try {
    return parseDaemonRecord(JSON.parse(readFileSync(join(dataDir, DAEMON_RECORD), 'utf8')));
  } catch {
    return null;
  }
}

/** Written whole and renamed into place, 0600 from the first byte: it holds a credential */
export function writeDaemonRecord(dataDir: string, record: DaemonRecord): void {
  const file = join(dataDir, DAEMON_RECORD);
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Removed by the daemon that wrote it, so a later one's record is never taken away */
export function removeDaemonRecord(dataDir: string, pid: number): void {
  if (readDaemonRecord(dataDir)?.pid !== pid) return;
  rmSync(join(dataDir, DAEMON_RECORD), { force: true });
}

/** The start time of a running process, or null when there is none with that pid */
export function processStarted(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    // The command name is in parentheses and may hold anything, so fields are read after the last one
    const started = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(started) ? started : null;
  } catch {
    return null;
  }
}

/** The record's daemon still runs: same pid, same start time */
export const recordAlive = (record: DaemonRecord, started: (pid: number) => number | null = processStarted): boolean => started(record.pid) === record.started;

/** What the window hands the daemon on its first hello: the daemon starts no server before it has them */
export interface LaunchFacts {
  /** The window's environment, the base of the server's; the secrets below never travel in it */
  env: Record<string, string>;
  /** The PATH of the person's login shell, resolved once by the window */
  PATH: string;
  /** The keyring's key for the server's secret files; only Electron's `safeStorage` can open it */
  secretKey: string | null;
  userData: string;
  dataDir: string;
  workspaceDir: string;
  logsDir: string;
  bundledDir: string;
  bundledWeb: string;
  guardEntry: string;
  keysDir: string;
  shellJson: string;
  version: string;
  distribution: string | null;
  aptManaged: boolean;
  /** `CLAUDIO_PAYLOAD=bundled`: the person's recovery for one launch */
  ignoreOverlays: boolean;
}

export type DaemonPhase =
  /** Started, and waiting for a window to hand it what a server needs */
  | 'waiting'
  | 'starting'
  | 'ready'
  /** The server went down on its own and is started again after a pause */
  | 'restarting'
  /** The server could not start, or kept failing: a window shows why and offers to try again */
  | 'failed'
  | 'stopping';

export interface DaemonBoot {
  version: string;
  bundled: boolean;
  trial: boolean;
}

export interface DaemonState {
  protocol: number;
  version: string;
  followsShell: boolean;
  phase: DaemonPhase;
  url: string | null;
  token: string;
  boot: DaemonBoot | null;
  /** Why it failed or is restarting, and the server log's last words */
  detail: string | null;
  /** The server log, shown by the window's error page */
  serverLog: string | null;
}

export type ToDaemon =
  | { type: 'hello'; protocol: number; version: string; launch: LaunchFacts }
  /** The window started loading the server's page; a trial waits for it to render */
  | { type: 'window-loading' }
  | { type: 'page-ready' }
  | { type: 'restart-server' }
  /** Forget every overlay and start the bundled payload */
  | { type: 'use-bundled' }
  /**
   * The daemon ends. `stop-work`: every chat stops with it (the person chose it, or nothing was live).
   * `detach`: the server closes as on any restart, parked work runs on for the next one (a hand-over)
   */
  | { type: 'stop'; work: 'stop-work' | 'detach' };

export type FromDaemon = { type: 'state'; state: DaemonState } | { type: 'relaunch-window' } | { type: 'stopped' };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function parseLaunch(v: unknown): LaunchFacts | null {
  const r = obj(v);
  if (!r) return null;
  const env = obj(r.env);
  const strings = ['PATH', 'userData', 'dataDir', 'workspaceDir', 'logsDir', 'bundledDir', 'bundledWeb', 'guardEntry', 'keysDir', 'shellJson', 'version'] as const;
  if (!env || strings.some((k) => !isStr(r[k]))) return null;
  if ((r.secretKey !== null && !isStr(r.secretKey)) || (r.distribution !== null && !isStr(r.distribution))) return null;
  if (typeof r.aptManaged !== 'boolean' || typeof r.ignoreOverlays !== 'boolean') return null;
  const cleanEnv: Record<string, string> = {};
  for (const [k, value] of Object.entries(env)) if (typeof value === 'string') cleanEnv[k] = value;
  return {
    env: cleanEnv,
    PATH: r.PATH as string,
    secretKey: r.secretKey as string | null,
    userData: r.userData as string,
    dataDir: r.dataDir as string,
    workspaceDir: r.workspaceDir as string,
    logsDir: r.logsDir as string,
    bundledDir: r.bundledDir as string,
    bundledWeb: r.bundledWeb as string,
    guardEntry: r.guardEntry as string,
    keysDir: r.keysDir as string,
    shellJson: r.shellJson as string,
    version: r.version as string,
    distribution: r.distribution as string | null,
    aptManaged: r.aptManaged,
    ignoreOverlays: r.ignoreOverlays,
  };
}

/** A line from a window, checked rather than trusted: anything else is null and ignored */
export function parseToDaemon(line: string): ToDaemon | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = obj(raw);
  if (!r) return null;
  switch (r.type) {
    case 'hello': {
      const launch = parseLaunch(r.launch);
      return isInt(r.protocol) && isStr(r.version) && launch ? { type: 'hello', protocol: r.protocol, version: r.version, launch } : null;
    }
    case 'window-loading':
    case 'page-ready':
    case 'restart-server':
    case 'use-bundled':
      return { type: r.type };
    case 'stop':
      return r.work === 'stop-work' || r.work === 'detach' ? { type: 'stop', work: r.work } : null;
    default:
      return null;
  }
}

const PHASES: readonly DaemonPhase[] = ['waiting', 'starting', 'ready', 'restarting', 'failed', 'stopping'];

function parseState(v: unknown): DaemonState | null {
  const r = obj(v);
  if (!r) return null;
  if (!isInt(r.protocol) || !isStr(r.version) || typeof r.followsShell !== 'boolean' || !PHASES.includes(r.phase as DaemonPhase) || !isStr(r.token)) return null;
  const b = obj(r.boot);
  const boot = b && isStr(b.version) && typeof b.bundled === 'boolean' && typeof b.trial === 'boolean' ? { version: b.version, bundled: b.bundled, trial: b.trial } : null;
  const s = (x: unknown) => (typeof x === 'string' ? x : null);
  return { protocol: r.protocol, version: r.version, followsShell: r.followsShell, phase: r.phase as DaemonPhase, url: s(r.url), token: r.token, boot, detail: s(r.detail), serverLog: s(r.serverLog) };
}

/** A line from the daemon, checked the same way: a daemon of another version may say more */
export function parseFromDaemon(line: string): FromDaemon | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = obj(raw);
  if (!r) return null;
  if (r.type === 'relaunch-window' || r.type === 'stopped') return { type: r.type };
  if (r.type === 'state') {
    const state = parseState(r.state);
    return state ? { type: 'state', state } : null;
  }
  return null;
}

/** Splits a byte stream into lines; a line longer than `max` is dropped rather than buffered for ever */
export function lineReader(onLine: (line: string) => void, max = 1024 * 1024): (chunk: Buffer | string) => void {
  let buffered = '';
  return (chunk) => {
    buffered += chunk.toString();
    for (;;) {
      const at = buffered.indexOf('\n');
      if (at === -1) break;
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (line) onLine(line);
    }
    if (buffered.length > max) buffered = '';
  };
}
