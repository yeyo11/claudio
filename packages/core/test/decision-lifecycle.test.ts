import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  DECISION_POINT_IDS,
  notificationsFor,
  type DecisionAnswer,
  type DecisionDemotedEvent,
  type DecisionPointId,
  type DecisionRecord,
  type DecisionStanding,
  type ProjectDecisionSettings,
} from '@claudio/shared';
import { Db } from '../src/db.ts';
import { DecisionActivationError, DecisionEngine } from '../src/decisions/engine.ts';
import { scoreEvidence } from '../src/decisions/evidence.ts';
import { DECISION_POINTS, decisionPoint } from '../src/decisions/points.ts';
import { hashQuestions, questionsHash } from '../src/decisions/questions-hash.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS, DEFAULT_GATE, JEV_MODEL, parseDecisionSettings } from '../src/decisions/settings.ts';
import { stanceOf } from '../src/decisions/stance.ts';
import { DEMOTION_CODES, demotionOf, holdoutShare, judgeActivation, standingOf, type ReplayEvidence, type RunsOn } from '../src/decisions/standing.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { choiceOf, noulOf, ScriptedProvider } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// The lifecycle of a point (docs/plans/decision-engine-v2.md §5, the owner's D1 to D3): standing,
// the promotion gate on settings writes and at run time, the holdout, the suggest floor, demotion,
// and the points that are switched on and silent.

