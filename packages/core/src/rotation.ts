import { randomUUID } from 'node:crypto';
import { ChatNotFoundError } from './chat-errors.ts';
import type { LimitWait, LimitWaitRunNowRefusalCode, ProjectProvidersSettings, ProviderMove, ProviderMoveDecider, ProvidersSettings, RotationSettings } from '@claudio/shared';
import type { ChatWork } from './chat-service.ts';
import type { ChatManager, ChatRuntime } from './chats.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import type { Db } from './db.ts';
import type { ClaudioEventInput } from './events.ts';
import { runRef } from './event-sources.ts';
import { defaultRotationSettings } from './providers/settings.ts';
import { errorMessage } from '@claudio/shared';

/*
 * What happens when Claude Code reaches its usage limit. The chat manager announces `limit-hit` once
 * per attempt; this decides.
 *
 * - A turn that died on the account's sign-in (the CLI's 401) takes the same path: the chat manager
 *   marks the account signed out, which keeps `choose` from picking it until it signs in again, and
 *   the rotation records `reason: 'auth'`. A wait then ends when an account can take the turn.
 * - With several accounts the limited account is marked out until its reset (the chat manager does
 *   it as the limit is read), the next one is chosen, and the turn is replayed in the same chat,
 *   resumed on it. Automated work always does; a person's chat does when `rotateOnLimit` is on.
 *   A pinned chat moves only within its policy.
 * - With no account left, a person's chat is left alone: it gets a banner, and `waitFor` and
 *   `cancel` are what a click on it calls.
 * - Automated work then waits for the earliest reset on its own (plan decision 4 of
 *   docs/plans/claude-only-fork.md), and gives up after the effective `maxWaitHours` (the project's,
 *   else the global one) when no reset is known.
 * - A wait is a row in `provider_moves`. A timer in the process that owns the chat claims it at the
 *   reset with a guarded update, so two processes on one data directory replay the turn once, and
 *   `recover()` re-arms the timers of a restarted process.
 * - A wait is not tied to the reset it began with. Whenever an account's reading or state changes
 *   (`accountsChanged`), at the earliest reset any account now gives, and on every look, each open
 *   wait asks the accounts again (`roomFor`) and goes on with the first one that has room (R10).
 */

/** A reset is taken as passed a moment late: the provider's own clock may differ from ours */
const RESET_SLACK_MS = 5_000;
/** With no known reset the wait looks again this often: a reading from another chat may end it */
const POLL_MS = 5 * 60_000;
/** How long a claim holds a wait before another process may take it again */
const CLAIM_MS = 2 * 60_000;
/** `setTimeout` takes a signed 32-bit number */
const MAX_TIMER_MS = 2 ** 31 - 1;
const HOUR_MS = 3_600_000;
/** The reason a wait carries when it began on a sign-in failure: it ends when an account can take the turn, not at a reset */
const AUTH_WAIT = 'sign-in expired';

/** What a chat is told once its wait has ended and no turn of its own is left to replay */
const CONTINUE_TEXT = "The provider's usage limit has reset. Continue the work you were doing where you left off.";

export type WaitEnd = 'resumed' | 'failed' | 'cancelled';

/** Why a person's "run it now" on a wait was refused; the 409's `code` */
export type RunNowRefusalCode = LimitWaitRunNowRefusalCode;

export class RunNowRefusal extends Error {
  constructor(
    readonly code: RunNowRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RunNowRefusal';
  }
}

