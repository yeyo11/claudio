import type { ChatActivity, ChatBackgroundTask, ChatBranchStatus, ChatChildren, ChatSubagent, ChatWorkflow } from '@claudio/shared';
import { subagentFor } from './chat-steps';

/**
 * What a chat delegated, as the strip over the composer and the cards under a step read it
 * (plans/tool-rows-and-live-branches.md §3.3). Pure, so the rules are tested without a page.
 */

/** How long a branch that ended stays in the strip, so its final word is seen before it leaves. */
export const BRANCH_GRACE_MS = 5000;

export type BranchKind = 'agent' | 'task' | 'workflow';

export interface Branch {
  /** Unique across kinds: a task and an agent may share an id */
  key: string;
  kind: BranchKind;
  id: string;
  /** What the badge says, in mono: the agent's type, `bash`, `workflow` */
  label: string;
  /** Its description; a command without one shows the command (`mono`) */
  description: string;
  mono: boolean;
  status: ChatBranchStatus;
  startedAt: string;
  endedAt: string | null;
  /** A running subagent's own line; null for anything else */
  activity: ChatActivity | null;
  /** The shell command of a background task */
  command: string | null;
  /** A workflow's progress: agents done, agents in all, the phase it is in (0 before any) */
  progress: { done: number; total: number; phase: number } | null;
  /** A workflow's agents, one status each, for its segmented bar; empty for anything else */
  segments: Array<'running' | 'completed' | 'failed'>;
  /** The key of the branch that launched it, when that branch is shown too */
  parent: string | null;
}

const COMMAND_CHARS = 60;

export function agentBranch(sub: ChatSubagent): Branch {
  return {
    key: `agent:${sub.id}`,
    kind: 'agent',
    id: sub.id,
    label: sub.kind || 'agent',
    description: sub.description || sub.kind,
    mono: false,
    status: sub.status,
    startedAt: sub.startedAt,
    endedAt: sub.endedAt,
    activity: sub.status === 'running' ? sub.activity ?? null : null,
    command: null,
    progress: null,
    segments: [],
    parent: null,
  };
}

export function taskBranch(task: ChatBackgroundTask, parent: string | null = null): Branch {
  const command = task.command?.trim() || null;
  const description = task.description.trim();
  return {
    key: `task:${task.id}`,
    kind: 'task',
    id: task.id,
    label: command !== null || task.kind === 'local_bash' ? 'bash' : task.kind,
    description: description || (command ? command.slice(0, COMMAND_CHARS) : task.id),
    mono: !description,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    activity: null,
    command,
    progress: null,
    segments: [],
    parent,
  };
}

export function workflowBranch(workflow: ChatWorkflow): Branch {
  const done = workflow.agents.filter((agent) => agent.status === 'completed').length;
  // The phase it is in: the last one an agent has started in
  const phase = workflow.agents.reduce((at, agent) => Math.max(at, agent.phase ? workflow.phases.indexOf(agent.phase) + 1 : 0), 0);
  return {
    key: `workflow:${workflow.id}`,
    kind: 'workflow',
    id: workflow.id,
    label: 'workflow',
    description: workflow.name ?? workflow.description,
    mono: false,
    status: workflow.status,
    startedAt: workflow.startedAt,
    endedAt: workflow.endedAt,
    activity: null,
    command: null,
    progress: { done, total: workflow.agents.length, phase },
    segments: workflow.agents.map((agent) => agent.status),
    parent: null,
  };
}

const at = (iso: string | null): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** Running, or ended so recently that its final word is still on show. */
export function isShown(branch: Pick<Branch, 'status' | 'endedAt'>, now: number): boolean {
  if (branch.status === 'running') return true;
  // An ended branch without an end time has nothing to measure its grace from: it has gone
  return branch.endedAt !== null && now - at(branch.endedAt) < BRANCH_GRACE_MS;
}

const oldestFirst = (a: Branch, b: Branch) => at(a.startedAt) - at(b.startedAt) || a.key.localeCompare(b.key);

/**
 * The strip's rows: every branch that runs or ended under five seconds ago, oldest first so rows do
 * not jump, each branch a subagent launched right under it. A launched branch whose owner has
 * already left the strip stands on its own.
 */
export function liveBranches(children: ChatChildren, now: number): Branch[] {
  const top: Array<{ branch: Branch; nested: Branch[] }> = [];
  for (const sub of children.subagents) {
    const branch = agentBranch(sub);
    const own = sub.tasks.map((task) => taskBranch(task)).filter((task) => isShown(task, now));
    if (isShown(branch, now)) top.push({ branch, nested: own.map((task) => ({ ...task, parent: branch.key })).sort(oldestFirst) });
    else for (const task of own) top.push({ branch: task, nested: [] });
  }
  for (const task of children.backgroundTasks) {
    const branch = taskBranch(task);
    if (isShown(branch, now)) top.push({ branch, nested: [] });
  }
  for (const workflow of children.workflows) {
    const branch = workflowBranch(workflow);
    if (isShown(branch, now)) top.push({ branch, nested: [] });
  }
  top.sort((a, b) => oldestFirst(a.branch, b.branch));
  return top.flatMap(({ branch, nested }) => [branch, ...nested]);
}

