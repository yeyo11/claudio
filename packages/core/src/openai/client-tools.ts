import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PermissionDecision } from '@claudio/shared';
import type { PermissionQuestion } from '../providers/driver.ts';
import { stableStringify } from './conversation-key.ts';
import type { OpenAiFailure } from './errors.ts';
import type { ChatMessage, ClientTool, ToolCall, ToolChoice } from './wire.ts';

/**
 * The client-tool handoff of the OpenAI surface (docs/openai-compatible-api.md, phase 4): a client's
 * `tools` become a stub MCP server the CLI loads, the CLI's `can_use_tool` request for each call is
 * held here rather than answered, the HTTP turn ends with the calls, and the client's results on the
 * next request let the held requests through, so the stub hands the CLI each result as it calls it.
 * Measured against the real CLI in docs/plans/openai-compatible-api-spike.md.
 */

/** The stub server's name: the CLI shows its tools to the model as `mcp__client__<name>`. */
export const CLIENT_TOOLS_SERVER = 'client';
export const CLIENT_TOOL_PREFIX = `mcp__${CLIENT_TOOLS_SERVER}__`;
/** The longest name the model's API takes for a tool, which the prefix counts toward */
const MAX_TOOL_NAME = 64;
export const MAX_CLIENT_TOOL_NAME = MAX_TOOL_NAME - CLIENT_TOOL_PREFIX.length;

/**
 * Claude Code's own tool names. A client tool of the same name would sit beside the built-in one in
 * the model's list under a prefix the model does not always repeat, and a `tool_choice` naming it, or
 * the client reading a call back, would be ambiguous: refused, compared without case.
 */
const BUILT_IN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'LS',
  'ListMcpResourcesTool',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Read',
  'ReadMcpResourceTool',
  'Skill',
  'SlashCommand',
  'StructuredOutput',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
];
const BUILT_IN = new Set(BUILT_IN_TOOLS.map((n) => n.toLowerCase()));

/** The deny `permissionPrompts: 'none'` gives: what a client-tool chat answers for every built-in tool. */
export const NOBODY_ANSWERS = 'Nobody is answering permission prompts for this chat';
/** What the CLI gives the model when the client never sent a result (spike: a clean error result). */
export const CLIENT_TIMEOUT_MESSAGE = 'the client did not return a result for this call in time';
/** What a held call gets when the client moved on without its result */
export const CLIENT_ABANDONED_MESSAGE = 'the client sent a new message instead of a result for this call';

/** The client tools a `tool_choice` lets the model call, by the client's names. */
export function allowedToolNames(choice: ToolChoice, tools: readonly ClientTool[]): Set<string> {
  if (choice.kind === 'none') return new Set();
  if (choice.kind === 'function') return new Set([choice.name]);
  return new Set(tools.map((t) => t.name));
}

/** The client's name of a CLI tool name, or null when it is not one of the stub's tools. */
export function clientToolName(cliName: string): string | null {
  return cliName.startsWith(CLIENT_TOOL_PREFIX) ? cliName.slice(CLIENT_TOOL_PREFIX.length) : null;
}

/**
 * Why the request's tools cannot be served, or null. The parser already checked the name's
 * characters and duplicates; this is what the stub adds: the prefix's room and the built-ins.
 */
export function clientToolsProblem(tools: readonly ClientTool[], paramOf: (index: number) => string = (i) => `tools[${String(i)}].function.name`): OpenAiFailure | null {
  for (const [i, tool] of tools.entries()) {
    const param = paramOf(i);
    if (tool.name.length > MAX_CLIENT_TOOL_NAME) {
      return { kind: 'invalid-request', param, message: `The tool name \`${tool.name}\` is too long: the CLI lists it as \`${CLIENT_TOOL_PREFIX}${tool.name}\`, and a tool name is at most ${String(MAX_TOOL_NAME)} characters, so client tool names are at most ${String(MAX_CLIENT_TOOL_NAME)}.` };
    }
    if (BUILT_IN.has(tool.name.toLowerCase())) {
      return { kind: 'invalid-request', param, message: `The tool name \`${tool.name}\` is one of Claude Code's own tools; rename it.` };
    }
  }
  const lower = new Set<string>();
  for (const tool of tools) {
    const key = tool.name.toLowerCase();
    if (lower.has(key)) return { kind: 'invalid-request', param: 'tools', message: `Two tools are named \`${tool.name}\` but for their case; the model would not tell them apart.` };
    lower.add(key);
  }
  return null;
}

