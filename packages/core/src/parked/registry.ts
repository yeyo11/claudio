import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { MCP_ENTRY_ENV } from '../claudio-mcp.ts';
import { CHAT_TOKEN_MAX_AGE_MS, chatTokenHash, type StoredChatTokens } from '../security/chat-tokens.ts';
import { descendantsOf, processEntry, processTable } from '../processes.ts';
import { ParkedProcess, type ParkedLedger } from './process.ts';
import { CliProcessStore, type CliProcessRow, type ProcessIdentity } from './store.ts';
import { PARKED_FILES, PARKED_LAYOUT, wrapperScript } from './wrapper.ts';

/** What a chat's process is started with. */
export interface ParkedSpawn {
  chatId: string;
  bin: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ParkedOptions {
  /** `<dataDir>`: the processes live under `<dataDir>/procs/<id>/` */
  dataDir: string;
  store: CliProcessStore;
  /** D6: how long a parked CLI may work on an open turn with no server renewing its lease */
  handoverSeconds: number;
  /** D9: a systemd user scope per CLI where a user manager runs; `setsid` otherwise */
  scopes: boolean;
  /** The clock the lease is written with */
  now?: () => number;
  /** Seconds between the watchdog's looks at the lease */
  tickSeconds?: number;
  /** Whether a systemd user manager answers; probed once when not given */
  userManager?: () => boolean;
  /** How long a reaped process has between SIGTERM and SIGKILL, and a scope's `TimeoutStopSec` */
  stopGraceSeconds?: number;
  /** The server holding processes; this one by default. A test stands in for a second server with another */
  owner?: ProcessIdentity;
  /** How often an adopted wrapper is looked for */
  pollMs?: number;
}

/** Why a row could not be adopted: it goes to layer 3 instead (or stays, while a live server holds it). */
export type AdoptRefusal = 'held' | 'layout' | 'gone' | 'taken' | 'files';

/** The server holding processes: this one, by pid and start time, as `/proc` names it. */
function selfIdentity(): ProcessIdentity {
  return { pid: process.pid, started: processEntry(process.pid)?.started ?? 0 };
}

const samePid = (a: ProcessIdentity, b: ProcessIdentity): boolean => a.pid === b.pid && a.started === b.started;

const alive = (who: ProcessIdentity | null): boolean => who !== null && processEntry(who.pid)?.started === who.started;

/** Where the MCP server this CLI may start comes from: the payload directory, which an update must not delete under it */
function payloadDirOf(env: NodeJS.ProcessEnv): string | null {
  const entry = env[MCP_ENTRY_ENV] ?? process.env[MCP_ENTRY_ENV];
  return entry ? dirname(entry) : null;
}

/** Whether what a row names still runs: its CLI, or its wrapper until the CLI's pid is written. */
const running = (row: CliProcessRow): boolean => alive(row.cli ?? row.wrapper);

let probedUserManager: boolean | null = null;

/**
 * Whether `systemd-run --user` can place a process in a scope here: a user manager that answers.
 * The container has none, nor does a desktop without systemd; there the wrapper runs under `setsid`
 * (D9). Asked once per server.
 */
export function hasUserManager(): boolean {
  if (probedUserManager !== null) return probedUserManager;
  const probe = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  probedUserManager = ['running', 'degraded'].includes((probe.stdout ?? '').trim());
  return probedUserManager;
}

/** Runs a `systemctl --user` command; resolves when it ended, whatever it answered. */
function systemctl(args: string[]): Promise<void> {
  return new Promise((resolve) => execFile('systemctl', ['--user', ...args], { timeout: 120_000 }, () => resolve()));
}

/**
 * The parked CLI processes of this data dir (layer 2 of docs/plans/survive-restarts.md, t3): it
 * starts each one detached under the wrapper, holds their lease while this server lives, keeps their
 * rows, adopts at start-up what a previous server left running (t4), lets them go on a shutdown, and
 * reaps what could not be adopted, whose chats layer 3 continues.
 */
export class ParkedProcesses implements ParkedLedger, StoredChatTokens {
  readonly root: string;
  private readonly store: CliProcessStore;
  private readonly handoverSeconds: number;
  private readonly useScopes: boolean;
  private readonly now: () => number;
  private readonly tickSeconds: number;
  private readonly stopGraceSeconds: number;
  private readonly owner: ProcessIdentity;
  private readonly pollMs: number | undefined;
  private readonly live = new Map<string, ParkedProcess>();
  private renewTimer: NodeJS.Timeout | null = null;
  private canPunch = true;
  /** The CLI's version, recorded in each row (t5): set by the core, which learns it from the CLI */
  cliVersion: () => string | null = () => null;
  /**
   * Turn ends whose offset waits to be written with the chat's own row (`ChatManager.persist`), so the
   * baseline the next turn's cost is measured from and the offset a successor replays from never
   * disagree (R1). Off, each is written at once, as a registry used alone does.
   */
  deferCommits = false;
  private readonly due = new Map<string, number>();

