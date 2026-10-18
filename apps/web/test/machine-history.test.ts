import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemSample } from '@claudio/shared';
import { bucketFor, chartPath, chartX, chartY, memoryUsedPercent, niceMax, pointsOf, type ChartFrame } from '../src/lib/machine.ts';

const sample = (at: string, over: Partial<SystemSample> = {}): SystemSample => ({
  at,
  load1: 1,
  totalMb: 1000,
  availableMb: 250,
  cpuSome10: 0,
  memorySome10: 0,
  ioSome10: 0,
  chats: 0,
  rssMb: 0,
  admitting: true,
  ...over,
});

const frame: ChartFrame = { from: 0, to: 1000, width: 200, height: 100, left: 0, right: 0, top: 0, bottom: 0, yMax: 100 };

test('a range is cut into about 300 points of whole minutes, never finer than a reading', () => {
  assert.equal(bucketFor('1h'), 60);
  assert.equal(bucketFor('6h'), 120);
  assert.equal(bucketFor('24h'), 300);
  assert.equal(bucketFor('7d'), 2040);
  for (const range of ['1h', '6h', '24h', '7d'] as const) assert.equal(bucketFor(range) % 60, 0);
});

test('memory in use is the share of the total, and unknown stays unknown', () => {
  assert.equal(memoryUsedPercent(sample('2026-10-18T10:00:00Z')), 75);
  assert.equal(memoryUsedPercent(sample('2026-10-18T10:00:00Z', { availableMb: null })), null);
  assert.equal(memoryUsedPercent(sample('2026-10-18T10:00:00Z', { totalMb: null })), null);
});

test('the y axis tops at a step a person reads, and holds both the data and the reference line', () => {
  assert.equal(niceMax(3, 25), 25);
  assert.equal(niceMax(40, 25), 50);
  assert.equal(niceMax(2, 12), 25);
  assert.equal(niceMax(100, 100), 100);
  assert.equal(niceMax(3000, 100), 3000);
});

test('a line is lifted at a missing reading and across a silence, and a value past the top is drawn on the edge', () => {
  const points = pointsOf(
    [sample('1970-01-01T00:00:00.000Z', { load1: 10 }), sample('1970-01-01T00:00:00.100Z', { load1: 20 }), sample('1970-01-01T00:00:00.200Z', { load1: null }), sample('1970-01-01T00:00:00.900Z', { load1: 30 }), sample('1970-01-01T00:00:01.000Z', { load1: 400 })],
    (s) => s.load1,
  );
  assert.deepEqual(points.map((p) => p.v), [10, 20, null, 30, 400]);
  // 300 ms of silence is longer than the 250 ms allowed: the last two points start a new stroke
  assert.equal(chartPath(points, frame, 250), 'M0 90 L20 80 M180 70 L200 0');
  assert.equal(chartX(frame, 500), 100);
  assert.equal(chartY(frame, 400), 0);
});
