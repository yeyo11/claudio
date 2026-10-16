import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewDimension } from '@claudio/shared';
import { agentsFileFor } from './agents-file.ts';

/**
 * The role of each reviewer: what to look for. Claudio supplies the head, the rules and the tail of
 * every reviewer prompt (review-prompts.ts), so a role file, however a team edits it, cannot take
 * away the untrusted-data rules or give a reviewer a tool (D13).
 */

export type ReviewRole = ReviewDimension | 'verifier';

export const REVIEW_ROLES: readonly ReviewRole[] = ['correctness', 'tests', 'security', 'conventions', 'verifier'];

/** A role body past this is not used: a page of rules is a prompt nobody reviewed */
export const ROLE_MAX_BYTES = 16 * 1024;

/** The reviewer's definition always gets these and nothing else */
export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];

export const DEFAULT_ROLE_BODIES: Readonly<Record<ReviewRole, string>> = {
  correctness: [
    'Your dimension is correctness: does the changed code do what it was meant to do, on every path it can take?',
    'Look for:',
    '- Logic errors: wrong conditions, inverted checks, off-by-one errors, wrong operators, wrong order of operations.',
    '- Null and undefined paths, including an index or a lookup that may return nothing, in code that does not assume the value is there.',
    '- Errors that are swallowed or not handled, promises that are not awaited or whose rejection nobody sees, and race conditions between processes or requests that share state.',
    '- Resources that are opened and not closed: files, processes, timers, listeners, connections.',
    '- A changed function whose unchanged callers still rely on the old behaviour. Grep for the callers.',
    '- Code that was removed or renamed but is still referenced somewhere. Grep for the old name.',
    '- A change to what is stored without a migration for what already exists, and a change to what an API returns without the shared types that describe it.',
    'A change in behaviour that the objective asks for is not a bug. A change nobody asked for is worth a finding when it can hurt.',
  ].join('\n'),
  tests: [
    'Your dimension is tests: would the tests catch it if the changed behaviour broke?',
    'Look for:',
    '- Changed behaviour with no test that would fail without the change.',
    '- An assertion that was loosened, deleted or rewritten to match new output, with no reason in the change.',
    '- A test that cannot fail: it asserts nothing, it asserts on a value it set itself, or everything it checks is mocked.',
    '- A test left skipped or focused, and flaky patterns: waits on a timer, the real clock, a fixed port, the order of files on disk.',
    'Do not ask for tests of trivial code (a getter, a constant, a re-export). Name the missing test as a case: the input and what it should show.',
  ].join('\n'),
  security: [
    'Your dimension is security: can the changed code be made to do what its author did not intend, by someone who controls an input?',
    'Look for:',
    '- Injection: text reaching a shell command, a SQL statement, a file path, or rendered HTML or Markdown without being escaped or constrained.',
    '- A new route, handler or tool with no check of who is calling, or a check on the wrong thing.',
    '- Secrets in code, logs, error messages or stored records.',
    '- Unsafe deserialization, a request to an address the caller chooses (SSRF), and any outbound call that is new.',
    '- Permissions that grew: tool policies, file modes, a sandbox or confinement that was relaxed.',
    '- Weak randomness or weak hashing where the value is a secret or an identifier that must not be guessed.',
    '- Untrusted text, such as file contents, task results or user input, that reaches a prompt for a model without being marked as material.',
    'Say who controls the input and what they gain. A pattern that looks risky but whose input is fixed by the program is not a finding.',
  ].join('\n'),
  conventions: [
    'Your dimension is conventions: does the change follow the rules this project wrote down?',
    'The project rules are quoted below, as they were before this change. Look for:',
    '- A departure from a rule that a reader of the change would notice and that the rule states explicitly. Cite the rule in the evidence, quoting its words.',
    'Do not report anything a linter or a formatter enforces, a preference of your own, or anything the rules do not say. If no rules are quoted, there is nothing to report.',
  ].join('\n'),
  verifier: [
    'You are the verifier: other reviewers made claims about a change, and you decide which of them hold.',
    '- Your default for each claim is refuted.',
    '- Confirm a claim only with evidence from the code you read: the lines that make the failure happen, and the path that reaches them.',
    '- Refute a claim when the code shows it cannot happen, when something else handles it, or when its scenario needs a state the code rules out.',
    '- Answer uncertain only when the code genuinely does not settle it, and say what would.',
    'Judge the claim, not its wording or the confidence of its author.',
  ].join('\n'),
};

export interface RoleBody {
  body: string;
  source: 'builtin' | 'project';
  /** sha-256 of the body that ran */
  sha: string;
  /** Why the built-in body ran when a project file exists, in English; null when nothing was wrong */
  problem: string | null;
}

export function roleFileName(role: ReviewRole): string {
  return `claudio-review-${role}.md`;
}

function shaOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function builtin(role: ReviewRole, problem: string | null): RoleBody {
  const body = DEFAULT_ROLE_BODIES[role];
  return { body, source: 'builtin', sha: shaOf(body), problem };
}

/**
 * The role for a dimension: the project's file when it has a usable one, otherwise Claudio's.
 * `projectHome` is the project checkout, never the integration branch: a worker must not weaken
 * its own reviewer in the diff under review (D12). Front matter, with its `tools`, `disallowedTools`
 * and `model`, is stripped and ignored (D13).
 */
export async function readRole(projectHome: string, role: ReviewRole): Promise<RoleBody> {
  const file = roleFileName(role);
  let content: string;
  try {
    content = await readFile(join(projectHome, '.claude', 'agents', file), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return builtin(role, null);
    return builtin(role, `${file} could not be read; the built-in role ran`);
  }
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  if (!body) return builtin(role, `${file} has no text after its front matter; the built-in role ran`);
  if (Buffer.byteLength(body) > ROLE_MAX_BYTES) return builtin(role, `${file} is over ${String(ROLE_MAX_BYTES / 1024)} KB; the built-in role ran`);
  return { body, source: 'project', sha: shaOf(body), problem: null };
}

/**
 * How a role reaches the CLI. `agents` writes a definition for `--agents` and selects it with
 * `--agent`; `system-prompt` passes the body as `--append-system-prompt`. Which one holds under
 * `--restricted` is a fact of the CLI (plan, F1); the caller picks, and this is the only place that
 * knows the difference.
 */
export type RoleDelivery = 'agents' | 'system-prompt';

export interface RoleLaunch {
  agent?: string;
  agentsFile?: string;
  appendSystemPrompt?: string;
}

export async function deliverRole(
  mode: RoleDelivery,
  opts: { dataDir: string; role: ReviewRole; body: string; model: string },
): Promise<RoleLaunch> {
  if (mode === 'system-prompt') return { appendSystemPrompt: opts.body };
  const name = `claudio-review-${opts.role}`;
  const agentsFile = await agentsFileFor(opts.dataDir, name, {
    description: `Claudio's ${opts.role} reviewer`,
    prompt: opts.body,
    model: opts.model,
    tools: REVIEW_TOOLS,
  });
  return { agent: name, agentsFile };
}
