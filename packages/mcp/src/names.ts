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
  'list_orchestrations',
  'get_orchestration',
  'get_team',
  'list_flow_runs',
  'get_journal',
  'list_documents',
  'read_document',
  'list_chats',
  'get_chat',
  'get_usage',
  'list_providers',
  'list_accounts',
] as const;

export type ClaudioMcpReadToolName = (typeof CLAUDIO_MCP_READ_TOOL_NAMES)[number];

/** The names as the CLI sees them, which is what `--allowedTools` takes */
export const CLAUDIO_MCP_READ_TOOLS: readonly string[] = CLAUDIO_MCP_READ_TOOL_NAMES.map((name) => `mcp__${CLAUDIO_MCP_SERVER}__${name}`);

/**
 * The tools that change something. None is ever in `--allowedTools`: each call reaches the person as
 * a permission prompt in the chat, and a call nobody confirms never reaches the API.
 */
export const CLAUDIO_MCP_WRITE_TOOL_NAMES = [
  'create_work_item',
  'update_work_item',
  'move_work_item',
  'comment_work_item',
  'retry_flow_run',
  'retry_orchestration_task',
  'start_chat',
  'accept_assistant_proposal',
  'discard_assistant_proposal',
] as const;

export type ClaudioMcpWriteToolName = (typeof CLAUDIO_MCP_WRITE_TOOL_NAMES)[number];
export type ClaudioMcpToolName = ClaudioMcpReadToolName | ClaudioMcpWriteToolName;

export const CLAUDIO_MCP_WRITE_TOOLS: readonly string[] = CLAUDIO_MCP_WRITE_TOOL_NAMES.map((name) => `mcp__${CLAUDIO_MCP_SERVER}__${name}`);

/** Whether the CLI's name for a tool is one of Claudio's write tools */
export const isClaudioMcpWriteTool = (toolName: string): boolean => CLAUDIO_MCP_WRITE_TOOLS.includes(toolName);
