import type { ProviderLimit } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, LogIn, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { api, keys, useAccounts, useSpend } from '../../api';
import { accountName, signInProblem, usagePct, windowRows } from '../../lib/accounts';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { formatCost } from '@claudio/ui/lib/format';
import { cardProvider, limitReading } from '../../lib/shell-live';
import { useLimitWindowName } from '../../lib/limit-words';
import { PROVIDERS_SETTINGS_PATH, useEnabledProviders } from '../../lib/provider-status';
import { resetWhen } from '../../lib/reset-when';
import { spendResetTime, spendView } from '../../lib/spend-cap';
import { SPEND_CAP_SETTINGS_PATH } from '../SpendCapDialog';
import { useUsageNow } from '../../lib/usage-now';
import { limitRows } from '../../lib/limit-rows';
import { StatusDot, usageTone, type DotTone } from '@claudio/ui/components/motion';
import { ProviderMark } from '@claudio/ui/components/ProviderMark';
import { Spinner } from '@claudio/ui/components/Spinner';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { useTerminalBar } from '../terminal/terminal-bar';
import { runningCount } from '../terminal/terminal-model';
import { useTerminalList } from '../terminal/use-terminals';
import { ProviderDots } from './ProviderDots';

type Now = ReturnType<typeof useUsageNow>;

export interface Connection {
  tone: DotTone;
  /** The feed is open and the CLI is ready: the dot pings */
  live: boolean;
  healthy: boolean;
  /** What is wrong, or the CLI when nothing is */
  title: string;
  /** The account when all is well, what to do when it is not */
  detail: string;
  /** What the status bar says in its few characters */
  short: string;
}

/**
 * The wrapper's connection in words: the API, the event feed, the CLI and its login. The status bar
 * says it in a few characters and the phone's More sheet in two lines; both lead to the account
 * settings, where each of these is fixed.
 */
export function useConnection(overview: Now['overview'], feedOpen: boolean): Connection {
  const { t } = useTranslation('components');
  const auth = overview.data?.system.auth;
  const cli = overview.data?.system.cli;
  const healthy = cli?.installed === true && auth?.loggedIn === true;
  const feedDown = !feedOpen && overview.data !== undefined;
  const tone: DotTone = overview.isError ? 'bad' : healthy && !feedDown ? 'ok' : 'warn';
  const title = overview.isError
    ? t('shell.apiUnreachable')
    : !overview.data
      ? t('shell.connecting')
      : healthy
        ? t('shell.claudeCode', { version: cli?.version ?? '' })
        : !cli?.installed
          ? t('shell.cliNotDetected')
          : t('shell.notLoggedIn');
  const account = [auth?.subscriptionType ?? auth?.authMethod, auth?.email].filter(Boolean).join(' · ') || t('shell.loggedIn');
  const detail = healthy
    ? feedDown
      ? t('shell.liveUpdatesPaused')
      : account
    : overview.isError
      ? t('shell.checkWrapper')
      : !overview.data
        ? ''
        : !cli?.installed
          ? t('shell.installCli')
          : t('shell.addCredential');
  // Healthy, the account is what a person looks for; otherwise the problem is
  const short = healthy ? (feedDown ? t('shell.liveUpdatesPaused') : (auth?.email ?? account)) : title;
  return { tone, live: healthy && !feedDown, healthy, title, detail, short };
}

