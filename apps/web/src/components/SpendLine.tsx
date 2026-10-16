import type { SpendState } from '@claudio/shared';
import { Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { formatCost } from '@claudio/ui/lib/format';
import { spendResetTime, spendView } from '../lib/spend-cap';
import { SPEND_CAP_SETTINGS_PATH } from './SpendCapDialog';

/**
 * Today against the daily cap, as one quiet line on the Usage page: the same bar and words as the
 * status bar, which a phone does not have. Nothing with no cap, and no figure when the reading is
 * missing: the caller passes what it read.
 */
export function SpendLineView({ state }: { state: SpendState }) {
  const { t } = useTranslation('usage');
  const view = spendView(state);
  if (!view || state.capUsd === null) return null;
  const time = spendResetTime(state);
  const word = view.exhausted ? t('cap.reached', { time }) : view.tone === 'warn' ? t('cap.near') : null;
  return (
    <div className={`usage-cap${view.tone === 'neutral' ? '' : ` is-${view.tone}`}`} role="note">
      <Gauge size={14} strokeWidth={1.75} aria-hidden />
      <span className="lead">{t('cap.label')}</span>
      <span className="sep" aria-hidden>
        ·
      </span>
      <span className="mono">{t('cap.figure', { spent: formatCost(state.spentUsd), cap: formatCost(state.capUsd) })}</span>
      <span className="meter-track meter-thin usage-cap-meter" aria-hidden>
        <span className={`meter-fill ${view.tone === 'neutral' ? '' : `is-${view.tone}`}`.trim()} style={{ width: `${view.fill}%` }} />
      </span>
      <span className="mono usage-cap-pct">{t('cap.percent', { value: view.percent })}</span>
      {word && <span className="usage-cap-word">{word}</span>}
      {view.overUsd > 0 && <span className="usage-cap-sub">{t('cap.over', { amount: formatCost(view.overUsd) })}</span>}
      {state.unreported > 0 && <span className="usage-cap-sub">{t('cap.unreported', { count: state.unreported })}</span>}
      <Link to={SPEND_CAP_SETTINGS_PATH}>{t('cap.change')}</Link>
      <span className="usage-cap-note">{t('cap.note')}</span>
    </div>
  );
}
