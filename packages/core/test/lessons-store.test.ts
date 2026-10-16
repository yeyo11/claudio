import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from '../src/db.ts';
import { LessonStore, type EvidenceInput, type NewLesson } from '../src/lessons/store.ts';
import { tempConfig } from './helpers.ts';

let now = new Date('2026-10-16T10:00:00.000Z');
const tick = (days: number) => {
  now = new Date(now.getTime() + days * 86_400_000);
};

function setup() {
  const db = new Db(tempConfig());
  const store = new LessonStore({ db, clock: () => now });
  return { db, store };
}

const evidence = (n: number): EvidenceInput => ({ signal: 'correction', quote: `no, not like that ${n}`, context: 'Edit src/cart.ts', chatId: 'c1', entryUuid: `u${n}`, at: now.toISOString() });
const input = (over: Partial<NewLesson> = {}): NewLesson => ({
  projectId: 'p1',
  trigger: 'When editing the cart',
  action: 'Keep totals in cents',
  confidence: 0.6,
  proposedBy: { kind: 'system', role: null },
  evidence: [evidence(1)],
  ...over,
});

const conflict = (fn: () => unknown) => assert.throws(fn, (err: Error) => (err as Error & { statusCode: number }).statusCode === 409);

test('a proposed lesson has a stable key, its evidence and no decision', () => {
  const { db, store } = setup();
  try {
    const first = store.insert(input());
    const second = store.insert(input({ projectId: null }));
    assert.match(first.key, /^L-\d+$/);
    assert.notEqual(first.key, second.key);
    assert.equal(first.status, 'proposed');
    assert.equal(first.delivered, false);
    assert.equal(first.evidence.length, 1);
    assert.equal(first.decidedBy, null);
    assert.deepEqual(store.list({ projectId: 'p1' }).map((l) => l.id), [first.id]);
    assert.deepEqual(store.list({ projectId: null }).map((l) => l.id), [second.id]);
    assert.equal(store.list({ status: 'active' }).length, 0);
  } finally {
    db.close();
  }
});

test('proposed → active on approve raises the confidence to the floor and delivers at once', () => {
  const { db, store } = setup();
  try {
    const l = store.insert(input({ confidence: 0.6 }));
    const approved = store.approve(l.id);
    assert.equal(approved.status, 'active');
    assert.equal(approved.confidence, 0.8);
    assert.equal(approved.delivered, true);
    assert.equal(approved.decidedBy?.kind, 'person');
    conflict(() => store.approve(l.id));
    const high = store.approve(store.insert(input({ confidence: 0.9 })).id);
    assert.equal(high.confidence, 0.9, 'a higher candidate keeps its confidence');
  } finally {
    db.close();
  }
});

test('proposed → active with an edit keeps the person\'s words and stamps edited_at', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id, { edit: { trigger: 'Cuando edite el carrito', action: 'Usa céntimos' } });
    assert.equal(l.trigger, 'Cuando edite el carrito');
    assert.equal(l.editedAt, now.toISOString());
  } finally {
    db.close();
  }
});

test('approve with retire retires the contradicted lessons in the same transaction, or none', () => {
  const { db, store } = setup();
  try {
    const old = store.approve(store.insert(input()).id);
    const fresh = store.insert(input({ contradicts: old.id }));
    const approved = store.approve(fresh.id, { retire: [old.id] });
    assert.equal(approved.status, 'active');
    const retired = store.mustFind(old.id);
    assert.equal(retired.status, 'retired');
    assert.equal(retired.retiredReason, 'contradicted');

    const other = store.insert(input());
    conflict(() => store.approve(other.id, { retire: [retired.id] }));
    assert.equal(store.mustFind(other.id).status, 'proposed', 'a retire that lost rolled the approval back');
  } finally {
    db.close();
  }
});

test('proposed → merged moves the evidence to the target, which is seen once more, and the row goes', () => {
  const { db, store } = setup();
  try {
    const target = store.approve(store.insert(input({ confidence: 0.8 })).id);
    const dup = store.insert(input({ evidence: [evidence(2), evidence(3)] }));
    const merged = store.merge(dup.id, target.id);
    assert.equal(merged.id, target.id);
    assert.equal(merged.seenCount, 2);
    assert.equal(merged.confidence, 0.85);
    assert.equal(merged.evidence.length, 3);
    assert.equal(store.find(dup.id), null);
    const rows = (db.connection.prepare('SELECT COUNT(*) AS n FROM lesson_evidence').get() as { n: number }).n;
    assert.equal(rows, 3);
    assert.throws(() => store.merge(dup.id, target.id), (err: Error) => (err as Error & { statusCode: number }).statusCode === 404);
  } finally {
    db.close();
  }
});

