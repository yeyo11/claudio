import type { LimitWait } from '@claudio/shared';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { timeUntil } from '@claudio/ui/lib/format';
import { useProviderLabel } from '../lib/provider-status';
import { resetWhen } from '../lib/reset-when';

/**
 * The strip a waiting piece of work shows where a running one shows its command: warn tint and the
 * clock, in words, with nothing moving (waiting is not live work). `why` says what holds it.
 */
export function WaitLine({
  wait,
  why,
  children,
  action,
}: {
  wait: Pick<LimitWait, 'provider' | 'resetsAt'>;
  why?: ReactNode;
  children?: ReactNode;
  /** A quiet way out at the line's end, such as stopping the wait */
  action?: ReactNode;
}) {
  const { t } = useTranslation('components');
  const label = useProviderLabel();
  const name = label(wait.provider);
  return (
    <div className="wait-line" role="status">
      <Clock {...ICON_SM} aria-hidden />
      <span>
        <b>{t('limitWait.title', { name })}</b>
        {' · '}
        {wait.resetsAt ? (
          <>
            {t('limitWait.resumesAt')} <span className="tnum">{resetWhen(wait.resetsAt)}</span> ({timeUntil(Date.parse(wait.resetsAt) / 1000)})
          </>
        ) : (
          t('limitWait.unknown')
        )}
        {why && <span className="why">{why}</span>}
        {children}
      </span>
      {action}
    </div>
  );
}
