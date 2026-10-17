// The live state of a workflow graph's tasks, from the journal the CLI writes as the run goes on.
// The script's own result only exists once the workflow ends, and the stream's progress was seen to
// miss an agent the API refused (R15): the journal records every start and every end as it happens.

import { readAgentEnd, readWorkflowJournal, workflowRunBytes, type WorkflowAgentEnd, type WorkflowJournalLine } from './workflows.ts';

/** The label and phase the generated script gives its synthesis agent; every other agent is labelled with its task's id. */
export const SYNTHESIS_LABEL = 'synthesis';
export const SYNTHESIS_PHASE = 'Synthesis';

export const isSynthesis = (task: Pick<JournalTask, 'label' | 'phase'>): boolean => task.label === SYNTHESIS_LABEL && task.phase === SYNTHESIS_PHASE;

export interface JournalTask {
  /** The task id, or `synthesis` */
  label: string;
  key: string;
  /** The agent of the latest attempt */
  agentId: string | null;
  phase: string | null;
  state: 'running' | 'completed' | 'failed';
  /** The agent's whole answer, once it completed */
  result: string | null;
  /** How the failed agent's transcript ends; filled by `readJournalTasks` */
  end: WorkflowAgentEnd | null;
}

export interface JournalRead {
  /** Lines the journal had, so the next launch into the same run can read only what it adds */
  lines: number;
  /** One entry per label, in the order each first started */
  tasks: JournalTask[];
  /** What the run's directory holds, transcripts included: the watchdog's measure of progress */
  bytes: number;
}

/**
 * Each agent call's latest state, from the journal's lines from `from` on. A call is known by its
 * key, and only its `started` line carries the label, so a later line of the same key wins: a run
 * resumed from its cache starts a call that failed again under the same key and a new agent id.
 */
export function foldJournal(lines: readonly WorkflowJournalLine[], from = 0): JournalTask[] {
  const byKey = new Map<string, JournalTask>();
  for (const line of lines.slice(from)) {
    if (!line.key) continue;
    const known = byKey.get(line.key);
    if (line.type === 'started') {
      const label = line.label ?? known?.label;
      if (!label) continue;
      byKey.set(line.key, { label, key: line.key, agentId: line.agentId, phase: line.phase ?? known?.phase ?? null, state: 'running', result: null, end: null });
    } else if (known && (line.type === 'result' || line.type === 'failed')) {
      if (line.agentId) known.agentId = line.agentId;
      known.state = line.type === 'result' ? 'completed' : 'failed';
      known.result = line.type === 'result' ? (typeof line.result === 'string' ? line.result : line.result == null ? null : JSON.stringify(line.result)) : null;
    }
  }
  // Two keys for one label would be the same task started from two places; the later one wins. A
  // task may be called `synthesis` too: the phase tells it from the synthesis
  const byLabel = new Map<string, JournalTask>();
  for (const task of byKey.values()) byLabel.set(`${task.phase ?? ''}\0${task.label}`, task);
  return [...byLabel.values()];
}

/** A workflow run's tasks as its journal has them, with the last message of each agent that failed. */
export async function readJournalTasks(transcript: string, runId: string, from = 0): Promise<JournalRead> {
  const lines = await readWorkflowJournal(transcript, runId);
  const tasks = foldJournal(lines, from);
  for (const task of tasks) {
    if (task.state === 'failed' && task.agentId) task.end = await readAgentEnd(transcript, runId, task.agentId);
  }
  return { lines: lines.length, tasks, bytes: await workflowRunBytes(transcript, runId) };
}

/** What a failed agent's task shows as its error: what the agent last said, or that it said nothing. */
export function journalError(task: JournalTask): string {
  return task.end?.text ?? 'the agent failed without a message';
}

/** What a failed agent was refused for, when the API refused it at a usage limit or a sign-in. */
export interface JournalRefusal {
  /** When the limit resets, if the refusal said */
  resetsAt: string | null;
  rateLimitType: string | null;
  /** A 401: the account's sign-in, not its limit */
  auth: boolean;
}

/**
 * Whether a failed agent was refused by the API at a limit (429) or a sign-in (401): the account's
 * state, which another account or the reset mends, not the task's failure. Read from the CLI's
 * structured fields only, never from what the message says.
 */
export function journalRefusal(task: JournalTask): JournalRefusal | null {
  const end = task.end;
  if (task.state !== 'failed' || !end) return null;
  if (end.apiErrorStatus === 401) return { resetsAt: null, rateLimitType: null, auth: true };
  if (end.apiErrorStatus !== 429 && !end.rateLimit) return null;
  return { resetsAt: end.rateLimit?.resetsAt ?? null, rateLimitType: end.rateLimit?.rateLimitType ?? null, auth: false };
}
