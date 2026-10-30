import type { Account } from '@claudio/shared';
import { CircleCheck, CirclePause, LogIn, Star, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoreActions, type MenuItem } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { usageTone } from '@claudio/ui/components/motion';
import { Tag } from '@claudio/ui/components/ui';
import { formatDateTime, formatPercent, timeAgo, toMs } from '@claudio/ui/lib/format';
import { accountExhausted, accountName, canSignInAgain, creditsView, isDefaultAccount, planOf, scopedRows, signInProblem, timeToReset, USAGE_MAX_AGE_MS, usagePct, windowRows, type ScopedRow, type WindowRow } from '../../lib/accounts';

/** `in 2 d 10 h`, or `back in 19 min` for a window that is spent: sentence case, never a title. */
function useResetText() {
  const { t } = useTranslation('accountsConfig');
  return (resetsAt: string | null, spent: boolean): string | null => {
    const left = timeToReset(resetsAt);
    if (left === null) return null;
    if (left === 0) return t('reset.now');
    return spent ? t('reset.back', { duration: left }) : t('reset.in', { duration: left });
  };
}

function WindowMeter({ row }: { row: WindowRow | ScopedRow }) {
  const { t } = useTranslation('accountsConfig');
  const resetText = useResetText();
  const spent = row.pct >= 100;
  const tone = usageTone(row.pct, spent);
  const label = 'model' in row ? t('window.scoped', { model: row.model }) : row.key === 'five_hour' ? t('window.fiveHour') : row.key === 'seven_day' ? t('window.sevenDay') : row.key;
  const reset = resetText(row.resetsAt, spent);
  return (
    <div className="account-meter">
      <div className="account-meter-head">
        <span className="account-meter-label">{label}</span>
        {/* Near the limit is a warning whatever the bar's colour: only a spent window is bad */}
        {spent ? <Tag tone="bad">{t('card.exhausted')}</Tag> : tone !== 'neutral' ? <Tag tone="warn">{t('card.runningHigh')}</Tag> : null}
        {reset && <span className="account-meter-reset">{reset}</span>}
        {row.resetsAt && <span className="sr-only">({formatDateTime(row.resetsAt)})</span>}
        <span className="account-meter-pct">
          {formatPercent(row.pct)}<span className="sr-only"> {t('card.used')}</span>
        </span>
      </div>
      <div className="meter-track" aria-hidden>
        <div className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${row.pct}%` }} />
      </div>
    </div>
  );
}

/** The credits an account may spend beyond its plan: nothing until they were ever set up, then on, off or at their cap. */
function CreditsLine({ account }: { account: Account }) {
  const { t } = useTranslation('accountsConfig');
  const view = creditsView(account.limits?.cli?.credits);
  if (!view) return null;
  if (view.kind === 'off') return <p className="account-credits tnum">{t('card.credits.none')}</p>;
  return (
    <p className="account-credits tnum">
      {view.limit ? t('card.credits.used', { used: view.used, limit: view.limit }) : t('card.credits.usedNoLimit', { used: view.used })}
      {view.kind === 'reached' && <Tag tone="warn">{t('card.credits.limitReached')}</Tag>}
    </p>
  );
}

/** Whether a card says how old its reading is: only one older than the page's own "read … ago" can be trusted to, so a fresh one is not said twice. */
function readingStale(observedAt: string, now = Date.now()): boolean {
  const at = toMs(observedAt);
  return at === null || now - at > USAGE_MAX_AGE_MS;
}

/** One account: who it is, how much of each window it used and how old that reading is, and what can be done with it. */
export function AccountCard({
  account,
  current,
  preferred = false,
  busy,
  onToggle,
  onRemove,
  onPrefer,
  onSignInAgain,
}: {
  account: Account;
  /** New work would start on this account */
  current: boolean;
  /** The person chose it as the account new work starts on while it has room */
  preferred?: boolean;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
  /** Makes it the preferred account; absent where no preference can be set */
  onPrefer?: () => void;
  onSignInAgain: () => void;
}) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const resetText = useResetText();
  const name = accountName(account);
  const exhausted = accountExhausted(account);
  const pct = usagePct(account.limits);
  const backIn = exhausted ? resetText(account.limits?.resetsAt ?? null, true) : null;
  // The plan tag already says "API key", so its kind is not said again
  const sub = [account.alias ? account.email : null, account.organization, account.kind !== 'api-key' ? t(`kind.${account.kind}`) : null].filter(Boolean).join(' · ');
  const plan = planOf(account);
  const planText = plan ? ('key' in plan ? t(`plan.${plan.key}`) : plan.raw) : null;
  const toggleLabel = account.enabled ? t('card.holdOut') : t('card.returnToRotation');
  const rows = [...windowRows(account.limits), ...scopedRows(account.limits)];
  const problem = signInProblem(account);

  // Hold out is the card's own button; the menu holds only what is not on the card
  const menu: MenuItem[] = isDefaultAccount(account) ? [] : [{ id: 'remove', label: t('card.remove'), icon: Trash2, destructive: true, disabled: busy, onSelect: onRemove }];
  const canPrefer = onPrefer !== undefined && !preferred && account.enabled && account.signedIn;
  const classes = ['card', 'account-card', current ? 'grad-border glow-top is-active' : '', exhausted || problem ? 'is-exhausted' : ''].filter(Boolean).join(' ');

  return (
    <li className={classes}>
      <div className="account-head">
        <span className="account-avatar" aria-hidden>
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="account-id">
          <span className="account-name">
            <span className="account-email">{name}</span>
            {planText && <Tag tone="muted">{planText}</Tag>}
            {preferred && <Tag tone="muted">{t('card.preferred')}</Tag>}
            {current && <span className="badge badge-grad">{t('card.inUse')}</span>}
            {isDefaultAccount(account) && <Tag tone="muted">{t('card.default')}</Tag>}
            {!account.enabled && <Tag tone="muted">{t('card.outOfRotation')}</Tag>}
            {problem ? (
              <Tag tone="bad">
                <TriangleAlert {...ICON_SM} /> {t(problem === 'expired' ? 'card.signInExpired' : 'card.signInIncomplete')}
              </Tag>
            ) : (
              !account.signedIn && <Tag tone="warn">{t('card.signedOut')}</Tag>
            )}
            {exhausted && <Tag tone="bad">{t('card.exhausted')}</Tag>}
          </span>
          {sub && (
            <span className="account-sub">
              <span className="account-org">{sub}</span>
            </span>
          )}
        </span>
        {pct !== null && (
          <span className="account-figure">
            <span className={`account-figure-value ${exhausted ? 'text-bad' : current ? 'grad-text' : ''}`.trim()}>
              {formatPercent(100 - pct)}<span className="sr-only"> {t('card.free')}</span>
            </span>
            <span className="section-label" aria-hidden={!backIn}>
              {backIn ?? t('card.free')}
            </span>
          </span>
        )}
      </div>

      {problem && (
        <p className="account-notice small" role="status">
          {t(problem === 'expired' ? 'card.expiredHint' : 'card.incompleteHint')}
        </p>
      )}

      <div className="account-meters">
        {rows.length > 0 ? (
          rows.map((row) => <WindowMeter key={row.key} row={row} />)
        ) : (
          <p className="muted small">{account.kind === 'api-key' ? t('card.noLimitsApiKey') : account.limits?.cli?.available === false ? t('card.noLimitsToken') : t('card.noUsage')}</p>
        )}
        <CreditsLine account={account} />
        {account.limits && readingStale(account.limits.observedAt) && (
          // The cache can be days old and a stream reading is as old as the run that sent it: an old one says how old
          <p className="muted small tnum" title={formatDateTime(account.limits.observedAt)}>
            {t(`card.source.${account.limits.source}`, { ago: timeAgo(account.limits.observedAt) })}
          </p>
        )}
      </div>

      <div className="account-foot">
        <span className="account-actions">
          {problem && canSignInAgain(account) && (
            <button type="button" className="btn btn-small btn-primary" onClick={onSignInAgain} disabled={busy} aria-label={t('card.signInAgainFor', { name })}>
              <LogIn {...ICON_SM} />
              <span className="account-action-text">{t('card.signInAgain')}</span>
            </button>
          )}
          {canPrefer && (
            <button type="button" className="btn btn-small" onClick={onPrefer} disabled={busy} aria-label={t('card.preferFor', { name })}>
              <Star {...ICON_SM} />
              <span className="account-action-text">{t('card.prefer')}</span>
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={onToggle} disabled={busy} aria-label={`${toggleLabel}: ${name}`}>
            {account.enabled ? <CirclePause {...ICON_SM} /> : <CircleCheck {...ICON_SM} />}
            <span className="account-action-text">{toggleLabel}</span>
          </button>
          {menu.length > 0 && <MoreActions label={t('card.more', { name })} title={name} entries={menu} className="account-more" />}
        </span>
      </div>
    </li>
  );
}
