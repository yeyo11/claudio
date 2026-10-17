import type { AgentReadScope, CollaboratorsSettings, PermissionMode, SharedProject } from '@claudio/shared';

/*
 * Which chats may read teammates' copies through their own token, and which copies
 * (docs/plans/collaborators-agent-access.md). A teammate's text is input the person does not control,
 * so the answer is narrow on purpose:
 *
 * - the Claudio assistant, a confined chat that runs no command, reads every copy, while
 *   Collaborators is on and its switch in Settings is;
 * - any other chat reads only the copies of its own project, and only when that project opted in;
 * - a chat that runs commands without asking (`bypassPermissions`, and `auto` or `dontAsk`, which do
 *   not ask either) reads nothing: orchestration workers run that way;
 * - a copy whose sharer turned "Teammates' agents may read this" off is read by no chat at all.
 *
 * Pure: the core gathers the facts, the API's guard asks.
 */

/** The modes in which a chat asks the person before it runs a command: the only ones that may read */
export const AGENT_READ_MODES: readonly PermissionMode[] = ['manual', 'acceptEdits', 'plan'];

/** What the scope is decided on, about the chat whose token is asking */
export interface AgentReadChat {
  /** Carries the `claudioAssistant` marker */
  assistant: boolean;
  /** The project its working directory is under; null for a loose chat */
  projectId: string | null;
  /** Its live process's mode; null when Claudio has no record of the chat */
  permissionMode: PermissionMode | null;
}

/**
 * Why a chat's token gets no copy. `off`: Collaborators is off. `assistant-off`: the person turned the
 * assistant's reads off. `no-chat`: no record of the chat. `mode`: it runs without asking.
 * `no-project`: a chat under no project. `project-off`: its project did not opt in.
 */
export type AgentReadRefusal = 'off' | 'assistant-off' | 'no-chat' | 'mode' | 'no-project' | 'project-off';

export type AgentReadDecision = { scope: AgentReadScope } | { refusal: AgentReadRefusal };

export function agentReadScope(
  chat: AgentReadChat | null,
  settings: Pick<CollaboratorsSettings, 'enabled' | 'assistantReads'>,
  projectOptedIn: (projectId: string) => boolean,
): AgentReadDecision {
  if (!settings.enabled) return { refusal: 'off' };
  if (!chat || chat.permissionMode === null) return { refusal: 'no-chat' };
  if (!AGENT_READ_MODES.includes(chat.permissionMode)) return { refusal: 'mode' };
  if (chat.assistant) return settings.assistantReads ? { scope: { kind: 'assistant' } } : { refusal: 'assistant-off' };
  if (!chat.projectId) return { refusal: 'no-project' };
  if (!projectOptedIn(chat.projectId)) return { refusal: 'project-off' };
  return { scope: { kind: 'project', projectId: chat.projectId } };
}

/**
 * Whether a copy is in a scope. A copy belongs to the local project it was linked to by hand, or,
 * with no link, to the projects whose key matches it: a link elsewhere takes it out of a match.
 */
export function copyInScope(scope: AgentReadScope, share: Pick<SharedProject, 'agentsMayRead' | 'matches' | 'linkedProjectId'>): boolean {
  if (!share.agentsMayRead) return false;
  if (scope.kind === 'assistant') return true;
  return share.linkedProjectId !== null ? share.linkedProjectId === scope.projectId : share.matches.includes(scope.projectId);
}
