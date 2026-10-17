import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { agentRunProcesses, claudioChildren, descendantsOf, processTable, type ProcessEntry } from '../processes.ts';

/** `agent`: the connection belongs to a chat's process or one of its descendants. `unknown` is not "not an agent". */
export type PeerVerdict = 'agent' | 'not-agent' | 'unknown';
/** One synchronous look: a verdict, or `exiting` when a process caught exiting stood in the way, which a look a moment later may settle */
export type PeerLook = PeerVerdict | 'exiting';

export interface PeerSocket {
  /** The client's address as the server's socket reports it (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) */
  address: string;
  /** The client's port, which is the local port of the client's own socket */
  port: number;
  /** The port the server accepted it on */
  serverPort: number;
}

/** How long the table of chat processes is trusted: building it reads a file per process */
const CHATS_TTL_MS = 1000;

/** The inode of the socket whose local port is `local` and remote port `remote`, in one of the kernel's tcp tables */
function inodeOf(table: string, local: number, remote: number): string | null {
  let text: string;
  try {
    text = readFileSync(table, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const localPort = Number.parseInt(fields[1]?.split(':')[1] ?? '', 16);
    const remotePort = Number.parseInt(fields[2]?.split(':')[1] ?? '', 16);
    const inode = fields[9];
    if (localPort === local && remotePort === remote && inode && inode !== '0') return inode;
  }
  return null;
}

/** How `/proc` is read for one process: the names in its descriptor directory, and its `stat` line. A test gives its own. */
export interface ProcReader {
  fds(pid: number): string[];
  link(pid: number, fd: string): string;
  stat(pid: number): string;
}

const procReader: ProcReader = {
  fds: (pid) => readdirSync(`/proc/${String(pid)}/fd`),
  link: (pid, fd) => readlinkSync(`/proc/${String(pid)}/fd/${fd}`),
  stat: (pid) => readFileSync(`/proc/${String(pid)}/stat`, 'utf8'),
};

/** The kernel's flag for a task inside `do_exit`, in the ninth field of its `stat` line */
const PF_EXITING = 0x4;
/**
 * How many looks `verdict` makes while a process caught exiting is to blame, before it answers
 * unknown. Counted, not timed: on a loaded machine one look (the process table and every chat's
 * descriptors) took over 500 ms on its own, and a budget of time was spent before a second look was
 * ever made, so the person was refused for a process that finished a moment later.
 */
const SETTLE_LOOKS = 25;
/** Between two looks: a process's exit takes milliseconds, and each look reads /proc again */
const SETTLE_STEP_MS = 20;

/** The fields of a `stat` line after the command name, which may itself contain spaces and parentheses */
const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(')') + 2).split(' ');

/** Whether a process has ended and only waits to be reaped: it holds no descriptors, and the kernel refuses to list them (EACCES) */
function finished(proc: ProcReader, pid: number): boolean {
  try {
    const state = statFields(proc.stat(pid))[0];
    return state === 'Z' || state === 'X';
  } catch {
    return true;
  }
}

/**
 * Whether a process is on its way out: between the start of its exit and becoming a zombie, the
 * kernel already refuses to list its descriptors (EACCES) while its state still reads running. That
 * lasts milliseconds, and it is the one refusal that clears up on its own.
 */
function exiting(proc: ProcReader, pid: number): boolean {
  try {
    return (Number(statFields(proc.stat(pid))[6]) & PF_EXITING) !== 0;
  } catch {
    return false;
  }
}


/**
 * Which process opened a loopback connection, as far as it matters: whether it is a chat's, or one
 * Claudio started on an agent's behalf (`CLAUDIO_AGENT_RUN`). Under
 * `mode: none` an agent that calls the API with no token looks exactly like the person's browser,
 * and this is the one thing that tells them apart (docs/plans/terminal.md, §3.5). Linux only.
 *
 * It finds the client's socket inode in `/proc/net/tcp{,6}` and looks for it among the descriptors of
 * the chats' processes and their descendants only: scanning every process costs 30 to 40 ms on a
 * desktop, and a holder outside those trees is not an agent either way. Where something cannot be
 * read the answer is `unknown`, and the gate decides what to do with it.
 */
export class PeerCheck {
  private chats: { at: number; pids: number[]; complete: boolean } | null = null;

