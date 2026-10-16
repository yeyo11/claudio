import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db.ts';
import { ReviewStore, ReviewStoreError, type NewReviewFinding, type NewReviewRound } from '../src/review-store.ts';
import { tempConfig } from './helpers.ts';

const at = (n: number) => new Date(Date.parse('2026-10-16T10:00:00.000Z') + n * 1000).toISOString();

function seed(sql: DatabaseSync, id = 'o1'): void {
  sql.prepare('INSERT OR IGNORE INTO orchestrations (id, created_at, json) VALUES (?, ?, ?)').run(id, at(0), '{}');
}

const round = (over: Partial<NewReviewRound> = {}): NewReviewRound => ({
  id: 'r1',
  orchestrationId: 'o1',
  round: 1,
  pass: 1,
  base: 'aaa',
  head: 'bbb',
  depth: 'full',
  claimedBy: 'p1',
  startedAt: at(1),
  ...over,
});

const finding = (over: Partial<NewReviewFinding> = {}): NewReviewFinding => ({
  id: 'f1',
  roundId: 'r1',
  fingerprint: 'fp1',
  source: 'model',
  rule: null,
  dimensions: ['correctness', 'security'],
  reportedBy: 2,
  severity: 'high',
  confidence: 0.9,
  title: 'Unchecked input',
  path: 'src/a.ts',
  line: 12,
  side: 'right',
  anchor: 'line',
  evidence: 'x',
  failureScenario: 'y',
  suggestion: null,
  verdict: 'confirmed',
  verdictReason: null,
  verifierChatId: 'c9',
  blocking: true,
  resolvedInRound: null,
  createdAt: at(5),
  ...over,
});

function open(): { db: Db; store: ReviewStore } {
  const db = new Db(tempConfig());
  seed(db.connection);
  return { db, store: new ReviewStore(db.connection) };
}

test('a claimed round starts running and reads back with its runs and findings', () => {
  const { db, store } = open();
  try {
    const claimed = store.claimRound(round());
    assert.equal(claimed.state, 'running');
    assert.equal(claimed.accepted, null);
    store.addRun({ id: 'u1', roundId: 'r1', kind: 'reviewer', dimension: 'security', chunk: 1, chunks: 2, effort: 'high', roleSource: 'builtin', roleSha: 'abc', state: 'running', startedAt: at(2) });
    store.updateRun('u1', { state: 'done', costUsd: 0.25, endedAt: at(3) });
    store.putFindings('r1', [finding(), finding({ id: 'f2', fingerprint: 'fp2', severity: 'low', blocking: false })]);
    store.endRound('r1', { state: 'blocked', reason: 'one blocking finding', files: 3, added: 10, deleted: 2, chunks: 2, skippedFiles: [{ path: 'a.png', why: 'binary' }], costUsd: 0.25, estimateUsd: 0.4, endedAt: at(4) });

    const [one] = store.rounds('o1');
    assert.ok(one);
    assert.equal(one.state, 'blocked');
    assert.deepEqual(one.skippedFiles, [{ path: 'a.png', why: 'binary' }]);
    assert.equal(one.costUsd, 0.25);
    assert.equal(one.runs.length, 1);
    assert.equal(one.runs[0]?.state, 'done');
    assert.equal(one.runs[0]?.roleSource, 'builtin');

    const page = store.findings('r1', { limit: 10, offset: 0 });
    assert.equal(page.total, 2);
    assert.deepEqual(page.findings.map((f) => f.id), ['f1', 'f2']);
    assert.deepEqual(page.findings[0]?.dimensions, ['correctness', 'security']);
    assert.equal(page.findings[0]?.blocking, true);
    assert.equal(page.findings[0]?.verifierChatId, 'c9');
    const blocking = store.findings('r1', { blocking: true, limit: 10, offset: 0 });
    assert.equal(blocking.total, 1);
    assert.equal(store.findings('r1', { limit: 1, offset: 1 }).findings[0]?.id, 'f2');
  } finally {
    db.close();
  }
});

