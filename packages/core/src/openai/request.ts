import type { Effort } from '@claudio/shared';
import { sniffMediaType, UPLOAD_LIMITS } from '../uploads.ts';
import { historyKey, normalizeText, stableStringify, type KeySeed } from './conversation-key.ts';
import { openAiError, type OpenAiErrorResponse, type OpenAiFailure } from './errors.ts';
import type { ChatCompletionRequest, ChatMessage, ClientTool, ImageRef, ResponseFormat, ToolCall, ToolChoice, UserPart } from './wire.ts';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: OpenAiErrorResponse };

/** Thrown only inside the parsers (this one and `responses-request.ts`), and always caught before a caller sees it. */
export class Refusal extends Error {
  constructor(readonly failure: OpenAiFailure) {
    super(failure.kind);
  }
}

export const invalid = (message: string, param: string | null = null): Refusal => new Refusal({ kind: 'invalid-request', message, param });
export const unsupported = (message: string, param: string): Refusal => new Refusal({ kind: 'unsupported-parameter', message, param });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const present = (value: unknown): boolean => value !== undefined && value !== null;

/** Types Claude reads as images; the same set the upload store accepts as `image`. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Parameters the CLI has no flag for. Accepted and named back in `x-claudio-ignored` rather than
 * refused: SDKs send several of them by default, and a 400 would make Claudio unusable from them.
 * `false` and `null` ask for nothing, so they are not listed.
 */
const IGNORED_PARAMETERS = [
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'logprobs',
  'top_logprobs',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'service_tier',
  'store',
  'metadata',
  'prediction',
] as const;

/**
 * OpenAI's `reasoning_effort` in Claudio's levels. OpenAI's lowest two have no Claudio match, so
 * they take the lowest Claudio has; Claudio's own `max` is accepted for a client that knows it.
 */
export const EFFORT_OF: Readonly<Record<string, Effort>> = { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ParseOptions {
  /** The largest image a data URL may carry, decoded; the upload store's image limit by default */
  maxImageBytes?: number;
}

// ---------- the parts of a message ----------

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function parseImage(url: unknown, path: string, maxBytes: number): ImageRef {
  if (typeof url !== 'string' || !url) throw invalid('An image part needs `image_url.url`.', path);
  if (url.startsWith('data:')) {
    const match = DATA_URL_RE.exec(url);
    const mediaType = match?.[1]?.toLowerCase() ?? '';
    if (!match || !(match[2] ?? '').split(';').includes('base64')) throw invalid('An image data URL must be base64-encoded.', path);
    if (!IMAGE_TYPES.has(mediaType)) throw unsupported(`Images must be PNG, JPEG, GIF or WebP; got \`${mediaType || 'no type'}\`.`, path);
    const base64 = (match[3] ?? '').replace(/\s/g, '');
    if (!base64 || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) throw invalid('The image data URL is not valid base64.', path);
    // Measured from the text, so an oversized image is refused without decoding it
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const sizeBytes = (base64.length / 4) * 3 - padding;
    if (sizeBytes > maxBytes) throw invalid(`The image is ${String(sizeBytes)} bytes; the most is ${String(maxBytes)}.`, path);
    return { kind: 'data', mediaType, base64, sizeBytes };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('The image URL is not a valid URL.', path);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw unsupported(`Image URLs must be \`data:\`, \`http:\` or \`https:\`; got \`${parsed.protocol}\`.`, path);
  return { kind: 'url', url: parsed.toString() };
}

type PartKind = 'text' | 'text+refusal' | 'user';

/** String or array content as plain text; refusal parts read as text in an assistant's history. */
function parseText(content: unknown, path: string, kind: Exclude<PartKind, 'user'>, allowNull = false): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) {
    if (allowNull) return '';
    throw invalid('The message needs `content`.', path);
  }
  if (!Array.isArray(content)) throw invalid('`content` must be a string or an array of parts.', path);
  return content
    .map((part, j) => {
      const at = `${path}[${String(j)}]`;
      if (!isRecord(part)) throw invalid('A content part must be an object.', at);
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (kind === 'text+refusal' && part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      if (part.type === 'text' || part.type === 'refusal') throw invalid(`A \`${part.type}\` part needs its text.`, at);
      throw unsupported(`Content parts of type \`${String(part.type)}\` are not supported here.`, `${at}.type`);
    })
    .join('\n');
}

function parseUserParts(content: unknown, path: string, maxImageBytes: number): UserPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw invalid('`content` must be a string or an array of parts.', path);
  if (content.length === 0) throw invalid('`content` must not be empty.', path);
  return content.map((part, j): UserPart => {
    const at = `${path}[${String(j)}]`;
    if (!isRecord(part)) throw invalid('A content part must be an object.', at);
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw invalid('A `text` part needs its text.', at);
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image_url') {
      // Some clients send the URL itself rather than `{ url }`
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      return { type: 'image', image: parseImage(url, `${at}.image_url`, maxImageBytes) };
    }
    throw unsupported(`Content parts of type \`${String(part.type)}\` are not supported.`, `${at}.type`);
  });
}

