import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { DecisionAnswer, DecisionPointId, HealthSignal, Orchestration, OrchestrationSpec, TranscriptEntry, VerificationSpec } from '@claudio/shared';
import { ChatManager, type ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { DecisionEngine, type DecisionProvider, type DecisionRequest, type ProviderResult } from '../src/decisions/engine.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS } from '../src/decisions/settings.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { Supervisor } from '../src/supervisor.ts';
import { tempConfig } from './helpers.ts';

// The runtime decision points (docs/plans/decision-engine.md, D2 w3): orchestration.retry,
// orchestration.model, orchestration.fixer, supervisor.intervene and the orchestrator side of
// run.continuation. Each has the four tests the plan asks for: off changes nothing and calls no
// provider; shadow records a row while today's behaviour decides; active acts only above the
// threshold; and an unavailable provider (no quota included) is today's behaviour at once.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

type Reply = (request: DecisionRequest) => ProviderResult;

/** Answers every question with `pick(questionId, index)`, at one confidence */
const replying =
  (pick: (id: string, index: number) => string | boolean, confidence: number | null = 0.99): Reply =>
  (request) => {
    const answers: Record<string, DecisionAnswer> = {};
    request.questions.forEach((q, i) => {
      const value = pick(q.id, i);
      answers[q.id] = q.kind === 'noul' ? { kind: 'noul', value: value === true, probability: null, confidence } : { kind: q.kind, value: String(value), probabilities: null, confidence };
    });
    return { status: 'answered', answers, latencyMs: 5, inputTokens: 10, costUsd: 0, model: 'jev-test' };
  };
const noQuota: Reply = () => ({ status: 'unavailable', reason: 'no-quota', latencyMs: 1 });

/** A real engine over a real store, with one point set and a provider that only records and answers */
async function deciding(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', reply: Reply, db: Db = new Db(tempConfig())) {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  // What the call site does once its point may act: proven, and never held out (the gate is tested in decision-lifecycle.test.ts)
  const engine = new DecisionEngine({ settings, db, projectDecisions: () => null, standing: () => 'proven', random: () => 1 });
  const calls: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    id: 'jev',
    available: () => true,
    ask: (request) => {
      calls.push(request);
      return Promise.resolve(reply(request));
    },
  };
  engine.register(provider);
  if (mode !== 'off') {
    await settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), provider: 'jev', points: { [point]: { mode, threshold: 0.85, consent: null } } });
    await settings.setConsent(point, { granted: true, stateVersion: decisionPoint(point)?.stateVersion ?? 1, providers: ['jev'] });
  }
  return { db, settings, engine, calls, rows: () => db.listDecisions().items };
}

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'claudio-decisions-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return repo;
}

async function finished(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 400; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') {
      await orchestrator.decided();
      return orch;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the orchestration never finished');
}

/** An orchestrator over the fake CLI, wired to a decision engine the way Core wires it */
async function graph(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', reply: Reply) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const d = await deciding(point, mode, reply, db);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  orchestrator.decisions = d.engine;
  const repo = repoWithCommit();
  const run = async (spec: Omit<Partial<OrchestrationSpec>, 'tasks'> & { tasks: Array<{ id: string; prompt: string }> }) => {
    const started = orchestrator.create({ name: 'decided', cwd: repo, worktree: true, synthesize: false, ...spec, tasks: spec.tasks.map((t) => ({ name: t.id, ...t })) });
    return finished(orchestrator, started.id);
  };
  return { ...d, orchestrator, repo, run };
}

// ---------- lesson.mine ----------

test('lesson.mine: a suggest point of project scope with one noul question and only the signals as state', async () => {
  const def = decisionPoint('lesson.mine');
  assert.ok(def);
  assert.equal(def.kind, 'suggest');
  assert.equal(def.scope, 'project');
  assert.deepEqual(def.primitives, ['noul']);
  assert.deepEqual(def.fields, ['signals']);
  assert.equal(def.stateVersion, 1);
  assert.equal(def.visible, false);
  const subject = { kind: 'chat' as const, id: 'c1', data: { signals: [{ id: 'S1', kind: 'correction', quote: 'no, use pnpm', context: '' }], secret: 'x' } };
  assert.deepEqual(await def.buildState(subject), { signals: subject.data.signals });
  assert.deepEqual(def.questions(subject).map((q) => [q.id, q.kind]), [['mine', 'noul']]);
});

