import { readdirSync, readFileSync } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface CliProcess {
  pid: number;
  argv: string[];
}

/**
 * Whether a process is a CLI working on that session: stream-json on stdin, and the session on
 * `--resume` or `--session-id`. Matching on the arguments rather than the binary is what also finds
 * one a wrapper started as a child of its own, and a pid the system has since reused for something else
 * does not match. A `--fork-session` process reads the session it resumes but writes the copy named
 * by `--session-id`, so only the copy counts as the session it drives.
 */
export function drivesSession(argv: readonly string[], sessionId: string): boolean {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  if (flag('--input-format') !== 'stream-json') return false;
  if (argv.includes('--fork-session')) return flag('--session-id') === sessionId;
  return flag('--resume') === sessionId || flag('--session-id') === sessionId;
}

/**
 * Every process in the table that takes stream-json on stdin, read once so that matching many runs
 * against it costs one pass. Only Linux exposes argument vectors without spawning `ps`; elsewhere
 * nothing is found, and the wrapper behaves as it did before it looked.
 */
export function streamJsonProcesses(): CliProcess[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const found: CliProcess[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let argv: string[];
    try {
      // A zombie's is empty, and one that exited in between cannot be read: both are gone
      argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.includes('stream-json')) found.push({ pid: Number(name), argv });
  }
  return found;
}

/**
 * Processes of the same user that Claudio started, found by the `CLAUDIO_CHAT_ID` the manager puts
 * in every spawn's environment: the agents that speak a protocol on stdio carry no session id in
 * argv, so this is how a chat's process is told from a stranger's. Linux only; `[]` elsewhere, and
 * for a process whose environment cannot be read (another user's).
 */
export function claudioChildren(): Array<{ pid: number; chatId: string; argv: string[] }> {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const found: Array<{ pid: number; chatId: string; argv: string[] }> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const environ = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      const chatId = environ.find((entry) => entry.startsWith('CLAUDIO_CHAT_ID='))?.slice('CLAUDIO_CHAT_ID='.length);
      if (!chatId) continue;
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length > 0) found.push({ pid: Number(name), chatId, argv });
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

/**
 * Marks a process Claudio starts on an agent's behalf outside a chat's own process tree (today: an
 * orchestration's verification commands, which run code an agent just wrote). Its value is the id of
 * the work it runs for. The terminal's peer check treats such a process like a chat's, and the shell
 * environment drops it with every other `CLAUDIO_*` variable.
 */
export const AGENT_RUN_ENV = 'CLAUDIO_AGENT_RUN';

/** One CLI process as its own record says, the shape `claude agents --json` lists. */
export interface CliSessionRecord {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: string;
  state?: string;
}

/**
 * The CLI's processes, from the record each one writes for itself under `<configDir>/sessions/`
 * (`<pid>.json`: its session, folder, kind and status), each checked against `/proc`: a record is
 * kept only while its pid still runs the process that wrote it, the start time it recorded
 * (`procStart`) being the one the kernel has, in the same pid namespace (`pidDomain`). This is what
 * `claude agents --json` reads, without starting a CLI to read it. Null where it cannot be read this
 * way (no `/proc`, or a CLI that keeps no such folder): the caller asks the CLI instead.
 */
export async function cliSessionRecords(configDir: string): Promise<CliSessionRecord[] | null> {
  const dir = join(configDir, 'sessions');
  let names: string[];
  let domain: string | null;
  try {
    [names, domain] = await Promise.all([readdir(dir), pidDomain()]);
  } catch {
    return null;
  }
  if (domain === null) return null;
  const found = await Promise.all(
    names
      .filter((name) => /^\d+\.json$/.test(name))
      .map(async (name): Promise<CliSessionRecord | null> => {
        try {
          const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
          const pid = Number(record.pid);
          if (!Number.isInteger(pid) || pid <= 0 || typeof record.sessionId !== 'string') return null;
          // Written in another container or on another machine sharing the folder: not a pid of ours to check
          if (typeof record.pidDomain === 'string' && record.pidDomain !== domain) return null;
          const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
          const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
          // A pid the system reused since the CLI that wrote this exited without removing it
          if (record.procStart !== undefined && String(record.procStart) !== started) return null;
          return {
            pid,
            cwd: typeof record.cwd === 'string' ? record.cwd : '',
            kind: typeof record.kind === 'string' ? record.kind : 'unknown',
            startedAt: Number(record.startedAt ?? 0),
            sessionId: record.sessionId,
            name: typeof record.name === 'string' ? record.name : '',
            status: typeof record.status === 'string' ? record.status : 'unknown',
            ...(typeof record.state === 'string' ? { state: record.state } : {}),
          };
        } catch {
          // Gone between the listing and the read, half-written, or its process is not there any more
          return null;
        }
      }),
  );
  return found.filter((r): r is CliSessionRecord => r !== null);
}

