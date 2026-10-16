import type { SpendState } from '@claudio/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Dialog } from '@claudio/ui/components/Dialog';
import { Sheet } from '@claudio/ui/components/controls';
import { formatCost } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { setSpendCapAsk, spendView } from '../lib/spend-cap';

/** Where the daily cap is set: Settings, with the other runtime settings. */
export const SPEND_CAP_SETTINGS_PATH = '/settings?tab=security';

/**
 * The question a person is asked when the day's spend reached the cap: go on anyway, or not. A
 * dialog on a desktop and a sheet up from the bottom on a phone, with the one primary of the zone
 * on the way through. `confirmLabel` words the way through for what it starts ("Send anyway" on a
 * chat, "Go on today anyway" on a graph).
 */
export function SpendCapDialog({
  spend,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  spend: SpendState;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('components');
  const narrow = useMediaQuery(NARROW);
  const view = spendView(spend);
  const amounts = (
    <p className="spend-dialog-amounts" data-testid="spend-cap-amounts">
      {t('spendCap.amounts', { spent: formatCost(spend.spentUsd), cap: formatCost(spend.capUsd ?? 0) })}
    </p>
  );
  const body: ReactNode = (
    <div className="spend-dialog">
      {amounts}
      <p className="muted">{t('spendCap.body')}</p>
      {view && view.overUsd > 0 && <p className="muted small">{t('spendCap.over', { amount: formatCost(view.overUsd) })}</p>}
      <p className="small">
        <Link to={SPEND_CAP_SETTINGS_PATH} className="spend-dialog-link" onClick={onCancel}>
          {t('spendCap.change')}
        </Link>
      </p>
    </div>
  );
  const actions = (
    <>
      <button type="button" className="btn" onClick={onCancel}>
        {t('spendCap.cancel')}
      </button>
      <button type="button" className="btn btn-primary" data-autofocus disabled={busy} onClick={onConfirm}>
        {confirmLabel ?? t('spendCap.send')}
      </button>
    </>
  );
  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onCancel()} side="bottom" title={t('spendCap.title')} footer={<div className="spend-dialog-foot is-sheet">{actions}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={t('spendCap.title')} onClose={onCancel} width={460} footer={actions}>
      {body}
    </Dialog>
  );
}

/**
 * Hosts the question for every request the cap refuses (`lib/spend-cap.ts`): a chat's send, a new
 * chat, a plan, a launch and the actions of a graph all reach it through `request`, which sends the
 * same call again with the override when the answer is yes. Two refusals at once share one question.
 */
export function SpendCapProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<SpendState | null>(null);
  const waiting = useRef<Array<(ok: boolean) => void>>([]);

  useEffect(
    () =>
      setSpendCapAsk(
        (spend) =>
          new Promise<boolean>((resolve) => {
            waiting.current.push(resolve);
            setPending(spend);
          }),
      ),
    [],
  );

  const settle = (ok: boolean) => {
    const resolvers = waiting.current;
    waiting.current = [];
    setPending(null);
    for (const resolve of resolvers) resolve(ok);
  };

  return (
    <>
      {children}
      {pending && <SpendCapDialog spend={pending} onConfirm={() => settle(true)} onCancel={() => settle(false)} />}
    </>
  );
}
