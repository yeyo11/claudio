import { UserRound, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MenuEntry, MenuItem } from '@claudio/ui/components/controls/Menu';
import { formatClock, formatPercent } from '@claudio/ui/lib/format';
import { accountLabel, canChoose, type AccountRow } from '../lib/account-choice';

/** Up to this many accounts the menu opens them as a submenu; beyond it a searchable picker. */
export const SUBMENU_MAX = 6;

export type T = (key: string, options?: Record<string, unknown>) => string;

/** The chat namespace's `t` for keys built here from a state's name, which the typed keys cannot see. */
export function useLooseT(): T {
  const { t } = useTranslation('chat');
  return (key, options) => String(t(key as 'composerMenu.title', options));
}

/** Why an account cannot be chosen, in words; undefined when it can, or when it is the chat's own. */
export function accountReason(row: AccountRow, model: string | null, t: T): string | undefined {
  switch (row.state) {
    case 'disabled':
      return t('composerMenu.account.disabled');
    case 'sign-in-expired':
      return t('composerMenu.account.signInExpired');
    case 'signed-out':
      return t('composerMenu.account.signedOut');
    case 'exhausted':
      return row.resetsAt ? t('composerMenu.account.exhaustedUntil', { time: formatClock(row.resetsAt) }) : t('composerMenu.account.exhausted');
    case 'model-unavailable':
      return t('composerMenu.account.noModel', { model: model ?? '' });
    default:
      return undefined;
  }
}

/** What an account says about itself on its one line: name, plan, use of its window. */
export function AccountLine({ row }: { row: AccountRow }) {
  return (
    <span className="account-picker-line">
      <span className="account-picker-name ellipsis">{accountLabel(row.account)}</span>
      {row.account.plan && <span className="account-picker-plan">{row.account.plan}</span>}
      {row.pct !== null && <span className="account-picker-pct tnum">{formatPercent(row.pct)}</span>}
    </span>
  );
}

/** The rows whose name, email or plan contain what was typed; everything while it is blank. */
export function filterRows(rows: readonly AccountRow[], query: string): AccountRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(({ account }) => [account.alias, account.email, account.id, account.plan].some((field) => field?.toLowerCase().includes(needle)));
}

/** One option of the radio list, with its reason as the second line when it cannot be chosen. */
export function accountOption(row: AccountRow, model: string | null, t: T): MenuItem {
  const reason = accountReason(row, model, t);
  return {
    id: row.account.id,
    text: accountLabel(row.account),
    label: <AccountLine row={row} />,
    disabled: !canChoose(row) && row.state !== 'current',
    disabledReason: reason,
  };
}

/** The submenu behind the Account item: the radio list, and the way out of a switch that waits. */
export function accountEntries({
  rows,
  model,
  pending,
  t,
  onChoose,
  onCancel,
}: {
  rows: readonly AccountRow[];
  model: string | null;
  /** The row the chat will move to when its turn ends */
  pending: AccountRow | undefined;
  t: T;
  onChoose: (accountId: string) => void;
  onCancel: () => void;
}): MenuEntry[] {
  const current = rows.find((row) => row.state === 'current');
  const entries: MenuEntry[] = [
    {
      id: 'choices',
      radio: { value: current?.account.id ?? '', onChange: (id) => id !== current?.account.id && onChoose(id) },
      items: rows.map((row) => accountOption(row, model, t)),
    },
  ];
  if (pending && current)
    entries.push({
      id: 'switch',
      items: [{ id: 'cancel', icon: Undo2, label: t('composerMenu.account.cancel'), meta: t('composerMenu.account.pendingTo', { name: accountLabel(pending.account) }), onSelect: onCancel }],
    });
  return entries;
}

/**
 * The Account item of the "+" menu: "Account · alias · 42 %", opening the choices as a submenu, or
 * as a picker when there are too many for one. Null with fewer than two accounts, where there is
 * nothing to choose.
 */
export function accountItem({
  rows,
  model,
  pending,
  t,
  onChoose,
  onCancel,
  onOpenChange,
  onPicker,
  picker,
}: {
  rows: readonly AccountRow[];
  model: string | null;
  pending: AccountRow | undefined;
  t: T;
  onChoose: (accountId: string) => void;
  onCancel: () => void;
  onOpenChange: (open: boolean) => void;
  /** Opens the picker on a desktop (a phone's sheet shows `picker` as a step of its own) */
  onPicker: () => void;
  picker: NonNullable<MenuItem['detail']>;
}): MenuItem | null {
  if (rows.length < 2) return null;
  const current = rows.find((row) => row.state === 'current');
  const title = t('composerMenu.account.title');
  const label = (
    <span>
      {title} · {current ? accountLabel(current.account) : '…'}
      {current && current.pct !== null && <span className="tnum"> · {formatPercent(current.pct)}</span>}
    </span>
  );
  const base: MenuItem = {
    id: 'account',
    icon: UserRound,
    label,
    text: title,
    meta: pending ? t('composerMenu.account.pendingTo', { name: accountLabel(pending.account) }) : undefined,
    onOpenChange,
  };
  if (rows.length > SUBMENU_MAX) return { ...base, onSelect: onPicker, detail: picker };
  return { ...base, submenu: accountEntries({ rows, model, pending, t, onChoose, onCancel }) };
}
