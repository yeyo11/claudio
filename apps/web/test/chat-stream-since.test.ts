import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat, ChatDetail } from '@claudio/shared';
import { streamSince } from '@claudio/chat-ui/lib/chats';

// Where a chat's stream opens decides whether the person's own message and the first blocks of a
// fresh execution are replayed, and whether a long chat is replayed at all.

const now = Date.parse('2026-10-15T10:00:00Z');
const detail = (startedAt: string | null, stream: ChatDetail['stream'] = { seq: 90, executionSeq: 40 }): ChatDetail => ({
  chat: { execution: startedAt ? { startedAt } : null } as Chat,
  entries: [],
  from: 0,
  total: 0,
  stream,
});

test('a reconnect resumes after what it already saw', () => {
  assert.equal(streamSince(7, detail(null), now), 7);
});

test('a fresh execution is replayed whole', () => {
  assert.equal(streamSince(0, detail('2026-10-15T09:59:30Z'), now), 40);
});

test('an old execution or none starts where the read ended', () => {
  assert.equal(streamSince(0, detail('2026-10-15T09:00:00Z'), now), 90);
  assert.equal(streamSince(0, detail(null), now), 90);
});

test('without a position the stream opens at the end', () => {
  assert.equal(streamSince(0, undefined, now), Number.MAX_SAFE_INTEGER);
  assert.equal(streamSince(0, detail(null, null), now), Number.MAX_SAFE_INTEGER);
});
