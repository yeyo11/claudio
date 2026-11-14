import type { DecisionActivationIssue, DecisionPointId } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox } from '@claudio/ui/components/ui';
import { formatList } from '@claudio/ui/lib/format';
import type { TFunction } from 'i18next';
import { TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../../../api';
import { gateMissing } from './gate';
import { bestReading } from './model';
import { pointName } from './Points';

/**
 * Whether a failed save still describes the form: a refusal does while at least one refused point is
 * where the form put it when it was sent. Any other failure always does.
 */
export function stillAsked(error: unknown, asked: Partial<Record<DecisionPointId, string>>, current: (id: DecisionPointId) => string): boolean {
  const refused = error instanceof ApiRequestError ? error.refused : undefined;
  return !refused || refused.some((issue) => current(issue.point) === asked[issue.point]);
}

/**
 * What the last save failed with, and for how long it still applies. A refusal names points and the
 * modes the form asked for; it stops applying once the person's draft no longer asks for any of them
 * (they set those points back), because the note would then describe a form that is gone. A save that
 * starts or succeeds clears it, and the close button does too.
 */
export function useSaveFailure(current: (id: DecisionPointId) => string) {
  const [held, setHeld] = useState<{ error: unknown; asked: Partial<Record<DecisionPointId, string>> } | null>(null);
  const hold = (error: unknown, asked: (id: DecisionPointId) => string) => {
    const refused = error instanceof ApiRequestError ? error.refused : undefined;
    setHeld({ error, asked: refused ? Object.fromEntries(refused.map((issue) => [issue.point, asked(issue.point)])) : {} });
  };
  const clear = () => setHeld(null);
  const live = held && stillAsked(held.error, held.asked, current);
  return { error: live ? held.error : null, hold, clear };
}

/**
 * A failed save, in the flow at the head of what it concerns, never over a row. A refusal by the
 * promotion gate (409) names the points and what each lacks; nothing was written and the form keeps
 * what they had, so it says so. It takes focus and scrolls into view when it appears, so a keyboard or
 * a screen reader lands on it, and it closes. Any other failure keeps the ordinary error box. A
 * project's card passes the points that are Active globally: the server counts dropping a Shadow
 * override on one of them as an activation, which the note says.
 */
export function SaveError({
  error,
  title,
  inheritedActive,
  onClose,
  id,
}: {
  error: unknown;
  title?: string;
  inheritedActive?: ReadonlySet<DecisionPointId>;
  onClose?: () => void;
  id?: string;
}) {
  const { t } = useTranslation('decisions');
  const ref = useRef<HTMLDivElement>(null);
  const refused = error instanceof ApiRequestError ? error.refused : undefined;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // The note is where the person looks next: a save is asked for at the foot of a long page
    node.scrollIntoView({ block: 'start' });
    node.focus({ preventScroll: true });
  }, [error]);
  if (!(error instanceof ApiRequestError) || !refused) return <ErrorBox error={error} {...(title ? { title } : {})} />;
  const bulk = error.code === 'decision-bulk-activation';
  return (
    <div ref={ref} id={id} tabIndex={-1} className="alert alert-warn dp-refusal" role="alert" data-testid="activation-refusal">
      <TriangleAlert {...ICON_SM} className="alert-icon" />
      <div className="alert-body">
        <strong>{bulk ? t('refusal.bulkTitle') : t('refusal.title', { count: refused.length })}</strong>
        {bulk && <div>{t('refusal.bulkBody')}</div>}
        {refused.map((issue) => (
          <div key={issue.point} data-point={issue.point}>
            {t(inheritedActive?.has(issue.point) ? 'refusal.inherited' : 'refusal.point', { point: pointName(t, issue.point), missing: gateMissing(t, issue.gate, bestReading(issue.live, issue.replay)) })}
          </div>
        ))}
        <div>{t('refusal.kept')}</div>
      </div>
      {onClose && (
        <button type="button" className="icon-btn dp-refusal-close" aria-label={t('refusal.close')} onClick={onClose}>
          <X {...ICON_SM} />
        </button>
      )}
    </div>
  );
}

/**
 * The save bar's one line about it: the note is above, where the points are, and the bar only points
 * to it. A button, so a keyboard reaches the note too.
 */
export function SaveFailureLink({ target }: { target: string }) {
  const { t } = useTranslation('decisions');
  return (
    <button
      type="button"
      className="link-btn dp-foot-note"
      onClick={() => {
        const node = document.getElementById(target);
        node?.scrollIntoView({ block: 'start' });
        node?.focus({ preventScroll: true });
      }}
    >
      {t('refusal.barNote')}
    </button>
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