export interface RotationDeps {
  db: Pick<Db, 'insertProviderMove' | 'providerMove' | 'claimProviderMove' | 'closeProviderMove' | 'openProviderMoves' | 'appendRotationEvent'>;
  runtime: Pick<ChatManager, 'on' | 'off' | 'get' | 'providers' | 'limitResetOf' | 'replayLastTurn' | 'send' | 'notice' | 'heldToSchema' | 'limitComing' | 'chooseNext' | 'roomFor' | 'warmModels' | 'accountOf' | 'rotatesOnLimit' | 'signInFailed'>;
  /** `providers.json`, as it stands now */
  settings: () => ProvidersSettings;
  /** A project's own providers settings; null when it sets none */
  projectProviders: (projectId: string) => ProjectProvidersSettings | null;
  /** The project a directory belongs to */
  projectOf: (dir: string) => string | null;
  emit: (event: ClaudioEventInput) => void;
  /** The run, task or item a chat works for; null for a person's chat */
  work?: (chatId: string) => ChatWork | null;
  /** Whether a chat is a sample of an instruction eval: its limit is the runner's to handle, never replayed or moved */
  evalSample?: (chatId: string) => boolean;
  /** A run held to a schema is waited on only when whoever started it waits for the chat (a flow run) */
  awaiting?: (chatId: string) => boolean;
  /**
   * Goes on with a chat whose work is not its last turn: a workflow's lead resumes its run from the
   * cache (docs/plans/workflow-engine-limits.md §2). Null for a chat it does not know, whose last turn
   * is replayed; otherwise whether the work went on, on `account` when the limit moved it there.
   */
  replay?: (chatId: string, account?: string) => Promise<boolean> | null;
  /**
   * Subscribes to every change of an account's reading or stored state (`AccountStore.onChange`);
   * returns the unsubscribe. Without it a wait only looks again on its own timer.
   */
  accountsChanged?: (listener: () => void) => () => void;
  /** A wait is over: the turn was replayed, it could not be, or a person stopped waiting */
  ended?: (move: ProviderMove, end: WaitEnd, reason: string | null) => void;
  now?: () => number;
  /** How often a wait with no known reset looks again; five minutes by default */
  pollMs?: number;
  /** How long after a reset the turn is replayed; five seconds by default */
  slackMs?: number;
}

/** What the rotation settings say for one project: its overrides on the global block. */
export function effectiveOnLimit(settings: Pick<ProvidersSettings, 'rotation'>, project: ProjectProvidersSettings | null): RotationSettings['onLimit'] {
  const base = (settings.rotation ?? defaultRotationSettings()).onLimit;
  return { ...base, ...(project?.onLimit ?? {}) };
}

/**
 * The wait for a limit to reset that a chat is in, read from the move rows: what the work shows while
 * it waits, and what a restart must leave alone, since the rotation re-arms the wait and replays the turn.
 */
export function openWaitOf(db: { providerMoves(filter: { chatId?: string; limit?: number }): ProviderMove[] }, chatId: string | null): LimitWait | null {
  if (!chatId) return null;
  const open = db.providerMoves({ chatId, limit: 10 }).find((m) => m.fromChat === chatId && (m.state === 'waiting' || m.state === 'resuming'));
  return open ? { provider: open.fromProvider, resetsAt: open.resetsAt, moveId: open.id } : null;
}

