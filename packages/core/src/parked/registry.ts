import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
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
}

/** The server holding processes: this one, by pid and start time, as `/proc` names it. */
function selfIdentity(): ProcessIdentity {
  return { pid: process.pid, started: processEntry(process.pid)?.started ?? 0 };
}

const alive = (who: ProcessIdentity | null): boolean => who !== null && processEntry(who.pid)?.started === who.started;

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
 * rows, and reaps what a previous server left. Adopting a live process at start-up is t4's; until
 * then a start stops what it finds, and the chats a restart cut are continued by layer 3 as before.
 */
export class ParkedProcesses implements ParkedLedger {
  readonly root: string;
  private readonly store: CliProcessStore;
  private readonly handoverSeconds: number;
  private readonly useScopes: boolean;
  private readonly now: () => number;
  private readonly tickSeconds: number;
  private readonly stopGraceSeconds: number;
  private readonly owner = selfIdentity();
  private readonly live = new Map<string, ParkedProcess>();
  private renewTimer: NodeJS.Timeout | null = null;
  private canPunch = true;

  constructor(options: ParkedOptions) {
    this.root = join(options.dataDir, 'procs');
    this.store = options.store;
    this.handoverSeconds = options.handoverSeconds;
    this.now = options.now ?? Date.now;
    this.tickSeconds = options.tickSeconds ?? 10;
    this.stopGraceSeconds = options.stopGraceSeconds ?? 10;
    this.useScopes = options.scopes && (options.userManager ?? hasUserManager)();
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
    const parked = new ParkedProcess({ id, dir, scope, child, fifo, ledger: this, from: 0 });
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

  /** The CLIs (by pid) of the rows `reap` would stop now: those whose server is gone and that still run. */
  leftBehind(): number[] {
    return this.store
      .all()
      .filter((row) => !this.live.has(row.id) && !(row.owner && alive(row.owner)) && alive(row.cli))
      .flatMap((row) => (row.cli ? [row.cli.pid] : []));
  }

  /**
   * What a previous server left: each row whose owner is gone. A process still running is stopped
   * (adopting it is t4's), its directory removed and its row deleted; a directory with no row whose
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
    this.store.commit(id, this.owner, offset);
  }

  stdinSeq(id: string, seq: number): void {
    this.store.setStdinSeq(id, this.owner, seq);
  }

  cannotPunch(): void {
    this.canPunch = false;
  }

  ended(parked: ParkedProcess): void {
    this.live.delete(parked.id);
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
