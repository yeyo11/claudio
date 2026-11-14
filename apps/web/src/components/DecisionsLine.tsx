import type { DecisionStats } from '@claudio/shared';
import type { TFunction } from 'i18next';
import { Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { formatCost, formatNumber } from '@claudio/ui/lib/format';
import { settingsHref } from '../pages/config/settingsGroups';

/** The net in words, with what it is made of: runs saved are not worth reporting without the runs the same decisions caused. */
function netWords(t: TFunction<'usage'>, data: Pick<DecisionStats, 'runsSaved' | 'runsCaused' | 'netRuns'>): string {
  // Each count agrees with its own noun ("1 ahorrada", "10 ahorradas"), so the detail is built from two inflected parts
  const detail = t('decisions.detail', {
    saved: t('decisions.savedCount', { count: data.runsSaved, formatted: formatNumber(data.runsSaved) }),
    caused: t('decisions.causedCount', { count: data.runsCaused, formatted: formatNumber(data.runsCaused) }),
  });
  if (data.netRuns > 0) return t('decisions.netSaved', { count: data.netRuns, formatted: formatNumber(data.netRuns), detail });
  if (data.netRuns < 0) return t('decisions.netCaused', { count: -data.netRuns, formatted: formatNumber(-data.netRuns), detail });
  return t('decisions.netZero', { detail });
}

/** Nothing when no decision was recorded in the window. */
export function DecisionsLineView({ stats: data }: { stats: DecisionStats }) {
  const { t } = useTranslation('usage');
  if (data.points.reduce((sum, row) => sum + row.count, 0) === 0) return null;
  return (
    <div className="usage-decisions" role="note">
      <Workflow size={14} strokeWidth={1.75} aria-hidden />
      <span className="lead">{t('decisions.label')}</span>
      {/* Each dot opens the piece it belongs to, so a wrapped line never ends on one */}
      <span className="fact">
        <span className="sep" aria-hidden>
          ·
        </span>
        <span>{t('decisions.jev', { cost: formatCost(data.jevCostUsd) })}</span>
      </span>
      <span className="fact tnum">
        <span className="sep" aria-hidden>
          ·
        </span>
        <span>{netWords(t, data)}</span>
      </span>
      <Link to={settingsHref('decisions', { detail: 'history' })}>{t('decisions.history')}</Link>
    </div>
  );
}
