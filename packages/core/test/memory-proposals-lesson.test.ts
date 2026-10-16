import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Lesson } from '@claudio/shared';
import { Db } from '../src/db.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { JournalService } from '../src/journal.ts';
import { LessonService, type MiningContext } from '../src/lessons/service.ts';
import { LessonStore, type EvidenceInput } from '../src/lessons/store.ts';
import type { Candidate } from '../src/lessons/validate.ts';
import { MemoryProposalService } from '../src/memory-proposals.ts';
import { MemoryStore } from '../src/memory.ts';
import { WorkItemError } from '../src/work-item-validation.ts';
import { tempConfig } from './helpers.ts';

let now = new Date('2026-10-16T10:00:00.000Z');
const tick = (days: number) => {
  now = new Date(now.getTime() + days * 86_400_000);
};

function setup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const events: ClaudioEventInput[] = [];
  const emit = (event: ClaudioEventInput) => void events.push(event);
  const journal = new JournalService({ db, emit });
  const projectDir = mkdtempSync(join(tmpdir(), 'claudio-lesson-project-'));
  const proposals = new MemoryProposalService({
    db,
    journal,
    memory: new MemoryStore(config),
    project: (id) => (id === 'p1' ? { path: projectDir, memoryKey: 'p1-key' } : null),
    emit,
  });
  const store = new LessonStore({ db, clock: () => now });
  const lessons = new LessonService({ store, proposals, emit, chatTitle: (id) => (id === 'c1' ? 'Fix the cart' : null) });
  return { db, events, proposals, store, lessons, projectDir };
}

const evidence = (n = 1): EvidenceInput => ({ signal: 'correction', quote: `no, not like that ${String(n)}`, context: 'Edit src/cart.ts', chatId: 'c1', entryUuid: `u${String(n)}`, at: now.toISOString() });
const ctx = (projectId = 'p1'): MiningContext => ({ projectId, chatId: 'c1', chatTitle: 'Fix the cart', evidence: new Map([['s1', evidence()]]) });
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  trigger: 'When editing the cart',
  action: 'Keep totals in cents',
  signals: ['s1'],
  quote: 'no, cents',
  confidence: 0.6,
  restates: null,
  contradicts: null,
  instructions: 'none',
  mechanical: false,
  ...over,
});
const statusOf = (e: unknown) => (e instanceof WorkItemError ? e.statusCode : 0);
const refuses = (code: number) => (err: unknown) => statusOf(err) === code;

/** A lesson proposed from a candidate, with the proposal that carries it */
function propose(s: ReturnType<typeof setup>, over: Partial<Candidate> = {}, project = 'p1') {
  const before = s.proposals.list(project).length;
  const result = s.lessons.createFromCandidates([candidate(over)], ctx(project));
  const proposal = s.proposals.list(project)[0];
  assert.ok(proposal);
  return { result, proposal, created: s.proposals.list(project).length - before };
}

/** An active lesson, approved as the person would */
async function activeLesson(s: ReturnType<typeof setup>, over: Partial<Candidate> = {}, project = 'p1'): Promise<Lesson> {
  const { proposal } = propose(s, over, project);
  const approved = await s.proposals.approve(proposal.id);
  assert.ok(approved.lesson);
  return approved.lesson;
}

test('a flow result cannot propose a lesson: 400', () => {
  const s = setup();
  try {
    assert.throws(
      () => s.proposals.propose('p1', { target: { kind: 'lesson', file: null, section: null }, text: 'When x: do y', reason: 'because' }, { proposedBy: { kind: 'agent', role: 'qa' } }),
      refuses(400),
    );
    assert.equal(s.proposals.list('p1').length, 0);
  } finally {
    s.db.close();
  }
});

