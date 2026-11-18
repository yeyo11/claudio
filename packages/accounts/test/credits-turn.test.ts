import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountCredits, AccountLimit } from '@claudio/shared';
import { accountState, creditsCapReached, creditsMayPay, creditsSettingOf, overageHint, parseUsage, planSpent, readingFromEvent, Readings, type Reading } from '../src/index.ts';

/*
 * What decides whether a running turn may go on paying from credits (t7 of
 * docs/plans/limit-resume-and-credits.md): the stream's overage hint, the account's credits setting
 * and Claudio's cap. Events are built from the SDK's typings; no paid turn was ever recorded.
 */

const windows = (utilization: number) => ({ five_hour: { utilization, resetsAt: 1_800_000_000 } });

describe('overage hint', () => {
  it('reads isUsingOverage as a turn on credits', () => {
    assert.equal(overageHint({ status: 'allowed', windows: windows(0.4), isUsingOverage: true }), true);
  });

  it('reads a covering overage status beside a spent plan window as a turn on credits', () => {
    assert.equal(overageHint({ status: 'allowed', windows: windows(1), overageStatus: 'allowed' }), true);
    assert.equal(overageHint({ status: 'rejected', rateLimitType: 'five_hour', windows: {}, overageStatus: 'allowed_warning' }), true);
  });

  it('does not read a covering status with room left in the plan as a turn on credits', () => {
    assert.equal(overageHint({ status: 'allowed', windows: windows(0.5), overageStatus: 'allowed' }), false);
  });

  it('never reads an overage status of rejected as credits paying, whatever else the event says', () => {
    assert.equal(overageHint({ status: 'rejected', rateLimitType: 'five_hour', windows: windows(1), isUsingOverage: true, overageStatus: 'rejected' }), false);
  });

  it('does not read a rejection that reports its window with room left as a turn on credits (2026-11-16, 19:05Z)', () => {
    assert.equal(overageHint({ status: 'rejected', rateLimitType: 'five_hour', utilization: 0.83, windows: windows(0.83), isUsingOverage: false, overageStatus: 'allowed' }), false);
    assert.equal(overageHint({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1.01, windows: windows(1.01), overageStatus: 'allowed' }), true);
  });

  it('reads the recorded events of an account with credits off as no hint', () => {
    assert.equal(overageHint({ status: 'allowed', rateLimitType: 'five_hour', windows: windows(1), isUsingOverage: false, overageStatus: 'rejected' }), false);
  });
});

describe("Claudio's credits cap", () => {
  const credits = (usedMinor: number): Pick<AccountLimit, 'cli'> => ({
    cli: { observedAt: '2026-11-15T00:00:00Z', available: true, plan: null, scoped: [], credits: { enabled: true, usedMinor, limitMinor: 4000, currency: 'USD', exponent: 2, limitReached: false, disabledReason: null, everEnabled: true } satisfies AccountCredits },
  });

  it('stops nothing without a cap', () => {
    assert.equal(creditsCapReached(null, { use: 'allow', capMinor: null }), false);
  });

  it('is reached once the month spent the cap, and not before', () => {
    assert.equal(creditsCapReached(credits(499), { use: 'allow', capMinor: 500 }), false);
    assert.equal(creditsCapReached(credits(500), { use: 'allow', capMinor: 500 }), true);
  });

  it('counts as reached while nobody knows what the month spent', () => {
    assert.equal(creditsCapReached(null, { use: 'last-resort', capMinor: 500 }), true);
  });

  it('reads an account the settings do not name as never', () => {
    assert.deepEqual(creditsSettingOf({ credits: {} }, 'acc-1'), { use: 'never', capMinor: null });
  });
});

