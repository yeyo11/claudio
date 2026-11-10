/**
 * The tools of Claudio's own MCP server, by name. A file of its own, with no import, so the core can
 * build an allow list from it without loading the server: a test checks the catalogue in tools.ts
 * against this list, which keeps the two the same.
 */
export const CLAUDIO_MCP_SERVER = 'claudio';

export const CLAUDIO_MCP_READ_TOOL_NAMES = [
  'list_projects',
  'get_overview',
  'get_board',
  'get_work_item',
  'list_milestones',
  'list_orchestrations',
  'get_orchestration',
  'get_orchestration_plan',
  'list_orchestration_templates',
  'get_orchestration_template',
  'list_assistant_proposals',
  'get_team',
  'list_agents',
  'list_flow_runs',
  'get_journal',
  'list_documents',
  'read_document',
  'list_chats',
  'get_chat',
  'get_usage',
  'list_providers',
  'list_accounts',
  'list_schedules',
  'get_schedule_runs',
  'preview_schedule',
] as const;

export type ClaudioMcpReadToolName = (typeof CLAUDIO_MCP_READ_TOOL_NAMES)[number];

/** The names as the CLI sees them, which is what `--allowedTools` takes */
export const CLAUDIO_MCP_READ_TOOLS: readonly string[] = CLAUDIO_MCP_READ_TOOL_NAMES.map((name) => `mcp__${CLAUDIO_MCP_SERVER}__${name}`);

/**
 * The tools that change something. None is ever in `--allowedTools`: each call reaches the person as
 * a permission prompt in the chat, and a call nobody confirms never reaches the API. Each calls only
 * routes a chat's own token may call (`work`, docs/plans/regression-fixes-2026-10-29.md, C1): no
 * delete, no setting, no account, no security.
 */
export const CLAUDIO_MCP_WRITE_TOOL_NAMES = [
  'create_work_item',
  'update_work_item',
  'check_criterion',
  'move_work_item',
  'comment_work_item',
  'retry_flow_run',
  'plan_orchestration',
  'launch_orchestration',
  'stop_orchestration',
  'resume_orchestration',
  'retry_orchestration_task',
  'retry_orchestration_task_clean',
  'rerun_orchestration_task',
  'skip_orchestration_task',
  'message_orchestration_task',
  'verify_orchestration',
  'retry_orchestration_review',
  'relaunch_orchestration',
  'launch_orchestration_template',
  'start_chat',
  'send_chat_message',
  'hint_chat',
  'message_chat_subagent',
  'interrupt_chat',
  'stop_chat',
  'resume_chat',
  'fork_chat',
  'accept_assistant_proposal',
  'discard_assistant_proposal',
  'create_schedule',
  'update_schedule',
  'run_schedule',
  'delete_schedule',
] as const;

export type ClaudioMcpWriteToolName = (typeof CLAUDIO_MCP_WRITE_TOOL_NAMES)[number];

/**
 * The writes that call the person's own orchestration routes (`person`): deleting a graph,
 * integrating it, its pull request, accepting its review gate, the spend pass, the Supervisor's
 * proposals, pruning worktrees, saving its workflow and changing the templates. A chat's token
 * reaches them only while the person has switched Claudio's server on for that chat, which makes it
 * the owner on every `/orchestrations*` route (D12 of docs/plans/claudio-servers.md); the API reads
 * the switch at every call and refuses every other chat, the assistant and the workers included. So
 * they are kept out of the assistant's guide (`CAPABILITIES`), which promises only what it can do.
 * They are writes like the others: never allowed ahead of time, each confirmed by the person.
 */
export const CLAUDIO_MCP_OWNER_TOOL_NAMES = [
  'delete_orchestration',
  'integrate_orchestration',
  'open_orchestration_pull_request',
  'accept_orchestration_review',
  'grant_orchestration_spend_pass',
  'send_supervisor_proposal',
  'dismiss_supervisor_proposal',
  'prune_orchestration_worktrees',
  'save_orchestration_workflow',
  'create_orchestration_template',
  'update_orchestration_template',
  'delete_orchestration_template',
] as const;

export type ClaudioMcpOwnerToolName = (typeof CLAUDIO_MCP_OWNER_TOOL_NAMES)[number];

/**
 * The reads of what teammates share (docs/plans/collaborators-agent-access.md). Offered only to a
 * chat whose scope allows it: the assistant while its switch is on, a chat of a project that opted
 * in. Each reads this install's copy, and the API checks the chat's scope again at every call.
 */
export const CLAUDIO_MCP_COLLAB_TOOL_NAMES = [
  'collab_list_shared',
  'collab_read_chats',
  'collab_read_transcript',
  'collab_read_memory',
  'collab_read_documents',
  'collab_read_board',
  'collab_read_journal',
] as const;

export type ClaudioMcpCollabToolName = (typeof CLAUDIO_MCP_COLLAB_TOOL_NAMES)[number];
export type ClaudioMcpToolName = ClaudioMcpReadToolName | ClaudioMcpWriteToolName | ClaudioMcpOwnerToolName | ClaudioMcpCollabToolName;

export const CLAUDIO_MCP_COLLAB_TOOLS: readonly string[] = CLAUDIO_MCP_COLLAB_TOOL_NAMES.map((name) => `mcp__${CLAUDIO_MCP_SERVER}__${name}`);

/**
 * Which tools a server process offers, from `CLAUDIO_MCP_TOOLSETS` (comma separated): `claudio` is the
 * assistant's reads and writes, `collab` the reads of teammates' copies. Unset, it is `claudio`.
 */
export const CLAUDIO_MCP_TOOLSETS_ENV = 'CLAUDIO_MCP_TOOLSETS';
export const CLAUDIO_MCP_TOOLSET_NAMES = ['claudio', 'collab'] as const;
export type ClaudioMcpToolset = (typeof CLAUDIO_MCP_TOOLSET_NAMES)[number];

/**
 * The toolsets an environment value names. Unset or empty is `claudio`, as before toolsets; unknown
 * names are dropped, so a value naming nothing known offers nothing rather than more.
 */
export function toolsetsFrom(value: string | undefined): ClaudioMcpToolset[] {
  if (!value?.trim()) return ['claudio'];
  const named = value
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is ClaudioMcpToolset => (CLAUDIO_MCP_TOOLSET_NAMES as readonly string[]).includes(part));
  return [...new Set(named)];
}

/** Every write as the CLI names it, the owner's orchestration writes included: none is ever pre-allowed nor "always allowed" */
export const CLAUDIO_MCP_WRITE_TOOLS: readonly string[] = [...CLAUDIO_MCP_WRITE_TOOL_NAMES, ...CLAUDIO_MCP_OWNER_TOOL_NAMES].map((name) => `mcp__${CLAUDIO_MCP_SERVER}__${name}`);

/** Whether the CLI's name for a tool is one of Claudio's write tools */
export const isClaudioMcpWriteTool = (toolName: string): boolean => CLAUDIO_MCP_WRITE_TOOLS.includes(toolName);