const NOW = new Date('2026-11-13T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

interface RigOptions {
  random?: () => number;
  standing?: (point: DecisionPointId) => DecisionStanding;
  replay?: (point: DecisionPointId, runsOn: RunsOn) => ReplayEvidence | null;
  project?: ProjectDecisionSettings | null;
}

function rig(opts: RigOptions = {}) {
  const config = tempConfig();
  const db = new Db(config);
  const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  const events: ClaudioEventInput[] = [];
  const engine = new DecisionEngine({
    settings,
    db,
    projectDecisions: () => opts.project ?? null,
    now: () => NOW,
    emit: (event) => events.push(event),
    random: opts.random ?? (() => 1),
    ...(opts.standing ? { standing: opts.standing } : {}),
    ...(opts.replay ? { replayEvidence: opts.replay } : {}),
  });
  const provider = new ScriptedProvider('jev');
  engine.register(provider);
  const cli = new ScriptedProvider('cli');
  engine.register(cli);

  let n = 0;
  /** A history row of `point`, answered and resolved `direct` unless told otherwise */
  const row = (point: DecisionPointId, answers: Record<string, DecisionAnswer>, over: Partial<DecisionRecord> = {}): void => {
    const def = decisionPoint(point);
    db.insertDecision({
      id: `seed-${String(++n)}`,
      point,
      kind: def?.kind ?? 'act',
      projectId: null,
      subjectKind: 'task',
      subjectId: null,
      provider: 'jev',
      model: 'jev-1.13.0',
      mode: 'shadow',
      status: 'answered',
      unavailable: null,
      state: {},
      questions: [],
      answers,
      confidence: 0.95,
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
      outcome: { summary: 'seeded', agreed: true, quality: 'direct' },
      agreed: true,
      resolvedAt: ago(1),
      feedback: null,
      feedbackAt: null,
      openedAt: null,
      paletteAction: null,
      at: ago(1),
      ...over,
    });
  };
  /** `count` resolved rows of `flow.bounce` answering `needs-person` (the acting answer), `right` of them right */
  const bounces = (count: number, right: number, over: Partial<DecisionRecord> = {}): void => {
    for (let i = 0; i < count; i++) {
      const agreed = i < right;
      row('flow.bounce', { bounce: choiceOf('needs-person') }, { agreed, outcome: { summary: 'seeded', agreed, quality: 'direct' }, ...over });
    }
  };
  /** The document as a person's PUT would send it: what GET answers, without the key's state */
  const body = (points: Record<string, unknown> = {}): Record<string, unknown> => {
    const { jev: _jev, ...rest } = settings.get();
    return { ...rest, points: { ...rest.points, ...points } };
  };
  const consent = async (point: DecisionPointId, providers: Array<'jev' | 'cli'> = ['jev']): Promise<void> => {
    await settings.setConsent(point, { granted: true, stateVersion: decisionPoint(point)?.stateVersion ?? 1, providers });
  };
  const file = (): Record<string, unknown> => JSON.parse(readFileSync(join(config.dataDir, 'decisions.json'), 'utf8')) as Record<string, unknown>;
  return { config, db, settings, engine, provider, cli, events, row, bounces, body, consent, file };
}

const refusal = (code: string) => (error: unknown) => error instanceof DecisionActivationError && error.statusCode === 409 && error.body.code === code;

const subject = { kind: 'flow_run' as const, id: 'run-1', data: { rejection: 'tests fail', criteria: [], bounces: 'first' } };

// ---------- standing ----------

test('a point with fewer scored cases than the gate asks is unproven, whatever its precision', () => {
  const s = rig();
  s.bounces(10, 10);
  const standing = s.engine.pointStanding('flow.bounce');
  assert.equal(standing?.standing, 'unproven');
  assert.ok(standing?.live.shortfalls.includes('cases'));
  assert.equal(standing?.live.cases, 10);
});

test('an act point is proven when the lower bound of its acting precision clears its break-even, and failing when it has the cases and does not', () => {
  const good = rig();
  good.bounces(40, 40);
  const proven = good.engine.pointStanding('flow.bounce');
  assert.equal(proven?.standing, 'proven');
  assert.deepEqual(proven?.live.shortfalls, []);
  assert.equal(proven?.gate.breakEven, 0.5);

  const bad = rig();
  bad.bounces(40, 12);
  const failing = bad.engine.pointStanding('flow.bounce');
  assert.equal(failing?.standing, 'failing');
  assert.deepEqual(failing?.live.shortfalls, ['break-even']);
});

test('an act point must also beat the code rule where its rows carry one', () => {
  const s = rig();
  // Right 32 of 40 times, and the code rule (which acted on every row) was right as often: no better than today
  s.bounces(40, 32, { baseline: true });
  const standing = s.engine.pointStanding('flow.bounce');
  assert.equal(standing?.standing, 'failing');
  assert.ok(standing?.live.shortfalls.includes('baseline'));
});

test('only outcomes that are direct count as cases', () => {
  const s = rig();
  s.bounces(40, 40, { outcome: { summary: 'qa passed later', agreed: true, quality: 'proxy' } });
  assert.equal(s.engine.pointStanding('flow.bounce')?.standing, 'unproven');
});

test('a suggest point is proven at a flag precision of 0.6 and a flag rate of at most 0.3', () => {
  const settings = DEFAULT_GATE;
  const def = decisionPoint('health.test-weakening');
  assert.ok(def);
  // 10 flags, 7 right; 30 rows that do not flag: a flag rate of 0.25
  const cases = [
    ...Array.from({ length: 10 }, (_, i) => ({ acts: true, confidence: 0.9, positive: i < 7 })),
    ...Array.from({ length: 30 }, () => ({ acts: false, confidence: 0.9, positive: false })),
  ];
  const score = scoreEvidence(cases);
  const live = { point: def.id, answered: 40, resolvedDirect: 40, resolvedProxy: 0, unresolved: 0, ...score };
  assert.equal(standingOf(def, settings, live, null, null).standing, 'proven');

  // The same precision flagging every other row is a flag that always fires
  const noisy = scoreEvidence([
    ...Array.from({ length: 20 }, (_, i) => ({ acts: true, confidence: 0.9, positive: i < 14 })),
    ...Array.from({ length: 20 }, () => ({ acts: false, confidence: 0.9, positive: false })),
  ]);
  const loud = standingOf(def, settings, { ...live, ...noisy }, null, null);
  assert.equal(loud.standing, 'failing');
  assert.deepEqual(loud.live.shortfalls, ['flag-rate']);
});

test('a replay proves a point only under the questions in force: a reworded question voids it', () => {
  const score = scoreEvidence(Array.from({ length: 50 }, () => ({ acts: true, confidence: 0.95, positive: true })));
  const hash = questionsHash('flow.bounce');
  assert.ok(hash);
  const current = rig({ replay: () => ({ at: ago(2), cases: 50, provider: 'cli', model: 'haiku', questionsHash: hash, score }) });
  const standing = current.engine.pointStanding('flow.bounce');
  assert.equal(standing?.standing, 'proven');
  assert.equal(standing?.replay?.source, 'replay');
  assert.equal(standing?.replay?.cases, 50);

  const stale = rig({ replay: () => ({ at: ago(2), cases: 50, provider: 'cli', model: 'haiku', questionsHash: 'an-older-wording', score }) });
  const voided = stale.engine.pointStanding('flow.bounce');
  assert.equal(voided?.standing, 'unproven');
  assert.equal(voided?.replay, null);
});

test('the questions hash is stable for every point and changes with the wording', () => {
  for (const id of DECISION_POINT_IDS) {
    const hash = questionsHash(id);
    assert.match(hash ?? '', /^[0-9a-f]{64}$/, id);
    assert.equal(questionsHash(id), hash, `${id} hashes the same twice`);
  }
  const asked = decisionPoint('flow.bounce')?.questions({ kind: 'flow_run', id: null, data: {} }) ?? [];
  const reworded = asked.map((q) => ({ ...q, question: `${q.question} Answer briefly.` }));
  assert.notEqual(hashQuestions(asked), hashQuestions(reworded));
  // Key order is not wording
  const reordered = asked.map((q) => Object.fromEntries(Object.entries(q).reverse()) as typeof q);
  assert.equal(hashQuestions(asked), hashQuestions(reordered));
});

// ---------- the gate at run time ----------

test('an active act point that is unproven behaves as shadow and says why', async () => {
  const s = rig();
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  const eff = s.engine.effective('flow.bounce', null);
  assert.equal(eff.mode, 'active');
  assert.equal(eff.limited, true);
  assert.equal(eff.limitedBy, 'unproven');
  assert.equal(stanceOf(s.engine, 'flow.bounce', null), 'watch');

  s.provider.script = () => ({ bounce: choiceOf('needs-person', 0.99) });
  const outcome = await s.engine.ask('flow.bounce', subject, { projectId: null });
  assert.equal(outcome.act, false);
  assert.equal(outcome.mode, 'shadow');
  const [stored] = s.db.listDecisions({ point: 'flow.bounce', limit: 1 }).items;
  assert.equal(stored?.mode, 'shadow', 'the row is shadow evidence like any other');
  assert.equal(stored?.acted, false);
});

test('an active act point that is failing behaves as shadow with the reason failing', async () => {
  const s = rig();
  s.bounces(40, 10);
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  assert.equal(s.engine.effective('flow.bounce', null).limitedBy, 'failing');
});

test('an active act point that is proven acts', async () => {
  const s = rig();
  s.bounces(40, 40);
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  assert.equal(s.engine.effective('flow.bounce', null).limitedBy, null);
  s.provider.script = () => ({ bounce: choiceOf('needs-person', 0.99) });
  const outcome = await s.engine.ask('flow.bounce', subject, { projectId: null });
  assert.equal(outcome.act, true);
  assert.equal(outcome.mode, 'active');
});

test('a suggest point that does not start a run still acts unproven; one that starts a run (lesson.mine) does not', async () => {
  const s = rig();
  await s.consent('health.test-weakening');
  await s.consent('lesson.mine');
  await s.settings.set({
    ...s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null }, 'lesson.mine': { mode: 'active', threshold: 0.85, consent: null } }),
    provider: 'jev',
  });
  assert.equal(s.engine.effective('health.test-weakening', null).limitedBy, null);
  assert.equal(s.engine.effective('lesson.mine', null).limitedBy, 'unproven');
});

