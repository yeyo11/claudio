import { randomUUID } from 'node:crypto';
import type { LimitWait, ProjectProvidersSettings, ProviderLimit, ProviderMove, ProviderMoveDecider, ProvidersSettings, RotationSettings } from '@agentry/shared';
import type { ChatWork } from './chat-service.ts';
import type { ChatManager, ChatRuntime } from './chats.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import type { Db } from './db.ts';
import type { AgentryEventInput } from './events.ts';
import { runRef } from './event-sources.ts';
import { defaultRotationSettings } from './providers/settings.ts';

/*
 * What happens when Claude Code reaches its usage limit. The chat manager announces `limit-hit` once
 * per attempt; this decides.
 *
 * - A person's chat is left alone: it gets a banner, and `waitFor` and `cancel` are what a click on
 *   it calls.
 * - Automated work waits for the reset on its own (the only action, plan decision 4 of
 *   docs/plans/claude-only-fork.md), and gives up after the effective `maxWaitHours` (the project's,
 *   else the global one) when no reset is known.
 * - A wait is a row in `provider_moves`. A timer in the process that owns the chat claims it at the
 *   reset with a guarded update, so two processes on one data directory replay the turn once, and
 *   `recover()` re-arms the timers of a restarted process.
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

/** What a chat is told once its wait has ended and no turn of its own is left to replay */
const CONTINUE_TEXT = "The provider's usage limit has reset. Continue the work you were doing where you left off.";

export type WaitEnd = 'resumed' | 'failed' | 'cancelled';

