import assert from 'node:assert/strict';
import test from 'node:test';
import type { CliCanary } from '@claudio/shared';
import { CliCanaryWatch } from '../src/cli-canary.ts';
import { Db } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

const result = (version: string, state: 'pass' | 'fail' = 'pass', checkedAt = '2026-11-15T10:00:00.000Z'): CliCanary => ({
  version,
  checkedAt,
  state,
  checks: [
    { id: 's1', state: 'pass', observed: 'kept' },
    { id: 's2', state, observed: state === 'fail' ? 'replaced settings.json' : 'kept' },
    { id: 's3c', state: 'pass', observed: 'connected' },
  ],
});

/** Lets the watch's own promise chain finish: it is started with `void` */
const settled = async (watch: CliCanaryWatch): Promise<void> => {
  for (let i = 0; i < 50 && watch.status().running; i++) await new Promise((r) => setTimeout(r, 5));
};

function setup(run: (v: string) => Promise<CliCanary>) {
  const db = new Db(tempConfig());
  const lines: string[] = [];
  let changes = 0;
  const calls: string[] = [];
  const watch = new CliCanaryWatch({
    db,
    claude: () => 'claude',
    log: (l) => lines.push(l),
    changed: () => void (changes += 1),
    closed: () => false,
    run: async (o) => {
      calls.push(o.version);
      return run(o.version);
    },
  });
  return { db, watch, lines, calls, changes: () => changes };
}

test('a CLI version Claudio has not seen is checked once and its result is kept per version', async () => {
  const { db, watch, calls } = setup(async (v) => result(v));
  watch.note('2.1.322');
  await settled(watch);
  assert.deepEqual(calls, ['2.1.322']);
  assert.equal(db.cliCanary('2.1.322')?.state, 'pass');
  assert.equal(watch.status().result?.version, '2.1.322');
  // The same version read again, and a restart's new watch over the same rows, run nothing
  watch.note('2.1.322');
  const again = new CliCanaryWatch({ db, claude: () => 'claude', log: () => undefined, changed: () => undefined, closed: () => false, run: async (o) => (calls.push(`again ${o.version}`), result(o.version)) });
  again.note('2.1.322');
  assert.deepEqual(calls, ['2.1.322']);
});

test('a new version is checked and the older versions keep their own result', async () => {
  const { db, watch, calls } = setup(async (v) => result(v, v === '2.2.0' ? 'fail' : 'pass'));
  watch.note('2.1.322');
  await settled(watch);
  watch.note('2.2.0');
  await settled(watch);
  assert.deepEqual(calls, ['2.1.322', '2.2.0']);
  assert.equal(db.cliCanary('2.1.322')?.state, 'pass');
  assert.equal(db.cliCanary('2.2.0')?.state, 'fail');
  assert.equal(watch.status().result?.state, 'fail');
});

test('a failed check is said once in the log with what it saw, and nothing else changes', async () => {
  const { watch, lines } = setup(async (v) => result(v, 'fail'));
  watch.note('2.2.0');
  await settled(watch);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /2\.2\.0 fails s2: replaced settings\.json/);
});

test('a result that lost a check is run again, and a re-run replaces the stored rows', async () => {
  const { db, watch, calls } = setup(async (v) => result(v, 'pass', '2026-11-16T10:00:00.000Z'));
  db.saveCliCanary({ version: '2.1.1', checkedAt: '2026-11-01T00:00:00.000Z', state: 'pass', checks: [{ id: 's1', state: 'pass', observed: 'old' }] });
  watch.note('2.1.1');
  await settled(watch);
  assert.deepEqual(calls, ['2.1.1']);
  assert.equal(db.cliCanary('2.1.1')?.checks.length, 3);
  assert.equal(db.cliCanary('2.1.1')?.checkedAt, '2026-11-16T10:00:00.000Z');
});

test('only one run goes at a time, and asking again while one runs is refused', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const { watch, calls } = setup(async (v) => (await gate, result(v)));
  watch.note('2.1.322');
  assert.equal(watch.status().running, true);
  assert.equal(watch.recheck(), false);
  release();
  await settled(watch);
  assert.equal(watch.recheck(), true);
  await settled(watch);
  assert.deepEqual(calls, ['2.1.322', '2.1.322']);
});

test('a run that throws is logged, leaves nothing stored and can be asked for again', async () => {
  const { db, watch, lines } = setup(async () => {
    throw new Error('boom');
  });
  watch.note('2.1.322');
  await settled(watch);
  assert.match(lines[0] ?? '', /did not finish: boom/);
  assert.equal(db.cliCanary('2.1.322'), null);
  assert.equal(watch.status().running, false);
});

test('with the canary off nothing runs by itself, the version is still reported, and a person can still ask', async () => {
  const db = new Db(tempConfig());
  const calls: string[] = [];
  const watch = new CliCanaryWatch({ db, claude: () => 'claude', log: () => undefined, changed: () => undefined, closed: () => false, off: true, run: async (o) => (calls.push(o.version), result(o.version)) });
  watch.note('2.1.322');
  assert.deepEqual(calls, []);
  assert.equal(watch.status().version, '2.1.322');
  assert.equal(watch.recheck(), true);
  await settled(watch);
  assert.deepEqual(calls, ['2.1.322']);
});