// ---------- orchestration.retry ----------

const FLAKY = [{ id: 'flaky', prompt: 'FAKE-FAIL-ONCE the disk was full' }];
const permanent = replying(() => 'permanent');

test('orchestration.retry: off retries as before and asks nothing', async () => {
  const g = await graph('orchestration.retry', 'off', permanent);
  const orch = await g.run({ tasks: FLAKY });
  assert.equal(orch.tasks[0]?.status, 'completed');
  assert.equal(orch.tasks[0]?.attempts, 2);
  assert.equal(g.calls.length, 0);
  assert.equal(g.rows().length, 0);
});

test('orchestration.retry: shadow records the answer and the retry still happens', async () => {
  const g = await graph('orchestration.retry', 'shadow', permanent);
  const orch = await g.run({ tasks: FLAKY });
  assert.equal(orch.tasks[0]?.status, 'completed');
  assert.equal(orch.tasks[0]?.attempts, 2);
  const [row] = g.rows();
  assert.equal(g.rows().length, 1);
  assert.equal(row?.mode, 'shadow');
  assert.equal(row?.acted, false);
  assert.equal(row?.subjectKind, 'task');
  // The state is the error as words, the task name and the attempt as words: no number to count
  const state = g.calls[0]?.state as { error: string; task: string; attempt: string };
  assert.match(state.error, /the disk was full/);
  assert.equal(state.task, 'flaky');
  assert.equal(state.attempt, 'first attempt');
});

test('orchestration.retry: active stops a permanent error above the threshold, and only then', async () => {
  const sure = await graph('orchestration.retry', 'active', permanent);
  const stopped = await sure.run({ tasks: FLAKY });
  assert.equal(stopped.tasks[0]?.status, 'failed');
  assert.equal(stopped.tasks[0]?.attempts, 1, 'no second attempt');
  assert.match(stopped.tasks[0]?.error ?? '', /the disk was full/);
  assert.equal(sure.rows()[0]?.acted, true);

  const unsure = await graph('orchestration.retry', 'active', replying(() => 'permanent', 0.5));
  assert.equal((await unsure.run({ tasks: FLAKY })).tasks[0]?.attempts, 2, 'below the threshold, today');
  const transient = await graph('orchestration.retry', 'active', replying(() => 'transient'));
  assert.equal((await transient.run({ tasks: FLAKY })).tasks[0]?.status, 'completed');
});

test('orchestration.retry: an unavailable provider retries at once, and a continuation is never asked about', async () => {
  const g = await graph('orchestration.retry', 'active', noQuota);
  const orch = await g.run({ tasks: FLAKY });
  assert.equal(orch.tasks[0]?.status, 'completed');
  assert.equal(orch.tasks[0]?.attempts, 2);
  assert.equal(g.rows()[0]?.status, 'unavailable');
  assert.equal(g.rows()[0]?.unavailable, 'no-quota');

  // A turn that ends as a report is continued, which is not an attempt and not a question
  const c = await graph('orchestration.retry', 'active', permanent);
  const continued = await c.run({ tasks: [{ id: 'early', prompt: 'FAKE-TEXT-ONCE The schema is in place. Next, I will wire the route.' }] });
  assert.equal(continued.tasks[0]?.continuations, 1);
  assert.equal(c.calls.length, 0);
});

// ---------- run.continuation (the orchestrator side) ----------

const REPORT = [{ id: 'early', prompt: 'FAKE-TEXT-ONCE The schema is in place. Next, I will wire the route.' }];

test('run.continuation: off continues on the phrase list as before and asks nothing', async () => {
  const g = await graph('run.continuation', 'off', replying(() => 'done'));
  const orch = await g.run({ tasks: REPORT });
  assert.equal(orch.tasks[0]?.continuations, 1);
  assert.equal(g.calls.length, 0);
  assert.equal(g.rows().length, 0);
});

