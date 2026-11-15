import { randomUUID } from 'node:crypto';
import { ChatNotFoundError, isTransientRefusal } from './chat-errors.ts';
import type { Account, LimitWait, LimitWaitRunNowRefusalCode, ProjectProvidersSettings, ProviderMove, ProviderMoveDecider, ProvidersSettings, RotationSettings } from '@claudio/shared';
import type { ChatWork } from './chat-service.ts';
import { CREDITS_STOP_WORDS, type ChatManager, type ChatRuntime, type LimitTurnMessage } from './chats.ts';
import type { CreditsStop } from './live-chat.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import type { Db, OpenHold } from './db.ts';
import type { ClaudioEventInput } from './events.ts';
import { runRef } from './event-sources.ts';
import { defaultRotationSettings } from './providers/settings.ts';
import { LIMIT_CONTINUE_TEXT, errorMessage } from '@claudio/shared';

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
 * - With no account left, a chat waits for the earliest reset on its own (plan decision 4 of
 *   docs/plans/claude-only-fork.md; docs/plans/limit-resume-and-credits.md D1): automated work always,
 *   and a person's or a schedule's chat when `rotateOnLimit` is on. With it off a person's chat is
 *   left alone: it gets a banner, and `waitFor` and `cancel` are what a click on it calls.
 * - A wait for a known reset holds however far away it is (D2). The effective `maxWaitHours` (the
 *   project's, else the global one) bounds only a wait with no reset known, and a resume the runtime
 *   keeps refusing for room.
 * - A person's wait ends when the person takes the chat over: a turn started on it since the wait
 *   began would otherwise be followed by the replay of the one that died.
 * - A turn stopped because it ran on its account's usage credits where the account's credits setting
 *   does not let it (D4 of docs/plans/limit-resume-and-credits.md) takes the limit's path, recorded
 *   with `reason: 'credits'`; so is a move onto an account whose credits pay for the turn.
 * - A chat of housekeeping (`internal`) runs with no persisted session, so there is nothing to
 *   resume: it ends at a limit and its owner runs it again (D6). A `/v1` client's chat is moved,
 *   never held: its request was answered already.
 * - A wait is a row in `provider_moves`, the hold, and the row is all there is to it (t8 of
 *   docs/plans/limit-resume-and-credits.md): it keeps when it looks again (`next_look_at`), the turn
 *   it replays (`turn`) and how many times it asked `get_usage` (`probe_count`). One sweeper per
 *   process looks over the open rows whose chat it has: at the earliest `next_look_at`, at least every
 *   `sweepMs`, and over every row when an account's reading changes. It claims a row with a guarded
 *   update, so two processes on one data directory replay the turn once. Nothing lives in a timer a
 *   restart could lose: the first pass of a restarted process takes its rows over, a claim that
 *   lapsed included, and closes the row of a chat that is gone.
 * - A resume the runtime refuses for run slots or memory keeps its claim, which is the back-off: the
 *   wait looks again when the claim lapses instead of ending failed.
 * - A wait is not tied to the reset it began with. Whenever an account's reading or state changes
 *   (`accountsChanged`), at the earliest reset any account now gives, and on every look, each open
 *   wait asks the accounts again (`roomFor`) and goes on with the first one that has room (R10).
 * - A wait that knows no reset asks `get_usage` (no turn, no tokens) for the accounts it could go on
 *   with whose reading is older than its last look, backing off 5, 15, 30 then every 60 min; it never
 *   starts a turn to find out. `maxWaitHours` ends it only once a probe past the cap answered nothing.
 * - A wait that knows its reset asks too, more sparsely (15 min after it began, 30 min later, then every
 *   60 min, never once the reset comes first): a person can reset an account's quota early from
 *   Claude's settings, and nothing but a reading says so (cause 12 of
 *   docs/plans/limit-resume-and-credits.md). The answer reaches the wait as any reading does.
 */

/** A reset is taken as passed a moment late: the provider's own clock may differ from ours */
const RESET_SLACK_MS = 5_000;
/** With no known reset the wait looks again this often: a reading from another chat may end it */
const POLL_MS = 5 * 60_000;
/** How long a claim holds a wait before another process may take it again */
const CLAIM_MS = 2 * 60_000;
/** The sweeper passes at least this often: rows a restart left, or another process's claim that lapsed */
const SWEEP_MS = 30_000;
/** 5, 15, 30, then every 60 min: a `get_usage` takes seconds, and an account out for hours says so at the first one */
const PROBE_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
/**
 * 15, 30, then every 60 min: a wait whose reset is known only probes for an early reset, which a
 * person does rarely; an hour late at worst is far better than the hours to the announced reset
 */
