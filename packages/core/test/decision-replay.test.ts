import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import type { DecisionPointId, DecisionRecord, DecisionSettings, DecisionQuestion } from '@claudio/shared';
import { Db } from '../src/db.ts';
import type { DecisionProvider } from '../src/decisions/engine.ts';
import { DecisionEngine } from '../src/decisions/engine.ts';
import { labelsFromOutcomes, parseQuestions, questionsHash, replayConsent, replayDecisions, replayRecord, ReplayError, ReplayRunner, type ReplayCase } from '../src/decisions/replay.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS } from '../src/decisions/settings.ts';
import { choiceOf, ScriptedProvider } from './decision-rig.ts';
import { tempConfig } from './helpers.ts';

// The replay harness of docs/plans/decision-engine-v2.md (M5). No provider here is a real one: every
// test hands the harness a scripted stand-in, so nothing reaches TypeSafe or Anthropic.

const POINT: DecisionPointId = 'flow.bounce';
const STATE_VERSION = 1;
const NEVER = new AbortController().signal;

const consentFor = (providers: Array<'cli' | 'jev'>, stateVersion = STATE_VERSION): Pick<DecisionSettings, 'points'> => ({
  points: { [POINT]: { mode: 'shadow', threshold: 0.85, consent: { at: '2026-11-01T00:00:00.000Z', stateVersion, providers } } },
});

/** The case's state names the right answer, so a scripted provider can answer from it */
const labelled = (positive: boolean, state: Record<string, unknown> = { rejection: positive ? 'needs a decision' : 'typo' }): ReplayCase => ({
  id: null,
  state,
  questions: [],
  positive,
});

const answerFrom = (provider: ScriptedProvider): void => {
  provider.script = (request) => ({ bounce: choiceOf(String(request.state.rejection).includes('decision') ? 'needs-person' : 'fixable') });
};

function setup() {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const provider = new ScriptedProvider('jev');
  answerFrom(provider);
  const run = (cases: ReplayCase[], over: Partial<Parameters<typeof replayDecisions>[0]> = {}) =>
    replayDecisions({ point: POINT, cases, provider, concurrency: 2, deadlineMs: 1_000, signal: NEVER, consent: { settings: consentFor(['jev']) }, ...over });
  return { config, db, provider, run };
}

const record = (id: string, over: Partial<DecisionRecord>): DecisionRecord => ({
  id,
  point: POINT,
  kind: 'act',
  projectId: 'p1',
  subjectKind: 'flow_run',
  subjectId: 'run-1',
  provider: 'jev',
  model: 'jev-1',
  mode: 'shadow',
  status: 'answered',
  unavailable: null,
  state: { rejection: 'needs a decision' },
  questions: [{ kind: 'choice', id: 'bounce', question: 'q', options: [{ id: 'fixable', label: 'f' }, { id: 'needs-person', label: 'n' }] }],
  answers: { bounce: choiceOf('needs-person') },
  confidence: 0.9,
  threshold: 0.85,
  acted: false,
  visible: false,
  savedRun: false,
  runEffect: 0,
  baseline: null,
  heldOut: false,
  latencyMs: 5,
  inputTokens: null,
  costUsd: 0,
  outcome: { summary: 'a person took it over', agreed: true, quality: 'direct' },
  agreed: true,
  resolvedAt: '2026-11-02T00:00:00.000Z',
  feedback: null,
  feedbackAt: null,
  openedAt: null,
  paletteAction: null,
  at: '2026-11-01T00:00:00.000Z',
  ...over,
});

test('a replay scores the answers against the labels and writes no decision row', async () => {
  const s = setup();
  // Three right (two acting, one holding) and one the provider gets wrong: it acts where acting was wrong
  const cases = [labelled(true), labelled(true), labelled(false), labelled(false, { rejection: 'a decision about the scope, which the label calls wrong' })];
  const run = await s.run(cases);

  assert.equal(run.cases, 4);
  assert.equal(run.unavailable, 0);
  assert.deepEqual([run.confusion.actedRight, run.confusion.actedWrong, run.confusion.heldRight, run.confusion.heldWrong], [2, 1, 1, 0]);
  assert.equal(run.score.precision.hits, 2);
  assert.equal(run.score.precision.n, 3);
  assert.equal(run.confusion.recall.value, 1);
  assert.equal(s.provider.calls.length, 4);
  assert.equal(s.db.listDecisions({ limit: 10 }).items.length, 0, 'a replay is not a decision');
});

