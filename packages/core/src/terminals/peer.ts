import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { AGENT_RUN_ENV } from '../processes.ts';

/** `agent`: the connection belongs to a chat's process or one of its descendants. `unknown` is not "not an agent". */
export type PeerVerdict = 'agent' | 'not-agent' | 'unknown';

export interface PeerSocket {
  /** The client's address as the server's socket reports it (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) */
  address: string;
  /** The client's port, which is the local port of the client's own socket */
  port: number;
  /** The port the server accepted it on */
  serverPort: number;
}

/** How `/proc` is read: the processes, one's descriptors, its `stat` line and its environment. A test gives its own. */
export interface ProcReader {
  pids(): number[];
  fds(pid: number): string[];
  link(pid: number, fd: string): string;
  stat(pid: number): string;
  environ(pid: number): string;
}

const procReader: ProcReader = {
  pids: () => readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number),
  fds: (pid) => readdirSync(`/proc/${String(pid)}/fd`),
  link: (pid, fd) => readlinkSync(`/proc/${String(pid)}/fd/${fd}`),
  stat: (pid) => readFileSync(`/proc/${String(pid)}/stat`, 'utf8'),
  environ: (pid) => readFileSync(`/proc/${String(pid)}/environ`, 'utf8'),
};

/** The variables that mark a process as a chat's, or as one Claudio started to run an agent's code */
const AGENT_MARKS = ['CLAUDIO_CHAT_ID=', `${AGENT_RUN_ENV}=`];
/** A bound on the ancestry walk, against a `stat` that reads a cycle */
const MAX_DEPTH = 512;

/**
 * The inodes of the client's socket: the row whose local port is the client's and whose remote port
 * is the server's. Both tables are read whatever the address says, since a dual-stack listener sees
 * an IPv4 client as `::ffff:…` and that socket is in `tcp`, not `tcp6`. `null` when neither table can
 * be read at all.
 */
function socketInodes(local: number, remote: number): Set<string> | null {
  const found = new Set<string>();
  let readable = false;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
      readable = true;
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const localPort = Number.parseInt(fields[1]?.split(':')[1] ?? '', 16);
      const remotePort = Number.parseInt(fields[2]?.split(':')[1] ?? '', 16);
      const inode = fields[9];
      if (localPort === local && remotePort === remote && inode && inode !== '0') found.add(inode);
    }
  }
  return readable ? found : null;
}

/**
 * Which process opened a loopback connection, as far as it matters: whether it is a chat's, or one
 * Claudio started on an agent's behalf (`CLAUDIO_AGENT_RUN`). Under `mode: none` an agent that calls
 * the API with no token looks exactly like the person's browser, and this is the one thing that tells
 * them apart (docs/plans/terminal.md, §3.5). Linux only.
 *
 * It finds the client's socket inode in `/proc/net/tcp{,6}`, the processes that hold it among every
 * `/proc/<pid>/fd`, and walks each holder's ancestry for an agent's mark in the environment. `not-agent`
 * is only ever said of a holder that was found and walked; a socket or holder that cannot be found is
 * `unknown`, and the gate refuses that under `mode: none`.
 *
 * It used to scan only the descriptors of the chats' trees, from a table of chat processes cached
 * for a second, to save the 20 to 40 ms of a full scan. A process an agent started after that table
 * was read (every `curl` from a Bash tool) was in no tree, and "not in a tree" was answered as "not
 * an agent": in a burst, about four requests in five got through. Finding the holder itself costs the
 * same as rebuilding that table, and it answers the question that was asked.
 */
export class PeerCheck {
  constructor(private readonly proc: ProcReader = procReader) {}

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

  /** The answer for a connection, as every gate awaits it */
  async verdict(peer: PeerSocket): Promise<PeerVerdict> {
    return this.check(peer);
  }

  /** One look, synchronous and as fast as reading /proc */
  check(peer: PeerSocket): PeerVerdict {
    const inodes = socketInodes(peer.port, peer.serverPort);
    if (!inodes || inodes.size === 0) return 'unknown';
    const holders = this.holders(new Set([...inodes].map((inode) => `socket:[${inode}]`)));
    if (holders.length === 0) return 'unknown';
    const walks = holders.map((pid) => this.fromAgent(pid));
    if (walks.includes('agent')) return 'agent';
    return walks.includes('unknown') ? 'unknown' : 'not-agent';
  }

  /** Every process holding one of the sockets: a descriptor inherited across a fork is held by both */
  private holders(wanted: Set<string>): number[] {
    let pids: number[];
    try {
      pids = this.proc.pids();
    } catch {
      return [];
    }
    const found: number[] = [];
    for (const pid of pids) {
      let names: string[];
      try {
        names = this.proc.fds(pid);
      } catch {
        // Gone, a zombie, or another user's: none of them is a holder this check could name
        continue;
      }
      for (const name of names) {
        try {
          if (wanted.has(this.proc.link(pid, name))) {
            found.push(pid);
            break;
          }
        } catch {
          // closed while looking
        }
      }
    }
    return found;
  }

  /**
   * Whether the process or one of its ancestors carries an agent's mark. The walk stops at this
   * server: the chats and verification commands it starts carry the mark below it, and what started
   * the server (a developer's shell, or an agent's when it runs its own dev server) does not make the
   * person's terminal shell an agent's. An ancestor whose environment cannot be read (another user's,
   * such as a display manager) carries no mark of ours.
   *
   * A chain that cannot be walked to its end is `unknown`, never clean: a process that exited
   * mid-walk, or an ancestor that has ended and waits to be reaped (a zombie's environment reads
   * empty, so a chat's CLI that just ended would hide the curl it left behind).
   */
  private fromAgent(holder: number): PeerVerdict {
    let pid = holder;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (pid <= 1 || pid === process.pid) return 'not-agent';
      let fields: string[];
      try {
        const stat = this.proc.stat(pid);
        // The command name sits in parentheses and may hold either itself: the state and the ppid follow the last one
        fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      } catch {
        return 'unknown';
      }
      if (fields[0] === 'Z' || fields[0] === 'X') return 'unknown';
      try {
        const environ = this.proc.environ(pid).split('\0');
        if (environ.some((entry) => AGENT_MARKS.some((mark) => entry.startsWith(mark)))) return 'agent';
      } catch (error) {
        // Not ours to read is no mark of ours; gone since the stat line is a walk that did not finish
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESRCH') return 'unknown';
      }
      const parent = Number(fields[1]);
      if (!Number.isInteger(parent) || parent === pid) return 'unknown';
      pid = parent;
    }
    return 'unknown';
  }
}
