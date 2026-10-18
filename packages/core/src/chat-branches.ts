import type {
  ChatActivity,
  ChatBackgroundTask,
  ChatBranchStatus,
  ChatChildren,
  ChatEnvironment,
  ChatSubagent,
  ChatWorkflow,
  ChatWorkflowAgent,
  EffectiveEnvironment,
  McpHealthStatus,
} from '@claudio/shared';
import { closeRuns } from '@claudio/shared';
import type { BackgroundTask, SubagentInfo, WorkflowAgentState, WorkflowRun } from './cli-facts.ts';

// What a chat delegated, in Claudio's words. The CLI reports the same work three ways (its stream,
// the files beside the transcript, its task notifications) and names the states differently in each;
// this is where they become one vocabulary, so nothing above it needs to know which pipe a record
// came through.

/**
 * The CLI's task states, in the four a person reads. A word it has not said before is read as
 * `stopped`, never as work in progress: an unknown state must not keep a chat looking busy.
 */
export function branchStatus(status: string): ChatBranchStatus {
  if (status === 'running' || status === 'pending' || status === 'started' || status === 'in_progress') return 'running';
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'stopped';
}

export function toChatTask(task: BackgroundTask): ChatBackgroundTask {
  return {
    id: task.id,
    kind: task.type,
    description: task.description,
    command: task.command ?? null,
    status: branchStatus(task.status),
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    summary: task.summary,
    byPerson: task.backgroundedByUser === true,
    ownerId: task.ownerAgentId ?? null,
  };
}

/**
 * A subagent with what it is doing right now, which only the live process knows (its sidechain's
 * open calls); one read from the files on disk has none.
 */
export type LiveSubagent = SubagentInfo & { activity?: ChatActivity | null };

/** The id a subagent goes by inside its chat: its transcript's, or its launching call's until it has one. */
const subagentId = (sub: SubagentInfo): string => sub.agentId ?? sub.toolUseId;

export function toChatSubagent(sub: LiveSubagent, tasks: ChatBackgroundTask[], sessionId: string): ChatSubagent {
  const id = subagentId(sub);
  return {
    id,
    sessionId,
    kind: sub.subagentType,
    description: sub.description,
    status: sub.status,
    startedAt: sub.startedAt,
    endedAt: sub.endedAt,
    runs: sub.runs ?? [{ startedAt: sub.startedAt, endedAt: sub.endedAt }],
    lastActivityAt: sub.lastActivityAt ?? null,
    cwd: sub.cwd ?? null,
    tasks: tasks.filter((t) => t.ownerId === id),
    // An ended agent is doing nothing, whatever its last call left open
    activity: sub.status === 'running' ? (sub.activity ?? null) : null,
  };
}

/**
 * An agent that has not reported done or failed is running only while its workflow is: once the
 * workflow has ended, whatever it was left doing ended with it, and takes the workflow's outcome.
 */
function agentStatus(state: string, workflow: ChatBranchStatus): ChatWorkflowAgent['status'] {
  if (state === 'done') return 'completed';
  if (state === 'error') return 'failed';
  return workflow;
}

function toWorkflowAgent(agent: WorkflowAgentState, workflow: ChatBranchStatus): ChatWorkflowAgent {
  return {
    index: agent.index,
    label: agent.label,
    status: agentStatus(agent.state, workflow),
    id: agent.agentId,
    phase: agent.phaseTitle,
    model: agent.model,
    startedAt: agent.startedAt,
    durationMs: agent.durationMs,
    tokens: agent.tokens,
    toolCalls: agent.toolCalls,
    promptPreview: agent.promptPreview,
    resultPreview: agent.resultPreview,
  };
}

export function toChatWorkflow(workflow: WorkflowRun): ChatWorkflow {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    startedAt: workflow.startedAt,
    endedAt: workflow.endedAt,
    phases: workflow.phases,
    agents: workflow.agents.map((a) => toWorkflowAgent(a, workflow.status)),
    ...(workflow.result !== undefined ? { result: workflow.result } : {}),
    summary: workflow.summary,
    totalTokens: workflow.totalTokens,
    script: workflow.script,
  };
}