/** Whether two requests declare the same tools: what a live stub serves cannot change. */
export function sameTools(a: readonly ClientTool[], b: readonly ClientTool[]): boolean {
  // Names compare with their case: a renamed tool is listed under another name, so the model would
  // call a name the live stub does not serve. The case-blind rule above only keeps one list unambiguous
  const form = (tools: readonly ClientTool[]) => stableStringify([...tools].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)).map((t) => [t.name, t.description, t.parameters]));
  return form(a) === form(b);
}

/**
 * The stub's `--mcp-config` entry. The CLI connects over HTTP and sends the session's own secret
 * (`ClientToolSession.secret`). Every `/v1` chat is a confined API chat, which has no token for
 * Claudio's API in its environment (D14.3 of docs/plans/headless-image.md), so the entry carries a
 * credential that opens this one stub and nothing else. It sits in the `0600` config file under the
 * data dir, which the chat's file tools and its guard keep it from reading. `alwaysLoad`, or the
 * model first spends a round trip on `ToolSearch` and ignores a "you must call a tool" instruction
 * (spike).
 */
export function clientToolsServerEntry(url: string, secret: string): Record<string, unknown> {
  return { type: 'http', url, headers: { Authorization: `Bearer ${secret}` }, alwaysLoad: true };
}

/**
 * The line a turn's prompt carries for `tool_choice`, which the live process cannot take as a flag:
 * `required` is only this instruction, a named function is this plus the denial of the others.
 */
export function toolChoiceInstruction(choice: ToolChoice): string | null {
  if (choice.kind === 'required') return '(For this turn: call at least one of the client tools, whose names start with `mcp__client__`.)';
  if (choice.kind === 'function') return `(For this turn: call the client tool \`${CLIENT_TOOL_PREFIX}${choice.name}\`.)`;
  return null;
}

/** The client's results at the end of a request: the tool messages after its last assistant message. */
export interface TrailingResults {
  /** The calls of the last assistant message */
  calls: ToolCall[];
  results: Array<{ toolCallId: string; text: string }>;
  /** A user message comes after the results */
  userAfter: boolean;
}

export function trailingResults(messages: readonly ChatMessage[]): TrailingResults {
  const turns = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const last = turns.findLastIndex((m) => m.role === 'assistant');
  const assistant = last >= 0 ? turns[last] : undefined;
  const calls = assistant?.role === 'assistant' ? assistant.toolCalls : [];
  const results: TrailingResults['results'] = [];
  let userAfter = false;
  for (const m of turns.slice(last + 1)) {
    if (m.role === 'tool') results.push({ toolCallId: m.toolCallId, text: m.text });
    else if (m.role === 'user') userAfter = true;
  }
  return { calls, results, userAfter };
}

/**
 * How one API names the client's results and the calls they answer, in the refusals about them:
 * Chat Completions has `tool` messages answering `tool_calls` in `messages`, Responses has
 * `function_call_output` items answering `function_call` items by `call_id` in `input`. The same
 * check runs for both, so a client is told in the words of the shape it sent.
 */
export interface ResultsVocabulary {
  /** The request field the results and their calls are in */
  param: string;
  /** Results for calls that are not in the history before them */
  unknown(ids: string): string;
  /** Calls with no result */
  missing(ids: string): string;
  /** One call answered twice */
  twice: string;
  /** Results for calls the live process does not wait on */
  notWaiting(ids: string): string;
  /** A user message after the results while the process holds the calls */
  userAfter: string;
  /** Results that came after the tool-call timeout stopped the chat */
  late(ids: string): string;
}

export const CHAT_COMPLETION_RESULTS: ResultsVocabulary = {
  param: 'messages',
  unknown: (ids) => `No tool call ${ids} in the last assistant message: a \`tool\` message must answer one of its \`tool_calls\`.`,
  missing: (ids) => `The tool calls ${ids} have no result: send a \`tool\` message for each of them, or none and a new \`user\` message to drop them.`,
  twice: 'A tool call has two results.',
  notWaiting: (ids) => `The chat is not waiting for the tool calls ${ids}.`,
  userAfter: 'A user message after tool results is not supported while the chat waits for them: send the results alone, then the message.',
  late: (ids) => `The tool calls ${ids} waited longer than the tool-call timeout (openaiToolCallTimeoutMinutes) for their results, and the chat was stopped. Start the conversation again.`,
};