test('a replay asks the point\'s current questions, or the reworded ones when given', async () => {
  const s = setup();
  const own = await s.run([labelled(true)]);
  assert.equal(s.provider.calls[0]?.questions[0]?.id, 'bounce');

  const reworded: DecisionQuestion[] = [
    { kind: 'choice', id: 'bounce', question: 'Reworded: can the Developer fix it alone?', options: [{ id: 'fixable', label: 'yes' }, { id: 'needs-person', label: 'no' }] },
  ];
  const tried = await s.run([labelled(true)], { questions: reworded });
  assert.equal(s.provider.calls[1]?.questions[0]?.question, 'Reworded: can the Developer fix it alone?');
  assert.notEqual(tried.questionsHash, own.questionsHash);
  assert.equal(tried.questionsHash, questionsHash(reworded));
});

test('the hash of the questions does not depend on the order of their keys', () => {
  const a: DecisionQuestion = { kind: 'noul', id: 'x', question: 'q' };
  const b = { question: 'q', id: 'x', kind: 'noul' } as DecisionQuestion;
  assert.equal(questionsHash([a]), questionsHash([b]));
  assert.notEqual(questionsHash([a]), questionsHash([{ ...a, question: 'other' }]));
});

test('a provider that is unavailable is counted, left out of the score and never asked again', async () => {
  const s = setup();
  s.provider.script = () => ({ status: 'unavailable', reason: 'network', latencyMs: 1 });
  const run = await s.run([labelled(true), labelled(false), labelled(true)], { concurrency: 1 });
  assert.equal(run.unavailable, 3);
  assert.equal(run.score.precision.n, 0);
  assert.equal(s.provider.calls.length, 3, 'one call per case, no retry');
});

test('a provider that cannot answer at all ends the calls: the rest are counted, not asked', async () => {
  const s = setup();
  s.provider.script = () => ({ status: 'unavailable', reason: 'rate-limited', latencyMs: 1 });
  const run = await s.run([labelled(true), labelled(true), labelled(true), labelled(true)], { concurrency: 1 });
  assert.equal(run.unavailable, 4);
  assert.equal(s.provider.calls.length, 1);
  assert.deepEqual(new Set(run.results.map((r) => r.unavailable)), new Set(['rate-limited']));
});

test('a provider that is down is counted without a single call', async () => {
  const s = setup();
  s.provider.up = false;
  const run = await s.run([labelled(true), labelled(false)]);
  assert.equal(run.unavailable, 2);
  assert.equal(s.provider.calls.length, 0);
});

test('an answer off the question\'s options is counted as unavailable, not scored', async () => {
  const s = setup();
  s.provider.script = () => ({ bounce: choiceOf('something-else') });
  const run = await s.run([labelled(true)]);
  assert.deepEqual([run.unavailable, run.score.precision.n, run.results[0]?.unavailable], [1, 0, 'invalid-answer']);
});

test('a provider that never answers is cut at the deadline', async () => {
  const s = setup();
  const hung: DecisionProvider = {
    id: 'jev',
    available: () => true,
    ask: (_request, opts) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ status: 'unavailable', reason: 'timeout', latencyMs: 1 }))),
  };
  const run = await s.run([labelled(true)], { provider: hung, deadlineMs: 20 });
  assert.deepEqual([run.unavailable, run.results[0]?.unavailable], [1, 'timeout']);
});

test('no consent, no replay: nothing is sent', async () => {
  const s = setup();
  await assert.rejects(s.run([labelled(true)], { consent: { settings: { points: {} } } }), (err) => err instanceof ReplayError && err.statusCode === 409);
  assert.equal(s.provider.calls.length, 0);
});

