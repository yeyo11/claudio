import type { LimitWait, Orchestration, OrchestrationTaskState } from '@claudio/shared';
import i18n from '../i18n';

/** What a person can decide about one task right now; mirrors what the server accepts. */
export interface TaskDecisions {
  /** One more execution of the same chat, in its worktree */
  retry: boolean;
  /** A new chat, the worktree rebuilt from the base */
  retryClean: boolean;
  /** Give the branch up so the graph can finish without it */
  skip: boolean;
  /** A nudge to a worker that is still running */
  hint: boolean;
}

const NONE: TaskDecisions = { retry: false, retryClean: false, skip: false, hint: false };

/** Only the graph engine has tasks to decide on; a workflow runs them as one session. */
export function decisionsOn(orch: Orchestration, task: OrchestrationTaskState): TaskDecisions {
  if ((orch.engine ?? 'graph') !== 'graph') return NONE;
  if (orch.status !== 'running' && orch.status !== 'waiting') return NONE;
  return {
    retry: task.status === 'failed',
    retryClean: task.status === 'failed',
    skip: task.status === 'failed' || task.status === 'blocked',
    // A task waiting for a reset has no worker to nudge: its chat is not running
    hint: task.status === 'running' && !task.waiting,
  };
}

/**
 * The failed tasks a blocked one waits behind, found through the tasks in between: the decision that
 * frees it is taken on them, not on it.
 */
export function blockedBy(orch: Orchestration, task: OrchestrationTaskState): OrchestrationTaskState[] {
  const byId = new Map(orch.tasks.map((t) => [t.id, t]));
  const found = new Map<string, OrchestrationTaskState>();
  const seen = new Set<string>();
  const walk = (current: OrchestrationTaskState) => {
    for (const id of current.dependsOn ?? []) {
      const dep = byId.get(id);
      if (!dep || seen.has(id)) continue;
      seen.add(id);
      if (dep.status === 'failed') found.set(id, dep);
      else if (dep.status === 'blocked') walk(dep);
    }
  };
  walk(task);
  return [...found.values()];
}

/** Where a task stands among its attempts, or null when there is nothing worth saying (the first, uneventful one). */
export function attemptLabel(orch: Orchestration, task: OrchestrationTaskState): string | null {
  const { attempts, status } = task;
  if (status === 'running' && attempts > 1) {
    // Past the configured attempts only a person's decision gets a task here
    return attempts > orch.maxAttempts
      ? i18n.t('orchestration:board.attemptByHand', { n: attempts })
      : i18n.t('orchestration:board.attemptOf', { n: attempts, max: orch.maxAttempts });
  }
  if (status === 'failed' && attempts > 0) {
    return attempts < orch.maxAttempts
      ? i18n.t('orchestration:board.failedAfterNotRetried', { count: attempts })
      : i18n.t('orchestration:board.failedAfter', { count: attempts });
  }
  if (status === 'completed' && attempts > 1) return i18n.t('orchestration:board.completedOn', { n: attempts });
  return null;
}

/** What the orchestration's status means for the person looking at it, when it asks for anything. */
export function waitingSummary(orch: Orchestration): { failed: OrchestrationTaskState[]; blocked: OrchestrationTaskState[] } | null {
  if (orch.status !== 'waiting') return null;
  return {
    failed: orch.tasks.filter((t) => t.status === 'failed'),
    blocked: orch.tasks.filter((t) => t.status === 'blocked'),
  };
}

/** Cost of what the tasks currently count, and the part of the total they do not: chats a clean retry left behind. */
export function costSplit(orch: Orchestration): { tasks: number; other: number } {
  const tasks = orch.tasks.reduce((sum, t) => sum + t.costUsd, 0);
  // A synthesis or an abandoned chat is in the total but on no task; float noise is not an amount
  const other = orch.costUsd - tasks;
  return { tasks, other: other > 0.0001 ? other : 0 };
}

const isWorkflow = (orch: Orchestration) => (orch.engine ?? 'graph') === 'workflow';

/**
 * The one wait a workflow held at a usage limit is in. Its lead runs every task, so the wait is the
 * graph's, not a task's: the server puts it on each running task, and the page says it once.
 */
export function workflowWait(orch: Orchestration): LimitWait | null {
  if (!isWorkflow(orch) || orch.status !== 'running') return null;
  return orch.tasks.find((t) => t.status === 'running' && t.waiting)?.waiting ?? null;
}

/** Whether a task's own wait strip and "Stop waiting" give way to the graph's one line (`workflowWait`). */
export function waitShownOnGraph(orch: Orchestration): boolean {
  return isWorkflow(orch);
}

/**
 * Why a workflow ended without finishing, in the server's words, with the tone its status takes:
 * bad when it failed (its lead went away, nothing moved for too long, the limit never reset), warn
 * when it was stopped. Null on the graph engine, whose `error` is its checks' (`FailedByChecksNotice`).
 */
export function workflowEnded(orch: Orchestration): { tone: 'bad' | 'warn'; error: string } | null {
  if (!isWorkflow(orch) || !orch.error) return null;
  if (orch.status === 'failed') return { tone: 'bad', error: orch.error };
  if (orch.status === 'stopped') return { tone: 'warn', error: orch.error };
  return null;
}