const RESET_PROBE_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
/** The least a sweeper sleeps: a row a pass could not move on is never looked at in a tight loop */
const MIN_SWEEP_GAP_MS = 5;
/** `setTimeout` takes a signed 32-bit number */
const MAX_TIMER_MS = 2 ** 31 - 1;
const HOUR_MS = 3_600_000;
/** The reason a wait carries when it began on a sign-in failure: it ends when an account can take the turn, not at a reset */
const AUTH_WAIT = 'sign-in expired';
const CHAT_GONE = 'its chat is gone';
const TOOK_OVER = 'a person took over the chat';

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
  db: Pick<Db, 'insertProviderMove' | 'providerMove' | 'providerMoveTurn' | 'claimProviderMove' | 'closeProviderMove' | 'openHolds' | 'scheduleProviderMove' | 'appendRotationEvent' | 'storedChats'>;
  runtime: Pick<ChatManager, 'on' | 'off' | 'get' | 'providers' | 'limitResetOf' | 'limitTurnOf' | 'replayLastTurn' | 'send' | 'notice' | 'heldToSchema' | 'limitComing' | 'chooseNext' | 'roomFor' | 'warmModels' | 'accountOf' | 'rotatesOnLimit' | 'signInFailed'>;
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
  /** Why the chat's last turn was stopped on its account's credits; null when it was not (a limit) */
  creditsStop?: (chatId: string) => CreditsStop | null;
  /** A wait is over: the turn was replayed, it could not be, or a person stopped waiting */
  ended?: (move: ProviderMove, end: WaitEnd, reason: string | null) => void;
  /**
   * Asks `get_usage` (no turn, no tokens) for the accounts a waiting chat could go on with whose
   * reading is not newer than `since` (epoch ms), and records what they answer; settles when they
   * have. Without it a wait with no known reset only polls, as before the sweeper.
   */
  probe?: (chatId: string, since: number) => Promise<void>;
  /** The one clock of the rotation: every look, claim, reset and expiry reads it */
  now?: () => number;
  /** How often a wait looks again at the most: a reset not passed yet, a poll with no probe; five minutes by default */
  pollMs?: number;
  /** How long the sweeper sleeps at the most between two passes; thirty seconds by default */
  sweepMs?: number;
  /** The probe back-off of a wait with no known reset: the first look, then after each probe; the last one repeats */
  probeBackoffMs?: readonly number[];
  /** The probe back-off of a wait whose reset is known, for an early reset: the first probe after the wait began, then after each probe; the last one repeats */
  resetProbeMs?: readonly number[];
  /** How long after a reset the turn is replayed; five seconds by default */
  slackMs?: number;
  /** How long a claim holds a wait, which is also how long a resume the runtime refused for room waits to try again; two minutes by default */
  claimMs?: number;
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
  return open ? { provider: open.fromProvider, resetsAt: open.resetsAt, moveId: open.id, nextLookAt: open.nextLookAt ?? null } : null;
}

/**
 * The accounts a probe for a waiting chat asks `get_usage` of: the one it is pinned to, else every
 * enabled, signed-in subscription account (an API key has no plan limits to read), less those whose
 * reading is newer than `since`, which already say what a probe would.
 */
export function probeTargets(run: Pick<ChatRuntime, 'account' | 'accountPinned'>, accounts: readonly Pick<Account, 'id' | 'kind' | 'enabled' | 'signedIn' | 'limits'>[], since: number): string[] {
  const usable = accounts.filter((a) => a.enabled && a.signedIn && a.kind !== 'api-key');
  const candidates = run.accountPinned && run.account ? usable.filter((a) => a.id === run.account) : usable;
  return candidates.filter((a) => !a.limits || Date.parse(a.limits.observedAt) <= since).map((a) => a.id);
}

const SOURCES = new Set<string>(['person', 'supervisor', 'claudio']);

/** The turn a row kept, if it is one: a row is data, and an older or damaged one replays with the nudge rather than throw */
function turnOf(json: string | null): LimitTurnMessage[] | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const turn: LimitTurnMessage[] = [];
    for (const m of parsed as unknown[]) {
      if (typeof m !== 'object' || m === null) return undefined;
      const { text, attachments, source, words } = m as Record<string, unknown>;
      if (typeof text !== 'string' || !Array.isArray(attachments) || !attachments.every((a) => typeof a === 'string') || typeof source !== 'string' || !SOURCES.has(source)) return undefined;
      turn.push({ text, attachments: attachments as string[], source: source as LimitTurnMessage['source'], ...(typeof words === 'string' ? { words } : {}) });
    }
    return turn.length ? turn : undefined;
  } catch {
    return undefined;
  }
}

/** How far a chat has got: the turns its executions ran, and whether one is running now */
const progressOf = (run: ChatRuntime): { turns: number; busy: boolean } => ({ turns: run.executions.length + run.turns, busy: run.status === 'busy' });