test('run.continuation: shadow records the answer and the phrase list still decides', async () => {
  const g = await graph('run.continuation', 'shadow', replying(() => 'done'));
  const orch = await g.run({ tasks: REPORT });
  assert.equal(orch.tasks[0]?.continuations, 1);
  // A continued turn whose report has no phrase is not asked about: the code rules hold its decision-only continuation back
  assert.ok(g.rows().length >= 1);
  assert.ok(g.rows().every((r) => !r.acted));
  // The last paragraph only, and the count as words
  const state = g.calls[0]?.state as { title: string; tail: string; continuations: string };
  assert.equal(state.tail, 'The schema is in place. Next, I will wire the route.');
  assert.equal(state.continuations, 'no continuation yet');
});

test('run.continuation: active drops the phrase items on done, adds one on owes-own-work, and only above the threshold', async () => {
  const done = await graph('run.continuation', 'active', replying(() => 'done'));
  const ended = await done.run({ tasks: REPORT });
  assert.equal(ended.tasks[0]?.continuations, undefined, 'a report the decision calls done is the end');
  assert.equal(ended.tasks[0]?.status, 'completed');
  assert.equal(ended.tasks[0]?.result, 'The schema is in place. Next, I will wire the route.');

  const handsOff = await graph('run.continuation', 'active', replying(() => 'hands-off'));
  assert.equal((await handsOff.run({ tasks: REPORT })).tasks[0]?.continuations, undefined, 'hands-off stops the run as done does');

  // No phrase matches this report, so the decision's own item is what the run is told
  const owes = await graph('run.continuation', 'active', replying(() => 'owes-own-work'));
  const goes = await owes.run({ tasks: [{ id: 'quiet', prompt: 'FAKE-TEXT-ONCE The schema is in place.' }] });
  // Every report of the graph is judged owing work, and the code rules allow one such continuation
  assert.equal(goes.tasks[0]?.continuations, 1);
  assert.match(goes.tasks[0]?.result ?? '', /a step of your own task is still to be taken/);
  assert.match(goes.tasks[0]?.result ?? '', /If nothing was owed, your earlier report stands\./);

  const unsure = await graph('run.continuation', 'active', replying(() => 'done', 0.5));
  assert.equal((await unsure.run({ tasks: REPORT })).tasks[0]?.continuations, 1, 'below the threshold, today');
});

test('run.continuation: an unavailable provider continues at once, and a result with no last paragraph is not asked', async () => {
  const g = await graph('run.continuation', 'active', noQuota);
  const orch = await g.run({ tasks: REPORT });
  assert.equal(orch.tasks[0]?.continuations, 1);
  assert.equal(g.rows()[0]?.unavailable, 'no-quota');

  const empty = await graph('run.continuation', 'active', replying(() => 'done'));
  await empty.run({ tasks: [{ id: 'plain', prompt: 'FAKE-WRITE plain.txt yes' }] });
  assert.equal(empty.calls.filter((c) => c.point === 'run.continuation').length, 1, 'the fake worker answers with text, so it is asked once');
});

test('run.continuation: the state carries the deliverable, whether the phrase list matched and what the turn did, and the baseline is the phrase items', async () => {
  const g = await graph('run.continuation', 'shadow', replying(() => 'done'));
  await g.run({ tasks: REPORT });
  const state = g.calls[0]?.state as { title: string; deliverable: string; tail: string; continuations: string; phraseListMatched: boolean; turn: { commits: number; edits: number } };
  assert.equal(state.title, 'early');
  assert.match(state.deliverable, /^FAKE-TEXT-ONCE The schema is in place\./);
  assert.equal(state.phraseListMatched, true);
  assert.deepEqual(state.turn, { commits: 0, edits: 0 });
  const first = g.rows().find((r) => r.state.continuations === 'no continuation yet');
  assert.ok(Array.isArray(first?.baseline));
  assert.equal((first?.baseline as unknown[]).length, 1, 'the phrase list found one item');
  assert.equal(decisionPoint('run.continuation')?.stateVersion, 2);
});