/** One window of the card: its name and figure over a thin bar in the threshold colour. */
function LimitMeter({ label, percent, exhausted }: { label: string; percent: number; exhausted: boolean }) {
  const tone = usageTone(percent, exhausted);
  // Inside a link, so the words are read as part of its name: "5 h 45%"
  return (
    <span className="more-account-limit">
      <span className="more-account-limit-head">
        <span>{label}</span>
        <span className={tone === 'neutral' ? undefined : `statusbar-${tone}`}>{percent}%</span>
      </span>
      <span className="meter-track meter-thin" aria-hidden>
        <span className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/**
 * The phone's More sheet opens on this: the default provider, whether it works, and how much of its
 * limit is used. It is what the desktop's status bar says of that provider, as a card, and leads to
 * Settings → Providers. A provider that reports no limit shows none, and says so.
 */
export function ProviderCard({ now, connection }: { now: Now; connection: Connection }) {
  const { t } = useTranslation(['shell', 'providers']);
  const windowOf = useLimitWindowName();
  const { statuses } = useEnabledProviders();
  const defaultProvider = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings() }).data?.defaultProvider;
  const status = statuses ? cardProvider(statuses, defaultProvider) : null;
  // Before the providers are read, or with none enabled, the card still says whether the CLI works
  if (!status)
    return (
      <NavLink to={PROVIDERS_SETTINGS_PATH} className="card grad-border glow-top more-account" title={t('shell:account.card')}>
        <span className="more-account-head">
          <span className="more-account-text">
            <span className="more-account-name ellipsis">{statuses ? t('shell:account.none') : connection.title}</span>
            {connection.detail && !statuses && <span className="more-account-meta ellipsis">{connection.detail}</span>}
          </span>
          <ChevronRight {...ICON} className="more-cell-chevron" />
        </span>
      </NavLink>
    );
  const limit: ProviderLimit | null | undefined = now.limits.find((l) => l.provider === status.id) ?? status.limit;
  const reading = limitReading(limit);
  const rows = limit && reading ? limitRows(limit).filter((row) => row.name === '5h' || row.name === '7d' || row.name === limit.window).slice(0, 2) : [];
  const ready = status.state === 'ready';
  const tone: DotTone = reading?.state === 'exhausted' ? 'bad' : reading?.state === 'near' ? 'warn' : ready ? 'ok' : 'warn';
  const word = reading?.state === 'exhausted' ? t('shell:statusbar.limit.exhausted') : reading?.state === 'near' ? t('shell:statusbar.limit.near') : ready ? [t('providers:state.ready'), status.version ? t('shell:account.version', { version: status.version }) : null].filter(Boolean).join(' · ') : t(`providers:state.${status.state}`);
  const note = reading?.state === 'exhausted' && reading.resetsAt ? t('shell:statusbar.limit.resumes', { when: resetWhen(reading.resetsAt) }) : null;
  // A reading that is not there says why a bar is missing, in words
  const missing = rows.length === 0 ? (limit?.state === 'unknown' ? t('shell:account.limitUnknown') : !status.capabilities.includes('rateLimitWindows') ? t('shell:account.limitNone') : null) : null;
  return (
    <NavLink to={PROVIDERS_SETTINGS_PATH} className="card grad-border glow-top more-account" title={t('shell:account.card')}>
      <span className="more-account-head">
        <span className="more-account-avatar" aria-hidden>
          <ProviderMark provider={status.id} label={status.label} decorative />
        </span>
        <span className="more-account-text">
          <span className="more-account-name ellipsis">{status.label}</span>
          <span className="more-account-meta ellipsis">
            <StatusDot tone={tone} live={ready && connection.live && !reading} />
            {[word, note].filter(Boolean).join(' · ')}
          </span>
        </span>
        <ChevronRight {...ICON} className="more-cell-chevron" />
      </span>
      {rows.length > 0 && (
        <span className="more-account-limits">
          {rows.map((row) => (
            <LimitMeter key={row.name} label={windowOf(row.name)} percent={row.percent} exhausted={reading?.state === 'exhausted' && row.name === limit?.window} />
          ))}
        </span>
      )}
      {missing && <span className="more-account-meta">{missing}</span>}
    </NavLink>
  );
}

/**
 * The phone's More sheet opens on this when there are accounts: the one new work would start on, its
 * 5 h and 7 d windows, and how many others are ready. It leads to the Accounts page. With no
 * account it gives way to the provider's own card.
 */
