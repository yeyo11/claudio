import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldUsage } from '../src/usage.ts';

let n = 0;

/** One line of a transcript: an assistant message block carrying the whole message's usage. */
function assistant(id: string, model: string, usage: { in: number; out: number; read?: number; create?: number }, extra: object = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `u${++n}`,
    timestamp: '2026-01-01T10:00:00.000Z',
    message: {
      id,
      role: 'assistant',
      model,
      content: [{ type: 'text', text: `block ${n}` }],
      usage: { input_tokens: usage.in, output_tokens: usage.out, cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.create ?? 0 },
    },
    ...extra,
  };
}

const user = (text: string): Record<string, unknown> => ({ type: 'user', uuid: `u${++n}`, message: { role: 'user', content: text } });

test('a message written as several blocks is counted once, from its last line', () => {
  const fold = foldUsage([
    user('go'),
    assistant('m1', 'claude-opus-5', { in: 10, out: 1, read: 100 }),
    assistant('m1', 'claude-opus-5', { in: 10, out: 40, read: 100 }),
    assistant('m1', 'claude-opus-5', { in: 10, out: 90, read: 100 }),
  ]);
  assert.deepEqual(fold.total(), { input: 10, output: 90, cacheRead: 100, cacheCreation: 0, total: 200 });
});

test('context is the last response, not a sum, so it drops when the CLI compacts', () => {
  const before = foldUsage([
    assistant('m1', 'claude-opus-5', { in: 5, out: 5, read: 90_000 }),
    assistant('m2', 'claude-opus-5', { in: 5, out: 5, read: 150_000, create: 1_000 }),
  ]);
  assert.deepEqual(before.context(), { used: 151_005, model: 'claude-opus-5' });
  const after = foldUsage([
    assistant('m1', 'claude-opus-5', { in: 5, out: 5, read: 150_000 }),
    assistant('m2', 'claude-opus-5', { in: 5, out: 5, read: 20_000 }), // compacted
  ]);
  assert.equal(after.context()?.used, 20_005);
  // What was paid for does not drop
  assert.equal(after.total().total, 5 + 5 + 150_000 + 5 + 5 + 20_000);
});

test('a subagent is spent but does not fill the chat context', () => {
  const fold = foldUsage([
    assistant('m1', 'claude-opus-5', { in: 1, out: 1, read: 30_000 }),
    assistant('s1', 'claude-haiku-4-5', { in: 1, out: 1, read: 500_000 }, { isSidechain: true }),
  ]);
  assert.deepEqual(fold.context(), { used: 30_001, model: 'claude-opus-5' });
  assert.equal(fold.total().cacheRead, 530_000);
});

test('tokens are kept per model, with the variant suffix whole', () => {
  const fold = foldUsage([
    assistant('m1', 'claude-opus-5', { in: 1, out: 2 }),
    assistant('m2', 'claude-opus-5[1m]', { in: 10, out: 20 }),
    assistant('m3', 'claude-opus-5', { in: 100, out: 200 }),
  ]);
  assert.deepEqual(
    fold.tokens().map((t) => [t.model, t.input, t.output, t.total]),
    [
      ['claude-opus-5', 101, 202, 303],
      ['claude-opus-5[1m]', 10, 20, 30],
    ],
  );
});

test("the CLI's placeholder messages say nothing about the context or the model", () => {
  const fold = foldUsage([assistant('m1', 'claude-opus-5', { in: 2, out: 2, read: 1_000 }), assistant('x', '<synthetic>', { in: 0, out: 0 })]);
  assert.deepEqual(fold.context(), { used: 1_002, model: 'claude-opus-5' });
  assert.deepEqual(fold.tokens().map((t) => t.model), ['claude-opus-5', null]);
});

test('a transcript with no response has no context and no tokens', () => {
  const fold = foldUsage([user('hello')]);
  assert.equal(fold.context(), null);
  assert.deepEqual(fold.tokens(), []);
  assert.equal(fold.total().total, 0);
});

// ---------- compaction ----------

const boundary = (at: string, post: number | null = 1_200): Record<string, unknown> => ({
  type: 'system',
  subtype: 'compact_boundary',
  uuid: `b${++n}`,
  timestamp: at,
  compactMetadata: { trigger: 'manual', preTokens: 142_000, ...(post === null ? {} : { postTokens: post }) },
});

test('a boundary newer than the last response says what the context dropped to, until the next response', () => {
  const lines = [assistant('m1', 'claude-opus-5', { in: 5, out: 5, read: 142_000 }), boundary('2026-01-01T10:05:00.000Z')];
  const after = foldUsage(lines).context();
  assert.equal(after?.used, 142_005, 'the last response is still what was read');
  assert.deepEqual(after?.compactedSince, { at: '2026-01-01T10:05:00.000Z', trigger: 'manual', preTokens: 142_000, postTokens: 1_200 });

  const answered = foldUsage([...lines, assistant('m2', 'claude-opus-5', { in: 5, out: 5, read: 3_000 })]).context();
  assert.equal(answered?.used, 3_005);
  assert.equal(answered?.compactedSince, undefined, 'the next response is the new figure');
});

test('a boundary without post tokens is kept, and the figure stays null rather than invented', () => {
  const context = foldUsage([assistant('m1', 'claude-opus-5', { in: 1, out: 1, read: 10 }), boundary('2026-01-01T10:05:00.000Z', null)]).context();
  assert.equal(context?.compactedSince?.postTokens, null);
});

test("a subagent's own compaction says nothing about the main window", () => {
  const fold = foldUsage([assistant('m1', 'claude-opus-5', { in: 1, out: 1, read: 10 })]);
  const entry = { uuid: 'bs', role: 'user' as const, timestamp: '2026-01-01T10:05:00.000Z', model: null, isSidechain: true, parentToolUseId: null, blocks: [], compaction: { part: 'boundary' as const, trigger: 'auto' as const, preTokens: 9, postTokens: 1, durationMs: null } };
  fold.add({}, entry);
  assert.equal(fold.context()?.compactedSince, undefined);
});

test('a cloned fold keeps the boundary it saw', () => {
  const fold = foldUsage([assistant('m1', 'claude-opus-5', { in: 1, out: 1, read: 10 }), boundary('2026-01-01T10:05:00.000Z')]);
  assert.equal(fold.clone().context()?.compactedSince?.preTokens, 142_000);
});
