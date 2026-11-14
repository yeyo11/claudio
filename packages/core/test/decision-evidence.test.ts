import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ContinuationEffect, DecisionAnswer, DecisionPointId, DecisionRecord } from '@claudio/shared';
import { Db, DECISION_EVIDENCE_SCHEMA_VERSION, migrate, type DecisionEvidenceRow } from '../src/db.ts';
import { DecisionEngine } from '../src/decisions/engine.ts';
import { pointEvidence, rate, scoreEvidence } from '../src/decisions/evidence.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionResolvers } from '../src/decisions/resolve.ts';
import { choiceOf, decisionRig, noulOf } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// The evidence layer of docs/plans/decision-engine-v2.md (M2 to M6): the resolvers that say how far
// they can be trusted, the run effect of each answer, the baseline beside every row, and the scorer
// the promotion gate reads.

const T0 = '2026-09-01T10:00:00.000Z';
const AFTER = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** `now` is the resolvers' clock: a point with a reach (`health.semantic-loop`) is only swept near its rows */
function setup(now = '2026-09-02T00:00:00.000Z') {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const engine = new DecisionEngine({ settings: { get: () => ({ historyDays: 30 }) } as never, db, projectDecisions: () => null });
  const resolvers = new DecisionResolvers({ sql: db.connection, db, engine, historyDays: () => 30, now: () => new Date(now) });
  let n = 0;
  const row = (point: DecisionPointId, over: Partial<DecisionRecord> & { answers: Record<string, DecisionAnswer> | null }): DecisionRecord => {
    const record: DecisionRecord = {
      id: `d${String(++n)}`,
      point,
      kind: 'act',
      projectId: 'p1',
      subjectKind: 'task',
      subjectId: null,
      provider: 'jev',
      model: 'jev-1',
      mode: 'shadow',
      status: 'answered',
      unavailable: null,
      state: {},
      questions: [],
      confidence: 0.9,
      threshold: 0.85,
      acted: false,
      visible: false,
      savedRun: false,
      runEffect: 0,
      baseline: null,
      heldOut: false,
      latencyMs: 10,
      inputTokens: 1,
      costUsd: 0,
      outcome: null,
      agreed: null,
      resolvedAt: null,
      feedback: null,
      feedbackAt: null,
      openedAt: null,
      paletteAction: null,
      at: T0,
      ...over,
    };
    db.insertDecision(record);
    return record;
  };
  const orchestration = (id: string, task: Record<string, unknown>): void => {
    db.connection.prepare('INSERT INTO orchestrations (id, created_at, json) VALUES (?, ?, ?)').run(id, T0, JSON.stringify({ id, status: 'completed', tasks: [{ id: 't1', status: 'completed', attempts: 1, ...task }] }));
  };
  const audit = (actor: string, route: string, path: string, at: string, status = 200): void => {
    db.connection.prepare('INSERT INTO audit (at, actor, method, path, status, summary, route) VALUES (?, ?, ?, ?, ?, ?, ?)').run(at, actor, 'POST', path, status, 's', route);
  };
  const get = (id: string) => db.decision(id);
  return { db, row, get, resolvers, orchestration, audit };
}

const effect = (n: number, cause: ContinuationEffect['cause'], changed: boolean): ContinuationEffect => ({ n, cause, changed, commits: changed ? 1 : 0, edits: changed ? 2 : 0 });

// ---------- run.continuation ----------

test('run.continuation: an acted owes-work is right when the continuation it caused changed something', () => {
  const s = setup();
  s.orchestration('o1', { continuations: 1, continuationEffects: [effect(1, 'decision', true)] });
  const r = s.row('run.continuation', { subjectId: 'o1:t1', mode: 'active', acted: true, state: { continuations: 'no continuation yet' }, answers: { report: choiceOf('owes-work') } });
  s.resolvers.sweep();
  assert.deepEqual([s.get(r.id)?.agreed, s.get(r.id)?.outcome?.quality], [true, 'direct']);
});