test('a second running round for one orchestration is refused with 409 review-running, a finished one is not', () => {
  const { db, store } = open();
  try {
    store.claimRound(round());
    assert.throws(
      () => store.claimRound(round({ id: 'r2', round: 2 })),
      (err) => err instanceof ReviewStoreError && err.statusCode === 409 && err.reason === 'review-running',
    );
    store.endRound('r1', { state: 'passed', endedAt: at(2) });
    store.claimRound(round({ id: 'r2', round: 2 }));
    seed(db.connection, 'o2');
    store.claimRound(round({ id: 'r3', orchestrationId: 'o2' }));
  } finally {
    db.close();
  }
});

test('a claim across two connections to one file lets exactly one through', () => {
  const config = tempConfig();
  const first = new Db(config);
  const second = new Db(config);
  try {
    seed(first.connection);
    const a = new ReviewStore(first.connection);
    const b = new ReviewStore(second.connection);
    a.claimRound(round({ claimedBy: 'p1' }));
    assert.throws(
      () => b.claimRound(round({ id: 'r2', round: 2, claimedBy: 'p2' })),
      (err) => err instanceof ReviewStoreError && err.reason === 'review-running',
    );
    assert.equal(b.rounds('o1').length, 1);
    a.endRound('r1', { state: 'incomplete', endedAt: at(2) });
    b.claimRound(round({ id: 'r2', round: 2, claimedBy: 'p2' }));
    assert.equal(a.rounds('o1').length, 2);
  } finally {
    first.close();
    second.close();
  }
});

test('the index alone refuses a running round the check did not see', () => {
  const { db, store } = open();
  try {
    store.claimRound(round());
    assert.throws(() =>
      db.connection.prepare("INSERT INTO review_rounds (id, orchestration_id, round, pass, base, head, depth, state, started_at) VALUES ('x', 'o1', 9, 1, 'a', 'b', 'full', 'running', ?)").run(at(1)),
    /UNIQUE/);
  } finally {
    db.close();
  }
});

test('accept needs a blocked or incomplete round and records who and why', () => {
  const { db, store } = open();
  try {
    store.claimRound(round());
    assert.throws(() => store.accept('r1', 'token:t1', 'ship it', at(3)), (err) => err instanceof ReviewStoreError && err.statusCode === 409 && err.reason === 'review-not-acceptable');
    store.endRound('r1', { state: 'blocked', endedAt: at(2) });
    store.accept('r1', 'token:t1', 'ship it', at(3));
    const [one] = store.rounds('o1');
    assert.equal(one?.state, 'accepted');
    assert.deepEqual(one?.accepted, { by: 'token:t1', reason: 'ship it', at: at(3) });
    assert.throws(() => store.accept('nope', 'a', 'b', at(4)), (err) => err instanceof ReviewStoreError && err.statusCode === 404);
  } finally {
    db.close();
  }
});

test('interruptRunning ends running rounds as incomplete, their live runs as interrupted, and frees the claim', () => {
  const { db, store } = open();
  try {
    store.claimRound(round({ claimedBy: 'p1' }));
    store.addRun({ id: 'u1', roundId: 'r1', kind: 'reviewer', state: 'running', startedAt: at(2) });
    store.addRun({ id: 'u2', roundId: 'r1', kind: 'verifier', state: 'done', startedAt: at(2) });
    assert.equal(store.interruptRunning(at(9), 'other'), 0);
    assert.equal(store.interruptRunning(at(9), 'p1'), 1);
    const [one] = store.rounds('o1');
    assert.equal(one?.state, 'incomplete');
    assert.match(one?.reason ?? '', /Interrupted/);
    assert.deepEqual(one?.runs.map((r) => r.state), ['interrupted', 'done']);
    store.claimRound(round({ id: 'r2', round: 2 }));
    assert.equal(store.interruptRunning(at(10)), 1);
  } finally {
    db.close();
  }
});

test('deleting the orchestration removes its rounds, runs and findings', () => {
  const { db, store } = open();
  try {
    store.claimRound(round());
    store.addRun({ id: 'u1', roundId: 'r1', kind: 'reviewer', state: 'done' });
    store.putFindings('r1', [finding()]);
    db.connection.prepare('DELETE FROM orchestrations WHERE id = ?').run('o1');
    for (const table of ['review_rounds', 'review_runs', 'review_findings']) {
      assert.equal((db.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    }
  } finally {
    db.close();
  }
});
