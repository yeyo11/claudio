import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { LimitWait } from '@claudio/shared';
import { ArrowRight, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { timeUntil } from '@claudio/ui/lib/format';
import { api } from '../api';
import { useProviderLabel } from '../lib/provider-status';
import { resetWhen } from '../lib/reset-when';

/** What a wait line needs of a wait: the server's `LimitWait`, or a move row read as one. */
export type WaitView = Pick<LimitWait, 'provider' | 'resetsAt'> & Partial<Pick<LimitWait, 'nextLookAt' | 'state'>>;

/**
 * When the work goes on, in the words every wait uses: the reset when it is known, "going on now"
 * while the turn is being sent, and, when nobody has said when the limit resets, the hour of the
 * next look (a `get_usage` probe), since that is the only time there is to tell. Warn and still:
 * nothing here is live work, a probe included, because the server does not say when one is in flight.
 */
export function WaitWhen({ wait }: { wait: WaitView }) {
  const { t } = useTranslation('components');
  if (wait.state === 'resuming') return <>{t('limitWait.resuming')}</>;
  if (wait.resetsAt)
    return (
      <>
        {t('limitWait.resumesAt')} <span className="tnum">{resetWhen(wait.resetsAt)}</span> ({timeUntil(Math.ceil(Date.parse(wait.resetsAt) / 60_000) * 60).replace(/ /g, '\u00a0')})
      </>
    );
  return (
    <>
      {t('limitWait.unknown')}
      {wait.nextLookAt && (
        <>
          {' · '}
          {t('limitWait.lookAgain')} <span className="tnum">{resetWhen(wait.nextLookAt)}</span>
        </>
      )}
    </>
  );
}

/**
 * The strip a waiting piece of work shows where a running one shows its command: warn tint and the
 * clock, in words, with nothing moving (waiting is not live work). One component for every place a
 * wait for a usage limit is shown: a chat's banner, a task, a graph, a flow run, a review.
 * `why` says what holds it, `account` which account's limit it is, and `actions` is `WaitActions`.
 */
export function WaitLine({
  wait,
  why,
  account,
  children,
  action,
  actions,
  banner,
}: {
  wait: WaitView;
  why?: ReactNode;
  /** The account whose limit holds it, when the page knows which */
  account?: string | null;
  children?: ReactNode;
  /** A quiet way out at the line's end, such as stopping the wait */
  action?: ReactNode;
  /** The person's actions on the wait, at the line's end */
  actions?: ReactNode;
  /** The chat's banner: roomier, and its actions drop under the words on a phone */
  banner?: boolean;
}) {
  const { t } = useTranslation('components');
  const label = useProviderLabel();
  const name = label(wait.provider);
  const at = action ?? (actions ? <span className="wait-line-go">{actions}</span> : null);
  return (
    <div className={banner ? 'wait-line is-banner' : 'wait-line'}>
      <Clock {...ICON_SM} aria-hidden />
      {/* Only the words are announced: the countdown and the buttons are not news */}
      <span className="wait-line-text" role="status">
        <b>{t('limitWait.title', { name })}</b>
        {' · '}
        <WaitWhen wait={wait} />
        {account && ` · ${t('limitWait.account', { account })}`}
        {why && <span className="why">{why}</span>}
        {children}
      </span>
      {at}
    </div>
  );
}

/**
 * The two ways out of a wait that already exist: stop waiting (a chat stays as it is, a task or a
 * run ends stopped) and run it now on an account with room. Both refetch what the page reads, and
 * every list of waits (`providers/waits`); a refusal says why in a toast.
 */
export function WaitActions({ moveId, invalidate = [], quiet = 'btn-quiet' }: { moveId: string; invalidate?: readonly QueryKey[]; quiet?: string }) {
  const { t } = useTranslation('components');
  const queryClient = useQueryClient();
  const toast = useToast();
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: ['providers', 'waits'] });
    for (const queryKey of invalidate) void queryClient.invalidateQueries({ queryKey });
  };
  const stop = useMutation({ mutationFn: () => api.cancelLimitWait(moveId), onSuccess: refetch, onError: (error) => toast.error(t('limitWait.stopFailed'), error) });
  const runNow = useMutation({ mutationFn: () => api.runLimitWaitNow(moveId), onSuccess: refetch, onError: (error) => toast.error(t('limitWait.runNowFailed'), error) });
  const pending = stop.isPending || runNow.isPending;
  return (
    <>
      <button type="button" className={`btn btn-small ${quiet}`} disabled={pending} onClick={() => stop.mutate()}>
        {t('limitWait.stop')}
      </button>
      <Tooltip content={t('limitWait.runNowTitle')}>
        <button type="button" className="btn btn-small" disabled={pending} onClick={() => runNow.mutate()}>
          <ArrowRight {...ICON_SM} /> {t('limitWait.runNow')}
        </button>
      </Tooltip>
    </>
  );
}