test('run.continuation: an acted owes-work is wrong when the continuation it caused changed nothing', () => {
  const s = setup();
  s.orchestration('o1', { continuations: 2, continuationEffects: [effect(1, 'decision', true), effect(2, 'decision', false)] });
  const r = s.row('run.continuation', { subjectId: 'o1:t1', mode: 'active', acted: true, state: { continuations: 'one continuation so far' }, answers: { report: choiceOf('owes-work') } });
  s.resolvers.sweep();
  assert.deepEqual([s.get(r.id)?.agreed, s.get(r.id)?.outcome?.quality, s.get(r.id)?.outcome?.detail?.n], [false, 'direct', 2]);
});

test('run.continuation: a task that completed with no continuation recorded leaves the row unresolved', () => {
  const s = setup();
  // The old proxy scored this as "the task completed": a disagreement with owes-work, an agreement with done
  s.orchestration('o1', { continuations: 0 });
  const owes = s.row('run.continuation', { subjectId: 'o1:t1', mode: 'active', acted: true, state: { continuations: 0 }, answers: { report: choiceOf('owes-work') } });
  const done = s.row('run.continuation', { subjectId: 'o1:t1', state: { continuations: 0 }, answers: { report: choiceOf('done') } });
  assert.equal(s.resolvers.sweep(), 0);
  assert.equal(s.get(owes.id)?.resolvedAt, null);
  assert.equal(s.get(done.id)?.resolvedAt, null);
});

test("run.continuation: a shadow row is judged by the continuation today's rule sent, and only then", () => {
  const s = setup();
  s.orchestration('o1', { continuations: 1, continuationEffects: [effect(1, 'phrase', false)] });
  s.orchestration('o2', { continuations: 1, continuationEffects: [effect(1, 'structural', true)] });
  const doneRight = s.row('run.continuation', { subjectId: 'o1:t1', state: { continuations: 0 }, answers: { report: choiceOf('done') } });
  const owesWrong = s.row('run.continuation', { subjectId: 'o1:t1', state: { continuations: 0 }, answers: { report: choiceOf('owes-work') } });
  const doneWrong = s.row('run.continuation', { subjectId: 'o2:t1', state: { continuations: 0 }, answers: { report: choiceOf('done') } });
  // Asked after the first continuation: the second one never happened, so there is nothing to read
  const later = s.row('run.continuation', { subjectId: 'o1:t1', state: { continuations: 1 }, answers: { report: choiceOf('done') } });
  s.resolvers.sweep();
  assert.equal(s.get(doneRight.id)?.agreed, true);
  assert.equal(s.get(owesWrong.id)?.agreed, false);
  assert.equal(s.get(doneWrong.id)?.agreed, false);
  assert.equal(s.get(later.id)?.resolvedAt, null);
  assert.equal(s.get(doneRight.id)?.outcome?.quality, 'direct');
});

test("run.continuation: a flow run's continuation effects are read from its row", () => {
  const s = setup();
  s.db.connection
    .prepare(
      `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, queued_at, ended_at, continuation_effects)
       VALUES ('r1', 'p1', 'i1', 'dev', 'dev', 'm', 'work', 'in_progress', 'ended', 'passed', ?, ?, ?)`,
    )
    .run(T0, T0, JSON.stringify([effect(1, 'decision', false)]));
  const r = s.row('run.continuation', { subjectKind: 'flow_run', subjectId: 'r1', mode: 'active', acted: true, state: { continuations: 'no continuation yet' }, answers: { report: choiceOf('owes-work') } });
  const unknown = s.row('run.continuation', { subjectKind: 'flow_run', subjectId: 'r1', state: { continuations: 'several continuations so far' }, answers: { report: choiceOf('owes-work') } });
  s.resolvers.sweep();
  assert.deepEqual([s.get(r.id)?.agreed, s.get(r.id)?.outcome?.summary], [false, 'The continuation changed nothing']);
  assert.equal(s.get(unknown.id)?.resolvedAt, null, 'a count it cannot read says nothing');
});