  constructor(options: ParkedOptions) {
    this.root = join(options.dataDir, 'procs');
    this.store = options.store;
    this.handoverSeconds = options.handoverSeconds;
    this.now = options.now ?? Date.now;
    this.tickSeconds = options.tickSeconds ?? 10;
    this.stopGraceSeconds = options.stopGraceSeconds ?? 10;
    this.useScopes = options.scopes && (options.userManager ?? hasUserManager)();
    this.owner = options.owner ?? selfIdentity();
    this.pollMs = options.pollMs;
  }

  /** The server this registry holds processes for, as the rows name it. */
  get identity(): ProcessIdentity {
    return this.owner;
  }

  get punches(): boolean {
    return this.canPunch;
  }

  /** The processes this server holds, by id */
  held(): ParkedProcess[] {
    return [...this.live.values()];
  }

  /**
   * Starts a CLI under the wrapper and returns it running. The FIFO is opened here, read-write and
   * non-blocking, before the wrapper exists: a FIFO opened that way never waits for the other end,
   * what is written meanwhile waits in the pipe, and libuv writes the rest as the CLI reads.
   * Throws when the directory or the FIFO cannot be made; a wrapper that cannot be executed is the
   * process's `error`, as a child's would be.
   */
  start(spec: ParkedSpawn): ParkedProcess {
    const id = randomBytes(8).toString('hex');
    const dir = join(this.root, id);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    mkdirSync(dir, { mode: 0o700 });
    const file = (name: keyof typeof PARKED_FILES) => join(dir, PARKED_FILES[name]);
    try {
      for (const name of ['input', 'output', 'errors', 'wrapperLog'] as const) writeFileSync(file(name), '', { mode: 0o600 });
      writeFileSync(file('version'), `${String(PARKED_LAYOUT)}\n`, { mode: 0o600 });
      writeFileSync(file('script'), wrapperScript({ dir, command: [spec.bin, ...spec.args], tickSeconds: this.tickSeconds }), { mode: 0o600 });
      this.writeLease(dir);
      if (spec.env.CLAUDIO_API_URL) writeFileSync(file('apiUrl'), `${spec.env.CLAUDIO_API_URL}\n`, { mode: 0o600 });
      const made = spawnSync('mkfifo', ['-m', '600', file('fifo')], { stdio: 'ignore' });
      if (made.status !== 0) throw new Error(`could not make the FIFO of a parked process (mkfifo exited ${String(made.status ?? made.signal)})`);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const fifo = new Socket({ fd: openSync(file('fifo'), constants.O_RDWR | constants.O_NONBLOCK), readable: false, writable: true });
    const scope = this.useScopes ? `claudio-cli-${id}.scope` : null;
    const wrapper = ['sh', file('script')];
    const command = scope
      ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${scope}`, `--description=Claudio chat ${spec.chatId}`, '-p', `TimeoutStopSec=${String(this.stopGraceSeconds)}`, '--', ...wrapper]
      : wrapper;
    const log = openSync(file('wrapperLog'), 'a');
    let child;
    try {
      // Detached: its own session and process group (the `setsid` of D9, and what systemd-run execs
      // into), and no descriptor of this server's, so nothing ties its life to this one
      child = spawn(command[0] as string, command.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'ignore', log] });
    } finally {
      closeSync(log);
    }
    const parked = new ParkedProcess({ id, dir, scope, child, fifo, ledger: this, from: 0, ...(this.pollMs !== undefined ? { pollMs: this.pollMs } : {}) });
    if (child.pid !== undefined) {
      this.store.insert({
        id,
        chatId: spec.chatId,
        layout: PARKED_LAYOUT,
        dir,
        scope,
        wrapper: { pid: child.pid, started: processEntry(child.pid)?.started ?? 0 },
        cli: null,
        owner: this.owner,
        leaseUntil: new Date(this.leaseUntilMs()).toISOString(),
        committedOffset: 0,
        stdinSeq: 0,
        turnOffset: null,
        tokenHash: spec.env.CLAUDIO_API_TOKEN ? chatTokenHash(spec.env.CLAUDIO_API_TOKEN) : null,
        payloadDir: payloadDirOf(spec.env),
        cliVersion: this.cliVersion(),
        startedAt: new Date(this.now()).toISOString(),
      });
      this.live.set(id, parked);
      this.armRenewal();
    }
    return parked;
  }

  /** Moves every held lease forward: written to each process's `lease` file, which the watchdog reads, and to the rows. */
  renew(): void {
    for (const parked of this.live.values()) {
      try {
        this.writeLease(parked.dir);
      } catch {
        // Its directory is going with it
      }
    }
    this.store.renew(this.owner, new Date(this.leaseUntilMs()).toISOString());
  }

  /**
   * The chat a stored token hash was made for (D5), while its process runs and this server holds it.
   * Bound to the process by the pid and start time of the row, so a pid the kernel reused, a process
   * no server holds, and a row older than a token may live (`CHAT_TOKEN_MAX_AGE_MS`) all answer null.
   */
  chatForTokenHash(hash: string): string | null {
    const row = this.store.byTokenHash(hash);
    if (!row?.owner || !samePid(row.owner, this.owner) || !running(row)) return null;
    return this.now() - Date.parse(row.startedAt) < CHAT_TOKEN_MAX_AGE_MS ? row.chatId : null;
  }

  /**
   * The chats whose parked CLI runs under a live server (this one's, or another that runs): what
   * start-up must not delete the files of. What `reap` is about to stop is not in it, and a start-up
   * that adopts (t4) adds what it took, which is not owned yet when this is read.
   */
  chatsInUse(): Set<string> {
    return new Set(this.store.all().filter((row) => running(row) && (this.live.has(row.id) || (row.owner !== null && alive(row.owner)))).map((row) => row.chatId));
  }

  /**
   * The port the running CLIs hold in their `CLAUDIO_API_URL`, or null when none runs (or none had
   * an address). Several ports can only come from a port that was changed while CLIs lived: the one
   * most of them hold wins, the newest on a tie, since a CLI can reach the API only there.
   */
  apiPort(): number | null {
    const held = new Map<number, { count: number; newest: string }>();
    for (const row of this.store.all()) {
      if (!running(row)) continue;
      let port = 0;
      try {
        port = Number(new URL(readFileSync(join(row.dir, PARKED_FILES.apiUrl), 'utf8').trim()).port);
      } catch {
        continue;
      }
      if (!Number.isInteger(port) || port <= 0) continue;
      const seen = held.get(port);
      held.set(port, { count: (seen?.count ?? 0) + 1, newest: seen && seen.newest > row.startedAt ? seen.newest : row.startedAt });
    }
    const [best] = [...held].sort((a, b) => b[1].count - a[1].count || (a[1].newest < b[1].newest ? 1 : -1));
    return best ? best[0] : null;
  }

  /** The CLIs (by pid) of the rows `reap` would stop now: those whose server is gone and that still run. */
  leftBehind(): number[] {
    return this.orphans()
      .filter((row) => alive(row.cli))
      .flatMap((row) => (row.cli ? [row.cli.pid] : []));
  }

  /** The rows whose server is gone (or let them go) and that this one does not hold: what a start adopts or reaps. */
  orphans(): CliProcessRow[] {
    return this.store.all().filter((row) => !this.live.has(row.id) && !(row.owner && alive(row.owner)));
  }

  /**
   * Takes over a process a server before this one left (layer 2, t4): checked by pid and start time,
   * wrapper and CLI, then taken with a guarded update on the owner the row was read with, so of two
   * servers starting at once exactly one gets it. Its lease is renewed from here on and its output is
   * read from the committed offset. Answers the process, or why it could not be adopted, in which
   * case the row is left as it was for `reap`.
   */
  adopt(row: CliProcessRow): ParkedProcess | AdoptRefusal {
    if (this.live.has(row.id) || (row.owner && alive(row.owner))) return 'held';
    if (row.layout !== PARKED_LAYOUT) return 'layout';
    // The wrapper holds the FIFO's writer and records the exit: without it the CLI reads EOF any time
    if (!alive(row.wrapper) || (row.cli !== null && !alive(row.cli)) || ParkedProcess.exited(row.dir)) return 'gone';
    if (!this.store.take(row.id, row.owner, this.owner, new Date(this.leaseUntilMs()).toISOString())) return 'taken';
    let fd: number;
    try {
      fd = openSync(join(row.dir, PARKED_FILES.fifo), constants.O_RDWR | constants.O_NONBLOCK);
      this.writeLease(row.dir);
    } catch {
      // Taken and then unusable: let go again, so the start reaps it
      this.store.release(row.id, this.owner);
      return 'files';
    }
    const fifo = new Socket({ fd, readable: false, writable: true });
    const parked = new ParkedProcess({
      id: row.id,
      dir: row.dir,
      scope: row.scope,
      wrapper: row.wrapper,
      cli: row.cli,
      fifo,
      ledger: this,
      from: row.committedOffset,
      stdinSeq: row.stdinSeq,
      turnOpen: row.turnOffset !== null,
      ...(this.pollMs !== undefined ? { pollMs: this.pollMs } : {}),
    });
    this.live.set(row.id, parked);
    this.armRenewal();
    return parked;
  }

  /**
   * A shutdown that leaves the processes running (D1): each stops being read and written, the turn
   * ends waiting are written, and the rows are let go so the next server takes them from nobody. The
   * lease is not moved again, so the watchdog ends an open turn if no server comes back in time.
   */
  detach(): ParkedProcess[] {
    this.flushCommits();
    const left = [...this.live.values()];
    for (const parked of left) {
      parked.detach();
      try {
        this.store.release(parked.id, this.owner);
      } catch {
        // The store closed first: the row names a server that is gone, which the next start reads the same way
      }
    }
    this.live.clear();
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    return left;
  }

  /** The turn ends waiting for their offset to be written; `deferCommits` only. */
  dueCommits(): Array<[string, number]> {
    return [...this.due];
  }

  /** Writes turn ends' offsets; inside the caller's transaction when it holds one. */
  writeCommits(due: ReadonlyArray<[string, number]>): void {
    for (const [id, offset] of due) this.store.commit(id, this.owner, offset);
  }

  /** The offsets are written: the bytes before them can go, and they wait no more. */
  committed(due: ReadonlyArray<[string, number]>): void {
    for (const [id, offset] of due) {
      if (this.due.get(id) === offset) this.due.delete(id);
      this.live.get(id)?.punch(offset);
    }
  }

  /** Writes whatever waits, on its own. */
  flushCommits(): void {
    const due = this.dueCommits();
    if (due.length === 0) return;
    try {
      this.writeCommits(due);
    } catch {
      return;
    }
    this.committed(due);
  }

  /**
   * What a previous server left and this one did not adopt: each row whose owner is gone. A process
   * still running is stopped, its directory removed and its row deleted; a directory with no row whose
   * process is gone is removed too. Resolves with the ids reaped.
   */
  async reap(): Promise<string[]> {
    const reaped: string[] = [];
    for (const row of this.store.all()) {
      if (this.live.has(row.id) || (row.owner && alive(row.owner))) continue;
      await this.stopRow(row);
      this.store.delete(row.id);
      rmSync(row.dir, { recursive: true, force: true });
      reaped.push(row.id);
    }
    if (!existsSync(this.root)) return reaped;
    const rows = new Set(this.store.all().map((r) => r.id));
    for (const name of readdirSync(this.root)) {
      if (rows.has(name) || this.live.has(name)) continue;
      const dir = join(this.root, name);
      let pid = 0;
      try {
        pid = Number(readFileSync(join(dir, PARKED_FILES.pid), 'utf8').trim());
      } catch {
        // The wrapper never got as far as starting the CLI
      }
      // A row is written right after the start: a directory without one whose CLI still runs is left to its end
      if (!ParkedProcess.exited(dir) && Number.isInteger(pid) && pid > 0 && processEntry(pid)) continue;
      rmSync(dir, { recursive: true, force: true });
      reaped.push(name);
    }
    return reaped;
  }

  // ---------- ParkedLedger ----------

  cli(id: string, cli: ProcessIdentity): void {
    this.store.setCli(id, this.owner, cli);
  }

  turn(id: string, offset: number | null): void {
    this.store.setTurn(id, this.owner, offset);
  }

  commit(id: string, offset: number): void {
    if (this.deferCommits) {
      this.due.set(id, offset);
      return;
    }
    this.store.commit(id, this.owner, offset);
    this.live.get(id)?.punch(offset);
  }

  stdinSeq(id: string, seq: number): void {
    this.store.setStdinSeq(id, this.owner, seq);
  }

  cannotPunch(): void {
    this.canPunch = false;
  }

  ended(parked: ParkedProcess): void {
    this.live.delete(parked.id);
    this.due.delete(parked.id);
    try {
      this.store.delete(parked.id);
    } catch {
      // The store closed under it (a shutdown): the next start reaps the row, whose process is gone
    }
    rmSync(parked.dir, { recursive: true, force: true });
    // A scope whose process died of a signal ends `failed` and keeps its name until reset (spike S4)
    if (parked.scope) void systemctl(['reset-failed', parked.scope]);
    if (this.live.size === 0 && this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  // ---------- internals ----------

  private leaseUntilMs(): number {
    return this.now() + this.handoverSeconds * 1000;
  }

  private writeLease(dir: string): void {
    const lease = join(dir, PARKED_FILES.lease);
    writeFileSync(`${lease}.tmp`, `${String(Math.floor(this.leaseUntilMs() / 1000))}\n`, { mode: 0o600 });
    renameSync(`${lease}.tmp`, lease);
  }

  /** Renewed well inside the hand-over window, so a busy event loop never lets a live server's lease run out. */
  private armRenewal(): void {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => this.renew(), Math.min(60_000, (this.handoverSeconds * 1000) / 5));
    this.renewTimer.unref();
  }

  /** Ends what a row names, if it still runs: its scope, or else its tree, SIGTERM first. */
  private async stopRow(row: CliProcessRow): Promise<void> {
    const wrapperUp = alive(row.wrapper);
    const cliUp = alive(row.cli);
    if (!wrapperUp && !cliUp) {
      if (row.scope) await systemctl(['reset-failed', row.scope]);
      return;
    }
    if (row.scope) {
      // Waits for the scope to empty, SIGKILL after its TimeoutStopSec, double forks included (spike S4)
      await systemctl(['stop', row.scope]);
      await systemctl(['reset-failed', row.scope]);
      return;
    }
    const table = processTable();
    const roots = [row.wrapper, row.cli].filter((who): who is ProcessIdentity => who !== null && alive(who));
    const victims = roots.flatMap((root) => {
      const entry = table.find((p) => p.pid === root.pid);
      return entry ? [...descendantsOf(table, entry.pid), entry] : [];
    });
    if (row.cli && cliUp) {
      try {
        process.kill(row.cli.pid, 'SIGTERM');
      } catch {
        // gone in between
      }
    }
    const deadline = Date.now() + this.stopGraceSeconds * 1000;
    while (alive(row.cli) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    for (const victim of victims) {
      if (processEntry(victim.pid)?.started !== victim.started) continue;
      try {
        process.kill(victim.pid, 'SIGKILL');
      } catch {
        // gone in between
      }
    }
  }
}