test('a point switched on without consent is shown as silent, in shadow as in active', async () => {
  const s = rig();
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'shadow', threshold: 0.85, consent: null }, 'flow.restart': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  const catalogue = s.engine.catalogue(null);
  const bounce = catalogue.find((p) => p.id === 'flow.bounce');
  assert.equal(bounce?.effective.limitedBy, 'no-consent');
  assert.equal(bounce?.effective.limited, false, 'limited stays what it was: active in name only');
  assert.equal(catalogue.find((p) => p.id === 'flow.restart')?.effective.limitedBy, 'no-consent');
  assert.equal(catalogue.find((p) => p.id === 'flow.refine-needed')?.effective.limitedBy, null, 'an off point is not silent, it is off');
});

test('the catalogue serves each point its standing, its gate, its readings, its floor and its demotion', () => {
  const s = rig();
  s.bounces(40, 40);
  const catalogue = s.engine.catalogue(null);
  const bounce = catalogue.find((p) => p.id === 'flow.bounce');
  assert.equal(bounce?.standing, 'proven');
  assert.deepEqual(bounce?.gate, { enforced: true, minCases: 30, breakEven: 0.5, minPrecision: null, maxFlagRate: null });
  assert.equal(bounce?.live.cases, 40);
  assert.equal(bounce?.effective.floor, null);
  assert.equal(bounce?.demoted, null);
  const weakening = catalogue.find((p) => p.id === 'health.test-weakening');
  assert.equal(weakening?.effective.floor, 0.7);
  assert.deepEqual(weakening?.gate, { enforced: false, minCases: 30, breakEven: null, minPrecision: 0.6, maxFlagRate: 0.3 });
  assert.equal(catalogue.find((p) => p.id === 'lesson.mine')?.gate.enforced, true);
  assert.equal(catalogue.find((p) => p.id === 'checks.fix')?.gate.breakEven, 0.7);
});

// ---------- the gate on settings writes (D1) ----------

test('activating an unproven act point is refused with a typed 409 that carries the missing evidence, and nothing is written', async () => {
  const s = rig();
  s.bounces(5, 5);
  await assert.rejects(s.engine.saveSettings(s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } })), (error: unknown) => {
    assert.ok(refusal('decision-unproven')(error));
    const issue = (error as DecisionActivationError).body.points[0];
    assert.equal(issue?.point, 'flow.bounce');
    assert.equal(issue?.standing, 'unproven');
    assert.equal(issue?.live.cases, 5);
    assert.ok(issue?.live.shortfalls.includes('cases'));
    return true;
  });
  assert.equal(s.settings.get().points['flow.bounce'], undefined);
});

test('activating an unproven suggest point that starts a run is refused', async () => {
  const s = rig();
  await assert.rejects(s.engine.saveSettings(s.body({ 'lesson.mine': { mode: 'active', threshold: 0.85, consent: null } })), refusal('decision-unproven'));
});

test('activating one unproven suggestion is allowed with a warning', async () => {
  const s = rig();
  const saved = await s.engine.saveSettings(s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null } }));
  assert.equal(saved.points['health.test-weakening']?.mode, 'active');
  assert.deepEqual(saved.warnings.map((w) => w.point), ['health.test-weakening']);
  assert.equal(saved.warnings[0]?.standing, 'unproven');
});

test('activating more than one unproven point at once is refused whatever their kind', async () => {
  const s = rig();
  const both = s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null }, 'memory.triage': { mode: 'active', threshold: 0.85, consent: null } });
  await assert.rejects(s.engine.saveSettings(both), (error: unknown) => {
    assert.ok(refusal('decision-bulk-activation')(error));
    assert.deepEqual((error as DecisionActivationError).body.points.map((p) => p.point).sort(), ['health.test-weakening', 'memory.triage']);
    return true;
  });
});

