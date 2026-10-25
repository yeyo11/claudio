import { randomUUID } from 'node:crypto';
import { ChatNotFoundError } from './chat-errors.ts';
import {
  COMPACT_FOCUS_MAX,
  type Chat,
  type ChatCompactAvailability,
  type ChatCompaction,
  type ChatContextUsage,
  type ChatMessageReceipt,
  type ChatMessageRequest,
  type CompactChatRequest,
  type CompactionFailure,
  type CompactionOrigin,
  type CompactRefusal,
  type ContextBreakdown,
  type ContextDetail,
  type ResumeChatRequest,
  type TranscriptEntry,
} from '@claudio/shared';
import type { ChatService } from './chat-service.ts';
import type { ChatManager } from './chats.ts';
import { ChatNotes, compactText, ContextRefusal, TYPED_COMPACT } from './context-notes.ts';
import { COMPACTION_LEASE_MS, type Db } from './db.ts';
import type { ClaudioEventInput } from './events.ts';
import { runRef } from './event-sources.ts';
import type { ContextSignal, ExecutionExtras, RunResult } from './live-chat.ts';
import type { DriverEvent } from './providers/driver.ts';
import { parseContextUsage, unreportedOf } from './providers/claude-code/context-usage.ts';

export { ContextRefusal } from './context-notes.ts';

/** How long an answer of `get_context_usage` is reused, so several tabs do not each ask the CLI */
export const CONTEXT_USAGE_CACHE_MS = 5_000;

/** What a compaction closes as, other than the CLI's own success */
type Closing = { state: 'failed'; failure: CompactionFailure; error: string | null } | { state: 'cancelled'; failure: 'interrupted' | 'stopped' };

/** The states a compaction row can leave: every one, since a cost reported after the boundary lands on a closed row */
const ANY_STATE: ChatCompaction['state'][] = ['requested', 'running', 'done', 'failed', 'cancelled'];

/** What a flow asks of `compactAndWait`: the run's own options, minus its schema (a compaction is not held to one) */
export interface CompactAndWaitOptions {
  flowRunId: string;
  options?: Omit<ResumeChatRequest, 'prompt' | 'attachments'> & ExecutionExtras;
  focus?: string;
  structuredNote?: boolean;
}

export interface ContextControlDeps {
  db: Db;
  runtime: ChatManager;
  chats: ChatService;
  /** A running flow run works on the chat */
  flowOwns(chatId: string): boolean;
  /** A running assistant run works on the chat */
  assistantOwns(chatId: string): boolean;
  /** The rotation holds the chat's usage limit: a wait is open */
  limitHeld?(chatId: string): boolean;
  notes: ChatNotes;
  emit(event: ClaudioEventInput): void;
  /** A failed or lost compaction is worth a line; core has no logger of its own, so whoever has one passes it */
  log?(message: string): void;
}

/** The compaction a turn is for: what the result will charge, and what the cost of the process was before it */
interface Turn {
  id: string;
  costBefore: number | null;
}

const iso = (ms = Date.now()): string => new Date(ms).toISOString();
const round = (usd: number): number => Math.round(usd * 1e8) / 1e8;

/**
 * What a person can see and ask of a chat's context window: the live breakdown, Compact now, and the
 * rows that record every compaction (docs/plans/context-control.md). Compaction is only ever offered
 * to the person (D1): nothing here sends `/compact` except the button, a typed `/compact`, and the
 * flow's decision point through {@link compactAndWait}.
 */
