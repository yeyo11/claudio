/*
 * The builder confined-chat calls to arm `declared-tools` on a confined API chat
 * (docs/plans/headless-image.md, D14.5 and "Contracts"): from the chat's stored policy, its working
 * directory and its attachment files, to the guard plan its launch passes (`ChatGuardPlan`).
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatGuardPlan } from '../live-chat.ts';
import { CLIENT_TOOL_PREFIX } from '../openai/client-tools.ts';
import type { DeclaredTools } from './input.ts';
import type { GuardLauncher } from './launch.ts';
import { isUnrestrictedBash, parsePermissionRule } from './rules/declared-tools.ts';

/** The part of a chat's `ApiChatPolicy` the rule reads */
export interface DeclaredPolicy {
  allowedTools: readonly string[];
  schema: boolean;
}

export interface DeclaredGuardRequest {
  policy: DeclaredPolicy;
  /** The chat's working directory; it must exist (D9) */
  cwd: string;
  /** The chat's own attachment files read by path, the only paths outside `cwd` a call may name */
  attachments: readonly string[];
}

/** Tools every confined API chat may call: the answer to a schema */
export const ALWAYS_ALLOWED_TOOLS: readonly string[] = ['StructuredOutput'];

export type DeclaredToolsProblem = 'bash-unrestricted' | 'bad-rule';

/** A declared tool list the rule cannot confine; the routes answer it with a `400` */
export class DeclaredToolsError extends Error {
  readonly code: DeclaredToolsProblem;
  readonly rule: string;
  constructor(code: DeclaredToolsProblem, rule: string) {
    super(
      code === 'bash-unrestricted'
        ? `${rule} allows every command; declare the commands, such as Bash(ls *) or Bash(git log *)`
        : `${rule} is not a Claude Code permission rule`,
    );
    this.name = 'DeclaredToolsError';
    this.code = code;
    this.rule = rule;
  }
}

/** The first rule a confined chat may not declare (a bare `Bash` or `Bash(*)`, or no rule at all), or null */
export function declaredToolsProblem(allowedTools: readonly string[]): DeclaredToolsError | null {
  for (const rule of allowedTools) {
    const parsed = parsePermissionRule(rule);
    if (!parsed) return new DeclaredToolsError('bad-rule', rule);
    if (parsed.tool === 'Bash' && isUnrestrictedBash(parsed.spec)) return new DeclaredToolsError('bash-unrestricted', rule);
  }
  return null;
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The rules file's `declared` section; throws a `DeclaredToolsError` for a list it cannot confine */
export function declaredToolsSection(request: DeclaredGuardRequest): DeclaredTools {
  const problem = declaredToolsProblem(request.policy.allowedTools);
  if (problem) throw problem;
  return {
    tools: [...request.policy.allowedTools],
    alwaysAllow: [...ALWAYS_ALLOWED_TOOLS],
    allowPrefixes: [CLIENT_TOOL_PREFIX],
    root: realOrSelf(request.cwd),
    attachments: [...new Set(request.attachments.map(realOrSelf))].sort(),
  };
}

/**
 * Arms `declared-tools` for a confined API chat: checks the guard can run and writes its files.
 * The plan's rules are `integrity` and `declared-tools`, enforcing, whatever the guard settings say.
 */
export function declaredToolsGuard(launcher: GuardLauncher, request: DeclaredGuardRequest): Promise<ChatGuardPlan> {
  return launcher.prepareDeclared(request.cwd, declaredToolsSection(request));
}
