import type { TranscriptEntry } from '@claudio/shared';
import type { TFunction } from 'i18next';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { formatClock, formatDateTime, formatDuration } from '@claudio/ui/lib/format';
import { formatTokens } from '../lib/chat-model';

/**
 * What the page does with a summary: the app keeps the note, this package only offers the button.
 * `noted` holds the uuids of summaries that are already a note, whose button is then left out.
 */
export interface CompactionActions {
  saveAsNote?: (summary: TranscriptEntry) => void;
  noted?: ReadonlySet<string>;
}

/** The line a person reads, and the separator's accessible name: one sentence, said whole. */
export function compactionLabel(entry: TranscriptEntry, t: TFunction<'chat'>): string {
  const c = entry.compaction;
  const parts = [t('transcript.compaction.label')];
  if (c?.trigger) parts.push(t(c.trigger === 'auto' ? 'transcript.compaction.auto' : 'transcript.compaction.manual'));
  if (c?.preTokens != null) {
    const pre = formatTokens(c.preTokens);
    parts.push(c.postTokens != null ? t('transcript.compaction.tokens', { pre, post: formatTokens(c.postTokens) }) : t('transcript.compaction.tokensBefore', { pre }));
  }
  if (entry.timestamp) parts.push(formatClock(entry.timestamp));
  return parts.join(' · ');
}

/**
 * A compaction in the transcript: a hairline with a centred small label, and under it the summary
 * Claude continued from, behind a fold. It is not a message — no avatar, no menu, no copy — and it
 * is not a status either, so it takes no colour and does not move.
 */
export function CompactionDivider({
  boundary,
  summary,
  summaryBody,
  actions,
  focused = false,
}: {
  boundary: TranscriptEntry | null;
  summary: TranscriptEntry | null;
  /** The summary, drawn by the transcript with its Markdown */
  summaryBody: ReactNode;
  actions?: CompactionActions;
  /** A search hit is inside the summary: the fold opens on it */
  focused?: boolean;
}) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(focused);
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const label = boundary ? compactionLabel(boundary, t) : '';
  const took = boundary?.compaction?.durationMs;
  const canSave = Boolean(summary && actions?.saveAsNote && !actions.noted?.has(summary.uuid));
  return (
    <div className="compaction" data-entry-id={boundary?.uuid ?? summary?.uuid}>
      {boundary && (
        <div className="compaction-divider" role="separator" aria-label={label} title={took ? t('transcript.compaction.tookLong', { duration: formatDuration(took) }) : boundary.timestamp ? formatDateTime(boundary.timestamp) : undefined}>
          <span className="compaction-label">{label}</span>
        </div>
      )}
      {summary && (
        <Collapsible className="fold compaction-fold" open={open} onOpenChange={setOpen} title={<span className="compaction-fold-title">{t(boundary ? 'transcript.compaction.summary' : 'transcript.compaction.summaryAlone')}</span>}>
          <div className="compaction-summary" data-entry-id={summary.uuid}>
            {summaryBody}
          </div>
          {canSave && (
            <button type="button" className="btn btn-small" onClick={() => actions?.saveAsNote?.(summary)}>
              {t('transcript.compaction.saveAsNote')}
            </button>
          )}
        </Collapsible>
      )}
    </div>
  );
}