export const RESPONSES_RESULTS: ResultsVocabulary = {
  param: 'input',
  unknown: (ids) => `No function call ${ids} in the output before it: a \`function_call_output\` must answer one of its \`function_call\` items by \`call_id\`.`,
  missing: (ids) => `The function calls ${ids} have no output: send a \`function_call_output\` with each \`call_id\`, or none and a new user message to drop them.`,
  twice: 'A function call has two outputs: two `function_call_output` items carry its `call_id`.',
  notWaiting: (ids) => `The chat is not waiting for the function calls ${ids}.`,
  userAfter: 'A user message after `function_call_output` items is not supported while the chat waits for them: send the outputs alone, then the message.',
  late: (ids) => `The function calls ${ids} waited longer than the tool-call timeout (openaiToolCallTimeoutMinutes) for their outputs, and the chat was stopped. Start the conversation again.`,
};

/** Call ids as the refusals list them */
export const listedIds = (ids: readonly string[]): string => ids.map((id) => `\`${id}\``).join(', ');

/**
 * What is wrong with a request's results, as OpenAI words it: every call of the last assistant
 * message needs its result, and a result needs a call. Null when they match.
 */
export function resultsProblem(trailing: TrailingResults, words: ResultsVocabulary): OpenAiFailure | null {
  const called = new Set(trailing.calls.map((c) => c.id));
  const answered = new Set(trailing.results.map((r) => r.toolCallId));
  const unknown = [...answered].filter((id) => !called.has(id));
  if (unknown.length) return { kind: 'invalid-request', param: words.param, message: words.unknown(listedIds(unknown)) };
  // No result at all and a new user message: the client dropped the calls and moved on
  if (abandons(trailing)) return null;
  const missing = trailing.calls.filter((c) => !answered.has(c.id)).map((c) => c.id);
  if (missing.length) return missingResults(missing, words);
  if (trailing.results.length !== answered.size) return { kind: 'invalid-request', param: words.param, message: words.twice };
  return null;
}

/** Whether the request drops the calls it was handed: no result for any of them, and a new user message. */
export function abandons(trailing: TrailingResults): boolean {
  return trailing.results.length === 0 && trailing.userAfter;
}

/** The one wording for calls still owed, whether the history or the live process is short of them. */
export function missingResults(ids: readonly string[], words: ResultsVocabulary): OpenAiFailure {
  return { kind: 'invalid-request', param: words.param, message: words.missing(listedIds(ids)) };
}

/** How a call's arguments are compared: key order and spacing do not make two calls different. */
export function argumentsKey(input: unknown): string {
  return stableStringify(input ?? {});
}

/** A call of the client's as the translator streamed it, or as the hand-off carries it. */
export interface ClientCall {
  id: string;
  name: string;
  /** The arguments, already parsed */
  input: unknown;
}

// ---------- the session: one chat's held calls ----------

interface Claim {
  name: string;
  args: string;
}

interface Held {
  requestId: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  answer: (decision: PermissionDecision) => void;
}

/** What `tools/call` hands the CLI: the client's text, or an error result when none is known. */
export interface StubResult {
  text: string;
  isError: boolean;
}

/**
 * One chat's client tools: what its stub lists, the CLI's requests it holds, the calls handed to the
 * client and the results that came back. It is the chat's `PermissionHost`, so every request the
 * CLI makes in this chat comes here and none reaches `PermissionBroker`: its 10-minute deny and the
 * panel's buttons could otherwise answer a client's call.
 *
 * The requests live only here, in memory: a restart loses them with the process that held them, and
 * the next request resumes the chat cold.
 */
