import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { daysSince, delivered, effective, shouldRetire } from '../src/lessons/decay.ts';
import { DEFAULT_LESSON_SETTINGS as settings, LessonSettingsStore, parseLessonSettings } from '../src/lessons/settings.ts';
import { tempConfig } from './helpers.ts';

const confirmed = '2026-01-01T00:00:00.000Z';
const after = (days: number) => new Date(Date.parse(confirmed) + days * 86_400_000);

// The worked example of the plan: approved at 0.8 and never seen or confirmed again
const table: Array<[number, number, boolean, boolean]> = [
  [0, 0.8, true, false],
  [89, 0.8, true, false],
  [90, 0.7, true, false],
  [119, 0.7, true, false],
  [120, 0.6, false, false],
  [149, 0.6, false, false],
  [150, 0.5, false, false],
  [180, 0.4, false, false],
  [209, 0.4, false, false],
  [210, 0.3, false, false],
  [239, 0.3, false, false],
  [240, 0.2, false, true],
];

for (const [days, level, isDelivered, retires] of table) {
  test(`decay at day ${days}: effective ${level}, delivered ${isDelivered}, retires ${retires}`, () => {
    const now = effective(0.8, false, confirmed, after(days), settings);
    assert.equal(now, level);
    assert.equal(delivered('active', now, settings), isDelivered);
    assert.equal(shouldRetire('active', false, now, settings), retires);
  });
}

test('a pinned lesson never decays or retires', () => {
  const now = effective(0.8, true, confirmed, after(900), settings);
  assert.equal(now, 0.8);
  assert.equal(shouldRetire('active', true, now, settings), false);
});

test('a clock that went backwards counts as no days, and base never exceeds max', () => {
  assert.equal(daysSince(confirmed, after(-5)), 0);
  assert.equal(effective(0.8, false, confirmed, after(-5), settings), 0.8);
  assert.equal(effective(0.99, false, confirmed, after(0), settings), 0.95);
});

test('only an active lesson is delivered or retired', () => {
  for (const status of ['proposed', 'retired', 'rejected', 'superseded'] as const) {
    assert.equal(delivered(status, 0.9, settings), false, status);
    assert.equal(shouldRetire(status, false, 0.1, settings), false, status);
  }
});

test('settings out of range are refused with the name of the field', () => {
  const cases: Array<[unknown, string]> = [
    [{ decay: { step: 0.9 } }, 'step'],
    [{ decay: { step: 0 } }, 'step'],
    [{ confidence: { deliverAt: 0.95 } }, 'deliverAt'],
    [{ confidence: { deliverAt: 0.1 } }, 'deliverAt'],
    [{ decay: { retireBelow: 0.75 } }, 'retireBelow'],
    [{ decay: { graceDays: 3 } }, 'graceDays'],
    [{ decay: { periodDays: 1 } }, 'periodDays'],
    [{ delivery: { handoffBytes: 9000 } }, 'handoffBytes'],
    [{ miner: { maxCostUsd: 5 } }, 'maxCostUsd'],
    [{ miner: { effort: 'huge' } }, 'effort'],
    [{ manualMining: 'yes' }, 'manualMining'],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => parseLessonSettings(input), (err: Error) => err.message.startsWith(field) && (err as Error & { statusCode: number }).statusCode === 400, field);
  }
  assert.equal(parseLessonSettings({}).manualMining, true, 'manual mining ships on');
});

test('lessons.json is read over the defaults, saved atomically and refused out of range', async () => {
  const config = tempConfig();
  const store = new LessonSettingsStore(config);
  assert.deepEqual(await store.get(), settings);
  const saved = await store.update({ decay: { step: 0.2 }, delivery: { looseChats: false } });
  assert.equal(saved.decay.step, 0.2);
  assert.equal(saved.decay.graceDays, 60, 'untouched fields keep their value');
  await assert.rejects(store.update({ decay: { step: 0.9 } }), /step/);
  const onDisk = JSON.parse(readFileSync(join(config.dataDir, 'lessons.json'), 'utf8')) as { decay: { step: number } };
  assert.equal(onDisk.decay.step, 0.2, 'a refused update writes nothing');
  assert.equal((await store.get()).delivery.looseChats, false);
});