test("the owner's file with every point active and no evidence loads, behaves as shadow and saves unchanged", async () => {
  const s = rig();
  const consent = { at: ago(30), stateVersion: 1, providers: ['jev'] };
  const points = Object.fromEntries(DECISION_POINTS.map((def) => [def.id, { mode: 'active', threshold: 0.85, consent: { ...consent, stateVersion: def.stateVersion } }]));
  writeFileSync(join(s.config.dataDir, 'decisions.json'), JSON.stringify({ provider: 'jev', cli: DEFAULT_DECISION_SETTINGS.cli, historyDays: 90, points }, null, 2));

  const loaded = s.settings.get();
  assert.equal(Object.values(loaded.points).filter((p) => p.mode === 'active').length, 29);
  for (const def of DECISION_POINTS) {
    const eff = s.engine.effective(def.id, null);
    const gated = def.kind === 'act' || def.effect.causesRun;
    // The Supervisor on Jev is an act point like the others; on the CLI it would ask nothing
    if (gated) assert.equal(eff.limitedBy, 'unproven', def.id);
  }

  const saved = await s.engine.saveSettings(s.body());
  assert.deepEqual(saved.warnings, []);
  const after = s.file().points as Record<string, { mode: string; threshold: number }>;
  assert.equal(Object.keys(after).length, 29);
  for (const def of DECISION_POINTS) assert.equal(after[def.id]?.mode, 'active', def.id);
  // A change elsewhere in the document is not an activation either
  await s.engine.saveSettings({ ...s.body(), historyDays: 60 });
  assert.equal(s.settings.get().historyDays, 60);
});

test('activating a proven point records its promotion and clears an old demotion', async () => {
  const s = rig();
  s.bounces(40, 40);
  // A shadow history wide enough to read a rate from: 40 acting rows and 40 that hold
  for (let i = 0; i < 40; i++) s.row('flow.bounce', { bounce: choiceOf('fixable') }, { outcome: null, agreed: null });
  await s.settings.set(s.body({ 'flow.bounce': { mode: 'shadow', threshold: 0.85, consent: null } }));
  await s.settings.demote('flow.bounce', {
    at: ago(3),
    reason: 'failing',
    evidence: { cases: 40, precision: { n: 40, hits: 10, value: 0.25, lower90: 0.17 }, breakEven: 0.5, shortfalls: ['break-even'], recentRows: 0, recentActs: 0, recentRate: null, promotedRate: null },
  });
  assert.equal(s.settings.get().points['flow.bounce']?.demoted?.reason, 'failing');

  const saved = await s.engine.saveSettings(s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }));
  const point = saved.points['flow.bounce'];
  assert.equal(point?.mode, 'active');
  assert.equal(point?.demoted, undefined);
  assert.equal(point?.promotion?.at, NOW.toISOString());
  assert.equal(point?.promotion?.actRate, 0.5, 'the rate of its shadow rows');
});

test('a settings body cannot set the engine marks', async () => {
  const s = rig();
  const forged = { at: ago(1), reason: 'rate', evidence: {} };
  await s.settings.set(s.body({ 'flow.bounce': { mode: 'shadow', threshold: 0.85, consent: null, demoted: forged, promotion: { at: ago(1), actRate: 0.9 } } }));
  assert.equal(s.settings.get().points['flow.bounce']?.demoted, undefined);
  assert.equal(s.settings.get().points['flow.bounce']?.promotion, undefined);
});

test("a project's override that activates an unproven act point is refused like a global write", () => {
  const s = rig();
  assert.throws(() => s.engine.checkProjectActivation(null, { points: { 'flow.bounce': { mode: 'active' } } }), refusal('decision-unproven'));
  assert.throws(
    () => s.engine.checkProjectActivation(null, { points: { 'memory.triage': { mode: 'active' }, 'team.assign': { mode: 'active' } } }),
    refusal('decision-bulk-activation'),
  );
  // Leaving an override as it was is not an activation
  assert.doesNotThrow(() => s.engine.checkProjectActivation({ points: { 'flow.bounce': { mode: 'active' } } }, { points: { 'flow.bounce': { mode: 'active' } } }));
});

test('the gate numbers are validated and editable per install, and a body without them keeps them', async () => {
  assert.throws(() => parseDecisionSettings({ ...structuredClone(DEFAULT_DECISION_SETTINGS), gate: { minCases: 0, suggestMinPrecision: 0.6, suggestMaxFlagRate: 0.3 } }), /minCases/);
  assert.throws(() => parseDecisionSettings({ ...structuredClone(DEFAULT_DECISION_SETTINGS), gate: { minCases: 30, suggestMinPrecision: 1.5, suggestMaxFlagRate: 0.3 } }), /suggestMinPrecision/);
  assert.throws(() => parseDecisionSettings({ ...structuredClone(DEFAULT_DECISION_SETTINGS), gate: { minCases: 30, suggestMinPrecision: 0.6, suggestMaxFlagRate: 0 } }), /suggestMaxFlagRate/);
  const s = rig();
  assert.deepEqual(s.settings.get().gate, DEFAULT_GATE);
  await s.settings.set({ ...s.body(), gate: { minCases: 10, suggestMinPrecision: 0.7, suggestMaxFlagRate: 0.2 } });
  const { gate: _gate, ...withoutGate } = s.body();
  await s.settings.set(withoutGate);
  assert.equal(s.settings.get().gate.minCases, 10);
  s.bounces(12, 12);
  assert.equal(s.engine.pointStanding('flow.bounce', s.settings.get(), true)?.standing, 'proven');
});

