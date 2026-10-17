import { Check, Search } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { canChoose, type AccountRow } from '../lib/account-choice';
import { AccountLine, accountReason, filterRows, SUBMENU_MAX, useLooseT } from './account-menu';

/**
 * The accounts as one radio list: a row per account (name, plan, use of its window on one line, and
 * the reason under it when it cannot be chosen), with a search field once there are more than a
 * submenu holds. The "+" menu's picker and a new chat's account field are both this, so an account
 * reads the same wherever it is chosen.
 */
export function AccountList({
  rows,
  model,
  chosen,
  busy = false,
  auto,
  label,
  search,
  autoFocusSearch = false,
  onChoose,
}: {
  rows: readonly AccountRow[];
  /** The model the account has to offer, for the reason a row gives when it does not */
  model: string | null;
  /** The account in use, or '' for the automatic row; null when none is */
  chosen: string | null;
  busy?: boolean;
  /** A first row that leaves the choice to the rotation, chosen with '' */
  auto?: string;
  /** Names the list for a screen reader */
  label: string;
  /** Whether the search field shows; by default only past what a submenu holds */
  search?: boolean;
  autoFocusSearch?: boolean;
  onChoose: (accountId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const loose = useLooseT();
  const why = useId();
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const searchable = search ?? rows.length > SUBMENU_MAX;
  const shown = filterRows(rows, searchable ? query : '');
  const radios = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);

  // Arrows walk the rows, disabled ones included: their reason is what a person came to read
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const items = radios();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = event.key === 'ArrowDown' ? items[Math.min(at + 1, items.length - 1)] : event.key === 'ArrowUp' ? (at <= 0 ? undefined : items[at - 1]) : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  // One tab stop for the list, on the row in use (the first when none is)
  const showsAuto = auto !== undefined && query.trim() === '';
  const stop = chosen !== null && (chosen === '' ? showsAuto : shown.some((row) => row.account.id === chosen)) ? chosen : (showsAuto ? '' : shown[0]?.account.id);

  return (
    <div className="account-picker">
      {searchable && (
        <label className="account-picker-search">
          <Search {...ICON_SM} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t('composerMenu.account.search')}
            aria-label={t('composerMenu.account.search')}
            autoComplete="off"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- a panel opened to be searched
            autoFocus={autoFocusSearch}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
      )}
      <div ref={list} role="radiogroup" aria-label={label} className="account-picker-list" onKeyDown={onKeyDown}>
        {showsAuto && (
          <div className="account-picker-item">
            <button type="button" role="radio" aria-checked={chosen === ''} aria-disabled={busy || undefined} tabIndex={stop === '' ? 0 : -1} className="account-picker-row" onClick={() => !busy && onChoose('')}>
              <span className="account-picker-line">
                <span className="account-picker-name ellipsis">{auto}</span>
              </span>
              {chosen === '' && <Check {...ICON_SM} className="account-picker-check" aria-hidden />}
            </button>
          </div>
        )}
        {shown.map((row) => {
          const reason = accountReason(row, model, loose);
          const isChosen = chosen === row.account.id;
          const reasonId = `${why}-${row.account.id}`;
          return (
            <div key={row.account.id} className="account-picker-item">
              <button
                type="button"
                role="radio"
                aria-checked={isChosen}
                aria-disabled={(!canChoose(row) && !isChosen) || busy || undefined}
                aria-describedby={reason ? reasonId : undefined}
                tabIndex={stop === row.account.id ? 0 : -1}
                className="account-picker-row"
                onClick={() => {
                  if (canChoose(row) && !busy) onChoose(row.account.id);
                }}
              >
                <AccountLine row={row} />
                {isChosen && <Check {...ICON_SM} className="account-picker-check" aria-hidden />}
              </button>
              {reason && (
                <p id={reasonId} className="account-picker-why">
                  {reason}
                </p>
              )}
            </div>
          );
        })}
        {shown.length === 0 && !showsAuto && <p className="small muted">{t('composerMenu.account.none')}</p>}
      </div>
    </div>
  );
}
