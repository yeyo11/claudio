import type { DatabaseSync } from 'node:sqlite';
import type { Execution } from '@claudio/shared';

import type { ModelUsage } from './providers/driver.ts';

// What a session cost, as its agent reports it. Claude Code's `total_cost_usd` and `modelUsage` are
// cumulative over the session, not the process: `--resume` restores them from the transcript and
// `--resume --fork-session` starts the copy from its parent's (spike S1 of
// docs/plans/decision-engine-v2.md, CLI 2.1.322). So a turn's cost is the growth since the
// session's last report, whichever process made it, and that last report has to outlive the process
// and the wrapper: it is kept on the chat's record (`ChatRecord.reported`).
//
// Before 2026-11-13 Claudio took it to restart at every spawn, and billed each resumed execution the
// session's history again. `recomputeResumedCosts` mends the stored executions once.

/** The totals a session last reported: what the next result's growth is measured from. */
export interface SessionTotals {
  costUsd: number;
  models: ModelUsage[];
}

export const noTotals = (): SessionTotals => ({ costUsd: 0, models: [] });

/**
 * The totals of a chat stored before they were kept on its record. Its executions were billed the
 * CLI's figure as it came (`costUsd` and `modelCosts` were the largest the process reported), so the
 * last execution with a cost holds the session's last reported totals. No tokens were kept: a model's
 * counts start from zero, which only the next turn's token figures pay for.
 */
export function legacyTotals(executions: readonly Execution[]): SessionTotals {
  const last = executions.findLast((e) => e.costUsd !== null);
  if (!last || last.costUsd === null) return noTotals();
  return { costUsd: last.costUsd, models: Object.entries(last.modelCosts ?? {}).map(([model, costUsd]) => ({ model, costUsd })) };
}

/** The migration's name in `cost_corrections`, the row that says when this database was mended. */
export const RESUMED_COSTS_FIX = 'resumed-session-costs';

/**
 * Bills each stored execution of a resumed chat only its own turns (D7 of
 * docs/plans/decision-engine-v2.md). A chat qualifies when its executions' costs only grow, oldest
 * first, which is the mark the old billing left: there each execution's cost is the session's total
 * when it ended, and its own cost is the increase over the one before. A chat whose costs ever go down
 * was not billed that way, or not only, and is left as it is, record included.
 *
 * Each mended chat's record gets the totals it last reported (`reported`), which is also what makes
 * this safe to run again: a chat that has them is either mended already or was billed after the fix,
 * and is never read as cumulative. The spend ledger is left alone: its rows are what the daily cap
 * decided with, and the row written here dates the fix so a reader can tell the figures before it
 * were overstated.
 */
export function recomputeResumedCosts(db: DatabaseSync, at = new Date().toISOString()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cost_corrections (
     name       TEXT PRIMARY KEY,
     applied_at TEXT NOT NULL,
     chats      INTEGER NOT NULL,
     executions INTEGER NOT NULL
   )`);
  const chats = db.prepare('SELECT id, json FROM chats').all() as Array<{ id: string; json: string }>;
  const executionsOf = db.prepare('SELECT id, json FROM executions WHERE chat_id = ? ORDER BY started_at ASC, rowid ASC');
  const updateExecution = db.prepare('UPDATE executions SET json = ? WHERE id = ?');
  const updateChat = db.prepare('UPDATE chats SET json = ? WHERE id = ?');
  let mendedChats = 0;
  let mendedExecutions = 0;
  for (const chat of chats) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(chat.json) as Record<string, unknown>;
    } catch {
      // One unreadable chat must not stop the upgrade
      continue;
    }
    if (record.reported !== undefined) continue;
    const rows: Array<{ id: string; execution: Execution }> = [];
    let readable = true;
    for (const row of executionsOf.all(chat.id) as Array<{ id: string; json: string }>) {
      try {
        rows.push({ id: row.id, execution: JSON.parse(row.json) as Execution });
      } catch {
        readable = false;
      }
    }
    // A gap in the history would make the next execution's increase wrong
    if (!readable) continue;
    const paid = rows.filter((r) => typeof r.execution.costUsd === 'number');
    if (paid.length < 2 || !onlyGrows(paid.map((r) => r.execution.costUsd ?? 0))) continue;
    const totals = legacyTotals(rows.map((r) => r.execution));
    let before: Execution | null = null;
    for (const { id, execution } of paid) {
      const cumulative = { costUsd: execution.costUsd, modelCosts: execution.modelCosts };
      if (before) {
        execution.costUsd = Math.max(0, (execution.costUsd ?? 0) - (before.costUsd ?? 0));
        if (execution.modelCosts) execution.modelCosts = modelGrowth(before.modelCosts ?? {}, execution.modelCosts);
        updateExecution.run(JSON.stringify(execution), id);
        mendedExecutions++;
      }
      // The next one grows from this one's reported total, not from what it is billed now
      before = { ...execution, costUsd: cumulative.costUsd, ...(cumulative.modelCosts ? { modelCosts: cumulative.modelCosts } : {}) };
    }
    updateChat.run(JSON.stringify({ ...record, reported: totals }), chat.id);
    mendedChats++;
  }
  db.prepare('INSERT INTO cost_corrections (name, applied_at, chats, executions) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING').run(RESUMED_COSTS_FIX, at, mendedChats, mendedExecutions);
}

/** Never lower than the one before: what an execution billed the session's running total looks like. */
function onlyGrows(costs: readonly number[]): boolean {
  return costs.every((cost, i) => i === 0 || cost >= (costs[i - 1] ?? 0));
}

/** Each model's increase; a model whose figure went down, or that is new, counts whole. */
function modelGrowth(before: Record<string, number>, now: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, usd] of Object.entries(now)) {
    const then = before[model] ?? 0;
    out[model] = usd >= then ? usd - then : usd;
  }
  return out;
}

/**
 * When this database's stored costs of resumed sessions were mended: figures dated before it (the
 * spend ledger's rows above all, which were left as they were) overstate what a resumed session
 * cost. Null on a database the fix never ran on.
 */
export function resumedCostsFixedAt(db: DatabaseSync): string | null {
  try {
    const row = db.prepare('SELECT applied_at FROM cost_corrections WHERE name = ?').get(RESUMED_COSTS_FIX) as { applied_at: string } | undefined;
    return row?.applied_at ?? null;
  } catch {
    // No such table: the fix has not run here
    return null;
  }
}
