import type { DatabaseSync } from 'node:sqlite';

/** One conversation key and the chat that holds its history. */
export interface OpenAiConversation {
  hash: string;
  chatId: string;
  /** OpenAI's `user` of the request that last answered under this key */
  user: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  hash: string;
  chat_id: string;
  client_user: string | null;
  created_at: string;
  updated_at: string;
}

const conversationOf = (r: Row): OpenAiConversation => ({ hash: r.hash, chatId: r.chat_id, user: r.client_user, createdAt: r.created_at, updatedAt: r.updated_at });

/**
 * The `openai_conversations` rows (docs/openai-compatible-api.md): which chat a stateless client's
 * history belongs to, so its next request resumes it. Rows rather than a map in memory, so a restart
 * or a second process on the data dir still finds the chat.
 */
export class OpenAiConversationStore {
  constructor(
    private readonly sql: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  find(hash: string): OpenAiConversation | null {
    const row = this.sql.prepare('SELECT hash, chat_id, client_user, created_at, updated_at FROM openai_conversations WHERE hash = ?').get(hash) as Row | undefined;
    return row ? conversationOf(row) : null;
  }

  /**
   * One statement, so two requests answering under the same key at once leave one whole row: the
   * later writer's chat, the first writer's `created_at`.
   */
  remember(hash: string, chatId: string, user: string | null): void {
    const at = this.now();
    this.sql
      .prepare(
        `INSERT INTO openai_conversations (hash, chat_id, client_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (hash) DO UPDATE SET chat_id = excluded.chat_id, client_user = excluded.client_user, updated_at = excluded.updated_at`,
      )
      .run(hash, chatId, user, at, at);
  }

  /** Every key of a chat; `Db.deleteChat` does the same in its own transaction. */
  forgetChat(chatId: string): number {
    return Number(this.sql.prepare('DELETE FROM openai_conversations WHERE chat_id = ?').run(chatId).changes);
  }

  /** Drops the keys not answered under since `olderThan` (ISO); returns how many went. */
  expire(olderThan: string): number {
    return Number(this.sql.prepare('DELETE FROM openai_conversations WHERE updated_at < ?').run(olderThan).changes);
  }
}