/** When the next ended branch leaves the strip, so the page knows when to look again; null when none will. */
export function nextExpiry(branches: readonly Branch[], now: number): number | null {
  let next: number | null = null;
  for (const branch of branches) {
    if (branch.status === 'running' || branch.endedAt === null) continue;
    const leaves = at(branch.endedAt) + BRANCH_GRACE_MS;
    if (leaves > now && (next === null || leaves < next)) next = leaves;
  }
  return next;
}

export interface BranchCounts {
  agents: number;
  tasks: number;
  workflows: number;
}

/** What is still running, by kind: the strip's count. */
export function branchCounts(branches: readonly Branch[]): BranchCounts {
  const counts: BranchCounts = { agents: 0, tasks: 0, workflows: 0 };
  for (const branch of branches) {
    if (branch.status !== 'running') continue;
    if (branch.kind === 'agent') counts.agents += 1;
    else if (branch.kind === 'task') counts.tasks += 1;
    else counts.workflows += 1;
  }
  return counts;
}

/**
 * What the folded strip says beside its count: the running subagent whose activity moved last, or,
 * when none reports one, the running branch that started last.
 */
export function newestBranch(branches: readonly Branch[]): Branch | null {
  let acting: { branch: Branch; since: number } | null = null;
  let started: Branch | null = null;
  for (const branch of branches) {
    if (branch.status !== 'running') continue;
    const since = branch.activity ? at(branch.activity.since) : null;
    if (since !== null && (!acting || since >= acting.since)) acting = { branch, since };
    if (!started || at(branch.startedAt) >= at(started.startedAt)) started = branch;
  }
  return acting?.branch ?? started;
}

// ---------- the cards under a step ----------

/** A step's call as far as matching it to a branch needs; `detail` is the CLI's structured result. */
export interface BranchCall {
  id: string;
  name: string | null;
  input: unknown;
  result: { isError: boolean; detail?: unknown } | null;
}

const DELEGATIONS = new Set(['Agent', 'Task']);
const WORKFLOW_TOOL = 'Workflow';
// A call is answered in seconds, the run it starts is stamped a moment after: some slack either side
const LAUNCH_SLACK_MS = 30_000;

const field = (value: unknown, key: string): unknown => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** The id the CLI recorded beside an `Agent` call's result, or a `Bash` call's background task. */
function detailId(call: BranchCall, kind: 'agent' | 'command', key: 'agentId' | 'backgroundTaskId'): string | null {
  const detail = call.result?.detail;
  return field(detail, 'kind') === kind ? text(field(detail, key)) : null;
}

/**
 * The branches a step's calls started, in the order of the calls. Matched exactly where the CLI
 * recorded it: an `Agent` call's agent id, a `Bash` call's background task id, and a subagent still
 * named by the call that launched it. A transcript written before the CLI recorded those falls back
 * to what the call asked for (its description, its command) when only one branch fits; a workflow
 * is matched by the time it started, as its run's id is not in the transcript.
 */
export function branchesOfStep(calls: readonly BranchCall[], span: { startedAt: string | null; endedAt: string | null }, children: ChatChildren): Branch[] {
  const found = new Map<string, Branch>();
  const allTasks = [...children.backgroundTasks, ...children.subagents.flatMap((sub) => sub.tasks)];
  for (const call of calls) {
    if (call.name && DELEGATIONS.has(call.name)) {
      const id = detailId(call, 'agent', 'agentId');
      const sub =
        (id && children.subagents.find((s) => s.id === id)) ||
        children.subagents.find((s) => s.id === call.id) ||
        // No id recorded: only a transcript that predates it, so the description is all there is
        (id ? null : subagentFor(call.input, children.subagents));
      if (sub) found.set(`agent:${sub.id}`, agentBranch(sub));
    } else if (call.name === 'Bash') {
      const id = detailId(call, 'command', 'backgroundTaskId');
      let task = id ? allTasks.find((t) => t.id === id) : undefined;
      if (!task && !id && field(call.input, 'run_in_background') === true) {
        const command = text(field(call.input, 'command'));
        const fits = command ? children.backgroundTasks.filter((t) => t.command?.trim() === command) : [];
        task = fits.length === 1 ? fits[0] : undefined;
      }
      if (task) found.set(`task:${task.id}`, taskBranch(task));
    }
  }
  if (span.startedAt && calls.some((call) => call.name === WORKFLOW_TOOL)) {
    const from = Date.parse(span.startedAt) - LAUNCH_SLACK_MS;
    const to = Date.parse(span.endedAt ?? span.startedAt) + LAUNCH_SLACK_MS;
    for (const workflow of children.workflows) {
      const started = Date.parse(workflow.startedAt);
      if (started >= from && started <= to) found.set(`workflow:${workflow.id}`, workflowBranch(workflow));
    }
  }
  return [...found.values()];
}

/** How long it ran, or has been running: the clock a row or a card shows. */
export function branchElapsed(branch: Pick<Branch, 'startedAt' | 'endedAt'>, now: number): number {
  return Math.max(0, (branch.endedAt ? at(branch.endedAt) : now) - at(branch.startedAt));
}
