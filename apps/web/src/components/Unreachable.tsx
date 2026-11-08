import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber } from '@claudio/ui/lib/format';
import { Empty } from '@claudio/ui/components/ui';
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
  // The tab says what the screen says while it shows. The page behind it (one opened during the
  // outage mounts after this screen) still writes its own title, so each write is remembered and
  // answered with the screen's, and the last one written is what comes back when the screen goes.
  useEffect(() => {
    const own = `${title} · Claudio`;
    let theirs = document.title;
    const claim = () => {
      if (document.title === own) return;
      theirs = document.title;
      document.title = own;
    };
    claim();
    const watch = new MutationObserver(claim);
    watch.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      watch.disconnect();
      document.title = theirs;
    };
  }, [title]);

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
