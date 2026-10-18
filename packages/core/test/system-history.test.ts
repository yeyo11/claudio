import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SystemSample } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { DEFAULT_ADMISSION } from '../src/system-load.ts';
import { DEFAULT_RETENTION_DAYS, DEFAULT_SAMPLE_SECONDS, SystemSampler, samplerSettingsFrom } from '../src/system-history.ts';
import { tempConfig } from './helpers.ts';

const sample = (at: string, over: Partial<SystemSample> = {}): SystemSample => ({
  at,
  load1: 1,
  totalMb: 16000,
  availableMb: 8000,
  cpuSome10: 2,
  memorySome10: 1,
  ioSome10: 0,
  chats: 2,
  rssMb: 900,
  admitting: true,
  ...over,
});

function fakeProc(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'claudio-sampler-proc-'));
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const PSI = (some: number) => `some avg10=${some.toFixed(2)} avg60=0 avg300=0 total=0\nfull avg10=0.00 avg60=0 avg300=0 total=0\n`;

test('samples are stored oldest first, a null stays null, and the same instant is replaced', () => {
  const db = new Db(tempConfig());
  db.appendSystemSample(sample('2026-10-18T10:02:00.000Z', { load1: null, availableMb: null, rssMb: null, admitting: false }));
  db.appendSystemSample(sample('2026-10-18T10:01:00.000Z'));
  db.appendSystemSample(sample('2026-10-18T10:01:00.000Z', { chats: 5 }));
  const rows = db.systemSamples();
  assert.deepEqual(rows.map((r) => r.at), ['2026-10-18T10:01:00.000Z', '2026-10-18T10:02:00.000Z']);
  assert.equal(rows[0]?.chats, 5, 'the second reading of an instant replaced the first');
  assert.equal(rows[1]?.load1, null);
  assert.equal(rows[1]?.availableMb, null);
  assert.equal(rows[1]?.admitting, false);
  assert.deepEqual(db.systemSamples({ since: '2026-10-18T10:02:00.000Z' }).map((r) => r.at), ['2026-10-18T10:02:00.000Z']);
  assert.deepEqual(db.systemSamples({ limit: 1 }).map((r) => r.at), ['2026-10-18T10:02:00.000Z'], 'the limit keeps the newest');
  db.close();
});

test('a bucket folds its rows into the worst of them: the peaks, the least free memory, any refusal', () => {
  const db = new Db(tempConfig());
  db.appendSystemSample(sample('2026-10-18T10:00:10.000Z', { memorySome10: 3, availableMb: 9000, chats: 1, admitting: true }));
  db.appendSystemSample(sample('2026-10-18T10:00:50.000Z', { memorySome10: 25, availableMb: 1500, chats: 4, admitting: false }));
  db.appendSystemSample(sample('2026-10-18T10:05:10.000Z', { memorySome10: 1, availableMb: 8000, chats: 2 }));
  const rows = db.systemSamples({ bucketSeconds: 300 });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { at: rows[0]?.at, memorySome10: rows[0]?.memorySome10, availableMb: rows[0]?.availableMb, chats: rows[0]?.chats, admitting: rows[0]?.admitting },
    { at: '2026-10-18T10:00:00Z', memorySome10: 25, availableMb: 1500, chats: 4, admitting: false },
  );
  assert.equal(rows[1]?.at, '2026-10-18T10:05:00Z');
  db.close();
});

test('the sampler stores a reading, prunes what is past the retention, and stores nothing where /proc is not there', () => {
  const db = new Db(tempConfig());
  db.appendSystemSample(sample('2026-10-01T00:00:00.000Z'));
  const root = fakeProc({
    loadavg: '0.50 0.40 0.30 1/100 1234\n',
    meminfo: 'MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n',
    'pressure/cpu': PSI(2),
    'pressure/memory': PSI(1.5),
    'pressure/io': PSI(0),
  });
  const sampler = new SystemSampler(db, () => [], () => DEFAULT_ADMISSION, { intervalSeconds: 60, retentionDays: 7 }, root);
  const taken = sampler.sample(new Date('2026-10-18T10:00:00.000Z'));
  assert.deepEqual(
    { load1: taken?.load1, totalMb: taken?.totalMb, availableMb: taken?.availableMb, memorySome10: taken?.memorySome10, chats: taken?.chats, rssMb: taken?.rssMb, admitting: taken?.admitting },
    { load1: 0.5, totalMb: 16000, availableMb: 8000, memorySome10: 1.5, chats: 0, rssMb: 0, admitting: true },
  );
  assert.deepEqual(db.systemSamples().map((r) => r.at), ['2026-10-18T10:00:00.000Z'], 'the sample from 17 days earlier is gone');

  const bare = new SystemSampler(db, () => [], () => DEFAULT_ADMISSION, { intervalSeconds: 60, retentionDays: 7 }, join(tmpdir(), 'claudio-no-proc-here'));
  assert.equal(bare.sample(new Date('2026-10-18T10:01:00.000Z')), null);
  assert.equal(db.systemSamples().length, 1, 'a row of nulls would only draw an empty chart');
  db.close();
});

test('the interval and the retention come from the environment, and 0 seconds turns the sampler off', () => {
  assert.deepEqual(samplerSettingsFrom({}), { intervalSeconds: DEFAULT_SAMPLE_SECONDS, retentionDays: DEFAULT_RETENTION_DAYS });
  assert.deepEqual(samplerSettingsFrom({ CLAUDIO_MACHINE_SAMPLE_SECONDS: '0', CLAUDIO_MACHINE_RETENTION_DAYS: '30' }), { intervalSeconds: 0, retentionDays: 30 });
  assert.deepEqual(samplerSettingsFrom({ CLAUDIO_MACHINE_SAMPLE_SECONDS: 'x', CLAUDIO_MACHINE_RETENTION_DAYS: '-3' }), { intervalSeconds: 60, retentionDays: 7 });
  const db = new Db(tempConfig());
  const off = new SystemSampler(db, () => [], () => DEFAULT_ADMISSION, { intervalSeconds: 0, retentionDays: 7 });
  off.start();
  off.stop();
  db.close();
});