export class ClientToolSession {
  /** In the stub's URL: a chat's id is only known once its process is spawned, after the URL was written */
  readonly id = randomUUID();
  /** What the chat's process presents to its stub: a credential for this session only, never for the API */
  readonly secret = randomBytes(32).toString('base64url');
  chatId: string | null = null;
  /** What the stub lists; fixed for a process, since the CLI reads the list when it connects */
  tools: ClientTool[];
  /** The `tool_choice` and `parallel_tool_calls` of the request being answered */
  choice: ToolChoice = { kind: 'auto' };
  parallel = true;
  /** The process that loaded this list: another one (or none) has to be started with the stub first */
  servedPid: number | null = null;
  /** The process the calls were handed over from: only it can take their results */
  holderPid: number | null = null;
  /** Requests the CLI is waiting on, by tool call id */
  private readonly held = new Map<string, Held>();
  /** Main-agent calls the turn being read streamed to the client and has not handed over yet */
  private readonly claimed = new Map<string, Claim>();
  /** Calls handed to the client, by id: their results are what the next request owes */
  private readonly awaiting = new Map<string, Claim>();
  /** Results the client sent that the stub has not handed over yet, by tool call id */
  private readonly results = new Map<string, Claim & { text: string }>();
  /** The same ids in arrival order, for a `tools/call` that carries no id */
  private readonly order: string[] = [];
  /** Calls whose wait ran out: a result for one is refused */
  private readonly expiredIds = new Set<string>();
  /** Requests the CLI took back: it will not call the stub for them, so a result for one is not kept */
  private readonly withdrawnIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(tools: ClientTool[]) {
    this.tools = tools;
  }

  /** Whether `presented` is this session's secret; compared in constant time */
  admits(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(this.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Calls handed to the client, not answered yet and not taken back by the CLI: what the client
   * still owes. A withdrawn call leaves this set, so it is never demanded of the client.
   */
  get waiting(): boolean {
    return this.awaiting.size > 0;
  }

  /**
   * Whether `pid`, the chat's live process, is the one still waiting on the client's results: the
   * process the calls were handed over from, with at least one of them still owed. Only it can
   * take them: another one never asked, and one whose requests were all withdrawn (a person
   * interrupted the turn) will not call the stub again, so results sent there would wait for nothing.
   */
  holds(pid: number | null): boolean {
    return pid !== null && this.holderPid === pid && this.waiting;
  }

  /** Ids of the calls handed to the client, for checking what the next request answers. */
  awaitingIds(): string[] {
    return [...this.awaiting.keys()];
  }

  expired(id: string): boolean {
    return this.expiredIds.has(id);
  }

  /** Requests held right now: for tests and for the timeout */
  heldCount(): number {
    return this.held.size;
  }

  /** The client tools the model may call in this turn, by the client's names. */
  allowedNames(): Set<string> {
    return allowedToolNames(this.choice, this.tools);
  }

  /**
   * Calls the turn being read streamed to the client. Only a claimed (or handed-over) call is held
   * when the CLI asks for it; the CLI writes a block's message before it asks, so the claim comes first.
   */
  claim(calls: readonly ClientCall[]): void {
    for (const call of calls) {
      if (this.awaiting.has(call.id) || this.results.has(call.id)) continue;
      this.claimed.set(call.id, { name: call.name, args: argumentsKey(call.input) });
    }
  }

  private forbids(name: string): string | null {
    if (this.choice.kind === 'none') return '`tool_choice` is `none`: no client tool may be called in this turn';
    if (this.choice.kind === 'function' && this.choice.name !== name) return `\`tool_choice\` requires \`${this.choice.name}\` in this turn; call that tool instead`;
    return null;
  }

  private notHandedOver(): string {
    return this.parallel ? 'This call was not handed to the client.' : '`parallel_tool_calls` is false: one client tool call per turn.';
  }

  // ---------- PermissionHost ----------

  /**
   * One request of the CLI's. A built-in tool (or anything else) is refused at once, as a chat that
   * asks nobody refuses it; a client tool is held, or allowed at once when its result came first
   * (a CLI that asks for parallel calls one after the other, spike question 4).
   */
  ask(question: PermissionQuestion, answer: (decision: PermissionDecision) => void): void {
    const name = clientToolName(question.toolName);
    if (name === null || !this.tools.some((t) => t.name === name)) {
      answer({ behavior: 'deny', message: NOBODY_ANSWERS });
      return;
    }
    if (this.results.has(question.toolUseId)) {
      answer({ behavior: 'allow', updatedInput: question.input });
      return;
    }
    const forbidden = this.forbids(name);
    if (forbidden) {
      answer({ behavior: 'deny', message: forbidden });
      return;
    }
    // Only a call the client was handed, or is being handed, can be waited for: anything else (a
    // subagent's call, one the translator skipped, a late ask) would hold the CLI until the watchdog
    if (!this.claimed.has(question.toolUseId) && !this.awaiting.has(question.toolUseId)) {
      answer({ behavior: 'deny', message: this.notHandedOver() });
      return;
    }
    this.held.set(question.toolUseId, { requestId: question.id, toolUseId: question.toolUseId, name, input: question.input, answer });
  }

  withdrawn(requestId: string): void {
    for (const [id, held] of this.held) {
      if (held.requestId !== requestId) continue;
      this.held.delete(id);
      this.withdrawnIds.add(id);
      // The CLI no longer waits on it, so neither does anyone else: the client is not asked for its
      // result (one it sends anyway is accepted and ignored)
      this.awaiting.delete(id);
      this.claimed.delete(id);
      // The CLI will not call the stub for it: a result left behind could only answer another call
      this.dropResult(id);
    }
    // Nothing is owed any more: a wait left running would stop a chat that moved on
    if (!this.waiting) this.clearTimer();
  }

  /**
   * A request held or a result owed, the wait bounding both. Claimed calls and results the stub has
   * not handed over do not count: they only matter inside the turn, while the chat is busy and never
   * evicted, and left over after it (a client gone mid-turn) they would keep the process for ever.
   */
  holding(): boolean {
    return this.held.size > 0 || this.waiting;
  }

  ended(): void {
    // Nothing of the process outlives it: the results the client still owes go to the next process
    // as a cold resume, never to a process that did not ask for them
    this.forgetCalls();
  }

  // ---------- the handoff ----------

  /**
   * The HTTP turn ended with these calls: they are the client's now. A held request for any other
   * call is refused (a second call when `parallel_tool_calls` is false). The wait starts here;
   * `onExpire` runs when it ends with results still owed, after each held request was refused.
   */
  handOff(calls: readonly ClientCall[], waitMs: number, onExpire: () => void, holderPid: number | null = null): void {
    this.awaiting.clear();
    this.claimed.clear();
    // The previous message's results were all taken before the model could write this one
    this.results.clear();
    this.order.length = 0;
    this.withdrawnIds.clear();
    this.holderPid = holderPid;
    for (const call of calls) this.awaiting.set(call.id, { name: call.name, args: argumentsKey(call.input) });
    for (const [id, held] of [...this.held]) {
      if (this.awaiting.has(id)) continue;
      this.held.delete(id);
      held.answer({ behavior: 'deny', message: this.notHandedOver() });
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const held of this.held.values()) held.answer({ behavior: 'deny', message: CLIENT_TIMEOUT_MESSAGE });
      this.held.clear();
      for (const id of this.awaiting.keys()) this.expiredIds.add(id);
      this.awaiting.clear();
      onExpire();
    }, waitMs);
    this.timer.unref();
  }

