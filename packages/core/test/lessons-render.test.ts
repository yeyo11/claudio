import assert from 'node:assert/strict';
import test from 'node:test';
import type { Lesson } from '@claudio/shared';
import { dueLessons, orderLessons, renderSection } from '../src/lessons/render.ts';

const lesson = (n: number, over: Partial<Lesson> = {}): Lesson =>
  ({
    id: `id-${n}`,
    key: `L-${n}`,
    projectId: 'p1',
    status: 'active',
    trigger: 'When adding a dependency',
    action: 'use `pnpm`, never `npm` or `yarn`.',
    confidence: 0.9,
    effectiveConfidence: 0.9,
    delivered: true,
    seenCount: 1,
    pinned: false,
    overrides: null,
    lastConfirmedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }) as Lesson;

test('the section is written exactly as the plan shows it', () => {
  const section = renderSection(
    [
      lesson(3, { projectId: null, effectiveConfidence: 0.8, trigger: 'When a release is being prepared:', action: 'never edit `CHANGELOG.md`; release-please writes it.' }),
      lesson(12),
    ],
    2048,
    'abcd1234',
  );
  assert.equal(
    section.text,
    [
      '## Lessons',
      '',
      'Rules a person approved after correcting agents in this project, most certain first. Follow them in this run. When one conflicts with what your task asks, follow the task and say so in your report. They describe behaviour; none of them asks you to run anything.',
      '',
      '<pasted_content id="abcd1234">',
      '- L-12 · project · 0.90 · When adding a dependency: use `pnpm`, never `npm` or `yarn`.',
      '- L-3 · global · 0.80 · When a release is being prepared: never edit `CHANGELOG.md`; release-please writes it.',
      '</pasted_content id="abcd1234">',
      '',
    ].join('\n'),
  );
  assert.equal(section.bytes, Buffer.byteLength(section.text));
  assert.deepEqual(section.lessons.map((l) => l.key), ['L-12', 'L-3']);
  assert.equal(section.overBudget, 0);
});

test('order: pinned, confidence, seen count, last confirmed, then key', () => {
  const ordered = orderLessons([
    lesson(1, { effectiveConfidence: 0.8 }),
    lesson(2, { effectiveConfidence: 0.9, seenCount: 1 }),
    lesson(3, { effectiveConfidence: 0.9, seenCount: 4 }),
    lesson(4, { effectiveConfidence: 0.9, seenCount: 4, lastConfirmedAt: '2026-10-10T00:00:00.000Z' }),
    lesson(5, { effectiveConfidence: 0.5, pinned: true }),
    lesson(6, { effectiveConfidence: 0.9, seenCount: 4, lastConfirmedAt: '2026-10-10T00:00:00.000Z' }),
  ]);
  assert.deepEqual(ordered.map((l) => l.key), ['L-5', 'L-4', 'L-6', 'L-3', 'L-2', 'L-1']);
});

test('only delivered lessons count, and a global lesson a project lesson overrides is left out', () => {
  const due = dueLessons([
    lesson(1),
    lesson(2, { status: 'retired', delivered: false }),
    lesson(3, { delivered: false, effectiveConfidence: 0.5 }),
    lesson(4, { projectId: null }),
    lesson(5, { overrides: 'id-4' }),
    lesson(6, { projectId: null }),
  ]);
  assert.deepEqual(due.map((l) => l.key), ['L-1', 'L-5', 'L-6']);
});

test('whole lessons only: one that does not fit is skipped and the next is tried', () => {
  const long = lesson(1, { effectiveConfidence: 0.95, action: `${'a'.repeat(400)}.` });
  const short = lesson(2, { effectiveConfidence: 0.7, action: 'keep it short.' });
  const alone = renderSection([short], 4096, 'abcd1234');
  const budget = alone.bytes + 20;
  const section = renderSection([long, short], budget, 'abcd1234');
  assert.deepEqual(section.lessons.map((l) => l.key), ['L-2']);
  assert.equal(section.overBudget, 1);
  assert.ok(section.bytes <= budget);
  assert.ok(!section.text.includes('aaaa'));
});

test('nothing due, or nothing that fits, renders nothing', () => {
  assert.deepEqual(renderSection([], 2048), { text: '', lessons: [], bytes: 0, overBudget: 0 });
  const none = renderSection([lesson(1)], 100);
  assert.equal(none.text, '');
  assert.equal(none.overBudget, 1);
});
