import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { Account, ModelFallback, ModelFallbackSuggestion, ModelOption } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { fallbackCandidates } from '../src/routes/accounts.ts';
import { signInDefault } from './helpers.ts';

// The per-account model list and the model fallbacks over HTTP, against the accounts package's fake
// `claude`, whose `initialize` answers a Max-like list for a login and a Pro-like one (no Opus) for a token.
const FAKE_CLAUDE = join(import.meta.dirname, '../../../packages/accounts/test/fake-claude.mjs');
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-api-model-fallbacks-'));
  // The fake CLI writes its probe counter into the config dir, which a real one creates itself
  mkdirSync(join(root, 'claude'));
  // The CLI's own login has a credential, so chats start on it
  signInDefault(join(root, 'claude'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test("GET /accounts/:id/models is the account's list from the CLI, and a token account lacks Opus", async () => {
  const mine = (await app.inject('/api/accounts/default/models')).json<ModelOption[]>();
  assert.ok(mine.some((m) => m.value === 'opus' && m.resolvedModel === 'claude-opus-5-5'));
  const { id } = (await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'token', alias: 'lite', secret: 'k' }) })).json<Account>();
  const lite = (await app.inject(`/api/accounts/${id}/models?refresh=true`)).json<ModelOption[]>();
  assert.ok(lite.length > 0 && !lite.some((m) => m.value === 'opus'));
  assert.equal((await app.inject('/api/accounts/nope/models')).statusCode, 404);
  await app.inject({ method: 'DELETE', url: `/api/accounts/${id}` });
});

test('the model fallbacks are written whole, validated, and read back', async () => {
  assert.deepEqual((await app.inject('/api/accounts/model-fallbacks')).json<ModelFallback[]>(), []);
  const put = await app.inject({ method: 'PUT', url: '/api/accounts/model-fallbacks', ...json({ fallbacks: [{ from: 'opus', to: 'sonnet' }] }) });
  assert.equal(put.statusCode, 200);
  const [entry] = put.json<ModelFallback[]>();
  assert.equal(entry?.from, 'opus');
  assert.equal(entry?.to, 'sonnet');
  assert.equal(entry?.origin, 'user');
  assert.deepEqual((await app.inject('/api/accounts/model-fallbacks')).json<ModelFallback[]>(), [entry]);
  for (const fallbacks of [[{ from: 'a', to: 'a' }], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }], [{ from: '', to: 'b' }]]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/model-fallbacks', ...json({ fallbacks }) })).statusCode, 400);
  }
  assert.deepEqual((await app.inject('/api/accounts/model-fallbacks')).json<ModelFallback[]>(), [entry], 'a refused write changes nothing');
  await app.inject({ method: 'PUT', url: '/api/accounts/model-fallbacks', ...json({ fallbacks: [] }) });
});

test('the fallback suggestion lists lower models and suggests nothing while the point is off', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/accounts/model-fallbacks/suggest', ...json({ model: 'opus' }) });
  assert.equal(res.statusCode, 200);
  const suggestion = res.json<ModelFallbackSuggestion>();
  assert.equal(suggestion.model, 'opus');
  assert.ok(suggestion.candidates.length > 0);
  assert.ok(suggestion.candidates.every((c) => c.value !== 'opus' && c.tier !== 'strong'));
  assert.equal(suggestion.suggestion, null);
  assert.equal(suggestion.decisionId, null);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/model-fallbacks/suggest', ...json({ model: '' }) })).statusCode, 400);
});

test('fallbackCandidates puts the same line first, then the tier below, and never a higher one', () => {
  const opt = (value: string, tier: ModelOption['tier']): ModelOption => ({ value, resolvedModel: `claude-${value}-5`, ...(tier ? { tier } : {}) });
  const opus = opt('opus', 'strong');
  const list = [opt('haiku', 'fast'), opt('sonnet', 'balanced'), { ...opt('opus-lite', 'strong'), resolvedModel: 'claude-opus-4' }, opus, { ...opt('sonnet-old', 'balanced'), disabled: true }];
  assert.deepEqual(fallbackCandidates(opus, 'opus', list).map((c) => c.value), ['opus-lite', 'sonnet', 'haiku']);
  assert.deepEqual(fallbackCandidates(opt('haiku', 'fast'), 'haiku', list).map((c) => c.value), []);
});