test('run.continuation: the three answers are done, hands-off and owes-own-work', () => {
  const def = decisionPoint('run.continuation');
  const [question] = def?.questions({ kind: 'task', id: 'o:t', data: {} }) ?? [];
  assert.equal(question?.kind, 'choice');
  assert.deepEqual(question?.kind === 'choice' ? question.options.map((o) => o.id) : [], ['done', 'hands-off', 'owes-own-work']);
  assert.deepEqual(def?.fields, ['title', 'deliverable', 'tail', 'continuations', 'phraseListMatched', 'turn']);
  const report = (value: string) => ({ report: { kind: 'choice' as const, value, probabilities: null, confidence: 0.99 } });
  assert.deepEqual(['done', 'hands-off', 'owes-own-work', 'owes-work'].map((v) => def?.effect.acts(report(v), {})), [false, false, true, true]);
  // Against the phrase list it replaces: the run it causes or saves, and none where the list agrees
  assert.deepEqual(['done', 'hands-off', 'owes-own-work'].map((v) => def?.effect.runs(report(v), [])), [0, 0, -1]);
  assert.deepEqual(['done', 'hands-off', 'owes-own-work'].map((v) => def?.effect.runs(report(v), ['offer'])), [1, 1, 0]);
});

// ---------- what each continuation changed (M3, D4) ----------

const effectsOf = (orch: Orchestration) => orch.tasks[0]?.continuationEffects ?? [];

test('a continuation that committed is recorded as a change, with its commits and edits', async () => {
  const g = await graph('run.continuation', 'off', replying(() => 'done'));
  const orch = await g.run({ tasks: [{ id: 'commits', prompt: 'FAKE-TEXT-ONCE The schema is in place. Next, I will wire the route.\nFAKE-THEN-COMMIT route.txt' }] });
  assert.deepEqual(effectsOf(orch), [{ n: 1, cause: 'phrase', changed: true, commits: 1, edits: 1 }]);
});

test('a continuation that only read is recorded as no change', async () => {
  const g = await graph('run.continuation', 'off', replying(() => 'done'));
  const orch = await g.run({ tasks: [{ id: 'reads', prompt: 'FAKE-TEXT-ONCE The schema is in place. Next, I will wire the route.\nFAKE-THEN-READ README.md' }] });
  assert.deepEqual(effectsOf(orch), [{ n: 1, cause: 'phrase', changed: false, commits: 0, edits: 0 }]);
});

test('a continuation that used no tool is recorded as no change', async () => {
  const g = await graph('run.continuation', 'off', replying(() => 'done'));
  const orch = await g.run({ tasks: REPORT });
  assert.deepEqual(effectsOf(orch), [{ n: 1, cause: 'phrase', changed: false, commits: 0, edits: 0 }]);
});

test('a worker that reports the same phrase every turn still reaches three continuations, each on record', async () => {
  const g = await graph('run.continuation', 'off', replying(() => 'done'));
  const orch = await g.run({ tasks: [{ id: 'always', prompt: 'FAKE-TEXT-ALWAYS The schema is in place. Next, I will wire the route.' }] });
  assert.equal(orch.tasks[0]?.continuations, 3);
  assert.deepEqual(
    effectsOf(orch).map((e) => [e.n, e.cause, e.changed]),
    [
      [1, 'phrase', false],
      [2, 'phrase', false],
      [3, 'phrase', false],
    ],
  );
});

test('a worker the decision reads as owing work every turn is sent back once, and its report is kept with the answer', async () => {
  const g = await graph('run.continuation', 'active', replying(() => 'owes-own-work'));
  const orch = await g.run({ tasks: [{ id: 'always', prompt: 'FAKE-TEXT-ALWAYS The schema is in place.' }] });
  assert.equal(orch.tasks[0]?.continuations, 1, 'no second decision-only continuation, and none after one that changed nothing');
  assert.deepEqual(effectsOf(orch), [{ n: 1, cause: 'decision', changed: false, commits: 0, edits: 0 }]);
  // The second report could only have sent a continuation the code rules hold back: it is not asked
  assert.equal(g.calls.filter((c) => c.point === 'run.continuation').length, 1);
  assert.equal(orch.tasks[0]?.result, 'The schema is in place.\n\nThe schema is in place.');
  assert.equal(g.rows().at(-1)?.acted, true);
});