test('a merge into a lesson that is not active rolls back and leaves the proposal', () => {
  const { db, store } = setup();
  try {
    const target = store.insert(input());
    const dup = store.insert(input());
    conflict(() => store.merge(dup.id, target.id));
    assert.equal(store.mustFind(dup.id).status, 'proposed');
    assert.equal(store.mustFind(dup.id).evidence.length, 1);
  } finally {
    db.close();
  }
});

test('proposed → rejected, and a rejected lesson cannot be approved or deleted twice', () => {
  const { db, store } = setup();
  try {
    const l = store.insert(input());
    assert.equal(store.reject(l.id).status, 'rejected');
    conflict(() => store.reject(l.id));
    conflict(() => store.approve(l.id));
  } finally {
    db.close();
  }
});

test('active → active: edit, pin, unpin and confirm', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    const edited = store.edit(l.id, { action: 'Keep totals in integer cents' });
    assert.equal(edited.action, 'Keep totals in integer cents');
    assert.equal(edited.trigger, l.trigger);
    assert.equal(edited.confidence, l.confidence, 'confidence is unchanged');
    assert.ok(edited.editedAt);
    assert.equal(store.pin(l.id, true).pinned, true);
    assert.equal(store.pin(l.id, false).pinned, false);
    tick(100);
    assert.equal(store.mustFind(l.id).effectiveConfidence, 0.7);
    const confirmed = store.confirm(l.id);
    assert.equal(confirmed.confidence, 0.9);
    assert.equal(confirmed.lastConfirmedAt, now.toISOString());
    assert.equal(confirmed.effectiveConfidence, 0.9, 'the decay starts over');
    assert.equal(store.confirm(l.id).confidence, 0.95, 'never above max');
  } finally {
    db.close();
  }
});

test('active → active when seen again: a step, one more sighting, evidence capped at ten', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    let seen = l;
    for (let i = 2; i <= 14; i++) seen = store.seen(l.id, [evidence(i)]);
    assert.equal(seen.seenCount, 14);
    assert.equal(seen.confidence, 0.95);
    assert.equal(seen.evidence.length, 10);
    assert.deepEqual(seen.evidence.map((e) => e.entryUuid), ['u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14'], 'the oldest were dropped');
  } finally {
    db.close();
  }
});

test('an insert with more than ten pieces of evidence keeps the newest ten', () => {
  const { db, store } = setup();
  try {
    const l = store.insert(input({ evidence: Array.from({ length: 12 }, (_, i) => evidence(i + 1)) }));
    assert.equal(l.evidence.length, 10);
    assert.equal(l.evidence[0]?.entryUuid, 'u3');
  } finally {
    db.close();
  }
});

test('active → retired by the person, then restored with the confidence floor', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    const retired = store.retire(l.id);
    assert.equal(retired.status, 'retired');
    assert.equal(retired.retiredReason, 'person');
    assert.equal(retired.delivered, false);
    conflict(() => store.retire(l.id));
    conflict(() => store.edit(l.id, { action: 'x' }));
    const restored = store.restore(l.id);
    assert.equal(restored.status, 'active');
    assert.equal(restored.retiredReason, null);
    assert.equal(restored.confidence, 0.8);
    conflict(() => store.restore(l.id));
  } finally {
    db.close();
  }
});

test('active → retired by the instructions reason', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    assert.equal(store.retire(l.id, 'instructions').retiredReason, 'instructions');
  } finally {
    db.close();
  }
});

test('the decay sweep retires what fell below the line and spares pinned lessons', () => {
  const { db, store } = setup();
  try {
    const decaying = store.approve(store.insert(input()).id);
    const pinned = store.approve(store.insert(input()).id);
    store.pin(pinned.id, true);
    tick(239);
    assert.deepEqual(store.sweep(), []);
    tick(1);
    const retired = store.sweep();
    assert.deepEqual(retired.map((l) => l.id), [decaying.id]);
    assert.equal(retired[0]?.retiredReason, 'decayed');
    assert.equal(store.mustFind(pinned.id).status, 'active');
  } finally {
    db.close();
  }
});

