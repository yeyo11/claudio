import type { Account, AccountCredits, AccountInUse, AccountInUseReason, AccountLimit, ProviderReadinessState, ProviderReasonCode } from '@claudio/shared';
import { currentLanguage, intlLocale } from '@claudio/ui/i18n/language';
import { formatDuration, toMs } from '@claudio/ui/lib/format';

/** What a person calls an account: its alias, else the email the CLI reported, else its id. */
export const accountName = (account: Pick<Account, 'alias' | 'email' | 'id'>): string => account.alias ?? account.email ?? account.id;

/** The default account is the CLI's own config dir; it cannot be removed. */
export const isDefaultAccount = (account: Pick<Account, 'id'>): boolean => account.id === 'default';

/** Use of the binding window as a whole percent, or null when nothing was read. */
export const usagePct = (limit: AccountLimit | null | undefined): number | null =>
  limit && limit.utilization !== null ? Math.min(100, Math.round(limit.utilization * 100)) : null;

/** An account that hit its limit: nothing can start on it until the window resets. */
export const accountExhausted = (account: Account): boolean => account.limits?.state === 'exhausted';

/** An account that cannot be used until the person signs in again: its session expired or its stored sign-in is incomplete. */
export const signInProblem = (account: Pick<Account, 'signInState'>): 'expired' | 'incomplete' | null =>
  account.signInState === 'expired' || account.signInState === 'incomplete' ? account.signInState : null;

/** Only a `login` account has a sign-in to redo; a token or key is replaced by removing and adding it. */
export const canSignInAgain = (account: Pick<Account, 'kind'>): boolean => account.kind === 'login';

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

export interface ScopedRow extends WindowRow {
  /** The model the limit is for, as the CLI names it (`Fable`) */
  model: string;
}

/** The weekly limits that apply to one model, beside the account-wide windows; one whose reset passed says nothing. */
export function scopedRows(limit: AccountLimit | null | undefined, now = Date.now()): ScopedRow[] {
  return (limit?.cli?.scoped ?? [])
    .filter((s) => s.resetsAt * 1000 > now)
    .map((s) => ({ key: `${s.window}:model:${s.model}`, model: s.model, pct: Math.min(100, Math.round(s.utilization * 100)), resetsAt: new Date(s.resetsAt * 1000).toISOString() }));
}

export type PlanKey = 'max' | 'pro' | 'team' | 'enterprise' | 'apiKey';
const PLANS: readonly PlanKey[] = ['max', 'pro', 'team', 'enterprise'];

/** The plan to name on the card: a known one by key, an unknown one as the CLI wrote it, an API key as itself, null when nothing says. */
export function planOf(account: Pick<Account, 'kind' | 'plan'>): { key: PlanKey } | { raw: string } | null {
  if (account.kind === 'api-key') return { key: 'apiKey' };
  // `auth status` says `max`, `initialize` says `Claude Max`
  const raw = account.plan?.trim().replace(/^claude\s+/i, '') ?? '';
  if (!raw) return null;
  const known = PLANS.find((p) => p === raw.toLowerCase());
  return known ? { key: known } : { raw: raw.charAt(0).toUpperCase() + raw.slice(1) };
}

/** An amount in minor units in its own currency and decimal places; a currency the CLI did not state is a plain number. */
export function formatCredits(minor: number, credits: Pick<AccountCredits, 'currency' | 'exponent'>): string {
  const value = minor / 10 ** credits.exponent;
  const digits = { minimumFractionDigits: credits.exponent, maximumFractionDigits: credits.exponent };
  try {
    return new Intl.NumberFormat(intlLocale(), credits.currency ? { style: 'currency', currency: credits.currency, ...digits } : digits).format(value);
  } catch {
    // A code Intl does not know: still the amount, with the code beside it
    return `${new Intl.NumberFormat(intlLocale(), digits).format(value)} ${credits.currency ?? ''}`.trim();
  }
}

/**
 * What the credits line says. Credits never set up say nothing (most accounts: it would be noise on
 * every card); once set up, whether they are on, off or at their cap does.
 */
export function creditsView(credits: AccountCredits | null | undefined): { kind: 'on' | 'off' | 'reached'; used: string; limit: string | null } | null {
  if (!credits) return null;
  const used = formatCredits(credits.usedMinor, credits);
  const limit = credits.limitMinor !== null && credits.limitMinor > 0 ? formatCredits(credits.limitMinor, credits) : null;
  if (credits.limitReached) return { kind: 'reached', used, limit };
  if (credits.enabled) return { kind: 'on', used, limit };
  return credits.everEnabled ? { kind: 'off', used, limit } : null;
}

/** How old a `get_usage` reading may be before opening Accounts reads it again. */
export const USAGE_MAX_AGE_MS = 10 * 60_000;

/** Whether an account the CLI can answer for has no reading from it, or one older than `maxAge`. */
export function usageStale(accounts: readonly Account[], now = Date.now(), maxAge = USAGE_MAX_AGE_MS): boolean {
  return accounts.some((a) => {
    if (!a.enabled || !a.signedIn) return false;
    const at = toMs(a.limits?.cli?.observedAt);
    return at === null || now - at > maxAge;
  });
}

/**
 * What the status bar and the phone's More sheet say about the CLI, as one kind. Signed in, at a
 * limit and "could not check" are separate questions: a limit or a failed probe never reads as a
 * missing sign-in, which only the credentials decide.
 */
export type ConnectionKind = 'ready' | 'no-cli' | 'signed-out' | 'expired' | 'limit' | 'near' | 'unchecked' | 'unready';

export interface ConnectionFacts {
  cliInstalled: boolean;
  inUse: Pick<AccountInUse, 'signInState'> | null;
  /** From the server when `inUse` is null; absent on an old one */
  inUseReason?: AccountInUseReason | null;
  /** `GET /accounts`, when read */
  accounts: readonly Pick<Account, 'enabled' | 'signedIn'>[];
  /** The default provider's state and reason, when read */
  provider: { state: ProviderReadinessState; reason: ProviderReasonCode | null } | null;
}

export function connectionOf(facts: ConnectionFacts): ConnectionKind {
  const { inUse, provider } = facts;
  if (!facts.cliInstalled) return 'no-cli';
  if (inUse?.signInState === 'expired') return 'expired';
  // The server's reason wins; with none (an old server), the credentials alone decide
  if (inUse === null && facts.inUseReason === 'limit') return 'limit';
  const signedIn = inUse !== null || facts.accounts.some((a) => a.enabled && a.signedIn);
  if (!signedIn || (inUse === null && facts.inUseReason === 'signed-out')) return 'signed-out';
  if (!provider || provider.state === 'ready') return 'ready';
  if (provider.state === 'degraded') return provider.reason === 'limit-reached' ? 'limit' : provider.reason === 'limit-near' ? 'near' : 'unready';
  if (provider.state === 'unknown') return 'unchecked';
  // Any other state is the provider's own word (`providers:state.*`), never "not signed in"
  return 'unready';
}
