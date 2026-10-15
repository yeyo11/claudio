import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat, ChatDetail, TranscriptEntry } from '@agentry/shared';
import { appendStreamed, dropOptimistic, isOptimistic, optimisticEntry, spliceTail } from '../src/lib/chat-stream';

const entry = (uuid: string, role: 'user' | 'assistant', text: string, timestamp: string): TranscriptEntry => ({
  uuid,
  role,
  timestamp,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text }],
});

const pageOf = (entries: TranscriptEntry[]): ChatDetail => ({ chat: {} as Chat, entries, from: 0, total: entries.length, stream: null });

test("the server's copy of an optimistic message takes its place, at the same index", () => {
  const before = entry('a1', 'assistant', 'hello', '2026-01-01T00:00:00.000Z');
  const mine = optimisticEntry('u1', 'next', new Date('2026-01-01T00:00:05.000Z'));
  const { page } = appendStreamed(pageOf([before]), mine);
  assert.equal(page.entries.length, 2);
  const server = entry('u1', 'user', 'next', '2026-01-01T00:00:04.000Z');
  const result = appendStreamed(page, server);
  assert.equal(result.page.entries.length, 2);
  assert.equal(result.page.entries[1], server);
  assert.equal(result.page.total, 2);
  assert.equal(isOptimistic(server), false);
});

test('a read that holds the optimistic message confirms it and keeps one', () => {
  const before = entry('a1', 'assistant', 'hello', '2026-01-01T00:00:00.000Z');
  const { page } = appendStreamed(pageOf([before]), optimisticEntry('u2', 'again', new Date('2026-01-01T00:00:05.000Z')));
  const fresh = pageOf([before, entry('u2', 'user', 'again', '2026-01-01T00:00:05.000Z')]);
  const spliced = spliceTail(page, fresh, 0, Date.now());
  assert.ok(spliced);
  assert.deepEqual(
    spliced.entries.map((e) => e.uuid),
    ['a1', 'u2'],
  );
});

test('dropOptimistic removes only optimistic entries', () => {
  const real = entry('u3', 'user', 'kept', '2026-01-01T00:00:00.000Z');
  const mine = optimisticEntry('u4', 'gone', new Date('2026-01-01T00:00:05.000Z'));
  const { page } = appendStreamed(pageOf([real]), mine);
  const dropped = dropOptimistic(page, 'u4');
  assert.deepEqual(
    dropped.entries.map((e) => e.uuid),
    ['u3'],
  );
  assert.equal(dropped.total, 1);
  assert.equal(dropOptimistic(dropped, 'u3'), dropped);
});

test("a resume's optimistic message is replaced by the server entry with the same words and another uuid", () => {
  const { page } = appendStreamed(pageOf([]), optimisticEntry('optimistic-1', 'go on', new Date('2026-01-01T00:00:05.000Z')));
  const server = entry('server-uuid', 'user', 'go on', '2026-01-01T00:00:04.000Z');
  const result = appendStreamed(page, server);
  assert.equal(result.page.entries.length, 1);
  assert.equal(result.page.entries[0], server);
});