export interface RotationDeps {
  db: Pick<Db, 'insertProviderMove' | 'providerMove' | 'claimProviderMove' | 'closeProviderMove' | 'openProviderMoves'>;
  runtime: Pick<ChatManager, 'on' | 'off' | 'get' | 'limits' | 'providers' | 'replayLastTurn' | 'send' | 'notice' | 'heldToSchema' | 'limitComing'>;
  /** `providers.json`, as it stands now */
  settings: () => ProvidersSettings;
  /** A project's own providers settings; null when it sets none */
  projectProviders: (projectId: string) => ProjectProvidersSettings | null;
  /** The project a directory belongs to */
  projectOf: (dir: string) => string | null;
  emit: (event: AgentryEventInput) => void;
  /** The run, task or item a chat works for; null for a person's chat */
  work?: (chatId: string) => ChatWork | null;
  /** A run held to a schema is waited on only when whoever started it waits for the chat (a flow run) */
  awaiting?: (chatId: string) => boolean;
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
  private readonly listener = (run: ChatRuntime, limit: ProviderLimit | null): void => {
    void this.onLimitHit(run, limit);
  };
  private started = false;

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
  }

  close(): void {
    if (this.started) this.deps.runtime.off('limit-hit', this.listener);
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
  async onLimitHit(run: ChatRuntime, limit: ProviderLimit | null): Promise<void> {
    const provider = run.provider ?? LEGACY_PROVIDER;
    this.deps.emit({ type: 'run.rateLimited', title: `${run.name} hit its rate limit`, ...runRef(run), provider, resetsAt: limit?.resetsAt ?? null });
    const work = this.deps.work?.(run.id) ?? null;
    if (!this.isAutomated(run, work)) return;
    this.handling.add(run.id);
    try {
      // A run held to a schema that nobody waits for already handed its result over: replaying the
      // turn would spend for nobody. The flow registers its wait just after the limit is announced.
      if (!work && (run.orchestrationId || this.deps.runtime.heldToSchema(run.id))) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (run.orchestrationId || !this.deps.awaiting?.(run.id)) {
          this.deps.runtime.notice(run.id, `${provider} reached its usage limit; this turn is not replayed.`);
          return;
        }
      }
      this.startWait(run, work, { decidedBy: 'setting', decisionId: null, reason: null, resetsAt: limit?.resetsAt ?? null, projectId: this.deps.projectOf(run.workingDir ?? run.cwd) });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.deps.runtime.notice(run.id, `Handling the usage limit failed: ${why}`);
      // Flows and tasks keep the run open while the rotation holds it: with neither a move nor a
      // wait behind it, nothing would ever end it. Waiting is all there is to fall back to.
      if (!this.waits.has(run.id)) {
        try {
          this.startWait(run, work, { decidedBy: 'setting', decisionId: null, reason: `handling the limit failed: ${why}`, resetsAt: limit?.resetsAt ?? null, projectId: null });
        } catch {
          /* the notice above is all that is left to say */
        }
      }
    } finally {
      this.handling.delete(run.id);
    }
  }

  // ---------- waiting ----------

  /**
   * Starts a wait for the chat's provider to reset: what a person's click on "Wait for the reset"
   * does, and the floor of automated work. Null when the chat already has an open wait.
   */
  waitFor(chatId: string, decidedBy: ProviderMoveDecider = 'person'): ProviderMove | null {
    const run = this.deps.runtime.get(chatId);
    if (!run) throw new Error('chat not found');
    const limit = this.deps.runtime.limits.get(run.provider ?? LEGACY_PROVIDER);
    const work = this.deps.work?.(chatId) ?? null;
    const projectId = this.deps.projectOf(run.workingDir ?? run.cwd);
    return this.startWait(run, work, { decidedBy, decisionId: null, reason: null, resetsAt: limit?.resetsAt ?? null, projectId });
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
      move.resetsAt
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

  /** Sets the timer of a wait: the reset when it is known, otherwise the next look. */
  private arm(move: ProviderMove): void {
    const existing = this.timers.get(move.id);
    if (existing) clearTimeout(existing);
    const now = this.now();
    const reset = move.resetsAt ?? this.learned.get(move.id) ?? null;
    const cap = Date.parse(move.at) + this.maxWaitHours(move) * HOUR_MS;
    const due = reset ? Date.parse(reset) + this.slackMs : Math.min(now + this.pollMs, cap);
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
      const reset = row.resetsAt ?? this.learned.get(id) ?? null;
      if (reset) {
        if (now >= Date.parse(reset) + this.slackMs) await this.resume(row);
        else this.arm(row);
        return;
      }
      // No reset is known: a later reading (another chat's, another process's) may say when it is, or that it is over
      const limit = this.deps.runtime.limits.get(row.fromProvider);
      if (limit?.resetsAt) {
        this.learned.set(id, limit.resetsAt);
        this.arm(row);
        return;
      }
      if (limit && limit.state !== 'exhausted' && Date.parse(limit.observedAt) > Date.parse(row.at)) {
        await this.resume(row);
        return;
      }
      if (now >= Date.parse(row.at) + this.maxWaitHours(row) * HOUR_MS) this.end(row, 'failed', 'limit-wait-expired');
      else this.arm(row);
    } catch {
      // A closed database (shutting down) is not the wait's to report
    }
  }

  /** Claims the wait and replays the turn on the same chat and provider. Only the claim's winner replays. */
  private async resume(row: ProviderMove): Promise<void> {
    const run = this.deps.runtime.get(row.fromChat);
    if (!run) {
      // Not this process's chat: whoever owns it arms its own timer
      this.drop(row);
      return;
    }
    const claimedAt = this.now();
    if (!this.deps.db.claimProviderMove(row.id, new Date(claimedAt).toISOString(), new Date(claimedAt + CLAIM_MS).toISOString())) {
      this.drop(row);
      return;
    }
    let replayed = false;
    let reason: string | null = null;
    try {
      replayed = await this.deps.runtime.replayLastTurn(run.id);
      // A restart forgot the turn that was cut off: the session resumes with a nudge instead
      if (!replayed) {
        this.deps.runtime.send(run.id, CONTINUE_TEXT);
        replayed = true;
      }
    } catch (error) {
      reason = `its turn could not be resumed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (replayed) this.deps.runtime.notice(run.id, 'The usage limit reset: the turn goes on.');
    else this.deps.runtime.notice(run.id, 'The usage limit reset, but the turn could not be resumed automatically; send it again.');
    this.end(row, replayed ? 'resumed' : 'failed', replayed ? null : reason);
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