  /**
   * Why the request's results cannot go to the calls this session waits on, or null. Results must
   * answer every call still owed; a result for a call the CLI withdrew is accepted and ignored, since
   * the client could not know. Checked before anything is changed, so a refusal touches nothing.
   */
  heldProblem(trailing: TrailingResults, words: ResultsVocabulary): OpenAiFailure | null {
    const unknown = trailing.results.filter((r) => !this.awaiting.has(r.toolCallId) && !this.withdrawnIds.has(r.toolCallId)).map((r) => r.toolCallId);
    if (unknown.length) return { kind: 'invalid-request', param: words.param, message: words.notWaiting(listedIds(unknown)) };
    const answered = new Set(trailing.results.map((r) => r.toolCallId));
    const missing = [...this.awaiting.keys()].filter((id) => !answered.has(id));
    if (missing.length) return missingResults(missing, words);
    // The CLI is in the middle of a turn: a message now would be read by it, or start a turn nobody reads
    if (trailing.userAfter) return { kind: 'invalid-request', param: words.param, message: words.userAfter };
    return null;
  }

  /**
   * The client's results: each held request is allowed with the input it was asked with, and the
   * stub hands the CLI the text when it calls. The caller checked them against `awaitingIds()`.
   */
  deliver(results: ReadonlyArray<{ toolCallId: string; text: string }>): void {
    this.clearTimer();
    for (const result of results) {
      if (this.withdrawnIds.has(result.toolCallId)) {
        this.awaiting.delete(result.toolCallId);
        continue;
      }
      const held = this.held.get(result.toolCallId);
      const claim = this.awaiting.get(result.toolCallId) ?? (held ? { name: held.name, args: argumentsKey(held.input) } : { name: '', args: '' });
      this.awaiting.delete(result.toolCallId);
      this.results.set(result.toolCallId, { ...claim, text: result.text });
      this.order.push(result.toolCallId);
    }
    for (const result of results) {
      const held = this.held.get(result.toolCallId);
      if (!held) continue;
      this.held.delete(result.toolCallId);
      held.answer({ behavior: 'allow', updatedInput: held.input });
    }
  }

