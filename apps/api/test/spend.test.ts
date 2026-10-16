import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { Orchestration, SpendCapRefusal, SpendState } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The daily spend cap over a real core and the fake CLI (docs/plans/agent-run-improvements.md, idea
// 13): `GET /spend`, the 409 on every route a person starts work from, the override only the owner
// may send, and the pass and the cap a chat's token can never touch.

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));
const OVERRIDE = { 'x-claudio-spend-override': '1' };
const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  root: string;
}

async function wrapper(): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-api-spend-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  // The address the assistant chat's MCP server would call; the fake CLI never starts it
  core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core, root };
}

const finish = (w: Wrapper) => async () => {
  w.core.shutdown();
  await w.app.close();
  rmSync(w.root, { recursive: true, force: true });
};

/** A cap of 10 USD with 20 spent today: the gate is closed. */
async function overCap({ core: c }: Wrapper): Promise<void> {
  await c.appSettings.update({ dailySpendCapUsd: 10 });
  c.db.addSpend({ at: new Date().toISOString(), chatId: 'seed', executionId: 'seed', usd: 20, reported: true, purpose: 'flow', account: null, accountKind: null, projectId: null, orchestrationId: null });
}

const today = (): string => {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};

/** Every route a person starts work from, with a body each one can take. */
const GATED: Array<[string, string, unknown]> = [
  ['POST', '/api/chats', { prompt: 'hi' }],
  ['POST', '/api/chats/nope/messages', { text: 'hi' }],
  ['POST', '/api/chats/nope/resume', { prompt: 'hi' }],
  ['POST', '/api/chats/nope/fork', { prompt: 'hi' }],
  ['POST', '/api/workflows/saved/run', { name: 'w' }],
  ['POST', '/api/orchestrations', { name: 'g', cwd: tmpdir(), tasks: [{ id: 'a', name: 'a', prompt: 'do it' }] }],
  ['POST', '/api/orchestrations/plan', { objective: 'x' }],
  ['POST', '/api/orchestrations/plan/start', { objective: 'x' }],
  ['POST', '/api/orchestrations/templates/nope/launch', {}],
  ['POST', '/api/orchestrations/nope/resume', {}],
  ['POST', '/api/orchestrations/nope/relaunch', {}],
  ['POST', '/api/orchestrations/nope/verify', {}],
  ['POST', '/api/orchestrations/nope/tasks/a/retry', {}],
  ['POST', '/api/orchestrations/nope/tasks/a/retry-clean', {}],
  ['POST', '/api/orchestrations/nope/tasks/a/rerun', {}],
  ['POST', '/api/projects/nope/assistant/runs', { kind: 'project' }],
  ['POST', '/api/assistant/chats', { prompt: 'hi' }],
];

test('GET /spend answers the day against the cap, and the cap is in the settings', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const off = (await w.app.inject('/api/spend')).json<SpendState>();
  assert.equal(off.level, 'off');
  assert.equal(off.capUsd, null);
  assert.equal(off.blocked, false);

  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ dailySpendCapUsd: 10 }) })).statusCode, 200);
  assert.equal((await w.app.inject('/api/settings/app')).json<{ dailySpendCapUsd: number }>().dailySpendCapUsd, 10);
  await overCap(w);
  const state = (await w.app.inject('/api/spend')).json<SpendState>();
  assert.equal(state.capUsd, 10);
  assert.equal(state.spentUsd, 20);
  assert.equal(state.level, 'exhausted');
  assert.equal(state.blocked, true);
  assert.equal(state.day, today());
  assert.ok(state.resetsAt > new Date().toISOString());
  assert.equal(state.byPurpose.flow, 20);
});

test('every route a person starts work from answers 409 spend-cap over the cap', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  await overCap(w);
  for (const [method, url, body] of GATED) {
    const res = await w.app.inject({ method: method as 'POST', url, ...json(body) });
    assert.equal(res.statusCode, 409, `${method} ${url}`);
    const refusal = res.json<SpendCapRefusal>();
    assert.equal(refusal.code, 'spend-cap', url);
    assert.equal(refusal.spend.capUsd, 10, url);
    assert.equal(refusal.spend.blocked, true, url);
    assert.ok(refusal.error, url);
  }
});