export class ProviderRotation {
  /** The sweeper's one timer: the next pass */
  private timer: NodeJS.Timeout | null = null;
  /** The pass under way, and whether another one was asked for meanwhile (`all`: every row, not only the due ones) */
  private passing: Promise<void> | null = null;
  private again: 'due' | 'all' | null = null;
  /** Chat id → the open wait it is in, for the rows whose chat this process has */
  private readonly waits = new Map<string, string>();
  /** Chats whose limit is being decided now */
  private readonly handling = new Set<string>();
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly slackMs: number;
  private readonly claimMs: number;
  private readonly sweepMs: number;
  private readonly backoff: readonly number[];
  private readonly resetBackoff: readonly number[];
  /**
   * When each wait's last probe settled (epoch ms). Memory only: after a restart the next probe of a
   * known reset is counted from when the wait began, which costs one probe at most
   */
  private readonly probedAt = new Map<string, number>();
  private readonly listener = (run: ChatRuntime, limitResetsAt: string | null): void => {
    void this.onLimitHit(run, limitResetsAt);
  };
  /** A person wrote to a chat (`person-message`): the wait it is in is over now, not at the next look */
  private readonly onPerson = (chatId: string): void => this.personWrote(chatId);
  /** Waits whose probe is under way: one at a time each */
  private readonly probing = new Set<string>();
  /** Chats whose claimed wait is being replayed now: the turn it sends is no person's, and one that arrives meanwhile queues behind it */
  private readonly resuming = new Set<string>();
  private started = false;
  private unsubscribe: (() => void) | null = null;
  /** A look at every wait is queued for the next turn of the loop: a burst of readings costs one */
  private recheckQueued = false;
  /** What a timer or a reading started and has not finished: shutdown waits for it, so no replay begins on a chat that is being stopped */
  private readonly inflight = new Set<Promise<void>>();
  private closing = false;
  /** A resume the runtime refused for room: when it first was, and when the claim that keeps the row lapses and it may be tried again */
  private readonly refused = new Map<string, { since: number; until: number }>();
  /** The chat's progress when its wait began: a person's wait ends when the chat moves past it */
  private readonly progress = new Map<string, { turns: number; busy: boolean }>();

  constructor(private readonly deps: RotationDeps) {
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? POLL_MS;
    this.slackMs = deps.slackMs ?? RESET_SLACK_MS;
    this.claimMs = deps.claimMs ?? CLAIM_MS;
    this.sweepMs = deps.sweepMs ?? SWEEP_MS;
    this.backoff = deps.probeBackoffMs?.length ? deps.probeBackoffMs : PROBE_BACKOFF_MS;
    this.resetBackoff = deps.resetProbeMs?.length ? deps.resetProbeMs : RESET_PROBE_MS;
  }

