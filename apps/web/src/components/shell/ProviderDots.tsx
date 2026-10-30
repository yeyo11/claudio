import type { ProviderLimit, ProviderStatus } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { PROVIDERS_SETTINGS_PATH, useEnabledProviders } from '../../lib/provider-status';
import { STATE_TONE, stateLabelKey } from '../../lib/provider-state';
import { useProviderReason } from '../ProviderRow';
import { formatPercent, timeAgo } from '@claudio/ui/lib/format';
import { limitReading, type LimitReading } from '../../lib/shell-live';
import { useLimitWindowName } from '../../lib/limit-words';
import { resetWhen } from '../../lib/reset-when';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { StatusDot, usageTone, type DotTone } from '@claudio/ui/components/motion';
import { Spinner } from '@claudio/ui/components/Spinner';
import { accountReading, type AccountInUseView } from '../../lib/accounts';
import { CLAUDE_CODE_ID } from '../../lib/provider-state';

/**
 * What the dot says of a provider whose last reading is near or at its limit. The limit is always
 * the word, even when something else degraded the provider too (the reason stays in the tip), and
 * an exhausted limit is bad whatever the state; a limit that is only near is warn.
 */
export function limitDotFacts(status: Pick<ProviderStatus, 'state' | 'reason'>, reading: Pick<LimitReading, 'state'> | null): { hot: boolean; limitOnly: boolean; tone: DotTone } {
  const hot = reading !== null && reading.state !== 'ok';
  // A provider degraded only by its limit is working: the limit says it, not "degraded"
  const limitOnly = hot && (status.state === 'ready' || status.reason === 'limit-reached' || status.reason === 'limit-near');
  const tone: DotTone = reading?.state === 'exhausted' ? 'bad' : limitOnly ? 'warn' : STATE_TONE[status.state];
  return { hot, limitOnly, tone };
}

/**
 * "Claude Code 2.1.282 ▬▬ 45 %" when it works; "Claude Code · limit ▬▬ 72 %" near its limit;
 * "Claude Code · limit reached resets 14:05" at it; "Claude Code · signed out" when it needs a person. The
 * limit is always said in a word beside its colour, and a provider that reports none shows no bar.
 */
function ProviderDot({ status, limit, account }: { status: ProviderStatus; limit: ProviderLimit | null | undefined; account: AccountInUseView | null }) {
  const { t } = useTranslation('providers');
  const { t: ts } = useTranslation('shell');
  const reason = useProviderReason(status);
  // A provider with accounts speaks with the reading of the account in use, the one the account
  // chip and the cards show; the provider's own reading is whichever account ran last
  const reading = account ? accountReading(account.limit) : limitReading(limit);
  const observedAt = account ? (account.limit?.observedAt ?? null) : (limit?.observedAt ?? null);
  const unknown = account ? account.limit?.state === 'unknown' : limit?.state === 'unknown';
  const windowOf = useLimitWindowName();
  const { hot, limitOnly, tone } = limitDotFacts(status, reading);
  const ok = status.state === 'ready';
  const word = t(stateLabelKey(status.state)).toLowerCase();
  const limitWord = reading ? (reading.state === 'exhausted' ? ts('statusbar.limit.exhausted') : ts('statusbar.limit.near')) : '';
  const text = hot ? `${status.label} · ${limitWord}` : ok ? status.label : `${status.label} · ${word}`;
  // The version is a literal the CLI prints, so it alone keeps the mono voice in the strip
  const version = !hot && ok && status.version ? status.version : null;
  const barTone = reading?.percent == null ? 'neutral' : usageTone(reading.percent, reading.state === 'exhausted');
  const showBar = reading !== null && reading.percent !== null && reading.state !== 'exhausted';
  const where = [status.version ? t('statusbar.version', { version: status.version }) : null, status.binaryPath ?? status.configHome]
    .filter(Boolean)
    .join(' · ');
  const windowName = windowOf(reading?.window);
  const tip = (
    <span className="statusbar-tip">
      <span>{`${status.label} · ${hot ? limitWord : word}`}</span>
      {where && <span className="mono">{where}</span>}
      {!ok && !limitOnly && <span>{reason}</span>}
      {reading && (
        <span>
          {[
            reading.percent !== null ? ts('statusbar.limit.tipWindow', { window: windowName, percent: formatPercent(reading.percent) }) : windowName,
            reading.resetsAt ? ts('statusbar.limit.tipReset', { when: resetWhen(reading.resetsAt) }) : null,
            account ? ts('statusbar.limit.tipAccount', { name: account.label }) : null,
            observedAt ? ts('statusbar.limit.tipAge', { age: timeAgo(observedAt) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {!reading && unknown && <span>{ts('statusbar.limit.unknown')}</span>}
      {!limit && !account && !status.capabilities.includes('rateLimitWindows') && status.state === 'ready' && <span>{ts('statusbar.limit.none', { provider: status.label })}</span>}
    </span>
  );
  return (
    <Tooltip content={tip} side="top">
      <NavLink
        to={PROVIDERS_SETTINGS_PATH}
        className={`statusbar-item ${tone === 'warn' ? 'statusbar-warn' : tone === 'bad' ? 'statusbar-bad' : ''}`.trim()}
      >
        {/* Named by what it shows (provider, state, percent, when it resumes), so a voice user can
            say the words they see; the spaces keep the flex items' words apart in that name */}
        <StatusDot tone={tone} />
        <span className="ellipsis">
          {text}
          {version && (
            <>
              {' '}
              <span className="mono">{version}</span>
            </>
          )}
        </span>
        {showBar && reading.percent !== null && (
          <>
            <span className="meter-track meter-thin statusbar-meter" aria-hidden>
              <span className={`meter-fill ${barTone === 'neutral' ? '' : `is-${barTone}`}`.trim()} style={{ width: `${reading.percent}%` }} />
            </span>{' '}
            <span>{formatPercent(reading.percent)}</span>
          </>
        )}
        {reading?.state === 'exhausted' && reading.resetsAt && <> <span className="statusbar-age">{ts('statusbar.limit.resumes', { when: resetWhen(reading.resetsAt) })}</span></>}
      </NavLink>
    </Tooltip>
  );
}

/**
 * One dot per enabled provider at the right of the status bar. With none found, or while the first
 * reading runs, a single note stands in for them, so the strip never shows a blank. `limits` are the
 * overview's readings, fresher than the ones the statuses carry; `inUse` is the account view's
 * account in use, whose reading Claude Code's dot shows.
 */
export function ProviderDots({ limits = [], inUse = null }: { limits?: readonly ProviderLimit[]; inUse?: AccountInUseView | null }) {
  const { t } = useTranslation('providers');
  const { statuses, loading } = useEnabledProviders();
  if (loading)
    return (
      <span className="statusbar-item">
        <Spinner />
        {t('statusbar.checking')}
      </span>
    );
  if (!statuses) return null;
  const present = statuses.filter((s) => s.state !== 'not-installed');
  if (present.length === 0)
    return (
      <NavLink to={PROVIDERS_SETTINGS_PATH} className="statusbar-item">
        <StatusDot tone="idle" />
        {t('statusbar.none')}
      </NavLink>
    );
  return (
    <>
      {present.map((s) => (
        <ProviderDot key={s.id} status={s} limit={limits.find((l) => l.provider === s.id) ?? s.limit} account={s.id === CLAUDE_CODE_ID ? inUse : null} />
      ))}
    </>
  );
}