function parseToolCalls(raw: unknown, path: string): ToolCall[] {
  if (!present(raw)) return [];
  if (!Array.isArray(raw)) throw invalid('`tool_calls` must be an array.', path);
  return raw.map((call, j): ToolCall => {
    const at = `${path}[${String(j)}]`;
    if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function) || typeof call.function.name !== 'string') {
      throw invalid('A tool call needs `id` and `function.name`.', at);
    }
    const args = call.function.arguments;
    if (present(args) && typeof args !== 'string') throw invalid('`function.arguments` must be a JSON string.', `${at}.function.arguments`);
    return { id: call.id, type: 'function', function: { name: call.function.name, arguments: typeof args === 'string' ? args : '' } };
  });
}

function parseMessage(raw: unknown, i: number, maxImageBytes: number): ChatMessage {
  const path = `messages[${String(i)}]`;
  if (!isRecord(raw)) throw invalid('A message must be an object.', path);
  const content = `${path}.content`;
  switch (raw.role) {
    case 'system':
    case 'developer':
      return { role: raw.role, text: parseText(raw.content, content, 'text') };
    case 'user':
      return { role: 'user', parts: parseUserParts(raw.content, content, maxImageBytes) };
    case 'assistant': {
      const toolCalls = parseToolCalls(raw.tool_calls, `${path}.tool_calls`);
      // The legacy single `function_call` is one tool call; its id was never sent, so the name stands in
      if (isRecord(raw.function_call) && typeof raw.function_call.name === 'string') {
        const args = typeof raw.function_call.arguments === 'string' ? raw.function_call.arguments : '';
        toolCalls.push({ id: raw.function_call.name, type: 'function', function: { name: raw.function_call.name, arguments: args } });
      }
      const text = parseText(raw.content, content, 'text+refusal', true);
      if (!text && toolCalls.length === 0 && !present(raw.content)) throw invalid('An assistant message needs `content` or `tool_calls`.', path);
      return { role: 'assistant', text, toolCalls };
    }
    case 'tool':
      if (typeof raw.tool_call_id !== 'string' || !raw.tool_call_id) throw invalid('A tool message needs `tool_call_id`.', `${path}.tool_call_id`);
      return { role: 'tool', toolCallId: raw.tool_call_id, text: parseText(raw.content, content, 'text') };
    case 'function':
      if (typeof raw.name !== 'string' || !raw.name) throw invalid('A function message needs `name`.', `${path}.name`);
      return { role: 'tool', toolCallId: raw.name, text: parseText(raw.content, content, 'text', true) };
    default:
      throw invalid(`Unknown role \`${String(raw.role)}\`.`, `${path}.role`);
  }
}

// ---------- the request's options ----------

export function parseFunction(raw: unknown, path: string): ClientTool {
  if (!isRecord(raw) || typeof raw.name !== 'string') throw invalid('A function needs a `name`.', path);
  if (!TOOL_NAME_RE.test(raw.name)) throw invalid('A function name is 1 to 64 letters, digits, `_` or `-`.', `${path}.name`);
  if (present(raw.parameters) && !isRecord(raw.parameters)) throw invalid('`parameters` must be a JSON Schema object.', `${path}.parameters`);
  if (present(raw.description) && typeof raw.description !== 'string') throw invalid('`description` must be a string.', `${path}.description`);
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : null,
    parameters: isRecord(raw.parameters) ? raw.parameters : { type: 'object', properties: {} },
    strict: raw.strict === true,
  };
}