test('a candidate becomes a proposed lesson and a lesson proposal with its evidence, and raises no notification', () => {
  const s = setup();
  try {
    const { result, proposal } = propose(s);
    assert.deepEqual(result, { proposed: 1, merged: 0, appended: 0, dropped: {} });
    assert.equal(proposal.target.kind, 'lesson');
    assert.equal(proposal.text, 'When editing the cart: Keep totals in cents');
    assert.match(proposal.reason, /Fix the cart/);
    assert.deepEqual(proposal.proposedBy, { kind: 'system', role: null });
    assert.equal(proposal.lesson?.status, 'proposed');
    assert.equal(proposal.lesson?.evidence[0]?.chatTitle, 'Fix the cart');
    assert.equal(proposal.lessonId, null);
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'proposed'));
    assert.ok(!s.events.some((e) => e.type === 'memory.proposal'));
  } finally {
    s.db.close();
  }
});

test('approving makes the lesson active at the approval floor, once, and emits both events', async () => {
  const s = setup();
  try {
    const { proposal } = propose(s);
    const approved = await s.proposals.approve(proposal.id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.lesson?.status, 'active');
    assert.equal(approved.lesson?.confidence, 0.8);
    assert.equal(approved.lesson?.delivered, true);
    assert.equal(approved.approvedText, null);
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'approved'));
    assert.ok(s.events.some((e) => e.type === 'memory.proposal' && e.action === 'approved'));
    await assert.rejects(s.proposals.approve(proposal.id), refuses(409));
  } finally {
    s.db.close();
  }
});

test("approving with the person's edit keeps their words, and a bad edit is a 400 that leaves everything waiting", async () => {
  const s = setup();
  try {
    const { proposal } = propose(s);
    await assert.rejects(s.proposals.approve(proposal.id, { lesson: { trigger: 'Cuando edites', action: 'run `rm -rf /` now' } }), refuses(400));
    assert.equal(s.proposals.find(proposal.id)?.status, 'pending');
    assert.equal(s.proposals.find(proposal.id)?.lesson?.status, 'proposed');
    const approved = await s.proposals.approve(proposal.id, { lesson: { trigger: 'Cuando edites el carrito', action: 'Guarda los totales en céntimos' } });
    assert.equal(approved.lesson?.trigger, 'Cuando edites el carrito');
    assert.ok(approved.lesson?.editedAt);
    assert.equal(approved.approvedText, 'Cuando edites el carrito: Guarda los totales en céntimos');
  } finally {
    s.db.close();
  }
});

test('approving with mergeInto folds the evidence into the target, deletes the proposed row and points the proposal at the target', async () => {
  const s = setup();
  try {
    const target = await activeLesson(s, { trigger: 'When editing the cart', action: 'Keep totals in cents' });
    // Similar, not the same: it is proposed with an offer to merge
    const { proposal, created } = propose(s, { action: 'Keep prices in cents' });
    assert.equal(created, 1);
    assert.match(proposal.reason, new RegExp(`Similar to ${target.key}`));
    const proposedId = proposal.lesson?.id ?? '';
    await assert.rejects(s.proposals.approve(proposal.id, { mergeInto: 'nope' }), refuses(404));
    await assert.rejects(s.proposals.approve(proposal.id, { mergeInto: target.id, keepBoth: true }), refuses(400));
    const approved = await s.proposals.approve(proposal.id, { mergeInto: target.id });
    assert.equal(approved.lesson?.id, target.id);
    assert.equal(approved.lesson?.seenCount, 2);
    assert.equal(approved.lesson?.evidence.length, 2);
    assert.equal(s.store.find(proposedId), null);
  } finally {
    s.db.close();
  }
});