test('run.continuation: the answers of state version 2 resolve as the old ones did, hands-off as a stop', () => {
  const s = setup();
  s.orchestration('o1', { continuations: 1, continuationEffects: [effect(1, 'decision', true)] });
  s.orchestration('o2', { continuations: 1, continuationEffects: [effect(1, 'phrase', false)] });
  s.orchestration('o3', { continuations: 1, continuationEffects: [effect(1, 'phrase', true)] });
  const owesRight = s.row('run.continuation', { subjectId: 'o1:t1', mode: 'active', acted: true, state: { continuations: 'no continuation yet' }, answers: { report: choiceOf('owes-own-work') } });
  const handsOffRight = s.row('run.continuation', { subjectId: 'o2:t1', state: { continuations: 'no continuation yet' }, answers: { report: choiceOf('hands-off') } });
  const handsOffWrong = s.row('run.continuation', { subjectId: 'o3:t1', state: { continuations: 'no continuation yet' }, answers: { report: choiceOf('hands-off') } });
  // An old id and a new one on the same facts read the same way
  const owesOld = s.row('run.continuation', { subjectId: 'o2:t1', state: { continuations: 0 }, answers: { report: choiceOf('owes-work') } });
  const owesNew = s.row('run.continuation', { subjectId: 'o2:t1', state: { continuations: 0 }, answers: { report: choiceOf('owes-own-work') } });
  const unknown = s.row('run.continuation', { subjectId: 'o2:t1', state: { continuations: 0 }, answers: { report: choiceOf('maybe') } });
  s.resolvers.sweep();
  assert.deepEqual([s.get(owesRight.id)?.agreed, s.get(owesRight.id)?.outcome?.quality], [true, 'direct']);
  assert.equal(s.get(handsOffRight.id)?.agreed, true);
  assert.equal(s.get(handsOffWrong.id)?.agreed, false);
  assert.deepEqual([s.get(owesOld.id)?.agreed, s.get(owesNew.id)?.agreed], [false, false]);
  assert.equal(s.get(unknown.id)?.resolvedAt, null);
});

test('run.continuation: an acted hands-off says nothing about a continuation only the decision could have sent', () => {
  const s = setup();
  s.orchestration('o1', { continuations: 1, continuationEffects: [effect(1, 'decision', false)] });
  const r = s.row('run.continuation', { subjectId: 'o1:t1', mode: 'active', acted: true, state: { continuations: 0 }, answers: { report: choiceOf('hands-off') } });
  s.resolvers.sweep();
  assert.equal(s.get(r.id)?.resolvedAt, null);
});

// ---------- health.semantic-loop ----------

/** An hour after the rows: inside the point's reach, and past every action the tests write */
const LOOP_NOW = AFTER(60);

test("health.semantic-loop: a person's stop after the flag is a direct agreement", () => {
  const s = setup(LOOP_NOW);
  const r = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c1', answers: { loop: noulOf(true) } });
  s.audit('local', 'POST /chats/:id/stop', '/api/chats/c1/stop', AFTER(5));
  s.resolvers.sweep();
  assert.deepEqual([s.get(r.id)?.agreed, s.get(r.id)?.outcome?.quality, s.get(r.id)?.outcome?.detail?.route], [true, 'direct', 'POST /chats/:id/stop']);
});

test('health.semantic-loop: a hint on the orchestration task the chat works for counts as stepping in', () => {
  const s = setup(LOOP_NOW);
  s.db.connection.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)').run('c1', T0, JSON.stringify({ orchestrationId: 'o1', orchestrationTaskId: 't1' }));
  const r = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c1', answers: { loop: noulOf(true) } });
  s.audit('token:abc', 'POST /orchestrations/:id/tasks/:taskId/hint', '/api/orchestrations/o1/tasks/t1/hint', AFTER(2));
  s.resolvers.sweep();
  assert.equal(s.get(r.id)?.agreed, true);
});

