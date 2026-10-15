import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  CreateTerminalRequest,
  Terminal,
  TerminalEndReason,
  TerminalHistoryPage,
  TerminalServerFrame,
  TerminalSettings,
  TerminalStatus,
  TerminalUnavailableReason,
  UpdateTerminalSettingsRequest,
} from '@claudio/shared';
import type { AgentryEventInput } from '../events.ts';
import { processEntry, processTable, terminateTree } from '../processes.ts';
import type { SecretVault } from '../secret-vault.ts';
import { resolveTerminalCwd, type CwdLookup } from './cwd.ts';
import { buildTerminalEnv } from './env.ts';
import { TerminalError } from './errors.ts';
import { Coalescer, FlowControl, RECHECK_MS, type CoalescerClock, type FlowDecision } from './flow.ts';
import { HostSpawnError, forkedHost, type HostFactory, type TerminalHost } from './host-client.ts';
import { PeerCheck } from './peer.ts';
import { TerminalSettingsStore, resolveShell } from './settings.ts';
import type { TerminalStore } from './store.ts';

/** A shell that does not exit when told to is killed after this */
export const KILL_GRACE_MS = 3000;
/** An exited or closed terminal stays in the list this long, so the person sees how it ended */
export const ENDED_KEPT_MS = 60 * 60 * 1000;
/** Sockets on one terminal: a desktop window, a phone, and a little room */
export const MAX_CLIENTS = 4;
/** The most a snapshot may weigh, so `hello` stays small on a phone */
export const SNAPSHOT_MAX_BYTES = 512 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
const COLS = [2, 500] as const;
const ROWS = [1, 200] as const;
/** The host failing this often this fast is not a fluke: the feature reads unavailable until it is turned off and on */
const HOST_FAILURES = 3;
const HOST_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * What a socket gives the service to reach one client with. The API adapter owns the socket; the
 * service owns what is sent over it and in what order.
 */
export interface TerminalClient {
  /** Who attached: `token:<id>`, an OIDC subject, `local`… */
  actor: string;
  /** `local` or the client's address */
  client: string;
  origin: string | null;
  /** A control frame (JSON text) */
  frame(frame: TerminalServerFrame): void;
  /** Output (a binary frame) */
  output(data: Buffer): void;
  /** How much the socket holds that the network has not taken yet; a client far behind is let go */
  buffered?(): number;
  /** The service is done with this client: close the socket */
  close(): void;
}