test('the sweep loses to a confirmation that lands in between', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    const staleConfirmedAt = l.lastConfirmedAt;
    tick(240);
    store.confirm(l.id);
    assert.equal(store.retireDecayed(l.id, staleConfirmedAt), false);
    assert.equal(store.mustFind(l.id).status, 'active');
  } finally {
    db.close();
  }
});

test('active project → superseded with an active global copy that carries the evidence', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    const { global, origin } = store.promote(l.id);
    assert.equal(origin.status, 'superseded');
    assert.equal(global.status, 'active');
    assert.equal(global.projectId, null);
    assert.equal(global.promotedFrom, l.id);
    assert.equal(global.evidence.length, 1);
    assert.equal(global.confidence, l.confidence);
    assert.notEqual(global.id, l.id);
    conflict(() => store.promote(l.id));
    assert.throws(() => store.promote(global.id), (err: Error) => (err as Error & { statusCode: number }).statusCode === 409);
  } finally {
    db.close();
  }
});

test('demoting a global lesson returns the origin to active and deletes the global row', () => {
  const { db, store } = setup();
  try {
    const l = store.approve(store.insert(input()).id);
    const { global } = store.promote(l.id);
    const back = store.demote(global.id);
    assert.equal(back.id, l.id);
    assert.equal(back.status, 'active');
    assert.equal(store.find(global.id), null);
  } finally {
    db.close();
  }
});

test('demoting a global lesson with no origin needs a project and creates a project row', () => {
  const { db, store } = setup();
  try {
    const global = store.approve(store.insert(input({ projectId: null })).id);
    assert.throws(() => store.demote(global.id), (err: Error) => (err as Error & { statusCode: number }).statusCode === 400);
    assert.equal(store.mustFind(global.id).status, 'active', 'the refusal changed nothing');
    const row = store.demote(global.id, 'p2');
    assert.equal(row.projectId, 'p2');
    assert.equal(row.status, 'active');
    assert.equal(row.evidence.length, 1);
    assert.equal(store.find(global.id), null);
    conflict(() => store.demote(row.id, 'p2'));
  } finally {
    db.close();
  }
});

test('delete removes any lesson but a proposed one, with its evidence, and clears the proposal link', () => {
  const { db, store } = setup();
  try {
    const proposed = store.insert(input());
    conflict(() => store.delete(proposed.id));
    const active = store.approve(proposed.id);
    db.connection
      .prepare("INSERT INTO memory_proposals (id, project_id, target_kind, text, reason, status, proposed_by_kind, created_at, lesson_id) VALUES ('m1', 'p1', 'lesson', 't', 'r', 'approved', 'system', ?, ?)")
      .run(now.toISOString(), active.id);
    store.delete(active.id);
    assert.equal(store.find(active.id), null);
    assert.equal((db.connection.prepare('SELECT COUNT(*) AS n FROM lesson_evidence').get() as { n: number }).n, 0);
    assert.equal((db.connection.prepare("SELECT lesson_id FROM memory_proposals WHERE id = 'm1'").get() as { lesson_id: string | null }).lesson_id, null);
    const rejected = store.reject(store.insert(input()).id);
    store.delete(rejected.id);
    assert.equal(store.find(rejected.id), null);
  } finally {
    db.close();
  }
});

test('an unknown lesson answers 404', () => {
  const { db, store } = setup();
  try {
    assert.throws(() => store.retire('nope'), (err: Error) => (err as Error & { statusCode: number }).statusCode === 404);
    assert.throws(() => store.confirm('nope'), (err: Error) => (err as Error & { statusCode: number }).statusCode === 404);
  } finally {
    db.close();
  }
});

test('two processes racing for one lesson: the loser answers 409 and changes nothing', () => {
  const config = tempConfig();
  const first = new Db(config);
  const second = new Db(config);
  try {
    const a = new LessonStore({ db: first, clock: () => now });
    const b = new LessonStore({ db: second, clock: () => now });
    const l = a.insert(input());
    assert.equal(a.approve(l.id).status, 'active');
    conflict(() => b.approve(l.id));
    assert.equal(b.retire(l.id).status, 'retired');
    conflict(() => a.retire(l.id));
    conflict(() => a.pin(l.id, true));
    assert.equal(a.restore(l.id).status, 'active');
  } finally {
    first.close();
    second.close();
  }
});
