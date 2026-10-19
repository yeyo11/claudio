import type { ChatSummary } from '@claudio/shared';
import { lastEnded, STATE_LABEL } from '@claudio/chat-ui/lib/chat-model';
import { chatBusy } from '@claudio/chat-ui/lib/liveness';
import i18n from '../i18n';

/** How the last execution ended, when an idle chat's last run went wrong. */
export function badOutcome(chat: ChatSummary) {
  const ended = chat.state === 'idle' && !chat.alive ? lastEnded(chat) : null;
  return ended?.outcome && ended.outcome !== 'completed' ? ended.outcome : null;
}

/**
 * The chat's state as a word and the status colour it takes: working is live, waiting is idle, a bad
 * outcome is bad. A chat at rest says nothing (`null`), and each caller decides how to say it to a
 * screen reader.
 */
export function chatStateWord(chat: ChatSummary): { word: string; tone: 'live' | 'idle' | 'bad' } | null {
  if (chatBusy(chat)) return { word: STATE_LABEL.working, tone: 'live' };
  if (chat.state === 'waiting') return { word: STATE_LABEL.waiting, tone: 'idle' };
  const bad = badOutcome(chat);
  if (bad) return { word: i18n.t(`chats:list.outcome.${bad}`), tone: 'bad' };
  return null;
}
