import { createHash } from 'node:crypto';
import type { ChatMessage, ToolCall } from './wire.ts';

/**
 * The conversation key: how a stateless client's request finds the Claudio chat that already holds
 * its history (docs/openai-compatible-api.md, the conversation key).
 *
 * A hash chain rather than one hash of the whole list, so the key the *next* request will carry can
 * be computed from this one plus the answer, without keeping the messages.
 *
 * What is hashed, exactly:
 * - the seed: a version tag, the model id as sent, the system prompt (every `system` and `developer`
 *   message, joined as `appendSystemPrompt` gets them) and the OpenAI `user`, so two end users with
 *   the same history never share a chat;
 * - then each other message in order, as a canonical JSON array:
 *   `["user", ...parts]` with text parts as text and images as the SHA-256 of their URL or data;
 *   `["assistant", text, [[id, name, arguments]...]]`; `["tool", toolCallId, text]`.
 *
 * Normalised, because clients differ there without meaning anything: CRLF becomes LF and each
 * message's text is trimmed at both ends (chat front ends trim what they echo back), string content
 * is the same as one text part, `null` assistant content is the same as `""`, and tool-call
 * arguments that parse as JSON are compared with their keys sorted. Never normalised: whitespace
 * inside a message, letter case, or the model id (an alias is a different key).
 */
const KEY_VERSION = 'claudio-openai-conversation/1';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Text as both the key and the prompt read it. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** JSON with object keys sorted, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are one value. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function canonicalArguments(raw: string): string {
  try {
    return stableStringify(JSON.parse(raw) as unknown);
  } catch {
    return raw.trim();
  }
}

const canonicalCalls = (calls: readonly ToolCall[]): string[][] => calls.map((c) => [c.id, c.function.name, canonicalArguments(c.function.arguments)]);

/** One message's canonical form; null for the roles that belong to the seed. */
function canonical(message: ChatMessage): unknown[] | null {
  switch (message.role) {
    case 'system':
    case 'developer':
      return null;
    case 'user':
      return [
        'user',
        ...message.parts.map((p) => (p.type === 'text' ? normalizeText(p.text) : ['image', sha256(p.image.kind === 'data' ? p.image.base64 : p.image.url)])),
      ];
    case 'assistant':
      return ['assistant', normalizeText(message.text), canonicalCalls(message.toolCalls)];
    case 'tool':
      return ['tool', message.toolCallId, normalizeText(message.text)];
  }
}

export interface KeySeed {
  model: string;
  systemPrompt: string | null;
  user: string | null;
}

export function seedKey(seed: KeySeed): string {
  return sha256(JSON.stringify([KEY_VERSION, seed.model, seed.systemPrompt ?? '', seed.user ?? null]));
}

/** The chain one message further. System and developer messages leave it as it is: they are in the seed. */
export function extendKey(key: string, message: ChatMessage): string {
  const form = canonical(message);
  return form === null ? key : sha256(`${key}\n${JSON.stringify(form)}`);
}

export function chainKey(seed: KeySeed, messages: readonly ChatMessage[]): string {
  return messages.reduce(extendKey, seedKey(seed));
}

/**
 * The key a request is looked up by: the chain through its last assistant message. Null when there
 * is none, since a history with no answer in it was never a chat Claudio answered.
 */
export function historyKey(seed: KeySeed, messages: readonly ChatMessage[]): string | null {
  const last = messages.findLastIndex((m) => m.role === 'assistant');
  return last < 0 ? null : chainKey(seed, messages.slice(0, last + 1));
}

/**
 * The key to remember once Claudio has answered: the request's messages plus the answer, which is
 * what the client's next request will carry up to its last assistant message.
 */
export function keyAfterAnswer(seed: KeySeed, messages: readonly ChatMessage[], answer: { text: string; toolCalls?: ToolCall[] }): string {
  return extendKey(chainKey(seed, messages), { role: 'assistant', text: answer.text, toolCalls: answer.toolCalls ?? [] });
}
