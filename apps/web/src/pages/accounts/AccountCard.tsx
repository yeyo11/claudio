import type { Account } from '@claudio/shared';
import { CircleCheck, CirclePause, LogIn, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoreActions, type MenuItem } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { usageTone } from '@claudio/ui/components/motion';
import { Tag } from '@claudio/ui/components/ui';
import { formatDateTime, timeAgo } from '@claudio/ui/lib/format';
import { accountExhausted, accountName, canSignInAgain, isDefaultAccount, signInProblem, timeToReset, usagePct, windowRows, type WindowRow } from '../../lib/accounts';

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

function WindowMeter({ row }: { row: WindowRow }) {
  const { t } = useTranslation('accountsConfig');
  const resetText = useResetText();
  const spent = row.pct >= 100;
  const tone = usageTone(row.pct, spent);
  const label = row.key === 'five_hour' ? t('window.fiveHour') : row.key === 'seven_day' ? t('window.sevenDay') : row.key;
  const reset = resetText(row.resetsAt, spent);
  return (
    <div className="account-meter">
      <div className="account-meter-head">
        <span className="account-meter-label">{label}</span>
        {spent ? <Tag tone="bad">{t('card.exhausted')}</Tag> : tone !== 'neutral' ? <Tag tone={tone === 'bad' ? 'bad' : 'warn'}>{t('card.runningHigh')}</Tag> : null}
        {reset && <span className="account-meter-reset">{reset}</span>}
        {row.resetsAt && <span className="sr-only">({formatDateTime(row.resetsAt)})</span>}
        <span className="account-meter-pct">
          {row.pct}%<span className="sr-only"> {t('card.used')}</span>
        </span>
      </div>
      <div className="meter-track" aria-hidden>
        <div className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${row.pct}%` }} />
      </div>
    </div>
  );
}

/** One account: who it is, how much of each window it used and how old that reading is, and what can be done with it. */
export function AccountCard({
  account,
  current,
  busy,
  onToggle,
  onRemove,
  onSignInAgain,
}: {
  account: Account;
  /** New work would start on this account */
  current: boolean;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSignInAgain: () => void;
}) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const resetText = useResetText();
  const name = accountName(account);
  const exhausted = accountExhausted(account);
  const pct = usagePct(account.limits);
  const backIn = exhausted ? resetText(account.limits?.resetsAt ?? null, true) : null;
  const sub = [account.alias ? account.email : null, account.organization, account.plan].filter(Boolean).join(' · ');
  const toggleLabel = account.enabled ? t('card.holdOut') : t('card.returnToRotation');
  const rows = windowRows(account.limits);
  const problem = signInProblem(account);

  const toggleItem: MenuItem = { id: 'toggle', label: toggleLabel, icon: account.enabled ? CirclePause : CircleCheck, disabled: busy, onSelect: onToggle };
  const removeItem: MenuItem = { id: 'remove', label: t('card.remove'), icon: Trash2, destructive: true, disabled: busy, onSelect: onRemove };
  const menu = isDefaultAccount(account) ? [toggleItem] : [toggleItem, removeItem];
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
          <span className="account-sub">
            {sub && <span className="account-org">{sub}</span>}
            <span className="mono">{t(`kind.${account.kind}`)}</span>
          </span>
        </span>
        {pct !== null && (
          <span className="account-figure">
            <span className={`account-figure-value ${exhausted ? 'text-bad' : current ? 'grad-text' : ''}`.trim()}>
              {100 - pct}%<span className="sr-only"> {t('card.free')}</span>
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
          <p className="muted small">{account.kind === 'api-key' ? t('card.noLimitsApiKey') : t('card.noUsage')}</p>
        )}
        {account.limits && (
          // The cache can be days old and a stream reading is as old as the run that sent it: say how old
          <p className="muted small mono" title={formatDateTime(account.limits.observedAt)}>
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
          <button type="button" className="btn btn-small" onClick={onToggle} disabled={busy} aria-label={`${toggleLabel}: ${name}`}>
            {account.enabled ? <CirclePause {...ICON_SM} /> : <CircleCheck {...ICON_SM} />}
            <span className="account-action-text">{toggleLabel}</span>
          </button>
          <MoreActions label={t('card.more', { name })} title={name} entries={menu} className="account-more" />
        </span>
      </div>
    </li>
  );
}