// ---------- probation and the holdout (D3) ----------

test('a proven act point holds out a tenth of its first hundred acts, recorded as held out and not acted', async () => {
  let coin = 0.05;
  const s = rig({ standing: () => 'proven', random: () => coin });
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  s.provider.script = () => ({ bounce: choiceOf('needs-person', 0.99) });

  const held = await s.engine.ask('flow.bounce', subject, { projectId: null });
  assert.equal(held.act, false);
  assert.equal(held.answers, null, 'today behaviour runs');
  const [row] = s.db.listDecisions({ point: 'flow.bounce', limit: 1 }).items;
  assert.equal(row?.heldOut, true);
  assert.equal(row?.acted, false);
  assert.equal(row?.mode, 'active');
  assert.equal(row?.runEffect, 0);

  coin = 0.1;
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).act, true, 'a draw at the share itself acts');
});

test('after a hundred acts in the window the holdout share drops to a twentieth', async () => {
  let coin = 0.07;
  const s = rig({ standing: () => 'proven', random: () => coin });
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  s.provider.script = () => ({ bounce: choiceOf('needs-person', 0.99) });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).act, false, '0.07 is inside the first share');

  for (let i = 0; i < 100; i++) s.row('flow.bounce', { bounce: choiceOf('needs-person') }, { mode: 'active', acted: true, outcome: null, agreed: null });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).act, true, '0.07 is outside the second');
  coin = 0.04;
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).act, false);
  assert.equal(holdoutShare(99), 0.1);
  assert.equal(holdoutShare(100), 0.05);
});

test('nothing is held out of a suggest point, nor of an answer under the threshold', async () => {
  const s = rig({ standing: () => 'proven', random: () => 0 });
  await s.consent('health.test-weakening');
  await s.consent('flow.bounce');
  await s.settings.set({
    ...s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null }, 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }),
    provider: 'jev',
  });
  s.provider.script = (request): Record<string, DecisionAnswer> => (request.point === 'flow.bounce' ? { bounce: choiceOf('needs-person', 0.6) } : { weakened: noulOf(true, 0.9) });
  assert.equal((await s.engine.ask('health.test-weakening', { kind: 'chat', id: 'c1', data: { path: 'a.test.ts', before: 'x', after: 'y' } }, { projectId: null })).act, true);
  await s.engine.ask('flow.bounce', subject, { projectId: null });
  const rows = s.db.listDecisions({ limit: 10 }).items;
  assert.ok(rows.every((r) => !r.heldOut));
});

// ---------- the suggest floor ----------

test('a suggestion under its floor is recorded and not shown; at the floor it is', async () => {
  const s = rig();
  await s.consent('health.test-weakening');
  await s.settings.set({ ...s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  const weak = { kind: 'chat' as const, id: 'c1', data: { path: 'a.test.ts', before: 'x', after: 'y' } };

  s.provider.script = () => ({ weakened: noulOf(true, 0.69) });
  const below = await s.engine.ask('health.test-weakening', weak, { projectId: null });
  assert.equal(below.act, false);
  assert.ok(below.decisionId, 'the row is recorded');
  assert.equal(s.db.decision(below.decisionId ?? '')?.acted, false);

  s.provider.script = () => ({ weakened: noulOf(true, 0.7) });
  assert.equal((await s.engine.ask('health.test-weakening', weak, { projectId: null })).act, true);

  await s.settings.set({ ...s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null, floor: 0.9 } }), provider: 'jev' });
  assert.equal(s.engine.effective('health.test-weakening', null).floor, 0.9);
  assert.equal((await s.engine.ask('health.test-weakening', weak, { projectId: null })).act, false);
});

