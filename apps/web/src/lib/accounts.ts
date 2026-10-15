import type { Account, AccountLimit } from '@agentry/shared';
import { currentLanguage, intlLocale } from '@agentry/ui/i18n/language';
import { formatDuration, toMs } from '@agentry/ui/lib/format';

/** What a person calls an account: its alias, else the email the CLI reported, else its id. */
export const accountName = (account: Pick<Account, 'alias' | 'email' | 'id'>): string => account.alias ?? account.email ?? account.id;

/** The default account is the CLI's own config dir; it cannot be removed. */
export const isDefaultAccount = (account: Pick<Account, 'id'>): boolean => account.id === 'default';

/** Use of the binding window as a whole percent, or null when nothing was read. */
export const usagePct = (limit: AccountLimit | null | undefined): number | null =>
  limit && limit.utilization !== null ? Math.min(100, Math.round(limit.utilization * 100)) : null;

/** An account that hit its limit: nothing can start on it until the window resets. */
export const accountExhausted = (account: Account): boolean => account.limits?.state === 'exhausted';

/** Can new work start on it: enabled, signed in, not at its limit. */
export const accountUsable = (account: Account): boolean => account.enabled && account.signedIn && !accountExhausted(account);

/** Usable ones first, in the server's order; the exhausted ones last. */
export function sortAccounts(accounts: readonly Account[]): Account[] {
  const rank = (a: Account) => (accountUsable(a) ? 0 : accountExhausted(a) ? 2 : 1);
  return accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((e) => e.a);
}

const minutes = () => new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'minute', unitDisplay: currentLanguage() === 'en' ? 'narrow' : 'short' });

/** How long until a reset, to the minute: `19 min`, `4 h 49 min`, `2 d 10 h`. */
export function resetDuration(ms: number): string {
  const whole = Math.max(1, Math.ceil(ms / 60_000));
  return whole < 60 ? minutes().format(whole) : formatDuration(whole * 60_000);
}

/** The time left to an ISO reset; `0` when it is already due, null when unknown. */
export function timeToReset(resetsAt: string | null | undefined, now = Date.now()): string | 0 | null {
  const at = toMs(resetsAt);
  if (at === null) return null;
  return at <= now ? 0 : resetDuration(at - now);
}

export interface WindowRow {
  key: string;
  pct: number;
  resetsAt: string | null;
}

/** An account's windows in the order the card draws them: five hours, then seven days, then any other. */
export function windowRows(limit: AccountLimit | null | undefined): WindowRow[] {
  if (!limit) return [];
  const order = (key: string) => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : 2);
  return Object.entries(limit.windows)
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([key, w]) => ({ key, pct: Math.min(100, Math.round(w.utilization * 100)), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }));
}