test('consent given for another provider, or for an older state shape, does not cover the replay', async () => {
  const s = setup();
  await assert.rejects(s.run([labelled(true)], { consent: { settings: consentFor(['cli']) } }), ReplayError);
  await assert.rejects(s.run([labelled(true)], { consent: { settings: consentFor(['jev'], STATE_VERSION + 1) } }), ReplayError);
  assert.equal(replayConsent(POINT, 'jev', consentFor(['jev'], STATE_VERSION + 1)), null);
  assert.equal(s.provider.calls.length, 0);
});

test('the owner flag stands in for the point\'s consent for one run and is recorded with the result', async () => {
  const s = setup();
  const run = await s.run([labelled(true)], { consent: { settings: { points: {} }, ownerFlag: true } });
  assert.equal(run.consent, 'owner-flag');
  s.db.saveDecisionReplay(replayRecord(run, { at: new Date('2026-11-13T10:00:00.000Z') }));
  assert.equal(s.db.decisionReplays(POINT)[0]?.consent, 'owner-flag');

  const own = await s.run([labelled(true)]);
  assert.equal(own.consent, 'point');
});

test('the state is redacted again before it is sent, so a set built outside is held to the same rules', async () => {
  const s = setup();
  await s.run([labelled(true, { rejection: 'needs a decision, API_KEY=sk-live-abcdef1234567890' })]);
  assert.ok(!JSON.stringify(s.provider.calls[0]?.state).includes('sk-live-abcdef1234567890'));
});

test('a stored replay is read back by point and by the hash of its questions, newest first', async () => {
  const s = setup();
  const first = await s.run([labelled(true)]);
  const second = await s.run([labelled(true), labelled(false)]);
  s.db.saveDecisionReplay(replayRecord(first, { at: new Date('2026-11-13T10:00:00.000Z'), note: 'before' }));
  s.db.saveDecisionReplay(replayRecord(second, { at: new Date('2026-11-13T11:00:00.000Z') }));

  assert.deepEqual(s.db.decisionReplays(POINT).map((r) => r.cases), [2, 1]);
  assert.deepEqual(s.db.decisionReplays('flow.restart'), []);
  const latest = s.db.latestDecisionReplay(POINT, first.questionsHash);
  assert.equal(latest?.cases, 2);
  assert.equal(latest?.questions[0]?.id, 'bounce');
  assert.equal(s.db.latestDecisionReplay(POINT, 'nothing'), null);
});

test('labels from outcomes survive the history being pruned', () => {
  const s = setup();
  s.db.insertDecision(record('old', { at: '2026-01-01T00:00:00.000Z' }));
  const result = labelsFromOutcomes(s.db, POINT, { since: '2025-12-01T00:00:00.000Z' });
  assert.equal(result.saved, 1);

  s.db.pruneDecisions('2026-06-01T00:00:00.000Z');
  assert.equal(s.db.decision('old'), null);
  const kept = s.db.decisionLabels(POINT);
  assert.equal(kept.length, 1);
  // The answer acted and agreed with what happened, so acting was right
  assert.deepEqual([kept[0]?.positive, kept[0]?.source, kept[0]?.state], [true, 'outcome', { rejection: 'needs a decision' }]);
});

