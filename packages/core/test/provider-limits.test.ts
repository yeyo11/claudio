import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountLimit } from '@claudio/shared';
import { providerLimitOf } from '../src/providers/limits.ts';

/*
 * A provider's limit is the reading of the account in use, no reading of its own (D2 of
 * docs/plans/regression-fixes-2026-10-29.md). Which account is in use, and what Claude's status says
 * at the limit, is the account view's: account-view.test.ts.
 */

const T0 = Date.parse('2026-10-29T10:00:00.000Z');

const reading = (extra: Partial<AccountLimit> = {}): AccountLimit => ({
  state: 'near',
  window: 'five_hour',
  utilization: 0.7,
  resetsAt: new Date(T0 + 3_600_000).toISOString(),
  windows: { five_hour: { utilization: 0.7, resetsAt: Math.floor(T0 / 1000) + 3600 } },
  observedAt: new Date(T0).toISOString(),
  source: 'stream',
  ...extra,
});

describe('providerLimitOf', () => {
  it('is the account\'s reading as it stands: state, binding window, use, reset and windows', () => {
    const limit = providerLimitOf('claude-code', reading());
    assert.deepEqual(limit, {
      provider: 'claude-code',
      state: 'near',
      window: 'five_hour',
      utilization: 0.7,
      resetsAt: new Date(T0 + 3_600_000).toISOString(),
      windows: { five_hour: { utilization: 0.7, resetsAt: Math.floor(T0 / 1000) + 3600 } },
      observedAt: new Date(T0).toISOString(),
      source: 'stream',
    });
  });

  it('names a read that spent nothing a probe, and keeps a failure a failure', () => {
    assert.equal(providerLimitOf('claude-code', reading({ source: 'cli' }))?.source, 'probe');
    assert.equal(providerLimitOf('claude-code', reading({ source: 'cache' }))?.source, 'probe');
    assert.equal(providerLimitOf('claude-code', reading({ source: 'failure' }))?.source, 'failure');
  });

  it('is nothing when the account has no reading', () => {
    assert.equal(providerLimitOf('claude-code', null), null);
  });
});
