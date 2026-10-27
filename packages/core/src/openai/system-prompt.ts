import type { DatabaseSync } from 'node:sqlite';
import { systemPromptOf } from './request.ts';
import type { ChatMessage } from './wire.ts';

/**
 * An API chat's system prompt in its two parts (docs/openai-compatible-api.md, "The system prompt").
 * They follow different rules in OpenAI's own API, so they are kept apart: the CLI only ever sees
 * them joined, as `--append-system-prompt`.
 */
export interface SystemPromptParts {
  /**
   * Responses' `instructions`: they apply to the response they are sent with and are not carried
   * over to the next one, so each request replaces them, or clears them by leaving them out
   */
  instructions: string;
  /**
   * The conversation's system and developer messages. Under `previous_response_id` earlier input
   * messages stay in context, these included, so they accumulate along the chain
   */
  conversation: string;
}

/**
 * What a request's conversation part builds on:
 * - `whole`: the request is the whole history (a new chat, or one found by its conversation key,
 *   whose key already holds the same system messages), so its own system messages are the part;
 * - `chain`: `previous_response_id`, the stored part of that response, which the new items extend;
 * - `named`: `X-Claudio-Chat-Id` without `previous_response_id`, where the body may be only the new
 *   messages: the request's system messages replace the chat's part when it carries any, and the
 *   chat keeps its own when it carries none.
 */
export type ConversationBase = { kind: 'whole' } | { kind: 'chain'; conversation: string } | { kind: 'named'; conversation: string };

const join = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');

/** Whether the messages carry any system or developer message, an empty one included (it clears the part). */
export function hasSystemMessages(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'system' || m.role === 'developer');
}

/** The parts a request asks its chat to run with. */
export function systemPromptParts(messages: readonly ChatMessage[], instructions: string | null, base: ConversationBase): SystemPromptParts {
  const own = systemPromptOf(messages) ?? '';
  const conversation = base.kind === 'chain' ? join(base.conversation, own) : base.kind === 'named' && !hasSystemMessages(messages) ? base.conversation : own;
  return { instructions: instructions?.trim() ?? '', conversation };
}

/** The prompt the CLI runs with: the instructions first, then the conversation's messages. */
export function effectiveSystemPrompt(parts: SystemPromptParts): string {
  return join(parts.instructions, parts.conversation);
}

/**
 * The `openai_chat_prompts` rows: the parts an API chat's client last asked for, which its next
 * process starts with. Not always what the live process runs: a turn that had to keep the old prompt
 * (a held turn) saves them all the same, so the next turn that can restart applies them; what the
 * process runs is its joined prompt (`ChatManager.systemPromptOf`). A row per chat rather than an
 * option of the live chat, because a request that names the chat and carries no system message must
 * keep the chat's part after a server restart too, when no process is left to ask.
 */
export class OpenAiChatPromptStore {
  constructor(
    private readonly sql: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  find(chatId: string): SystemPromptParts | null {
    const row = this.sql.prepare('SELECT instructions, conversation FROM openai_chat_prompts WHERE chat_id = ?').get(chatId) as { instructions: string; conversation: string } | undefined;
    return row ? { instructions: row.instructions, conversation: row.conversation } : null;
  }

  save(chatId: string, parts: SystemPromptParts): void {
    this.sql
      .prepare(
        `INSERT INTO openai_chat_prompts (chat_id, instructions, conversation, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET instructions = excluded.instructions, conversation = excluded.conversation, updated_at = excluded.updated_at`,
      )
      .run(chatId, parts.instructions, parts.conversation, this.now());
  }

  // A chat's row goes with the chat in `Db.deleteChat`, inside its transaction
}
