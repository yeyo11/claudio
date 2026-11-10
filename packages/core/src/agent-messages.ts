import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeNextResponse, BridgeReport, ChatMessageSource, ChatPendingMessage, MessageDelivery, MessageUndeliveredReason, SubagentMessageReceipt } from '@claudio/shared';

/**
 * Messages written straight to one subagent of a chat (docs/agent-messages.md, D2 of
 * docs/plans/agent-messages.md). Claudio keeps the queue, as rows, so a reload of the page or of the
 * server still finds each one; the chat's `claudio-bridge` mod only carries them: it long-polls
 * `next`, hands each to `$.session.send`, and reports what the CLI answered.
 *
 * A row's state: `written` (in Claudio's queue), `taken` (handed to the mod, its answer not in yet),
 * `delivered`, or `undelivered` with a reason. The page sees `written` and `taken` alike, as
 * `written`: both are still on their way.
 */

/** No poll from the chat's bridge for this long while a message waits: the bridge is not there */
export const BRIDGE_UNAVAILABLE_MS = 15_000;
/** The longest a poll may be held: one `$.http.fetch` of the mod may take 30 s in all */
export const BRIDGE_WAIT_MAX_S = 25;
/** Lost messages listed for a chat, the newest: the page offers each back */
const MAX_UNDELIVERED = 20;

export const BRIDGE_UNAVAILABLE = "Claudio could not reach this chat's bridge: it asked for no message for 15 s";
const NOT_READ = 'the subagent did not take it';
const CANCELLED = 'withdrawn before the bridge took it';

type RowState = 'written' | 'taken' | 'delivered' | 'undelivered';

interface Row {
  id: string;
  chat_id: string;
  agent_id: string;
  source: string;
  words: string;
  text: string;
  state: RowState;
  reason_code: string | null;
  reason: string | null;
  sent_at: string;
  taken_at: string | null;
  delivered_at: string | null;
  dismissed: number;
}

const COLUMNS = 'id, chat_id, agent_id, source, words, text, state, reason_code, reason, sent_at, taken_at, delivered_at, dismissed';

/** One message to a subagent, as core reads it back */
export interface AgentMessage {
  id: string;
  chatId: string;
  agentId: string;
  source: ChatMessageSource;
  /** The words without Claudio's frame */
  words: string;
  /** What the subagent is given: the frame and the words */
  text: string;
  state: RowState;
  reasonCode: MessageUndeliveredReason | null;
  reason: string | null;
  sentAt: string;
  takenAt: string | null;
  deliveredAt: string | null;
}

const SOURCES: readonly ChatMessageSource[] = ['person', 'supervisor', 'claudio'];
const CODES: readonly MessageUndeliveredReason[] = ['cancelled', 'not-read', 'bridge-unavailable', 'agent-stopped'];

function messageOf(r: Row): AgentMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    agentId: r.agent_id,
    source: SOURCES.find((s) => s === r.source) ?? 'person',
    words: r.words,
    text: r.text,
    state: r.state,
    reasonCode: CODES.find((c) => c === r.reason_code) ?? null,
    reason: r.reason,
    sentAt: r.sent_at,
    takenAt: r.taken_at,
    deliveredAt: r.delivered_at,
  };
}

/** What the page sees of one: the words, never the frame, and who it is for */
export function agentPendingView(m: AgentMessage): ChatPendingMessage {
  return {
    id: m.id,
    text: m.words,
    attachments: [],
    state: m.state === 'undelivered' ? 'undelivered' : 'written',
    sentAt: m.sentAt,
    source: m.source,
    ...(m.state === 'undelivered' && m.reason ? { reason: m.reason } : {}),
    to: { agentId: m.agentId },
  };
}

/** A refusal the API answers with its status, and `reason` as the answer's `code` */
export class AgentMessageRefusal extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409,
    readonly reason: 'message-unknown' | 'taken' | 'agent-stopped',
  ) {
    super(message);
  }
}

/** What the store needs of the chats */
export interface AgentMessageHost {
  /** Streams one message's fate on the chat's own stream, as `delivery` events */
  delivery(chatId: string, delivery: MessageDelivery): void;
  /** The person stopped that subagent: the CLI will not resume it, so a message to it is never handed out */
  agentStopped(chatId: string, agentId: string): boolean;
}

export class AgentMessages {
  /** When each chat's bridge last asked for messages, in this process: a poll's time is not worth a row */
  private readonly polls = new Map<string, number>();
  /** Polls held open, by chat: each is woken when a message arrives */
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The chats with a row the page lists, so a chat with none costs no query on every read */
  private readonly listed = new Set<string>();

