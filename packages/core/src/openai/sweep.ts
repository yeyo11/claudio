import type { ChatRuntime } from '../live-chat.ts';
import type { OpenAiConversationStore } from './conversations.ts';
import type { OpenAiResponseStore } from './responses-store.ts';

/**
 * How long a conversation key, and the `api` chat behind it, outlives its last answer. A client
 * that comes back within a week continues its chat; after that it starts a new one from the history
 * it resends (the cold prompt), so nothing is lost but the warm session.
 */
export const OPENAI_CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpenAiSweepDeps {
  conversations: Pick<OpenAiConversationStore, 'expire' | 'hasChat'>;
  /** Stored responses (`/v1/responses`): they expire on the same clock and keep their chat while they last */
  responses?: Pick<OpenAiResponseStore, 'expire' | 'hasChat'>;
  runtime: { list(): ChatRuntime[] };
  /** `ChatService.remove`: the transcript and Claudio's record go together */
  remove(chatId: string): Promise<void>;
}

export interface OpenAiSweep {
  /** Conversation keys dropped */
  keys: number;
  /** Stored responses dropped */
  responses: number;
  /** `api` chats deleted */
  chats: string[];
}

/**
 * Expires the conversation keys nobody answered under for `ttlMs` and the stored responses older
 * than that, then deletes the `api` chats left with neither. Only chats the OpenAI surface started go: a person's chat a client resumed by
 * `X-Claudio-Chat-Id` loses its keys and stays. A chat with a process, or one that changed inside
 * the period, is kept whatever its keys say, so a turn that is running is never pulled from under it.
 */
export async function sweepOpenAiChats(deps: OpenAiSweepDeps, now: number, ttlMs: number = OPENAI_CONVERSATION_TTL_MS): Promise<OpenAiSweep> {
  const cutoff = new Date(now - ttlMs).toISOString();
  const keys = deps.conversations.expire(cutoff);
  const responses = deps.responses?.expire(cutoff) ?? 0;
  const chats: string[] = [];
  for (const chat of deps.runtime.list()) {
    if (chat.origin !== 'api' || chat.pid !== null || chat.updatedAt > cutoff) continue;
    if (deps.conversations.hasChat(chat.id) || deps.responses?.hasChat(chat.id)) continue;
    try {
      await deps.remove(chat.id);
      chats.push(chat.id);
    } catch {
      // Something took the chat up since the list was read: the next sweep looks again
    }
  }
  return { keys, responses, chats };
}