test('health.semantic-loop: a Supervisor hint, a chat token, a late action or a plain message leave the flag unresolved', () => {
  const s = setup(LOOP_NOW);
  // The old resolver read this as agreement: 525 of 525 on the owner's install
  s.db.connection.prepare("INSERT INTO supervisor_proposals (id, chat_id, signal, hint, cost_usd, at, status) VALUES ('sp', 'c1', 'loop', 'h', 0, ?, 'sent')").run(AFTER(1));
  const r = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c1', answers: { loop: noulOf(true) } });
  s.audit('chat:c9', 'POST /chats/:id/stop', '/api/chats/c1/stop', AFTER(3));
  s.audit('local', 'POST /chats/:id/messages', '/api/chats/c1/messages', AFTER(4));
  s.audit('local', 'POST /chats/:id/stop', '/api/chats/c1/stop', AFTER(45));
  s.audit('local', 'POST /chats/:id/stop', '/api/chats/c10/stop', AFTER(5));
  // A flag on another chat that a person did stop: the sweep reads these rows, and resolves only that one
  const control = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c2', answers: { loop: noulOf(true) } });
  s.audit('local', 'POST /chats/:id/stop', '/api/chats/c2/stop', AFTER(6));
  assert.equal(s.resolvers.sweep(), 1);
  assert.equal(s.get(control.id)?.agreed, true);
  assert.equal(s.get(r.id)?.resolvedAt, null);
});

test('health.semantic-loop: a no is never judged, and a person can still say the flag was wrong', () => {
  const s = setup(LOOP_NOW);
  const no = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c1', answers: { loop: noulOf(false) } });
  const flagged = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c2', answers: { loop: noulOf(true) } });
  s.audit('local', 'POST /chats/:id/stop', '/api/chats/c1/stop', AFTER(5));
  s.db.setDecisionFeedback(flagged.id, 'not_useful', AFTER(6));
  s.resolvers.sweep();
  assert.equal(s.get(no.id)?.resolvedAt, null);
  assert.equal(s.get(flagged.id)?.agreed, false);
});

test('health.semantic-loop: a flag older than the reach of a person\'s answer is not read at all', () => {
  // Fourteen hours on, past the half hour a person's action counts and the grace for a late sweep
  const s = setup('2026-09-02T00:00:00.000Z');
  const r = s.row('health.semantic-loop', { kind: 'suggest', subjectKind: 'chat', subjectId: 'c1', answers: { loop: noulOf(true) } });
  s.audit('local', 'POST /chats/:id/stop', '/api/chats/c1/stop', AFTER(5));
  assert.equal(s.resolvers.sweep(), 0);
  assert.equal(s.get(r.id)?.resolvedAt, null);
});

// ---------- supervisor.intervene ----------

