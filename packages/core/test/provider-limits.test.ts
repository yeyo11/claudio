import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProviderLimit, RateLimitInfo } from '@claudio/shared';
import type { DriverEvent } from '../src/providers/driver.ts';
import { LIMIT_WRITE_GAP_MS, ProviderLimits, limitFromInfo, type ProviderLimitStore } from '../src/providers/limits.ts';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const seconds = (ms: number): number => Math.floor(ms / 1000);

function memory() {
  const rows = new Map<string, ProviderLimit>();
  let writes = 0;
  const store: ProviderLimitStore = {
    upsertProviderLimit: (l) => {
      writes += 1;
      const old = rows.get(l.provider);
      if (old && old.observedAt > l.observedAt) return false;
      rows.set(l.provider, l);
      return true;
    },
    providerLimit: (p) => rows.get(p) ?? null,
    providerLimits: () => [...rows.values()],
  };
  return { store, writes: () => writes };
}

function clock(start = T0) {
  let at = start;
  return { now: () => at, tick: (ms: number) => void (at += ms) };
}

/** Claude's `rate_limit_event` as the stream driver emits it */
const claude = (status: string, windows: RateLimitInfo['windows'], rateLimitType?: string): RateLimitInfo => ({
  status,
  ...(rateLimitType ? { rateLimitType } : {}),
  windows,
  observedAt: new Date(T0).toISOString(),
});

const usedInfo = (used: number, resetsAt: number): RateLimitInfo =>
  claude(used >= 100 ? 'rejected' : 'allowed', { '5h': { utilization: used / 100, resetsAt } });

/** A real rejection, with its window spent until an hour on */
const rejected: DriverEvent = { kind: 'rate-limit', info: usedInfo(100, seconds(T0 + 3_600_000)) };