  constructor(
    private readonly sql: DatabaseSync,
    private readonly host: AgentMessageHost,
    private readonly opts: { unavailableMs?: number; now?: () => number } = {},
  ) {
    const rows = this.sql.prepare("SELECT DISTINCT chat_id FROM agent_messages WHERE state IN ('written', 'taken') OR (state = 'undelivered' AND dismissed = 0)").all() as Array<{ chat_id: string }>;
    for (const r of rows) this.listed.add(r.chat_id);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private get unavailableMs(): number {
    return this.opts.unavailableMs ?? BRIDGE_UNAVAILABLE_MS;
  }

  get(chatId: string, id: string): AgentMessage | null {
    const row = this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE id = ? AND chat_id = ?`).get(id, chatId) as Row | undefined;
    return row ? messageOf(row) : null;
  }

  /** Every message of a chat, oldest first: the record the lead's transcript is merged with */
  history(chatId: string): AgentMessage[] {
    return (this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE chat_id = ? ORDER BY sent_at, rowid`).all(chatId) as unknown as Row[]).map(messageOf);
  }

  /**
   * Queues one message for the chat's bridge. A person's new message to an agent dismisses the ones
   * to the same agent that were lost before, as the chat's own queue does when the person sends again.
   */
  write(chatId: string, agentId: string, message: { words: string; text: string; source: ChatMessageSource }): SubagentMessageReceipt {
    const id = randomUUID();
    const at = this.iso();
    this.sql.exec('BEGIN');
    try {
      if (message.source === 'person') this.sql.prepare("UPDATE agent_messages SET dismissed = 1 WHERE chat_id = ? AND agent_id = ? AND state = 'undelivered'").run(chatId, agentId);
      this.sql
        .prepare(`INSERT INTO agent_messages (id, chat_id, agent_id, source, words, text, state, sent_at, dismissed) VALUES (?, ?, ?, ?, ?, ?, 'written', ?, 0)`)
        .run(id, chatId, agentId, message.source, message.words, message.text, at);
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
    this.listed.add(chatId);
    this.wake(chatId);
    this.arm(chatId);
    return { id, state: 'written' };
  }

  /**
   * What the page lists for the chat: the messages on their way and the newest lost ones. A chat
   * whose process is gone (`alive: false`) has nobody left to carry what still waits: those are
   * settled first, which also covers the rows a restart of Claudio left behind.
   */
  list(chatId: string, alive: boolean, endedReason = 'the process ended before the bridge delivered it'): ChatPendingMessage[] {
    if (!this.listed.has(chatId)) return [];
    if (!alive) this.endChat(chatId, endedReason);
    const waiting = this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE chat_id = ? AND state IN ('written', 'taken') ORDER BY sent_at, rowid`).all(chatId) as unknown as Row[];
    const lost = (
      this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE chat_id = ? AND state = 'undelivered' AND dismissed = 0 ORDER BY sent_at DESC, rowid DESC LIMIT ?`).all(chatId, MAX_UNDELIVERED) as unknown as Row[]
    ).reverse();
    if (!waiting.length && !lost.length) this.listed.delete(chatId);
    return [...waiting, ...lost].map((r) => agentPendingView(messageOf(r)));
  }

  /**
   * The bridge's long poll: the messages waiting now, in order, marked taken; when none wait, the
   * first that arrives within `waitS` seconds; else none. A message to an agent the person stopped
   * meanwhile is settled `agent-stopped` instead of being handed out.
   */
  async next(chatId: string, waitS: number, signal?: AbortSignal): Promise<BridgeNextResponse> {
    this.polls.set(chatId, this.now());
    let taken = this.take(chatId);
    if (!taken.length && waitS > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const waiters = this.waiters.get(chatId) ?? new Set<() => void>();
        this.waiters.set(chatId, waiters);
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          waiters.delete(done);
          if (!waiters.size) this.waiters.delete(chatId);
          resolve();
        };
        const timer = setTimeout(done, Math.min(waitS, BRIDGE_WAIT_MAX_S) * 1000);
        timer.unref();
        signal?.addEventListener('abort', done, { once: true });
        waiters.add(done);
      });
      this.polls.set(chatId, this.now());
      // A poll the caller gave up on takes nothing: what it would have taken waits for the next one
      if (!signal?.aborted) taken = this.take(chatId);
    }
    return { messages: taken.map((m) => ({ id: m.id, agentId: m.agentId, text: m.text })) };
  }

  private take(chatId: string): AgentMessage[] {
    const rows = (this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE chat_id = ? AND state = 'written' ORDER BY sent_at, rowid`).all(chatId) as unknown as Row[]).map(messageOf);
    const out: AgentMessage[] = [];
    const at = this.iso();
    for (const m of rows) {
      if (this.host.agentStopped(chatId, m.agentId)) {
        this.settle(m, { code: 'agent-stopped', reason: 'the subagent was stopped, and a stopped subagent cannot be resumed' });
        continue;
      }
      // Guarded by the state, so two polls racing never hand out one message twice
      const changed = Number(this.sql.prepare("UPDATE agent_messages SET state = 'taken', taken_at = ? WHERE id = ? AND state = 'written'").run(at, m.id).changes);
      if (changed) out.push(m);
    }
    return out;
  }

  /**
   * What `$.session.send` answered for one message the bridge took. Ignored for a message of
   * another chat, or one not taken (a report for it is stale or forged): answers whether it counted.
   */
  report(chatId: string, id: string, report: BridgeReport): boolean {
    const m = this.get(chatId, id);
    if (!m || m.state !== 'taken') return false;
    if (report.isDelivered === true) {
      const at = this.iso();
      const changed = Number(this.sql.prepare("UPDATE agent_messages SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'taken'").run(at, id).changes);
      if (changed) this.host.delivery(chatId, { id, state: 'delivered', at, source: m.source, to: { agentId: m.agentId } });
      return changed > 0;
    }
    const reason = typeof report.reason === 'string' && report.reason.trim() ? report.reason.trim().slice(0, 2_000) : NOT_READ;
    return this.settle(m, { code: 'not-read', reason }, 'taken');
  }

  /**
   * Takes back a message the bridge has not taken (`cancelled`), or dismisses a lost one from the
   * list (the page's "Discard"). One already taken or delivered is the subagent's: 409 `taken`.
   */
  withdraw(chatId: string, agentId: string, id: string): SubagentMessageReceipt {
    const m = this.get(chatId, id);
    if (!m || m.agentId !== agentId) throw new AgentMessageRefusal('no such message to this subagent', 404, 'message-unknown');
    if (m.state === 'undelivered') {
      this.sql.prepare('UPDATE agent_messages SET dismissed = 1 WHERE id = ?').run(id);
      return { id, state: 'undelivered' };
    }
    if (m.state !== 'written' || !this.settle(m, { code: 'cancelled', reason: CANCELLED }, 'written', true)) {
      throw new AgentMessageRefusal('the bridge has already taken this message to the subagent', 409, 'taken');
    }
    return { id, state: 'undelivered' };
  }

  /** The chat's process ended: whatever still waits, or was taken without an answer, is lost with it */
  endChat(chatId: string, reason: string): void {
    // Every process end comes here: a chat that never wrote to a subagent costs no query
    if (this.listed.has(chatId)) this.settleWaiting(chatId, reason);
    this.wake(chatId);
    this.polls.delete(chatId);
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }

  private settleWaiting(chatId: string, reason: string): void {
    const rows = (this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE chat_id = ? AND state IN ('written', 'taken')`).all(chatId) as unknown as Row[]).map(messageOf);
    for (const m of rows) this.settle(m, { code: null, reason });
  }

  /** Stops every timer and lets every held poll answer: the server is going away */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const chatId of [...this.waiters.keys()]) this.wake(chatId);
  }

  /**
   * Moves one message to `undelivered`, from the state it was read in so a race settles it once, and
   * tells the page. A withdrawn one (`quiet`) is not listed afterwards: whoever withdrew it knows.
   */
  private settle(m: AgentMessage, why: { code: MessageUndeliveredReason | null; reason: string }, from: RowState = m.state, quiet = false): boolean {
    const changed = Number(
      this.sql.prepare('UPDATE agent_messages SET state = ?, reason_code = ?, reason = ?, dismissed = ? WHERE id = ? AND state = ?').run('undelivered', why.code, why.reason, quiet ? 1 : 0, m.id, from).changes,
    );
    if (!changed) return false;
    const view = agentPendingView({ ...m, state: 'undelivered', reasonCode: why.code, reason: why.reason });
    this.host.delivery(m.chatId, { id: m.id, state: 'undelivered', message: view, source: m.source, ...(why.code ? { reason: why.code } : {}), to: { agentId: m.agentId } });
    return true;
  }

  private wake(chatId: string): void {
    for (const done of [...(this.waiters.get(chatId) ?? [])]) done();
  }

  /**
   * Checks the chat's waiting messages once the bridge has had `unavailableMs` to ask for them: one
   * no poll could have taken in that time is lost as `bridge-unavailable`. A poll held open counts as
   * the bridge being there, since a message written meanwhile wakes it at once.
   */
  private arm(chatId: string): void {
    if (this.timers.has(chatId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      this.check(chatId);
    }, this.unavailableMs);
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private check(chatId: string): void {
    const rows = (this.sql.prepare(`SELECT ${COLUMNS} FROM agent_messages WHERE chat_id = ? AND state = 'written'`).all(chatId) as unknown as Row[]).map(messageOf);
    if (!rows.length) return;
    if (this.waiters.get(chatId)?.size) {
      this.arm(chatId);
      return;
    }
    const now = this.now();
    const polled = this.polls.get(chatId) ?? 0;
    let left = false;
    for (const m of rows) {
      const since = Math.max(Date.parse(m.sentAt), polled);
      if (now - since >= this.unavailableMs) this.settle(m, { code: 'bridge-unavailable', reason: BRIDGE_UNAVAILABLE }, 'written');
      else left = true;
    }
    if (left) this.arm(chatId);
  }
}
