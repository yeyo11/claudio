/*
 * What a PreToolUse hook is given, and how the guard sorts a tool call into classes by its name and
 * the shape of its input (docs/plans/guards.md, "Rule catalogue"). Only `node:` imports.
 */

/* Same unions as `@claudio/shared`; kept here so the guard program imports nothing outside `guards/` (a test checks they agree) */
export type GuardRuleId = 'integrity' | 'no-verify' | 'push' | 'destructive' | 'secrets' | 'protect-configs' | 'declared-tools';
export type GuardMode = 'enforce' | 'observe';

export interface GuardLimits {
  maxInputBytes: number;
  maxScriptBytes: number;
  maxFilesRead: number;
  maxDepth: number;
  deadlineMs: number;
}

export const DEFAULT_LIMITS: Readonly<GuardLimits> = {
  maxInputBytes: 16 * 1024 * 1024,
  maxScriptBytes: 1024 * 1024,
  maxFilesRead: 8,
  maxDepth: 4,
  deadlineMs: 3000,
};

/**
 * What a confined API chat declared, as `declared-tools` reads it (docs/plans/headless-image.md,
 * D14.5). Its presence arms the rule, whatever `rules` and `mode` say.
 */
export interface DeclaredTools {
  /** The chat's permission rules as declared: `Read`, `Bash(ls *)`, `mcp__server__tool` */
  tools: string[];
  /** Tools that always pass: `StructuredOutput` */
  alwaysAllow: string[];
  /** Name prefixes that always pass: the `/v1` client-tool stub's `mcp__client__` */
  allowPrefixes: string[];
  /** Real path of the chat's working directory; every path a call names must resolve inside it */
  root: string;
  /** Real paths of the chat's own attachment files, the only paths outside `root` a call may name */
  attachments: string[];
}

/** The rules file the guard reads; internal to core, not part of the HTTP contract */
export interface GuardRulesFile {
  version: 1;
  mode: GuardMode;
  /** Effective rules, `integrity` first */
  rules: GuardRuleId[];
  /** Real paths: the run's worktree (or cwd for a chat), plus extra roots */
  roots: string[];
  mainCheckout: string | null;
  hooksPathDir: string | null;
  /** The run's own scratch dir, exported as `TMPDIR`; recursive deletes inside it pass (Resolved question 1) */
  tmpDir?: string | null;
  /** Folder of one-use "Allow once" files (interactive chats only); absent when the run offers none */
  allowDir?: string | null;
  dataDir: string;
  guardDir: string;
  claudeConfigDirs: string[];
  protectConfigs: string[];
  knownSecretSha256: string[];
  limits: GuardLimits;
  /** A confined API chat's declared policy; absent for every other run */
  declared?: DeclaredTools | null;
}

export interface HookInput {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  session_id?: string;
  cwd?: string;
}

export interface Decision {
  verdict: 'pass' | 'block';
  rule?: GuardRuleId;
  reason?: string;
  /** Stable id of the check that fired, for example `push.git-verb` */
  matcher?: string;
}

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The parsed stdin as a hook input; null when it is not one */
export function parseHookInput(value: unknown): HookInput | null {
  if (!isMap(value)) return null;
  const { hook_event_name: event, tool_name: tool, tool_input: toolInput } = value;
  if (typeof event !== 'string' || typeof tool !== 'string' || !isMap(toolInput)) return null;
  const input: HookInput = { hook_event_name: event, tool_name: tool, tool_input: toolInput };
  if (typeof value.tool_use_id === 'string') input.tool_use_id = value.tool_use_id;
  if (typeof value.session_id === 'string') input.session_id = value.session_id;
  if (typeof value.cwd === 'string') input.cwd = value.cwd;
  return input;
}

/** One file a tool writes, with the text it puts there */
export interface WriteTarget {
  path: string | null;
  contents: string[];
  /** Text the edit replaces, so moving an existing secret around is not a new write */
  oldContents: string[];
}

export type ToolClass = 'bash' | 'write' | 'mcp' | 'delegating' | 'other';

export interface ToolView {
  kind: ToolClass;
  /** Shell command lines the tool runs */
  commands: string[];
  writes: WriteTarget[];
  /** Some string field is longer than the input limit */
  oversize: boolean;
}

const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path', 'target', 'destination']);
const MCP_PATH_KEYS = new Set([...PATH_KEYS, 'file', 'filename', 'filepath', 'dest', 'destination_path', 'target_path', 'output_path']);
const CONTENT_KEYS = new Set(['content', 'text', 'body', 'data', 'new_string', 'new_source', 'patch', 'contents', 'file_text', 'new_str']);
const OLD_KEYS = new Set(['old_string', 'old_source', 'old_str']);
const COMMAND_KEYS = ['command', 'cmd', 'script'];
/** An MCP tool whose name says it changes files, so its path field is a write target even without content */
const MUTATING = /write|edit|create|save|put|delete|remove|move|rename|append|patch|update|replace|truncate|mkdir|copy|touch|chmod/i;
const DELEGATING = new Set(['Task', 'Agent', 'Workflow']);
const MAX_WALK_DEPTH = 8;

interface Collected {
  paths: string[];
  contents: string[];
  olds: string[];
  commands: string[];
  oversize: boolean;
}

function collect(value: unknown, depth: number, limit: number, pathKeys: ReadonlySet<string>, out: Collected, key = ''): void {
  if (typeof value === 'string') {
    if (value.length > limit || (value.length * 3 > limit && Buffer.byteLength(value) > limit)) out.oversize = true;
    if (pathKeys.has(key)) out.paths.push(value);
    else if (CONTENT_KEYS.has(key)) out.contents.push(value);
    else if (OLD_KEYS.has(key)) out.olds.push(value);
    else if (COMMAND_KEYS.includes(key) && depth <= 1) out.commands.push(value);
    return;
  }
  if (depth >= MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, depth + 1, limit, pathKeys, out, key);
  } else if (isMap(value)) {
    for (const [name, item] of Object.entries(value)) collect(item, depth + 1, limit, pathKeys, out, name);
  }
}

/** Sorts a tool call into a class, and pulls out what the rules look at */
export function classify(input: HookInput, limit: number): ToolView {
  const name = input.tool_name;
  const found: Collected = { paths: [], contents: [], olds: [], commands: [], oversize: false };
  const isMcp = name.startsWith('mcp__');
  collect(input.tool_input, 0, limit, isMcp ? MCP_PATH_KEYS : PATH_KEYS, found);
  const view: ToolView = { kind: 'other', commands: found.commands, writes: [], oversize: found.oversize };
  if (DELEGATING.has(name)) {
    view.kind = 'delegating';
    return view;
  }
  const hasPath = found.paths.length > 0;
  const hasContent = found.contents.length > 0 || found.olds.length > 0;
  const writeTool = name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit';
  if (writeTool || (hasPath && hasContent) || (isMcp && (hasContent || (hasPath && MUTATING.test(name))))) {
    if (found.paths.length <= 1) view.writes.push({ path: found.paths[0] ?? null, contents: found.contents, oldContents: found.olds });
    else for (const path of found.paths) view.writes.push({ path, contents: found.contents, oldContents: found.olds });
  }
  if (isMcp) view.kind = 'mcp';
  else if (name === 'Bash' || found.commands.length > 0) view.kind = 'bash';
  else if (view.writes.length > 0) view.kind = 'write';
  return view;
}
