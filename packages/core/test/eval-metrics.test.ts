import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellMetrics, passAtK, passHatK, pressureDrop, runMetrics, wilsonInterval } from '../src/evals/metrics.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('pass@k is exact for small n, c, k', () => {
  close(passAtK(5, 2, 3), 1 - 1 / 10); // C(3,3) / C(5,3)
  close(passAtK(5, 1, 3), 1 - 4 / 10); // C(4,3) / C(5,3)
  close(passAtK(4, 1, 2), 1 - 3 / 6);
  close(passAtK(5, 3, 3), 1);
});

test('pass@k edge cases: c = 0, c = n, k = n', () => {
  close(passAtK(5, 0, 3), 0);
  close(passAtK(5, 5, 3), 1);
  close(passAtK(3, 1, 3), 1);
  close(passAtK(3, 0, 3), 0);
});

test('pass^k is exact for small n, c, k', () => {
  close(passHatK(5, 3, 2), 3 / 10); // C(3,2) / C(5,2)
  close(passHatK(5, 4, 3), 4 / 10);
  close(passHatK(5, 2, 3), 0);
});

test('pass^k edge cases: c = 0, c = n, k = n', () => {
  close(passHatK(5, 0, 3), 0);
  close(passHatK(5, 5, 3), 1);
  close(passHatK(3, 3, 3), 1);
  close(passHatK(3, 2, 3), 0);
});

test('the Wilson interval is known at a few points and stays inside 0..1', () => {
  const half = wilsonInterval(5, 10);
  close(half.low, 0.2366, 1e-3);
  close(half.high, 0.7634, 1e-3);
  const none = wilsonInterval(0, 5);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0.4 && none.high < 0.5);
  assert.equal(wilsonInterval(5, 5).high, 1);
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
});

const key = { caseId: 'a', variant: 'current', pressure: 'neutral' } as const;

test('a cell counts only scored samples, clamps k to n and counts the unjudged', () => {
  const m = cellMetrics(key, ['passed', 'passed', 'failed', 'unjudged', 'infra-error', null], { k: 3, mustHold: new Set(['a']) });
  assert.equal(m.n, 3);
  assert.equal(m.c, 2);
  assert.equal(m.k, 3);
  assert.equal(m.unjudged, 1);
  assert.equal(m.mustHold, true);
  close(m.passAtK ?? NaN, 1);
  close(m.passHatK ?? NaN, 0);
  assert.equal(cellMetrics(key, ['passed', 'failed'], { k: 3 }).k, 2);
});

test('a cell with no scored sample has null rates and the whole interval', () => {
  const m = cellMetrics(key, ['unjudged']);
  assert.equal(m.n, 0);
  assert.equal(m.passAtK, null);
  assert.equal(m.passHatK, null);
  assert.deepEqual(m.interval, { low: 0, high: 1 });
  assert.equal(m.k, 0);
});

test('runMetrics groups by case, variant and pressure; pressureDrop reads supportive minus competing', () => {
  const s = (pressure: 'supportive' | 'competing', outcome: 'passed' | 'failed') => ({ ...key, pressure, outcome });
  const cells = runMetrics([s('supportive', 'passed'), s('supportive', 'passed'), s('competing', 'passed'), s('competing', 'failed')]);
  assert.equal(cells.length, 2);
  close(pressureDrop(cells, 'a', 'current') ?? NaN, 0.5);
  assert.equal(pressureDrop(cells, 'a', 'pinned'), null);
  assert.equal(pressureDrop(cells, 'b', 'current'), null);
});
