import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ChatSummary, DecisionSettings, SupervisorConfig, SupervisorProposal } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The supervisor over HTTP: its settings, and a person sending or dismissing what it proposed. The
// proposals are written as the supervisor would write them, so no model is asked anything here.
process.env.FAKE_CLAUDE_LOGGED_IN = '1';
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude-control.mjs', import.meta.url));

let app: FastifyInstance;
let core: Core;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-api-supervisor-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: workspace,
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  core.runtime.stopAll();
  await app.close();
  core.shutdown();
});

async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const proposal = (over: Partial<SupervisorProposal>): SupervisorProposal => ({
  id: `p-${Math.random().toString(36).slice(2)}`,
  chatId: 'nobody',
  signal: 'hung-command',
  hint: 'Is a connection left open?',
  costUsd: 0.001,
  at: new Date().toISOString(),
  status: 'proposed',
  ...over,
});

test('the deprecated settings are a view of the supervisor.intervene point, and a write sets its mode only', async () => {
  const view = async () => (await app.inject({ method: 'GET', url: '/api/settings/supervisor' })).json<SupervisorConfig>();
  const pointMode = () => core.decisionSettings.get().points['supervisor.intervene']?.mode ?? 'off';
  const read = await app.inject({ method: 'GET', url: '/api/settings/supervisor' });
  assert.equal(read.statusCode, 200);
  // Off by default, with the decision engine's CLI model and cap
  assert.deepEqual(read.json(), { enabled: false, model: 'haiku', autoSend: false, maxCostUsd: 0.25 });

  const put = async (body: unknown) => app.inject({ method: 'PUT', url: '/api/settings/supervisor', payload: body as object });
  const shadow = await put({ enabled: true, model: 'opus', autoSend: false, maxCostUsd: 3 });
  assert.equal(shadow.statusCode, 200);
  assert.deepEqual(shadow.json(), { enabled: true, model: 'haiku', autoSend: false, maxCostUsd: 0.25 }, 'the model and the cap are ignored');
  assert.equal(pointMode(), 'shadow');
  assert.deepEqual(core.decisionSettings.get().cli, { model: 'haiku', effort: 'low', maxCostUsd: 0.02, supervisorMaxCostUsd: 0.25 });

  assert.equal((await put({ enabled: true, autoSend: true })).statusCode, 200);
  assert.equal(pointMode(), 'active');
  assert.deepEqual(await view(), { enabled: true, model: 'haiku', autoSend: true, maxCostUsd: 0.25 });

  // The engine's settings are what the view reads back
  const settings = (await app.inject({ url: '/api/decisions/settings' })).json<DecisionSettings>();
  const { jev: _jev, ...stored } = settings;
  const updated = await app.inject({ method: 'PUT', url: '/api/decisions/settings', payload: { ...stored, cli: { ...stored.cli, model: 'sonnet', maxCostUsd: 0.04, supervisorMaxCostUsd: 0.5 }, points: { 'supervisor.intervene': { mode: 'shadow' } } } });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(await view(), { enabled: true, model: 'sonnet', autoSend: false, maxCostUsd: 0.5 });

  const bad = await put({ enabled: 'yes' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /enabled/);
  assert.equal(pointMode(), 'shadow', 'a refused write changes nothing');

  assert.equal((await put({ enabled: false, autoSend: true })).statusCode, 200);
  assert.equal(pointMode(), 'off');
  assert.equal(existsSync(join(core.config.dataDir, 'supervisor.json')), false, 'supervisor.json is never written');
});

test('both routes are documented as deprecated', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { deprecated?: boolean; summary?: string }>> }>();
  for (const method of ['get', 'put']) {
    const op = spec.paths['/api/settings/supervisor']?.[method];
    assert.equal(op?.deprecated, true, method);
    assert.match(op?.summary ?? '', /deprecated/i);
  }
});

test('a proposal is sent to its chat once, dismissed once, and found only under its own chat or task', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/chats', payload: { prompt: 'SLEEP 60' } });
  assert.equal(created.statusCode, 201);
  const id = created.json<ChatSummary>().id;
  await until(() => core.runtime.pulse(id)?.commands[0], 'the command to start');

  const toSend = proposal({ chatId: id });
  const toDismiss = proposal({ chatId: id, signal: 'loop' });
  assert.ok(core.db.saveProposal(toSend));
  assert.ok(core.db.saveProposal(toDismiss));

  const elsewhere = await app.inject({ method: 'POST', url: `/api/chats/another/supervisor/${toSend.id}/send` });
  assert.equal(elsewhere.statusCode, 404);

  const sent = await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toSend.id}/send` });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json<SupervisorProposal>().status, 'sent');
  const said = core.runtime.events(id).flatMap((e) => e.entry?.blocks ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : []));
  assert.ok(said.some((t) => t.startsWith('A hint from the person following this chat') && t.includes('Is a connection left open?')));

  const again = await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toSend.id}/send` });
  assert.equal(again.statusCode, 409);

  const dismissed = await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toDismiss.id}/dismiss` });
  assert.equal(dismissed.statusCode, 200);
  assert.equal(dismissed.json<SupervisorProposal>().status, 'dismissed');
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/supervisor/${toDismiss.id}/dismiss` })).statusCode, 409);
});

test('a task proposal is acted on from the board, and a task that is not running refuses the hint', async () => {
  const forTask = proposal({ chatId: 'worker', orchestrationId: 'orch-x', taskId: 'build' });
  const other = proposal({ chatId: 'worker', signal: 'loop', orchestrationId: 'orch-x', taskId: 'build' });
  core.db.saveProposal(forTask);
  core.db.saveProposal(other);

  assert.equal((await app.inject({ method: 'POST', url: `/api/orchestrations/orch-x/tasks/other/supervisor/${forTask.id}/dismiss` })).statusCode, 404);
  // The graph does not exist, so the task hint route has no worker to reach; the proposal stays proposed
  const send = await app.inject({ method: 'POST', url: `/api/orchestrations/orch-x/tasks/build/supervisor/${forTask.id}/send` });
  assert.equal(send.statusCode, 404);
  assert.equal(core.db.proposal(forTask.id)?.status, 'proposed');

  const dismissed = await app.inject({ method: 'POST', url: `/api/orchestrations/orch-x/tasks/build/supervisor/${other.id}/dismiss` });
  assert.equal(dismissed.statusCode, 200);
  assert.equal(dismissed.json<SupervisorProposal>().status, 'dismissed');
});
