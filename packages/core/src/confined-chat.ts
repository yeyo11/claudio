/*
 * The confined API chat (docs/plans/headless-image.md, D14): every chat of a headless Claudio, and
 * every chat in a workspace in any profile. Its policy is fixed at creation and stored with it; each
 * of its processes starts confined from that policy alone, whatever an earlier execution or a
 * request put in the chat's options (`ChatManager.confineApiChat`).
 */
import { dirname, resolve } from 'node:path';
import type { ApiChatPolicy, ChatStartRefusalCode, PermissionMode, WorkspaceRefusalCode } from '@claudio/shared';
import { declaredToolsProblem } from './guards/declared.ts';
import { parsePermissionRule } from './guards/rules/declared-tools.ts';
import type { ChatConfinement } from './live-chat.ts';
import { STRUCTURED_OUTPUT_TOOL } from './providers/claude-code/stream.ts';

/** The one mode such a chat runs in: what is not declared is denied, and nobody is asked */
export const CONFINED_PERMISSION_MODE: PermissionMode = 'dontAsk';

/** Tools that write files: none may be declared in a workspace, a read-only copy of a source tree */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * A start or continuation refused for a reason the client acts on by its code. `statusCode` and
 * `reason` are what the API's error handler turns into `{ error, code }`; the `/v1` routes map the
 * same codes to their snake_case form (D16).
 */
export class ChatStartRefusal extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 410,
    readonly reason: ChatStartRefusalCode | WorkspaceRefusalCode | null = null,
  ) {
    super(message);
    this.name = 'ChatStartRefusal';
  }
}

/** The working directory of a start is gone: D9 refuses it rather than creating an empty one */
export function cwdMissing(cwd: string, workspaceId: string | null): ChatStartRefusal {
  return workspaceId
    ? new ChatStartRefusal(`workspace '${workspaceId}' has expired or was removed`, 410, 'workspace-expired')
    : new ChatStartRefusal(`the working directory ${cwd} does not exist`, 400, 'cwd-missing');
}

/** What of a start request decides a confined chat's policy, or is refused for one */
export interface ConfinedStartRequest {
  permissionMode?: PermissionMode | undefined;
  allowedTools?: unknown;
  maxTurns?: number | undefined;
  maxBudgetUsd?: number | undefined;
  jsonSchema?: unknown;
  mcp?: unknown;
  claudioMcp?: unknown;
  worktree?: unknown;
  permissionPrompts?: unknown;
}

const refused = (message: string): ChatStartRefusal => new ChatStartRefusal(message, 400);

/**
 * The policy a confined API chat is created with, or a `400` for a request it cannot honour: another
 * permission mode, any MCP server (Claudio's own included), a worktree, host prompts, a rule that
 * lets every command run, or a write tool in a workspace. `allowedTools` are the declared rules,
 * already taken from a named preset by the caller; none declared means the chat can only answer.
 */
export function apiChatPolicy(request: ConfinedStartRequest, context: { workspaceId: string | null; allowedTools: readonly string[]; budgetUsd: number }): ApiChatPolicy {
  if (request.permissionMode !== undefined && request.permissionMode !== CONFINED_PERMISSION_MODE) {
    throw refused(`permissionMode must be ${CONFINED_PERMISSION_MODE} for a confined API chat`);
  }
  if (request.mcp !== undefined && request.mcp !== null) throw refused('a confined API chat loads no MCP server: mcp cannot be given');
  if (request.claudioMcp !== undefined) throw refused("a confined API chat has no way back into Claudio: claudioMcp cannot be given");
  if (request.worktree !== undefined && request.worktree !== null) throw refused('a confined API chat runs in no worktree');
  if (request.permissionPrompts === 'host') throw refused('a confined API chat asks nobody: permissionPrompts must be none');
  const problem = declaredToolsProblem(context.allowedTools);
  if (problem) throw refused(problem.message);
  if (context.workspaceId) {
    const writer = context.allowedTools.find((rule) => WRITE_TOOLS.has(parsePermissionRule(rule)?.tool ?? ''));
    if (writer) throw refused(`a workspace is read only: ${writer} cannot be declared in it`);
  }
  const budget = request.maxBudgetUsd ?? context.budgetUsd;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) throw refused('maxBudgetUsd must be a positive number');
  return {
    workspaceId: context.workspaceId,
    allowedTools: [...context.allowedTools],
    maxTurns: request.maxTurns ?? null,
    maxBudgetUsd: budget,
    schema: request.jsonSchema !== undefined && request.jsonSchema !== null,
  };
}

/** A declared tool list as a request sends it: a list of rules, every one text */
export function declaredRules(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((rule) => typeof rule !== 'string')) throw refused('allowedTools must be a list of permission rules');
  return value as string[];
}

/**
 * The flags a process of the chat is confined with: only the declared tools exist (`--tools`), plus
 * `StructuredOutput` for a schema; no settings file is read; and the only paths the file tools reach
 * beside the working directory are the folders of the chat's own attachments, one per upload,
 * never the uploads folder.
 */
export function confinementOf(policy: ApiChatPolicy, attachmentPaths: readonly string[]): ChatConfinement {
  const tools = new Set<string>();
  for (const rule of policy.allowedTools) {
    const tool = parsePermissionRule(rule)?.tool;
    if (tool) tools.add(tool);
  }
  if (policy.schema) tools.add(STRUCTURED_OUTPUT_TOOL);
  const addDirs = [...new Set(attachmentPaths.map((path) => dirname(resolve(path))))].sort();
  return { tools: [...tools], settingSources: [], ...(addDirs.length ? { addDirs } : {}) };
}

/**
 * Git reads no configuration but the run's own (D14.7): not the system's, not the user's, and it
 * never climbs out of the chat's folder looking for a repository, so a hostile `.git` above it is
 * never found. The ceiling is the workspaces root, and the folder holding the working directory.
 */
export function confinedGitEnv(cwd: string, workspacesRoot: string | null): Record<string, string> {
  const ceilings = [...new Set([workspacesRoot, dirname(resolve(cwd))].filter((dir): dir is string => !!dir))];
  return { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: ceilings.join(':') };
}

/** Whether two policies are the same, for a continuation that names a chat (`409 policy-mismatch`) */
export function samePolicy(a: ApiChatPolicy, b: ApiChatPolicy): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.maxTurns === b.maxTurns &&
    a.maxBudgetUsd === b.maxBudgetUsd &&
    a.schema === b.schema &&
    a.allowedTools.length === b.allowedTools.length &&
    a.allowedTools.every((rule, i) => rule === b.allowedTools[i])
  );
}
