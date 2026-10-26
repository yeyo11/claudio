import type { DatabaseSync } from 'node:sqlite';
import type { InputItem, ResponseObject } from './responses-wire.ts';

/** One stored response of `POST /v1/responses`: what `previous_response_id` and `GET /v1/responses/:id` find. */
export interface StoredResponse {
  id: string;
  chatId: string;
  /** The conversation key after this response: a `previous_response_id` turn extends it */
  conversationKey: string;
  /** The response object as it was served */
  response: ResponseObject;
  /** The request's input, as `GET /v1/responses/:id/input_items` lists it */
  inputItems: InputItem[];
  createdAt: string;
}

interface Row {
  id: string;
  chat_id: string;
  conversation_key: string;
  response: string;
  input_items: string;
  created_at: string;
}

const storedOf = (r: Row): StoredResponse => ({
  id: r.id,
  chatId: r.chat_id,
  conversationKey: r.conversation_key,
  response: JSON.parse(r.response) as ResponseObject,
  inputItems: JSON.parse(r.input_items) as InputItem[],
  createdAt: r.created_at,
});

/**
 * The `openai_responses` rows (docs/openai-compatible-api.md, phase 5): one per response a client
 * asked to keep (`store`, true by default), written once and never changed. Rows rather than a file,
 * like the conversation keys: they accumulate, two processes on one data dir both answer requests,
 * and a restart must still continue a chain. A response with `store: false` writes nothing, so it can
 * be neither retrieved nor continued, which is what the reference promises such a client.
 */
export class OpenAiResponseStore {
  constructor(
    private readonly sql: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  save(entry: Omit<StoredResponse, 'createdAt'>): void {
    this.sql
      .prepare('INSERT INTO openai_responses (id, chat_id, conversation_key, response, input_items, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.chatId, entry.conversationKey, JSON.stringify(entry.response), JSON.stringify(entry.inputItems), this.now());
  }

  find(id: string): StoredResponse | null {
    const row = this.sql.prepare('SELECT id, chat_id, conversation_key, response, input_items, created_at FROM openai_responses WHERE id = ?').get(id) as Row | undefined;
    return row ? storedOf(row) : null;
  }

  /** `DELETE /v1/responses/:id`: the row goes, the chat stays. */
  delete(id: string): boolean {
    return Number(this.sql.prepare('DELETE FROM openai_responses WHERE id = ?').run(id).changes) > 0;
  }

  /** Every response of a chat; `Db.deleteChat` does the same in its own transaction. */
  forgetChat(chatId: string): number {
    return Number(this.sql.prepare('DELETE FROM openai_responses WHERE chat_id = ?').run(chatId).changes);
  }

  /** Whether a stored response still leads to the chat: the sweep keeps such an `api` chat. */
  hasChat(chatId: string): boolean {
    return this.sql.prepare('SELECT 1 FROM openai_responses WHERE chat_id = ? LIMIT 1').get(chatId) !== undefined;
  }

  /** Drops the responses created before `olderThan` (ISO); returns how many went. */
  expire(olderThan: string): number {
    return Number(this.sql.prepare('DELETE FROM openai_responses WHERE created_at < ?').run(olderThan).changes);
  }
}