test('a decision-only continuation that changed something does not open a second one', async () => {
  const g = await graph('run.continuation', 'active', replying(() => 'owes-own-work'));
  const orch = await g.run({ tasks: [{ id: 'once', prompt: 'FAKE-TEXT-ONCE The schema is in place.\nFAKE-THEN-COMMIT route.txt' }] });
  assert.equal(orch.tasks[0]?.continuations, 1);
  assert.deepEqual(effectsOf(orch), [{ n: 1, cause: 'decision', changed: true, commits: 1, edits: 1 }]);
});

// ---------- the baseline on each call (M2) ----------

test("orchestration.retry: the row's baseline is today's retry, which does not act", async () => {
  const g = await graph('orchestration.retry', 'shadow', permanent);
  await g.run({ tasks: FLAKY });
  assert.equal(g.rows()[0]?.baseline, false);
});

// ---------- orchestration.fixer ----------

const LINT = "echo 'FAKE-WRITE lint.txt ok'; echo '✗ lint.spec.mjs'; test -f lint.txt";
const UNIT = "echo 'FAKE-WRITE unit.txt ok'; echo '✗ unit.spec.mjs'; test -f unit.txt";
const CHECKS: VerificationSpec = { commands: ['true', [LINT, UNIT]], fixer: true, maxAttempts: 2 };
const worthIt = replying(() => true);
const notWorthIt = replying(() => false);

test('orchestration.fixer: off runs the fixer as before and asks nothing', async () => {
  const g = await graph('orchestration.fixer', 'off', notWorthIt);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'fixed');
  assert.equal(g.calls.length, 0);
  assert.equal(g.rows().length, 0);
});

test('orchestration.fixer: shadow asks once for a group of two failing checks and the fixer still runs', async () => {
  const g = await graph('orchestration.fixer', 'shadow', notWorthIt);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'fixed');
  assert.equal(orch.verification?.attempts, 1);
  // One question for the step, carrying both failed checks and the specs they name
  assert.equal(g.calls.length, 1);
  const state = g.calls[0]?.state as { checks: Array<{ command: string; output: string }>; failedSpecs: string[]; notes: string[]; attempt: string };
  assert.equal(state.checks.length, 2);
  assert.deepEqual(state.checks.map((c) => c.command), [LINT, UNIT]);
  assert.deepEqual([...state.failedSpecs].sort(), ['lint.spec.mjs', 'unit.spec.mjs']);
  assert.equal(state.attempt, 'first attempt');
  assert.equal(g.rows()[0]?.acted, false);
  // Today the fixer runs again: the code rule does not act
  assert.equal(g.rows()[0]?.baseline, false);
});

test('orchestration.fixer: active stops the fixing above the threshold and leaves the checks failed', async () => {
  const g = await graph('orchestration.fixer', 'active', notWorthIt);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'failed');
  assert.equal(orch.verification?.attempts, 0, 'no fixer run was started');
  assert.match(orch.verification?.report ?? '', /decision engine judged another fixer attempt unlikely to help/);
  assert.deepEqual(orch.verification?.commands.map((c) => c.status), ['passed', 'failed', 'failed']);
  assert.equal(g.rows()[0]?.acted, true);

  const unsure = await graph('orchestration.fixer', 'active', replying(() => false, 0.5));
  assert.equal((await unsure.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] })).verification?.status, 'fixed');
  const hopeful = await graph('orchestration.fixer', 'active', worthIt);
  assert.equal((await hopeful.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] })).verification?.status, 'fixed');
});

test('orchestration.fixer: an unavailable provider runs the fixer at once', async () => {
  const g = await graph('orchestration.fixer', 'active', noQuota);
  const orch = await g.run({ verification: CHECKS, tasks: [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }] });
  assert.equal(orch.verification?.status, 'fixed');
  assert.equal(g.rows()[0]?.unavailable, 'no-quota');
});

// ---------- orchestration.model ----------

const PLAN = JSON.stringify({
  name: 'plan',
  engine: 'graph',
  engineReason: 'changes files',
  tasks: [
    { id: 'a', name: 'A', prompt: 'rename the field\nin every file' },
    { id: 'b', name: 'B', prompt: 'design the migration', dependsOn: ['a'] },
  ],
});