function parseTools(body: Record<string, unknown>): ClientTool[] {
  if (present(body.tools) && present(body.functions)) throw invalid('Send `tools` or the legacy `functions`, not both.', 'functions');
  let tools: ClientTool[] = [];
  if (present(body.tools)) {
    if (!Array.isArray(body.tools)) throw invalid('`tools` must be an array.', 'tools');
    tools = body.tools.map((tool, j) => {
      const at = `tools[${String(j)}]`;
      if (!isRecord(tool) || tool.type !== 'function') throw unsupported('Only tools of type `function` are supported.', `${at}.type`);
      return parseFunction(tool.function, `${at}.function`);
    });
  } else if (present(body.functions)) {
    if (!Array.isArray(body.functions)) throw invalid('`functions` must be an array.', 'functions');
    tools = body.functions.map((fn, j) => parseFunction(fn, `functions[${String(j)}]`));
  }
  assertDistinctTools(tools);
  return tools;
}

export function assertDistinctTools(tools: readonly ClientTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    // The stub MCP server lists them under one prefix: two of a name could not be told apart
    if (seen.has(tool.name)) throw invalid(`Two tools are named \`${tool.name}\`.`, 'tools');
    seen.add(tool.name);
  }
}

function parseToolChoice(body: Record<string, unknown>, tools: readonly ClientTool[]): ToolChoice {
  const legacy = !present(body.tool_choice) && present(body.function_call);
  const raw = legacy ? body.function_call : body.tool_choice;
  const param = legacy ? 'function_call' : 'tool_choice';
  if (!present(raw)) return { kind: 'auto' };
  if (raw === 'auto' || raw === 'none' || raw === 'required') {
    if (raw === 'required' && tools.length === 0) throw invalid('`tool_choice` is `required` but no tools were sent.', param);
    return { kind: raw };
  }
  const name = isRecord(raw) ? (legacy ? raw.name : isRecord(raw.function) ? raw.function.name : undefined) : undefined;
  if (typeof name !== 'string') throw invalid('`tool_choice` must be `auto`, `none`, `required` or a named function.', param);
  if (!tools.some((t) => t.name === name)) throw invalid(`\`${param}\` names \`${name}\`, which is not among the tools.`, param);
  return { kind: 'function', name };
}

function parseResponseFormat(raw: unknown): ResponseFormat {
  if (!present(raw)) return { type: 'text' };
  if (!isRecord(raw)) throw invalid('`response_format` must be an object.', 'response_format');
  if (raw.type === 'text' || raw.type === 'json_object') return { type: raw.type };
  if (raw.type !== 'json_schema') throw unsupported(`\`response_format.type\` \`${String(raw.type)}\` is not supported.`, 'response_format.type');
  const spec = raw.json_schema;
  if (!isRecord(spec) || typeof spec.name !== 'string') throw invalid('`response_format.json_schema` needs a `name`.', 'response_format.json_schema');
  if (!isRecord(spec.schema)) throw invalid('`response_format.json_schema.schema` must be a JSON Schema object.', 'response_format.json_schema.schema');
  return { type: 'json_schema', name: spec.name, schema: spec.schema, strict: spec.strict === true };
}

