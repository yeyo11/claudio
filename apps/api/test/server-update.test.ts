import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, ServerUpdateRefusal, loadConfig } from '@claudio/core';
import type { ServerUpdateStatus } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { isOwnerActor } from '../src/security.ts';

const json = (body: unknown, token?: string) => ({
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

async function wrapper(env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-server-update-api-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      ...env,
    }),
  );
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core };
}

async function withToken(app: FastifyInstance): Promise<string> {
  const { token } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  return token;
}

const CHANGES = [
  ['POST', '/api/system/server-update/download'],
  ['POST', '/api/system/server-update/apply'],
  ['DELETE', '/api/system/server-update/scheduled'],
  ['POST', '/api/system/server-update/revert'],
  ['POST', '/api/system/cli-version/install'],
  ['DELETE', '/api/system/cli-version/install'],
] as const;

test('the status is read without any network, and says why this server cannot update itself', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  const status = (await app.inject('/api/system/server-update')).json() as ServerUpdateStatus;
  assert.equal(status.unsupportedReason, 'not-docker');
  assert.equal(status.running, core.version);
  assert.equal(status.state, 'idle');
  const cli = (await app.inject('/api/system/cli-version')).json();
  assert.equal(cli.installable, false);
  assert.equal(cli.install, null);
  assert.equal(cli.source, 'path');
});

test('with no authentication every change is refused with a code that says a token is needed', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  for (const [method, url] of CHANGES) {
    const res = await app.inject({ method, url, ...json({}) });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.json().code, url.includes('cli-version') ? 'cli.needs-auth' : 'update.needs-auth', `${method} ${url}`);
  }
});

test("the owner's token gets past the owner check; no credential is a 401", async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  const token = await withToken(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/server-update/download', ...json({}) })).statusCode, 401);
  const download = await app.inject({ method: 'POST', url: '/api/system/server-update/download', ...json({}, token) });
  assert.equal(download.statusCode, 400);
  assert.equal(download.json().code, 'update.unsupported');
  const install = await app.inject({ method: 'POST', url: '/api/system/cli-version/install', ...json({}, token) });
  assert.equal(install.statusCode, 400);
  assert.equal(install.json().code, 'cli.unsupported');
  const remove = await app.inject({ method: 'DELETE', url: '/api/system/cli-version/install', headers: { authorization: `Bearer ${token}` } });
  assert.equal(remove.statusCode, 409);
  assert.equal(remove.json().code, 'cli.not-installed');
});

test('a restart over live work answers 409 with the counts, for the busy dialog', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  const token = await withToken(app);
  core.serverUpdates.apply = async () => {
    throw new ServerUpdateRefusal(409, 'update.live-work', 'busy', { working: 1, waiting: 0, running: 2 });
  };
  const res = await app.inject({ method: 'POST', url: '/api/system/server-update/apply', ...json({}, token) });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'busy', code: 'update.live-work', live: { working: 1, waiting: 0, running: 2 } });
});

test('read-only refuses every change before the route runs', async (t) => {
  const { app, core } = await wrapper({ CLAUDIO_AUTH_TOKEN: 'a-token-from-a-secret', CLAUDIO_READ_ONLY: '1' });
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  for (const [method, url] of CHANGES) {
    assert.equal((await app.inject({ method, url, ...json({}, 'a-token-from-a-secret') })).statusCode, 405, `${method} ${url}`);
  }
});

test('only a token or OIDC actor is the owner', () => {
  for (const actor of ['token:env', 'token:first-run', 'oidc:someone@example.com']) assert.equal(isOwnerActor(actor), true, actor);
  for (const actor of [null, 'local', 'desktop', 'anonymous', 'webhook', 'chat:abc']) assert.equal(isOwnerActor(actor), false, String(actor));
});
