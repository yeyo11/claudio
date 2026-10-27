import { randomUUID } from 'node:crypto';
import { UPLOAD_LIMITS } from '../uploads.ts';
import { extendKey } from './conversation-key.ts';
import { openAiError } from './errors.ts';
import {
  assertDistinctTools,
  EFFORT_OF,
  invalid,
  isRecord,
  parseFunction,
  parseImage,
  present,
  Refusal,
  translateRequest,
  unsupported,
  type ChatTurn,
  type ParseOptions,
  type Parsed,
} from './request.ts';
import type { InputContent, InputItem, OutputItem, ResponseFunctionTool, ResponseTextFormat, ResponseToolChoice } from './responses-wire.ts';
import type { ChatCompletionRequest, ChatMessage, ClientTool, ImageRef, ResponseFormat, ToolCall, ToolChoice, UserPart } from './wire.ts';

/**
 * `POST /v1/responses` read into the Chat Completions request the rest of the surface already runs
 * on (docs/openai-compatible-api.md, phase 5): input items become messages, flat function tools become
 * client tools, `text.format` becomes `response_format`. What only Responses has (`instructions`,
 * `previous_response_id`, `store`, `metadata`, what the response echoes) rides beside it.
 */
export interface ResponsesRequest {
  /** The request in Chat Completions' terms; with `previous_response_id`, only the new items */
  chat: ChatCompletionRequest;
  instructions: string | null;
  previousResponseId: string | null;
  /** `store` as sent, true when absent: the reference's default */
  store: boolean;
  metadata: Record<string, string>;
  /** The input as `GET /v1/responses/:id/input_items` lists it */
  inputItems: InputItem[];
  /** What the response object repeats of the request */
  echo: ResponseEcho;
}

export interface ResponseEcho {
  tools: ResponseFunctionTool[];
  toolChoice: ResponseToolChoice;
  text: { format: ResponseTextFormat };
  parallelToolCalls: boolean;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  truncation: 'auto' | 'disabled';
  user: string | null;
}

/**
 * Tool types OpenAI runs on its own side. Claude Code's own tools run on this machine instead (the
 * tool preset decides which), so none of these can be honoured: refused rather than dropped, since a
 * client that asked for a web search and got an answer without one would not know.
 */
const HOSTED_TOOLS = new Set([
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'web_search_2025_08_26',
  'file_search',
  'code_interpreter',
  'computer',
  'computer_use',
  'computer_use_preview',
  'image_generation',
  'mcp',
  'local_shell',
  'shell',
  'apply_patch',
  'custom',
  'tool_search',
  'programmatic_tool_calling',
]);

/** Input items of hosted tools: their calls were OpenAI's, so Claudio has nothing to continue them with */
const HOSTED_ITEMS = new Set([
  'file_search_call',
  'computer_call',
  'computer_call_output',
  'web_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'local_shell_call',
  'local_shell_call_output',
  'shell_call',
  'shell_call_output',
  'apply_patch_call',
  'apply_patch_call_output',
  'mcp_list_tools',
  'mcp_approval_request',
  'mcp_approval_response',
  'mcp_call',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_call',
  'tool_search_output',
  'program',
  'program_output',
  'compaction',
  'compaction_trigger',
  'additional_tools',
  'configuration_update',
]);

/**
 * Parameters the CLI has no flag for, accepted and named in `x-claudio-ignored` as Chat Completions
 * does. `metadata` is not here: it is stored and echoed, which is all the reference asks of it.
 */
const IGNORED_PARAMETERS = [
  'max_output_tokens',
  'max_tool_calls',
  'temperature',
  'top_p',
  'top_logprobs',
  'service_tier',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'prompt_cache_options',
  'context_management',
  'moderation',
  'access_programs',
] as const;

const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;

// ---------- input ----------

type TextPart = { kind: 'text' | 'refusal'; text: string };