/** What a client does once attached */
export interface TerminalConnection {
  /** Keys and paste, as bytes. Refused over 64 KiB; the view splits a larger paste. */
  input(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** The client's xterm has parsed `bytes` more of what was sent */
  ack(bytes: number): void;
  /** Claims the terminal's size for this client */
  focus(): void;
  detach(): void;
}

export interface TerminalServiceDeps {
  store: TerminalStore;
  settings: TerminalSettingsStore;
  lookup: CwdLookup;
  emit: (event: AgentryEventInput) => void;
  vault?: Pick<SecretVault, 'get'> | null;
  version?: string;
  /** The server's environment, the base of every shell's; `process.env` by default */
  env?: NodeJS.ProcessEnv;
  /** How the host is reached: a forked child by default, a fake in tests */
  host?: HostFactory;
  peer?: PeerCheck;
  /** Wall clock in milliseconds; a test moves it */
  now?: () => number;
  /** Timers for the output coalescer; a test drives them */
  clock?: CoalescerClock;
  /** The periodic pass (flow re-checks, idle, forgetting the ended); 0 leaves it to the caller's `tick()` */
  tickMs?: number;
  serverPid?: number;
  /** Whether node-pty can be found at all, before anything loads it */
  ptyResolvable?: () => boolean;
}

interface ClientState {
  id: string;
  client: TerminalClient;
  attachment: number;
  live: boolean;
  bytesIn: number;
  bytesOut: number;
  /** The last size this client asked for, which it gets back when it becomes the active one */
  size: { cols: number; rows: number } | null;
}

interface Live {
  info: Terminal;
  clients: Map<string, ClientState>;
  flow: FlowControl;
  coalescer: Coalescer;
  /** The client the size belongs to: the one that last sent input, focused or resized */
  active: string | null;
  /** When the last client left, or the terminal started: what the idle limit counts from */
  idleSince: number;
  endedAt: number | null;
  /** The host has not yet said the shell is gone */
  killing: boolean;
  spawning: boolean;
}

const clamp = (value: number, [min, max]: readonly [number, number]): number => Math.min(max, Math.max(min, Math.trunc(value)));

function nodePtyResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve('node-pty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Every terminal: the registry, the limits, the lifetime and the byte stream's flow. The PTYs
 * themselves run in the terminal host, a child process of the server (`host-client.ts`), so a
 * native fault ends the terminals and not the API, and no process the server spawns ever inherits
 * a PTY master.
 *
 * It is the person's own shell. Nothing here writes into a terminal on its own, reads what one
 * prints to decide anything, or starts `claude` in one; the screen the host keeps exists to repaint a
 * client that reattaches and is never searched, logged or stored.
 */
export class TerminalService {
  private readonly terminals = new Map<string, Live>();
  private host: TerminalHost | null = null;
  private readonly hostFactory: HostFactory;
  private readonly peerCheck: PeerCheck;
  private readonly now: () => number;
  private readonly clock: CoalescerClock;
  private readonly serverPid: number;
  private readonly timer: NodeJS.Timeout | null;
  private readonly ptyResolvable: () => boolean;
  private ptyMissing = false;
  private hostFailures: number[] = [];
  private hostDown = false;
  private stopped = false;
  private nextClient = 1;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly deps: TerminalServiceDeps) {
    this.hostFactory = deps.host ?? forkedHost();
    this.peerCheck = deps.peer ?? new PeerCheck();
    this.now = deps.now ?? Date.now;
    this.clock = deps.clock ?? {
      now: () => performance.now(),
      after: (ms, run) => {
        const handle = setTimeout(run, ms);
        return () => clearTimeout(handle);
      },
    };
    this.serverPid = deps.serverPid ?? process.pid;
    this.ptyResolvable = deps.ptyResolvable ?? nodePtyResolvable;
    const tickMs = deps.tickMs ?? RECHECK_MS;
    this.timer = tickMs > 0 ? setInterval(() => this.tick(), tickMs) : null;
    this.timer?.unref();
  }

  // ---------- the feature ----------

  settings(): TerminalSettings {
    return this.deps.settings.get();
  }

  /**
   * Whether the terminal can be opened at all: what the settings, the environment and the host
   * decide. Who is asking, and from where, is the API's gate (`terminal-gate.ts`), which adds its own reasons.
   */
  status(): TerminalStatus {
    const settings = this.deps.settings.get();
    const reason = this.unavailableReason(settings);
    return {
      enabled: settings.enabled,
      available: reason === null,
      reason,
      settings,
      sources: this.deps.settings.sources(),
      peerCheck: this.peerCheck.available(),
      running: this.running(),
    };
  }

  /** The peer-process check, for the gate: whether a loopback connection belongs to a chat's process */
  get peer(): PeerCheck {
    return this.peerCheck;
  }

  /**
   * Changes the settings. Turning the terminal off closes every one at once; turning it on again
   * gives a host that failed a fresh start.
   */
  async updateSettings(patch: UpdateTerminalSettingsRequest): Promise<TerminalStatus> {
    const before = this.deps.settings.get();
    await this.deps.settings.update(patch);
    const after = this.deps.settings.get();
    if (before.enabled && !after.enabled) await this.closeAll('disabled');
    if (!before.enabled && after.enabled) {
      this.hostFailures = [];
      this.hostDown = false;
    }
    // Lowering the cap closes nothing: what runs keeps running, and no new one opens past it
    this.changed();
    return this.status();
  }

  history(limit = 50, offset = 0): TerminalHistoryPage {
    return this.deps.store.history(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
  }

  /** An attempt the gate or the socket refused, written for the owner to see */
  recordRefusal(entry: { terminalId?: string | null; actor: string; client: string; origin?: string | null; reason: string }): void {
    this.deps.store.refuse({ sessionId: entry.terminalId ?? null, actor: entry.actor, client: entry.client, origin: entry.origin ?? null, reason: entry.reason, at: this.iso() });
  }

  // ---------- terminals ----------

  list(filter: { project?: string; chat?: string } = {}): Terminal[] {
    return [...this.terminals.values()]
      .map((t) => this.snapshotOf(t))
      .filter((t) => {
        if (filter.project !== undefined && !(t.scope.kind === 'project' && t.scope.projectId === filter.project)) return false;
        if (filter.chat !== undefined && !(t.scope.kind === 'chat' && t.scope.chatId === filter.chat)) return false;
        return true;
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get(id: string): Terminal | null {
    const live = this.terminals.get(id);
    return live ? this.snapshotOf(live) : null;
  }

  running(): number {
    let count = 0;
    for (const live of this.terminals.values()) if (live.info.state === 'running') count += 1;
    return count;
  }

  /** Opens a shell in the project's directory or the chat's worktree. The request carries ids, never a path. */
  async create(request: CreateTerminalRequest, who: { actor: string; client: string }): Promise<Terminal> {
    const settings = this.deps.settings.get();
    const reason = this.unavailableReason(settings);
    if (reason === 'off' || reason === 'disabled-by-env') throw new TerminalError('terminal.off', 'The terminal is off', 409);
    if (reason) throw new TerminalError('terminal.unavailable', `The terminal is not available: ${reason}`, 409);

    const { scope, cwd } = await resolveTerminalCwd(request, this.deps.lookup);
    // Checked after the lookups, which wait, and right before the slot is taken, so two requests cannot both fit under the cap
    if (this.running() >= settings.maxTerminals) throw new TerminalError('terminal.limit', `At most ${String(settings.maxTerminals)} terminals can run at once`, 409);
    const shell = resolveShell(settings, this.deps.env ?? process.env);
    const env = buildTerminalEnv({ base: this.deps.env ?? process.env, vault: this.deps.vault ?? null, cwd, ...(this.deps.version ? { version: this.deps.version } : {}) });
    const cols = clamp(request.cols ?? DEFAULT_COLS, COLS);
    const rows = clamp(request.rows ?? DEFAULT_ROWS, ROWS);
    const id = `term_${randomBytes(16).toString('base64url')}`;
    const startedAt = this.iso();

    const live: Live = {
      info: { id, scope, cwd, shell, state: 'running', cols, rows, clients: 0, startedAt, endedAt: null, endReason: null, exitCode: null },
      clients: new Map(),
      flow: new FlowControl(),
      coalescer: new Coalescer(this.clock, (frame) => this.deliver(live, frame)),
      active: null,
      idleSince: this.now(),
      endedAt: null,
      killing: false,
      spawning: true,
    };
    // Held while the host spawns, so a second request cannot slip past the cap in the meantime
    this.terminals.set(id, live);
    this.deps.store.startSession({ id, scope, cwd, shell, actor: who.actor, client: who.client, serverPid: this.serverPid, startedAt });
    try {
      const started = await this.hostOf().spawn({ id, shell, args: settings.loginShell ? ['-l'] : [], cwd, env, cols, rows, scrollbackLines: settings.scrollbackLines });
      live.spawning = false;
      this.deps.store.setProcess(id, started.pid, started.pidStarted);
    } catch (error) {
      live.spawning = false;
      this.terminals.delete(id);
      this.deps.store.endSession(id, 'host-failed', null, this.iso());
      if (error instanceof HostSpawnError && error.reason === 'pty-missing') {
        this.ptyMissing = true;
        throw new TerminalError('terminal.unavailable', 'The terminal is not available: pty-missing', 409);
      }
      if (error instanceof HostSpawnError) throw new TerminalError('terminal.unavailable', `The shell could not start: ${error.message}`, 409);
      throw new TerminalError('terminal.unavailable', 'The terminal is not available: host-failed', 409);
    }
    // The shell may have exited, or the terminal been closed, while the host was starting it
    if (live.info.state === 'closed') {
      live.killing = true;
      this.host?.kill(id, KILL_GRACE_MS);
    }
    if (live.info.state !== 'running') return this.snapshotOf(live);
    this.changed();
    return this.snapshotOf(live);
  }

  /** Ends a terminal: SIGHUP, SIGTERM, then SIGKILL after 3 s to the shell's process group and what descends from it */
  close(id: string, reason: TerminalEndReason = 'closed'): Terminal | null {
    const live = this.terminals.get(id);
    if (!live) return null;
    if (live.info.state === 'running') this.finish(live, reason, null, null);
    return this.snapshotOf(live);
  }

  /** Ends every running terminal, and resolves once the host has said they are gone (or the grace has passed) */
  async closeAll(reason: TerminalEndReason): Promise<void> {
    const running = [...this.terminals.values()].filter((t) => t.info.state === 'running');
    if (running.length === 0) return;
    for (const live of running) this.finish(live, reason, null, null, false);
    this.host?.killAll(KILL_GRACE_MS);
    this.changed();
    await this.settled(running);
  }

  /**
   * Called when the server stops: every shell ends, the rows say so, and the host is let go (it ends
   * what it holds and exits). The rows are written before this returns, so the database may close.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    const running = [...this.terminals.values()].filter((t) => t.info.state === 'running');
    for (const live of running) this.finish(live, 'server-stopping', null, null, false);
    this.host?.killAll(KILL_GRACE_MS);
    this.deps.store.detachAll(this.iso());
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // The host is let go once it has reported its shells gone; a server that exits first is as good,
    // since the host ends them itself when its channel closes
    await this.settled(running);
    this.host?.dispose();
  }

  /**
   * Shells a previous server left behind (it was killed hard, and the host's own cleanup did not
   * run): the rows say they are still open. Each tree whose root is still the same process (same pid
   * and start time) is ended; a pid the system has reused is left alone. Rows of a server that is
   * still alive are not touched. Returns how many trees were ended.
   */
  reapStrays(): number {
    let ended = 0;
    const table = processTable();
    for (const stray of this.deps.store.strays()) {
      const owner = stray.serverPid !== this.serverPid ? processEntry(stray.serverPid) : null;
      // Another server of this data directory is running and owns it
      if (owner) continue;
      const root = stray.pid > 0 && stray.pidStarted > 0 ? table.find((p) => p.pid === stray.pid && p.started === stray.pidStarted) : undefined;
      if (root) {
        terminateTree(root, table, KILL_GRACE_MS);
        ended += 1;
      }
      this.deps.store.endSession(stray.id, 'server-crashed', null, this.iso());
    }
    return ended;
  }

  // ---------- sockets ----------

  /**
   * Attaches a client to a terminal. The client gets `hello` with the screen as the host keeps it, then
   * the unfinished tail of a half-written sequence, then everything after. Throws when the terminal is
   * gone, has ended with nothing left to show, or already has the most clients.
   */
  async attach(id: string, client: TerminalClient): Promise<TerminalConnection> {
    const live = this.terminals.get(id);
    if (!live) throw new TerminalError('terminal.not-found', 'No such terminal', 404);
    if (live.info.state === 'closed') throw new TerminalError('terminal.ended', 'The terminal was closed', 409);
    if (live.clients.size >= MAX_CLIENTS) throw new TerminalError('terminal.clients', `At most ${String(MAX_CLIENTS)} clients can attach to one terminal`, 409);

    const state: ClientState = {
      id: `c${String(this.nextClient++)}`,
      client,
      attachment: this.deps.store.attach({ sessionId: id, actor: client.actor, client: client.client, origin: client.origin, at: this.iso() }),
      live: false,
      bytesIn: 0,
      bytesOut: 0,
      size: null,
    };
    live.clients.set(state.id, state);
    live.info.clients = live.clients.size;
    live.flow.add(state.id);
    const settings = this.deps.settings.get();
    try {
      const snap = await this.hostOf().snapshot(id, settings.replayLines, SNAPSHOT_MAX_BYTES);
      if (!live.clients.has(state.id)) throw new TerminalError('terminal.ended', 'The terminal ended while attaching', 409);
      // What is held for the clients already attached is what the snapshot already shows: send it to
      // them before this one counts, so the new client never sees it twice
      live.coalescer.flush();
      client.frame({ type: 'hello', terminal: this.snapshotOf(live), snapshot: snap.snapshot, cols: snap.cols, rows: snap.rows });
      if (snap.tail.length > 0) client.output(snap.tail);
      state.live = true;
      if (live.info.state === 'exited') client.frame({ type: 'exit', code: live.info.exitCode, signal: null });
    } catch (error) {
      this.dropClient(live, state, false);
      if (error instanceof TerminalError) throw error;
      throw new TerminalError('terminal.unavailable', 'The terminal is not available: host-failed', 409);
    }
    this.changed();
    return this.connection(live, state);
  }

  private connection(live: Live, state: ClientState): TerminalConnection {
    return {
      input: (data) => {
        if (data.length > MAX_INPUT_BYTES) throw new TerminalError('terminal.input-too-large', 'Input frames are at most 64 KiB', 413);
        if (live.info.state !== 'running' || !live.clients.has(state.id)) return;
        state.bytesIn += data.length;
        this.claim(live, state);
        this.host?.write(live.info.id, data);
      },
      resize: (cols, rows) => {
        if (live.info.state !== 'running' || !live.clients.has(state.id)) return;
        state.size = { cols: clamp(cols, COLS), rows: clamp(rows, ROWS) };
        this.claim(live, state);
      },
      ack: (bytes) => {
        if (!live.clients.has(state.id)) return;
        this.apply(live, live.flow.acked(state.id, bytes));
      },
      focus: () => {
        if (live.info.state === 'running' && live.clients.has(state.id)) this.claim(live, state);
      },
      detach: () => {
        if (live.clients.has(state.id)) this.dropClient(live, state, true);
      },
    };
  }

  /** The size belongs to the client that last sent input, focused or resized; the others render at it and do not fight */
  private claim(live: Live, state: ClientState): void {
    live.active = state.id;
    const want = state.size;
    if (!want || (want.cols === live.info.cols && want.rows === live.info.rows)) return;
    live.info.cols = want.cols;
    live.info.rows = want.rows;
    this.host?.resize(live.info.id, want.cols, want.rows);
    for (const other of live.clients.values()) {
      if (other.id !== state.id && other.live) other.client.frame({ type: 'size', cols: want.cols, rows: want.rows });
    }
  }

  // ---------- output and flow ----------

  /** The host sent the shell's output: it goes to the coalescer, which hands one frame to every live client */
  private onData(id: string, data: Buffer): void {
    const live = this.terminals.get(id);
    if (!live || live.info.state !== 'running') return;
    live.coalescer.push(data);
  }

  private deliver(live: Live, frame: Buffer): void {
    for (const state of [...live.clients.values()]) {
      if (!state.live) continue;
      state.client.output(frame);
      state.bytesOut += frame.length;
      const decision = live.flow.sent(state.id, frame.length);
      this.apply(live, decision);
      const buffered = state.client.buffered?.();
      if (buffered !== undefined && live.clients.has(state.id)) this.apply(live, live.flow.buffered(state.id, buffered));
    }
  }

  private apply(live: Live, decision: FlowDecision): void {
    for (const id of decision.evict) {
      const state = live.clients.get(id);
      if (!state) continue;
      state.client.frame({ type: 'closed', reason: 'evicted-slow' });
      this.dropClient(live, state, true, true);
    }
    if (live.info.state !== 'running') return;
    if (decision.pause) this.host?.pause(live.info.id);
    if (decision.resume) this.host?.resume(live.info.id);
  }

  private dropClient(live: Live, state: ClientState, notify: boolean, closeSocket = false): void {
    if (!live.clients.delete(state.id)) return;
    this.deps.store.detach(state.attachment, state.bytesIn, state.bytesOut, this.iso());
    live.info.clients = live.clients.size;
    if (live.active === state.id) live.active = null;
    if (live.clients.size === 0) live.idleSince = this.now();
    if (closeSocket) state.client.close();
    // The flow may now resume: a client that leaves takes its unacknowledged bytes with it
    this.apply(live, live.flow.remove(state.id));
    if (notify) this.changed();
  }

  // ---------- endings ----------

  private onExit(id: string, code: number | null, signal: string | null): void {
    const live = this.terminals.get(id);
    if (!live) return;
    live.killing = false;
    if (live.info.state === 'running') this.finish(live, 'exit', code, signal);
    else if (!this.stopped) this.host?.forget(id);
    this.notifySettled();
  }

  /**
   * Records that a terminal ended and tells its clients. Only the shell exiting leaves the clients
   * attached (they see how it ended); every other reason closes them, and kills the shell.
   */
  private finish(live: Live, reason: TerminalEndReason, code: number | null, signal: string | null, announce = true): void {
    if (live.info.state !== 'running') return;
    live.coalescer.flush();
    live.coalescer.discard();
    const exited = reason === 'exit';
    live.info.state = exited ? 'exited' : 'closed';
    live.info.endReason = reason;
    live.info.exitCode = code;
    live.info.endedAt = this.iso();
    live.endedAt = this.now();
    this.deps.store.endSession(live.info.id, reason, code, live.info.endedAt);
    if (exited) {
      for (const state of live.clients.values()) if (state.live) state.client.frame({ type: 'exit', code, signal });
    } else {
      live.killing = !live.spawning;
      for (const state of [...live.clients.values()]) {
        state.client.frame({ type: 'closed', reason });
        this.dropClient(live, state, false, true);
      }
      if (reason !== 'host-failed') this.host?.kill(live.info.id, KILL_GRACE_MS);
    }
    if (announce) this.changed();
  }

  /** The host died: every shell it held is gone, and a host that keeps dying turns the feature off until it is turned on again */
  private onHostFailed(reason: string): void {
    if (this.stopped) return;
    for (const live of [...this.terminals.values()]) {
      if (live.info.state === 'running') this.finish(live, 'host-failed', null, null, false);
      live.killing = false;
    }
    this.notifySettled();
    const now = this.now();
    this.hostFailures = [...this.hostFailures.filter((at) => now - at < HOST_FAILURE_WINDOW_MS), now];
    if (this.hostFailures.length >= HOST_FAILURES) this.hostDown = true;
    void reason;
    this.changed();
  }

  /** Resolves when none of `lives` waits for the host any more, or when the grace and a little more have passed */
  private settled(lives: Live[]): Promise<void> {
    return new Promise((done) => {
      const check = (): void => {
        if (lives.some((live) => live.killing)) return;
        this.waiters.delete(check);
        clearTimeout(limit);
        done();
      };
      const limit = setTimeout(() => {
        this.waiters.delete(check);
        done();
      }, KILL_GRACE_MS + 1500);
      limit.unref();
      this.waiters.add(check);
      check();
    });
  }

  private notifySettled(): void {
    for (const check of [...this.waiters]) check();
  }

  // ---------- the periodic pass ----------

  /**
   * Re-checks the flow of paused terminals (so a stale count can never leave a shell paused), ends
   * the ones nobody has attached for `idleMinutes`, and forgets the ended ones after an hour.
   */
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    const idleMs = this.deps.settings.get().idleMinutes * 60_000;
    for (const live of [...this.terminals.values()]) {
      if (live.info.state === 'running') {
        if (live.flow.isPaused) this.apply(live, live.flow.recheck());
        if (live.clients.size === 0 && !live.spawning && now - live.idleSince >= idleMs) this.finish(live, 'idle', null, null);
      } else if (live.endedAt !== null && now - live.endedAt >= ENDED_KEPT_MS) {
        this.terminals.delete(live.info.id);
        this.host?.forget(live.info.id);
        this.changed();
      }
    }
  }

  // ---------- helpers ----------

  private hostOf(): TerminalHost {
    this.host ??= this.hostFactory({
      data: (id, data) => this.onData(id, data),
      exit: (id, code, signal) => this.onExit(id, code, signal),
      failed: (reason) => this.onHostFailed(reason),
    });
    return this.host;
  }

  private unavailableReason(settings: TerminalSettings): TerminalUnavailableReason | null {
    if (this.deps.settings.vetoed) return 'disabled-by-env';
    if (!settings.enabled) return 'off';
    if (this.hostDown) return 'host-failed';
    if (this.ptyMissing || !this.ptyResolvable()) return 'pty-missing';
    return null;
  }

  private snapshotOf(live: Live): Terminal {
    return { ...live.info, scope: { ...live.info.scope } };
  }

  private changed(): void {
    if (this.stopped) return;
    this.deps.emit({ type: 'terminal.changed', title: 'Terminals changed', terminals: this.list(), status: this.status() });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