test('the floor does not apply to the CLI, which gives no confidence', async () => {
  const s = rig();
  await s.consent('health.test-weakening', ['cli']);
  await s.settings.set({ ...s.body({ 'health.test-weakening': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'cli' });
  s.cli.script = () => ({ weakened: noulOf(true, null) });
  const outcome = await s.engine.ask('health.test-weakening', { kind: 'chat', id: 'c1', data: { path: 'a.test.ts', before: 'x', after: 'y' } }, { projectId: null });
  assert.equal(outcome.act, true);
});

test('the floor is validated like a threshold', () => {
  const doc = (floor: unknown) => ({ ...structuredClone(DEFAULT_DECISION_SETTINGS), points: { 'health.test-weakening': { mode: 'shadow', threshold: 0.85, floor } } });
  assert.throws(() => parseDecisionSettings(doc(0.3)), /floor/);
  assert.throws(() => parseDecisionSettings(doc(1)), /floor/);
  assert.equal(parseDecisionSettings(doc(0.75)).points['health.test-weakening']?.floor, 0.75);
});

// ---------- demotion (D2) ----------

test('a promoted point that no longer clears its gate goes back to shadow, says why, and is told', async () => {
  const s = rig();
  s.bounces(40, 40);
  await s.consent('flow.bounce');
  await s.engine.saveSettings({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  assert.ok(s.settings.get().points['flow.bounce']?.promotion);
  assert.deepEqual(await s.engine.review(), [], 'still proven: nothing to do');

  // Its acts turn out wrong: 60 more resolved rows, all wrong
  s.bounces(60, 0, { mode: 'active', acted: true });
  const made = await s.engine.review();
  assert.equal(made.length, 1);
  const point = s.settings.get().points['flow.bounce'];
  assert.equal(point?.mode, 'shadow');
  assert.equal(point?.demoted?.reason, 'failing');
  assert.equal(point?.demoted?.evidence.cases, 100);
  assert.deepEqual(point?.demoted?.evidence.shortfalls, ['break-even']);
  assert.equal(point?.promotion, undefined);
  assert.ok(point?.consent, 'consent stays');

  const event = s.events.find((e) => e.type === 'decision.demoted');
  assert.ok(event && event.type === 'decision.demoted');
  assert.equal(event.point, 'flow.bounce');
  assert.equal(event.reasonCode, DEMOTION_CODES.failing);
  assert.equal(event.params.hits, 40);
  assert.equal(event.params.n, 100);

  // The catalogue shows it, and the next write that sets it active again is judged like any other
  assert.equal(s.engine.catalogue(null).find((p) => p.id === 'flow.bounce')?.demoted?.reason, 'failing');
  await assert.rejects(s.engine.saveSettings(s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } })), refusal('decision-unproven'));
});

test('a promoted point acting more than twice as often as in shadow goes back to shadow', async () => {
  const s = rig();
  s.bounces(40, 40);
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  // Promoted on a rate of 0.2; every row of the last seven days acts
  await s.settings.markPromotion('flow.bounce', { at: ago(10), actRate: 0.2 });
  const [made] = await s.engine.review();
  assert.equal(made?.demotion.reason, 'rate');
  assert.equal(made?.demotion.evidence.recentRate, 1);
  assert.equal(made?.demotion.evidence.promotedRate, 0.2);
  assert.equal(s.settings.get().points['flow.bounce']?.mode, 'shadow');
  assert.equal(s.events.find((e) => e.type === 'decision.demoted' && e.reasonCode === DEMOTION_CODES.rate)?.type, 'decision.demoted');
});

test('a point already active when it became proven gets its promotion mark, and nothing is promoted by itself', async () => {
  const s = rig();
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null }, 'flow.restart': { mode: 'shadow', threshold: 0.85, consent: null } }), provider: 'jev' });
  s.bounces(40, 40);
  for (let i = 0; i < 40; i++) s.row('flow.restart', { requeue: noulOf(false) });
  assert.deepEqual(await s.engine.review(), []);
  assert.equal(s.settings.get().points['flow.bounce']?.promotion?.at, NOW.toISOString());
  assert.equal(s.settings.get().points['flow.restart']?.mode, 'shadow', 'a proven shadow point stays in shadow');
});

test('the demotion rules, read alone', () => {
  const def = decisionPoint('flow.bounce');
  assert.ok(def);
  const proven = standingOf(def, DEFAULT_GATE, { point: 'flow.bounce', answered: 40, resolvedDirect: 40, resolvedProxy: 0, unresolved: 0, ...scoreEvidence(Array.from({ length: 40 }, () => ({ acts: true, confidence: 0.9, positive: true }))) }, null, null);
  const quiet = scoreEvidence(Array.from({ length: 30 }, (_, i) => ({ acts: i < 9, confidence: 0.9, positive: null })));
  assert.equal(demotionOf(def, proven, quiet, { at: ago(9), actRate: 0.2 }, NOW.toISOString()), null, '0.3 is inside twice 0.2');
  const loud = scoreEvidence(Array.from({ length: 30 }, (_, i) => ({ acts: i < 13, confidence: 0.9, positive: null })));
  assert.equal(demotionOf(def, proven, loud, { at: ago(9), actRate: 0.2 }, NOW.toISOString())?.reason, 'rate');
  const few = scoreEvidence(Array.from({ length: 10 }, () => ({ acts: true, confidence: 0.9, positive: null })));
  assert.equal(demotionOf(def, proven, few, { at: ago(9), actRate: 0.2 }, NOW.toISOString()), null, 'ten rows say nothing about a rate');
});

