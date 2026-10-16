import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Execution } from '@claudio/shared';
import { limitedTail } from '../src/chats.ts';
import { emptyTokenUsage } from '../src/usage.ts';

const exec = (account: string | null, cause?: 'rate-limit'): Execution => ({
  id: `e-${account ?? 'none'}-${cause ?? 'ok'}`,
  startedAt: '2026-10-16T10:00:00.000Z',
  endedAt: '2026-10-16T10:01:00.000Z',
  outcome: cause ? 'failed' : 'completed',
  error: null,
  permissionMode: 'acceptEdits',
  model: null,
  account,
  maxBudgetUsd: null,
  costUsd: null,
  tokens: emptyTokenUsage(),
  turns: 1,
  ...(cause ? { cause } : {}),
});

// The accounts a chat's latest attempts died on are recovered from the record, so a restart does
// not send the chat back to an account that just failed
test('the trailing limit failures name the accounts they died on, newest first, and stop at the first attempt that did not', () => {
  assert.deepEqual(limitedTail([exec('a', 'rate-limit'), exec('b', 'rate-limit')]), ['b', 'a']);
  assert.deepEqual(limitedTail([exec('a', 'rate-limit'), exec('b')]), [], 'a finished attempt ends the run');
  assert.deepEqual(limitedTail([exec('a', 'rate-limit'), exec('b'), exec('c', 'rate-limit')]), ['c']);
  assert.deepEqual(limitedTail([exec(null, 'rate-limit')]), [], 'the CLI default account has no id to pass over');
  assert.deepEqual(limitedTail([]), []);
});
