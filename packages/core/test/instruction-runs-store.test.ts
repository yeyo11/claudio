import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { EvalDefinition, EvalVariantInfo } from '@claudio/shared';
import { EVALS_SCHEMA_VERSION, migrate } from '../src/db.ts';
import { EvalStore, EvalStoreError, type NewEvalRun, type NewEvalSample } from '../src/evals/store.ts';

const PIN = 'a'.repeat(40);
const definition = { version: 1 } as unknown as EvalDefinition;
const at = (n: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, n)).toISOString();

function open(): { db: DatabaseSync; store: EvalStore } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return { db, store: new EvalStore(db) };
}

const run = (id: string, over: Partial<NewEvalRun> = {}): NewEvalRun => ({
  id, projectId: 'p1', evalName: 'tests-first', definitionSha: 'd'.repeat(64), definition, variants: ['current', 'proposed'],
  samplesPerCase: 1, account: null, maxCostUsd: 5, startedBy: 'person', createdAt: at(1), ...over,
});
const variants: EvalVariantInfo[] = [
  { variant: 'current', targetPath: 'CLAUDE.md', present: true, contentSha: 'x', content: 'a' },
  { variant: 'proposed', targetPath: 'CLAUDE.md', present: true, contentSha: 'y', content: 'b' },
];
const samples = (prefix: string): NewEvalSample[] => [
  { id: `${prefix}-1`, caseId: 'c1', variant: 'current', attempt: 1, seq: 0, pin: PIN },
  { id: `${prefix}-2`, caseId: 'c1', variant: 'proposed', attempt: 1, seq: 1, pin: PIN },
];
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('migrating from the previous version creates the tables and keeps the rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, EVALS_SCHEMA_VERSION - 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'eval_runs'").get(), undefined);
  migrate(db);
  for (const name of ['eval_runs', 'eval_variants', 'eval_samples', 'eval_calls', 'eval_checks', 'eval_runs_live', 'eval_runs_history', 'eval_samples_run']) {
    assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), name);
  }
});

test('a second live run in a project fails on the unique index, and another project is free', () => {
  const { store } = open();
  store.insertRun(run('r1'), variants, samples('r1'));
  assert.throws(() => store.insertRun(run('r2'), variants, samples('r2')), (err: unknown) => err instanceof EvalStoreError && err.code === 'eval-running');
  assert.equal(store.summary('r2'), null, 'the failed insert left nothing behind');
  store.insertRun(run('r3', { projectId: 'p2' }), variants, samples('r3'));
  store.endRun('r1', { outcome: 'completed', endedAt: at(2) });
  store.insertRun(run('r4', { createdAt: at(3) }), variants, samples('r4'));
});

test('two claims of one sample give one winner, and the run cap holds', () => {
  const { store } = open();
  store.insertRun(run('r1'), variants, samples('r1'));
  assert.equal(store.claimSample('r1-1', 100, 2, at(1)), true);
  assert.equal(store.claimSample('r1-1', 200, 2, at(1)), false);
  assert.equal(store.claimSample('r1-2', 200, 1, at(1)), false, 'one is running and the cap is one');
  assert.equal(store.claimSample('r1-2', 200, 2, at(1)), true);
  assert.equal(store.sample('r1-1')?.state, 'running');
});

test('ending a sample is guarded, accumulates the cost and feeds the counts', () => {
  const { store } = open();
  store.insertRun(run('r1'), variants, samples('r1'));
  store.claimSample('r1-1', 1, 2, at(1));
  store.claimSample('r1-2', 1, 2, at(1));
  assert.equal(store.endSample('r1-1', { outcome: 'passed', costUsd: 0.25, endedAt: at(2) }), true);
  assert.equal(store.endSample('r1-1', { outcome: 'failed', costUsd: 9, endedAt: at(3) }), false);
  assert.equal(store.endSample('r1-2', { outcome: 'failed', costUsd: 0.5, endedAt: at(3) }), true);
  const summary = store.summary('r1');
  assert.equal(summary?.costUsd, 0.75);
  assert.deepEqual(summary?.counts, { passed: 1, failed: 1 });
  assert.deepEqual(summary?.scored, { current: { passed: 1, of: 1 }, proposed: { passed: 0, of: 1 } });
});