test('under the cap nothing is refused, and a message to a chat mid-turn is never asked', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  await w.core.appSettings.update({ dailySpendCapUsd: 10 });
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi' }) })).statusCode, 201);
  const [, , body] = GATED[5] as [string, string, unknown];
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/orchestrations', ...json(body) })).statusCode, 201);
});

test("the owner's override goes through, and a launch past it gives its graph today's pass", async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  await overCap(w);
  for (const [method, url, body] of GATED) {
    const res = await w.app.inject({ method: method as 'POST', url, ...json(body, OVERRIDE) });
    assert.notEqual(res.statusCode, 409, `${method} ${url}: ${res.body}`);
  }
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi' }, OVERRIDE) })).statusCode, 201);
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/assistant/chats', ...json({ prompt: 'hi' }, OVERRIDE) })).statusCode, 201);
  const launched = await w.app.inject({ method: 'POST', url: '/api/orchestrations', ...json((GATED[5] as [string, string, unknown])[2], OVERRIDE) });
  assert.equal(launched.statusCode, 201, launched.body);
  const graph = launched.json<Orchestration>();
  assert.equal((await w.app.inject(`/api/orchestrations/${graph.id}`)).json<Orchestration>().spendPass, today());
  // A header that is not "1" is no override
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi' }, { 'x-claudio-spend-override': 'yes' }) })).statusCode, 409);
});

test('the pass route sets the graph’s pass and answers the graph', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const launched = await w.app.inject({ method: 'POST', url: '/api/orchestrations', ...json((GATED[5] as [string, string, unknown])[2]) });
  const graph = launched.json<Orchestration>();
  assert.ok(!graph.spendPass);
  await overCap(w);
  const res = await w.app.inject({ method: 'POST', url: `/api/orchestrations/${graph.id}/spend-pass` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<Orchestration>().spendPass, today());
  assert.equal(w.core.orchestrator.spendPassOf(graph.id), today());
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/orchestrations/nope/spend-pass' })).statusCode, 404);
});

test("a chat's token reads the spend but can neither override, grant a pass nor change the cap", async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const { token: owner } = (await w.app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>();
  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  const asOwner = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${owner}`, ...extra });
  const chatToken = w.core.security.chatTokens.mint('chat-42');
  const asChat = (body?: unknown, extra: Record<string, string> = {}) => ({
    remoteAddress: '127.0.0.1',
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${chatToken}`, ...extra },
  });
  await overCap(w);
  const launched = await w.app.inject({ method: 'POST', url: '/api/orchestrations', ...json((GATED[5] as [string, string, unknown])[2], asOwner(OVERRIDE)) });
  assert.equal(launched.statusCode, 201, launched.body);
  const graph = launched.json<Orchestration>();

  assert.equal((await w.app.inject({ url: '/api/spend', ...asChat() })).statusCode, 200);

  const refused = await w.app.inject({ method: 'POST', url: '/api/chats', ...asChat({ prompt: 'hi' }, OVERRIDE) });
  assert.equal(refused.statusCode, 409, 'the header from a chat token is ignored');
  assert.equal(refused.json<SpendCapRefusal>().code, 'spend-cap');
  const owned = await w.app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi' }, asOwner(OVERRIDE)) });
  assert.equal(owned.statusCode, 201, 'the same request from the owner goes through');

  assert.equal((await w.app.inject({ method: 'POST', url: `/api/orchestrations/${graph.id}/spend-pass`, ...asChat({}) })).statusCode, 403);
  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/settings/app', ...asChat({ dailySpendCapUsd: null }) })).statusCode, 403);
  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/settings/app', ...asChat({ dailySpendCapUsd: 1000 }) })).statusCode, 403);
  assert.equal(w.core.appSettings.dailySpendCapUsd, 10, 'the cap did not move');
  // The owner's pass works
  assert.equal((await w.app.inject({ method: 'POST', url: `/api/orchestrations/${graph.id}/spend-pass`, headers: asOwner() })).statusCode, 200);
});
