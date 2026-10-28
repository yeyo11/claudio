/**
 * OpenAI's Chat Completions wire format, as far as Claudio speaks it (docs/openai-compatible-api.md).
 * These types stay in core rather than in `packages/shared`: they describe somebody else's protocol,
 * not Claudio's contract, and the web never reads them.
 */

// ---------- errors ----------

/** The body of every error under `/v1`, the shape OpenAI's SDKs parse. */
export interface OpenAiErrorBody {
  error: {
    message: string;
    type: OpenAiErrorType;
    param: string | null;
    code: OpenAiErrorCode | null;
  };
}

/** `run_error`: the turn ran and ended without the answer it owed, for a reason a retry would meet again */
export type OpenAiErrorType = 'invalid_request_error' | 'rate_limit_error' | 'server_error' | 'run_error';

/** Why a turn ended without its answer (D16); each is final for the request that met it */
export type RunEndedCode = 'max_turns' | 'max_budget' | 'tool_blocked' | 'no_structured_output';

export type OpenAiErrorCode =
  | 'invalid_api_key'
  | 'permission_denied'
  | 'model_not_found'
  | 'not_found'
  | 'conflict'
  | 'invalid_request_error'
  | 'unsupported_parameter'
  | 'rate_limit_exceeded'
  | 'server_error'
  | 'service_unavailable'
  | RunEndedCode;

// ---------- tools ----------

/** A function the client declares; Claudio carries it until the client-tool handoff acts on it. */
export interface ClientTool {
  name: string;
  description: string | null;
  /** JSON Schema of the arguments; OpenAI's default when absent is an object with no properties */
  parameters: Record<string, unknown>;
  strict: boolean;
}

export type ToolChoice = { kind: 'auto' } | { kind: 'none' } | { kind: 'required' } | { kind: 'function'; name: string };

/** A tool call as a message of the history carries it, and as a whole response returns it. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One fragment of a streamed tool call; `index` stays the same for every fragment of one call. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

// ---------- the request, once read ----------

/** An image a user message carried, before the caller turns it into an upload. */
export type ImageRef =
  | { kind: 'data'; mediaType: string; base64: string; sizeBytes: number }
  | { kind: 'url'; url: string };

export type UserPart = { type: 'text'; text: string } | { type: 'image'; image: ImageRef };

/**
 * A message of the history, normalised: string and array content are one form, refusal parts are
 * text, and the legacy `function` role is a tool result named by its function.
 */
export type ChatMessage =
  | { role: 'system' | 'developer'; text: string }
  | { role: 'user'; parts: UserPart[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; text: string };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: boolean };

/** A Chat Completions request that passed validation. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  /** `stream_options.include_usage`: the final chunk with `choices: []` and the usage */
  includeUsage: boolean;
  reasoningEffort: string | null;
  responseFormat: ResponseFormat;
  tools: ClientTool[];
  toolChoice: ToolChoice;
  parallelToolCalls: boolean | null;
  /** OpenAI's end-user id: kept with the conversation row, nothing else */
  user: string | null;
  /** Parameters the CLI cannot honour, present in the request; named in `x-claudio-ignored` */
  ignored: string[];
}

// ---------- the response ----------

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  /** Claudio's: what this turn alone cost in USD, when the provider reported it */
  cost_usd?: number;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: { role: 'assistant'; content: string | null; refusal: null; tool_calls?: ToolCall[] };
    finish_reason: FinishReason;
    logprobs: null;
  }>;
  /** Absent when the run reported no token counts: never estimated */
  usage?: ChatCompletionUsage;
}

export interface ChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: ToolCallDelta[];
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  /** Empty only on the final usage chunk */
  choices: Array<{ index: 0; delta: ChunkDelta; finish_reason: FinishReason | null; logprobs: null }>;
  /** Null on every chunk but the final usage chunk */
  usage: ChatCompletionUsage | null;
}

/** The line that ends a stream; the SSE writer sends it as `data: [DONE]`. */
export const STREAM_DONE = '[DONE]';

/** What a stream writes, in order: chunks, an error chunk on a failure, then the sentinel. */
export type ChatCompletionStreamItem = ChatCompletionChunk | OpenAiErrorBody | typeof STREAM_DONE;