  /** The process that owed the results is gone and the chat resumes cold: nothing of it is held. */
  forgetCalls(): void {
    this.held.clear();
    this.claimed.clear();
    this.awaiting.clear();
    this.results.clear();
    this.order.length = 0;
    this.withdrawnIds.clear();
    this.holderPid = null;
    this.clearTimer();
  }

  /**
   * The client dropped the calls and sent a new message. The caller interrupted the CLI first, so it
   * withdrew its requests; one still held is answered with an error result rather than left waiting.
   */
  abandon(): void {
    for (const held of this.held.values()) held.answer({ behavior: 'deny', message: CLIENT_ABANDONED_MESSAGE });
    this.forgetCalls();
  }

  private dropResult(id: string): void {
    if (!this.results.delete(id)) return;
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
  }

  /**
   * What `tools/call` returns: the result under the CLI's tool call id
   * (`_meta["claudecode/toolUseId"]`, seen on the wire but not documented), else the oldest result
   * for a call of that name **and those arguments** (only calls that are the same call can swap
   * results). Never waits, and never hands over another call's result: a call nothing matches gets
   * an error result at once.
   */
  callResult(name: string, toolUseId: string | undefined, args: unknown): StubResult {
    let id = toolUseId !== undefined && this.results.has(toolUseId) ? toolUseId : undefined;
    if (id === undefined) {
      const key = argumentsKey(args);
      id = this.order.find((candidate) => {
        const result = this.results.get(candidate);
        return result?.name === name && result.args === key;
      });
    }
    const found = id === undefined ? undefined : this.results.get(id);
    if (id === undefined || !found) return { text: `No result from the client is known for this call of \`${name}\` with these arguments.`, isError: true };
    this.dropResult(id);
    return { text: found.text, isError: false };
  }

  dispose(): void {
    this.forgetCalls();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------- the stub MCP server ----------

/** What the stub answers one HTTP request with: a JSON body, or nothing (202) for a notification. */
export type StubReply = { status: 200; body: unknown } | { status: 202 } | { status: 400; body: unknown };

const MCP_VERSION = '2025-06-18';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function answerOne(message: unknown, session: ClientToolSession, version: string): unknown {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: isRecord(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null, error: { code: -32600, message: 'invalid request' } };
  }
  const params = isRecord(message.params) ? message.params : {};
  const id = message.id;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : version, capabilities: { tools: {} }, serverInfo: { name: 'claudio-client-tools', version } });
    case 'ping':
      return ok({});
    case 'tools/list':
      // `readOnlyHint`: the CLI then asks for every call of a turn at once and runs them together;
      // without it the second ask comes only after the first call ran (spike question 4). The stub
      // changes nothing itself: the client acts on its own side
      return ok({
        tools: session.tools.map((t) => ({ name: t.name, ...(t.description !== null ? { description: t.description } : {}), inputSchema: t.parameters, annotations: { readOnlyHint: true } })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const meta = isRecord(params._meta) ? params._meta : {};
      const toolUseId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : undefined;
      const result = session.callResult(name, toolUseId, params.arguments);
      return ok({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
    }
    default:
      // `server/discover` among them: the CLI falls back to `initialize` on this answer (spike)
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${message.method}` } };
  }
}

/**
 * One POST to the stub, JSON-RPC over MCP's Streamable HTTP with plain JSON answers (no SSE), which
 * is what the spike's stub served and the CLI took. Notifications get 202 and no body.
 */
export function answerStub(body: unknown, session: ClientToolSession, version: string = MCP_VERSION): StubReply {
  const notification = (m: unknown) => isRecord(m) && m.id === undefined;
  if (Array.isArray(body)) {
    const answers = body.filter((m) => !notification(m)).map((m) => answerOne(m, session, version));
    return answers.length ? { status: 200, body: answers } : { status: 202 };
  }
  if (!isRecord(body)) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } } };
  if (notification(body)) return { status: 202 };
  return { status: 200, body: answerOne(body, session, version) };
}
