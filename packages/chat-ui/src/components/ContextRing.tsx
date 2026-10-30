import type { ChatSummary } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { ProgressRing, usageTone } from '@claudio/ui/components/motion';
import { formatNumber } from '@claudio/ui/lib/format';
import { contextLevel, contextShare } from '../lib/chat-model';

/**
 * How full a chat's context window is, as a small ring with the figure inside: neutral until it
 * nears the point the CLI compacts, then amber and red as `ContextMeter` turns. The share is the one
 * every other context figure reads (`contextShare`, which counts a compaction's own figure); nothing
 * is drawn while the model's window is unknown. Its accessible name says what the figure is.
 */
export function ContextRing({ chat, size = 34, stroke = 3, className }: { chat: Pick<ChatSummary, 'context'>; size?: number; stroke?: number; className?: string }) {
  const { t } = useTranslation('chat');
  const { context } = chat;
  const share = contextShare(chat);
  if (!context || share === null) return null;
  const percent = Math.round(Math.min(1, Math.max(0, share)) * 100);
  const level = contextLevel(share);
  const detail = t('badges.context.detail', { used: formatNumber(context.used), window: context.window === null ? '?' : formatNumber(context.window) });
  const note = level === 'full' ? t('badges.context.aboutToCompact') : level === 'warn' ? t('badges.context.fillingUp') : '';
  return (
    <span
      className={className}
      role="meter"
      aria-label={t('badges.context.inUse')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={note ? `${detail}, ${note}` : detail}
    >
      <ProgressRing value={percent / 100} size={size} stroke={stroke} tone={usageTone(percent)}>
        {/* The figure alone fits the ring; the name above says it is a percentage */}
        <span aria-hidden>{formatNumber(percent)}</span>
      </ProgressRing>
    </span>
  );
}