/** This process's pid namespace as the CLI names it in `pidDomain`; null where `/proc` cannot say. */
async function pidDomain(): Promise<string | null> {
  try {
    const [machine, namespace] = await Promise.all([readFile('/etc/machine-id', 'utf8'), readlink('/proc/self/ns/pid')]);
    return `linux:${machine.trim()}:${namespace}`;
  } catch {
    return null;
  }
}

/** How long a read of the process table serves the lists: it is a file per process, and one request assembles many chats. */
const PROCESSES_TTL_MS = 1_000;
let recent: { at: number; value: CliProcess[] } | null = null;

/**
 * {@link streamJsonProcesses}, read at most once a second. For what is shown, not for deciding
 * whether a process may be started: that reads the table fresh.
 */
export function recentStreamJsonProcesses(): CliProcess[] {
  const now = Date.now();
  if (!recent || now - recent.at > PROCESSES_TTL_MS) recent = { at: now, value: streamJsonProcesses() };
  return recent.value;
}

/** Makes the next {@link recentStreamJsonProcesses} read the table: a process known to have come or gone. */
export function forgetStreamJsonProcesses(): void {
  recent = null;
}

// ---------- one command's process tree ----------

/** A process as the kernel lists it: what is needed to walk a tree and to know a pid is still the same process. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Clock ticks after boot when it started; with the pid it identifies a process for good, since a pid can be reused */
  started: number;
  argv: string[];
}

/**
 * The whole process table, with parents. `/proc/<pid>/stat` puts the command name in parentheses,
 * and the name may itself hold spaces and parentheses, so the fields are read after the last `)`.
 * Empty where `/proc` is not there: nothing can be walked, and callers say so instead of guessing.
 */
export function processTable(): ProcessEntry[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const table: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // After the name come the state, then the ppid, and starttime is the twentieth field
      const ppid = Number(fields[1]);
      const started = Number(fields[19]);
      if (!Number.isFinite(ppid) || !Number.isFinite(started)) continue;
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      table.push({ pid: Number(name), ppid, started, argv });
    } catch {
      // gone between listing and reading
    }
  }
  return table;
}

/** How long {@link recentProcessTable} serves one reading. Short: a chat's tree changes by the second. */
const PROCESS_TABLE_TTL_MS = 2_000;
let recentTable: { at: number; value: ProcessEntry[] } | null = null;

/**
 * {@link processTable}, read at most once every two seconds, for what is only shown (the usage of
 * each chat). It is a stat and a cmdline file per process on the machine, about 12 ms with 400 of
 * them, and several tabs polling it each paid that on the event loop. Never for a decision that
 * signals a process: stopping a tree and the escalation to SIGKILL read the table fresh, since a
 * stale one could name a pid that has since been reused.
 * `read` and `now` are the seams a test uses.
 */
export function recentProcessTable(read: () => ProcessEntry[] = processTable, now: number = Date.now()): ProcessEntry[] {
  if (!recentTable || now - recentTable.at > PROCESS_TABLE_TTL_MS || now < recentTable.at) recentTable = { at: now, value: read() };
  return recentTable.value;
}

/** Drops the cached table: the next {@link recentProcessTable} reads it again. */
export function forgetProcessTable(): void {
  recentTable = null;
}

/** One process from the table, or null when it is gone: for a caller that already knows the pid and must not scan them all. */
export function processEntry(pid: number): ProcessEntry | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    const started = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(started)) return null;
    const argv = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return { pid, ppid, started, argv };
  } catch {
    return null;
  }
}

/** Kernel clock ticks per second; 100 on every Linux Claudio runs on. */
const TICKS_PER_SECOND = 100;

/**
 * When a process started, as a wall-clock time. Null where the boot time is not known. The boot time
 * comes from the uptime, which has a hundredth of a second, and not from `btime` in `/proc/stat`,
 * which is whole seconds: that is a second of error, and a command is told apart from its
 * neighbour by less than that.
 *
 * `bootMs` lets a caller comparing several processes estimate the boot time once: each estimate
 * is off by however long the thread waited between reading the uptime and the clock, and siblings
 * each measured against their own could swap places on a busy machine.
 */
