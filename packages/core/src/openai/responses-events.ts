import { randomUUID } from 'node:crypto';
import type { RunEvent, TokenUsage } from '@claudio/shared';
import type { OpenAiFailure } from './errors.ts';
import { ChatCompletionTranslator, SEPARATOR, type ChatCompletionTranslatorOptions, type TurnError, type TurnTranslator } from './events.ts';
import type { ResponseEcho } from './responses-request.ts';
import type { FunctionCallItem, OutputItem, OutputMessage, OutputText, ResponseErrorCode, ResponseObject, ResponseStreamEvent, ResponseUsage } from './responses-wire.ts';
import { STREAM_DONE, type ChatCompletionStreamItem, type FinishReason, type ToolCall, type ToolCallDelta } from './wire.ts';

export function responseUsage(usage: TokenUsage): ResponseUsage {
  // As Chat Completions counts them: cached and cache-written tokens are input, and named apart
  const input = usage.input + usage.cacheRead + usage.cacheCreation;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheCreation },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.output,
  };
}

export interface ResponsesTranslatorOptions {
  /** `resp_…`, chosen by the caller */
  id: string;
  model: string;
  /** Unix seconds */
  createdAt: number;
  instructions: string | null;
  previousResponseId: string | null;
  store: boolean;
  metadata: Record<string, string>;
  echo: ResponseEcho;
  structured?: boolean;
  clientTools?: ChatCompletionTranslatorOptions['clientTools'];
  /** For tests: the ids of output items */
  itemId?: (prefix: 'msg' | 'fc') => string;
}

/** How a turn ended, in the Responses shape. */
export type ResponsesTurnEnd =
  | { kind: 'response'; response: ResponseObject; costUsd: number }
  | (TurnError & { response: ResponseObject });

type OpenItem = { kind: 'message'; index: number; item: OutputMessage } | { kind: 'call'; index: number; item: FunctionCallItem };

const clone = <T>(value: T): T => structuredClone(value);

/** An event before it is numbered; distributed over the union so each kind keeps its own fields */
type Unnumbered = ResponseStreamEvent extends infer E ? (E extends ResponseStreamEvent ? Omit<E, 'sequence_number'> : never) : never;

/**
 * One turn as the Responses API says it. The Chat Completions translator does the reading (text
 * from partials and messages, client calls from `tool_use` blocks, structured output, failures); this
 * turns what it says into output items and the semantic events, so both routes read a turn the same
 * way. A text stretch is one `message` item, each client call one `function_call` item, in the order
 * the model wrote them.
 *
 * Events, in order: `response.created`, `response.in_progress`, then per item `output_item.added`,
 * for a message `content_part.added`, `output_text.delta`…, `output_text.done`, `content_part.done`,
 * for a call `function_call_arguments.delta`, `function_call_arguments.done`, then
 * `output_item.done`; last `response.completed`, `response.incomplete` or `response.failed`. Every
 * event has a `sequence_number` one above the one before, from 0.
 */
export class ResponsesTranslator implements TurnTranslator<ResponseStreamEvent> {
  private readonly inner: ChatCompletionTranslator;
  private seq = 0;
  private opened = false;
  /** Whether any of the answer's text has gone out yet */
  private textSent = false;
  private readonly output: OutputItem[] = [];
  private current: OpenItem | null = null;
  /** Output items of client calls, by the stream index the Chat Completions translator gives them */
  private readonly calls = new Map<number, { index: number; item: FunctionCallItem }>();
  private usage: TokenUsage | null = null;
  private status: ResponseObject['status'] = 'in_progress';
  private error: ResponseObject['error'] = null;
  private incomplete: ResponseObject['incomplete_details'] = null;
  private completedAt: number | null = null;
  private readonly itemId: (prefix: 'msg' | 'fc') => string;

