import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRST_MS, HighlightScheduler, SETTLE_MS, STREAMING_MAX_CHARS, STREAMING_MS } from '../src/lib/highlight-scheduler.ts';

const scheduler = new HighlightScheduler();

test('the first pass comes soon', () => {
  assert.deepEqual(scheduler.next({ hasResult: false, length: 40 }), { delay: FIRST_MS, restartOnChange: false });
});

test('later passes are throttled while the block grows', () => {
  assert.deepEqual(scheduler.next({ hasResult: true, length: 4000 }), { delay: STREAMING_MS, restartOnChange: false });
});

test('a huge block waits until it settles', () => {
  assert.deepEqual(scheduler.next({ hasResult: false, length: STREAMING_MAX_CHARS + 1 }), { delay: SETTLE_MS, restartOnChange: true });
  assert.deepEqual(scheduler.next({ hasResult: true, length: STREAMING_MAX_CHARS }), { delay: STREAMING_MS, restartOnChange: false });
});