test('the activation rules, read alone', () => {
  const def = (id: DecisionPointId) => {
    const found = decisionPoint(id);
    assert.ok(found);
    return found;
  };
  const standing = (id: DecisionPointId, value: DecisionStanding) => ({ ...standingOf(def(id), DEFAULT_GATE, { point: id, answered: 0, resolvedDirect: 0, resolvedProxy: 0, unresolved: 0, ...scoreEvidence([]) }, null, null), standing: value });
  const change = (id: DecisionPointId, value: DecisionStanding, before: 'off' | 'shadow' | 'active' = 'shadow') => ({ def: def(id), before, after: 'active' as const, standing: standing(id, value) });
  assert.equal(judgeActivation([change('flow.bounce', 'proven'), change('checks.fix', 'proven')]).refusal, null, 'proven points may go together');
  assert.equal(judgeActivation([change('flow.bounce', 'unproven', 'active'), change('checks.fix', 'failing', 'active')]).refusal, null, 'already active is not an activation');
  assert.equal(judgeActivation([change('flow.bounce', 'proven'), change('memory.triage', 'unproven')]).warnings.length, 1);
  assert.equal(judgeActivation([change('flow.bounce', 'failing')]).refusal?.code, 'decision-unproven');
  // The Supervisor's Active is its owner's switch (bounded by autoSignals), and under the CLI it can earn no evidence
  const supervisor = judgeActivation([change('supervisor.intervene', 'unproven')]);
  assert.equal(supervisor.refusal, null, 'the Supervisor may be switched to active without standing');
  assert.deepEqual(supervisor.warnings, []);
});

// ---------- what is told, and in which words ----------

