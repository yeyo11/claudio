/**
 * OpenAI's Responses API wire format, as far as Claudio speaks it (docs/openai-compatible-api.md,
 * phase 5). Read from the official reference on 2026-10-26: the create, retrieve, delete and
 * input-items methods and the streaming events under developers.openai.com/api/reference/resources/responses.
 * Kept in core beside the Chat Completions types, for the same reason: somebody else's protocol.
 */

import type { RunEndedCode } from './wire.ts';

// ---------- items ----------

export interface OutputText {
  type: 'output_text';
  text: string;
  annotations: [];
  logprobs: [];
}

export interface OutputMessage {
  type: 'message';
  id: string;
  status: ItemStatus;
  role: 'assistant';
  content: OutputText[];
}

export interface FunctionCallItem {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  /** A JSON string, as the client sends it back */
  arguments: string;
  status: ItemStatus;
}

export type ItemStatus = 'in_progress' | 'completed' | 'incomplete';

export type OutputItem = OutputMessage | FunctionCallItem;

/**
 * An input item with its images in the form `Image`: as the wire lists them (`InputItem`), as a
 * request carried them (`ImageRef`, with the bytes) or as a stored row keeps them (a reference).
 */
export type InputItemOf<Image> =
  | { type: 'message'; id: string; status: 'completed'; role: 'user' | 'system' | 'developer'; content: Array<{ type: 'input_text'; text: string } | Image> }
  | { type: 'message'; id: string; status: 'completed'; role: 'assistant'; content: Array<OutputText | { type: 'refusal'; refusal: string }> }
  | { type: 'function_call'; id: string; status: 'completed'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; id: string; status: 'completed'; call_id: string; output: string };

export type InputImage = { type: 'input_image'; image_url: string; detail: string };

/** An input item as `GET /v1/responses/:id/input_items` lists it: what the request carried, with ids. */
export type InputItem = InputItemOf<InputImage>;

export type InputContent = { type: 'input_text'; text: string } | InputImage;

// ---------- the response object ----------

/** A function tool as the response echoes it: flat, not nested under `function` as in Chat Completions. */
export interface ResponseFunctionTool {
  type: 'function';
  name: string;
  description: string | null;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export type ResponseToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

export type ResponseTextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: boolean; description?: string };

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
  /** Claudio's: what this turn alone cost in USD, when the provider reported it */
  cost_usd?: number;
}

export type ResponseStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed';

/** The `code` a failed response's `error` carries: the reference's enum has only these two that fit Claudio. */
export type ResponseErrorCode = 'server_error' | 'rate_limit_exceeded' | RunEndedCode;

export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  completed_at: number | null;
  status: ResponseStatus;
  error: { code: ResponseErrorCode; message: string } | null;
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: OutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort: string | null; summary: null };
  store: boolean;
  temperature: number | null;
  text: { format: ResponseTextFormat };
  tool_choice: ResponseToolChoice;
  tools: ResponseFunctionTool[];
  top_p: number | null;
  truncation: 'auto' | 'disabled';
  usage: ResponseUsage | null;
  user: string | null;
  metadata: Record<string, string>;
  background: false;
}

/** What `DELETE /v1/responses/:id` answers. */
export interface ResponseDeleted {
  id: string;
  object: 'response.deleted';
  deleted: true;
}

// ---------- streaming ----------

interface Sequenced {
  sequence_number: number;
}

/**
 * The semantic events Claudio streams, each sent as an SSE `event: <type>` line and its `data:`.
 * No `[DONE]` sentinel: the stream ends after `response.completed`, `response.incomplete` or
 * `response.failed`, as the reference's example does.
 */
export type ResponseStreamEvent = Sequenced &
  (
    | { type: 'response.created' | 'response.in_progress' | 'response.completed' | 'response.incomplete' | 'response.failed'; response: ResponseObject }
    | { type: 'response.output_item.added' | 'response.output_item.done'; output_index: number; item: OutputItem }
    | { type: 'response.content_part.added' | 'response.content_part.done'; item_id: string; output_index: number; content_index: number; part: OutputText }
    | { type: 'response.output_text.delta'; item_id: string; output_index: number; content_index: number; delta: string; logprobs: [] }
    | { type: 'response.output_text.done'; item_id: string; output_index: number; content_index: number; text: string; logprobs: [] }
    | { type: 'response.function_call_arguments.delta'; item_id: string; output_index: number; delta: string }
    | { type: 'response.function_call_arguments.done'; item_id: string; output_index: number; arguments: string }
  );
