import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, ServerUpdateRefusal, loadConfig } from '@claudio/core';
import type { ServerUpdateStatus } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { isOwnerActor } from '../src/security.ts';

const json = (body: unknown, token?: string) => ({
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function wrapper(env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-server-update-api-'));
  roots.push(root);
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
    throw new ServerUpdateRefusal(409, 'update.live-work', 'busy', { working: 1, waiting: 0, running: 2, terminals: 1 });
  };
  const res = await app.inject({ method: 'POST', url: '/api/system/server-update/apply', ...json({}, token) });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'busy', code: 'update.live-work', live: { working: 1, waiting: 0, running: 2, terminals: 1 } });
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

const DESKTOP_SECRET = 'a-per-launch-secret-of-32-random-bytes';
const UPDATE_WRITES = CHANGES.filter(([, url]) => url.includes('server-update'));
const fromShell = (secret = DESKTOP_SECRET, remoteAddress = '127.0.0.1') => ({
  remoteAddress,
  payload: '{}',
  headers: { host: '127.0.0.1:43123', 'content-type': 'application/json', authorization: `Bearer ${secret}` },
});

/** `CLAUDIO_LAUNCHER` is read live from the process environment, as the server reads it */
function launcher(t: { after: (fn: () => void) => void }, value: string | undefined): void {
  const before = process.env.CLAUDIO_LAUNCHER;
  if (value === undefined) delete process.env.CLAUDIO_LAUNCHER;
  else process.env.CLAUDIO_LAUNCHER = value;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDIO_LAUNCHER;
    else process.env.CLAUDIO_LAUNCHER = before;
  });
}

test("under auth none the desktop shell's own credential makes the four update writes where it supervises the server", async (t) => {
  launcher(t, 'desktop');
  const { app, core } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET, CLAUDIO_DISTRIBUTION: 'deb' });
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  assert.equal(core.security.mode, 'none');
  for (const [method, url] of UPDATE_WRITES) {
    const res = await app.inject({ method, url, ...fromShell() });
    // Past the owner check and judged as the shell: what stops it now is the host (no keys here), never auth
    assert.notEqual(res.json().code, 'update.needs-auth', `${method} ${url}: ${res.body}`);
    assert.notEqual(res.statusCode, 403, `${method} ${url}`);
  }
  const audit = core.db.auditPage({ path: '/api/system/server-update/download' }).entries[0];
  assert.equal(audit?.actor, 'desktop');

  // Anyone else on this machine stays `local`, and `local` may not restart the server over live work
  for (const options of [{ ...json({}) }, fromShell(`${DESKTOP_SECRET}x`), fromShell('not-the-secret-at-all-not-at-all')]) {
    for (const [method, url] of UPDATE_WRITES) {
      const res = await app.inject({ method, url, ...options });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(res.json().code, 'update.needs-auth', `${method} ${url}`);
    }
  }
  // The secret from another machine is no secret
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/server-update/download', ...fromShell(DESKTOP_SECRET, '10.0.0.5') })).json().code, 'update.needs-auth');
  // And it opens nothing but these four
  const cli = await app.inject({ method: 'POST', url: '/api/system/cli-version/install', ...fromShell() });
  assert.equal(cli.json().code, 'cli.needs-auth');
});

test('without CLAUDIO_LAUNCHER=desktop the desktop credential opens no update write, under any mode', async (t) => {
  launcher(t, undefined);
  const { app, core } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET, CLAUDIO_DISTRIBUTION: 'deb' });
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  for (const [method, url] of UPDATE_WRITES) {
    assert.equal((await app.inject({ method, url, ...fromShell() })).json().code, 'update.needs-auth', `none: ${method} ${url}`);
  }
  await withToken(app);
  for (const [method, url] of UPDATE_WRITES) {
    const res = await app.inject({ method, url, ...fromShell() });
    assert.equal(res.statusCode, 403, `token: ${method} ${url}`);
    assert.match(res.json().error, /only reads/, `token: ${method} ${url}`);
  }
});

test('under a token the shell makes the update writes too, still nothing else, and a chat token never', async (t) => {
  launcher(t, 'desktop');
  const { app, core } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET, CLAUDIO_DISTRIBUTION: 'deb' });
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  await withToken(app);
  for (const [method, url] of UPDATE_WRITES) {
    const res = await app.inject({ method, url, ...fromShell() });
    assert.notEqual(res.statusCode, 403, `${method} ${url}: ${res.body}`);
  }
  const layout = await app.inject({ method: 'DELETE', url: '/api/dashboard/layout', ...fromShell() });
  assert.equal(layout.statusCode, 403);
  assert.match(layout.json().error, /only reads/);
  const chat = core.security.chatTokens.mint('chat-42');
  for (const [method, url] of UPDATE_WRITES) {
    assert.equal((await app.inject({ method, url, ...json({}, chat) })).statusCode, 403, `chat: ${method} ${url}`);
  }
});

test('the status answers the desktop facts: base, shell, needsShell and the offer', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    core.shutdown();
    await app.close();
  });
  const status = (await app.inject('/api/system/server-update')).json() as ServerUpdateStatus;
  assert.equal(status.base, 'image');
  assert.equal(status.shell, null);
  assert.equal(status.needsShell, null);
  assert.equal(status.offer, null);
});

test('only a token or OIDC actor is the owner', () => {
  for (const actor of ['token:env', 'token:first-run', 'oidc:someone@example.com']) assert.equal(isOwnerActor(actor), true, actor);
  for (const actor of [null, 'local', 'desktop', 'anonymous', 'webhook', 'chat:abc']) assert.equal(isOwnerActor(actor), false, String(actor));
});
