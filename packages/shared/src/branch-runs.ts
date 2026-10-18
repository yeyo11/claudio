import type { ChatBranchRun } from './types.ts';

const ms = (iso: string): number => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : 0;
};

/**
 * The one clock an agent shows, in the panel, the strip and the cards: while it runs, how long the
 * current run has been going; once it ended, the time it was active over all its runs. Gaps between
 * runs (an agent waiting to be resumed) are not work, so they never count.
 */
export function runsElapsedMs(runs: readonly ChatBranchRun[], now: number): number {
  const last = runs.at(-1);
  if (last && last.endedAt === null) return Math.max(0, now - ms(last.startedAt));
  return runs.reduce((sum, run) => sum + Math.max(0, (run.endedAt ? ms(run.endedAt) : now) - ms(run.startedAt)), 0);
}

/** Closes the run that is still open, if any, at `at`. */
export function closeRuns(runs: readonly ChatBranchRun[], at: string): ChatBranchRun[] {
  return runs.map((run) => (run.endedAt === null ? { ...run, endedAt: at } : run));
}

/**
 * Whether a task notification says the agent only ended its turn: `completed`, but with background
 * work of its own still running. The CLI's stream gives no field for it (a `task_notification` has
 * `status`, `summary`, `usage`), so it is read from the words it always uses in the summary and,
 * where it is carried, the note.
 */
export function isWaitingOnBackground(text: { summary?: string | null; note?: string | null }): boolean {
  return /waiting on its own background work/i.test(text.summary ?? '') || /stopped with background work of its own still running/i.test(text.note ?? '');
}
