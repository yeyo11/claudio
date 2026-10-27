import type { RunEvent, RunOutcome, TokenUsage } from '@claudio/shared';
import type { ModelUsage } from '../providers/driver.ts';
import { openAiError, type OpenAiErrorResponse, type OpenAiFailure } from './errors.ts';
import {
  STREAM_DONE,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionStreamItem,
  type ChatCompletionUsage,
  type ChunkDelta,
  type FinishReason,
  type OpenAiErrorBody,
  type ToolCall,
} from './wire.ts';

/** Between two stretches of the answer (two text blocks, or text before and after a tool ran). */
const SEPARATOR = '\n\n';

export function completionUsage(usage: TokenUsage): ChatCompletionUsage {
  // OpenAI counts cached prompt tokens inside prompt_tokens and names the cached share apart
  const prompt = usage.input + usage.cacheRead + usage.cacheCreation;
  return { prompt_tokens: prompt, completion_tokens: usage.output, total_tokens: prompt + usage.output, prompt_tokens_details: { cached_tokens: usage.cacheRead } };
}

/**
 * The token counts of a `result`, from the per-model figures the CLI reports with it (the driver's
 * `modelUsage`). `RunOutcome` carries no tokens today, so the caller reads them where it can and
 * hands them in; nothing here estimates them.
 */
