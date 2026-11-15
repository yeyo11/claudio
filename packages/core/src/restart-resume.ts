import { errorMessage } from '@claudio/shared';
import type { ChatManager, CutTurn } from './chats.ts';
import type { Db } from './db.ts';

/**
 * Layer 3 of docs/plans/survive-restarts.md: what a start does with the turns the previous server
 * left cut. A person's chat cut less than an hour ago goes on by itself, through Claude Code's own
 * continuation (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`); one cut longer ago waits for the person's
 * Continue (D7). Automated work is its owner's: an orchestration's tasks and workflows
 * (`Orchestrator.recover`), flow runs, the assistant and the rotation's waits each continue their own
 * chats under their own limits, so nothing here touches them.
 */

/** D7: a person's turn cut less than this long ago continues by itself */
export const AUTO_CONTINUE_MAX_AGE_MS = 60 * 60_000;
/**
 * Added to the bound the CLI is given: it measures the age from its own last transcript line, which
 * can be a moment later than the cut Claudio read, and a turn Claudio decided to continue should not
 * then start idle over the difference.
 */
const CLI_AGE_SLACK_MS = 5 * 60_000;
/**
 * A turn cut this many times in a row is not continued again by itself: whatever keeps taking the
 * server down with it would keep spending. It waits for the person, as `MAX_FLOW_RESTARTS` makes a
 * flow run wait.
 */
export const MAX_RESTART_CHAIN = 3;

export type CutTurnPlan =
  /** Continued now, by itself */
  | { action: 'continue' }
  /** Left for the person's Continue in the chat */
  | { action: 'offer'; why: string }
  /** Not this module's: its owner continues it, or nobody does */
  | { action: 'leave'; why: string };

/** What becomes of one cut turn at `nowMs`. Pure: the clock and the claim are the caller's. */
export function planCutTurn(cut: CutTurn, nowMs: number): CutTurnPlan {
  if (cut.origin === 'api') return { action: 'leave', why: 'an API chat is never replayed: its client sends the request again' };
  if (cut.origin === 'internal') return { action: 'leave', why: "Claudio's own housekeeping ends with the server that ran it" };
  if (cut.origin === 'orchestration') return { action: 'leave', why: 'its orchestration continues it' };
  // A chat of Claudio's or one adopted from a terminal: whose turn it was is what its execution recorded
  if (cut.purpose === null) return { action: 'offer', why: 'its execution did not record who started it' };
  if (cut.purpose !== 'person') return { action: 'leave', why: `its owner (${cut.purpose}) continues it` };
  if (!cut.continuable) return { action: 'offer', why: 'its provider cannot continue it, or a process of the previous server still holds the session' };
  if (cut.chain > MAX_RESTART_CHAIN) return { action: 'offer', why: `a restart cut it ${String(cut.chain)} times in a row` };
  const age = nowMs - Date.parse(cut.cutAt);
  if (!Number.isFinite(age) || age > AUTO_CONTINUE_MAX_AGE_MS) return { action: 'offer', why: 'it was cut more than an hour ago' };
  return { action: 'continue' };
}

export interface RestartResumeDeps {
  runtime: Pick<ChatManager, 'cutTurns' | 'continueCut'>;
  db: Pick<Db, 'claimRestartContinuation'>;
  /** The one clock: the age of each cut and the time of each claim */
  now: () => number;
  /** A chat something else holds: a wait at a usage limit, which the rotation replays (t8 of limit-resume-and-credits) */
  held: (chatId: string) => boolean;
}

export interface RestartResumeReport {
  continued: string[];
  offered: string[];
  left: string[];
  /** Claimed by another process or an earlier pass of this one */
  taken: string[];
  failed: Array<{ chatId: string; error: string }>;
}

/**
 * Goes over the cut turns once, after the chats are restored. Each one it continues is claimed first,
 * keyed by its cut execution, so two processes on one data dir (or a second pass) never continue one
 * turn twice. A start the runtime refuses (no place, no memory) keeps its claim: the turn is not
 * tried again by itself, and the chat offers Continue like an old cut.
 */
export function continueCutTurns(deps: RestartResumeDeps): RestartResumeReport {
  const report: RestartResumeReport = { continued: [], offered: [], left: [], taken: [], failed: [] };
  const nowMs = deps.now();
  for (const cut of deps.runtime.cutTurns()) {
    if (deps.held(cut.chatId)) {
      report.left.push(cut.chatId);
      continue;
    }
    const plan = planCutTurn(cut, nowMs);
    if (plan.action !== 'continue') {
      report[plan.action === 'offer' ? 'offered' : 'left'].push(cut.chatId);
      continue;
    }
    if (!deps.db.claimRestartContinuation(`chat:${cut.executionId}`, cut.chatId, new Date(nowMs).toISOString())) {
      report.taken.push(cut.chatId);
      continue;
    }
    try {
      deps.runtime.continueCut(cut.chatId, AUTO_CONTINUE_MAX_AGE_MS + CLI_AGE_SLACK_MS);
      report.continued.push(cut.chatId);
    } catch (err) {
      report.failed.push({ chatId: cut.chatId, error: errorMessage(err) });
    }
  }
  return report;
}