function parseRequest(body: unknown, maxImageBytes: number): ChatCompletionRequest {
  if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalid('`model` is required.', 'model');
  if (present(body.n)) {
    if (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < 1) throw invalid('`n` must be a positive integer.', 'n');
    // One chat answers once: several choices would be several chats, billed several times
    if (body.n > 1) throw unsupported('Only one choice per request is supported (`n` = 1).', 'n');
  }
  if (present(body.audio) || (Array.isArray(body.modalities) && body.modalities.some((m) => m !== 'text'))) {
    throw unsupported('Only text output is supported.', present(body.audio) ? 'audio' : 'modalities');
  }
  if (present(body.stream) && typeof body.stream !== 'boolean') throw invalid('`stream` must be a boolean.', 'stream');
  if (present(body.stream_options) && !isRecord(body.stream_options)) throw invalid('`stream_options` must be an object.', 'stream_options');
  if (present(body.reasoning_effort) && (typeof body.reasoning_effort !== 'string' || !Object.hasOwn(EFFORT_OF, body.reasoning_effort))) {
    throw invalid(`\`reasoning_effort\` must be one of ${Object.keys(EFFORT_OF).join(', ')}.`, 'reasoning_effort');
  }
  if (present(body.user) && typeof body.user !== 'string') throw invalid('`user` must be a string.', 'user');
  if (present(body.parallel_tool_calls) && typeof body.parallel_tool_calls !== 'boolean') throw invalid('`parallel_tool_calls` must be a boolean.', 'parallel_tool_calls');

  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('`messages` must be a non-empty array.', 'messages');
  const messages = body.messages.map((m, i) => parseMessage(m, i, maxImageBytes));
  const last = messages.findLast((m) => m.role !== 'system' && m.role !== 'developer');
  // The CLI cannot continue a reply the client wrote the start of, so the turn must be the client's
  if (!last || last.role === 'assistant') throw invalid('The last message must be from the user or a tool.', 'messages');

  const tools = parseTools(body);
  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {};
  return {
    model: body.model.trim(),
    messages,
    stream: body.stream === true,
    includeUsage: body.stream === true && streamOptions.include_usage === true,
    reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null,
    responseFormat: parseResponseFormat(body.response_format),
    tools,
    toolChoice: parseToolChoice(body, tools),
    parallelToolCalls: typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : null,
    user: typeof body.user === 'string' ? body.user : null,
    ignored: IGNORED_PARAMETERS.filter((name) => present(body[name]) && body[name] !== false),
  };
}

/** Reads a request body; a bad shape is an OpenAI-shaped 400, never a throw. */
export function parseChatCompletionRequest(body: unknown, options: ParseOptions = {}): Parsed<ChatCompletionRequest> {
  try {
    return { ok: true, value: parseRequest(body, options.maxImageBytes ?? UPLOAD_LIMITS.image) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: openAiError(err.failure) };
    throw err;
  }
}

// ---------- what a chat start needs ----------

/** A prompt and the images it refers to as `[image N]`, in that order. */
export interface RenderedPrompt {
  prompt: string;
  images: ImageRef[];
}

/** What starting or resuming a chat for one request needs; the route turns it into `NewChatRequest`. */
export interface ChatTurn {
  model: string;
  appendSystemPrompt?: string;
  effort?: Effort;
  jsonSchema?: Record<string, unknown>;
  /**
   * `response_format.json_schema.strict` as the client sent it; null without a schema. Recorded only:
   * the CLI validates every structured output against the schema and makes the model retry, so the
   * answer is held to the schema whether or not the client asked for strictness.
   */
  schemaStrict: boolean | null;
  user: string | null;
  stream: boolean;
  includeUsage: boolean;
  /** The client's tools: a stub MCP server serves them (docs/openai-compatible-api.md, phase 4) */
  tools: ClientTool[];
  toolChoice: ToolChoice;
  parallelToolCalls: boolean | null;
  ignored: string[];
  /** The seed of the conversation key, to compute the key after the answer */
  keySeed: KeySeed;
  /** The key to look the chat up by; null when the history has no assistant message */
  historyKey: string | null;
  /** A new chat's first prompt: the earlier turns as a transcript, then the new ones */
  cold: RenderedPrompt;
  /** A resumed chat's prompt: only the messages after the last assistant message */
  delta: RenderedPrompt;
  /**
   * A new chat's name: the first user message's first line. Without it the chat is named
   * `<dir>-<id prefix>`, which the CLI records as the session's title, and the first prompt a cold
   * start sends is the preamble over the rendered history, not anything the person wrote. Null when
   * no user message has text.
   */
  title: string | null;
}

const COLD_PREAMBLE =
  'This conversation began in another client, which sent its earlier turns along. They are below, oldest first; ' +
  'treat them as what was already said, then answer the new message after them.';

class ImageList {
  readonly images: ImageRef[] = [];
  add(image: ImageRef): string {
    this.images.push(image);
    return `[image ${String(this.images.length)}]`;
  }
}

function userText(parts: readonly UserPart[], images: ImageList): string {
  return normalizeText(parts.map((p) => (p.type === 'text' ? p.text : images.add(p.image))).join('\n'));
}

