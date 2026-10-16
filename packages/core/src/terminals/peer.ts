import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { agentRunProcesses, claudioChildren, descendantsOf, processTable, type ProcessEntry } from '../processes.ts';

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

/** Whether a process has ended and only waits to be reaped: it holds no descriptors, and the kernel refuses to list them (EACCES) */
function finished(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    // The state follows the command name, which may itself contain spaces and parentheses
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === 'Z' || state === 'X';
  } catch {
    return true;
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

  check(peer: PeerSocket): PeerVerdict {
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
    if (!readable || !inode) return 'unknown';
    const { pids, complete } = this.chatTree();
    const wanted = `socket:[${inode}]`;
    let sealed = complete;
    for (const pid of pids) {
      let names: string[];
      try {
        names = readdirSync(`/proc/${String(pid)}/fd`);
      } catch (error) {
        // Gone since the table was read is fine, and so is a zombie; a directory this user may not read is not
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH' && !finished(pid)) sealed = false;
        continue;
      }
      for (const name of names) {
        try {
          if (readlinkSync(`/proc/${String(pid)}/fd/${name}`) === wanted) return 'agent';
        } catch {
          // closed while looking
        }
      }
    }
    return sealed ? 'not-agent' : 'unknown';
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