/** A message's parts when only text may be there: a string, or `input_text` / `output_text` parts (and `refusal` for an assistant). */
function textParts(content: unknown, path: string, assistant: boolean): TextPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) throw invalid('`content` must be a string or an array of content parts.', path);
  return content.map((part, j): TextPart => {
    const at = `${path}[${String(j)}]`;
    if (!isRecord(part)) throw invalid('A content part must be an object.', at);
    const textual = part.type === 'input_text' || part.type === 'output_text';
    if (textual && typeof part.text === 'string') return { kind: 'text', text: part.text };
    if (assistant && part.type === 'refusal' && typeof part.refusal === 'string') return { kind: 'refusal', text: part.refusal };
    if (textual || part.type === 'refusal') throw invalid(`A \`${String(part.type)}\` part needs its text.`, at);
    throw unsupported(`Content parts of type \`${String(part.type)}\` are not supported in this message.`, `${at}.type`);
  });
}

const joined = (parts: readonly TextPart[]): string => parts.map((p) => p.text).join('\n');

/** The longest image URL kept as it is in the stored input */
export const STORED_IMAGE_URL_MAX = 2048;

/**
 * What the stored input says of an image: a reference, never its data. A data URL becomes one with
 * the same media type, its size as a parameter and no payload (`data:image/png;claudio-omitted-bytes=2048,`),
 * still a well-formed data URL; the bytes are in the upload the turn saved. Copying up to 5 MB of
 * base64 into every stored response's row, and parsing it again on each lookup, would buy nothing.
 * An http(s) URL is kept unless it is longer than `STORED_IMAGE_URL_MAX`, then only its origin with
 * how much was left out.
 */
export function imageReference(image: ImageRef): string {
  if (image.kind === 'data') return `data:${image.mediaType};claudio-omitted-bytes=${String(image.sizeBytes)},`;
  if (image.url.length <= STORED_IMAGE_URL_MAX) return image.url;
  return `${new URL(image.url).origin}/?claudio-omitted-chars=${String(image.url.length)}`;
}

function userContent(content: unknown, path: string, maxImageBytes: number): { parts: UserPart[]; items: InputContent[] } {
  if (typeof content === 'string') return { parts: [{ type: 'text', text: content }], items: [{ type: 'input_text', text: content }] };
  if (!Array.isArray(content) || content.length === 0) throw invalid('`content` must be a string or a non-empty array of content parts.', path);
  const parts: UserPart[] = [];
  const items: InputContent[] = [];
  for (const [j, part] of content.entries()) {
    const at = `${path}[${String(j)}]`;
    if (!isRecord(part)) throw invalid('A content part must be an object.', at);
    if (part.type === 'input_text') {
      if (typeof part.text !== 'string') throw invalid('An `input_text` part needs its text.', at);
      parts.push({ type: 'text', text: part.text });
      items.push({ type: 'input_text', text: part.text });
      continue;
    }
    if (part.type === 'input_image') {
      if (present(part.file_id) && !present(part.image_url)) throw unsupported('Images by `file_id` are not supported: send `image_url` as a data URL or an http(s) URL.', `${at}.file_id`);
      const image = parseImage(part.image_url, `${at}.image_url`, maxImageBytes);
      parts.push({ type: 'image', image });
      items.push({ type: 'input_image', image_url: imageReference(image), detail: typeof part.detail === 'string' ? part.detail : 'auto' });
      continue;
    }
    throw unsupported(`Content parts of type \`${String(part.type)}\` are not supported.`, `${at}.type`);
  }
  return { parts, items };
}

/** A function call's output: a string, or text parts (images and files cannot go back through the stub). */
function outputOf(output: unknown, path: string): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) throw invalid('`output` must be a string or an array of `input_text` parts.', path);
  return output
    .map((part, j) => {
      const at = `${path}[${String(j)}]`;
      if (!isRecord(part)) throw invalid('An output part must be an object.', at);
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
      throw unsupported(`Function call output parts of type \`${String(part.type)}\` are not supported: send text.`, `${at}.type`);
    })
    .join('\n');
}

const stringId = (value: unknown, prefix: string): string => (typeof value === 'string' && value ? value : newId(prefix));