test('a contradiction needs retire or keepBoth; retire retires the other, keepBoth keeps it', async () => {
  const s = setup();
  try {
    const old = await activeLesson(s, { trigger: 'When editing the cart', action: 'Keep totals in cents' });
    const { proposal } = propose(s, { trigger: 'When editing the cart', action: 'Keep totals as decimals', contradicts: old.key });
    assert.equal(proposal.lesson?.contradicts, old.id);
    await assert.rejects(s.proposals.approve(proposal.id), refuses(409));
    assert.equal(s.proposals.find(proposal.id)?.status, 'pending');
    await assert.rejects(s.proposals.approve(proposal.id, { retire: ['nope'] }), refuses(404));
    const approved = await s.proposals.approve(proposal.id, { retire: [old.id] });
    assert.equal(approved.lesson?.status, 'active');
    assert.equal(approved.lesson?.contradicts, null);
    const retired = s.store.find(old.id);
    assert.equal(retired?.status, 'retired');
    assert.equal(retired?.retiredReason, 'contradicted');

    const next = propose(s, { trigger: 'When editing the cart', action: 'Keep totals in whole cents only', contradicts: approved.lesson?.key ?? '' });
    const both = await s.proposals.approve(next.proposal.id, { keepBoth: true });
    assert.equal(both.lesson?.status, 'active');
    assert.equal(s.store.find(approved.lesson?.id ?? '')?.status, 'active');
  } finally {
    s.db.close();
  }
});

test('keeping both against a global lesson makes the project lesson override it', async () => {
  const s = setup();
  try {
    const project = await activeLesson(s, { trigger: 'When naming branches', action: 'Use the ticket id first' });
    const global = s.lessons.promote(project.id);
    const { proposal } = propose(s, { trigger: 'When naming branches', action: 'Use the author name first', contradicts: global.key });
    assert.equal(proposal.lesson?.contradicts, global.id);
    const approved = await s.proposals.approve(proposal.id, { keepBoth: true });
    assert.equal(approved.lesson?.overrides, global.id);
  } finally {
    s.db.close();
  }
});

test('the same rule again: an active lesson is seen once more, a waiting proposal gains evidence, a rejected one is dropped', async () => {
  const s = setup();
  try {
    const first = propose(s);
    // Same as a proposal that waits
    const again = s.lessons.createFromCandidates([candidate()], ctx());
    assert.deepEqual(again, { proposed: 0, merged: 0, appended: 1, dropped: {} });
    assert.equal(s.proposals.list('p1').length, 1);
    assert.equal(s.proposals.list('p1')[0]?.lesson?.evidence.length, 2);

    const approved = await s.proposals.approve(first.proposal.id);
    const merged = s.lessons.createFromCandidates([candidate()], ctx());
    assert.deepEqual(merged, { proposed: 0, merged: 1, appended: 0, dropped: {} });
    assert.equal(s.lessons.get(approved.lesson?.id ?? '').seenCount, 2);

    const other = propose(s, { trigger: 'When writing tests', action: 'Use the node test runner' });
    s.proposals.reject(other.proposal.id, { reason: 'no' });
    const dropped = s.lessons.createFromCandidates([candidate({ trigger: 'When writing tests', action: 'Use the node test runner' })], ctx());
    assert.deepEqual(dropped.dropped, { 'duplicate-rejected': 1 });
    assert.equal(dropped.proposed, 0);
  } finally {
    s.db.close();
  }
});

test('a candidate with no known signal is dropped', () => {
  const s = setup();
  try {
    const result = s.lessons.createFromCandidates([candidate({ signals: ['gone'] })], ctx());
    assert.deepEqual(result.dropped, { 'no-signal': 1 });
    assert.equal(s.proposals.list('p1').length, 0);
  } finally {
    s.db.close();
  }
});

test('a retired lesson seen again is proposed as "Brings back", and approving restores it with the new evidence', async () => {
  const s = setup();
  try {
    const lesson = await activeLesson(s);
    s.lessons.retire(lesson.id);
    const { proposal, created } = propose(s);
    assert.equal(created, 1);
    assert.match(proposal.reason, new RegExp(`Brings back ${lesson.key}`));
    assert.equal(proposal.lesson?.id, lesson.id);
    assert.equal(proposal.lesson?.status, 'retired');
    // Seen a third time while the proposal waits: no second proposal
    assert.equal(s.lessons.createFromCandidates([candidate()], ctx()).appended, 1);
    assert.equal(s.proposals.list('p1').filter((p) => p.status === 'pending').length, 1);
    await assert.rejects(s.proposals.approve(proposal.id, { retire: [lesson.id] }), refuses(400));

    const approved = await s.proposals.approve(proposal.id);
    assert.equal(approved.lesson?.status, 'active');
    assert.ok((approved.lesson?.evidence.length ?? 0) >= 3);
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'restored'));
  } finally {
    s.db.close();
  }
});

