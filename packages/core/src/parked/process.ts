import { execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { constants } from 'node:os';
import { join } from 'node:path';
import type { ChatProcess, ChatProcessInput } from '../chat-process.ts';
import { descendantsOf, processEntry, processTable } from '../processes.ts';
import type { ProcessIdentity } from './store.ts';
import { FileTail } from './tail.ts';
import { PARKED_FILES } from './wrapper.ts';

/** What a parked process records about itself, in its row; the registry holds the store and the owner. */
export interface ParkedLedger {
  cli(id: string, cli: ProcessIdentity): void;
  turn(id: string, offset: number | null): void;
  commit(id: string, offset: number): void;
  stdinSeq(id: string, seq: number): void;
  /** The process is gone and read to the end: its row, files and scope go */
  ended(process: ParkedProcess): void;
  /** Hole punching failed on this filesystem: nobody tries again */
  cannotPunch(): void;
  readonly punches: boolean;
}

export interface ParkedProcessInit {
  id: string;
  dir: string;
  scope: string | null;
  /** The wrapper this server started. Absent for one adopted from a server before it, which is no child of this one */
  child?: ChildProcess;
  /** The wrapper of an adopted process, by pid and start time: its end is found by looking for it */
  wrapper?: ProcessIdentity;
  fifo: Socket;
  ledger: ParkedLedger;
  /** Where reading starts: the committed offset */
  from: number;
  /** The sequence number of the last line written to its stdin, by this server or the one before it */
  stdinSeq?: number;
  /** A turn is open on it, as its row says: its `turn` file is already there */
  turnOpen?: boolean;
  /** The CLI, as its row names it, checked alive by whoever adopts it */
  cli?: ProcessIdentity | null;
  /** How long the wait for the CLI after its wrapper died may take before the process counts as gone */
  cliGoneMs?: number;
  /** How often an adopted wrapper is looked for: there is no `exit` event for a process that is not our child */
  pollMs?: number;
}

/** Blocks are freed whole; the line cut by a hole's edge is below the committed offset anyway. */
const PUNCH_BLOCK = 4096;
/** How often the CLI is looked for after its wrapper was killed, until it is gone too */
const CLI_GONE_POLL_MS = 50;

const SIGNAL_NAMES = new Map<number, NodeJS.Signals>(Object.entries(constants.signals).map(([name, n]) => [n, name as NodeJS.Signals]));

/** The line written to `in.jsonl` for one line of input: its kind and its id, never its text. */
function inputRecord(seq: number, line: string): string {
  let type = 'unknown';
  let id: string | undefined;
  let subtype: string | undefined;
  try {
    const parsed = JSON.parse(line) as { type?: unknown; uuid?: unknown; request_id?: unknown; request?: { subtype?: unknown }; response?: { request_id?: unknown } };
    if (typeof parsed.type === 'string') type = parsed.type;
    const named = parsed.response?.request_id ?? parsed.request_id ?? parsed.uuid;
    if (typeof named === 'string') id = named;
    if (typeof parsed.request?.subtype === 'string') subtype = parsed.request.subtype;
  } catch {
    // Not JSON: recorded by its kind alone
  }
  return `${JSON.stringify({ seq, type, ...(subtype ? { subtype } : {}), ...(id ? { id } : {}) })}\n`;
}

/** The CLI's stdin, through the FIFO. Every line is also recorded, by kind and id, so a successor knows what was sent. */
class ParkedInput implements ChatProcessInput {
  writableEnded = false;
  /** Detached: this server writes nothing more, and the CLI's input stays open for the next one */
  private muted = false;

  constructor(
    private readonly socket: Socket,
    private readonly record: (seq: number, line: string) => void,
    private readonly ended: () => void,
    private seq = 0,
  ) {}

  write(text: string): boolean {
    if (this.muted) return false;
    for (const line of text.split('\n')) if (line.trim()) this.record(++this.seq, line);
    return this.socket.write(text);
  }

  mute(): void {
    this.muted = true;
    this.socket.destroy();
  }

  end(): void {
    if (this.writableEnded || this.muted) return;
    this.writableEnded = true;
    this.socket.end();
    this.ended();
  }

  on(event: 'error', listener: (err: Error) => void): this {
    this.socket.on(event, listener);
    return this;
  }
}

/**
 * A CLI running under the parked wrapper (`wrapper.ts`), seen from the server that holds it: its
 * stdin is a FIFO, its stdout and stderr are files this follows. It stands where a child on pipes
 * stood (`ChatProcess`), so the chat's code reads and writes it the same way; what differs is that
 * the CLI does not depend on this server to live.
 *
 * `pid` is the wrapper's, the process Claudio started: the CLI is its child, and a tree walked from
 * it holds the CLI and everything the CLI started (`cliProcessOf` finds the CLI in it).
 */
export class ParkedProcess extends EventEmitter implements ChatProcess {
  readonly id: string;
  readonly dir: string;
  readonly scope: string | null;
  readonly pid: number | undefined;
  readonly stdin: ParkedInput;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly ledger: ParkedLedger;
  private readonly cliGoneMs: number;
  private out: FileTail | null = null;
  private err: FileTail | null = null;
  private delivered: number;
  private punched: number;
  private cliKnown: ProcessIdentity | null = null;
  private turnOpen: boolean;
  private closing = false;
  private closed = false;
  private watching: NodeJS.Timeout | null = null;
  /** Whether this server let it go on shutting down: it runs on, for the next server to adopt */
  detached = false;

  constructor(init: ParkedProcessInit) {
    super();
    this.id = init.id;
    this.dir = init.dir;
    this.scope = init.scope;
    this.pid = init.child ? init.child.pid : init.wrapper?.pid;
    this.ledger = init.ledger;
    this.delivered = init.from;
    this.punched = init.from - (init.from % PUNCH_BLOCK);
    this.cliGoneMs = init.cliGoneMs ?? 30_000;
    this.turnOpen = init.turnOpen ?? false;
    this.cliKnown = init.cli ?? null;
    this.stdin = new ParkedInput(
      init.fifo,
      (seq, line) => {
        try {
          appendFileSync(this.file('input'), inputRecord(seq, line), { mode: 0o600 });
          this.ledger.stdinSeq(this.id, seq);
        } catch {
          // A record that could not be written loses a successor one line of what was sent, never the line itself
        }
      },
      () => this.signalWrapper('SIGUSR1'),
      init.stdinSeq ?? 0,
    );
    init.fifo.on('error', () => {
      // The FIFO cannot break while the wrapper holds its other end; after the wrapper is gone nothing reads it
    });
    const { child, wrapper } = init;
    if (child) {
      child.on('error', (error) => {
        if (this.closed) return;
        this.closed = true;
        this.emit('error', error);
        this.ledger.ended(this);
      });
      child.on('exit', (code, signal) => void this.wrapperExited(code, signal));
    } else if (wrapper) {
      // Adopted: the wrapper's parent is the user manager or init, so its end is only seen by looking
      this.watching = setInterval(() => {
        if (processEntry(wrapper.pid)?.started === wrapper.started) return;
        this.stopWatching();
        void this.wrapperExited(null, null);
      }, init.pollMs ?? 500);
      this.watching.unref();
    }
  }

  private stopWatching(): void {
    if (this.watching) clearInterval(this.watching);
    this.watching = null;
  }

  /** Whether a turn is open on it, as this server or its row last knew. */
  get turnIsOpen(): boolean {
    return this.turnOpen;
  }

  /** The byte of `out.jsonl` after the last line handed to the reader. */
  get offset(): number {
    return this.delivered;
  }

  /** The CLI itself, once the wrapper has written its pid and while it is the same process. */
  cli(): ProcessIdentity | null {
    if (this.cliKnown) return this.cliKnown;
    let pid: number;
    try {
      pid = Number(readFileSync(this.file('pid'), 'utf8').trim());
    } catch {
      return null;
    }
    const entry = Number.isInteger(pid) && pid > 0 ? processEntry(pid) : null;
    // Its parent is the wrapper: a pid read late enough to have been reused is somebody else's
    if (!entry || entry.ppid !== this.pid) return null;
    this.cliKnown = { pid, started: entry.started };
    this.ledger.cli(this.id, this.cliKnown);
    return this.cliKnown;
  }

  /**
   * The ids of the control requests some server already answered, from `in.jsonl`: what an adopter
   * must not ask a person again, nor answer twice (spike S1).
   */
  answeredRequests(): Set<string> {
    const answered = new Set<string>();
    let text = '';
    try {
      text = readFileSync(this.file('input'), 'utf8');
    } catch {
      return answered;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; id?: unknown };
        if (record.type === 'control_response' && typeof record.id === 'string') answered.add(record.id);
      } catch {
        // A record cut by a crash names nothing
      }
    }
    return answered;
  }

  /** Resolves once every complete line `out.jsonl` holds now has been handed over: an adopter's replay. */
  async caughtUp(): Promise<void> {
    await this.out?.drain();
  }

  /**
   * This server lets the process go and leaves it running: nothing more is read or written, no signal
   * is sent, and no event is emitted. Its row and files stay for the server that adopts it next.
   */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.detached = true;
    this.stopWatching();
    this.out?.stop();
    this.err?.stop();
    this.stdin.mute();
  }

  /** Starts handing over the CLI's lines: stdout with the offset after each, stderr as it comes. */
  listen(onOut: (line: string) => void, onErr: (line: string) => void): void {
    this.out = new FileTail(this.file('output'), this.delivered, (line, end) => {
      this.delivered = end;
      onOut(line);
    });
    this.err = new FileTail(this.file('errors'), 0, (line) => onErr(line));
    this.out.start();
    this.err.start();
    this.cli();
  }

  /**
   * The chat's lead opened a turn, or ended one. Open, the watchdog may end it once the lease has run
   * out; ended, the fold has read everything up to here, which is committed, and the bytes before it
   * are given back to the filesystem.
   */
  turn(open: boolean): void {
    if (open === this.turnOpen || this.closed) return;
    this.turnOpen = open;
    const offset = this.delivered;
    try {
      if (open) {
        writeFileSync(`${this.file('turn')}.tmp`, `${String(offset)}\n`, { mode: 0o600 });
        renameSync(`${this.file('turn')}.tmp`, this.file('turn'));
        this.ledger.turn(this.id, offset);
        return;
      }
      rmSync(this.file('turn'), { force: true });
    } catch {
      // The directory went with the process
      return;
    }
    this.ledger.commit(this.id, offset);
  }

  /**
   * A signal for the CLI: what the chat's code sends a child (SIGTERM to stop it, SIGKILL when it
   * would not go). SIGKILL takes the whole tree, the wrapper's included, and the scope with it.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.closed || this.pid === undefined) return false;
    if (signal === 'SIGKILL') {
      this.killTree();
      return true;
    }
    const cli = this.cli();
    try {
      // Before the wrapper has said which pid the CLI is, its group holds both: the wrapper may die
      // of it too, and the CLI is not left running unsignalled
      process.kill(cli ? cli.pid : -this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private killTree(): void {
    const table = processTable();
    const root = this.pid === undefined ? undefined : table.find((p) => p.pid === this.pid);
    for (const victim of root ? [...descendantsOf(table, root.pid), root] : []) {
      try {
        process.kill(victim.pid, 'SIGKILL');
      } catch {
        // gone in between
      }
    }
    // What escaped the tree by forking twice is still in the scope
    if (this.scope) execFile('systemctl', ['--user', 'kill', '--signal=SIGKILL', this.scope], () => {});
  }

  private signalWrapper(signal: NodeJS.Signals): void {
    if (this.pid === undefined || this.closed) return;
    try {
      process.kill(this.pid, signal);
    } catch {
      // gone already
    }
  }

  /**
   * Gives the bytes before a committed offset back to the filesystem. Only once the commit is
   * written: a hole above the offset a successor replays from would read as NULs.
   */
  punch(offset: number): void {
    if (!this.ledger.punches || this.closed) return;
    const upTo = offset - (offset % PUNCH_BLOCK);
    if (upTo <= this.punched) return;
    const from = this.punched;
    this.punched = upTo;
    // util-linux's fallocate: Node has no call for it. A filesystem without holes keeps the bytes
    // until the process ends and its directory goes (spike S6)
    execFile('fallocate', ['--punch-hole', '--offset', String(from), '--length', String(upTo - from), this.file('output')], (error) => {
      if (error) this.ledger.cannotPunch();
    });
  }

  private async wrapperExited(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.stopWatching();
    // A wrapper killed on its own leaves the CLI running (a tree is signalled descendants first, but
    // not all at once): its last lines are written after the wrapper is gone, and are read here
    const cli = this.cli();
    if (cli) {
      const deadline = Date.now() + this.cliGoneMs;
      while (processEntry(cli.pid)?.started === cli.started && Date.now() < deadline) await new Promise((r) => setTimeout(r, CLI_GONE_POLL_MS));
    }
    let status: number | null = null;
    try {
      status = Number(readFileSync(this.file('exitCode'), 'utf8').trim());
    } catch {
      // The wrapper was killed before it could write it: its own status is all there is
    }
    await Promise.all([this.out?.drain(), this.err?.drain()].map((p) => p?.catch(() => undefined)));
    // Let go of while it drained (a shutdown): the next server reads what is left
    if (this.detached) return;
    this.out?.stop();
    this.err?.stop();
    if (status !== null && Number.isInteger(status)) {
      // `wait` gives 128 + n for a CLI that died of signal n, as a child on pipes would report it
      const named = status > 128 ? SIGNAL_NAMES.get(status - 128) : undefined;
      this.exitCode = named ? null : status;
      this.signalCode = named ?? null;
    } else {
      this.exitCode = code;
      this.signalCode = signal ?? (code === null ? 'SIGKILL' : null);
    }
    this.closed = true;
    this.emit('exit', this.exitCode, this.signalCode);
    this.emit('close', this.exitCode, this.signalCode);
    this.ledger.ended(this);
  }

  private file(name: keyof typeof PARKED_FILES): string {
    return join(this.dir, PARKED_FILES[name]);
  }

  /** Whether the wrapper left its exit status, for a reader that finds the process gone. */
  static exited(dir: string): boolean {
    return existsSync(join(dir, PARKED_FILES.exitCode));
  }
}