export function startedAtMs(entry: ProcessEntry, bootMs: number | null = bootTimeMs()): number | null {
  return bootMs === null ? null : bootMs + (entry.started / TICKS_PER_SECOND) * 1000;
}

/** When the machine booted, as a wall-clock time; null where it is not known. */
export function bootTimeMs(): number | null {
  try {
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return Number.isFinite(uptime) ? Date.now() - uptime * 1000 : null;
  } catch {
    return null;
  }
}

/** Every descendant of `root` (not `root` itself), children before their parents. */
export function descendantsOf(table: readonly ProcessEntry[], root: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  // Grown in place: copying a parent's list on every child made a table of a few thousand processes quadratic
  for (const entry of table) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const out: ProcessEntry[] = [];
  const seen = new Set([root]);
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      walk(child.pid);
      out.push(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The process of the CLI itself under the pid Claudio spawned, which is the same one unless a
 * wrapper started it as a child: found by what it drives, not by its name.
 */
export function cliProcessOf(table: readonly ProcessEntry[], spawned: number, sessionId: string): ProcessEntry | null {
  const own = table.find((p) => p.pid === spawned);
  if (!own) return null;
  return [own, ...descendantsOf(table, spawned)].find((p) => drivesSession(p.argv, sessionId)) ?? own;
}

/**
 * The roots of the commands a CLI is running. Each shell command the CLI runs is one child of the
 * CLI, started right after the call was made; the children it keeps for its whole life (MCP servers,
 * language servers) started before any command did. So the roots are the children that started at
 * or after the earliest open command, and the i-th oldest command owns the i-th oldest of them. It
 * is a claim about the process tree and the clock, never about a command line: what `pnpm e2e`
 * looks like in `ps` decides nothing.
 *
 * `openSince` is when each open command was called, oldest first. A command with no root of its own
 * (it has not spawned yet, or already ended) gets null, and `unclaimed` counts the children that
 * started in that window and belong to none of them: a caller that knows something else could have
 * started a child there (a background command) must not trust the assignment.
 */
export function commandRoots(
  table: readonly ProcessEntry[],
  cli: number,
  openSince: readonly number[],
  toleranceMs = 2000,
): { roots: Array<ProcessEntry | null>; unclaimed: number } {
  const earliest = openSince[0];
  if (earliest === undefined) return { roots: [], unclaimed: 0 };
  const boot = bootTimeMs();
  const children = table
    .filter((p) => p.ppid === cli)
    .map((entry) => ({ entry, at: startedAtMs(entry, boot) }))
    .filter((c): c is { entry: ProcessEntry; at: number } => c.at !== null && c.at >= earliest - toleranceMs)
    .sort((a, b) => a.at - b.at);
  const claimed = new Set<number>();
  const roots = openSince.map((since) => {
    const root = children.find((c) => !claimed.has(c.entry.pid) && c.at >= since - toleranceMs);
    if (!root) return null;
    claimed.add(root.entry.pid);
    return root.entry;
  });
  return { roots, unclaimed: children.length - claimed.size };
}

/**
 * Signals a process tree: the descendants first, so nothing is left to be adopted by init and
 * escape, then the root. What survives the grace period gets SIGKILL, but only if it is still the
 * same process (same pid, same start time): a pid the system has reused since is somebody else's.
 * Returns how many processes of the tree were ended, at once: the escalation runs on its own timer,
 * so the request that asked for the cancel does not wait for it. One that is gone by the time its
 * turn comes counts: a shell waiting on the child just signalled exits and is reaped by its parent
 * in between, and it ended with the tree all the same.
 */
export function terminateTree(root: ProcessEntry, table: readonly ProcessEntry[], graceMs = 2000): number {
  const victims = [...descendantsOf(table, root.pid), root];
  const signal = (entry: ProcessEntry, name: NodeJS.Signals): boolean => {
    try {
      process.kill(entry.pid, name);
      return true;
    } catch {
      return false; // gone already, or not ours to signal
    }
  };
  const ended = victims.filter((victim) => {
    try {
      process.kill(victim.pid, 'SIGTERM');
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }).length;
  setTimeout(() => {
    const now = processTable();
    for (const victim of victims) {
      if (now.some((p) => p.pid === victim.pid && p.started === victim.started)) signal(victim, 'SIGKILL');
    }
  }, graceMs).unref();
  return ended;
}

/**
 * Signals the process group a child spawned with `detached: true` leads, so that what it started
 * ends with it; the child alone when there is no group to signal.
 */
export function killGroup(child: { pid?: number | undefined; kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