export class ProviderRotation {
  /** Move id → its timer */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Chat id → the open wait it is in */
  private readonly waits = new Map<string, string>();
  /** Chats whose limit is being decided now */
  private readonly handling = new Set<string>();
  /** A reset learned from a later reading, for a wait that began without one: move id → ISO time */
  private readonly learned = new Map<string, string>();
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly slackMs: number;
  private readonly listener = (run: ChatRuntime, limitResetsAt: string | null): void => {
    void this.onLimitHit(run, limitResetsAt);
  };
  private started = false;
  private unsubscribe: (() => void) | null = null;
  /** A look at every wait is queued for the next turn of the loop: a burst of readings costs one */
  private recheckQueued = false;

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? POLL_MS;
    this.slackMs = deps.slackMs ?? RESET_SLACK_MS;
  }

  /** Starts listening for `limit-hit`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.runtime.on('limit-hit', this.listener);
    this.unsubscribe = this.deps.accountsChanged?.(() => this.recheckSoon()) ?? null;
  }

  close(): void {
    if (this.started) this.deps.runtime.off('limit-hit', this.listener);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waits.clear();
  }

  /**
   * Whether the rotation has taken over a chat's limit: a decision under way, a wait, or a limit
   * about to be announced for automated work. What a flow run waits on rather than fail.
   */
  holds(chatId: string): boolean {
    if (this.handling.has(chatId) || this.waits.has(chatId)) return true;
    const run = this.deps.runtime.get(chatId);
    return !!run && this.deps.runtime.limitComing(chatId) && this.isAutomated(run, this.deps.work?.(chatId) ?? null);
  }

  /** The open wait a chat is in, if any. */
  waitOf(chatId: string): string | null {
    return this.waits.get(chatId) ?? null;
  }

  // ---------- at a limit ----------

  /** A person's chat is not automated work: it asks (P4-2). The decision engine's own chats never move. */
  private isAutomated(run: ChatRuntime, work: ChatWork | null): boolean {
    if (work) return true;
    if (run.origin === 'internal') return false;
    if (run.orchestrationId) return true;
    return this.deps.runtime.heldToSchema(run.id);
  }

  /** Announces the limit and, for automated work, acts on it. Never throws: it runs from an event. */
  async onLimitHit(run: ChatRuntime, limitResetsAt: string | null): Promise<void> {
    const provider = run.provider ?? LEGACY_PROVIDER;
    const auth = this.deps.runtime.signInFailed(run.id);
    // A sign-in failure is no limit: it has its notice below, and the account's own state says it needs signing in
    if (!auth) this.deps.emit({ type: 'run.rateLimited', title: `${run.name} hit its rate limit`, ...runRef(run), provider, resetsAt: limitResetsAt });
    // A sample is run again from scratch on whichever account has room: replaying it would mix two accounts' behaviour
    if (this.deps.evalSample?.(run.id)) return;
    const work = this.deps.work?.(run.id) ?? null;
    const automated = this.isAutomated(run, work);
    // A person's chat moves to another account only when they asked for it; otherwise it has its banner
    if (!automated && !this.deps.runtime.rotatesOnLimit()) {
      if (auth) this.deps.runtime.notice(run.id, 'The sign-in of the chat\'s account expired; sign in to it again, or move the chat to another account.');
      return;
    }
    this.handling.add(run.id);
    try {
      // A run held to a schema that nobody waits for already handed its result over: replaying the
      // turn would spend for nobody. The flow registers its wait just after the limit is announced.
      if (automated && !work && (run.orchestrationId || this.deps.runtime.heldToSchema(run.id))) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (run.orchestrationId || !this.deps.awaiting?.(run.id)) {
          this.deps.runtime.notice(run.id, auth ? `The sign-in of ${provider}'s account expired; this turn is not replayed.` : `${provider} reached its usage limit; this turn is not replayed.`);
          return;
        }
      }
      const moved = await this.moveToAccount(run, auth);
      if (moved.moved || !automated) return;
      // The accounts know when the first of them that can take the turn is back (`chooseNext`); else
      // the reset the account the turn died on gave (`limitResetOf`: that account's reading, or the refusal),
      // which may have passed by now: the wait then goes on at once
      const resetsAt = moved.waitUntil !== null ? new Date(moved.waitUntil).toISOString() : limitResetsAt;
      this.startWait(run, work, { decidedBy: 'setting', decisionId: null, reason: auth ? AUTH_WAIT : null, resetsAt, projectId: this.deps.projectOf(run.workingDir ?? run.cwd) });
    } catch (error) {
      const why = errorMessage(error);
      this.deps.runtime.notice(run.id, `Handling the ${auth ? 'sign-in failure' : 'usage limit'} failed: ${why}`);
      // Flows and tasks keep the run open while the rotation holds it: with neither a move nor a
      // wait behind it, nothing would ever end it. Waiting is all there is to fall back to.
      if (automated && !this.waits.has(run.id)) {
        try {
          this.startWait(run, work, { decidedBy: 'setting', decisionId: null, reason: auth ? AUTH_WAIT : `handling the limit failed: ${why}`, resetsAt: limitResetsAt, projectId: null });
        } catch {
          /* the notice above is all that is left to say */
        }
      }
    } finally {
      this.handling.delete(run.id);
    }
  }

  // ---------- another account ----------

  /**
   * Chooses the account the limited chat goes on with and replays its turn there. False, with the
   * earliest reset among the accounts when it is known, when the chat runs on no account or none
   * other can take it.
   */
  private async moveToAccount(run: ChatRuntime, auth = false): Promise<{ moved: boolean; waitUntil: number | null }> {
    const from = this.deps.runtime.accountOf(run.id);
    // The choice looks at which account can run the chat's model: read the lists it has not seen yet
    await this.deps.runtime.warmModels();
    const choice = this.deps.runtime.chooseNext(run.id);
    if (!from || !choice) return { moved: false, waitUntil: null };
    const to = choice.account;
    if (!to || to === from) {
      if (!to && run.model) this.deps.runtime.notice(run.id, `No other account can run ${run.model} now; the turn waits for one that can.`);
      this.record('wait', from, null, auth ? 'auth' : 'limit', run, { waitUntil: choice.waitUntil });
      return { moved: false, waitUntil: choice.waitUntil };
    }
    const resumed = await (this.deps.replay?.(run.id, to) ?? this.deps.runtime.replayLastTurn(run.id, to));
    if (!resumed) return { moved: false, waitUntil: choice.waitUntil };
    this.record('switch', from, to, auth ? 'auth' : (choice.reason ?? 'limit'), run, null);
    this.deps.runtime.notice(run.id, auth ? `The sign-in of account ${from} expired; the turn goes on with account ${to}.` : `Account ${from} reached its usage limit; the turn goes on with account ${to}.`);
    this.deps.emit({ type: 'run.accountRotated', title: `${run.name} moved from account ${from} to ${to}`, ...runRef(run), from, to, resumed });
    return { moved: true, waitUntil: null };
  }

  private record(event: 'switch' | 'wait', from: string, to: string | null, reason: string, run: ChatRuntime, data: Record<string, unknown> | null): void {
    try {
      this.deps.db.appendRotationEvent({ ts: new Date(this.now()).toISOString(), event, from, to, reason, detail: run.name, data: { chatId: run.id, ...(data ?? {}) } });
    } catch {
      // A closed database (shutting down) is not the rotation's to report
    }
  }

  // ---------- waiting ----------

  /**
   * Starts a wait for the chat's provider to reset: what a person's click on "Wait for the reset"
   * does, and the floor of automated work. Null when the chat already has an open wait. The reset it
   * waits for is the earliest one among the accounts the chat could go on with (`chooseNext`), never
   * another account's that merely ran last (regression audit §2.7).
   */
  waitFor(chatId: string, decidedBy: ProviderMoveDecider = 'person'): ProviderMove | null {
    const run = this.deps.runtime.get(chatId);
    if (!run) throw new ChatNotFoundError();
    const back = this.deps.runtime.chooseNext(chatId)?.waitUntil ?? null;
    const work = this.deps.work?.(chatId) ?? null;
    const projectId = this.deps.projectOf(run.workingDir ?? run.cwd);
    const resetsAt = back !== null ? new Date(back).toISOString() : this.deps.runtime.limitResetOf(chatId);
    return this.startWait(run, work, { decidedBy, decisionId: null, reason: null, resetsAt, projectId });
  }

  private startWait(run: ChatRuntime, work: ChatWork | null, opts: { decidedBy: ProviderMoveDecider; decisionId: string | null; reason: string | null; resetsAt: string | null; projectId: string | null }): ProviderMove | null {
    const at = new Date(this.now()).toISOString();
    const provider = run.provider ?? LEGACY_PROVIDER;
    const move: ProviderMove = {
      id: randomUUID(),
      at,
      subjectKind: work?.subjectKind ?? 'chat',
      subjectId: work?.subjectId ?? run.id,
      projectId: opts.projectId,
      fromChat: run.id,
      toChat: null,
      fromProvider: provider,
      toProvider: null,
      fromModel: run.model,
      toModel: null,
      action: 'wait',
      state: 'waiting',
      decidedBy: opts.decidedBy,
      decisionId: opts.decisionId,
      resetsAt: opts.resetsAt,
      reason: opts.reason,
      updatedAt: at,
    };
    if (!this.deps.db.insertProviderMove(move)) return null;
    this.waits.set(run.id, move.id);
    this.arm(move);
    const label = this.deps.runtime.providers.list().find((m) => m.id === provider)?.label ?? provider;
    this.deps.runtime.notice(
      run.id,
      opts.reason === AUTH_WAIT
        ? `No account can take the turn: the sign-in of ${label}'s accounts expired. Sign in again to one of them; the turn goes on then, waiting up to ${this.maxWaitHours(move)} h.`
        : move.resetsAt
        ? `${label} reached its usage limit. Waiting for it to reset at ${move.resetsAt}; the turn goes on then.${opts.reason ? ` (${opts.reason})` : ''}`
        : `${label} reached its usage limit and gave no reset time. Waiting up to ${this.maxWaitHours(move)} h; the turn goes on when it does.${opts.reason ? ` (${opts.reason})` : ''}`,
    );
    this.deps.emit({ type: 'run.limitWaiting', title: `${run.name} waits for ${label}'s limit to reset`, ...runRef(run), provider, resetsAt: move.resetsAt });
    return move;
  }

  private maxWaitHours(move: ProviderMove): number {
    const project = move.projectId ? this.deps.projectProviders(move.projectId) : null;
    return effectiveOnLimit(this.deps.settings(), project).maxWaitHours;
  }

  /** The earliest reset a wait knows of: the one it began with, or an earlier one a later reading gave. */
  private resetOf(move: Pick<ProviderMove, 'id' | 'resetsAt'>): string | null {
    const learned = this.learned.get(move.id) ?? null;
    if (!move.resetsAt || !learned) return move.resetsAt ?? learned;
    return Date.parse(learned) < Date.parse(move.resetsAt) ? learned : move.resetsAt;
  }

  /**
   * Sets the timer of a wait: the next look, or its reset when that comes first. A known reset is
   * no reason to stop looking: another account may get room before it (R10).
   */
  private arm(move: ProviderMove): void {
    const existing = this.timers.get(move.id);
    if (existing) clearTimeout(existing);
    const now = this.now();
    const reset = this.resetOf(move);
    const cap = Date.parse(move.at) + this.maxWaitHours(move) * HOUR_MS;
    const look = Math.min(now + this.pollMs, cap);
    const due = reset ? Math.min(Date.parse(reset) + this.slackMs, look) : look;
    const timer = setTimeout(() => void this.tick(move.id), Math.min(Math.max(0, due - now), MAX_TIMER_MS));
    timer.unref();
    this.timers.set(move.id, timer);
  }

  private drop(move: Pick<ProviderMove, 'id' | 'fromChat'>): void {
    const timer = this.timers.get(move.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(move.id);
    this.learned.delete(move.id);
    if (this.waits.get(move.fromChat) === move.id) this.waits.delete(move.fromChat);
  }

  private async tick(id: string): Promise<void> {
    try {
      const row = this.deps.db.providerMove(id);
      if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) {
        this.drop(row ?? { id, fromChat: '' });
        return;
      }
      const now = this.now();
      // An account with room ends any wait, whatever reset it began with; a sign-in failure has no
      // other way to end
      if (await this.goOnIfRoom(row)) return;
      const reset = this.resetOf(row);
      if (reset) {
        if (now >= Date.parse(reset) + this.slackMs) await this.resume(row);
        else this.arm(row);
        return;
      }
      // No reset is known: a later reading of one of the chat's accounts may say when it is (`goOnIfRoom`
      // learns it), or that one has room. A reading of whichever account ran last is no evidence: it
      // resumed waits on accounts still out before 2026-10-29
      if (now >= Date.parse(row.at) + this.maxWaitHours(row) * HOUR_MS) this.end(row, 'failed', 'limit-wait-expired');
      else this.arm(row);
    } catch {
      // A closed database (shutting down) is not the wait's to report
    }
  }

  /**
   * Looks for an account with room for a waiting chat and, when one has it, goes on there. What every
   * look, every reset and every change of an account's reading or state comes to.
   */
  private async goOnIfRoom(row: ProviderMove): Promise<boolean> {
    const room = this.deps.runtime.roomFor(row.fromChat, Date.parse(row.at));
    if (room?.account) {
      await this.resume(row, room.account);
      return true;
    }
    // Every account is still out, but one may now say it is back sooner than the wait thought
    if (room?.waitUntil && row.reason !== AUTH_WAIT) {
      const known = this.resetOf(row);
      if (!known || room.waitUntil < Date.parse(known)) this.learned.set(row.id, new Date(room.waitUntil).toISOString());
    }
    return false;
  }

  private recheckSoon(): void {
    if (this.recheckQueued) return;
    this.recheckQueued = true;
    setImmediate(() => {
      this.recheckQueued = false;
      void this.recheck();
    });
  }

  /** Every open wait this process owns asks the accounts again. Never throws: it runs from an event. */
  private async recheck(): Promise<void> {
    for (const [chatId, id] of [...this.waits]) {
      try {
        const row = this.deps.db.providerMove(id);
        if (!row || (row.state !== 'waiting' && row.state !== 'resuming') || row.fromChat !== chatId) continue;
        if (!(await this.goOnIfRoom(row))) this.arm(row);
      } catch {
        // A closed database (shutting down) is not the wait's to report
      }
    }
  }

  /**
   * A person's "run it now" on an open wait: the turn goes on at once on an account with room, the
   * first the accounts' readings allow. An account the turn already died on is taken only when no
   * other one can be: the person decided to try it. Refused when the wait is over, belongs to
   * another process, or every account's reading says it is out.
   */
  async runNow(moveId: string): Promise<{ move: ProviderMove; account: string | null }> {
    const row = this.deps.db.providerMove(moveId);
    if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) throw new RunNowRefusal('wait-over', 'this wait is already over');
    if (!this.deps.runtime.get(row.fromChat)) throw new RunNowRefusal('not-owned', 'the chat of this wait runs in another Claudio process on this data directory');
    const room = this.deps.runtime.roomFor(row.fromChat, Date.parse(row.at))?.account ?? this.deps.runtime.roomFor(row.fromChat, null)?.account ?? null;
    // A chat on no account (no account store) has only its provider's reading to go by, and the person overrides it
    if (!room && this.deps.runtime.accountOf(row.fromChat)) {
      const back = this.deps.runtime.chooseNext(row.fromChat)?.waitUntil ?? null;
      throw new RunNowRefusal('no-room', `every account is out of usage${back ? ` until ${new Date(back).toISOString()}` : ''}`);
    }
    if (!(await this.resume(row, room ?? undefined, 'person'))) {
      const now = this.deps.db.providerMove(moveId);
      if (!now || (now.state !== 'waiting' && now.state !== 'resuming')) return { move: now ?? row, account: null };
      throw new RunNowRefusal('wait-over', 'the wait is being resumed already');
    }
    return { move: this.deps.db.providerMove(moveId) ?? row, account: room };
  }

  /**
   * Claims the wait and replays the turn in the same chat, on `account` when one was found with room.
   * Only the claim's winner replays. False when it did not get to replay (another claim, another
   * process's chat).
   */
  private async resume(row: ProviderMove, account?: string, decidedBy: 'rotation' | 'person' = 'rotation'): Promise<boolean> {
    const run = this.deps.runtime.get(row.fromChat);
    if (!run) {
      // Not this process's chat: whoever owns it arms its own timer
      this.drop(row);
      return false;
    }
    const claimedAt = this.now();
    if (!this.deps.db.claimProviderMove(row.id, new Date(claimedAt).toISOString(), new Date(claimedAt + CLAIM_MS).toISOString())) {
      this.drop(row);
      return false;
    }
    const from = this.deps.runtime.accountOf(run.id);
    let replayed = false;
    let reason: string | null = null;
    try {
      const own = this.deps.replay?.(run.id, account) ?? null;
      if (own) {
        replayed = await own;
        if (!replayed) reason = 'its work could not be resumed';
      } else {
        replayed = await this.deps.runtime.replayLastTurn(run.id, account);
        // A restart forgot the turn that was cut off: the session resumes with a nudge instead
        if (!replayed) {
          this.deps.runtime.send(run.id, CONTINUE_TEXT);
          replayed = true;
        }
      }
    } catch (error) {
      reason = `its turn could not be resumed: ${errorMessage(error)}`;
    }
    const moved = replayed && account && from && account !== from ? { from, to: account } : null;
    if (moved) this.record('switch', moved.from, moved.to, decidedBy === 'person' ? 'person' : 'limit', run, { wait: row.id });
    if (!replayed) this.deps.runtime.notice(run.id, 'The usage limit reset, but the turn could not be resumed automatically; send it again.');
    else if (decidedBy === 'person') this.deps.runtime.notice(run.id, `Run now on a person's request${account ? `, with account ${account}` : ''}: the turn goes on.`);
    else if (account) this.deps.runtime.notice(run.id, `Account ${account} has room again: the turn goes on with it.`);
    else this.deps.runtime.notice(run.id, 'The usage limit reset: the turn goes on.');
    if (moved) this.deps.emit({ type: 'run.accountRotated', title: `${run.name} moved from account ${moved.from} to ${moved.to}`, ...runRef(run), from: moved.from, to: moved.to, resumed: true });
    this.end(row, replayed ? 'resumed' : 'failed', replayed ? null : reason);
    return true;
  }

  private end(row: ProviderMove, end: WaitEnd, reason: string | null): boolean {
    const state = end === 'resumed' ? 'resumed' : end === 'failed' ? 'failed' : 'cancelled';
    const closed = this.deps.db.closeProviderMove(row.id, state, new Date(this.now()).toISOString(), { reason });
    this.drop(row);
    if (!closed) return false;
    if (end === 'failed') this.deps.runtime.notice(row.fromChat, reason === 'limit-wait-expired' ? 'The wait for the usage limit to reset ran out.' : `The wait ended: ${reason ?? 'it failed'}.`);
    this.deps.ended?.({ ...row, state, reason: reason ?? row.reason }, end, reason);
    return true;
  }

  /** A person stops waiting; the run or task it belonged to then ends stopped. False when the wait was not open. */
  cancel(moveId: string): boolean {
    const row = this.deps.db.providerMove(moveId);
    if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) return false;
    return this.end(row, 'cancelled', 'stopped waiting');
  }

  /**
   * Arms the timers of the waits whose chat this process restored, after a start-up. A claim whose
   * time ran out is taken again; a wait whose reset passed while the process was down resumes now.
   */
  recover(): void {
    const nowIso = new Date(this.now()).toISOString();
    for (const row of this.deps.db.openProviderMoves(nowIso)) {
      if (!this.deps.runtime.get(row.fromChat) || this.timers.has(row.id)) continue;
      this.waits.set(row.fromChat, row.id);
      this.arm(row);
    }
  }
}
