import type { DecisionActivationIssue } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox } from '@claudio/ui/components/ui';
import { formatList } from '@claudio/ui/lib/format';
import type { TFunction } from 'i18next';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../../../api';
import { gateMissing } from './gate';
import { bestReading } from './model';
import { pointName } from './Points';

/**
 * A save the promotion gate refused (409): the points it names and what each lacks, where the person
 * acted. Nothing was written and the form keeps what they had, so the line says so. Any other failure
 * keeps the ordinary error box.
 */
export function SaveError({ error, title }: { error: unknown; title?: string }) {
  const { t } = useTranslation('decisions');
  if (!(error instanceof ApiRequestError) || !error.refused) return <ErrorBox error={error} {...(title ? { title } : {})} />;
  const bulk = error.code === 'decision-bulk-activation';
  return (
    <div className="alert alert-warn" role="alert" data-testid="activation-refusal">
      <TriangleAlert {...ICON_SM} className="alert-icon" />
      <div className="alert-body">
        <strong>{bulk ? t('refusal.bulkTitle') : t('refusal.title', { count: error.refused.length })}</strong>
        {bulk && <div>{t('refusal.bulkBody')}</div>}
        {error.refused.map((issue) => (
          <div key={issue.point} data-point={issue.point}>
            {t('refusal.point', { point: pointName(t, issue.point), missing: gateMissing(t, issue.gate, bestReading(issue.live, issue.replay)) })}
          </div>
        ))}
        <div>{t('refusal.kept')}</div>
      </div>
    </div>
  );
}

/**
 * What a successful save says: the plain confirmation, or the same title with the suggest points that
 * went Active without proof named in the detail. One toast either way, so the warning is said once.
 */
export function savedNotice(t: TFunction<'decisions'>, warnings: readonly DecisionActivationIssue[]): { tone: 'ok' | 'warn'; title: string; detail?: string } {
  if (warnings.length === 0) return { tone: 'ok', title: t('engine.saved') };
  return { tone: 'warn', title: t('engine.saved'), detail: t('warnings.unproven', { points: formatList(warnings.map((issue) => pointName(t, issue.point))) }) };
}