test('rejecting a lesson proposal rejects the lesson in the same decision; rejecting a "brings back" proposal leaves the lesson retired', async () => {
  const s = setup();
  try {
    const { proposal } = propose(s);
    const rejected = s.proposals.reject(proposal.id, { reason: 'wrong' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectReason, 'wrong');
    assert.equal(rejected.lesson?.status, 'rejected');
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'rejected'));

    const lesson = await activeLesson(s, { trigger: 'When writing docs', action: 'Keep sentences short' });
    s.lessons.retire(lesson.id);
    const back = propose(s, { trigger: 'When writing docs', action: 'Keep sentences short' });
    assert.equal(s.proposals.reject(back.proposal.id).lesson?.status, 'retired');
  } finally {
    s.db.close();
  }
});

test('a failed lesson approval releases the proposal and leaves the lesson proposed', async () => {
  const s = setup();
  try {
    const { proposal } = propose(s);
    const real = s.lessons.approveProposed.bind(s.lessons);
    s.lessons.approveProposed = () => {
      throw new WorkItemError('the lesson changed meanwhile', 409);
    };
    await assert.rejects(s.proposals.approve(proposal.id), refuses(409));
    s.lessons.approveProposed = real;
    const after = s.proposals.find(proposal.id);
    assert.equal(after?.status, 'pending');
    assert.equal(after?.decidedAt, null);
    assert.equal(after?.lesson?.status, 'proposed');
    assert.equal((await s.proposals.approve(proposal.id)).lesson?.status, 'active');
  } finally {
    s.db.close();
  }
});

test('an instructions proposal made from a lesson retires it on approval, and a failed write releases both rows', async () => {
  const s = setup();
  try {
    const lesson = await activeLesson(s);
    const made = s.proposals.propose(
      'p1',
      { target: { kind: 'instructions', file: null, section: 'Lessons' }, text: '- When editing the cart: keep totals in cents', reason: 'from a lesson' },
      { proposedBy: { kind: 'person', role: null }, lessonId: lesson.id },
    );
    assert.equal(made.lessonId, lesson.id);

    // CLAUDE.md that cannot be read: the write fails after the lesson was retired with the claim
    mkdirSync(join(s.projectDir, 'CLAUDE.md'));
    await assert.rejects(s.proposals.approve(made.id));
    assert.equal(s.proposals.find(made.id)?.status, 'pending');
    assert.equal(s.store.find(lesson.id)?.status, 'active');
    assert.equal(s.store.find(lesson.id)?.retiredReason, null);
  } finally {
    s.db.close();
  }
});

test('approving an instructions proposal made from a lesson writes CLAUDE.md and retires the lesson with reason instructions', async () => {
  const s = setup();
  try {
    const lesson = await activeLesson(s);
    const made = s.proposals.propose(
      'p1',
      { target: { kind: 'instructions', file: null, section: 'Lessons' }, text: '- When editing the cart: keep totals in cents', reason: 'from a lesson' },
      { proposedBy: { kind: 'person', role: null }, lessonId: lesson.id },
    );
    writeFileSync(join(s.projectDir, 'CLAUDE.md'), '# Project\n');
    await s.proposals.approve(made.id);
    assert.match(readFileSync(join(s.projectDir, 'CLAUDE.md'), 'utf8'), /keep totals in cents/);
    const retired = s.store.find(lesson.id);
    assert.equal(retired?.status, 'retired');
    assert.equal(retired?.retiredReason, 'instructions');
  } finally {
    s.db.close();
  }
});