test('a demotion makes a notification with the codes the web translates, in both languages', () => {
  const event: DecisionDemotedEvent = {
    id: 1,
    at: NOW.toISOString(),
    type: 'decision.demoted',
    title: 'flow.bounce went back to Shadow',
    titleCode: DEMOTION_CODES.title,
    point: 'flow.bounce',
    demotion: { at: NOW.toISOString(), reason: 'rate', evidence: { cases: 40, precision: { n: 40, hits: 40, value: 1, lower90: 0.95 }, breakEven: 0.5, shortfalls: [], recentRows: 30, recentActs: 30, recentRate: 1, promotedRate: 0.2 } },
    reason: 'In the last 7 days it acted on 30 of 30 answers.',
    reasonCode: DEMOTION_CODES.rate,
    params: { point: 'flow.bounce', hits: 40, n: 40, acts: 30, rows: 30 },
  };
  const [draft] = notificationsFor(event);
  assert.equal(draft?.title, event.title);
  assert.equal(draft?.body, event.reason);
  assert.equal(draft?.href, '/settings/decisions');
  assert.equal(draft?.tone, 'warn');

  for (const language of ['en', 'es']) {
    const server = JSON.parse(readFileSync(new URL(`../../../apps/web/src/i18n/locales/${language}/server.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
    for (const code of Object.values(DEMOTION_CODES)) {
      const found = code.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), server);
      assert.equal(typeof found, 'string', `${language}: ${code}`);
    }
  }
});

test('a review queued by an outcome runs after the sweep, and shutdown waits for it', async () => {
  const s = rig();
  s.bounces(40, 40);
  await s.consent('flow.bounce');
  await s.engine.saveSettings({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  await s.settings.markPromotion('flow.bounce', { at: ago(10), actRate: 0.2 });
  s.engine.startReviewing();
  await s.engine.settled();
  s.events.length = 0;
  // The start already demoted it on its rate; put it back and let an outcome trigger the next review
  await s.settings.set(s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), { 'flow.bounce': { at: ago(10), actRate: 0.2 } });
  const [some] = s.db.listDecisions({ point: 'flow.bounce', limit: 1 }).items;
  s.engine.resolve(some?.id ?? '', { summary: 'again', agreed: true, quality: 'direct' });
  await new Promise((r) => setTimeout(r, 5));
  s.engine.stop();
  await s.engine.settled();
  assert.equal(s.events.filter((e) => e.type === 'decision.demoted').length, 1);
  assert.equal(s.settings.get().points['flow.bounce']?.mode, 'shadow');
});

// ---------- the review's fixes: the replay bootstraps, any failing point demotes, the holdout since promotion ----------

const perfectReplay = (provider: 'cli' | 'jev' = 'cli', model = 'haiku'): ReplayEvidence => ({
  at: ago(2),
  cases: 50,
  provider,
  model,
  questionsHash: questionsHash('flow.bounce') ?? '',
  score: scoreEvidence(Array.from({ length: 50 }, () => ({ acts: true, confidence: 0.95, positive: true }))),
});

test('a replay only bootstraps a point: once the live history has the cases, it alone decides the standing', () => {
  const early = rig({ replay: () => perfectReplay() });
  early.bounces(10, 2);
  const bootstrapped = early.engine.pointStanding('flow.bounce');
  assert.deepEqual([bootstrapped?.standing, bootstrapped?.decidedBy], ['proven', 'replay'], 'ten live cases are too few to overrule it');

  const live = rig({ replay: () => perfectReplay() });
  live.bounces(40, 10);
  const judged = live.engine.pointStanding('flow.bounce');
  assert.deepEqual([judged?.standing, judged?.decidedBy], ['failing', 'live'], 'a stored replay does not keep a point proven that is wrong live');
  assert.equal(judged?.replay?.shortfalls.length, 0, 'the replay is still shown, cleared, and still not what decides');

  const none = rig();
  none.bounces(5, 5);
  assert.deepEqual([none.engine.pointStanding('flow.bounce')?.standing, none.engine.pointStanding('flow.bounce')?.decidedBy], ['unproven', null]);
  assert.equal(none.engine.catalogue(null).find((p) => p.id === 'flow.bounce')?.decidedBy, null, 'the catalogue serves which reading decided');
});

test('a point proven by its replay and promoted is demoted once its live evidence fails', async () => {
  const s = rig({ replay: () => perfectReplay() });
  await s.consent('flow.bounce', ['cli']);
  await s.settings.set(s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }));
  await s.settings.markPromotion('flow.bounce', { at: ago(20), actRate: 1 });
  s.bounces(40, 8, { mode: 'active', acted: true });
  const [made] = await s.engine.review();
  assert.equal(made?.demotion.reason, 'failing');
  assert.equal(made?.demotion.evidence.cases, 40, 'told by the live reading that decided');
  assert.equal(s.settings.get().points['flow.bounce']?.mode, 'shadow');
});

test('a replay counts only for the provider the point runs on, and for Jev only on its pinned model', () => {
  const def = decisionPoint('flow.bounce');
  assert.ok(def);
  const empty = { point: def.id, answered: 0, resolvedDirect: 0, resolvedProxy: 0, unresolved: 0, ...scoreEvidence([]) };
  const hash = questionsHash('flow.bounce');
  const onJev: RunsOn = { provider: 'jev', model: JEV_MODEL };
  assert.equal(standingOf(def, DEFAULT_GATE, empty, perfectReplay('cli'), hash, onJev).standing, 'unproven', "a replay on the CLI's model says nothing about Jev");
  assert.equal(standingOf(def, DEFAULT_GATE, empty, perfectReplay('jev', 'jev-1.12.0'), hash, onJev).standing, 'unproven', 'nor one on an older Jev');
  assert.equal(standingOf(def, DEFAULT_GATE, empty, perfectReplay('jev', JEV_MODEL), hash, onJev).standing, 'proven');
  assert.equal(standingOf(def, DEFAULT_GATE, empty, perfectReplay('jev', JEV_MODEL), hash, { provider: 'cli', model: null }).standing, 'unproven');
  assert.equal(standingOf(def, DEFAULT_GATE, empty, perfectReplay('cli', 'sonnet'), hash, { provider: 'cli', model: null }).standing, 'proven', 'the CLI is not held to a model');
});

test('the engine looks up the replay for the provider the install runs the point on', async () => {
  const asked: RunsOn[] = [];
  const s = rig({
    replay: (_point, runsOn) => {
      asked.push(runsOn);
      return null;
    },
  });
  s.engine.pointStanding('flow.bounce', s.settings.get(), true);
  await s.settings.set({ ...s.body(), provider: 'jev' });
  s.engine.pointStanding('flow.bounce', s.settings.get(), true);
  assert.deepEqual(asked, [
    { provider: 'cli', model: null },
    { provider: 'jev', model: JEV_MODEL },
  ]);
});

test('an active point with no promotion mark whose standing is failing goes back to shadow; the Supervisor never does', async () => {
  const s = rig({ standing: () => 'failing' });
  // As on the owner's install: switched on before the gate existed, so no point carries a mark
  await s.settings.set(
    s.body({
      'flow.bounce': { mode: 'active', threshold: 0.85, consent: null },
      'changes.unexplained-hunk': { mode: 'active', threshold: 0.85, consent: null },
      'supervisor.intervene': { mode: 'active', threshold: 0.85, consent: null },
    }),
  );
  const made = await s.engine.review();
  assert.deepEqual(made.map((m) => m.point).sort(), ['changes.unexplained-hunk', 'flow.bounce'], 'a suggest point the gate does not enforce is demoted too');
  assert.ok(made.every((m) => m.demotion.reason === 'failing'));
  assert.equal(s.settings.get().points['changes.unexplained-hunk']?.mode, 'shadow');
  assert.equal(s.settings.get().points['supervisor.intervene']?.mode, 'active', "its Active is its owner's switch for sending hints");

  // Unproven, without a mark, is left alone: it has no evidence to lose
  const quiet = rig({ standing: () => 'unproven' });
  await quiet.settings.set(quiet.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }));
  assert.deepEqual(await quiet.engine.review(), []);
});

test('the holdout counts the acts since the point was promoted, not those of the window before it', async () => {
  const s = rig({ standing: () => 'proven', random: () => 0.07 });
  await s.consent('flow.bounce');
  await s.settings.set({ ...s.body({ 'flow.bounce': { mode: 'active', threshold: 0.85, consent: null } }), provider: 'jev' });
  s.provider.script = () => ({ bounce: choiceOf('needs-person', 0.99) });
  // A hundred acts from an earlier time in Active, before it was demoted and promoted again
  for (let i = 0; i < 100; i++) s.row('flow.bounce', { bounce: choiceOf('needs-person') }, { mode: 'active', acted: true, outcome: null, agreed: null, at: ago(3) });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).act, true, 'with no mark the window counts: past a hundred, 0.07 acts');
  await s.settings.markPromotion('flow.bounce', { at: ago(1), actRate: 0.5 });
  assert.equal((await s.engine.ask('flow.bounce', subject, { projectId: null })).act, false, 'since the promotion it has acted once: 0.07 is held out');
});
