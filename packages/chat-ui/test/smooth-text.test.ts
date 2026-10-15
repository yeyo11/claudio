import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmoothReveal } from '../src/lib/smooth-text';

const FRAME = 16;

test('steady arrivals are shown trailing the stream by a small, bounded amount', () => {
  const reveal = new SmoothReveal();
  let text = '';
  let shown = '';
  // 0.1 characters per ms for two seconds
  for (let t = 0; t <= 2000; t += FRAME) {
    if (t % 48 === 0) {
      text += 'abcde'.repeat(1).slice(0, 5);
      reveal.push(text, t);
    }
    shown = reveal.step(FRAME);
    assert.ok(shown.length <= text.length);
  }
  const behind = text.length - shown.length;
  assert.ok(behind <= 0.1 * 250 + 20, `trails by ${behind} characters`);
});

test('a burst is drained within about the lag and never trails by more than the cap', () => {
  const reveal = new SmoothReveal();
  reveal.push('x', 0);
  reveal.step(FRAME);
  reveal.push('x'.repeat(2000), 20);
  const first = reveal.step(FRAME);
  assert.ok(2000 - first.length <= 600, 'the backlog is capped');
  let elapsed = FRAME;
  while (!reveal.done && elapsed < 2000) {
    reveal.step(FRAME);
    elapsed += FRAME;
  }
  assert.ok(reveal.done);
  assert.ok(elapsed < 1500, `drained in ${elapsed} ms`);

  const burst = new SmoothReveal();
  burst.push('a', 0);
  burst.step(FRAME);
  burst.push('a'.repeat(500), 20);
  let ms = 0;
  while (!burst.done && ms < 2000) {
    burst.step(FRAME);
    ms += FRAME;
  }
  assert.ok(ms <= 500, `500 characters took ${ms} ms`);
});

test('finish shows the rest within 150 ms of steps', () => {
  const reveal = new SmoothReveal();
  reveal.push('a', 0);
  reveal.step(FRAME);
  reveal.push('a'.repeat(400), 10);
  reveal.finish();
  let ms = 0;
  while (!reveal.done) {
    reveal.step(FRAME);
    ms += FRAME;
    assert.ok(ms <= 150 + FRAME, 'still not done');
  }
});

test('a rewrite that does not continue the text restarts at the common prefix', () => {
  const reveal = new SmoothReveal();
  reveal.push('hello world', 0);
  for (let i = 0; i < 100; i++) reveal.step(FRAME);
  assert.equal(reveal.step(FRAME), 'hello world');
  reveal.push('hello there, friend', 100);
  const out = reveal.step(FRAME);
  assert.ok(out.startsWith('hello '));
  assert.ok(!out.includes('world'));
});

test('step never returns more than the target', () => {
  const reveal = new SmoothReveal();
  reveal.push('abc', 0);
  for (let i = 0; i < 20; i++) assert.ok(reveal.step(1000).length <= 3);
  assert.equal(reveal.step(FRAME), 'abc');
});

test('freshRanges fades the newest text in two steps and leaves older text alone', async () => {
  const { freshRanges } = await import('../src/lib/smooth-text');
  const checkpoints = [
    { length: 10, at: 0 },
    { length: 20, at: 100 },
    { length: 30, at: 250 },
  ];
  assert.deepEqual(freshRanges(checkpoints, 260, 30), [
    { from: 10, to: 20, level: 2 },
    { from: 20, to: 30, level: 1 },
  ]);
  assert.deepEqual(freshRanges(checkpoints, 1000, 30), []);
  // A rendered text shorter than the checkpoints is clamped, never beyond its end
  assert.deepEqual(freshRanges(checkpoints, 260, 25), [
    { from: 10, to: 20, level: 2 },
    { from: 20, to: 25, level: 1 },
  ]);
});