  /** Where the chats' processes come from: the table of processes, and the pids of the chats' CLIs in it. A test gives its own. */
  constructor(
    private readonly sources: { table(): ProcessEntry[]; chatPids(): number[] } = {
      table: processTable,
      // A verification command is not a chat's child, but it runs what an agent wrote (T8-2)
      chatPids: () => [...claudioChildren().map((chat) => chat.pid), ...agentRunProcesses()],
    },
    private readonly proc: ProcReader = procReader,
  ) {}

  /** Whether this machine lets the check work at all */
  available(): 'on' | 'unknown' {
    try {
      readdirSync('/proc/self/fd');
      readFileSync('/proc/net/tcp', 'utf8');
      return 'on';
    } catch {
      return 'unknown';
    }
  }

  /**
   * The answer for a connection. A process of a chat's tree caught exiting made it unknown, and under
   * `mode: none` the person's own browser was refused with it: on a machine whose agents start and
   * end processes all the time, 1 to 3 requests in 100 were. Once it has finished it holds nothing,
   * so the look is made again from the start, the socket's inode included: a process that exited
   * holding the client's socket took the socket with it, and that answer stays unknown. The looks
   * are spaced by timers, never a blocking wait, so the server goes on serving everyone else.
   */
  async verdict(peer: PeerSocket): Promise<PeerVerdict> {
    for (let looks = 1; ; looks++) {
      const look = this.check(peer);
      if (look !== 'exiting') return look;
      if (looks >= SETTLE_LOOKS) return 'unknown';
      await delay(SETTLE_STEP_MS);
    }
  }

  /** One look, synchronous and as fast as reading /proc: `exiting` asks the caller to look again shortly, through `verdict` */
  check(peer: PeerSocket): PeerLook {
    const look = this.inspect(peer);
    return look.verdict === 'unknown' && look.exiting.length > 0 ? 'exiting' : look.verdict;
  }

  /** One look: the verdict, and the processes whose descriptors could not be read because they were exiting */
  private inspect(peer: PeerSocket): { verdict: PeerVerdict; exiting: number[] } {
    // A v4-mapped peer is an IPv4 socket: it is in tcp, not tcp6
    const v6 = peer.address.includes(':') && !peer.address.toLowerCase().startsWith('::ffff:');
    const tables = v6 ? ['/proc/net/tcp6'] : ['/proc/net/tcp'];
    let inode: string | null = null;
    let readable = false;
    for (const table of tables) {
      try {
        readFileSync(table, 'utf8');
        readable = true;
      } catch {
        continue;
      }
      inode = inodeOf(table, peer.port, peer.serverPort);
      if (inode) break;
    }
    if (!readable || !inode) return { verdict: 'unknown', exiting: [] };
    const { pids, complete } = this.chatTree();
    const wanted = `socket:[${inode}]`;
    let sealed = complete;
    const leaving: number[] = [];
    for (const pid of pids) {
      let names: string[];
      try {
        names = this.proc.fds(pid);
      } catch (error) {
        // Gone since the table was read is fine, and so is a zombie; a directory this user may not read is not
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ESRCH' && !finished(this.proc, pid)) {
          sealed = false;
          if (exiting(this.proc, pid)) leaving.push(pid);
        }
        continue;
      }
      for (const name of names) {
        try {
          if (this.proc.link(pid, name) === wanted) return { verdict: 'agent', exiting: [] };
        } catch {
          // closed while looking
        }
      }
    }
    return { verdict: sealed ? 'not-agent' : 'unknown', exiting: leaving };
  }

  /** The chats' CLI processes and everything below them, from `CLAUDIO_CHAT_ID` in their environment */
  private chatTree(): { pids: number[]; complete: boolean } {
    const now = Date.now();
    if (this.chats && now - this.chats.at < CHATS_TTL_MS) return this.chats;
    const table = this.sources.table();
    const pids = new Set<number>();
    for (const root of this.sources.chatPids()) {
      pids.add(root);
      for (const entry of descendantsOf(table, root)) pids.add(entry.pid);
    }
    // An empty table means /proc could not be listed: nothing was ruled out
    this.chats = { at: now, pids: [...pids], complete: table.length > 0 };
    return this.chats;
  }
}
