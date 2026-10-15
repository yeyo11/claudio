import type { Account } from '@claudio/shared';

/**
 * Whether every account that could take new work is at its limit, with the reset ahead or unknown.
 * Claude's provider-wide limit is the reading of whichever account ran last, so it cannot say this:
 * one account at its limit leaves Claude able to work while another has room. No ready account at
 * all is not a limit (signed out says so in its own words).
 */
export function accountsAtLimit(accounts: ReadonlyArray<Pick<Account, 'enabled' | 'signedIn' | 'limits'>>, now: number = Date.now()): boolean {
  const ready = accounts.filter((a) => a.enabled && a.signedIn);
  const out = (limit: Account['limits']): boolean => limit?.state === 'exhausted' && (limit.resetsAt === null || Date.parse(limit.resetsAt) > now);
  return ready.length > 0 && ready.every((a) => out(a.limits));
}
