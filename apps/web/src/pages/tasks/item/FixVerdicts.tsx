import type { FlowCheckVerdict } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { Tag } from '@claudio/ui/components/ui';

/**
 * What the Developer decided about each failing check of the newest fix, under the fix panel: fixed
 * with where it changed things, stopped (warn, with the reason in words), or left as it was. The
 * locations are text, as the Developer wrote them: Claudio never links them to an editor.
 */
export function FixVerdicts({ verdicts }: { verdicts: readonly FlowCheckVerdict[] }) {
  const { t } = useTranslation('checks');
  if (verdicts.length === 0) return null;
  return (
    <ul className="fix-verdicts" aria-label={t('fix.verdictsLabel')}>
      {verdicts.map((verdict) => (
        <li key={verdict.name} className="fix-verdict">
          <span className="name">{verdict.name}</span>
          {verdict.stopped ? (
            <>
              <Tag tone="warn">{t('fix.verdict.stopped')}</Tag>
              <span className="fix-verdict-why">{t(`fix.verdict.stop.${verdict.stopped}`)}</span>
            </>
          ) : verdict.fixed ? (
            <Tag tone="ok">{t('fix.verdict.fixed')}</Tag>
          ) : (
            <Tag>{t('fix.verdict.unchanged')}</Tag>
          )}
          {verdict.locations && verdict.locations.length > 0 && (
            <ul className="fix-verdict-locations">
              {verdict.locations.map((location) => (
                <li key={location}>
                  <code className="mono">{location}</code>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
