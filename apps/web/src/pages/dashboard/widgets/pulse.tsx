import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAccounts, useOverview } from '../../../api';
import { accountName, usagePct } from '../../../lib/accounts';
import { ProgressRing, usageTone } from '@claudio/ui/components/motion';
import { Spinner } from '@claudio/ui/components/Spinner';
import { Skeleton } from '@claudio/ui/components/ui';
import { formatAmountShort, formatCost, formatNumber, formatPercent, timeUntil } from '@claudio/ui/lib/format';
import { useHomePulse } from '../pulse';
import type { WidgetProps } from '../registry';

function Kpi({
  className = '',
  mark,
  label,
  tag,
  value,
  valueShort,
  valueClass = '',
  sub,
  short,
}: {
  className?: string;
  /** What sits before the label: a spinner when it is live, a dot otherwise */
  mark?: ReactNode;
  label: string;
  /** On a phone, a short label in place of the long one */
  tag?: string;
  value: ReactNode;
  /** On a phone, where the tile is a third of the screen, a shorter form of the figure */
  valueShort?: ReactNode;
  valueClass?: string;
  sub: ReactNode;
  /** On a phone, the word under the figure */
  short: string;
}) {
  return (
    <div className={`card kpi ${className}`.trim()}>
      <span className="kpi-head">
        {mark}
        <span className="kpi-label">{label}</span>
        {tag && <span className="kpi-tag section-label">{tag}</span>}
      </span>
      <span className={`kpi-value ${valueClass}`.trim()}>
        {valueShort === undefined ? (
          value
        ) : (
          <>
            <span className="kpi-value-full">{value}</span>
            <span className="kpi-value-short">{valueShort}</span>
          </>
        )}
      </span>
      <span className="kpi-sub tnum">{sub}</span>
      <span className="kpi-short">{short}</span>
    </div>
  );
}

/**
 * The page's figures in one strip: who is at work, who waits, what today cost. The 5 h limit is a
 * widget of its own beside it, because on a phone it moves to the bottom as the account's card.
 */
export function KpisWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const pulse = useHomePulse(project);
  const heading = `${id}-title`;
  if (pulse.loading) {
    return (
      <section className="kpi-strip" aria-busy="true" aria-label={title}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card kpi">
            <Skeleton rows={2} height={16} />
          </div>
        ))}
      </section>
    );
  }
  const where = [
    pulse.orchestrationsRunning > 0 ? t('kpis.orchestrations', { count: pulse.orchestrationsRunning, n: formatNumber(pulse.orchestrationsRunning) }) : null,
    pulse.chatsWorking > 0 ? t('kpis.chats', { count: pulse.chatsWorking, n: formatNumber(pulse.chatsWorking) }) : null,
  ].filter(Boolean);
  return (
    <section className="kpi-strip" aria-labelledby={heading}>
      <h2 id={heading} className="sr-only">
        {title}
      </h2>
      <Kpi
        mark={pulse.agents > 0 ? <Spinner /> : <span className="dot" aria-hidden />}
        label={t('kpis.agents')}
        value={formatNumber(pulse.agents)}
        sub={where.length > 0 ? where.join(' · ') : t('kpis.nothingRunning')}
        short={t('kpis.agentsShort', { count: pulse.agents })}
      />
      <Kpi
        mark={<span className={`dot ${pulse.waiting > 0 ? 'dot-idle' : 'dot-ok'}`} aria-hidden />}
        label={t('kpis.waiting')}
        value={formatNumber(pulse.waiting)}
        sub={pulse.waiting > 0 ? t('kpis.waitingSome') : t('kpis.waitingNone')}
        short={t('kpis.waitingShort', { count: pulse.waiting })}
      />
      <Kpi
        className="grad-border kpi-spend"
        label={t('kpis.spend')}
        tag={t('kpis.today')}
        value={pulse.spentToday === null ? '—' : formatCost(pulse.spentToday)}
        valueShort={pulse.spentToday === null ? '—' : formatAmountShort(pulse.spentToday)}
        valueClass="grad-text"
        sub={
          pulse.chatsWithoutCost > 0
            ? t('kpis.withoutCost', { count: pulse.chatsWithoutCost, n: formatNumber(pulse.chatsWithoutCost) })
            : project
              ? t('kpis.inProject')
              : t('kpis.everyProject')
        }
        short={t('kpis.spent')}
      />
    </section>
  );
}

/**
 * The 5 h window as a ring, with when it comes back and the weekly share. It belongs to the account,
 * so it reads the same on every dashboard; on a phone it is the account's card at the bottom.
 */
export function LimitsWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation('home');
  const overview = useOverview();
  const { limits } = useHomePulse(project);
  const heading = `${id}-title`;
  const five = limits.fiveHour;
  const accounts = useAccounts().data ?? [];
  const currentAccount = accounts.find((a) => a.id === overview.data?.accounts?.inUse?.id);
  // The account new work starts on; the CLI's own login when no account is known yet
  const email = currentAccount ? accountName(currentAccount) : (overview.data?.system.auth.email ?? null);
  // The other accounts, each with the share of its binding window: a limit is per account
  const others = accounts.filter((a) => a.id !== currentAccount?.id && a.enabled && a.signedIn).map((a) => ({ id: a.id, name: accountName(a), pct: usagePct(a.limits), exhausted: a.limits?.state === 'exhausted' }));
  const tone = five ? usageTone(five.pct) : 'neutral';
  return (
    <section className="card kpi limits-card" aria-labelledby={heading}>
      {overview.isLoading ? (
        <Skeleton rows={2} height={16} />
      ) : (
        <>
          {five ? (
            <ProgressRing value={five.pct / 100} size={56} stroke={5} tone={tone === 'neutral' ? 'accent' : tone}>
              <span className="gauge-value">{formatPercent(five.pct)}</span>
            </ProgressRing>
          ) : null}
          <span className="limits-text">
            {email && (
              <Link to="/accounts" className="limits-account strong ellipsis">
                {email}
              </Link>
            )}
            <h2 id={heading} className="kpi-label">
              {five ? t('kpis.fiveHour') : title}
            </h2>
            {five ? (
              <>
                {five.resetsAt !== null && <span className="kpi-sub tnum">{t('kpis.resets', { when: timeUntil(five.resetsAt / 1000) })}</span>}
                {limits.weekly && <span className="kpi-sub tnum">{t('kpis.weekly', { percent: formatPercent(limits.weekly.pct) })}</span>}
                {others.length > 0 && (
                  <span className="kpi-sub tnum ellipsis">
                    {others.map((o) => `${o.name} ${o.exhausted ? t('kpis.accountExhausted') : o.pct === null ? '–' : formatPercent(o.pct)}`).join(' · ')}
                  </span>
                )}
                <span className="limits-phone tnum">
                  {[t('kpis.fiveHourShort', { percent: formatPercent(five.pct) }), limits.weekly ? t('kpis.weeklyShort', { percent: formatPercent(limits.weekly.pct) }) : null].filter(Boolean).join(' · ')}
                </span>
              </>
            ) : (
              <span className="kpi-sub">{t('widgets.limits.none')}</span>
            )}
          </span>
        </>
      )}
    </section>
  );
}
