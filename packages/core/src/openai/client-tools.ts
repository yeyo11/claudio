import { randomUUID } from 'node:crypto';
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
export function clientToolsProblem(tools: readonly ClientTool[]): OpenAiFailure | null {
  for (const [i, tool] of tools.entries()) {
    const param = `tools[${String(i)}].function.name`;
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
  const form = (tools: readonly ClientTool[]) => stableStringify([...tools].sort((x, y) => (x.name < y.name ? -1 : 1)).map((t) => [t.name, t.description, t.parameters]));
  return form(a) === form(b);
}

/**
 * The stub's `--mcp-config` entry. The CLI connects over HTTP and sends the chat's own token, which
 * it expands from its environment (`CLAUDIO_API_TOKEN` is minted per process, as for Claudio's own
 * MCP server), so no secret is written to the file. `alwaysLoad`, or the model first spends a round
 * trip on `ToolSearch` and ignores a "you must call a tool" instruction (spike).
 */
export function clientToolsServerEntry(url: string): Record<string, unknown> {
  return { type: 'http', url, headers: { Authorization: 'Bearer ${CLAUDIO_API_TOKEN}' }, alwaysLoad: true };
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
 * What is wrong with a request's results, as OpenAI words it: every call of the last assistant
 * message needs its result, and a result needs a call. Null when they match.
 */
export function resultsProblem(trailing: TrailingResults): OpenAiFailure | null {
  const called = new Set(trailing.calls.map((c) => c.id));
  const answered = new Set(trailing.results.map((r) => r.toolCallId));
  const unknown = [...answered].filter((id) => !called.has(id));
  if (unknown.length) return { kind: 'invalid-request', param: 'messages', message: `No tool call ${unknown.map((id) => `\`${id}\``).join(', ')} in the last assistant message: a \`tool\` message must answer one of its \`tool_calls\`.` };
  // No result at all and a new user message: the client dropped the calls and moved on
  if (abandons(trailing)) return null;
  const missing = trailing.calls.filter((c) => !answered.has(c.id)).map((c) => c.id);
  if (missing.length) return missingResults(missing);
  if (trailing.results.length !== answered.size) return { kind: 'invalid-request', param: 'messages', message: 'A tool call has two results.' };
  return null;
}

/** Whether the request drops the calls it was handed: no result for any of them, and a new user message. */
export function abandons(trailing: TrailingResults): boolean {
  return trailing.results.length === 0 && trailing.userAfter;
}

/** The one wording for calls still owed, whether the history or the live process is short of them. */
export function missingResults(ids: readonly string[]): OpenAiFailure {
  return {
    kind: 'invalid-request',
    param: 'messages',
    message: `The tool calls ${ids.map((id) => `\`${id}\``).join(', ')} have no result: send a \`tool\` message for each of them, or none and a new \`user\` message to drop them.`,
  };
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
  private timer: NodeJS.Timeout | null = null;

  constructor(tools: ClientTool[]) {
    this.tools = tools;
  }

  /** Calls handed to the client and not answered yet: the CLI is waiting on the client. */
  get waiting(): boolean {
    return this.awaiting.size > 0;
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
      // The CLI will not call the stub for it: a result left behind could only answer another call
      this.dropResult(id);
    }
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
   * The client's results: each held request is allowed with the input it was asked with, and the
   * stub hands the CLI the text when it calls. The caller checked them against `awaitingIds()`.
   */
  deliver(results: ReadonlyArray<{ toolCallId: string; text: string }>): void {
    this.clearTimer();
    for (const result of results) {
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
   * for a call of that name. Never waits: a call nobody answered gets an error result at once.
   */
  callResult(name: string, toolUseId: string | undefined): StubResult {
    let id = toolUseId !== undefined && this.results.has(toolUseId) ? toolUseId : undefined;
    id ??= this.order.find((candidate) => this.results.get(candidate)?.name === name);
    const found = id === undefined ? undefined : this.results.get(id);
    if (id === undefined || !found) return { text: `No result from the client is known for this call of \`${name}\`.`, isError: true };
    this.results.delete(id);
    this.order.splice(this.order.indexOf(id), 1);
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
      const result = session.callResult(name, toolUseId);
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