/**
 * The input as messages. A `function_call` item, and an assistant `message` item, join the assistant
 * message right before them (an output's messages and calls are one assistant turn, as Chat
 * Completions sends them and as `assistantOfOutput` reads a stored output), or start one of their
 * own; texts join with a blank line, as the answer's text does. `reasoning` items are dropped:
 * Claudio never returns them, and the CLI keeps its own thinking.
 */
function parseInput(raw: unknown, maxImageBytes: number): { messages: ChatMessage[]; items: InputItem[] } {
  if (typeof raw === 'string') {
    if (!raw.trim()) throw invalid('`input` must not be empty.', 'input');
    return { messages: [{ role: 'user', parts: [{ type: 'text', text: raw }] }], items: [{ type: 'message', id: newId('msg'), status: 'completed', role: 'user', content: [{ type: 'input_text', text: raw }] }] };
  }
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('`input` must be a string or a non-empty array of input items.', 'input');
  const messages: ChatMessage[] = [];
  const items: InputItem[] = [];
  /** The assistant message a `function_call` right after it belongs to */
  let open: Extract<ChatMessage, { role: 'assistant' }> | null = null;
  for (const [i, item] of raw.entries()) {
    const path = `input[${String(i)}]`;
    if (!isRecord(item)) throw invalid('An input item must be an object.', path);
    const type = item.type ?? (item.role !== undefined ? 'message' : undefined);
    if (type === 'message') {
      const content = `${path}.content`;
      const id = stringId(item.id, 'msg');
      if (item.role === 'user') {
        const { parts, items: shown } = userContent(item.content, content, maxImageBytes);
        messages.push({ role: 'user', parts });
        items.push({ type: 'message', id, status: 'completed', role: 'user', content: shown });
        open = null;
      } else if (item.role === 'system' || item.role === 'developer') {
        const parts = textParts(item.content, content, false);
        messages.push({ role: item.role, text: joined(parts) });
        items.push({ type: 'message', id, status: 'completed', role: item.role, content: parts.map((p) => ({ type: 'input_text', text: p.text })) });
      } else if (item.role === 'assistant') {
        const parts = textParts(item.content, content, true);
        const text = joined(parts);
        if (open) open.text = [open.text, text].filter(Boolean).join('\n\n');
        else {
          open = { role: 'assistant', text, toolCalls: [] };
          messages.push(open);
        }
        items.push({
          type: 'message',
          id,
          status: 'completed',
          role: 'assistant',
          content: parts.map((p) => (p.kind === 'text' ? { type: 'output_text', text: p.text, annotations: [], logprobs: [] } : { type: 'refusal', refusal: p.text })),
        });
      } else {
        throw invalid(`Unknown role \`${String(item.role)}\`.`, `${path}.role`);
      }
      continue;
    }
    if (type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id) throw invalid('A `function_call` item needs `call_id`.', `${path}.call_id`);
      if (typeof item.name !== 'string' || !item.name) throw invalid('A `function_call` item needs `name`.', `${path}.name`);
      if (present(item.arguments) && typeof item.arguments !== 'string') throw invalid('`arguments` must be a JSON string.', `${path}.arguments`);
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      const call: ToolCall = { id: item.call_id, type: 'function', function: { name: item.name, arguments: args } };
      if (open) open.toolCalls.push(call);
      else {
        open = { role: 'assistant', text: '', toolCalls: [call] };
        messages.push(open);
      }
      items.push({ type: 'function_call', id: stringId(item.id, 'fc'), status: 'completed', call_id: item.call_id, name: item.name, arguments: args });
      continue;
    }
    if (type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !item.call_id) throw invalid('A `function_call_output` item needs `call_id`.', `${path}.call_id`);
      const output = outputOf(item.output, `${path}.output`);
      messages.push({ role: 'tool', toolCallId: item.call_id, text: output });
      items.push({ type: 'function_call_output', id: stringId(item.id, 'fco'), status: 'completed', call_id: item.call_id, output });
      open = null;
      continue;
    }
    if (type === 'reasoning') continue;
    if (type === 'item_reference') throw unsupported('`item_reference` items are not supported: send the item itself, or continue with `previous_response_id`.', `${path}.type`);
    if (typeof type === 'string' && HOSTED_ITEMS.has(type)) throw unsupported(`Input items of type \`${type}\` belong to OpenAI's hosted tools, which are not supported here.`, `${path}.type`);
    throw invalid(`Unknown input item type \`${String(type)}\`.`, `${path}.type`);
  }
  return { messages, items };
}

