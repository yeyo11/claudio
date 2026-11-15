import type { AccountCreditsSetting, AccountLimit, AccountLimitState, AccountsSettings, RateLimitInfo } from '@claudio/shared';

/*
 * The one place the account thresholds live. Before 2026-10-29 an account was `near` at 0.75 by its
 * own reading, at 0.6 by the provider-wide one, and the bars turned at 0.6 and 0.75: the status bar
 * said "near the limit" for an account its own card drew as fine. The rotation threshold is not here:
 * it is the person's setting (`AccountsSettings.threshold`, or a policy's).
 *
 * No Node import: the web reads this module too (`@claudio/accounts/thresholds`).
 */

/** From this use of the binding window an account is `near` its limit: where the bars turn warn. */
export const NEAR = 0.6;
/** At this use the window is spent. */
export const EXHAUSTED = 1;
/** A usage bar is neutral below this share, warn from it. */
export const BAR_WARN = 0.6;
/** A usage bar is bad from this share, and when the account is exhausted. */
export const BAR_BAD = 0.75;

/** The tone of a usage bar for a share of 0..1. */
export function barTone(utilization: number, exhausted = false): 'neutral' | 'warn' | 'bad' {
  if (exhausted || utilization >= BAR_BAD) return 'bad';
  return utilization >= BAR_WARN ? 'warn' : 'neutral';
}

/**
 * Whether an account's reading says it is out at `now`: exhausted, with its reset still ahead or not
 * known. The one definition of "out" the choice, the account view and the decision route share.
 */
export function isOut(limit: Pick<AccountLimit, 'state' | 'resetsAt'> | null | undefined, now: number): boolean {
  if (!limit || limit.state !== 'exhausted') return false;
  return limit.resetsAt === null || Date.parse(limit.resetsAt) > now;
}

/** When an out account comes back (epoch ms); null when it is not out or its reset is unknown. */
export function outUntil(limit: Pick<AccountLimit, 'state' | 'resetsAt'> | null | undefined, now: number): number | null {
  if (!isOut(limit, now) || !limit?.resetsAt) return null;
  return Date.parse(limit.resetsAt);
}

/**
 * The account's state as a person reads it: `overage` where the plan is spent and its credits cover
 * what runs there (`creditsCover`), else the folded state. Such an account is still out for
 * {@link isOut}: whether work may spend its credits is the account's credits setting, which only
 * `choose` reads.
 */
export function accountState(limit: Pick<AccountLimit, 'state' | 'creditsCover'> | null | undefined): AccountLimitState {
  if (!limit) return 'unknown';
  return limit.state === 'exhausted' && limit.creditsCover === true ? 'overage' : limit.state;
}

/** An account the credits setting does not name: its credits are never spent (D3 of docs/plans/limit-resume-and-credits.md) */
const NEVER: AccountCreditsSetting = { use: 'never', capMinor: null };

/** The credits setting of an account, `never` where the settings do not name it. */
export function creditsSettingOf(settings: Pick<AccountsSettings, 'credits'>, id: string): AccountCreditsSetting {
  return settings.credits[id] ?? NEVER;
}

/**
 * Whether Claudio's own cap (D5) stops the account's credits: a cap is set and the month's spend
 * reached it, or nobody knows the spend (`get_usage` never said it), since money is never spent on a
 * guess. The same rule `choose` applies before work starts there.
 */
export function creditsCapReached(limit: Pick<AccountLimit, 'cli'> | null | undefined, setting: AccountCreditsSetting): boolean {
  if (setting.capMinor === null) return false;
  const spent = limit?.cli?.credits?.usedMinor;
  return spent === undefined || spent >= setting.capMinor;
}

const PLAN_WINDOWS = new Set(['five_hour', 'seven_day']);
const COVERING = new Set(['allowed', 'allowed_warning']);

/**
 * Whether a `rate_limit_event` hints that the turn now runs on usage credits: `isUsingOverage`, or an
 * `overageStatus` that covers (`allowed`, `allowed_warning`) beside a spent plan window. A hint only
 * (docs/decisions/credits-in-the-stream.md): the fields are typed with no meaning and no recorded
 * event ever had them so. It is enough to stop a turn whose credits may not be spent, where a false
 * positive costs a move, and never enough to call an account `overage`. An `overageStatus` of
 * `rejected` says credits do not cover, whatever else the event says.
 */
export function overageHint(info: Pick<RateLimitInfo, 'status' | 'rateLimitType' | 'utilization' | 'windows' | 'isUsingOverage' | 'overageStatus'>): boolean {
  if (info.overageStatus === 'rejected') return false;
  if (info.isUsingOverage === true) return true;
  if (!info.overageStatus || !COVERING.has(info.overageStatus)) return false;
  const type = info.rateLimitType ?? '';
  if (info.status === 'rejected' && PLAN_WINDOWS.has(type)) return true;
  if ((info.utilization ?? 0) >= EXHAUSTED && !type.includes('overage')) return true;
  return Object.entries(info.windows).some(([key, w]) => !key.includes('overage') && w.utilization >= EXHAUSTED);
}