export function tokenUsageOf(models: readonly ModelUsage[]): TokenUsage | null {
  if (models.length === 0) return null;
  const sum = (pick: (m: ModelUsage) => number | undefined): number => models.reduce((n, m) => n + (pick(m) ?? 0), 0);
  const input = sum((m) => m.inputTokens);
  const output = sum((m) => m.outputTokens);
  const cacheRead = sum((m) => m.cacheReadInputTokens);
  const cacheCreation = sum((m) => m.cacheCreationInputTokens);
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

/** How a finished turn reads to OpenAI's client, from what the provider said about it. */
export function finishReasonOf(outcome: RunOutcome, calledTools: boolean): FinishReason {
  if (calledTools) return 'tool_calls';
  // A budget that ran out cut the answer short, which is what `length` tells a client
  if (outcome.stopReason === 'max_tokens' || outcome.cause === 'budget') return 'length';
  if (outcome.stopReason === 'refusal') return 'content_filter';
  return 'stop';
}

/** What a failed `result` means to the client; null when the result is not a failure to report. */
export function failureOfOutcome(outcome: RunOutcome, text: string | undefined): OpenAiFailure | null {
  if (!outcome.isError || outcome.cause === 'budget') return null;
  if (outcome.cause === 'rate-limit') return { kind: 'usage-limit', resetsAt: null, ...(text ? { message: text } : {}) };
  if (outcome.cause === 'stopped') return { kind: 'server', message: 'The chat was stopped before it answered.' };
  return { kind: 'server', message: text ? `The run failed: ${text}` : 'The run failed.' };
}

/**
 * A turn held to a schema that ended without its output: the model gave up on the schema (the CLI
 * then reports success with only prose, recorded in `review-schema-fail.jsonl`) or a budget cut it.
 */
export function structuredFailure(outcome: RunOutcome, text: string | undefined): OpenAiFailure {
  const said = text?.trim();
  if (outcome.cause === 'budget') return { kind: 'server', message: 'The run hit its budget before it produced the structured output `response_format` asked for.' };
  return { kind: 'server', message: `The model did not produce output matching \`response_format\`${said ? `; it said: ${said}` : '.'}` };
}

export interface ChatCompletionTranslatorOptions {
  /** `chatcmpl-…`, chosen by the caller so this stays deterministic */
  id: string;
  /** The model id as the client asked for it: clients match on it */
  model: string;
  /** Unix seconds */
  created: number;
  includeUsage: boolean;
  /**
   * The turn was asked for a structured answer (`response_format`, the CLI's `--json-schema`): the
   * content is the result's `structured_output` as JSON text, and the model's prose around it is not
   * part of the answer. The CLI reports the output only on its `result`, so it goes out as one
   * content chunk at the end.
   */
  structured?: boolean;
  /**
   * The client's tools in this turn: a main-agent `tool_use` block named `<prefix><name>`, with a name
   * in `names`, is a call the client makes, streamed as tool-call deltas. `single` keeps only the
   * first (`parallel_tool_calls: false`). `handOff()` then ends the turn with them.
   */
  clientTools?: { prefix: string; names: ReadonlySet<string>; single: boolean };
  /**
   * Text after a client call opens an output item of its own (`ResponsesTranslator`), so its chunk
   * goes out without the block separator: an item must not start with `\n\n`. The answer's text
   * (`answered()`, the conversation key) keeps the separator, which is how the items join again
   * when their output is read back as one assistant message (`assistantOfOutput`).
   */
  itemPerStretch?: boolean;
}

/** The end of a turn, once `result` or a failure arrived. */
export type TurnEnd =
  | {
      kind: 'completion';
      completion: ChatCompletion;
      finishReason: FinishReason;
      /** For `x-claudio-cost-usd`; never put in the body */
      costUsd: number;
      /** The answer's text and calls, for the conversation key after the answer */
      text: string;
      toolCalls: ToolCall[];
    }
  | TurnError;

/** A turn that ended in a failure: the HTTP error a whole answer is, whichever API shape it is in. */
export type TurnError = { kind: 'error'; status: number; body: OpenAiErrorBody; retryAfterSeconds?: number };

export const isTurnError = (end: { kind: string }): end is TurnError => end.kind === 'error';

/** The one place a failed end becomes the HTTP answer: its status, its body and its `Retry-After`. */
export function httpErrorOf(end: TurnError): OpenAiErrorResponse {
  return { status: end.status, body: end.body, ...(end.retryAfterSeconds !== undefined ? { retryAfterSeconds: end.retryAfterSeconds } : {}) };
}

/**
 * What the route's turn runner drives, whichever wire format the answer is in: Chat Completions
 * chunks, or the Responses API's events (`ResponsesTranslator`, which is built on this one).
 */
export interface TurnTranslator<Item> {
  readonly finished: boolean;
  push(event: RunEvent, context?: { usage?: TokenUsage | null }): Item[];
  failWith(failure: OpenAiFailure): Item[];
  handOff(): Item[] | null;
  clientCalls(): Array<{ id: string; name: string; input: unknown }>;
  takeNewClientCalls(): Array<{ id: string; name: string; input: unknown }>;
  /** The answer's text and calls once the turn completed (for the conversation key); null otherwise */
  answered(): { text: string; toolCalls: ToolCall[] } | null;
  /**
   * The end a stream gets when the event that ends the turn could not be written: a failure, as a
   * mid-stream one ends, since a stream that just stops reads as a complete answer to most clients
   */
  unwritableEnd(message: string): Item[];
}

interface StreamedBlock {
  text: string;
  /** Whether any of it has gone out: the separator goes before a block's first character, once */
  started: boolean;
}

interface CallState {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Claudio's `RunEvent` stream for one turn, as Chat Completions output. Fed every event of the turn
 * in order; `push` returns the stream items to write (a whole-response caller ignores them), and
 * `end()` the whole response once the turn is over.
 *
 * Text comes from two places that overlap: `partial` events stream a block as it is written, and the
 * `message` event that closes it holds the block whole. Partials are throttled and the last stretch
 * of a block may never be sent as one, so each closing message is compared with what was streamed
 * for it and only the rest goes out.
 */
export class ChatCompletionTranslator implements TurnTranslator<ChatCompletionStreamItem> {
  private content = '';
  private sentRole = false;
  /** Text blocks streamed from partials, oldest first, not yet matched to their closing message */
  private streamed: StreamedBlock[] = [];
  /** The text block partials are filling now; null between blocks or inside a thinking block */
  private current: StreamedBlock | null = null;
  private readonly calls = new Map<string, CallState>();
  /** Client calls streamed since `takeNewClientCalls()` last ran, with their input as the block had it */
  private fresh: Array<{ id: string; name: string; input: unknown }> = [];
  /** A client call went out after the last text: the next text starts a new stretch */
  private callSinceText = false;
  private ended: TurnEnd | null = null;

  constructor(private readonly opts: ChatCompletionTranslatorOptions) {}

  get finished(): boolean {
    return this.ended !== null;
  }

  /** The whole response or the error, once the turn is over. */
  end(): TurnEnd | null {
    return this.ended;
  }

  answered(): { text: string; toolCalls: ToolCall[] } | null {
    return this.ended?.kind === 'completion' ? { text: this.ended.text, toolCalls: this.ended.toolCalls } : null;
  }

  private chunk(delta: ChunkDelta, finishReason: FinishReason | null = null): ChatCompletionChunk {
    // Clients read the role from the first chunk only, and some drop a stream whose first chunk lacks it
    const withRole: ChunkDelta = this.sentRole ? delta : { role: 'assistant', ...delta };
    this.sentRole = true;
    return {
      id: this.opts.id,
      object: 'chat.completion.chunk',
      created: this.opts.created,
      model: this.opts.model,
      choices: [{ index: 0, delta: withRole, finish_reason: finishReason, logprobs: null }],
      usage: null,
    };
  }

  private emit(block: StreamedBlock, text: string, out: ChatCompletionStreamItem[]): void {
    if (!text) return;
    const separated = !block.started && this.content !== '';
    const piece = separated ? `${SEPARATOR}${text}` : text;
    const sent = separated && this.callSinceText && this.opts.itemPerStretch ? text : piece;
    block.started = true;
    this.callSinceText = false;
    this.content += piece;
    out.push(this.chunk({ content: sent }));
  }

  private partial(event: RunEvent, out: ChatCompletionStreamItem[]): void {
    // A structured answer is the result's output alone; prose the model wrote beside its call is not it
    if (this.opts.structured) return;
    // Thinking is the model's working, not its answer: it never reaches the client
    if (event.block !== 'text') {
      this.current = null;
      return;
    }
    if (event.text !== undefined) {
      // A whole `text` starts a block (live-chat resets what it sent at every block start)
      this.current = { text: '', started: false };
      this.streamed.push(this.current);
      this.emit(this.current, event.text, out);
      this.current.text = event.text;
      return;
    }
    if (!this.current || event.append === undefined) return;
    const at = event.at ?? this.current.text.length;
    // A fragment that starts past what is held means one was lost: the closing message fills the gap
    if (at > this.current.text.length) return;
    const fresh = event.append.slice(this.current.text.length - at);
    this.emit(this.current, fresh, out);
    this.current.text += fresh;
  }

  private message(event: RunEvent, out: ChatCompletionStreamItem[]): void {
    if (this.opts.structured) return;
    const entry = event.entry;
    if (!entry || entry.role !== 'assistant' || entry.isSidechain || entry.parentToolUseId !== null) return;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') {
        this.clientCall(block.id, block.name, block.input, out);
        continue;
      }
      if (block.type !== 'text') continue;
      const streamed = this.streamed.shift() ?? { text: '', started: false };
      if (block.text.startsWith(streamed.text)) this.emit(streamed, block.text.slice(streamed.text.length), out);
      // Otherwise the stream already said something else and cannot take it back: the message is kept as streamed
    }
    // Blocks streamed after this message's own stay queued for the message that closes them
    if (this.current && !this.streamed.includes(this.current)) this.current = null;
  }

  /**
   * A tool call of the client's, from its whole `tool_use` block (the calls come from the blocks, not
   * from the CLI's permission requests: spike change 2). Streamed as two fragments, the call's name
   * with empty arguments and then the arguments whole, the shape OpenAI's own streams open with.
   */
  private clientCall(id: string, cliName: string, input: unknown, out: ChatCompletionStreamItem[]): void {
    const tools = this.opts.clientTools;
    if (!tools || !cliName.startsWith(tools.prefix) || this.calls.has(id)) return;
    const name = cliName.slice(tools.prefix.length);
    if (!tools.names.has(name) || (tools.single && this.calls.size > 0)) return;
    out.push(...this.toolCallDelta({ id, name, argumentsAppend: '' }));
    out.push(...this.toolCallDelta({ id, name, argumentsAppend: JSON.stringify(input ?? {}) }));
    this.fresh.push({ id, name, input: input ?? {} });
    this.callSinceText = true;
  }

  /**
   * The client calls streamed since the last time this was asked, and only those: what a turn
   * claims as each message arrives. Asking for the whole list each time would parse every call so
   * far again on every message of a long turn.
   */
  takeNewClientCalls(): Array<{ id: string; name: string; input: unknown }> {
    const taken = this.fresh;
    this.fresh = [];
    return taken;
  }

  /** Calls the client is to make, streamed so far, in order: what `handOff()` would hand over. */
  clientCalls(): Array<{ id: string; name: string; input: unknown }> {
    return this.toolCallList().map((c) => ({ id: c.id, name: c.function.name, input: parsedArguments(c.function.arguments) }));
  }

  /**
   * Ends the turn at the end of an API message that called client tools: `finish_reason:
   * "tool_calls"`, while the CLI's process waits on them. No usage: the CLI reports it only with the
   * turn's `result`, which comes once the client's results are in. Null when no call streamed.
   */
  handOff(): ChatCompletionStreamItem[] | null {
    if (this.ended || this.calls.size === 0) return null;
    const out: ChatCompletionStreamItem[] = [];
    this.complete('tool_calls', 0, null, out);
    return out;
  }

  private finish(outcome: RunOutcome, text: string | undefined, usage: TokenUsage | null, out: ChatCompletionStreamItem[]): void {
    const failure = failureOfOutcome(outcome, text);
    if (failure) {
      this.fail(failure, out);
      return;
    }
    if (this.opts.structured) {
      // Without the output there is no answer: an empty 200 would read as a valid, empty object
      if (outcome.structuredOutput === undefined || outcome.structuredOutput === null) {
        this.fail(structuredFailure(outcome, text), out);
        return;
      }
      this.emit({ text: '', started: false }, JSON.stringify(outcome.structuredOutput), out);
    }
    // A structured answer that arrived is whole, whatever the stop reason of the call that carried it
    const finishReason = this.opts.structured ? 'stop' : finishReasonOf(outcome, this.calls.size > 0);
    this.complete(finishReason, outcome.costUsd, usage, out);
  }

  private complete(finishReason: FinishReason, costUsd: number, usage: TokenUsage | null, out: ChatCompletionStreamItem[]): void {
    const toolCalls = this.toolCallList();
    out.push(this.chunk(this.sentRole ? {} : { content: '' }, finishReason));
    const counted = usage ? completionUsage(usage) : null;
    if (this.opts.includeUsage && counted) {
      out.push({ id: this.opts.id, object: 'chat.completion.chunk', created: this.opts.created, model: this.opts.model, choices: [], usage: counted });
    }
    out.push(STREAM_DONE);
    this.ended = {
      kind: 'completion',
      finishReason,
      costUsd,
      text: this.content,
      toolCalls,
      completion: {
        id: this.opts.id,
        object: 'chat.completion',
        created: this.opts.created,
        model: this.opts.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: toolCalls.length > 0 && !this.content ? null : this.content, refusal: null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
        ...(counted ? { usage: counted } : {}),
      },
    };
  }

  private fail(failure: OpenAiFailure, out: ChatCompletionStreamItem[]): void {
    const error = openAiError(failure);
    // A stream that just stops reads as a complete answer to most clients: the failure must be said
    out.push(error.body, STREAM_DONE);
    this.ended = { kind: 'error', ...error };
  }

  /**
   * One event of the turn. `usage` is read only with the `result` event: `RunOutcome` has no token
   * counts, so the caller passes what the provider reported (see `tokenUsageOf`), or null.
   */
  push(event: RunEvent, context: { usage?: TokenUsage | null } = {}): ChatCompletionStreamItem[] {
    if (this.ended) return [];
    const out: ChatCompletionStreamItem[] = [];
    if (event.kind === 'partial') this.partial(event, out);
    else if (event.kind === 'message') this.message(event, out);
    else if (event.kind === 'result' && event.outcome) this.finish(event.outcome, event.text, context.usage ?? null, out);
    return out;
  }

  unwritableEnd(message: string): ChatCompletionStreamItem[] {
    return [openAiError({ kind: 'server', message }).body, STREAM_DONE];
  }

  /** The turn failed outside the event stream (the process died, the client's chat was refused mid-way). */
  failWith(failure: OpenAiFailure): ChatCompletionStreamItem[] {
    if (this.ended) return [];
    const out: ChatCompletionStreamItem[] = [];
    this.fail(failure, out);
    return out;
  }

  /**
   * A fragment of a client tool call, as the client-tool handoff will stream it. The first fragment
   * of a call names it; every fragment of it carries the same `index`, and `content` is null while a
   * call streams, which is how clients tell a call from text.
   */
  toolCallDelta(call: { id: string; name: string; argumentsAppend: string }): ChatCompletionStreamItem[] {
    if (this.ended) return [];
    let state = this.calls.get(call.id);
    const first = !state;
    if (!state) {
      state = { index: this.calls.size, id: call.id, name: call.name, arguments: '' };
      this.calls.set(call.id, state);
    }
    state.arguments += call.argumentsAppend;
    const delta = first
      ? { index: state.index, id: state.id, type: 'function' as const, function: { name: state.name, arguments: call.argumentsAppend } }
      : { index: state.index, function: { arguments: call.argumentsAppend } };
    return [this.chunk({ content: null, tool_calls: [delta] })];
  }

  private toolCallList(): ToolCall[] {
    return [...this.calls.values()].sort((a, b) => a.index - b.index).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
  }
}

/** A call's arguments back as a value: they were written by `JSON.stringify`, so they parse. */
function parsedArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