test('ending a run settles the samples that never ran and frees the project', () => {
  const { store } = open();
  store.insertRun(run('r1'), variants, samples('r1'));
  assert.equal(store.endRun('r1', { outcome: 'cancelled', endedAt: at(2) }), true);
  assert.equal(store.endRun('r1', { outcome: 'failed', endedAt: at(3) }), false);
  assert.deepEqual(store.samples('r1').map((s) => [s.state, s.outcome]), [['ended', 'cancelled'], ['ended', 'cancelled']]);
  assert.equal(store.liveRun('p1'), null);
});

test('deleting a run cascades to its variants, samples, calls and checks, and refuses a live one', () => {
  const { db, store } = open();
  store.insertRun(run('r1'), variants, samples('r1'));
  store.claimSample('r1-1', 1, 2, at(1));
  store.addCalls('r1-1', [{ seq: 0, message: 0, toolUseId: 't', name: 'Bash', scope: 'main', outcome: 'ok', input: '{}', result: null, at: null }]);
  store.addChecks('r1-1', [{ idx: 0, kind: 'called', passed: true, detail: 'ok', evidenceSeq: 0, output: null }]);
  assert.equal(store.calls('r1-1').length, 1);
  assert.equal(store.deleteRun('r1'), false, 'live');
  store.endRun('r1', { outcome: 'completed', endedAt: at(2) });
  assert.equal(store.deleteRun('r1'), true);
  for (const table of ['eval_runs', 'eval_variants', 'eval_samples', 'eval_calls', 'eval_checks']) assert.equal(count(db, table), 0, table);
});

test('only the newest 100 ended runs of an eval are kept, in the transaction of the next insert', () => {
  const { db, store } = open();
  for (let i = 0; i < 103; i += 1) {
    store.insertRun(run(`r${String(i).padStart(3, '0')}`, { createdAt: at(i) }), variants.slice(0, 1), samples(`r${String(i)}`).slice(0, 1));
    store.endRun(`r${String(i).padStart(3, '0')}`, { outcome: 'completed', endedAt: at(i) });
  }
  assert.equal(count(db, 'eval_runs'), 100);
  assert.equal(store.summary('r002'), null);
  assert.ok(store.summary('r003'));
  store.insertRun(run('other', { evalName: 'other', createdAt: at(200) }), variants, samples('other'));
  assert.equal(count(db, 'eval_runs'), 101, 'another eval has its own 100');
});

test('history pages newest first with a cursor that survives equal timestamps', () => {
  const { store } = open();
  for (let i = 0; i < 5; i += 1) {
    store.insertRun(run(`r${String(i)}`, { createdAt: i < 3 ? at(1) : at(2) }), variants, samples(`r${String(i)}`));
    store.endRun(`r${String(i)}`, { outcome: 'completed', endedAt: at(5) });
  }
  const first = store.history('p1', 'tests-first', { limit: 2 });
  assert.deepEqual(first.runs.map((r) => r.id), ['r4', 'r3']);
  const second = store.history('p1', 'tests-first', { limit: 2, before: first.next ?? '' });
  assert.deepEqual(second.runs.map((r) => r.id), ['r2', 'r1']);
  const third = store.history('p1', null, { limit: 2, before: second.next ?? '' });
  assert.deepEqual(third.runs.map((r) => r.id), ['r0']);
  assert.equal(third.next, null);
});

test('recovery lists live runs and running samples with their owners, and a sample can be requeued', () => {
  const { store } = open();
  store.insertRun(run('r1'), variants, samples('r1'), { pid: 42, startedAt: at(1) });
  store.claimSample('r1-1', 42, 2, at(1));
  assert.deepEqual(store.liveRuns(), [{ id: 'r1', projectId: 'p1', state: 'queued', ownerPid: 42, ownerStartedAt: at(1) }]);
  assert.deepEqual(store.runningSamples().map((s) => [s.id, s.ownerPid]), [['r1-1', 42]]);
  assert.equal(store.requeueSample('r1-1'), true);
  assert.equal(store.nextQueued('r1'), 'r1-1');
  assert.equal(store.adoptRun('r1', 77, at(2)), true);
  assert.equal(store.liveRuns()[0]?.ownerPid, 77);
});