async function planned(mode: 'off' | 'shadow' | 'active', reply: Reply) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const d = await deciding('orchestration.model', mode, reply, db);
  const orchestrator = new Orchestrator(config, new ChatManager(config, db), db);
  orchestrator.decisions = d.engine;
  const run = orchestrator.startPlan({ objective: `Ship it\nFAKE-RESULT-WORK ${PLAN}`, cwd: repoWithCommit(), model: 'opus' });
  const draft = await orchestrator.draft(run.id);
  await orchestrator.decided();
  return { ...d, draft };
}

const cheap = replying((id) => (id === 'a' ? 'haiku' : 'opus'));

test('orchestration.model: off leaves every task on the plan model and asks nothing', async () => {
  const p = await planned('off', cheap);
  assert.deepEqual(p.draft.tasks.map((t) => t.model), [undefined, undefined]);
  assert.equal(p.calls.length, 0);
  assert.equal(p.rows().length, 0);
});

test('orchestration.model: shadow records the suggestion and the draft is untouched', async () => {
  const p = await planned('shadow', cheap);
  assert.deepEqual(p.draft.tasks.map((t) => t.model), [undefined, undefined]);
  assert.equal(p.rows().length, 1);
  assert.equal(p.rows()[0]?.acted, false);
  const state = p.calls[0]?.state as { tasks: Array<{ id: string; prompt: string; dependsOn: string[] }>; models: Array<{ id: string }> };
  assert.deepEqual(state.tasks.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(state.tasks[1]?.dependsOn, ['a']);
  assert.deepEqual(state.models.map((m) => m.id), ['haiku', 'sonnet', 'opus']);
  // The baseline is the model each task takes today
  const baseline = p.rows()[0]?.baseline as Record<string, unknown>;
  assert.deepEqual(Object.keys(baseline), ['a', 'b']);
});

test('orchestration.model: active prefills the models that differ from the plan model, and the person still edits them', async () => {
  const p = await planned('active', cheap);
  // b is already on the plan's model, so nothing is prefilled for it
  assert.deepEqual(p.draft.tasks.map((t) => t.model), ['haiku', undefined]);
  assert.equal(p.draft.model, 'opus');
  assert.equal(p.rows()[0]?.acted, true);
  assert.equal(p.rows()[0]?.visible, true);
});

test('orchestration.model: an unavailable provider leaves the draft as today, at once', async () => {
  const p = await planned('active', noQuota);
  assert.deepEqual(p.draft.tasks.map((t) => t.model), [undefined, undefined]);
  assert.equal(p.rows()[0]?.unavailable, 'no-quota');
});

// ---------- supervisor.intervene ----------

const hung: HealthSignal = { kind: 'hung-command', level: 'bad', reason: '`pnpm e2e` has been running for 12 min.', detail: 'pnpm e2e' };
const chat = { id: 'c1', name: 'chat c1', cwd: '/work', workingDir: '/work', origin: 'claudio', orchestrationId: null } as ChatRuntime;
const transcript: TranscriptEntry[] = [
  {
    uuid: 'u1',
    role: 'assistant',
    timestamp: null,
    model: null,
    isSidechain: false,
    parentToolUseId: null,
    blocks: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } },
      { type: 'tool_result', toolUseId: 't1', content: 'exit 1: no such file', isError: true },
    ],
  },
];

