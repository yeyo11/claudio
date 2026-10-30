import { useOverview, useSpend, useUsage } from '../api';

const pad = (n: number) => String(n).padStart(2, '0');

/** Today in the browser's calendar: only for when the server's day cannot be read. */
function usageToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The day "Today" means: the server's (`SpendState.day`), which is the day it buckets usage by and
 * the spend cap counts. A browser in another time zone (a phone on the LAN, the tunnel, a container
 * on UTC) would otherwise show another day's figure next to the meter. Undefined while it loads; the
 * browser's own day only when the server's cannot be read.
 */
export function usageDay(spend: { data?: { day: string }; isError: boolean }, now = new Date()): string | undefined {
  return spend.data?.day ?? (spend.isError ? usageToday(now) : undefined);
}

/**
 * What the shell reads of the wrapper right now: the overview, each provider's last limit reading
 * and what today cost. The status bar and the phone's More card read the same queries through
 * this hook, so each is fetched once and both always show the same figure.
 */
export function useUsageNow() {
  const overview = useOverview();
  const today = usageDay(useSpend());
  const usage = useUsage({ from: today, to: today }, { enabled: today !== undefined });
  const total = usage.data?.total;
  return {
    overview,
    usage,
    /** One reading per provider that has one; fresher than the statuses, which only change on detection */
    limits: overview.data?.limits ?? [],
    /** Null when nothing reported a cost today; undefined while it loads */
    todayCost: total === undefined ? undefined : total.costUsd,
  };
}