// ---------- options ----------

function parseTools(raw: unknown): { tools: ClientTool[]; echo: ResponseFunctionTool[] } {
  if (!present(raw)) return { tools: [], echo: [] };
  if (!Array.isArray(raw)) throw invalid('`tools` must be an array.', 'tools');
  const tools = raw.map((tool, j): ClientTool => {
    const at = `tools[${String(j)}]`;
    if (!isRecord(tool)) throw invalid('A tool must be an object.', at);
    if (tool.type === 'function') {
      const fn = parseFunction(tool, at);
      // Responses tries strict mode unless told otherwise (the migration guide); Chat Completions does not
      return { ...fn, strict: tool.strict !== false };
    }
    if (typeof tool.type === 'string' && HOSTED_TOOLS.has(tool.type)) {
      throw unsupported(`The hosted tool \`${tool.type}\` is not supported: Claude Code's own tools run on Claudio's machine (pick them with \`X-Claudio-Tool-Preset\`), and your own functions go in \`tools\` as \`{ "type": "function" }\`.`, `${at}.type`);
    }
    throw unsupported(`Tools of type \`${String(tool.type)}\` are not supported; only \`function\`.`, `${at}.type`);
  });
  assertDistinctTools(tools);
  return { tools, echo: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: t.strict })) };
}

function parseToolChoice(raw: unknown, tools: readonly ClientTool[]): { choice: ToolChoice; echo: ResponseToolChoice } {
  if (!present(raw)) return { choice: { kind: 'auto' }, echo: 'auto' };
  if (raw === 'auto' || raw === 'none' || raw === 'required') {
    if (raw === 'required' && tools.length === 0) throw invalid('`tool_choice` is `required` but no tools were sent.', 'tool_choice');
    return { choice: { kind: raw }, echo: raw };
  }
  if (!isRecord(raw)) throw invalid('`tool_choice` must be `auto`, `none`, `required` or `{ "type": "function", "name": … }`.', 'tool_choice');
  if (raw.type === 'function') {
    if (typeof raw.name !== 'string') throw invalid('A function `tool_choice` needs `name`.', 'tool_choice.name');
    if (!tools.some((t) => t.name === raw.name)) throw invalid(`\`tool_choice\` names \`${raw.name}\`, which is not among the tools.`, 'tool_choice.name');
    return { choice: { kind: 'function', name: raw.name }, echo: { type: 'function', name: raw.name } };
  }
  if (raw.type === 'allowed_tools') throw unsupported('`tool_choice` of type `allowed_tools` is not supported: send only the tools the model may call.', 'tool_choice.type');
  throw unsupported(`\`tool_choice\` of type \`${String(raw.type)}\` is not supported: hosted tools are not available here.`, 'tool_choice.type');
}

function parseTextFormat(raw: unknown, ignored: string[]): { format: ResponseFormat; echo: ResponseTextFormat } {
  if (!present(raw)) return { format: { type: 'text' }, echo: { type: 'text' } };
  if (!isRecord(raw)) throw invalid('`text` must be an object.', 'text');
  if (present(raw.verbosity)) ignored.push('text.verbosity');
  const spec = raw.format;
  if (!present(spec)) return { format: { type: 'text' }, echo: { type: 'text' } };
  if (!isRecord(spec)) throw invalid('`text.format` must be an object.', 'text.format');
  if (spec.type === 'text' || spec.type === 'json_object') return { format: { type: spec.type }, echo: { type: spec.type } };
  if (spec.type !== 'json_schema') throw unsupported(`\`text.format.type\` \`${String(spec.type)}\` is not supported.`, 'text.format.type');
  if (typeof spec.name !== 'string' || !spec.name) throw invalid('`text.format` of type `json_schema` needs a `name`.', 'text.format.name');
  if (!isRecord(spec.schema)) throw invalid('`text.format.schema` must be a JSON Schema object.', 'text.format.schema');
  const strict = spec.strict === true;
  return {
    format: { type: 'json_schema', name: spec.name, schema: spec.schema, strict },
    echo: { type: 'json_schema', name: spec.name, schema: spec.schema, strict, ...(typeof spec.description === 'string' ? { description: spec.description } : {}) },
  };
}