const toolResult = (m: Extract<ChatMessage, { role: 'tool' }>): string => `<tool-result id="${m.toolCallId}">\n${normalizeText(m.text)}\n</tool-result>`;

/** The new turn as the model reads it: the user's words as they are, tool results marked. */
function renderNew(messages: readonly ChatMessage[], images: ImageList): string {
  return messages
    .map((m) => (m.role === 'user' ? userText(m.parts, images) : m.role === 'tool' ? toolResult(m) : ''))
    .filter(Boolean)
    .join('\n\n');
}

function renderEarlier(messages: readonly ChatMessage[], images: ImageList): string {
  const blocks = messages.map((m) => {
    if (m.role === 'user') return `<user>\n${userText(m.parts, images)}\n</user>`;
    if (m.role === 'tool') return toolResult(m);
    if (m.role === 'assistant') {
      const calls = m.toolCalls.map((c) => `<tool-call id="${c.id}" name="${c.function.name}">\n${c.function.arguments}\n</tool-call>`);
      return `<assistant>\n${[normalizeText(m.text), ...calls].filter(Boolean).join('\n')}\n</assistant>`;
    }
    return '';
  });
  return `<earlier-turns>\n${blocks.filter(Boolean).join('\n')}\n</earlier-turns>`;
}

/** Splits the history at its last assistant message: what was said, and what is new. */
function split(messages: readonly ChatMessage[]): { earlier: ChatMessage[]; fresh: ChatMessage[] } {
  const turns = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const last = turns.findLastIndex((m) => m.role === 'assistant');
  return { earlier: turns.slice(0, last + 1), fresh: turns.slice(last + 1) };
}

export function renderCold(messages: readonly ChatMessage[]): RenderedPrompt {
  const { earlier, fresh } = split(messages);
  const images = new ImageList();
  if (earlier.length === 0) return { prompt: renderNew(fresh, images), images: images.images };
  const transcript = renderEarlier(earlier, images);
  return { prompt: `${COLD_PREAMBLE}\n\n${transcript}\n\n${renderNew(fresh, images)}`, images: images.images };
}

export function renderDelta(messages: readonly ChatMessage[]): RenderedPrompt {
  const images = new ImageList();
  return { prompt: renderNew(split(messages).fresh, images), images: images.images };
}

const RESULTS_AFTER_RESTART =
  'Your session restarted while you waited for the results of your client tool calls, so those calls were recorded as interrupted. ' +
  'The client has now sent their results, below; continue from them as if each call had returned it.';

/**
 * A resumed chat's prompt when the process that held the client's calls is gone: the CLI records
 * its own "interrupted" error for each dangling call on `--resume`, so the results go in as a user
 * message that says what happened (spike question 6).
 */
export function renderResultsCold(messages: readonly ChatMessage[]): RenderedPrompt {
  const images = new ImageList();
  return { prompt: `${RESULTS_AFTER_RESTART}\n\n${renderNew(split(messages).fresh, images)}`, images: images.images };
}

/** Every `system` and `developer` message, wherever it stands, as the one system prompt the CLI appends. */
export function systemPromptOf(messages: readonly ChatMessage[]): string | null {
  const texts = messages.flatMap((m) => (m.role === 'system' || m.role === 'developer' ? [normalizeText(m.text)] : [])).filter(Boolean);
  return texts.length ? texts.join('\n\n') : null;
}

function jsonSchemaOf(format: ResponseFormat): Record<string, unknown> | undefined {
  if (format.type === 'json_schema') return format.schema;
  // "Any JSON object" is a schema too, and the CLI's `--json-schema` is how Claudio enforces one
  if (format.type === 'json_object') return { type: 'object' };
  return undefined;
}

/**
 * Whether two schemas are the same for a process: compared as JSON with keys sorted, so a client that
 * reorders a schema's keys between turns keeps its process. `undefined` (no schema) equals only itself.
 */
export function sameJsonSchema(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return (a ?? undefined) === (b ?? undefined);
  return stableStringify(a) === stableStringify(b);
}