export function AccountCard({ now, connection }: { now: Now; connection: Connection }) {
  const { t } = useTranslation('shell');
  const accounts = useAccounts().data ?? [];
  // An account whose sign-in ended is out of rotation: say so beside the card, with the way back
  const problem = accounts.find((a) => signInProblem(a) !== null) ?? null;
  const kind = problem ? signInProblem(problem) : null;
  const alert =
    problem && kind ? (
      <NavLink to="/accounts" className="more-account-alert" title={t('account.signInAgain')}>
        <TriangleAlert {...ICON_SM} />
        <span className="ellipsis">{t(kind === 'expired' ? 'account.signInExpired' : 'account.signInIncomplete', { name: accountName(problem) })}</span>
        <span className="more-account-alert-action">
          <LogIn {...ICON_SM} /> {t('account.signInAgain')}
        </span>
      </NavLink>
    ) : null;
  return (
    <>
      <CurrentAccountCard now={now} connection={connection} />
      {alert}
    </>
  );
}

function CurrentAccountCard({ now, connection }: { now: Now; connection: Connection }) {
  const { t } = useTranslation('shell');
  const windowOf = useLimitWindowName();
  const accounts = useAccounts().data ?? [];
  const snapshot = now.overview.data?.accounts;
  const current = accounts.find((a) => a.id === snapshot?.current) ?? null;
  if (!current) return <ProviderCard now={now} connection={connection} />;
  const name = accountName(current);
  const exhausted = current.limits?.state === 'exhausted';
  const rows = windowRows(current.limits).filter((row) => row.key === 'five_hour' || row.key === 'seven_day');
  const tone: DotTone = exhausted ? 'bad' : current.limits?.state === 'near' ? 'warn' : 'ok';
  const word = exhausted ? t('statusbar.limit.exhausted') : current.limits?.state === 'near' ? t('statusbar.limit.near') : t('account.ready');
  return (
    <NavLink to="/accounts" className="card grad-border glow-top more-account" title={t('account.card')}>
      <span className="more-account-head">
        <span className="more-account-avatar" aria-hidden>
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="more-account-text">
          <span className="more-account-name ellipsis">{name}</span>
          <span className="more-account-meta ellipsis">
            <StatusDot tone={tone} live={connection.live && tone === 'ok' && rows.length === 0} />
            {[word, snapshot && snapshot.total > 1 ? t('account.ofTotal', { ready: snapshot.ready, total: snapshot.total }) : null].filter(Boolean).join(' · ')}
          </span>
        </span>
        <ChevronRight {...ICON} className="more-cell-chevron" />
      </span>
      {rows.length > 0 && (
        <span className="more-account-limits">
          {rows.map((row) => (
            <LimitMeter key={row.key} label={windowOf(row.key === 'five_hour' ? '5h' : '7d')} percent={row.pct} exhausted={exhausted && row.pct >= 100} />
          ))}
        </span>
      )}
    </NavLink>
  );
}

/** The account new work starts on, with the share used of its binding window; only when there is a choice of accounts. */
function AccountChip({ now }: { now: Now }) {
  const { t } = useTranslation('shell');
  const accounts = useAccounts().data ?? [];
  const current = accounts.find((a) => a.id === now.overview.data?.accounts?.current);
  if (!current || accounts.length < 2) return null;
  const pct = usagePct(current.limits);
  const tone = pct === null ? 'neutral' : usageTone(pct, current.limits?.state === 'exhausted');
  return (
    <NavLink to="/accounts" className="statusbar-item" title={t('statusbar.account')}>
      <span className="ellipsis">{accountName(current)}</span>
      {pct !== null && <span className={`mono ${tone === 'neutral' ? '' : `statusbar-${tone}`}`.trim()}>{pct}%</span>}
    </NavLink>
  );
}

/**
 * The day's spend against the daily cap, beside the limit dots: a neutral bar below 60 %, warn with
 * "near the cap" from 60 %, bad with the percentage from 75 %, and bad with when it comes back once
 * the cap is reached. Nothing is drawn with no cap, and nothing is invented when the reading failed.
 */
