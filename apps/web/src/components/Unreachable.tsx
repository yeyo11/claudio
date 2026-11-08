import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber } from '@claudio/ui/lib/format';
import { Empty, usePageTitle } from '@claudio/ui/components/ui';
import { reachability, useReachability } from '../lib/reachability';

/** Seconds until `at`, rounded up so the line never reads "0 s" while a wait is still on. */
export const secondsUntil = (at: number, now: number): number => Math.max(1, Math.ceil((at - now) / 1000));

/**
 * What a server that cannot be reached looks like (docs/plans/remote-updates.md, D9): not a reload
 * offer, because reloading cannot help, but a screen that says what is wrong in the words of the
 * cause (no connection at all, or this address not answering), retries by itself and goes on
 * without a reload when the server answers. It takes the page's place and leaves the shell around
 * it. `address` is what the person typed to get here; the servers feature will pass a remote's.
 */
export function Unreachable({ address = window.location.host, standalone = false }: { address?: string; standalone?: boolean }) {
  const { t } = useTranslation('shell');
  const { offline, nextAttemptAt, probing } = useReachability();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextAttemptAt === null) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [nextAttemptAt]);

  const title = offline ? t('unreachable.offlineTitle') : t('unreachable.title');
  // The page that was hidden behind this screen sets its own title only when it mounts, so the
  // title it had is put back when the screen goes
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  usePageTitle(title);

  const wait = probing || nextAttemptAt === null ? t('unreachable.retrying') : t('unreachable.retryIn', { seconds: formatNumber(secondsUntil(nextAttemptAt, now)) });
  const screen = (
    <Empty
      illustration="offline"
      size="lg"
      heading
      title={title}
      action={
        <button type="button" className="btn btn-primary" onClick={() => reachability.retryNow()}>
          {t('unreachable.retryNow')}
        </button>
      }
    >
      <p className="unreachable-text" data-testid="unreachable-text">
        {offline ? t('unreachable.offlineBody') : <Trans t={t} i18nKey="unreachable.body" values={{ address }} components={{ mono: <span className="mono" /> }} />}
      </p>
      {/* Not a live region: a count that changes every second would be read out every second */}
      <p className="unreachable-wait tnum">{wait}</p>
    </Empty>
  );
  return standalone ? <main className="unreachable-standalone" data-testid="unreachable">{screen}</main> : <div className="unreachable" data-testid="unreachable">{screen}</div>;
}