  constructor(private readonly opts: ResponsesTranslatorOptions) {
    this.inner = new ChatCompletionTranslator({
      id: opts.id,
      model: opts.model,
      created: opts.createdAt,
      includeUsage: false,
      ...(opts.structured ? { structured: true } : {}),
      ...(opts.clientTools ? { clientTools: opts.clientTools } : {}),
    });
    this.itemId = opts.itemId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`);
  }

  get finished(): boolean {
    return this.inner.finished;
  }

  /** The response as it stands: in progress until the turn ends. */
  response(): ResponseObject {
    const { opts } = this;
    return {
      id: opts.id,
      object: 'response',
      created_at: opts.createdAt,
      completed_at: this.completedAt,
      status: this.status,
      error: this.error,
      incomplete_details: this.incomplete,
      instructions: opts.instructions,
      max_output_tokens: opts.echo.maxOutputTokens,
      model: opts.model,
      output: clone(this.output),
      parallel_tool_calls: opts.echo.parallelToolCalls,
      previous_response_id: opts.previousResponseId,
      reasoning: { effort: opts.echo.reasoningEffort, summary: null },
      store: opts.store,
      temperature: opts.echo.temperature,
      text: clone(opts.echo.text),
      tool_choice: clone(opts.echo.toolChoice),
      tools: clone(opts.echo.tools),
      top_p: opts.echo.topP,
      truncation: opts.echo.truncation,
      usage: this.usage && this.status !== 'failed' ? responseUsage(this.usage) : null,
      user: opts.echo.user,
      metadata: { ...opts.metadata },
      background: false,
    };
  }

  /** The turn's end, once it ended: the response, or the error a whole answer is (with the failed response). */
  end(): ResponsesTurnEnd | null {
    const inner = this.inner.end();
    if (!inner) return null;
    if (inner.kind === 'error') return { ...inner, response: this.response() };
    return { kind: 'response', response: this.response(), costUsd: inner.costUsd };
  }

  answered(): { text: string; toolCalls: ToolCall[] } | null {
    return this.inner.answered();
  }

  /** `response.created` and `response.in_progress`, once: what a stream opens with. */
  open(): ResponseStreamEvent[] {
    if (this.opened) return [];
    this.opened = true;
    const snapshot = this.response();
    return [this.event({ type: 'response.created', response: snapshot }), this.event({ type: 'response.in_progress', response: clone(snapshot) })];
  }

  push(event: RunEvent, context: { usage?: TokenUsage | null } = {}): ResponseStreamEvent[] {
    if (event.kind === 'result') this.usage = context.usage ?? null;
    return this.map(this.inner.push(event, context));
  }

  failWith(failure: OpenAiFailure): ResponseStreamEvent[] {
    return this.map(this.inner.failWith(failure));
  }

  handOff(): ResponseStreamEvent[] | null {
    const items = this.inner.handOff();
    return items ? this.map(items) : null;
  }

  clientCalls(): Array<{ id: string; name: string; input: unknown }> {
    return this.inner.clientCalls();
  }

  takeNewClientCalls(): Array<{ id: string; name: string; input: unknown }> {
    return this.inner.takeNewClientCalls();
  }

  // ---------- from chunks to events ----------

  private event(body: Unnumbered): ResponseStreamEvent {
    return { ...body, sequence_number: this.seq++ };
  }

  private map(items: readonly ChatCompletionStreamItem[]): ResponseStreamEvent[] {
    if (items.length === 0) return [];
    const out = this.open();
    for (const item of items) {
      if (item === STREAM_DONE) continue;
      if ('error' in item) {
        this.fail(item.error.code === 'rate_limit_exceeded' ? 'rate_limit_exceeded' : 'server_error', item.error.message, out);
        continue;
      }
      const choice = item.choices[0];
      if (!choice) continue;
      if (typeof choice.delta.content === 'string' && choice.delta.content) this.text(choice.delta.content, out);
      for (const call of choice.delta.tool_calls ?? []) this.call(call, out);
      if (choice.finish_reason) this.finish(choice.finish_reason, out);
    }
    return out;
  }

  private text(chunk: string, out: ResponseStreamEvent[]): void {
    let delta = chunk;
    if (this.current?.kind !== 'message') {
      // Text after a call opens an item of its own, which must not start with the separator the
      // answer's text puts between stretches. The answer keeps it (`answered()`, the conversation
      // key): it is how the items join again when the output is read back (`assistantOfOutput`).
      // The inner translator puts it before a block only once some text went out
      if (this.textSent && delta.startsWith(SEPARATOR)) delta = delta.slice(SEPARATOR.length);
      this.close('completed', out);
      const item: OutputMessage = { type: 'message', id: this.itemId('msg'), status: 'in_progress', role: 'assistant', content: [] };
      const index = this.output.push(item) - 1;
      this.current = { kind: 'message', index, item };
      out.push(this.event({ type: 'response.output_item.added', output_index: index, item: clone(item) }));
      const part: OutputText = { type: 'output_text', text: '', annotations: [], logprobs: [] };
      item.content.push(part);
      out.push(this.event({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: clone(part) }));
    }
    this.textSent = true;
    const { index, item } = this.current;
    const part = item.content[0];
    if (part) part.text += delta;
    out.push(this.event({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta, logprobs: [] }));
  }

  private call(delta: ToolCallDelta, out: ResponseStreamEvent[]): void {
    let known = this.calls.get(delta.index);
    if (!known) {
      this.close('completed', out);
      const item: FunctionCallItem = { type: 'function_call', id: this.itemId('fc'), call_id: delta.id ?? '', name: delta.function?.name ?? '', arguments: '', status: 'in_progress' };
      const index = this.output.push(item) - 1;
      known = { index, item };
      this.calls.set(delta.index, known);
      this.current = { kind: 'call', index, item };
      out.push(this.event({ type: 'response.output_item.added', output_index: index, item: clone(item) }));
    }
    const piece = delta.function?.arguments ?? '';
    if (!piece) return;
    known.item.arguments += piece;
    out.push(this.event({ type: 'response.function_call_arguments.delta', item_id: known.item.id, output_index: known.index, delta: piece }));
  }

  /** Ends the item being written: its `.done` events, with the item as it ends. */
  private close(status: 'completed' | 'incomplete', out: ResponseStreamEvent[]): void {
    const open = this.current;
    if (!open) return;
    this.current = null;
    open.item.status = status;
    if (open.kind === 'message') {
      const part = open.item.content[0] ?? { type: 'output_text', text: '', annotations: [], logprobs: [] };
      out.push(this.event({ type: 'response.output_text.done', item_id: open.item.id, output_index: open.index, content_index: 0, text: part.text, logprobs: [] }));
      out.push(this.event({ type: 'response.content_part.done', item_id: open.item.id, output_index: open.index, content_index: 0, part: clone(part) }));
    } else {
      out.push(this.event({ type: 'response.function_call_arguments.done', item_id: open.item.id, output_index: open.index, arguments: open.item.arguments }));
    }
    out.push(this.event({ type: 'response.output_item.done', output_index: open.index, item: clone(open.item) }));
  }

  /**
   * The turn's end. A budget or a token limit that cut the answer is `incomplete` with
   * `max_output_tokens`, a refusal `incomplete` with `content_filter`; client calls and everything
   * else are `completed` (a response that hands calls over is complete: the reference's own example).
   */
  private finish(reason: FinishReason, out: ResponseStreamEvent[]): void {
    const cut = reason === 'length' || reason === 'content_filter';
    this.close(cut ? 'incomplete' : 'completed', out);
    this.completedAt = Math.floor(Date.now() / 1000);
    if (cut) {
      this.status = 'incomplete';
      this.incomplete = { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' };
      out.push(this.event({ type: 'response.incomplete', response: this.response() }));
      return;
    }
    this.status = 'completed';
    out.push(this.event({ type: 'response.completed', response: this.response() }));
  }

  /**
   * A failure after the response was created is `response.failed`, never a silent end. The item being
   * written stays in the output, `incomplete`, with no `.done` events: it did not finish.
   */
  private fail(code: ResponseErrorCode, message: string, out: ResponseStreamEvent[]): void {
    const open = this.current;
    if (open) {
      open.item.status = 'incomplete';
      this.current = null;
    }
    this.status = 'failed';
    this.error = { code, message };
    out.push(this.event({ type: 'response.failed', response: this.response() }));
  }
}