test('the sweep retires per the decay table and a confirmation that lands in between wins', async () => {
  const s = setup();
  try {
    const lesson = await activeLesson(s);
    tick(239);
    assert.equal(s.lessons.sweep().length, 0);
    tick(1);
    const swept = s.lessons.sweep();
    assert.deepEqual(swept.map((l) => [l.id, l.status, l.retiredReason]), [[lesson.id, 'retired', 'decayed']]);
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'retired'));

    // Another lesson, which a confirmation reaches between the sweep's read and its update
    const second = await activeLesson(s, { trigger: 'When writing docs', action: 'Keep sentences short' });
    tick(240);
    const real = s.store.retireDecayed.bind(s.store);
    s.store.retireDecayed = (id, at) => {
      s.store.confirm(id);
      return real(id, at);
    };
    assert.equal(s.lessons.sweep().length, 0);
    assert.equal(s.store.find(second.id)?.status, 'active');
  } finally {
    s.db.close();
  }
});

test('edit, pin, confirm, retire, restore and delete follow the lifecycle', async () => {
  const s = setup();
  try {
    const lesson = await activeLesson(s);
    assert.throws(() => s.lessons.update(lesson.id, {}), refuses(400));
    assert.throws(() => s.lessons.update(lesson.id, { action: 'run `a && b`' }), refuses(400));
    const edited = s.lessons.update(lesson.id, { action: 'Keep totals in whole cents', pinned: true });
    assert.equal(edited.action, 'Keep totals in whole cents');
    assert.equal(edited.pinned, true);
    assert.equal(edited.confidence, 0.8);
    assert.equal(s.lessons.confirm(lesson.id).confidence, 0.9);
    assert.equal(s.lessons.retire(lesson.id).status, 'retired');
    assert.throws(() => s.lessons.confirm(lesson.id), refuses(409));
    assert.throws(() => s.lessons.update(lesson.id, { pinned: false }), refuses(409));
    assert.equal(s.lessons.restore(lesson.id).status, 'active');
    s.lessons.delete(lesson.id);
    assert.equal(s.store.find(lesson.id), null);
    assert.throws(() => s.lessons.get(lesson.id), refuses(404));

    const waiting = propose(s);
    assert.throws(() => s.lessons.delete(waiting.proposal.lesson?.id ?? ''), refuses(409));
    for (const action of ['edited', 'pinned', 'confirmed', 'retired', 'restored', 'deleted']) {
      assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === action), action);
    }
  } finally {
    s.db.close();
  }
});

test('promote makes a global copy, demote returns it, and alsoInProjects counts the same rule elsewhere', async () => {
  const s = setup();
  try {
    const here = await activeLesson(s);
    const elsewhere = await activeLesson(s, {}, 'p2');
    assert.equal(s.lessons.get(here.id).alsoInProjects, 1);
    assert.equal(s.lessons.get(elsewhere.id).alsoInProjects, 1);

    const global = s.lessons.promote(here.id);
    assert.equal(global.projectId, null);
    assert.equal(s.lessons.get(here.id).status, 'superseded');
    assert.throws(() => s.lessons.promote(here.id), refuses(409));
    assert.deepEqual(s.lessons.list(null).map((l) => l.id), [global.id]);

    const back = s.lessons.demote(global.id);
    assert.equal(back.id, here.id);
    assert.equal(back.status, 'active');
    assert.equal(s.store.find(global.id), null);
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'promoted'));
    assert.ok(s.events.some((e) => e.type === 'lesson.changed' && e.action === 'demoted'));
  } finally {
    s.db.close();
  }
});

test('export lists every status of the project and none of another', async () => {
  const s = setup();
  try {
    const kept = await activeLesson(s);
    const gone = propose(s, { trigger: 'When writing tests', action: 'Use the node test runner' });
    s.proposals.reject(gone.proposal.id);
    await activeLesson(s, {}, 'p2');
    const exported = s.lessons.export('p1');
    assert.deepEqual(exported.map((l) => l.status).sort(), ['active', 'rejected']);
    assert.ok(exported.some((l) => l.id === kept.id));
  } finally {
    s.db.close();
  }
});