describe('limitFromInfo', () => {
  const reset = seconds(T0 + 3_600_000);

  it('Claude: a window under 60 % is ok, and the most used window binds', () => {
    const limit = limitFromInfo('claude-code', claude('allowed', { '5h': { utilization: 0.3, resetsAt: reset }, '7d': { utilization: 0.5, resetsAt: reset + 100 } }), 'stream', 'x');
    assert.deepEqual([limit.state, limit.window, limit.utilization], ['ok', '7d', 0.5]);
    assert.equal(limit.resetsAt, new Date((reset + 100) * 1000).toISOString());
  });

  it('Claude: allowed_warning, or a binding window from 60 %, is near', () => {
    assert.equal(limitFromInfo('claude-code', claude('allowed_warning', { '5h': { utilization: 0.2, resetsAt: reset } }), 'stream', 'x').state, 'near');
    assert.equal(limitFromInfo('claude-code', claude('allowed', { '5h': { utilization: 0.6, resetsAt: reset } }), 'stream', 'x').state, 'near');
  });

  it('Claude: rejected is exhausted and its own window binds', () => {
    const limit = limitFromInfo('claude-code', claude('rejected', { '5h': { utilization: 1, resetsAt: reset }, '7d': { utilization: 0.9, resetsAt: reset + 9 } }, '7d'), 'stream', 'x');
    assert.deepEqual([limit.state, limit.window], ['exhausted', '7d']);
  });

  it('Claude: no windows and an unrecognised status is unknown, never ok', () => {
    assert.equal(limitFromInfo('claude-code', claude('', {}), 'stream', 'x').state, 'unknown');
  });

  it('a turn that died on the limit leaves the last reading as it stands', () => {
    const time = clock();
    const limits = new ProviderLimits(memory().store, time.now);
    limits.observe('claude-code', { kind: 'rate-limit', info: claude('allowed_warning', { '5h': { utilization: 0.9, resetsAt: seconds(T0 + 600_000) } }) });
    time.tick(1000);
    limits.observe('claude-code', { kind: 'result', rateLimited: true } as DriverEvent);
    const after = limits.get('claude-code');
    assert.deepEqual([after?.state, after?.source, after?.utilization], ['near', 'stream', 0.9]);
    assert.equal(after?.resetsAt, new Date(T0 + 600_000).toISOString());
  });

  it('a turn that died on the limit with no reading invents none: no 100 %, no reset', () => {
    const limits = new ProviderLimits(memory().store, clock().now);
    limits.observe('claude-code', { kind: 'result', rateLimited: true } as DriverEvent);
    assert.equal(limits.get('claude-code'), null);
  });

  it('a rejected report with only its window and reset is exhausted until that reset, with no use drawn', () => {
    const time = clock();
    const limits = new ProviderLimits(memory().store, time.now);
    const resetsAt = seconds(T0 + 600_000);
    limits.observe('claude-code', { kind: 'rate-limit', info: { ...claude('rejected', {}, 'five_hour'), resetsAt } });
    const out = limits.get('claude-code');
    assert.deepEqual([out?.state, out?.window, out?.utilization, out?.resetsAt], ['exhausted', 'five_hour', null, new Date(resetsAt * 1000).toISOString()]);
    time.tick(601_000);
    assert.equal(limits.get('claude-code')?.state, 'unknown');
  });

  it('a reset in the past reads unknown, and a new reading replaces it', () => {
    const time = clock();
    const limits = new ProviderLimits(memory().store, time.now);
    limits.observe('other', { kind: 'rate-limit', info: usedInfo(100, seconds(T0 + 60_000)) });
    assert.equal(limits.get('other')?.state, 'exhausted');
    time.tick(61_000);
    const after = limits.get('other');
    assert.deepEqual([after?.state, after?.utilization], ['unknown', null]);
    assert.equal(limits.raw('other')?.state, 'exhausted', 'the stored reading stands until a new one');
    limits.observeProbe('other', usedInfo(5, seconds(T0 + 20_000_000)));
    assert.deepEqual([limits.get('other')?.state, limits.get('other')?.source], ['ok', 'probe']);
  });

  it('a stream of events writes on a change of state or window, and otherwise once a minute', () => {
    const { store, writes } = memory();
    const time = clock();
    const limits = new ProviderLimits(store, time.now);
    const event = (used: number): DriverEvent => ({ kind: 'rate-limit', info: claude('allowed', { '5h': { utilization: used, resetsAt: seconds(T0 + 3_600_000) } }) });
    limits.observe('claude-code', event(0.1));
    for (let i = 0; i < 5; i += 1) {
      time.tick(1000);
      limits.observe('claude-code', event(0.1 + i / 100));
    }
    assert.equal(writes(), 1);
    assert.equal(limits.get('claude-code')?.utilization, 0.14, 'memory holds the newest');
    time.tick(1000);
    limits.observe('claude-code', event(0.7));
    assert.equal(writes(), 2, 'near is a change of state');
    time.tick(LIMIT_WRITE_GAP_MS);
    limits.observe('claude-code', event(0.71));
    assert.equal(writes(), 3, 'a minute passed');
  });

  it('shares the row through the store: another process sees it, an older reading never wins', () => {
    const { store } = memory();
    const a = new ProviderLimits(store, clock().now);
    const b = new ProviderLimits(store, clock(T0 + 5000).now);
    a.observe('other', rejected);
    assert.equal(b.get('other')?.state, 'exhausted');
    b.observeProbe('other', usedInfo(5, seconds(T0 + 20_000_000)));
    a.observe('other', rejected); // stamped earlier than b's reading
    assert.equal(b.get('other')?.state, 'ok');
  });

  it('tells a listener when the state changes, once', () => {
    const limits = new ProviderLimits(memory().store, clock().now);
    const seen: string[] = [];
    limits.onChange((l) => seen.push(l.state));
    limits.observe('other', rejected);
    limits.observe('other', rejected);
    assert.deepEqual(seen, ['exhausted']);
  });

  it('lists the readings that stand', () => {
    const limits = new ProviderLimits(memory().store, clock().now);
    limits.observe('other', rejected);
    limits.observe('claude-code', { kind: 'rate-limit', info: claude('allowed', { '5h': { utilization: 0.1, resetsAt: seconds(T0 + 60_000) } }) });
    assert.deepEqual(limits.list().map((l) => l.provider), ['claude-code', 'other']);
  });
});