test('an outcome labels only what a direct outcome settled, and never overrules a person', () => {
  const s = setup();
  s.db.insertDecision(record('direct-agreed', {}));
  // Acted and disagreed: acting was wrong
  s.db.insertDecision(record('direct-disagreed', { agreed: false, outcome: { summary: 'a person did not need to', agreed: false, quality: 'direct' } }));
  s.db.insertDecision(record('proxy', { outcome: { summary: 'a guess', agreed: true, quality: 'proxy' } }));
  s.db.insertDecision(record('open', { outcome: null, agreed: null }));
  s.db.insertDecision(record('person', {}));
  s.db.saveDecisionLabel({ id: 'mine', point: POINT, decisionId: 'person', state: {}, questions: [], positive: false, answers: null, source: 'person', note: null, at: '2026-11-03T00:00:00.000Z' });

  const result = labelsFromOutcomes(s.db, POINT, { since: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(result, { saved: 2, keptPerson: 1, unreadable: 0 });
  const byRow = new Map(s.db.decisionLabels(POINT).map((l) => [l.decisionId, l]));
  assert.equal(byRow.get('direct-agreed')?.positive, true);
  assert.equal(byRow.get('direct-disagreed')?.positive, false);
  assert.equal(byRow.get('person')?.source, 'person');
  assert.equal(byRow.get('person')?.positive, false);
  assert.equal(byRow.has('proxy'), false);
  assert.equal(byRow.has('open'), false);

  // Run again: the same rows refresh in place, no duplicates
  labelsFromOutcomes(s.db, POINT, { since: '2026-10-01T00:00:00.000Z' });
  assert.equal(s.db.decisionLabels(POINT).length, 3);
});

test('questions a person wrote are read whole or not at all', () => {
  const good = [{ kind: 'noul', id: 'a', question: 'q' }, { kind: 'choice', id: 'b', question: 'q', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }];
  assert.equal(parseQuestions(good)?.length, 2);
  assert.equal(parseQuestions([{ kind: 'choice', id: 'b', question: 'q', options: [{ id: 'x', label: 'X' }] }]), null, 'a choice needs two options');
  assert.equal(parseQuestions([good[0], good[0]]), null, 'ids are unique');
  assert.equal(parseQuestions([{ kind: 'free', id: 'a', question: 'q' }]), null);
  assert.equal(parseQuestions([]), null);
});

function runnerSetup(settings: Pick<DecisionSettings, 'points' | 'cli'>) {
  const s = setup();
  const credentials = new DecisionCredentialStore(s.config);
  const store = new DecisionSettingsStore(s.config, credentials);
  const engine = new DecisionEngine({ settings: store, db: s.db, projectDecisions: () => null });
  engine.register(s.provider);
  const runner = new ReplayRunner({ db: s.db, engine, settings: { get: () => settings } });
  const label = (id: string, positive: boolean) =>
    s.db.saveDecisionLabel({ id, point: POINT, decisionId: null, state: { rejection: positive ? 'needs a decision' : 'typo' }, questions: [], positive, answers: null, source: 'person', note: null, at: '2026-11-03T00:00:00.000Z' });
  return { ...s, runner, label };
}

const cliSettings = DEFAULT_DECISION_SETTINGS.cli;

test('the runner refuses a replay without consent, without labels or while one runs, before sending anything', () => {
  const noConsent = runnerSetup({ points: {}, cli: cliSettings });
  noConsent.label('a', true);
  assert.throws(() => noConsent.runner.start({ point: POINT, provider: 'jev' }), (err) => err instanceof ReplayError && err.statusCode === 409);
  assert.equal(noConsent.provider.calls.length, 0);

  const noLabels = runnerSetup({ ...consentFor(['jev']), cli: cliSettings });
  assert.throws(() => noLabels.runner.start({ point: POINT, provider: 'jev' }), /no labels/);
});

test('the runner replays in the background and stores the result for the gate to read', async () => {
  const s = runnerSetup({ ...consentFor(['jev']), cli: cliSettings });
  s.label('a', true);
  s.label('b', false);
  const started = s.runner.start({ point: POINT, provider: 'jev', note: 'try' });
  assert.equal(started.cases, 2);
  assert.throws(() => s.runner.start({ point: POINT, provider: 'jev' }), /already running/);
  for (let i = 0; i < 100 && s.runner.state().running.length > 0; i++) await new Promise((r) => setTimeout(r, 10));

  const stored = s.db.latestDecisionReplay(POINT, started.questionsHash);
  assert.deepEqual([stored?.cases, stored?.consent, stored?.note, stored?.provider], [2, 'point', 'try', 'jev']);
  assert.equal(s.db.listDecisions({ limit: 10 }).items.length, 0);
});

test('a replay the signal ends is not stored as a result', async () => {
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  const run = await s.run([labelled(true)], { signal: controller.signal });
  assert.equal(run.aborted, true);
  assert.equal(s.provider.calls.length, 0);
});