/** The point is the Supervisor's one switch (docs/plans/settings-ia.md §7.2); `deciding` sets it under Jev, with consent */
async function supervising(mode: 'off' | 'shadow' | 'active', reply: Reply, opts: { provider?: 'jev' | 'cli'; autoSignals?: HealthSignal['kind'][] } = {}) {
  const config = tempConfig();
  const db = new Db(config);
  const d = await deciding('supervisor.intervene', mode, reply, db);
  if (opts.provider === 'cli') {
    const { jev: _jev, ...stored } = d.settings.get();
    await d.settings.set({ ...stored, provider: 'cli' });
    await d.settings.setConsent('supervisor.intervene', { granted: true, stateVersion: decisionPoint('supervisor.intervene')?.stateVersion ?? 1, providers: ['cli'] });
  }
  // Active sends on its own only for the kinds listed; these tests list the hung command unless told otherwise
  {
    const { jev: _jev, ...stored } = d.settings.get();
    await d.settings.set({ ...stored, supervisor: { autoSignals: opts.autoSignals ?? ['hung-command'] } });
  }
  const asked: string[] = [];
  const sent: string[] = [];
  const supervisor = new Supervisor({
    settings: d.settings,
    db,
    ask: (q) => {
      asked.push(q.prompt);
      return Promise.resolve({ structured: { stuck: true, hint: 'Check the open socket.' }, costUsd: 0.002, isError: false });
    },
    steps: () => Promise.resolve(transcript),
    hint: (p) => {
      sent.push(p.id);
      return Promise.resolve();
    },
    emit: () => undefined,
    charge: () => undefined,
    decisions: d.engine,
  });
  return { ...d, supervisor, asked, sent };
}

