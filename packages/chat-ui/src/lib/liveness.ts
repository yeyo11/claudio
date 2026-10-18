import type { Chat, ChatAgentStatus, ChatChildren, ChatWorkflow, ChatWorkflowAgent, Execution, TranscriptEntry } from '@claudio/shared';

/*
 * Whether something is still going on, said once. Every screen that draws a spinner, a clock or a
 * count for a chat or for what it delegated asks here, so none of them can keep a branch running
 * that nothing holds any more. Pure: the rules are tested without a page.
 *
 * The ground fact is `Chat.alive` (a process holds the chat: ours, a terminal's, another program's).
 * A branch is running only inside a chat that is alive and a workflow's agent only inside a workflow
 * that is running; anything else that still says `running` is a record nobody closed.
 */

/** What these rules read of a chat; a chat summary has no `children`, and a fixture needs no more. */
export type LivenessChat = Pick<Chat, 'alive' | 'state'> & Partial<Pick<Chat, 'updatedAt'>> & {
  executions?: ReadonlyArray<Pick<Execution, 'endedAt'>>;
  children?: ChatChildren;
};

/** What these rules read of a branch. */
export interface BranchState {
  status: ChatAgentStatus;
  endedAt: string | null;
}

/** Whether a process still holds the chat. */
export function chatAlive(chat: Pick<Chat, 'alive'>): boolean {
  return chat.alive;
}

/** When a chat nothing holds stopped: its last execution's end, else its last write; null when neither is known. */
function stoppedAt(chat: LivenessChat): string | null {
  const ended = (chat.executions ?? []).map((e) => e.endedAt).filter((t): t is string => t !== null);
  return ended.sort().at(-1) ?? chat.updatedAt ?? null;
}

/** Whether a branch is working right now: it says so, and the chat it belongs to is still held. */
export function branchLive(chat: Pick<Chat, 'alive'>, branch: Pick<BranchState, 'status'>): boolean {
  return chatAlive(chat) && branch.status === 'running';
}

/**
 * The branch as it should be read: in a chat that is not alive, `running` is `stopped`, ended when
 * the chat was. Anything else is the branch as it came, so a screen that goes through here and a
 * server that already settled it agree.
 */
export function effectiveBranch<B extends BranchState>(chat: LivenessChat, branch: B): B {
  // A waiting agent's own background work went down with the process that held it, as a running one did
  if (chatAlive(chat) || (branch.status !== 'running' && branch.status !== 'waiting')) return branch;
  return { ...branch, status: 'stopped', endedAt: branch.endedAt ?? stoppedAt(chat) };
}

/** Whether a workflow's agent is working: it says so, and its workflow is still running. */
export function workflowAgentLive(workflow: Pick<ChatWorkflow, 'status'>, agent: Pick<ChatWorkflowAgent, 'status'>): boolean {
  return workflow.status === 'running' && agent.status === 'running';
}

/** Whether anything a chat delegated is working now. */
export function anyBranchLive(chat: LivenessChat): boolean {
  const children = chat.children;
  if (!children || !chatAlive(chat)) return false;
  const tasks = [...children.backgroundTasks, ...children.subagents.flatMap((s) => s.tasks)];
  return children.subagents.some((s) => s.status === 'running') || tasks.some((t) => t.status === 'running') || children.workflows.some((w) => w.status === 'running');
}

/**
 * Whether a chat is busy for a list or the shell: its agent is working, or something it delegated
 * is. A chat nothing holds is never busy, whatever its records still say.
 */
export function chatBusy(chat: LivenessChat): boolean {
  return chatAlive(chat) && (chat.state === 'working' || anyBranchLive(chat));
}

// ---------- the call in flight ----------

export interface OpenCall {
  id: string;
  name: string;
  input: unknown;
  /** When the call was made */
  at: string | null;
}

/** A person's own message opens a turn; a tool result is the CLI answering inside one. */
function startsTurn(entry: TranscriptEntry): boolean {
  if (entry.role !== 'user' || entry.isSidechain || entry.compaction) return false;
  return !entry.blocks.some((b) => b.type === 'tool_result') && entry.blocks.some((b) => b.type === 'text' && b.text.trim() !== '');
}

/**
 * The tool call the agent is waiting on in the latest turn, or null. Only what follows the last
 * message a person sent is looked at: a call an interrupt or a crash left without its result in an
 * earlier turn is not running, and reading the whole transcript for it is how a finished chat came
 * to show a command "running". The newest unanswered call of the main agent wins; a subagent's are
 * its own branch's.
 */
export function openCallInTurn(entries: readonly TranscriptEntry[]): OpenCall | null {
  let from = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && startsTurn(entry)) {
      from = i + 1;
      break;
    }
  }
  const turn = entries.slice(from).filter((e) => !e.isSidechain);
  const answered = new Set<string>();
  for (const entry of turn) for (const block of entry.blocks) if (block.type === 'tool_result') answered.add(block.toolUseId);
  for (let i = turn.length - 1; i >= 0; i--) {
    const entry = turn[i];
    if (!entry) continue;
    for (let j = entry.blocks.length - 1; j >= 0; j--) {
      const block = entry.blocks[j];
      if (block?.type === 'tool_use' && !answered.has(block.id)) return { id: block.id, name: block.name, input: block.input, at: entry.timestamp };
    }
  }
  return null;
}
