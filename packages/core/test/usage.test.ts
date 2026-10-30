import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessage } from '@claudio/shared';
import { foldUsage, OPEN_MESSAGES, UsageFold } from '../src/usage.ts';

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

// ---------- a fold kept beside its transcript ----------

/** A long session: messages over several days and models, a few written as several blocks, a subagent's among them. */
function longSession(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < OPEN_MESSAGES * 3; i++) {
    const day = `2026-01-0${String(1 + (i % 3))}T10:00:00.000Z`;
    const model = i % 5 === 0 ? 'claude-haiku-4-5' : 'claude-opus-5';
    const extra = { timestamp: day, ...(i % 7 === 0 ? { isSidechain: true } : {}) };
    lines.push(assistant(`m${i}`, model, { in: i, out: 1, read: 100 + i }, extra));
    // The same message again, with its final figures: counted once, from this line
    if (i % 4 === 0) lines.push(assistant(`m${i}`, model, { in: i, out: 9, read: 100 + i }, extra));
    if (i === OPEN_MESSAGES * 2) lines.push(boundary('2026-01-03T10:00:00.000Z'));
  }
  return lines;
}

test('a fold of more messages than it keeps one by one counts every message once, from its last line', () => {
  const lines = longSession();
  const fold = foldUsage(lines);
  // What a sum by message id over the whole transcript says, with nothing settled
  const last = new Map<string, Record<string, unknown>>();
  for (const l of lines) if (l.type === 'assistant') last.set(String((l.message as { id: string }).id), l);
  const expected = [...last.values()].reduce<number>((sum, l) => {
    const u = (l.message as { usage: Record<string, number> }).usage;
    return sum + (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }, 0);
  assert.equal(fold.total().total, expected);
  assert.equal(fold.tokens().reduce((sum, t) => sum + t.total, 0), expected);
  assert.equal(fold.days().reduce((sum, d) => sum + d.total, 0), expected);
  assert.deepEqual(fold.tokens().map((t) => t.model), ['claude-haiku-4-5', 'claude-opus-5'], 'models in the order they were first used');
});

test('a fold stored as JSON and read back goes on exactly as the fold that was never stored', () => {
  const lines = longSession();
  const whole = foldUsage(lines);
  const half = Math.floor(lines.length / 2);
  const stored = JSON.parse(JSON.stringify(foldUsage(lines.slice(0, half)).toJSON())) as ReturnType<UsageFold['toJSON']>;
  const restored = UsageFold.fromJSON(stored);
  for (const line of lines.slice(half)) {
    const entry = normalizeMessage(line);
    if (entry) restored.add(line, entry);
  }
  assert.deepEqual(restored.snapshot(), whole.snapshot());
  assert.deepEqual(restored.clone().snapshot(), whole.snapshot());
});