const waitFor = async (read: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !read(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('supervisor.intervene: off does not watch, asks for no hint and asks nothing else', async () => {
  const s = await supervising('off', replying(() => false));
  assert.equal(await s.supervisor.wake(chat, null, [hung]), null);
  assert.equal(s.asked.length, 0);
  assert.equal(s.calls.length, 0);
  assert.equal(s.rows().length, 0);
});

test('supervisor.intervene: shadow under Jev records the answer and proposes the hint for a person to send', async () => {
  const s = await supervising('shadow', replying(() => false));
  assert.equal((await s.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
  assert.equal(s.sent.length, 0);
  await waitFor(() => s.rows().length === 1);
  assert.equal(s.asked.length, 1);
  assert.equal(s.rows()[0]?.acted, false);
  assert.equal(s.rows()[0]?.subjectKind, 'chat');
  // The signal, its detail and the tool calls' names and errors: no input, no file content
  assert.deepEqual(s.calls[0]?.state, { signal: 'hung-command', detail: 'pnpm e2e', calls: [{ tool: 'Bash', error: 'exit 1: no such file' }] });
});

test('supervisor.intervene: active under Jev spares the hint above the threshold on a no, and sends it on its own otherwise', async () => {
  const no = await supervising('active', replying(() => false));
  assert.equal(await no.supervisor.wake(chat, null, [hung]), null);
  assert.equal(no.asked.length, 0, 'no housekeeping chat was started');
  assert.equal(no.rows()[0]?.acted, true);
  assert.equal(no.rows()[0]?.savedRun, true);
  // Today's rule, "a hint is drafted", never declines: the row says so for the comparison
  assert.equal(no.rows()[0]?.baseline, false);
  // The signal is not asked about again on the next tick
  assert.equal(await no.supervisor.wake(chat, null, [hung]), null);
  assert.equal(no.calls.length, 1);

  const unsure = await supervising('active', replying(() => false, 0.5));
  assert.equal((await unsure.supervisor.wake(chat, null, [hung]))?.status, 'sent');
  const yes = await supervising('active', replying(() => true));
  assert.equal((await yes.supervisor.wake(chat, null, [hung]))?.status, 'sent');
  assert.equal(yes.sent.length, 1);
});

test('supervisor.intervene: Active proposes for a signal kind not listed and sends for one that is', async () => {
  const listed = await supervising('active', replying(() => true), { autoSignals: ['hung-command'] });
  assert.equal((await listed.supervisor.wake(chat, null, [hung]))?.status, 'sent');
  assert.equal(listed.db.proposalsOf(chat.id)[0]?.sentBy, 'supervisor');

  const unlisted = await supervising('active', replying(() => true), { autoSignals: ['loop'] });
  const proposed = await unlisted.supervisor.wake(chat, null, [hung]);
  assert.equal(proposed?.status, 'proposed', 'a kind that has not earned it waits for a person');
  assert.equal(unlisted.sent.length, 0);
  assert.equal(unlisted.db.proposalsOf(chat.id)[0]?.sentBy, undefined);

  // A person's Send records who sent it
  const sent = await unlisted.supervisor.send(proposed?.id ?? '', { chatId: chat.id });
  assert.equal(sent.sentBy, 'person');
  assert.equal(unlisted.db.proposalsOf(chat.id)[0]?.sentBy, 'person');
});

test('supervisor.intervene: an unavailable provider asks for the hint at once', async () => {
  const s = await supervising('active', noQuota);
  assert.equal((await s.supervisor.wake(chat, null, [hung]))?.status, 'sent');
  assert.equal(s.rows()[0]?.unavailable, 'no-quota');
});

test('supervisor.intervene: under the CLI the engine is never asked; Active sends every hint, Shadow proposes it', async () => {
  const active = await supervising('active', replying(() => false), { provider: 'cli' });
  assert.equal(active.engine.effective('supervisor.intervene', null).limited, false, 'Active in full, not in name only');
  assert.equal((await active.supervisor.wake(chat, null, [hung]))?.status, 'sent');
  assert.equal(active.sent.length, 1);

  const shadow = await supervising('shadow', replying(() => false), { provider: 'cli' });
  assert.equal((await shadow.supervisor.wake(chat, null, [hung]))?.status, 'proposed');
  assert.equal(shadow.sent.length, 0);

  // Nothing waits on the engine, and nothing is recorded in the background either
  await new Promise((r) => setTimeout(r, 50));
  for (const s of [active, shadow]) {
    assert.equal(s.calls.length, 0);
    assert.equal(s.rows().length, 0);
  }
});

test('notification.urgency: the state may carry the risk of the chat\'s recent calls, at state version 2', () => {
  const urgency = decisionPoint('notification.urgency');
  assert.ok(urgency?.fields.includes('risk'));
  assert.equal(urgency?.stateVersion, 2);
});

// ---------- review.depth ----------

const GATE: VerificationSpec = { commands: ['true'], fixer: false, maxAttempts: 1, e2eSpecs: false, review: { fixer: false } };
const REVIEWED = [{ id: 'api', prompt: 'FAKE-WRITE api.txt server' }];
const light = replying(() => 'light');

test('review.depth: off runs the full review and asks nothing', async () => {
  const g = await graph('review.depth', 'off', light);
  const orch = await g.run({ verification: GATE, tasks: REVIEWED });
  assert.equal(orch.verification?.review?.status, 'passed');
  assert.equal(orch.verification?.review?.depth, 'full');
  assert.equal(g.calls.length, 0);
});

test('review.depth: shadow records the answer and runs the full review', async () => {
  const g = await graph('review.depth', 'shadow', light);
  const orch = await g.run({ verification: GATE, tasks: REVIEWED });
  assert.equal(orch.verification?.review?.depth, 'full');
  assert.equal(g.rows().length, 1);
  assert.equal(g.rows()[0]?.acted, false);
  // The state holds only the point's fields
  const state = g.calls[0]?.state as { files: number; paths: string[]; securityHit: boolean; dimensions: string[]; estimateUsd: number };
  assert.deepEqual(Object.keys(state).sort(), ['added', 'deleted', 'dimensions', 'estimateUsd', 'files', 'paths', 'securityHit']);
  assert.deepEqual(state.paths, ['api.txt']);
  assert.equal(g.rows()[0]?.baseline, 'full', 'today the review is full');
});

test('review.depth: active acts above the threshold, a graph that fixed its depth is not asked, and an unavailable provider is full', async () => {
  const g = await graph('review.depth', 'active', light);
  assert.equal((await g.run({ verification: GATE, tasks: REVIEWED })).verification?.review?.depth, 'light');
  assert.equal(g.rows()[0]?.acted, true);

  const set = await graph('review.depth', 'active', light);
  const orch = await set.run({ verification: { ...GATE, review: { fixer: false, depth: 'full' } }, tasks: REVIEWED });
  assert.equal(orch.verification?.review?.depth, 'full');
  assert.equal(set.calls.length, 0);

  const unsure = await graph('review.depth', 'active', replying(() => 'light', 0.5));
  assert.equal((await unsure.run({ verification: GATE, tasks: REVIEWED })).verification?.review?.depth, 'full');
  const none = await graph('review.depth', 'active', noQuota);
  assert.equal((await none.run({ verification: GATE, tasks: REVIEWED })).verification?.review?.depth, 'full');
});