const proposal = (s: ReturnType<typeof setup>, chat: string, signal: string, status: string, occurrence = '', sentBy: 'supervisor' | 'person' | null = null): void => {
  s.db.connection
    .prepare('INSERT INTO supervisor_proposals (id, chat_id, signal, occurrence, hint, cost_usd, at, status, sent_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .run(`sp-${chat}-${signal}`, chat, signal, occurrence, 'h', AFTER(1), status, sentBy);
};
const command = (s: ReturnType<typeof setup>, chat: string, toolUseId: string, startedAt: string, durationMs: number, outcome: string, kind = 'pnpm test'): void => {
  s.db.connection.prepare('INSERT INTO command_durations (kind, chat_id, tool_use_id, started_at, duration_ms, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(kind, chat, toolUseId, startedAt, durationMs, outcome);
};
const intervene = (s: ReturnType<typeof setup>, chat: string, signal: string, stuck: boolean, mode: 'shadow' | 'active' = 'shadow') =>
  s.row('supervisor.intervene', { subjectKind: 'chat', subjectId: chat, mode, state: { signal }, answers: { intervene: noulOf(stuck) } });

test('supervisor.intervene: a hung command that then ended by itself makes "stuck" wrong, directly', () => {
  const s = setup();
  command(s, 'c0', 'old', '2026-08-01T10:00:00.000Z', 60_000, 'ok');
  command(s, 'c1', 'tu1', AFTER(-20), 25 * 60_000, 'ok');
  proposal(s, 'c1', 'hung-command', 'sent', 'tu1');
  const r = intervene(s, 'c1', 'hung-command', true, 'active');
  s.resolvers.sweep();
  const out = s.get(r.id)?.outcome;
  assert.deepEqual([s.get(r.id)?.agreed, out?.quality, out?.detail?.usualMs], [false, 'direct', 60_000]);
});

test('supervisor.intervene: a hung command a person cancelled makes "stuck" right in any mode; one the Supervisor cancelled is only a proxy', () => {
  const s = setup();
  command(s, 'c1', 'tu1', AFTER(-20), 30 * 60_000, 'cancelled');
  command(s, 'c2', 'tu2', AFTER(-20), 30 * 60_000, 'cancelled');
  command(s, 'c3', 'tu3', AFTER(-20), 30 * 60_000, 'cancelled');
  command(s, 'c4', 'tu4', AFTER(-20), 30 * 60_000, 'cancelled');
  // No proposal: the command running when the question was asked is the one it was about
  const shadow = intervene(s, 'c1', 'hung-command', true);
  // Under Active with no hint the Supervisor sent, the cancel can only have been a person's
  const active = intervene(s, 'c2', 'hung-command', true, 'active');
  proposal(s, 'c3', 'hung-command', 'sent', 'tu3', 'supervisor');
  const bySupervisor = intervene(s, 'c3', 'hung-command', true, 'active');
  // A sent row from before `sent_by` was kept is read by the mode, as it was
  proposal(s, 'c4', 'hung-command', 'sent', 'tu4');
  const stored = intervene(s, 'c4', 'hung-command', true, 'active');
  s.resolvers.sweep();
  assert.deepEqual([s.get(shadow.id)?.agreed, s.get(shadow.id)?.outcome?.quality], [true, 'direct']);
  assert.deepEqual([s.get(active.id)?.agreed, s.get(active.id)?.outcome?.quality], [true, 'direct']);
  assert.deepEqual([s.get(bySupervisor.id)?.agreed, s.get(bySupervisor.id)?.outcome?.quality], [true, 'proxy']);
  assert.deepEqual([s.get(stored.id)?.agreed, s.get(stored.id)?.outcome?.quality], [true, 'proxy']);
});

test("supervisor.intervene: a person's send is a direct outcome under Active too; the Supervisor's own send stays a proxy", () => {
  const s = setup();
  proposal(s, 'c1', 'no-progress', 'sent', '', 'person');
  proposal(s, 'c2', 'no-progress', 'sent', '', 'supervisor');
  proposal(s, 'c3', 'no-progress', 'not-stuck');
  const person = intervene(s, 'c1', 'no-progress', true, 'active');
  const itself = intervene(s, 'c2', 'no-progress', true, 'active');
  // The draft found the worker not stuck: a model's reading, so a proxy for "no hint helps"
  const notStuck = intervene(s, 'c3', 'no-progress', true, 'shadow');
  s.resolvers.sweep();
  assert.deepEqual([s.get(person.id)?.agreed, s.get(person.id)?.outcome?.quality], [true, 'direct']);
  assert.deepEqual([s.get(itself.id)?.agreed, s.get(itself.id)?.outcome?.quality], [true, 'proxy']);
  assert.deepEqual([s.get(notStuck.id)?.agreed, s.get(notStuck.id)?.outcome?.quality], [false, 'proxy']);
});

test("supervisor.intervene: other signals are judged by a person's Send or Dismiss; the Supervisor's own send is a proxy", () => {
  const s = setup();
  proposal(s, 'c1', 'repeat-stall', 'sent');
  proposal(s, 'c2', 'repeat-stall', 'dismissed');
  proposal(s, 'c3', 'repeat-stall', 'sent');
  proposal(s, 'c4', 'repeat-stall', 'proposed');
  const personSent = intervene(s, 'c1', 'repeat-stall', true);
  const dismissed = intervene(s, 'c2', 'repeat-stall', true, 'active');
  const selfSent = intervene(s, 'c3', 'repeat-stall', true, 'active');
  const waiting = intervene(s, 'c4', 'repeat-stall', true);
  s.resolvers.sweep();
  assert.deepEqual([s.get(personSent.id)?.agreed, s.get(personSent.id)?.outcome?.quality], [true, 'direct']);
  assert.deepEqual([s.get(dismissed.id)?.agreed, s.get(dismissed.id)?.outcome?.quality], [false, 'direct']);
  assert.deepEqual([s.get(selfSent.id)?.agreed, s.get(selfSent.id)?.outcome?.quality], [true, 'proxy']);
  assert.equal(s.get(waiting.id)?.resolvedAt, null);
});

// ---------- quality of the other resolvers, and of stored rows ----------

test('an outcome stored before outcomes carried a quality reads as proxy', () => {
  const s = setup();
  const r = s.row('flow.bounce', { answers: { bounce: choiceOf('fixable') } });
  s.db.connection.prepare('UPDATE decisions SET outcome = ? WHERE id = ?').run(JSON.stringify({ summary: 'old', agreed: true }), r.id);
  assert.equal(s.get(r.id)?.outcome?.quality, 'proxy');
});

test('a later QA verdict is a proxy, a retry that completed is direct', () => {
  const s = setup();
  s.db.connection
    .prepare(
      `INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, outcome, queued_at, ended_at)
       VALUES ('v1', 'p1', 'i1', 'qa', 'qa', 'm', 'verify', 'in_review', 'ended', 'rejected', ?, ?)`,
    )
    .run(T0, AFTER(10));
  const scope = s.row('flow.scope-drift', { kind: 'suggest', subjectKind: 'work_item', subjectId: 'i1', answers: { c1: noulOf(true) } });
  s.orchestration('o1', { attempts: 3 });
  const retry = s.row('orchestration.retry', { subjectId: 'o1:t1', state: { attempt: 'first attempt' }, answers: { retry: choiceOf('transient') } });
  s.resolvers.sweep();
  assert.equal(s.get(scope.id)?.outcome?.quality, 'proxy');
  assert.deepEqual([s.get(retry.id)?.agreed, s.get(retry.id)?.outcome?.quality], [true, 'direct']);
});

// ---------- run effect and baseline ----------

test('the engine stores the baseline and counts runs per answer against it', async () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const rig = decisionRig(db, config);
  await rig.configure('run.continuation', 'active');
  const subject = { kind: 'task' as const, id: 'o1:t1', data: { title: 't', tail: 'I will now run the tests.', continuations: 'no continuation yet' } };
  rig.provider.script = () => ({ report: choiceOf('owes-own-work', 0.99) });
  await rig.engine.ask('run.continuation', subject, { projectId: null, baseline: [] });
  await rig.engine.ask('run.continuation', subject, { projectId: null, baseline: ['run the tests'] });
  await rig.engine.ask('run.continuation', subject, { projectId: null });
  rig.provider.script = () => ({ report: choiceOf('done', 0.99) });
  await rig.engine.ask('run.continuation', subject, { projectId: null, baseline: ['run the tests'] });
  await rig.engine.ask('run.continuation', subject, { projectId: null, baseline: [] });
  rig.provider.script = () => ({ report: choiceOf('done', 0.5) });
  await rig.engine.ask('run.continuation', subject, { projectId: null, baseline: ['run the tests'] });
  const rows = rig.rows('run.continuation').reverse();
  // A continuation the phrase list would not have sent is caused; one it would have sent is not
  assert.deepEqual(
    rows.map((r) => [r.runEffect, r.savedRun, r.baseline]),
    [
      [-1, false, []],
      [0, false, ['run the tests']],
      [-1, false, null],
      [1, true, ['run the tests']],
      [0, false, []],
      [0, false, ['run the tests']],
    ],
  );
  const stats = rig.engine.stats('2000-01-01T00:00:00.000Z');
  assert.deepEqual([stats.runsSaved, stats.runsCaused, stats.netRuns, stats.claudeRunsSaved], [1, 2, -1, 1]);
  const point = stats.points.find((p) => p.point === 'run.continuation');
  assert.deepEqual([point?.runsSaved, point?.runsCaused, point?.netRuns], [1, 2, -1]);
  // owes-own-work against [], and done (acted or not) against ['run the tests'], differ from the phrase list
  assert.deepEqual(point?.baseline, { rows: 5, differs: 3, decisionRight: 0, baselineRight: 0, unresolved: 3 });
  db.close();
});

test('a point that starts a miner or a fix on yes causes a run; a decline of the Supervisor saves one', () => {
  const runs = (point: DecisionPointId, answers: Record<string, DecisionAnswer>): number => decisionPoint(point)?.effect.runs(answers, null) ?? NaN;
  assert.equal(runs('lesson.mine', { mine: noulOf(true) }), -1);
  assert.equal(runs('lesson.mine', { mine: noulOf(false) }), 0);
  assert.equal(runs('checks.fix', { fix: choiceOf('branch-fixable') }), -1);
  assert.equal(runs('supervisor.intervene', { intervene: noulOf(false) }), 1);
  assert.equal(runs('supervisor.intervene', { intervene: noulOf(true) }), 0);
  assert.equal(runs('flow.bounce', { bounce: choiceOf('needs-person') }), 1);
  assert.equal(runs('flow.bounce', { bounce: choiceOf('fixable') }), 0);
  assert.deepEqual([decisionPoint('run.continuation')?.effect.savesRun, decisionPoint('run.continuation')?.effect.causesRun], [true, true]);
});

// ---------- the scorer ----------

test('the Wilson lower bound is below the observed rate and grows with the sample', () => {
  const small = rate(8, 10);
  const large = rate(80, 100);
  assert.equal(small.value, 0.8);
  assert.ok((small.lower90 ?? 1) < 0.8 && (small.lower90 ?? 0) > 0.55);
  assert.ok((large.lower90 ?? 0) > (small.lower90 ?? 1));
  assert.ok(Math.abs((large.lower90 ?? 0) - 0.7441) < 0.001);
  assert.deepEqual(rate(0, 0), { n: 0, hits: 0, value: null, lower90: null });
});

test('the scorer reads labelled cases: precision, the baseline, calibration and the act rate', () => {
  const score = scoreEvidence([
    { acts: true, confidence: 1, positive: true, baselineActs: false },
    { acts: true, confidence: 1, positive: false, baselineActs: true },
    { acts: true, confidence: 0.92, positive: true, baselineActs: true },
    { acts: false, confidence: 0.7, positive: false, baselineActs: true },
    { acts: false, confidence: null, positive: null, baselineActs: true },
    { acts: true, confidence: 0.99, positive: null },
  ]);
  assert.deepEqual([score.precision.hits, score.precision.n], [2, 3]);
  assert.deepEqual([score.baselinePrecision.hits, score.baselinePrecision.n], [1, 3]);
  assert.deepEqual(score.baseline, { rows: 5, differs: 3, decisionRight: 2, baselineRight: 0, unresolved: 1 });
  assert.deepEqual([score.actRate.hits, score.actRate.n], [4, 6]);
  const exact = score.calibration.at(-1);
  assert.deepEqual([exact?.from, exact?.to, exact?.all.n, exact?.acting.hits], [1, 1, 2, 1]);
  const ninety = score.calibration.find((b) => b.from === 0.9);
  assert.deepEqual([ninety?.to, ninety?.all.hits], [0.95, 1]);
});

test('point evidence takes truth only from direct outcomes and a person, and counts the rest', () => {
  const row = (over: Partial<DecisionEvidenceRow>): DecisionEvidenceRow => ({
    point: 'flow.bounce',
    answers: { bounce: choiceOf('needs-person') },
    state: {},
    confidence: 0.9,
    acted: true,
    heldOut: false,
    baseline: 'fixable',
    outcome: null,
    agreed: null,
    feedback: null,
    mode: 'active',
    at: T0,
    ...over,
  });
  const evidence = pointEvidence('flow.bounce', [
    row({ outcome: { summary: 'a person', agreed: true, quality: 'direct' }, agreed: true }),
    row({ outcome: { summary: 'QA', agreed: true, quality: 'proxy' }, agreed: true }),
    row({ outcome: { summary: 'QA', agreed: true, quality: 'proxy' }, agreed: false, feedback: 'not_useful' }),
    row({ answers: { bounce: choiceOf('fixable') }, outcome: { summary: 'a person', agreed: false, quality: 'direct' }, agreed: false }),
    row({}),
    row({ point: 'flow.restart' }),
  ]);
  assert.deepEqual([evidence.answered, evidence.resolvedDirect, evidence.resolvedProxy, evidence.unresolved], [5, 3, 1, 1]);
  // Acting (needs-person): one right, one wrong by the person's word; the proxy row is not counted
  assert.deepEqual([evidence.precision.hits, evidence.precision.n], [1, 2]);
  // The code rule always says fixable: it differs wherever the answer is needs-person, and the person's not useful makes it right once
  assert.deepEqual(evidence.baseline, { rows: 5, differs: 4, decisionRight: 1, baselineRight: 1, unresolved: 2 });
  assert.deepEqual([evidence.actRate.hits, evidence.actRate.n], [4, 5]);
});

// ---------- storage ----------

test('the migration backfills each acted row by its answer and leaves the new columns empty', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, DECISION_EVIDENCE_SCHEMA_VERSION - 1);
  const insert = raw.prepare(
    `INSERT INTO decisions (id, point, kind, subject_kind, provider, model, mode, status, state, questions, answers, acted, visible, saved_run, latency_ms, at)
     VALUES (?, ?, 'act', 'task', 'jev', 'm', 'active', 'answered', '{}', '[]', ?, ?, 0, ?, 1, '2026-10-20T10:00:00Z')`,
  );
  const a = (value: unknown): string => JSON.stringify(value);
  insert.run('owes', 'run.continuation', a({ report: { kind: 'choice', value: 'owes-work', confidence: 1 } }), 1, 1);
  insert.run('done', 'run.continuation', a({ report: { kind: 'choice', value: 'done', confidence: 1 } }), 1, 1);
  insert.run('shadow', 'run.continuation', a({ report: { kind: 'choice', value: 'done', confidence: 1 } }), 0, 0);
  insert.run('decline', 'supervisor.intervene', a({ intervene: { kind: 'noul', value: false, confidence: 1 } }), 1, 1);
  insert.run('hint', 'supervisor.intervene', a({ intervene: { kind: 'noul', value: true, confidence: 1 } }), 1, 1);
  insert.run('fixer', 'orchestration.fixer', a({ 'another-attempt': { kind: 'noul', value: false, confidence: 1 } }), 1, 1);
  insert.run('precheck', 'flow.criteria-precheck', a({ c1: { kind: 'choice', value: 'met-or-unknown' }, c2: { kind: 'choice', value: 'clearly-unmet' } }), 1, 1);
  insert.run('miner', 'lesson.mine', a({ mine: { kind: 'noul', value: true, confidence: 1 } }), 1, 0);
  migrate(raw);
  const got = Object.fromEntries(
    (raw.prepare('SELECT id, run_effect, saved_run, held_out, baseline FROM decisions').all() as Array<{ id: string; run_effect: number; saved_run: number; held_out: number; baseline: string | null }>).map((r) => [
      r.id,
      [r.run_effect, r.saved_run, r.held_out, r.baseline],
    ]),
  );
  assert.deepEqual(got, {
    owes: [-1, 0, 0, null],
    done: [1, 1, 0, null],
    shadow: [0, 0, 0, null],
    decline: [1, 1, 0, null],
    hint: [0, 0, 0, null],
    fixer: [1, 1, 0, null],
    precheck: [1, 1, 0, null],
    miner: [-1, 0, 0, null],
  });
  const flowColumns = (raw.prepare('PRAGMA table_info(flow_runs)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(flowColumns.includes('continuation_effects'));
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'decision_labels'").get());
  raw.close();
});

test('labels survive the pruning of the history, and a person replaces the label an outcome wrote', () => {
  const s = setup();
  const r = s.row('run.continuation', { answers: { report: choiceOf('done') }, at: '2026-01-01T00:00:00.000Z' });
  const label = { id: 'l1', point: 'run.continuation' as const, decisionId: r.id, state: { tail: 'x' }, questions: [], positive: true, answers: null, source: 'outcome' as const, note: 'changed', at: T0 };
  s.db.saveDecisionLabel(label);
  s.db.saveDecisionLabel({ ...label, id: 'l2', positive: false, source: 'person', note: 'no work was owed' });
  s.db.saveDecisionLabel({ ...label, id: 'l3', decisionId: null, point: 'flow.bounce' });
  assert.equal(s.db.pruneDecisions('2026-06-01T00:00:00.000Z'), 1);
  assert.equal(s.get(r.id), null);
  const kept = s.db.decisionLabels('run.continuation');
  assert.deepEqual(kept.map((l) => [l.id, l.positive, l.source, l.note]), [['l1', false, 'person', 'no work was owed']]);
  assert.equal(s.db.decisionLabels().length, 2);
  assert.equal(s.db.deleteDecisionLabel('l3'), true);
});
