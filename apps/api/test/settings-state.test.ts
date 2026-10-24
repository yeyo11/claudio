import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ClaudioEvent, SettingOverrides, SettingState, SettingsState } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

/** Each test gets its own wrapper, so a stored setting never leaks into the next */
async function wrapper(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-settings-state-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    await app.close();
    core.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, core };
}

test('a changed setting shows as changed, and its reset brings the default back and emits the store event', async (t) => {
  const { app, core } = await wrapper(t);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ maxConcurrentRuns: 3 }) })).statusCode, 200);
  const before = (await app.inject('/api/settings/state')).json<SettingsState>();
  assert.deepEqual(before.settings['runs.concurrent'], { changed: true, source: 'stored', default: 8 });

  const seen: ClaudioEvent[] = [];
  const stop = core.events.subscribe((event) => seen.push(event));
  t.after(stop);
  const reset = await app.inject({ method: 'DELETE', url: '/api/settings/state/runs.concurrent' });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json<SettingState>(), { changed: false, source: 'default', default: 8 });
  assert.equal((await app.inject('/api/settings/app')).json<{ maxConcurrentRuns: number }>().maxConcurrentRuns, 8);
  assert.ok(seen.some((event) => event.type === 'settings.changed'));
});

test('an unknown id is a 404 and a setting the environment sets is a 409 setting-from-env', async (t) => {
  const { app } = await wrapper(t, { CLAUDIO_MAX_CONCURRENT_RUNS: '4' });
  const unknown = await app.inject({ method: 'DELETE', url: '/api/settings/state/access.mode' });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json<{ code: string }>().code, 'setting-unknown');

  const fromEnv = await app.inject({ method: 'DELETE', url: '/api/settings/state/runs.concurrent' });
  assert.equal(fromEnv.statusCode, 409);
  assert.equal(fromEnv.json<{ code: string }>().code, 'setting-from-env');
  assert.equal((await app.inject('/api/settings/state')).json<SettingsState>().settings['runs.concurrent']?.source, 'env');
});

test("a chat's token reads the state and cannot reset any setting", async (t) => {
  const { app, core } = await wrapper(t);
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  const owner = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/app', ...json({ dailySpendCapUsd: 5 }, owner) })).statusCode, 200);

  const chat = core.security.chatTokens.mint('chat-42');
  const asChat = (method: 'GET' | 'DELETE', url: string) => ({ method, url, remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}` } });
  assert.equal((await app.inject(asChat('GET', '/api/settings/state'))).statusCode, 200);
  for (const id of ['spend-cap.daily', 'point-flow-bounce', 'guards.rule.push', 'terminal.scrollback', 'nope']) {
    assert.equal((await app.inject(asChat('DELETE', `/api/settings/state/${id}`))).statusCode, 403, id);
  }
  assert.equal(core.appSettings.dailySpendCapUsd, 5);
});

test("a decision point's reset keeps its consent", async (t) => {
  const { app, core } = await wrapper(t);
  await core.decisionSettings.set({ provider: 'cli', cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02 }, historyDays: 30, points: { 'flow.bounce': { mode: 'shadow', threshold: 0.9 } } });
  await core.decisionSettings.setConsent('flow.bounce', { granted: true, stateVersion: 1, providers: ['cli'] });

  const reset = await app.inject({ method: 'DELETE', url: '/api/settings/state/point-flow-bounce' });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json<SettingState>().changed, false);
  const point = core.decisionSettings.get().points['flow.bounce'];
  assert.equal(point?.mode, 'off');
  assert.equal(point?.consent?.stateVersion, 1);
});

test('the overrides name the projects that set a global setting, sorted by name', async (t) => {
  const { app } = await wrapper(t);
  const create = async (name: string) => (await app.inject({ method: 'POST', url: '/api/projects', ...json({ name }) })).json<{ id: string }>().id;
  const zeta = await create('zeta');
  const alpha = await create('alpha');
  for (const id of [zeta, alpha]) {
    const settings = (await app.inject(`/api/projects/${id}/settings`)).json<Record<string, unknown>>();
    const put = await app.inject({ method: 'PUT', url: `/api/projects/${id}/settings`, ...json({ ...settings, decisions: { provider: 'jev' } }) });
    assert.equal(put.statusCode, 200, put.body);
  }
  const overrides = (await app.inject('/api/settings/overrides')).json<SettingOverrides>();
  assert.deepEqual(overrides, { 'engine.who-answers': [alpha, zeta] });
});
