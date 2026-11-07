import type { ChangeSummary, EditStep, FileDiff } from '@claudio/shared';
import type { ChangeScope, DiffOptions } from '../../api';
import { useFeedState } from '../../lib/events';

/**
 * Where a review reads from: a chat, a task, an orchestration's integration branch, or a work
 * item's own branch. The screen is the same for all four; only these loaders, the way back and what
 * is live differ.
 */
export interface ReviewSource {
  kind: 'chat' | 'task' | 'integration' | 'workItem';
  /** Names the source in the browser's "seen" store */
  storageKey: string;
  /** The summary of a scope; null when there is no git checkout to compare (a chat outside git) */
  summary: (scope: ChangeScope) => { queryKey: readonly unknown[]; queryFn: () => Promise<ChangeSummary | null> };
  diff: (path: string, opts: DiffOptions) => { queryKey: readonly unknown[]; queryFn: () => Promise<FileDiff> };
  /** The transcript's edits; null where there is no transcript (the integration branch) */
  steps: { queryKey: readonly unknown[]; queryFn: () => Promise<EditStep[]> } | null;
  /** The chat whose transcript the steps come from, for "See it in the conversation" */
  conversation: string | null;
  /** Something is still working on it, so it is read again on the events, and on a timer where they miss a move */
  live: boolean;
  /**
   * Whether `changes.updated` announces every move of its files while it is live, so the event alone
   * keeps it fresh and the timer runs only while the feed is down. True for a task and the
   * integration branch (see {@link liveRefresh}).
   */
  announced: boolean;
  back: { to: string; label: string };
  /** The chat's first prompt, the task's name: what the work was about */
  subject: string | null;
  /**
   * The open change request this branch is the head of: its threads are drawn on the diff and the
   * person's notes go to its draft review. Null where there is none (a chat, a task, a branch with no PR).
   */
  changeRequestId: string | null;
  /** The orchestration whose review gate is on: its findings are drawn on the diff. Absent where there is none */
  reviewGate?: { orchestrationId: string };
  /** What the agent is running now, to find the file it is editing */
  activity: { target: string | null; cwd: string | null; top: string | null } | null;
}

/** How often a live source is read again besides the events */
export const LIVE_REFRESH_MS = 8_000;

/**
 * The timer a live source is read again on, given whether the event feed is open.
 *
 * A task's and the integration branch's reads sit under the graph's key, and the server's change
 * watcher (`packages/core/src/change-watcher.ts`) looks at a running task's worktree and at the
 * integration branch while it merges or resolves every few seconds, sending `changes.updated` when
 * anything moved, a commit or a file no tool announced: the very window these sources are live.
 * So the event is enough, and the timer only stands in while the feed is down.
 *
 * A chat and a work item keep the timer. `changes.updated` never names either (a person's chat has
 * no watched worktree, and a work item's branch is worked in by chats one after another), and the
 * only event that does move a chat's changes is `chat.activity` for an edit tool: a file written by a
 * shell command, a formatter or a commit announces nothing.
 */
export function liveRefresh(source: Pick<ReviewSource, 'live' | 'announced'>, feedOpen: boolean): number | false {
  if (!source.live) return false;
  return source.announced && feedOpen ? false : LIVE_REFRESH_MS;
}

/** {@link liveRefresh} for the page's feed */
export function useLiveRefresh(source: Pick<ReviewSource, 'live' | 'announced'>): number | false {
  return liveRefresh(source, useFeedState() === 'open');
}