  /** Starts listening for `limit-hit`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.closing = false;
    this.deps.runtime.on('limit-hit', this.listener);
    this.deps.runtime.on('person-message', this.onPerson);
    this.unsubscribe = this.deps.accountsChanged?.(() => this.recheckSoon()) ?? null;
    this.schedule();
  }

  /**
   * Stops listening and clears every timer at once; the promise settles when what they had started
   * has, so a shutdown does not close the database under a replay.
   */
  close(): Promise<void> {
    if (this.started) {
      this.deps.runtime.off('limit-hit', this.listener);
      this.deps.runtime.off('person-message', this.onPerson);
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waits.clear();
    this.refused.clear();
    this.progress.clear();
    this.probedAt.clear();
    return Promise.allSettled([...this.inflight]).then(() => undefined);
  }

  private track(work: Promise<void>): void {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
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
    if (run.origin === 'internal') return false;
    if (work) return true;
    if (run.orchestrationId) return true;
    return this.deps.runtime.heldToSchema(run.id);
  }

  /** Announces the limit and, for automated work, acts on it. Never throws: it runs from an event. */
  async onLimitHit(run: ChatRuntime, limitResetsAt: string | null): Promise<void> {
    const provider = run.provider ?? LEGACY_PROVIDER;
    const auth = this.deps.runtime.signInFailed(run.id);
    // Read now: the replay's launch clears it
    const credits = auth ? null : (this.deps.creditsStop?.(run.id) ?? null);
    // A sign-in failure is no limit: it has its notice below, and the account's own state says it needs signing in
    if (!auth) this.deps.emit({ type: 'run.rateLimited', title: `${run.name} hit its rate limit`, ...runRef(run), provider, resetsAt: limitResetsAt });
    // A sample is run again from scratch on whichever account has room: replaying it would mix two accounts' behaviour
    if (this.deps.evalSample?.(run.id)) return;
    // Housekeeping runs with no persisted session, so its `--resume` always fails (case C7 of
    // docs/plans/limit-resume-and-credits.md): it ends here, and whoever started it runs it again
    if (run.origin === 'internal') return;
    // An API client's request was answered with its 429 when the turn died (with `Retry-After`): the
    // client asks again when it wants. Moving or waiting would replay a turn for nobody and spend on
    // an account the client never chose
    if (run.origin === 'api') return;
    const work = this.deps.work?.(run.id) ?? null;
    const automated = this.isAutomated(run, work);
    // A person's chat moves to another account only when they asked for it; otherwise it has its banner
    if (!automated && !this.deps.runtime.rotatesOnLimit()) {
      if (auth) this.deps.runtime.notice(run.id, 'The sign-in of the chat\'s account expired; sign in to it again, or move the chat to another account.');
      return;
    }
    this.handling.add(run.id);
    try {
      // A person who wrote to the chat since its last wait took it over: that wait is over, and the
      // limit this turn hit is a new one. The unique open row would refuse its wait otherwise
      this.releaseIfTakenOver(run.id);
      // A run held to a schema that nobody waits for already handed its result over: replaying the
      // turn would spend for nobody. The flow registers its wait just after the limit is announced.
      if (automated && !work && (run.orchestrationId || this.deps.runtime.heldToSchema(run.id))) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (run.orchestrationId || !this.deps.awaiting?.(run.id)) {
          this.deps.runtime.notice(run.id, auth ? `The sign-in of ${provider}'s account expired; this turn is not replayed.` : `${provider} reached its usage limit; this turn is not replayed.`);
          return;
        }
      }
      const moved = await this.moveToAccount(run, auth, credits);
      if (moved.moved) return;
      // The accounts know when the first of them that can take the turn is back (`chooseNext`); else
      // the reset the account the turn died on gave (`limitResetOf`: that account's reading, or the refusal),
      // which may have passed by now: the wait then goes on at once
      const resetsAt = moved.waitUntil !== null ? new Date(moved.waitUntil).toISOString() : limitResetsAt;
      this.startWait(run, work, { decidedBy: 'setting', decisionId: null, reason: auth ? AUTH_WAIT : credits ? `its credits may not pay for the turn: ${CREDITS_STOP_WORDS[credits]}` : null, resetsAt, projectId: this.deps.projectOf(run.workingDir ?? run.cwd) });
    } catch (error) {
      const why = errorMessage(error);
      this.deps.runtime.notice(run.id, `Handling the ${auth ? 'sign-in failure' : 'usage limit'} failed: ${why}`);
      // Flows and tasks keep the run open while the rotation holds it: with neither a move nor a
      // wait behind it, nothing would ever end it. Waiting is all there is to fall back to.
      if (!this.waits.has(run.id)) {
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
  private async moveToAccount(run: ChatRuntime, auth = false, credits: CreditsStop | null = null): Promise<{ moved: boolean; waitUntil: number | null }> {
    const from = this.deps.runtime.accountOf(run.id);
    // The choice looks at which account can run the chat's model: read the lists it has not seen yet
    await this.deps.runtime.warmModels();
    const choice = this.deps.runtime.chooseNext(run.id);
    if (!from || !choice) return { moved: false, waitUntil: null };
    const to = choice.account;
    if (!to || to === from) {
      if (!to && run.model) this.deps.runtime.notice(run.id, `No other account can run ${run.model} now; the turn waits for one that can.`);
      this.record('wait', from, null, auth ? 'auth' : credits ? 'credits' : 'limit', run, { waitUntil: choice.waitUntil, ...(credits ? { credits } : {}) });
      return { moved: false, waitUntil: choice.waitUntil };
    }
    const resumed = await (this.deps.replay?.(run.id, to) ?? this.deps.runtime.replayLastTurn(run.id, to));
    if (!resumed) return { moved: false, waitUntil: choice.waitUntil };
    // A move off credits the setting refuses, or onto credits it allows, is the credits' doing
    const onCredits = !auth && choice.credits === true;
    this.record('switch', from, to, auth ? 'auth' : credits || onCredits ? 'credits' : (choice.reason ?? 'limit'), run, credits || onCredits ? { credits: credits ?? 'paid' } : null);
    const left = auth
      ? `The sign-in of account ${from} expired`
      : credits
        ? `Account ${from} has no plan quota left and its credits may not pay for this turn (${CREDITS_STOP_WORDS[credits]})`
        : `Account ${from} reached its usage limit`;
    this.deps.runtime.notice(run.id, `${left}; the turn goes on with account ${to}${onCredits ? ', paid from its credits' : ''}.`);
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
    const now = this.now();
    const at = new Date(now).toISOString();
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
      probeCount: 0,
    };
    move.nextLookAt = new Date(this.firstLook(move, now)).toISOString();
    // The turn that died goes into the row: a restart empties the chat's memory of it, not the row
    const turn = this.deps.runtime.limitTurnOf(run.id);
    if (!this.deps.db.insertProviderMove(move, turn ? JSON.stringify(turn) : null)) return null;
    this.waits.set(run.id, move.id);
    this.progress.set(move.id, progressOf(run));
    this.schedule();
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

  private maxWaitHours(move: Pick<ProviderMove, 'projectId'>): number {
    const project = move.projectId ? this.deps.projectProviders(move.projectId) : null;
    return effectiveOnLimit(this.deps.settings(), project).maxWaitHours;
  }

  /** Whether a wait asks `get_usage` when nothing said when its accounts reset: not a sign-in failure, which only a person mends */
  private probes(row: Pick<ProviderMove, 'reason'>): boolean {
    return !!this.deps.probe && row.reason !== AUTH_WAIT;
  }

  /**
   * When a new wait first looks: at its reset, a poll away at the latest (another account may get
   * room before it, R10). One with no reset known looks at its first probe, or at the poll, never
   * past its cap.
   */
  private firstLook(move: Pick<ProviderMove, 'at' | 'resetsAt' | 'reason' | 'projectId'>, now: number): number {
    if (move.resetsAt) return Math.min(Date.parse(move.resetsAt) + this.slackMs, now + this.pollMs);
    if (this.probes(move)) return now + (this.backoff[0] ?? this.pollMs);
    return Math.min(now + this.pollMs, Date.parse(move.at) + this.maxWaitHours(move) * HOUR_MS);
  }

  private drop(move: Pick<ProviderMove, 'id' | 'fromChat'>): void {
    this.refused.delete(move.id);
    this.progress.delete(move.id);
    this.probedAt.delete(move.id);
    if (this.waits.get(move.fromChat) === move.id) this.waits.delete(move.fromChat);
  }

  // ---------- the sweeper ----------

  /**
   * Sets the sweeper's one timer: the earliest look among the waits whose chat this process has (a
   * claim that holds a row counts until it lapses), `sweepMs` away at the latest. Another process's
   * rows are its own to look at; counting them would wake this one for nothing.
   */
  private schedule(): void {
    if (this.closing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    let next = now + this.sweepMs;
    try {
      for (const row of this.deps.db.openHolds()) {
        if (!this.deps.runtime.get(row.fromChat)) continue;
        const look = row.nextLookAt ? Date.parse(row.nextLookAt) : now;
        const claim = row.state === 'resuming' && row.claimedUntil ? Date.parse(row.claimedUntil) + 1 : null;
        next = Math.min(next, claim !== null && claim > now ? Math.max(claim, look) : look);
      }
    } catch {
      // A closed database (shutting down): nothing is left to look at
      return;
    }
    const timer = setTimeout(() => void this.sweep(), Math.min(Math.max(MIN_SWEEP_GAP_MS, next - now), MAX_TIMER_MS));
    timer.unref();
    this.timer = timer;
  }

  /**
   * One pass of the sweeper over the open waits: the due ones look again (`all`: every one, as an
   * account's new reading asks). One pass at a time; one asked for meanwhile follows it. Settles when
   * the pass and the replays it started have. Never throws.
   */
  sweep(all = false): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.passing) {
      this.again = all || this.again === 'all' ? 'all' : 'due';
      return this.passing;
    }
    const run = (async () => {
      let every = all;
      for (;;) {
        await this.pass(every);
        const again = this.again;
        this.again = null;
        if (!again || this.closing) return;
        every = again === 'all';
      }
    })().finally(() => {
      this.passing = null;
      this.schedule();
    });
    this.passing = run;
    this.track(run);
    return run;
  }

  private async pass(all: boolean): Promise<void> {
    let rows: OpenHold[];
    try {
      rows = this.deps.db.openHolds();
    } catch {
      return;
    }
    for (const row of rows) {
      if (this.closing) return;
      try {
        await this.look(row, all);
      } catch {
        // A closed database (shutting down) is not the wait's to report; a row that could not be
        // looked at waits a poll rather than be taken again in the next pass
        try {
          this.deps.db.scheduleProviderMove(row.id, new Date(this.now()).toISOString(), new Date(this.now() + this.pollMs).toISOString());
        } catch {
          /* closed */
        }
      }
    }
  }

  /** What one wait does at a pass: end, go on, probe, or say when it looks again. */
  private async look(row: OpenHold, all: boolean): Promise<void> {
    const now = this.now();
    const run = this.deps.runtime.get(row.fromChat);
    if (!run) {
      // A chat no process has any more can never be resumed, and its open row would refuse every
      // later wait for it (the unique index). One another process holds is that process's to look at
      if (!this.deps.db.storedChats([row.fromChat]).has(row.fromChat)) this.end(row, 'failed', CHAT_GONE);
      else this.drop(row);
      return;
    }
    // Ours from here on, whoever opened it: a restarted process takes its rows over at its first pass
    this.waits.set(row.fromChat, row.id);
    // A claim that holds the row: our replay under way, our refused resume's back-off, or another process's
    if (row.state === 'resuming' && row.claimedUntil !== null && Date.parse(row.claimedUntil) >= now) return;
    if (this.endIfTakenOver(row, run)) return;
    const due = !row.nextLookAt || Date.parse(row.nextLookAt) <= now;
    if (!due && !all) return;
    // An account with room ends any wait, whatever reset it began with; a sign-in failure has no
    // other way to end
    const room = await this.goOnIfRoom(row);
    if (room.resumed) return;
    const reset = room.reset;
    const nowIso = new Date(now).toISOString();
    if (reset) {
      const back = Date.parse(reset) + this.slackMs;
      if (now >= back) {
        await this.resume(row);
        return;
      }
      // A known reset holds however far off it is (D2); it is looked at a poll from now at the latest.
      // The window may start again before it (an early reset), which only `get_usage` would say: a
      // due look asks, sparsely, unless the reset comes first
      const probeAt = this.probes(row) ? this.resetProbeAt(row) : null;
      if (due && probeAt !== null && probeAt < back && now >= probeAt) {
        const count = (row.probeCount ?? 0) + 1;
        const after = now + this.resetGap(count);
        this.probe(row, run, now, Math.min(back, now + this.pollMs, after), this.probedAt.get(row.id) ?? Date.parse(row.updatedAt));
        return;
      }
      const next = probeAt !== null && probeAt < back ? Math.max(probeAt, now + MIN_SWEEP_GAP_MS) : back;
      this.deps.db.scheduleProviderMove(row.id, nowIso, new Date(Math.min(back, now + this.pollMs, next)).toISOString());
      return;
    }
    // No reset known. A look out of turn (a new reading) found no room: the row keeps its time
    if (!due) return;
    const cap = Date.parse(row.at) + this.maxWaitHours(row) * HOUR_MS;
    if (this.probes(row)) {
      // `maxWaitHours` ends the wait only once a probe past the cap answered nothing (cause 5)
      if (now >= cap && this.probedPast(row, cap)) {
        this.end(row, 'failed', 'limit-wait-expired');
        return;
      }
      const wait = this.backoff[Math.min((row.probeCount ?? 0) + 1, this.backoff.length - 1)] ?? this.pollMs;
      this.probe(row, run, now, now + wait, Date.parse(row.updatedAt));
      return;
    }
    if (now >= cap) this.end(row, 'failed', 'limit-wait-expired');
    else this.deps.db.scheduleProviderMove(row.id, nowIso, new Date(Math.min(now + this.pollMs, cap)).toISOString());
  }

  /** Whether the wait's last probe was taken past its cap: its `updated_at` is when it last looked, and a probe always looks. */
  private probedPast(row: OpenHold, cap: number): boolean {
    return (row.probeCount ?? 0) > 0 && Date.parse(row.updatedAt) >= cap;
  }

  /** The gap before probe number `n` (0: the first, counted from when the wait began) of a wait whose reset is known */
  private resetGap(n: number): number {
    return this.resetBackoff[Math.min(n, this.resetBackoff.length - 1)] ?? HOUR_MS;
  }

  /**
   * When a wait whose reset is known next asks `get_usage`: a gap after its last probe. A process
   * that does not remember that probe (a restart) counts the gaps from when the wait began, so a
   * long sleep costs one probe at once, never one per missed gap.
   */
  private resetProbeAt(row: Pick<ProviderMove, 'id' | 'at' | 'probeCount'>): number {
    const count = row.probeCount ?? 0;
    const last = this.probedAt.get(row.id);
    if (last !== undefined) return last + this.resetGap(count);
    let at = Date.parse(row.at);
    for (let n = 0; n <= count; n++) at += this.resetGap(n);
    return at;
  }

  /**
   * Asks `get_usage` for the accounts the waiting chat could go on with whose reading is not newer than
   * `since`, in the background: the row says first when it looks again (`next`), so a probe that hangs
   * or a restart in the middle costs one look, never a loop. What the accounts answer reaches the
   * waits as any reading does.
   */
  private probe(row: OpenHold, run: ChatRuntime, now: number, next: number, since: number): void {
    const probe = this.deps.probe;
    this.deps.db.scheduleProviderMove(row.id, new Date(now).toISOString(), new Date(next).toISOString(), { probed: true });
    if (!probe || this.probing.has(row.id)) return;
    this.probing.add(row.id);
    const work = probe(run.id, since)
      .catch(() => undefined)
      .then(() => {
        // From now on a reading older than this is no news to the next probe
        const open = this.deps.db.providerMove(row.id);
        if (!open || (open.state !== 'waiting' && open.state !== 'resuming')) return;
        const settled = this.now();
        this.probedAt.set(row.id, settled);
        if (open.nextLookAt) this.deps.db.scheduleProviderMove(row.id, new Date(settled).toISOString(), open.nextLookAt);
      })
      .catch(() => undefined)
      .finally(() => {
        this.probing.delete(row.id);
        if (!this.closing) this.recheckSoon();
      });
    this.track(work);
  }

  /**
   * Looks for an account with room for a waiting chat and, when one has it, goes on there. What every
   * look, every reset and every change of an account's reading or state comes to. Otherwise the
   * reset the wait now knows: the one it began with, or an earlier one a reading gave since, which
   * the row keeps.
   */
  private async goOnIfRoom(row: ProviderMove): Promise<{ resumed: boolean; reset: string | null }> {
    const room = this.deps.runtime.roomFor(row.fromChat, Date.parse(row.at));
    if (room?.account) {
      await this.resume(row, room.account);
      return { resumed: true, reset: row.resetsAt };
    }
    // Every account is still out, but one may now say it is back sooner than the wait thought. A
    // reading of whichever account ran last is no evidence: it resumed waits on accounts still out
    // before 2026-10-29; `roomFor` reads only the accounts the chat can go on with
    if (room?.waitUntil && row.reason !== AUTH_WAIT && (!row.resetsAt || room.waitUntil < Date.parse(row.resetsAt))) {
      const learned = new Date(room.waitUntil).toISOString();
      const now = this.now();
      this.deps.db.scheduleProviderMove(row.id, new Date(now).toISOString(), new Date(Math.min(room.waitUntil + this.slackMs, now + this.pollMs)).toISOString(), { resetsAt: learned });
      return { resumed: false, reset: learned };
    }
    return { resumed: false, reset: row.resetsAt };
  }

  /** An account's reading or state changed: every open wait asks the accounts again, once for a burst. */
  private recheckSoon(): void {
    if (this.recheckQueued || this.closing) return;
    this.recheckQueued = true;
    setImmediate(() => {
      this.recheckQueued = false;
      void this.sweep(true);
    });
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
      if (!this.deps.db.storedChats([row.fromChat]).has(row.fromChat)) this.end(row, 'failed', CHAT_GONE);
      else this.drop(row);
      return false;
    }
    // The person decides for their own click; the rotation never replays a turn over one they started
    if (decidedBy === 'rotation' && this.endIfTakenOver(row, run)) return false;
    const claimedAt = this.now();
    if (!this.deps.db.claimProviderMove(row.id, new Date(claimedAt).toISOString(), new Date(claimedAt + this.claimMs).toISOString())) {
      // Our own refused claim has not lapsed yet: the wait is still ours and looks again then. Any
      // other claim is another process's, and the sweeper looks at the row once it lapses
      if (!this.refused.has(row.id)) this.drop(row);
      return false;
    }
    this.resuming.add(run.id);
    try {
      return await this.replayClaimed(row, run, account, decidedBy);
    } finally {
      this.resuming.delete(run.id);
    }
  }

  /** The replay of a wait this process claimed, and the end of the wait. */
  private async replayClaimed(row: ProviderMove, run: ChatRuntime, account: string | undefined, decidedBy: 'rotation' | 'person'): Promise<boolean> {
    const from = this.deps.runtime.accountOf(run.id);
    let replayed = false;
    let reason: string | null = null;
    try {
      const own = this.deps.replay?.(run.id, account) ?? null;
      if (own) {
        replayed = await own;
        if (!replayed) reason = 'its work could not be resumed';
      } else {
        // A restart emptied the chat's memory of the turn that died; the row kept it
        replayed = await this.deps.runtime.replayLastTurn(run.id, account, turnOf(this.deps.db.providerMoveTurn(row.id)));
        // A row with no turn (opened by an older Claudio): the session resumes with a nudge instead
        if (!replayed) {
          this.deps.runtime.send(run.id, LIMIT_CONTINUE_TEXT);
          replayed = true;
        }
      }
    } catch (error) {
      // A full run table or a short memory clears within moments: the wait looks again instead of ending
      // failed with the person's turn lost (case C8)
      if (isTransientRefusal(error) && this.holdOff(row, run, error)) {
        if (decidedBy === 'person') throw error;
        return false;
      }
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

  /**
   * Keeps a wait whose resume the runtime refused for room. The claim the resume took stays: it is
   * the back-off, and no other process can take the row before it lapses. False once the refusals
   * have lasted `maxWaitHours`, when the wait ends failed as before.
   */
  private holdOff(row: ProviderMove, run: ChatRuntime, error: Error): boolean {
    const now = this.now();
    const first = !this.refused.has(row.id);
    const since = this.refused.get(row.id)?.since ?? now;
    if (now - since >= this.maxWaitHours(row) * HOUR_MS) return false;
    this.refused.set(row.id, { since, until: now + this.claimMs });
    this.waits.set(row.fromChat, row.id);
    this.deps.db.scheduleProviderMove(row.id, new Date(now).toISOString(), new Date(now + this.claimMs + 1).toISOString());
    this.schedule();
    if (first) this.deps.runtime.notice(run.id, `The usage limit reset, but Claudio cannot start the turn yet (${errorMessage(error)}); it looks again in ${String(Math.max(1, Math.round(this.claimMs / 60_000)))} min.`);
    return true;
  }

  /** Whether a person took a person's chat over since its wait began: a turn started on it, or one is running. */
  private tookOver(row: ProviderMove, run: ChatRuntime): boolean {
    if (this.isAutomated(run, this.deps.work?.(run.id) ?? null)) return false;
    const base = this.progress.get(row.id);
    if (!base) {
      // A wait this process did not begin (a restart): from here on is what counts
      this.progress.set(row.id, progressOf(run));
      return false;
    }
    const now = progressOf(run);
    return now.turns > base.turns || (now.busy && !base.busy);
  }

  /** Ends the wait of a person's chat the person took over. True when it did. */
  private endIfTakenOver(row: ProviderMove, run = this.deps.runtime.get(row.fromChat)): boolean {
    if (!run || !this.tookOver(row, run)) return false;
    this.end(row, 'cancelled', TOOK_OVER);
    return true;
  }

  /**
   * A person sent a message to a chat that waits: they took it over, and the wait ends before anything
   * can replay over their words. The sweeper would find it too, a look later.
   */
  private personWrote(chatId: string): void {
    if (this.resuming.has(chatId) || this.handling.has(chatId)) return;
    try {
      const id = this.waits.get(chatId);
      const row = id ? this.deps.db.providerMove(id) : null;
      const run = this.deps.runtime.get(chatId);
      if (!row || !run || (row.state !== 'waiting' && row.state !== 'resuming')) return;
      // A task's or a flow's chat is not the person's: a message to it does not stop its wait
      if (this.isAutomated(run, this.deps.work?.(chatId) ?? null)) return;
      this.end(row, 'cancelled', TOOK_OVER);
    } catch {
      // A closed database (shutting down) is not the wait's to report
    }
  }

  private releaseIfTakenOver(chatId: string): void {
    const id = this.waits.get(chatId);
    const row = id ? this.deps.db.providerMove(id) : null;
    if (row && (row.state === 'waiting' || row.state === 'resuming')) this.endIfTakenOver(row);
  }

  private end(row: ProviderMove, end: WaitEnd, reason: string | null): boolean {
    const state = end === 'resumed' ? 'resumed' : end === 'failed' ? 'failed' : 'cancelled';
    const closed = this.deps.db.closeProviderMove(row.id, state, new Date(this.now()).toISOString(), { reason });
    this.drop(row);
    if (!closed) return false;
    if (end === 'failed') this.deps.runtime.notice(row.fromChat, reason === 'limit-wait-expired' ? 'The wait for the usage limit to reset ran out.' : `The wait ended: ${reason ?? 'it failed'}.`);
    this.deps.ended?.({ ...row, state, reason: reason ?? row.reason, nextLookAt: null }, end, reason);
    return true;
  }

  /** A person stops waiting; the run or task it belonged to then ends stopped. False when the wait was not open. */
  cancel(moveId: string): boolean {
    const row = this.deps.db.providerMove(moveId);
    if (!row || (row.state !== 'waiting' && row.state !== 'resuming')) return false;
    return this.end(row, 'cancelled', 'stopped waiting');
  }

  /**
   * After a start-up, once this process's chats are back: takes over the open rows whose chat it
   * restored (so `holds` and `waitOf` answer for them at once), closes the rows of chats no process
   * has, and runs a pass of the sweeper, which resumes what fell due while the process was down. A
   * claim a restart cut short is taken again once it lapses. Rows another process restored are left
   * to it.
   */
  recover(): Promise<void> {
    try {
      for (const row of this.deps.db.openHolds()) {
        const run = this.deps.runtime.get(row.fromChat);
        if (run) {
          this.waits.set(row.fromChat, row.id);
          if (!this.progress.has(row.id)) this.progress.set(row.id, progressOf(run));
        } else if (!this.deps.db.storedChats([row.fromChat]).has(row.fromChat)) this.end(row, 'failed', CHAT_GONE);
      }
    } catch {
      // A closed database (shutting down): nothing may start anyway
      return Promise.resolve();
    }
    return this.sweep();
  }
}