/** What the CLI reported delegated, wherever it was read from. */
export interface BranchFacts {
  subagents: LiveSubagent[];
  tasks: BackgroundTask[];
  workflows: WorkflowRun[];
}

/**
 * Ends what a chat that nothing holds any more still reports as running: its process took the
 * work down with it, whatever the file or the stream last said. `endedAt` is when that was, the
 * last execution's end or the session's last write, so a clock stops there instead of counting on.
 */
export function settleChildren(children: ChatChildren, endedAt: string): ChatChildren {
  const task = (t: ChatBackgroundTask): ChatBackgroundTask => (t.status === 'running' ? { ...t, status: 'stopped', endedAt: t.endedAt ?? endedAt } : t);
  return {
    subagents: children.subagents.map((s) => ({
      ...s,
      ...(s.status === 'running' ? { status: 'stopped' as const, endedAt: s.endedAt ?? endedAt, runs: closeRuns(s.runs, s.endedAt ?? endedAt) } : {}),
      // An ended agent is doing nothing, whatever its last call left open
      activity: null,
      tasks: s.tasks.map(task),
    })),
    backgroundTasks: children.backgroundTasks.map(task),
    workflows: children.workflows.map((w) => {
      const status = w.status === 'running' ? 'stopped' : w.status;
      return {
        ...w,
        status,
        endedAt: w.status === 'running' ? (w.endedAt ?? endedAt) : w.endedAt,
        agents: w.agents.map((a) => (a.status === 'running' ? { ...a, status } : a)),
      };
    }),
  };
}

/**
 * A chat's branches. A command a subagent launched belongs to that subagent and is listed under
 * it; the chat's own are the ones nobody else launched. Running work comes first. With `settleAt`
 * the chat is not alive, and nothing in it is reported as running.
 */
export function toChildren({ subagents, tasks, workflows }: BranchFacts, sessionId: string, settleAt?: string): ChatChildren {
  const children = group({ subagents, tasks, workflows }, sessionId);
  return settleAt === undefined ? children : settleChildren(children, settleAt);
}

/**
 * One record per agent id. Two can only meet when facts from two places disagree about the same
 * agent; the one that saw more of its runs wins, then the older start, so a later duplicate can
 * never shadow the agent it repeats.
 */
function oneEach(subagents: LiveSubagent[]): LiveSubagent[] {
  const byId = new Map<string, LiveSubagent>();
  for (const sub of subagents) {
    const id = subagentId(sub);
    const held = byId.get(id);
    const better = !held || (sub.runs?.length ?? 1) > (held.runs?.length ?? 1) || ((sub.runs?.length ?? 1) === (held.runs?.length ?? 1) && sub.startedAt < held.startedAt);
    if (better) byId.set(id, sub);
  }
  return [...byId.values()];
}

function group({ subagents, tasks, workflows }: BranchFacts, sessionId: string): ChatChildren {
  const mapped = tasks.map(toChatTask);
  const owners = new Set(subagents.map(subagentId));
  const running = (a: { status: string; startedAt: string }, b: { status: string; startedAt: string }) =>
    Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt);
  return {
    subagents: oneEach(subagents).map((s) => toChatSubagent(s, mapped, sessionId)).sort(running),
    backgroundTasks: mapped.filter((t) => t.ownerId === null || !owners.has(t.ownerId)).sort(running),
    workflows: workflows.map(toChatWorkflow).sort(running),
  };
}

const MCP_STATUSES: readonly McpHealthStatus[] = ['connected', 'failed', 'needs-auth', 'pending', 'unknown'];

/** What Claude loaded when a chat last started in its directory, without the CLI's provenance fields. */
export function toChatEnvironment(env: EffectiveEnvironment): ChatEnvironment {
  return {
    observedAt: env.observedAt,
    model: env.model,
    permissionMode: env.permissionMode,
    outputStyle: env.outputStyle,
    tools: env.tools,
    mcpServers: env.mcpServers.map((s) => ({ name: s.name, status: MCP_STATUSES.find((k) => k === s.status) ?? 'unknown' })),
    agents: env.agents,
    skills: env.skills,
    slashCommands: env.slashCommands,
    plugins: env.plugins.map((p) => ({ name: p.name, ...(p.path ? { path: p.path } : {}) })),
    memoryPaths: env.memoryPaths,
  };
}
