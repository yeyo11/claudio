import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DecisionRecord, ModelFallback } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { DecisionEngine } from '../src/decisions/engine.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionResolvers } from '../src/decisions/resolve.ts';
import { ModelFallbackStore } from '../src/decisions/settings.ts';
import { loadConfig } from '../src/paths.ts';
import { tempConfig } from './helpers.ts';

function store() {
  const root = mkdtempSync(join(tmpdir(), 'agentry-fallbacks-'));
  const config = loadConfig({ CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(root, 'claude'), AGENTRY_WORKSPACE_DIR: join(root, 'ws'), AGENTRY_DATA_DIR: join(root, 'data') });
  return { fallbacks: new ModelFallbackStore(config), dir: config.dataDir };
}

test('account.model-fallback is a global suggest point whose options are the candidate models, plus none', () => {
  const point = decisionPoint('account.model-fallback');
  assert.equal(point?.kind, 'suggest');
  assert.equal(point?.scope, 'global');
  const candidates = [
    { id: 'sonnet', displayName: 'Sonnet 5.5', tier: 'balanced' },
    { id: 'haiku', displayName: 'Haiku 5.5', tier: 'fast' },
  ];
  const questions = point?.questions({ kind: 'model', id: 'opus', data: { model: 'opus', candidates } }) ?? [];
  assert.equal(questions.length, 1);
  const first = questions[0];
  assert.ok(first?.kind === 'choice' && first.options.map((o) => o.id).join() === 'sonnet,haiku,none');
  assert.deepEqual(point?.questions({ kind: 'model', id: 'opus', data: { model: 'opus', candidates: [] } }), []);
});

test('model-fallbacks.json reads as no mapping until a person saves one', async () => {
  const { fallbacks } = store();
  assert.deepEqual(fallbacks.list(), []);
  assert.equal(fallbacks.target('opus'), null);
  const now = new Date('2026-10-15T10:00:00.000Z');
  const saved = await fallbacks.set({ fallbacks: [{ from: 'opus', to: 'sonnet' }, { from: 'fable', to: 'opus', origin: 'suggestion' }] }, now);
  assert.deepEqual(saved, [
    { from: 'opus', to: 'sonnet', origin: 'user', at: now.toISOString() },
    { from: 'fable', to: 'opus', origin: 'suggestion', at: now.toISOString() },
  ]);
  assert.equal(fallbacks.target('opus'), 'sonnet');
  // A pair already there keeps its stamp
  const later = await fallbacks.set({ fallbacks: [{ from: 'opus', to: 'sonnet', origin: 'suggestion' }] }, new Date('2026-10-16T10:00:00.000Z'));
  assert.deepEqual(later, [{ from: 'opus', to: 'sonnet', origin: 'user', at: now.toISOString() }]);
});

test('a bad mapping is refused whole, and a hand-edited bad entry is skipped on read', async () => {
  const { fallbacks, dir } = store();
  await assert.rejects(fallbacks.set({ fallbacks: [{ from: 'opus', to: 'opus' }] }), /itself/);
  await assert.rejects(fallbacks.set({ fallbacks: [{ from: 'opus', to: 'sonnet' }, { from: 'opus', to: 'haiku' }] }), /already has/);
  await assert.rejects(fallbacks.set({ fallbacks: [{ from: 'op us', to: 'sonnet' }] }), /from/);
  await assert.rejects(fallbacks.set({ fallbacks: [{ from: 'opus', to: 'sonnet', origin: 'robot' }] }), /origin/);
  await assert.rejects(fallbacks.set({}), /array/);
  mkdirSync(dir, { recursive: true });
  const at = '2026-10-15T10:00:00.000Z';
  writeFileSync(join(dir, 'model-fallbacks.json'), JSON.stringify({ fallbacks: [{ from: 'x y', to: 'z', origin: 'user', at }, { from: 'opus', to: 'sonnet', origin: 'user', at }] }));
  assert.deepEqual(fallbacks.list().map((f) => f.from), ['opus']);
});

test('the resolver judges a suggestion by the mapping the person accepted', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const engine = new DecisionEngine({ settings: { get: () => ({ historyDays: 30 }) } as never, db, projectDecisions: () => null });
  let accepted: ModelFallback[] = [];
  const resolvers = new DecisionResolvers({ sql: db.connection, db, engine, historyDays: () => 30, modelFallbacks: () => accepted, now: () => new Date('2026-10-16T00:00:00.000Z') });
  const insert = (id: string, value: string): void => {
    const record: DecisionRecord = {
      id, point: 'account.model-fallback', kind: 'suggest', projectId: null, subjectKind: 'model', subjectId: 'opus', provider: 'cli', model: 'haiku', mode: 'shadow', status: 'answered', unavailable: null,
      state: { model: 'opus' }, questions: [], answers: { model: { kind: 'choice', value } }, confidence: 0.9, threshold: 0.85, acted: false, visible: false, savedRun: false, latencyMs: 1, inputTokens: 1, costUsd: 0,
      outcome: null, agreed: null, resolvedAt: null, feedback: null, feedbackAt: null, openedAt: null, paletteAction: null, at: '2026-10-15T10:00:00.000Z',
    };
    db.insertDecision(record);
  };
  insert('a', 'sonnet');
  insert('b', 'none');
  assert.equal(resolvers.sweep(), 0, 'nothing is known while no mapping is accepted');
  accepted = [{ from: 'opus', to: 'sonnet', origin: 'suggestion', at: '2026-10-15T11:00:00.000Z' }];
  assert.equal(resolvers.sweep(), 1);
  assert.equal(db.decision('a')?.agreed, true);
  assert.equal(db.decision('b')?.agreed, null);
});
