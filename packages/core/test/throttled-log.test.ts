import assert from 'node:assert/strict';
import test from 'node:test';
import { ThrottledLog } from '../src/throttled-log.ts';

test('a failure that repeats on every save is said once per interval, with how many were held back', () => {
  const lines: string[] = [];
  let clock = 0;
  const log = new ThrottledLog('chats: saving the chats', 60_000, (line) => lines.push(line), () => clock);
  log.failed(new Error('database is locked'));
  clock = 1_000;
  log.failed(new Error('database is locked'));
  log.failed(new Error('database is locked'));
  assert.deepEqual(lines, ['chats: saving the chats failed: database is locked']);
  clock = 61_000;
  log.failed(new Error('disk I/O error'));
  assert.equal(lines.at(-1), 'chats: saving the chats failed (and 2 more times since the last report): disk I/O error');
});
