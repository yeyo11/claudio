/**
 * The card over the composer of the messages the agent has not read yet (docs/chat-delivery.md,
 * docs/design-system.md "Queued messages over the composer"). A person's message can be hurried or
 * taken back; a notice Claudio or its Supervisor wrote can only be dismissed. When the turn is inside
 * a foreground call (a subagent it waits on, a command), "Send now" would end that work with the
 * turn, so the card offers to send the call to the background instead, and says what an interrupt ends.
 */
import { Hourglass, Info, TriangleAlert, Undo2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { ChatPendingBlocker } from '@claudio/shared';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON_SM } from '@claudio/ui/components/icons';
import { isNotice, type QueuedMessage } from './queued';

export interface QueuedCardsProps {
  queued: readonly QueuedMessage[];
  /** The agent's name, as the page calls it ("Claude Code") */
  agent: string;
  /** "Send now": the turn ends so the agent reads what waits, for the oldest message still waiting */
  onSendNow: (messageId: string) => void;
  /** The foreground call the turn waits on goes to the background, and the agent reads what waits */
  onBackground: (toolUseId: string) => void;
  /** A person's waiting message is withdrawn and its words and files go back in the box */
  onWithdraw: (message: QueuedMessage) => void;
  /** A notice is withdrawn before the agent reads it, or put away once it was lost */
  onDismiss: (message: QueuedMessage) => void;
  /** A person's lost message: its words and files go back in the box */
  onRestore: (message: QueuedMessage) => void;
  /** What is on its way, so a button is not pressed twice */
  sending?: boolean;
  backgrounding?: boolean;
}

/** The work a blocked message waits for, as the foot names it: an agent's description, or the command */
function blockerText(t: TFunction<'chat'>, blocker: ChatPendingBlocker): string {
  const what = blocker.description ?? blocker.name;
  return blocker.name === 'Bash' ? t('view.queued.blockedCommand', { what }) : t('view.queued.blockedAgent', { what });
}

export function QueuedCards({ queued, agent, onSendNow, onBackground, onWithdraw, onDismiss, onRestore, sending = false, backgrounding = false }: QueuedCardsProps) {
  const { t } = useTranslation('chat');
  if (queued.length === 0) return null;
  const people = queued.filter((message) => !isNotice(message));
  // Only a person's message is theirs to hurry: a notice waits for the agent's next step
  const waiting = people.find((message) => message.state === 'waiting');
  const blocker = waiting?.blockedBy;
  const lost = people.some((message) => message.state === 'lost');
  const foot = lost
    ? t('view.queued.undelivered', { agent })
    : blocker
      ? blockerText(t, blocker)
      : waiting
        ? t('view.queued.hint', { count: people.length })
        : people.length > 0
          ? t('view.queued.held', { count: people.length, agent })
          : t('view.queued.noticeHint', { agent });
  return (
    <div className={`chat-queued ${queued.every((message) => message.state === 'lost') ? 'is-lost' : ''}`.trimEnd()} role="status" aria-label={t('view.queued.title')}>
      <ul className="chat-queued-list">
        {queued.map((message) => {
          const notice = isNotice(message);
          return (
            <li key={message.id} className={`chat-queued-item ${message.state === 'lost' ? 'is-lost' : ''} ${notice ? 'is-notice' : ''}`.replace(/\s+/g, ' ').trim()}>
              {message.state === 'lost' ? <TriangleAlert {...ICON_SM} aria-hidden /> : notice ? <Info {...ICON_SM} aria-hidden /> : <Hourglass {...ICON_SM} aria-hidden />}
              <span className="chat-queued-text">
                {notice && <span className="chat-queued-from">{message.source === 'supervisor' ? t('view.queued.fromSupervisor') : t('view.queued.fromClaudio')} </span>}
                {message.text || t('view.queued.files', { count: message.attachments.length })}
              </span>
              {notice ? (
                <Tooltip content={t('view.queued.dismissHint', { agent })}>
                  <button type="button" className="icon-btn" aria-label={t('view.queued.dismiss')} onClick={() => onDismiss(message)}>
                    <X {...ICON_SM} />
                  </button>
                </Tooltip>
              ) : message.state === 'lost' ? (
                <Tooltip content={t('view.queued.restore')}>
                  <button type="button" className="icon-btn" aria-label={t('view.queued.restore')} onClick={() => onRestore(message)}>
                    <Undo2 {...ICON_SM} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content={t('view.queued.withdrawHint', { agent })}>
                  <button type="button" className="icon-btn" aria-label={t('view.queued.withdraw')} onClick={() => onWithdraw(message)}>
                    <Undo2 {...ICON_SM} />
                  </button>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
      <div className="chat-queued-foot">
        <span className="small muted">{foot}</span>
        {waiting && blocker && (
          <span className="chat-queued-actions">
            <Tooltip content={t('view.queued.backgroundHint', { agent })}>
              <button type="button" className="btn btn-small" onClick={() => onBackground(blocker.toolUseId)} disabled={backgrounding || sending}>
                {backgrounding ? t('view.queued.backgrounding') : t('view.queued.background')}
              </button>
            </Tooltip>
            <button type="button" className="btn btn-small" onClick={() => onSendNow(waiting.id)} disabled={sending || backgrounding}>
              {sending ? t('view.queued.sending') : t('view.queued.interrupt')}
            </button>
          </span>
        )}
        {waiting && !blocker && (
          <Tooltip content={t('view.queued.sendNowHint', { agent })}>
            <button type="button" className="btn btn-small" onClick={() => onSendNow(waiting.id)} disabled={sending}>
              {sending ? t('view.queued.sending') : t('view.queued.sendNow')}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