export function SpendItem() {
  const { t } = useTranslation('shell');
  const state = useSpend().data;
  const view = state ? spendView(state) : null;
  if (!state || !view || state.capUsd === null) return null;
  const time = spendResetTime(state);
  const tone = view.tone === 'neutral' ? '' : ` statusbar-${view.tone}`;
  const tip = (
    <span className="statusbar-tip">
      <span>{t('statusbar.spend.tipSpent', { spent: formatCost(state.spentUsd), cap: formatCost(state.capUsd) })}</span>
      {state.unreported > 0 && <span className="mono">{t('statusbar.spend.tipUnreported', { count: state.unreported })}</span>}
      <span className="mono">{t('statusbar.spend.tipZone', { time, zone: state.timezone })}</span>
    </span>
  );
  return (
    <Tooltip content={tip} side="top">
      <NavLink to={SPEND_CAP_SETTINGS_PATH} className={`statusbar-item spend${tone}`}>
        {view.exhausted ? (
          <span className="ellipsis">{t('statusbar.spend.reached', { time })}</span>
        ) : (
          <>
            <span>{t('statusbar.spend.label')}</span>
            <span className="meter-track meter-thin statusbar-meter" aria-hidden>
              <span className={`meter-fill ${view.tone === 'neutral' ? '' : `is-${view.tone}`}`.trim()} style={{ width: `${view.fill}%` }} />
            </span>
            <span className="mono">{t('statusbar.spend.percent', { value: view.percent })}</span>
            {view.tone === 'warn' && <span>{t('statusbar.spend.near')}</span>}
          </>
        )}
      </NavLink>
    </Tooltip>
  );
}

/**
 * The Terminal item: an icon and how many shells are running, a button that shows or hides the panel
 * above the bar. Absent where a terminal cannot be opened. A shell is the person's, not an agent
 * working, so the count never moves or lights up.
 */
function TerminalItem() {
  const { t } = useTranslation('terminal');
  const bar = useTerminalBar();
  const { terminals } = useTerminalList({ all: true }, bar.available);
  if (!bar.available) return null;
  const count = runningCount(terminals);
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return (
    <Tooltip content={t('dock.hint', { shortcut: `${mac ? '⌘' : 'Ctrl+'}\`` })} side="top">
      <button type="button" className={`statusbar-item statusbar-btn${bar.open ? ' is-open' : ''}`} aria-expanded={bar.open} aria-controls={bar.open ? 'terminal-bar' : undefined} aria-label={t('bar.item', { count })} onClick={bar.toggle}>
        <SquareTerminal size={13} strokeWidth={1.75} aria-hidden />
        <span>{t('bar.label')}</span>
        {count > 0 && <span className="mono">{count}</span>}
      </button>
    </Tooltip>
  );
}

/**
 * The desktop's bottom strip, as in an IDE: the connection on the left, and on the right what is
 * running, what today cost and one dot per provider with its limit. Text and dots only: it sits
 * beside every page.
 */
export function StatusBar({ now, connection, agents }: { now: Now; connection: Connection; agents: number }) {
  const { t } = useTranslation('shell');
  return (
    <footer className="statusbar" aria-label={t('statusbar.label')}>
      <Tooltip content={[connection.title, connection.detail].filter(Boolean).join(' · ')} side="top">
        <NavLink to="/settings?tab=account" className="statusbar-item statusbar-conn">
          <StatusDot tone={connection.tone} live={connection.live} />
          <span className="ellipsis">{connection.short}</span>
        </NavLink>
      </Tooltip>
      {/* Beside the account: the shell is the person's own tool, not something running on their behalf */}
      <TerminalItem />
      <span className="statusbar-spacer" />
      {agents > 0 && (
        <NavLink to="/chats?state=working" className="statusbar-item statusbar-live">
          <Spinner />
          {t('statusbar.running', { count: agents })}
        </NavLink>
      )}
      {now.todayCost !== undefined && (
        <NavLink to="/usage" className="statusbar-item">
          {now.todayCost === null ? t('statusbar.todayNone') : t('statusbar.today', { cost: formatCost(now.todayCost) })}
        </NavLink>
      )}
      <SpendItem />
      <AccountChip now={now} />
      <ProviderDots limits={now.limits} />
    </footer>
  );
}
