import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEPTH_MAX, RESULT_BUDGET_CHARS, STRING_MAX_CHARS, render, shrink, type Truncated } from '../src/render.ts';

/*
 * A tool's answer is cut by its structure, never by characters: whatever was too large, what comes
 * out parses, fits the budget, and says what was cut and how to ask for the rest (report §4.1).
 */

const parsed = (json: string): Truncated => JSON.parse(json) as Truncated;

test('a value that fits is its compact JSON, untouched', () => {
  assert.equal(render({ a: 1, b: [1, 2], c: 'x' }), '{"a":1,"b":[1,2],"c":"x"}');
  assert.equal(render(undefined), 'null');
  assert.equal(shrink({ a: 1 }, 100), null);
});

test('a long list is shortened from the end until it fits, and the answer says so with the hint', () => {
  const rows = Array.from({ length: 3_000 }, (_, i) => ({ i, title: `chat ${i}`, text: 'y'.repeat(300) }));
  const out = render(rows, RESULT_BUDGET_CHARS, 'Ask for fewer with limit.');
  assert.ok(out.length <= RESULT_BUDGET_CHARS, `${out.length} chars`);
  const answer = parsed(out);
  const kept = answer.result as Array<{ i: number }>;
  assert.ok(kept.length > 10 && kept.length < 3_000, `${kept.length} kept`);
  assert.deepEqual(kept.slice(0, 3).map((r) => r.i), [0, 1, 2], 'the front of the list is kept');
  assert.deepEqual(answer.truncated, { arrays: 1, strings: 0 });
  assert.equal(answer.hint, 'Ask for fewer with limit.');
});

test('over the budget, strings longer than 2 000 characters are cut with an ellipsis before any list is shortened', () => {
  const out = parsed(render({ body: 'z'.repeat(STRING_MAX_CHARS * 20), short: 'ok' }));
  const result = out.result as { body: string; short: string };
  assert.equal(result.body.length, STRING_MAX_CHARS + 1);
  assert.ok(result.body.endsWith('…'));
  assert.equal(result.short, 'ok');
  assert.equal(out.truncated.strings, 1);
});

test('objects nested deeper than six levels are folded into {"…": true} once the budget asks for it', () => {
  let deep: Record<string, unknown> = { leaf: 'x'.repeat(STRING_MAX_CHARS) };
  for (let i = 0; i < DEPTH_MAX + 3; i++) deep = { child: deep, pad: 'p'.repeat(1_500) };
  const out = parsed(render({ items: Array.from({ length: 30 }, () => deep) }, 20_000));
  assert.ok(JSON.stringify(out).length <= 20_000);
  assert.match(JSON.stringify(out.result), /\{"…":true\}/);
  assert.ok((out.truncated.objects ?? 0) > 0);
});

test('the largest list goes first, and nested lists are cut where they are', () => {
  const value = { small: [1, 2, 3], entries: Array.from({ length: 200 }, (_, i) => ({ i, blocks: Array.from({ length: 20 }, () => 'b'.repeat(100)) })) };
  const out = parsed(render(value, 8_000));
  const result = out.result as { small: number[]; entries: unknown[] };
  assert.deepEqual(result.small, [1, 2, 3], 'a small list is left alone');
  assert.ok(result.entries.length < 200);
  assert.ok(JSON.stringify(out).length <= 8_000);
});

test('whatever the shape, the answer is valid JSON within the budget', () => {
  const shapes: unknown[] = [
    'q'.repeat(100_000),
    Array.from({ length: 50 }, () => 'w'.repeat(5_000)),
    { a: { b: { c: { d: { e: { f: { g: { h: Array.from({ length: 500 }, (_, i) => ({ i, s: 's'.repeat(400) })) } } } } } } } },
    Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 'n'.repeat(100)))),
  ];
  for (const [i, shape] of shapes.entries()) {
    for (const budget of [RESULT_BUDGET_CHARS, 4_000, 1_200]) {
      const out = render(shape, budget);
      assert.ok(out.length <= budget, `shape ${i} at ${budget}: ${out.length}`);
      assert.doesNotThrow(() => JSON.parse(out), `shape ${i} at ${budget}`);
    }
  }
});
