import type { SharedProject } from '@claudio/shared';
import { CircleCheck, Moon, Pause, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@claudio/ui/components/controls';
import { timeAgo } from '@claudio/ui/lib/format';
import { worstSync, type CollabTone, type SyncSummaryKind } from '../collaborators/model';

// Pending is a still icon, not a spinner: a loop means an agent is working, and a sync is not one
const ICON: Record<SyncSummaryKind, LucideIcon> = {
  synced: CircleCheck,
  pending: RefreshCw,
  offline: Moon,
  paused: Pause,
  error: TriangleAlert,
};

const TONE: Record<SyncSummaryKind, CollabTone> = { synced: 'ok', pending: 'muted', offline: 'idle', paused: 'warn', error: 'bad' };

/**
 * The Shared tab's icon: the worst state among this project's shared copies, so the tab says
 * "paused" or "failed" without being opened. The words are in the tooltip and the label, because a
 * colour alone says nothing (docs/plans/owner-report-fixes.md, D5).
 */
export function SyncTabIcon({ projects }: { projects: readonly SharedProject[] }) {
  const { t } = useTranslation('collaborators');
  const worst = worstSync(projects.map((p) => p.sync));
  if (!worst) return null;
  const label = worst.kind === 'synced' && worst.ago ? t('shared.tabSync.syncedAgo', { ago: timeAgo(worst.ago) }) : t(`shared.tabSync.${worst.kind}`);
  const Icon = ICON[worst.kind];
  return (
    <Tooltip content={label}>
      <span className={`collab-tone tone-${TONE[worst.kind]} tab-sync`} role="img" aria-label={label} data-sync={worst.kind}>
        <Icon size={14} strokeWidth={1.75} aria-hidden />
      </span>
    </Tooltip>
  );
}
