import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountCredits, AccountLimit } from '@claudio/shared';
import { creditsCapReached, creditsSettingOf, overageHint } from '../src/index.ts';

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