function parseReasoning(raw: unknown, ignored: string[]): string | null {
  if (!present(raw)) return null;
  if (!isRecord(raw)) throw invalid('`reasoning` must be an object.', 'reasoning');
  for (const name of ['summary', 'generate_summary', 'context', 'mode']) if (present(raw[name])) ignored.push(`reasoning.${name}`);
  if (!present(raw.effort)) return null;
  if (typeof raw.effort !== 'string' || !Object.hasOwn(EFFORT_OF, raw.effort)) throw invalid(`\`reasoning.effort\` must be one of ${Object.keys(EFFORT_OF).join(', ')}.`, 'reasoning.effort');
  return raw.effort;
}

/** The reference's limits: 16 pairs, keys up to 64 characters, string values up to 512. */
function parseMetadata(raw: unknown): Record<string, string> {
  if (!present(raw)) return {};
  if (!isRecord(raw)) throw invalid('`metadata` must be an object of strings.', 'metadata');
  const entries = Object.entries(raw);
  if (entries.length > 16) throw invalid('`metadata` holds at most 16 pairs.', 'metadata');
  for (const [key, value] of entries) {
    if (key.length > 64) throw invalid('A `metadata` key is at most 64 characters.', 'metadata');
    if (typeof value !== 'string' || value.length > 512) throw invalid('A `metadata` value is a string of at most 512 characters.', 'metadata');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function parse(body: unknown, maxImageBytes: number): ResponsesRequest {
  if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalid('`model` is required.', 'model');
  if (body.background === true) throw unsupported('`background` responses are not supported: send the request and wait for it, or stream it.', 'background');
  if (present(body.conversation)) throw unsupported('Conversation objects are not supported: continue with `previous_response_id`, or resend the history.', 'conversation');
  if (present(body.prompt)) throw unsupported('Stored prompt templates (`prompt`) are not supported: send `instructions` and `input`.', 'prompt');
  if (present(body.stream) && typeof body.stream !== 'boolean') throw invalid('`stream` must be a boolean.', 'stream');
  if (present(body.store) && typeof body.store !== 'boolean') throw invalid('`store` must be a boolean.', 'store');
  if (present(body.instructions) && typeof body.instructions !== 'string') throw invalid('`instructions` must be a string.', 'instructions');
  if (present(body.previous_response_id) && (typeof body.previous_response_id !== 'string' || !body.previous_response_id)) throw invalid('`previous_response_id` must be a response id.', 'previous_response_id');
  if (present(body.user) && typeof body.user !== 'string') throw invalid('`user` must be a string.', 'user');
  if (present(body.parallel_tool_calls) && typeof body.parallel_tool_calls !== 'boolean') throw invalid('`parallel_tool_calls` must be a boolean.', 'parallel_tool_calls');
  if (present(body.truncation) && body.truncation !== 'auto' && body.truncation !== 'disabled') throw invalid('`truncation` must be `auto` or `disabled`.', 'truncation');
  if (!present(body.input)) throw invalid('`input` is required.', 'input');

  const ignored: string[] = IGNORED_PARAMETERS.filter((name) => present(body[name]) && body[name] !== false);
  // `disabled` is the default and what the CLI does by itself; only `auto` asks for something it cannot do
  if (body.truncation === 'auto') ignored.push('truncation');
  if (Array.isArray(body.include) && body.include.length > 0) ignored.push('include');

  const { messages, items } = parseInput(body.input, maxImageBytes);
  const last = messages.findLast((m) => m.role !== 'system' && m.role !== 'developer');
  // As in Chat Completions: the CLI cannot continue a reply the client wrote the start of
  if (!last || last.role === 'assistant') throw invalid('The last input item must be a user message or a `function_call_output`.', 'input');

  const { tools, echo: toolsEcho } = parseTools(body.tools);
  const { choice, echo: choiceEcho } = parseToolChoice(body.tool_choice, tools);
  const { format, echo: formatEcho } = parseTextFormat(body.text, ignored);
  const effort = parseReasoning(body.reasoning, ignored);
  const metadata = parseMetadata(body.metadata);
  const user = typeof body.user === 'string' ? body.user : null;
  const parallel = typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : null;
  const model = body.model.trim();
  return {
    chat: {
      model,
      messages,
      stream: body.stream === true,
      includeUsage: false,
      reasoningEffort: effort,
      responseFormat: format,
      tools,
      toolChoice: choice,
      parallelToolCalls: parallel,
      user,
      ignored,
    },
    instructions: typeof body.instructions === 'string' ? body.instructions : null,
    previousResponseId: typeof body.previous_response_id === 'string' ? body.previous_response_id : null,
    store: body.store !== false,
    metadata,
    inputItems: items,
    echo: {
      tools: toolsEcho,
      toolChoice: choiceEcho,
      text: { format: formatEcho },
      parallelToolCalls: parallel !== false,
      reasoningEffort: effort,
      maxOutputTokens: numberOrNull(body.max_output_tokens),
      temperature: numberOrNull(body.temperature),
      topP: numberOrNull(body.top_p),
      truncation: body.truncation === 'auto' ? 'auto' : 'disabled',
      user,
    },
  };
}

/** Reads a `POST /v1/responses` body; a bad shape is an OpenAI-shaped 400, never a throw. */
export function parseResponsesRequest(body: unknown, options: ParseOptions = {}): Parsed<ResponsesRequest> {
  try {
    return { ok: true, value: parse(body, options.maxImageBytes ?? UPLOAD_LIMITS.image) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: openAiError(err.failure) };
    throw err;
  }
}

// ---------- into a chat turn ----------

/**
 * The output of a stored response as the assistant message it was: its text and its function calls.
 * Put before a `previous_response_id` request's new items, so the results it carries are checked
 * against the calls exactly as a resent history's are, and the delta is just the new items.
 */
export function assistantOfOutput(output: readonly OutputItem[]): Extract<ChatMessage, { role: 'assistant' }> {
  const text = output
    .flatMap((item) => (item.type === 'message' ? [item.content.map((c) => c.text).join('')] : []))
    .filter(Boolean)
    .join('\n\n');
  const toolCalls: ToolCall[] = output.flatMap((item) => (item.type === 'function_call' ? [{ id: item.call_id, type: 'function' as const, function: { name: item.name, arguments: item.arguments } }] : []));
  return { role: 'assistant', text, toolCalls };
}

/** The request with the stored response's output put before its new items. */
export function withPreviousOutput(request: ResponsesRequest, output: readonly OutputItem[]): ResponsesRequest {
  return { ...request, chat: { ...request.chat, messages: [assistantOfOutput(output), ...request.chat.messages] } };
}

/**
 * What starting or resuming the chat needs. Its `appendSystemPrompt` is only the input's system and
 * developer messages, as on Chat Completions: `instructions`, and what a `previous_response_id`
 * chain carried, join them in the route (`systemPromptParts`), which knows the chat. `instructions`
 * stay out of the conversation key: the reference says they are not carried from one response to the
 * next, so a client may change them on every request (its own function-calling example does) and
 * still be in the same conversation.
 */
export function responsesTurnOf(request: ResponsesRequest): ChatTurn {
  return translateRequest(request.chat);
}

/**
 * The conversation key after a `previous_response_id` turn: the stored response's key, extended by
 * the new items and the answer. A client that later resends the whole history (with the same model
 * and `user`, and its system messages as the first request had them) finds the same chat.
 */
export function keyAfterPrevious(previousKey: string, newMessages: readonly ChatMessage[], answer: { text: string; toolCalls: ToolCall[] }): string {
  return extendKey(newMessages.reduce(extendKey, previousKey), { role: 'assistant', text: answer.text, toolCalls: answer.toolCalls });
}
