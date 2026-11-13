import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { DecisionLabel, DecisionLabelImportResult, DecisionRecord, DecisionReplay, DecisionReplayList } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The golden set and replay routes. No provider is asked anything: the one replay these tests
// start is refused for want of consent before anything is sent.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-replay-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  await core.shutdown();
});

const QUESTIONS = [{ kind: 'choice', id: 'bounce', question: 'Can the Developer fix it alone?', options: [{ id: 'fixable', label: 'Fixable' }, { id: 'needs-person', label: 'Needs a person' }] }];

const row = (id: string): DecisionRecord => ({
  id,
  point: 'flow.bounce',
  kind: 'act',
  projectId: 'p1',
  subjectKind: 'flow_run',
  subjectId: 'run-1',
  provider: 'jev',
  model: 'jev-1.13.0',
  mode: 'shadow',
  status: 'answered',
  unavailable: null,
  state: { rejection: 'tests fail' },
  questions: QUESTIONS as DecisionRecord['questions'],
  answers: { bounce: { kind: 'choice', value: 'fixable', probabilities: null, confidence: 0.9 } },
  confidence: 0.9,
  threshold: 0.85,
  acted: false,
  visible: false,
  savedRun: false,
  runEffect: 0,
  baseline: null,
  heldOut: false,
  latencyMs: 120,
  inputTokens: null,
  costUsd: 0.001,
  outcome: null,
  agreed: null,
  resolvedAt: null,
  feedback: null,
  feedbackAt: null,
  openedAt: null,
  paletteAction: null,
  at: new Date().toISOString(),
});

test('a person labels a history row, relabels it, and the label outlives the row', async () => {
  core.db.insertDecision(row('lab-1'));
  const first = await app.inject({ method: 'POST', url: '/api/decisions/labels', ...json({ decisionId: 'lab-1', positive: true, note: 'it was a typo' }) });
  assert.equal(first.statusCode, 200);
  const label = first.json<DecisionLabel>();
  assert.deepEqual([label.point, label.source, label.positive, label.decisionId, label.state], ['flow.bounce', 'person', true, 'lab-1', { rejection: 'tests fail' }]);

  const again = await app.inject({ method: 'POST', url: '/api/decisions/labels', ...json({ decisionId: 'lab-1', positive: false }) });
  assert.equal(again.json<DecisionLabel>().id, label.id, 'the same row keeps one label');
  assert.equal(again.json<DecisionLabel>().positive, false);

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/decisions/lab-1' })).statusCode, 200);
  const listed = (await app.inject('/api/decisions/labels?point=flow.bounce')).json<DecisionLabel[]>();
  assert.equal(listed.filter((l) => l.decisionId === 'lab-1').length, 1);

  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/labels', ...json({ decisionId: 'no-such-row', positive: true }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/labels', ...json({ decisionId: 'lab-1', positive: 'yes' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/decisions/labels/${label.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/decisions/labels/${label.id}` })).statusCode, 404);
});

test('an imported set is validated whole and its states are redacted on the way in', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/decisions/labels/import', ...json({ labels: [{ point: 'flow.bounce', state: {}, questions: QUESTIONS, positive: true }, { point: 'flow.bounce', state: {}, questions: [], positive: true }] }) });
  assert.equal(bad.statusCode, 400);
  const before = (await app.inject('/api/decisions/labels?point=flow.bounce')).json<DecisionLabel[]>().length;

  const ok = await app.inject({
    method: 'POST',
    url: '/api/decisions/labels/import',
    ...json({ labels: [{ point: 'flow.bounce', state: { rejection: 'needs a decision, API_KEY=sk-live-abcdef1234567890' }, questions: QUESTIONS, positive: true, note: 'from the review' }] }),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json<DecisionLabelImportResult>().imported, 1);
  const labels = (await app.inject('/api/decisions/labels?point=flow.bounce')).json<DecisionLabel[]>();
  assert.equal(labels.length, before + 1, 'the rejected set wrote nothing');
  assert.ok(!JSON.stringify(labels).includes('sk-live-abcdef1234567890'));
});

test('a replay without the point\'s consent is refused and sends nothing', async () => {
  const answer = await app.inject({ method: 'POST', url: '/api/decisions/replays', ...json({ point: 'flow.bounce', provider: 'jev' }) });
  assert.equal(answer.statusCode, 409);
  assert.match(answer.json<{ message?: string; error?: string }>().message ?? answer.body, /no consent/);
  assert.equal(core.db.decisionReplays('flow.bounce').length, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/decisions/replays', ...json({ point: 'no.such.point' }) })).statusCode, 404);
});

test('stored replays are listed by point, newest first', async () => {
  const stored = (id: string, at: string): DecisionReplay => ({
    id,
    point: 'flow.bounce',
    at,
    provider: 'jev',
    model: 'jev-1.13.0',
    questions: QUESTIONS as DecisionReplay['questions'],
    questionsHash: 'h',
    cases: 3,
    unavailable: 0,
    score: { precision: { n: 0, hits: 0, value: null, lower90: null }, baselinePrecision: { n: 0, hits: 0, value: null, lower90: null }, baseline: { rows: 0, differs: 0, decisionRight: 0, baselineRight: 0, unresolved: 0 }, calibration: [], actRate: { n: 0, hits: 0, value: null, lower90: null } },
    confusion: { actedRight: 0, actedWrong: 0, heldRight: 0, heldWrong: 0, unreadable: 0, recall: { n: 0, hits: 0, value: null, lower90: null } },
    costUsd: 0,
    consent: 'point',
    note: null,
  });
  core.db.saveDecisionReplay(stored('r1', '2026-11-13T09:00:00.000Z'));
  core.db.saveDecisionReplay(stored('r2', '2026-11-13T10:00:00.000Z'));
  const list = (await app.inject('/api/decisions/replays?point=flow.bounce')).json<DecisionReplayList>();
  assert.deepEqual(list.items.map((r) => r.id), ['r2', 'r1']);
  assert.deepEqual(list.running, []);
  assert.equal((await app.inject('/api/decisions/replays?point=flow.restart')).json<DecisionReplayList>().items.length, 0);
});

test("a chat's token cannot write labels or start a replay, but can read them", async () => {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  try {
    const chat = core.security.chatTokens.mint('chat-42');
    const fromChat = (method: string, url: string, body?: unknown) => ({
      method: method as 'GET',
      url,
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const forbidden: Array<[string, string, unknown]> = [
      ['POST', '/api/decisions/labels', { decisionId: 'lab-1', positive: true }],
      ['DELETE', '/api/decisions/labels/some-label', undefined],
      ['POST', '/api/decisions/labels/import', { labels: [] }],
      ['POST', '/api/decisions/labels/outcomes', { point: 'flow.bounce' }],
      ['POST', '/api/decisions/replays', { point: 'flow.bounce' }],
    ];
    for (const [method, url, body] of forbidden) {
      const answer = await app.inject(fromChat(method, url, body));
      assert.equal(answer.statusCode, 403, `${method} ${url}`);
      assert.equal(answer.json().code, 'chat-forbidden');
    }
    assert.equal((await app.inject(fromChat('GET', '/api/decisions/labels'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/decisions/replays'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});
