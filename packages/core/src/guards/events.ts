import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { GuardEvent, GuardOutcome, GuardRuleId } from '@claudio/shared';
import { maskSecrets } from '../decisions/redact.ts';
import { KEEP_GUARD_EVENTS, pruneGuardEvents } from '../db.ts';

/** The longest excerpt kept, after masking */
export const MAX_GUARD_EXCERPT = 240;
const MAX_REASON = 500;
/** A long-running server prunes again after this many inserts; a process opening the db prunes too */
const PRUNE_EVERY = 200;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** What is recorded; the store assigns `seq` and cuts the text. */
export type NewGuardEvent = Omit<GuardEvent, 'seq' | 'at' | 'projectId' | 'orchestrationId' | 'taskId' | 'flowRunId' | 'toolUseId'> & {
  at?: string;
  projectId?: string | null;
  orchestrationId?: string | null;
  taskId?: string | null;
  flowRunId?: string | null;
  toolUseId?: string | null;
};

export interface GuardEventFilter {
  chatId?: string;
  projectId?: string;
  orchestrationId?: string;
  taskId?: string;
  flowRunId?: string;
  rule?: GuardRuleId;
  outcome?: GuardOutcome;
  /** Rows older than this seq only: the previous page's `next` */
  before?: number;
  limit?: number;
}

interface Row {
  seq: number;
  at: string;
  chat_id: string;
  project_id: string | null;
  orchestration_id: string | null;
  task_id: string | null;
  flow_run_id: string | null;
  tool_use_id: string | null;
  tool_name: string;
  rule: string;
  matcher: string;
  outcome: string;
  reason: string;
  excerpt: string;
}

const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const eventOf = (r: Row): GuardEvent => ({
  seq: r.seq,
  at: r.at,
  chatId: r.chat_id,
  projectId: r.project_id,
  orchestrationId: r.orchestration_id,
  taskId: r.task_id,
  flowRunId: r.flow_run_id,
  toolUseId: r.tool_use_id,
  toolName: r.tool_name,
  rule: r.rule as GuardRuleId,
  matcher: r.matcher,
  outcome: r.outcome as GuardOutcome,
  reason: r.reason,
  excerpt: r.excerpt,
});

/**
 * The guards' audit trail over `guard_events`. Each insert is one `INSERT OR IGNORE`, so the
 * processes sharing a data dir need no transaction and a replayed stream inserts nothing twice.
 */
export class GuardEventStore {
  private inserts = 0;

  constructor(private readonly db: DatabaseSync, private readonly keep = KEEP_GUARD_EVENTS) {}

  /** Returns the stored event, or null when an identical (chat, call, outcome) was already there. */
  insert(event: NewGuardEvent): GuardEvent | null {
    const row = {
      at: event.at ?? new Date().toISOString(),
      projectId: event.projectId ?? null,
      orchestrationId: event.orchestrationId ?? null,
      taskId: event.taskId ?? null,
      flowRunId: event.flowRunId ?? null,
      toolUseId: event.toolUseId ?? null,
      // Masked first, cut second: cutting first could split a secret and leave half of it unmatched
      excerpt: cut(maskSecrets(event.excerpt), MAX_GUARD_EXCERPT),
      reason: cut(maskSecrets(event.reason), MAX_REASON),
    };
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO guard_events (at, chat_id, project_id, orchestration_id, task_id, flow_run_id, tool_use_id, tool_name, rule, matcher, outcome, reason, excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.at, event.chatId, row.projectId, row.orchestrationId, row.taskId, row.flowRunId, row.toolUseId, event.toolName, event.rule, event.matcher, event.outcome, row.reason, row.excerpt);
    if (++this.inserts % PRUNE_EVERY === 0) pruneGuardEvents(this.db, this.keep);
    if (Number(result.changes) === 0) return null;
    return {
      seq: Number(result.lastInsertRowid),
      at: row.at,
      chatId: event.chatId,
      projectId: row.projectId,
      orchestrationId: row.orchestrationId,
      taskId: row.taskId,
      flowRunId: row.flowRunId,
      toolUseId: row.toolUseId,
      toolName: event.toolName,
      rule: event.rule,
      matcher: event.matcher,
      outcome: event.outcome,
      reason: row.reason,
      excerpt: row.excerpt,
    };
  }

  /** Newest first; `next` is the `before` cursor of the following page, null at the end. */
  list(filter: GuardEventFilter = {}): { events: GuardEvent[]; next: number | null } {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    const eq = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      where.push(`${column} = ?`);
      args.push(value);
    };
    eq('chat_id', filter.chatId);
    eq('project_id', filter.projectId);
    eq('orchestration_id', filter.orchestrationId);
    eq('task_id', filter.taskId);
    eq('flow_run_id', filter.flowRunId);
    eq('rule', filter.rule);
    eq('outcome', filter.outcome);
    if (filter.before !== undefined) {
      where.push('seq < ?');
      args.push(filter.before);
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
    const rows = this.db
      .prepare(`SELECT * FROM guard_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit + 1) as unknown as Row[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { events: page.map(eventOf), next: rows.length > limit && last ? last.seq : null };
  }

  /** Blocks per task of one orchestration; a task with none is absent. */
  countByTask(orchestrationId: string): Map<string, number> {
    const rows = this.db
      .prepare("SELECT task_id, COUNT(*) AS n FROM guard_events WHERE orchestration_id = ? AND task_id IS NOT NULL AND outcome = 'blocked' GROUP BY task_id")
      .all(orchestrationId) as unknown as Array<{ task_id: string; n: number }>;
    return new Map(rows.map((r) => [r.task_id, r.n]));
  }

  /** Blocks per flow run, for the given runs; a run with none is absent. */
  countByFlowRun(flowRunIds: readonly string[]): Map<string, number> {
    if (!flowRunIds.length) return new Map();
    const rows = this.db
      .prepare(`SELECT flow_run_id, COUNT(*) AS n FROM guard_events WHERE flow_run_id IN (${flowRunIds.map(() => '?').join(',')}) AND outcome = 'blocked' GROUP BY flow_run_id`)
      .all(...flowRunIds) as unknown as Array<{ flow_run_id: string; n: number }>;
    return new Map(rows.map((r) => [r.flow_run_id, r.n]));
  }
}