export class ContextControl {
  /** The request under way per chat and detail: whoever asks meanwhile shares it */
  private readonly reading = new Map<string, Promise<ChatContextUsage>>();
  private readonly cache = new Map<string, { at: number; breakdown: ContextBreakdown; detail: ContextDetail }>();
  /** The compaction each chat's housekeeping turn is for, until its result */
  private readonly turns = new Map<string, Turn>();
  /** Who waits for a row to close (`compactAndWait`) */
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly deps: ContextControlDeps) {
    // At boot: what a dead process left open and whose lease has passed is closed as lost
    try {
      deps.db.sweepHousekeeping(iso());
    } catch {
      // the database is closing: nothing is left to sweep
    }
    deps.runtime.on('chat-context', (chatId: string, signal: ContextSignal) => this.onEvent(chatId, signal));
  }

  // ---------- the breakdown ----------

  /**
   * What fills the chat's window, asked of the live process. A chat with no process of ours is a
   * state, not an error, and so is a CLI that cannot or will not answer: the snapshot from the
   * transcript is always there.
   */
  async usage(chatId: string, detail: ContextDetail = 'summary'): Promise<ChatContextUsage> {
    const chat = await this.deps.chats.get(chatId);
    if (!chat) throw new ChatNotFoundError();
    const base = { snapshot: chat.context, observedAt: iso() };
    const runtime = this.deps.runtime.get(chatId);
    if (runtime?.pid == null) return { live: false, unreported: 'no-process', detail: null, breakdown: null, ...base };
    // `full` calls the token-count API once per category: only while nothing else is going on
    const effective: ContextDetail = detail === 'full' && chat.state !== 'idle' ? 'summary' : detail;
    const key = `${chatId}\0${effective}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CONTEXT_USAGE_CACHE_MS) {
      return { live: true, unreported: null, detail: cached.detail, breakdown: cached.breakdown, snapshot: chat.context, observedAt: iso(cached.at) };
    }
    const pending = this.reading.get(key);
    if (pending) return { ...(await pending), snapshot: chat.context };
    const read = (async (): Promise<ChatContextUsage> => {
      try {
        const raw = await this.deps.runtime.contextUsage(chatId, effective);
        if (!raw) return { live: false, unreported: 'no-process', detail: null, breakdown: null, ...base };
        const breakdown = parseContextUsage(raw);
        this.cache.set(key, { at: Date.now(), breakdown, detail: effective });
        return { live: true, unreported: null, detail: effective, breakdown, ...base };
      } catch (err) {
        return { live: true, unreported: unreportedOf(err), detail: null, breakdown: null, ...base };
      }
    })();
    this.reading.set(key, read);
    try {
      return await read;
    } finally {
      this.reading.delete(key);
    }
  }

  // ---------- Compact now ----------

  /** The first refusal that applies, in the order the plan fixes, or none */
  availability(chat: Chat): ChatCompactAvailability {
    const { db } = this.deps;
    const refuse = (refusal: CompactRefusal, open: ChatCompaction | null = null): ChatCompactAvailability => ({ available: false, refusal, open });
    if (chat.origin === 'internal') return refuse('housekeeping');
    if (chat.control.mode === 'readOnly') return refuse('read-only');
    if (!chat.context && chat.messageCount === 0) return refuse('no-history');
    // An environment not known yet does not refuse: a CLI refusal then fails the row
    if (chat.environment && !chat.environment.slashCommands.includes('compact')) return refuse('unsupported');
    if (chat.atLimit || this.deps.limitHeld?.(chat.id)) return refuse('at-limit');
    if (this.deps.flowOwns(chat.id) || this.deps.assistantOwns(chat.id)) return refuse('run');
    let open = db.openCompaction(chat.id);
    let pendingNote = this.deps.notes.pendingOf(chat.id);
    if (open || pendingNote) {
      // A row whose lease passed belongs to a process that is gone: closed here rather than refusing for ever
      db.sweepHousekeeping(iso());
      open = db.openCompaction(chat.id);
      pendingNote = this.deps.notes.pendingOf(chat.id);
      if (open || pendingNote) return refuse('open', open);
    }
    if (chat.state === 'waiting') return refuse('waiting');
    const runtime = this.deps.runtime.get(chat.id);
    if (chat.state === 'working' || runtime?.status === 'starting') return refuse('busy');
    return { available: true, refusal: null, open: null };
  }

  /** `availability` of a chat read now */
  private async check(chatId: string): Promise<Chat> {
    const chat = await this.deps.chats.get(chatId, { fresh: true });
    if (!chat) throw new ChatNotFoundError();
    const { refusal } = this.availability(chat);
    if (refusal) throw new ContextRefusal(refusal);
    return chat;
  }

  /** Throws a `ContextRefusal` when a note turn cannot start on the chat; the notes service asks it */
  async assertAvailable(chatId: string): Promise<void> {
    await this.check(chatId);
  }

  /** Writes a housekeeping turn to the chat: to its live process, or by resuming it with the options of its last execution */
  async startTurn(chatId: string, text: string, purpose: 'compact' | 'note', options: Partial<ResumeChatRequest & ExecutionExtras> = {}): Promise<void> {
    const live = this.deps.runtime.get(chatId)?.pid != null;
    if (live) {
      this.deps.runtime.sendMessage(chatId, text, [], undefined, purpose);
      return;
    }
    // A confined or assistant chat stays confined; the schema of a run is left behind
    await this.deps.chats.resume(chatId, { ...options, prompt: text }, { ...this.deps.runtime.executionExtrasOf(chatId), ...options, housekeeping: purpose });
  }

  /** `POST /chats/:id/compact`: claims the chat's housekeeping slot and sends `/compact`; the row says how it goes */
  async compact(chatId: string, request: CompactChatRequest, actor: string | null = null): Promise<ChatCompaction> {
    const body: unknown = request ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) throw new Error('the body must be an object');
    const { focus: rawFocus, structuredNote: rawStructured } = body as Record<string, unknown>;
    if (rawFocus !== undefined && typeof rawFocus !== 'string') throw new Error('focus must be a string');
    const focus = typeof rawFocus === 'string' ? rawFocus.trim() : '';
    if (focus.length > COMPACT_FOCUS_MAX) throw new Error(`focus must be at most ${String(COMPACT_FOCUS_MAX)} characters`);
    if (rawStructured !== undefined && typeof rawStructured !== 'boolean') throw new Error('structuredNote must be a boolean');
    await this.check(chatId);
    const row = this.claim(chatId, { origin: 'person', focus: focus || null, structuredNote: rawStructured ?? true, flowRunId: null, requestedBy: actor });
    try {
      await this.startTurn(chatId, compactText(row.focus, row.structuredNote), 'compact');
    } catch (err) {
      this.close(row.id, { state: 'failed', failure: 'not-started', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return this.deps.db.compactionById(row.id) ?? row;
  }

  /**
   * A `/compact` typed into an idle chat goes the way the button does, with origin `typed` and no
   * note (E4); the text is sent as typed. Null when the chat cannot take one now: it is then an
   * ordinary message, and only a boundary, if one comes, is recorded (E5).
   */
  async sendTyped(chatId: string, request: ChatMessageRequest): Promise<ChatMessageReceipt | null> {
    const text = request.text ?? '';
    if (!TYPED_COMPACT.test(text.trim())) return null;
    const chat = await this.deps.chats.get(chatId, { fresh: true });
    if (!chat || chat.control.mode !== 'interactive' || this.availability(chat).refusal) return null;
    const focus = text.trim().replace(TYPED_COMPACT, '').trim();
    const row = this.claim(chatId, { origin: 'typed', focus: focus || null, structuredNote: false, flowRunId: null, requestedBy: null });
    try {
      return this.deps.runtime.sendMessage(chatId, text, [], request.id, 'compact');
    } catch (err) {
      this.close(row.id, { state: 'failed', failure: 'not-started', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Compacts a chat for the flow, before its run takes it, and answers when the row has closed (or
   * the lease has run out) and the process has gone. Never rejects: the caller goes on uncompacted.
   */
  async compactAndWait(chatId: string, opts: CompactAndWaitOptions): Promise<ChatCompaction | null> {
    let row: ChatCompaction | null = null;
    try {
      await this.check(chatId);
      const structured = opts.structuredNote ?? true;
      row = this.claim(chatId, { origin: 'flow', focus: opts.focus ?? null, structuredNote: structured, flowRunId: opts.flowRunId, requestedBy: null });
      const closed = this.closed(row.id);
      // The run's own options, never its schema, and the process ends with the turn
      const { jsonSchema: _schema, ...options } = (opts.options ?? {}) as NonNullable<CompactAndWaitOptions['options']> & { jsonSchema?: unknown };
      await this.startTurn(chatId, compactText(row.focus, structured), 'compact', { ...options, keepAlive: false });
      await closed;
      await this.deps.runtime.exited(chatId);
      return this.deps.db.compactionById(row.id);
    } catch (err) {
      this.deps.log?.(`the compaction before a flow run on chat ${chatId} did not happen: ${err instanceof Error ? err.message : String(err)}`);
      if (row) this.close(row.id, { state: 'failed', failure: 'not-started', error: err instanceof Error ? err.message : String(err) });
      return row ? this.deps.db.compactionById(row.id) : null;
    }
  }

  /** Resolves when the row leaves its open states, or when its lease would have passed */
  private closed(id: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(), COMPACTION_LEASE_MS);
      timer.unref();
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), finish]);
    });
  }

  /** The chat's one housekeeping slot, or a refusal `open` when another process holds it */
  private claim(chatId: string, row: { origin: CompactionOrigin; focus: string | null; structuredNote: boolean; flowRunId: string | null; requestedBy: string | null }): ChatCompaction {
    const now = Date.now();
    const claimed = this.deps.db.claimHousekeeping(
      chatId,
      { kind: 'compaction', leaseUntil: iso(now + COMPACTION_LEASE_MS), row: { id: randomUUID(), requestedAt: iso(now), ...row } },
      iso(now),
    );
    if (!claimed) throw new ContextRefusal('open');
    const compaction = claimed as ChatCompaction;
    // What the CLI reports for the turn is cumulative over its process: the cost of this one is the difference
    this.turns.set(chatId, { id: compaction.id, costBefore: this.deps.runtime.get(chatId)?.costUsd ?? null });
    return compaction;
  }

  // ---------- what the chat's process says ----------

  /** Fed by the runtime with what the process of a chat reports; the rows follow it */
  onEvent(chatId: string, signal: ContextSignal): void {
    try {
      this.read(chatId, signal);
    } catch (err) {
      // The database closed while the process was still draining: the rows are all that is lost
      this.deps.log?.(`context control could not follow chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private read(chatId: string, signal: ContextSignal): void {
    const { db } = this.deps;
    switch (signal.kind) {
      case 'driver': {
        const { event } = signal;
        if (event.kind === 'compacting') {
          if (!event.active) return;
          const open = db.openCompaction(chatId);
          if (!open) return;
          // The status repeats while it works: it keeps the lease, and only the first one is news
          const first = open.state === 'requested';
          db.updateCompaction(open.id, { state: 'running', ...(first ? { startedAt: iso() } : {}), leaseUntil: iso(Date.now() + COMPACTION_LEASE_MS) }, { from: ['requested', 'running'] });
          if (first) this.announce(chatId, 'is compacting');
          return;
        }
        if (event.kind === 'compacted') return this.compacted(chatId, event);
        const open = db.openCompaction(chatId);
        // An automatic attempt the CLI gave up on (`too_few_groups` on a short chat) is not a failure of anything asked for
        if (!open) return;
        const text = event.error ?? 'Claude Code reported that the compaction failed';
        if (signal.interrupted) this.close(open.id, { state: 'cancelled', failure: 'interrupted' });
        else if (signal.stopped) this.close(open.id, { state: 'cancelled', failure: 'stopped' });
        else this.fail(chatId, open.id, 'cli', text);
        return;
      }
      case 'summary': {
        const row = this.turns.get(chatId);
        const compaction = row ? db.compactionById(row.id) : null;
        if (compaction) this.deps.notes.fromCompaction(compaction, signal.entry);
        return;
      }
      case 'result':
        return this.resulted(chatId, signal.result, signal.interrupted);
      case 'ended': {
        this.deps.notes.onEnded(chatId, signal.error);
        const open = db.openCompaction(chatId);
        if (open) {
          if (signal.stopped) this.close(open.id, { state: 'cancelled', failure: 'stopped' });
          else this.fail(chatId, open.id, 'process-ended', signal.error ?? 'the process ended during the compaction');
        }
        this.turns.delete(chatId);
        return;
      }
    }
  }

  private compacted(chatId: string, event: Extract<DriverEvent, { kind: 'compacted' }>): void {
    const { db } = this.deps;
    this.cache.forEach((_, key) => {
      if (key.startsWith(`${chatId}\0`)) this.cache.delete(key);
    });
    // Already recorded: the same boundary read twice
    if (event.uuid && db.compactionByBoundary(event.uuid)) return;
    const figures = { trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens, durationMs: event.durationMs, boundaryUuid: event.uuid, endedAt: iso() };
    const open = db.openCompaction(chatId);
    if (open) {
      if (db.updateCompaction(open.id, { state: 'done', ...figures }, { from: ['requested', 'running'] })) {
        if (this.turns.get(chatId)?.id !== open.id) this.turns.set(chatId, { id: open.id, costBefore: null });
        this.settled(open.id);
      }
    } else {
      // The CLI's own (automatic, or typed in a terminal, or typed while the chat worked): over already, so it takes no slot
      const now = iso();
      const id = randomUUID();
      db.insertCompaction({
        id,
        chatId,
        origin: event.trigger === 'manual' ? 'typed' : 'cli',
        state: 'done',
        trigger: event.trigger ?? 'auto',
        focus: null,
        structuredNote: false,
        flowRunId: null,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        durationMs: event.durationMs,
        costUsd: null,
        failure: null,
        error: null,
        boundaryUuid: event.uuid,
        noteId: null,
        requestedAt: now,
        startedAt: now,
        endedAt: now,
      });
      this.turns.set(chatId, { id, costBefore: null });
    }
    this.announce(chatId, 'was compacted');
  }

  /** A housekeeping turn ended: what it cost, and whether it did what it was for */
  private resulted(chatId: string, result: RunResult, interrupted: boolean): void {
    if (result.purpose === 'note') {
      this.deps.notes.onResult(chatId, result);
      return;
    }
    const turn = this.turns.get(chatId);
    this.turns.delete(chatId);
    if (!turn) return;
    const row = this.deps.db.compactionById(turn.id);
    if (!row) return;
    if (row.state === 'requested' || row.state === 'running') {
      // No boundary came. The recorded cases: an empty chat answers with an assistant text and a plain result (F13), a budget or a limit ends it as an error
      const text = this.deps.runtime.get(chatId)?.lastText?.trim();
      if (interrupted) this.close(row.id, { state: 'cancelled', failure: 'interrupted' });
      else if (result.cause === 'stopped') this.close(row.id, { state: 'cancelled', failure: 'stopped' });
      else if (result.cause === 'budget') this.fail(chatId, row.id, 'budget', result.result || 'the chat reached its budget');
      else if (result.cause === 'rate-limit') this.fail(chatId, row.id, 'limit', result.result || 'the usage limit was reached');
      else this.fail(chatId, row.id, 'cli', (result.isError ? result.result : text) || 'Claude Code did not compact the conversation');
    }
    // Only what the CLI reported: the difference of its running total over the process, never an estimate
    if (turn.costBefore !== null && result.costUsd > turn.costBefore && row.origin !== 'cli') {
      this.deps.db.updateCompaction(row.id, { costUsd: round(result.costUsd - turn.costBefore) }, { from: ANY_STATE });
    }
    this.settled(row.id);
    this.announce(chatId, 'finished compacting');
  }

  private fail(chatId: string, id: string, failure: CompactionFailure, error: string): void {
    if (!this.close(id, { state: 'failed', failure, error })) return;
    this.deps.log?.(`the compaction of chat ${chatId} failed (${failure}): ${error}`);
    this.deps.runtime.notice(chatId, `Compaction failed: ${error}`, { code: 'compaction.failed', failure, error });
  }

  /** Closes an open row once; false when something else closed it first */
  private close(id: string, closing: Closing): boolean {
    const changed = this.deps.db.updateCompaction(
      id,
      {
        state: closing.state,
        failure: closing.failure,
        error: closing.state === 'failed' ? closing.error : null,
        endedAt: iso(),
      },
      { from: ['requested', 'running'] },
    );
    if (changed) this.settled(id);
    return changed;
  }

  /** Whoever waited for the row to close hears it did */
  private settled(id: string): void {
    const row = this.deps.db.compactionById(id);
    if (!row || row.state === 'requested' || row.state === 'running') return;
    const waiting = this.waiters.get(id);
    this.waiters.delete(id);
    for (const done of waiting ?? []) done();
  }

  /** Tells whoever follows the chat to read its `context` and `compact` again */
  private announce(chatId: string, what: string): void {
    const run = this.deps.runtime.get(chatId);
    if (!run) return;
    this.deps.emit({
      type: 'run.updated',
      title: `${run.name} ${what}`,
      ...runRef(run),
      status: run.status,
      previousStatus: null,
      turns: run.turns,
      costUsd: run.costUsd,
      pendingPrompts: run.pendingPrompts ?? 0,
    });
  }

  // ---------- reading the rows ----------

  compactions(chatId: string): ChatCompaction[] {
    return this.deps.db.compactions(chatId);
  }

  /**
   * A page of the transcript was read: a structured compaction whose summary was not streamed keeps
   * its note now, from the summary entry that follows its boundary (E34).
   */
  sawEntries(chatId: string, entries: TranscriptEntry[]): void {
    try {
      entries.forEach((entry, at) => {
        const next = entries[at + 1];
        if (entry.compaction?.part !== 'boundary' || next?.compaction?.part !== 'summary') return;
        const row = this.deps.db.compactionByBoundary(entry.uuid);
        if (row && row.chatId === chatId && row.structuredNote && !row.noteId) this.deps.notes.fromCompaction(row, next);
      });
    } catch {
      // the page is read all the same
    }
  }
}
