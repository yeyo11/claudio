import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

/*
 * One Claudio server per data directory. Two servers on one directory each believe the stores, the
 * tunnel record and the chats' processes are theirs: on 2026-10-18 a dev server started by an
 * agent with the desktop's CLAUDIO_DATA_DIR inherited took the desktop's live Serve rule for a
 * leftover and closed its tunnel (docs/security-model.md, "One server per data directory").
 *
 * Node 22 has no advisory file lock (`flock`) without a native module, so the lock is a file created
 * with O_EXCL that names its holder. A crashed holder leaves it behind; it is stale when that process
 * is gone, which is told by its pid and, on Linux, by the start time of the process that has that pid
 * now (a pid is reused) and by the boot it was written in.
 */

/** The lock's file, in the data directory itself */
export const DATA_DIR_LOCK_FILE = 'server.lock';

/** What the lock file holds */
export interface DataDirLockHolder {
  /** Unique to this acquisition: what the tunnel record carries to say it was written under the lock */
  id: string;
  pid: number;
  hostname: string;
  /** The process's start time in clock ticks since boot, from /proc; null where there is no /proc */
  started: number | null;
  /** /proc/sys/kernel/random/boot_id; null where there is none */
  boot: string | null;
  /** When it was taken */
  at: string;
}

export interface DataDirLock {
  readonly dir: string;
  readonly id: string;
  /** Removes the lock file, if it is still this lock's. Idempotent. */
  release(): void;
}

/** A live server holds the directory: nothing in it was read or written */
export class DataDirLockedError extends Error {
  readonly code = 'EDATADIRLOCKED';
  constructor(
    readonly dir: string,
    readonly holder: DataDirLockHolder | null,
  ) {
    const who = holder ? `pid ${String(holder.pid)}${holder.hostname === hostname() ? '' : ` on ${holder.hostname}`}, since ${holder.at}` : 'a server that is starting now';
    super(
      `Another Claudio server is using the data directory ${dir} (${who}). Two servers on one data directory overwrite each other's ` +
        'state, so this one stops here without touching it. Stop the other server, or start this one with its own CLAUDIO_DATA_DIR and PORT.',
    );
  }
}

/** What the lock needs from the machine; a test replaces it */
export interface LockProbe {
  pid: number;
  hostname: string;
  /** Whether a process with this pid exists (a process of another user counts) */
  alive(pid: number): boolean;
  /** The start time of the process with this pid, in clock ticks since boot; null when unknown */
  startTime(pid: number): number | null;
  boot(): string | null;
}

const procStartTime = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    // The command name may hold spaces and parentheses: the fields are counted from its closing one
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Field 22 of the line, the 20th after the name
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
};

const bootId = (): string | null => {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
};

export const SYSTEM_PROBE: LockProbe = {
  pid: process.pid,
  hostname: hostname(),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startTime: procStartTime,
  boot: bootId,
};

/** The directories this process holds, so a second server in the same process is refused too */
const heldHere = new Map<string, string>();

/** A lock file younger than this that cannot be read is a holder between creating and writing it */
const WRITING_MS = 2_000;

function readHolder(file: string): { raw: string; holder: DataDirLockHolder | null } | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DataDirLockHolder>;
    if (typeof parsed.id === 'string' && typeof parsed.pid === 'number' && typeof parsed.hostname === 'string') {
      return {
        raw,
        holder: {
          id: parsed.id,
          pid: parsed.pid,
          hostname: parsed.hostname,
          started: typeof parsed.started === 'number' ? parsed.started : null,
          boot: typeof parsed.boot === 'string' ? parsed.boot : null,
          at: typeof parsed.at === 'string' ? parsed.at : 'an unknown time',
        },
      };
    }
  } catch {
    // Unreadable: decided by its age below
  }
  return { raw, holder: null };
}

/**
 * Whether the holder still runs. A holder on another machine (a container recreated with the same
 * volume gets a new hostname) cannot be asked, and is taken for gone: refusing would keep that
 * container from ever starting again after a crash.
 */
function holderAlive(holder: DataDirLockHolder, probe: LockProbe): boolean {
  if (holder.hostname !== probe.hostname) return false;
  const boot = probe.boot();
  if (holder.boot && boot && holder.boot !== boot) return false;
  // This process did not write it (it would be in `heldHere`): a previous process that had this pid
  if (holder.pid === probe.pid) return false;
  if (!probe.alive(holder.pid)) return false;
  const started = probe.startTime(holder.pid);
  if (holder.started !== null && started !== null && holder.started !== started) return false;
  return true;
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Takes the lock of `dir`, before anything in it is read or written; throws `DataDirLockedError`
 * when a live server holds it. A stale lock is taken over under a second O_EXCL file, so two servers
 * starting at once on a crashed one's directory cannot both remove it and both win.
 */
export function acquireDataDirLock(dirInput: string, probe: LockProbe = SYSTEM_PROBE): DataDirLock {
  mkdirSync(dirInput, { recursive: true });
  const dir = realpathSync(resolve(dirInput));
  const file = join(dir, DATA_DIR_LOCK_FILE);
  const takeover = `${file}.takeover`;
  const here = heldHere.get(dir);
  if (here !== undefined) throw new DataDirLockedError(dir, readHolder(file)?.holder ?? null);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const holder: DataDirLockHolder = {
      id: randomBytes(12).toString('base64url'),
      pid: probe.pid,
      hostname: probe.hostname,
      started: probe.startTime(probe.pid),
      boot: probe.boot(),
      at: new Date().toISOString(),
    };
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(holder)}\n`);
      } finally {
        closeSync(fd);
      }
      return held(dir, file, holder.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const found = readHolder(file);
    // Gone between the two calls: try again
    if (!found) continue;
    if (found.holder ? holderAlive(found.holder, probe) : Date.now() - mtimeOf(file) < WRITING_MS) throw new DataDirLockedError(dir, found.holder);
    // Stale: removed under the takeover file, and only if it is still the one judged stale
    let fd: number;
    try {
      fd = openSync(takeover, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another server is taking it over; one that died doing so left a file that ages out
      if (Date.now() - mtimeOf(takeover) > WRITING_MS * 5) rmSync(takeover, { force: true });
      else sleep(50);
      continue;
    }
    try {
      if (readHolder(file)?.raw === found.raw) rmSync(file, { force: true });
    } finally {
      closeSync(fd);
      rmSync(takeover, { force: true });
    }
  }
  throw new DataDirLockedError(dir, readHolder(file)?.holder ?? null);
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function held(dir: string, file: string, id: string): DataDirLock {
  heldHere.set(dir, id);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    if (heldHere.get(dir) === id) heldHere.delete(dir);
    try {
      if (readHolder(file)?.holder?.id === id) rmSync(file, { force: true });
    } catch {
      // The process is going away; a lock left behind is found stale by the next server
    }
  };
  // Every way out but a crash passes through 'exit'; a crash leaves a lock the next start finds stale
  process.on('exit', release);
  return { dir, id, release };
}

/** The holder of `dir`'s lock as the file says, without judging whether it still runs */
export function readDataDirLock(dir: string): DataDirLockHolder | null {
  return readHolder(join(dir, DATA_DIR_LOCK_FILE))?.holder ?? null;
}