export function translateRequest(request: ChatCompletionRequest): ChatTurn {
  const systemPrompt = systemPromptOf(request.messages);
  const effort = request.reasoningEffort === null ? undefined : EFFORT_OF[request.reasoningEffort];
  const jsonSchema = jsonSchemaOf(request.responseFormat);
  const keySeed: KeySeed = { model: request.model, systemPrompt, user: request.user };
  return {
    model: request.model,
    ...(systemPrompt !== null ? { appendSystemPrompt: systemPrompt } : {}),
    ...(effort ? { effort } : {}),
    ...(jsonSchema ? { jsonSchema } : {}),
    schemaStrict: request.responseFormat.type === 'json_schema' ? request.responseFormat.strict : null,
    user: request.user,
    stream: request.stream,
    includeUsage: request.includeUsage,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    ignored: request.ignored,
    keySeed,
    historyKey: historyKey(keySeed, request.messages),
    cold: renderCold(request.messages),
    delta: renderDelta(request.messages),
    title: titleOf(request.messages),
  };
}

/**
 * The same cut as a transcript's title: the first line, at most 100 UTF-16 units (`sessions.ts`
 * counts the same way), but never ending on half of a surrogate pair: the name goes to the CLI's
 * `--name` and into the chat list, where a lone surrogate is not text.
 */
function titleOf(messages: readonly ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = normalizeText(m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
    const line = cutTitle(text.split('\n')[0]?.trim() ?? '');
    if (line) return line;
  }
  return null;
}

const TITLE_LENGTH = 100;

function cutTitle(line: string): string {
  if (line.length <= TITLE_LENGTH) return line;
  const last = line.charCodeAt(TITLE_LENGTH - 1);
  return line.slice(0, last >= 0xd800 && last <= 0xdbff ? TITLE_LENGTH - 1 : TITLE_LENGTH);
}

/** Parse and translate in one step, for a route. */
export function chatTurnOf(body: unknown, options: ParseOptions = {}): Parsed<ChatTurn> {
  const parsed = parseChatCompletionRequest(body, options);
  return parsed.ok ? { ok: true, value: translateRequest(parsed.value) } : parsed;
}

// ---------- images into uploads ----------

/** The I/O the images need, injected so the translation stays testable without a network or a disk. */
export interface ImageUploads {
  /** Fetches an http(s) image; may stop reading past `maxBytes` and should refuse private addresses */
  fetch(url: string, maxBytes: number): Promise<{ bytes: Buffer; mediaType: string | null }>;
  /** Stores the bytes as an upload; `UploadStore.save` fits */
  save(name: string, bytes: Buffer): { id: string };
}

const EXTENSION: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * Turns a prompt's images into upload ids, in order, so `[image N]` is the Nth attachment. The bytes
 * decide the type, not the label: an image block whose declared type is wrong is rejected by the
 * API, so a mislabelled or non-image file is refused here with a 400 instead of failing the run.
 * `param` names where the images came from: `messages` for Chat Completions, `input` for Responses.
 */
export async function uploadImages(images: readonly ImageRef[], uploads: ImageUploads, maxBytes: number = UPLOAD_LIMITS.image, param: string = 'messages'): Promise<Parsed<string[]>> {
  const ids: string[] = [];
  for (const [i, image] of images.entries()) {
    const n = String(i + 1);
    let bytes: Buffer;
    if (image.kind === 'data') {
      bytes = Buffer.from(image.base64, 'base64');
    } else {
      try {
        bytes = (await uploads.fetch(image.url, maxBytes)).bytes;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: openAiError({ kind: 'invalid-request', message: `Image ${n} could not be fetched: ${reason}`, param }) };
      }
    }
    if (bytes.length === 0) return { ok: false, error: openAiError({ kind: 'invalid-request', message: `Image ${n} is empty.`, param }) };
    if (bytes.length > maxBytes) {
      return { ok: false, error: openAiError({ kind: 'invalid-request', message: `Image ${n} is ${String(bytes.length)} bytes; the most is ${String(maxBytes)}.`, param }) };
    }
    const mediaType = sniffMediaType(bytes, '');
    if (!IMAGE_TYPES.has(mediaType)) {
      return { ok: false, error: openAiError({ kind: 'unsupported-parameter', message: `Image ${n} is not a PNG, JPEG, GIF or WebP image.`, param }) };
    }
    ids.push(uploads.save(`openai-image-${n}.${EXTENSION[mediaType] ?? 'bin'}`, bytes).id);
  }
  return { ok: true, value: ids };
}
