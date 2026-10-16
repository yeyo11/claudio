import type { ProviderId, SpendPurpose, ToolPolicy } from '@claudio/shared';
import type { ChatRuntime, NewChat, RunResult } from './chats.ts';

/*
 * One turn of an agent's CLI with nothing around it: no tool, no settings file, no API url or
 * token, no kept session. The state is in the prompt and the answer comes back as
 * `structured_output`. The decision engine's `cli` provider and the lesson miner both run this way,
 * so the part they share lives here and each reads the result its own way.
 */

/** The part of the chat runtime a one-shot drives; the tests hand it the real one over a fake CLI */
export interface OneShotRuntime {
  start(opts: NewChat): ChatRuntime;
  waitForResult(id: string): Promise<RunResult>;
  stop(id: string): unknown;
  exited(id: string): Promise<void>;
  remove(id: string): boolean;
}

/** What a one-shot chat may do: nothing. It has no tool, so the policy states that outright. */
export const NO_TOOLS_POLICY: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'deny', gitPush: 'deny' };

/** How long a stopped chat gets to end before it is removed regardless */
const EXIT_GRACE_MS = 5_000;

export interface OneShotSpec {
  prompt: string;
  name: string;
  purpose: SpendPurpose;
  provider?: ProviderId;
  model: string;
  /** Left to the target's own default when null */
  effort: string | null;
  maxBudgetUsd: number;
  jsonSchema: Record<string, unknown>;
  deadlineMs: number;
  signal: AbortSignal;
}

/** `result`: the turn ended; `timeout`: the deadline or the signal cut it; `failed`: it could not start or the wait threw */
export type OneShotOutcome = { kind: 'result'; result: RunResult } | { kind: 'timeout' } | { kind: 'failed' };

/** The options every one-shot chat is started with; exported so a test can pin them */
export function oneShotChat(spec: OneShotSpec): NewChat {
  return {
    prompt: spec.prompt,
    name: spec.name,
    purpose: spec.purpose,
    ...(spec.provider ? { provider: spec.provider } : {}),
    model: spec.model,
    ...(spec.effort ? { effort: spec.effort } : {}),
    maxBudgetUsd: spec.maxBudgetUsd,
    jsonSchema: spec.jsonSchema,
    internal: true,
    keepAlive: false,
    uploads: false,
    api: false,
    confine: { tools: [], settingSources: [] },
    toolConfig: { preset: null, allowedTools: [], disallowedTools: [], mcp: null, policy: NO_TOOLS_POLICY },
    permissionMode: 'dontAsk',
    permissionPrompts: 'none',
  };
}

/** Stops what is still running and removes the chat: the answer is the row, the chat leaves nothing behind */
async function dispose(runtime: OneShotRuntime, id: string): Promise<void> {
  try {
    runtime.stop(id);
  } catch {
    // already over
  }
  let grace: NodeJS.Timeout | undefined;
  await Promise.race([runtime.exited(id), new Promise((r) => (grace = setTimeout(r, EXIT_GRACE_MS)))]).catch(() => undefined);
  if (grace) clearTimeout(grace);
  runtime.remove(id);
}

/** Starts the chat, waits for its result under the deadline and the signal, and always disposes of it */
export async function runOneShot(runtime: OneShotRuntime, spec: OneShotSpec): Promise<OneShotOutcome> {
  if (spec.signal.aborted) return { kind: 'timeout' };
  let chat: ChatRuntime;
  try {
    chat = runtime.start(oneShotChat(spec));
  } catch {
    return { kind: 'failed' };
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cut = new Promise<'cut'>((resolve) => {
      timer = setTimeout(() => resolve('cut'), spec.deadlineMs);
      onAbort = () => resolve('cut');
      spec.signal.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([runtime.waitForResult(chat.id), cut]);
    if (result === 'cut') return { kind: 'timeout' };
    return { kind: 'result', result };
  } catch {
    return { kind: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) spec.signal.removeEventListener('abort', onAbort);
    await dispose(runtime, chat.id);
  }
}