describe('whether credits may pay for the work on an account (the 2026-11-16 leak)', () => {
  // The sequence a second machine recorded on 2026-11-16 (docs/reports/credits-never-leak-2026-11-16.md):
  // a get_usage answer with credits on, then the stream's five-hour window at 1.00 and 1.01, `allowed`,
  // `isUsingOverage: false`, while the CLI kept working for 25 minutes
  const NOW = Date.parse('2026-11-16T16:46:41Z');
  const RESET = Math.floor(Date.parse('2026-11-16T17:10:00Z') / 1000);
  const usage = (at: number, enabled: boolean): Reading =>
    parseUsage(
      {
        subscription_type: 'team',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 31, resets_at: new Date(RESET * 1000).toISOString() },
          seven_day: { utilization: 58, resets_at: '2026-11-16T19:00:00Z' },
          extra_usage: { is_enabled: enabled, monthly_limit: 10000, used_credits: 3000, utilization: null, currency: 'EUR' },
        },
      },
      at,
    );
  const event = (at: number, utilization: number, extra: Record<string, unknown>): Reading =>
    readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: RESET, utilization, unifiedWindows: { five_hour: { utilization, resetsAt: RESET }, seven_day: { utilization: 0.62, resetsAt: RESET + 7000 } }, ...extra }, at) ?? assert.fail('no reading');
  const after = async (...rs: Reading[]): Promise<AccountLimit> => {
    const kept = new Readings(null);
    for (const r of rs) await kept.observe('default', r);
    return kept.limit('default', NOW) ?? assert.fail('no reading');
  };
  const SINCE_REFRESH = 88 * 60_000;

  it('says yes once the plan window reads 1.00 and 1.01 with credits on, though the event says isUsingOverage false', async () => {
    const limit = await after(usage(NOW - SINCE_REFRESH, true), event(NOW - 60_000, 1, { isUsingOverage: false, overageStatus: 'allowed' }), event(NOW, 1.01, { isUsingOverage: false, overageStatus: 'allowed' }));
    assert.equal(limit.state, 'exhausted');
    assert.equal(creditsMayPay(limit, NOW), true);
  });

  it('says yes from get_usage alone when the events carry no overage field at all', async () => {
    const limit = await after(usage(NOW - SINCE_REFRESH, true), event(NOW, 1.01, {}));
    assert.equal(creditsMayPay(limit, NOW), true);
  });

  it('says yes from the stream when the last get_usage, older, said credits were off', async () => {
    const limit = await after(usage(NOW - SINCE_REFRESH, false), event(NOW, 1.01, { isUsingOverage: false, overageStatus: 'allowed' }));
    assert.equal(accountState(limit), 'exhausted', 'not the overage state: no get_usage says credits cover');
    assert.equal(creditsMayPay(limit, NOW), true);
  });

  it('says no while the plan has room, with credits on', async () => {
    const limit = await after(usage(NOW - SINCE_REFRESH, true), event(NOW, 0.99, { overageStatus: 'allowed' }));
    assert.equal(creditsMayPay(limit, NOW), false);
  });

  it('says no where the latest word is that credits are off', async () => {
    assert.equal(creditsMayPay(await after(event(NOW, 1.01, { isUsingOverage: false, overageStatus: 'rejected' })), NOW), false);
    assert.equal(creditsMayPay(await after(usage(NOW - SINCE_REFRESH, false), event(NOW, 1.01, { overageStatus: 'rejected' })), NOW), false);
    assert.equal(creditsMayPay(await after(event(NOW - 1000, 1.01, { overageStatus: 'allowed' }), usage(NOW, false)), NOW), false);
  });

  it('says no where nobody ever said whether credits are on', async () => {
    assert.equal(creditsMayPay(await after(event(NOW, 1.01, {})), NOW), false);
  });

  it('does not read a rejection that credits cover, with the window at 83 %, as the account out (19:05Z)', async () => {
    const r = readingFromEvent({ status: 'rejected', rateLimitType: 'five_hour', utilization: 0.83, isUsingOverage: false, overageStatus: 'allowed', unifiedWindows: { five_hour: { utilization: 0.83, resetsAt: RESET } } }, NOW) ?? assert.fail('no reading');
    const limit = await after(usage(NOW - 60_000, true), r);
    assert.equal(limit.state, 'near');
    assert.equal(creditsMayPay(limit, NOW), false);
  });

  it('reads a spent window from get_usage or the CLI cache as well as from the stream', () => {
    assert.equal(planSpent({ windows: { five_hour: { utilization: 1.01, resetsAt: RESET } } }, NOW), true);
    assert.equal(planSpent({ windows: { five_hour: { utilization: 1.01, resetsAt: RESET } } }, RESET * 1000), false, 'not past its reset');
    assert.equal(planSpent({ windows: { seven_day: { utilization: 1, resetsAt: RESET } } }, NOW), true);
  });
});
