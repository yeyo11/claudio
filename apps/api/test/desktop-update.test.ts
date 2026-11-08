import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Core, DesktopUpdateRefusal, loadConfig } from '@claudio/core';
import type { DesktopUpdateStatus, RestartRequest } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { isOwnerActor } from '../src/security.ts';

// docs/plans/remote-updates.md, D3, D4, D8: the desktop app's package update and its restart, from
// any device, for the owner's actors alone. Nothing here reaches systemctl: outside a `.deb` desktop
// app the module never runs it, and where a test needs another answer the module's method is replaced.

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const json = (body: unknown, token?: string) => ({
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

async function wrapper(env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-desktop-update-api-'));
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

const WRITES = [
  ['POST', '/api/system/desktop-update'],
  ['POST', '/api/system/restart'],
] as const;

const DESKTOP_SECRET = 'a-per-launch-secret-of-32-random-bytes';
const fromShell = (method: InjectOptions['method']): InjectOptions => ({
  method,
  remoteAddress: '127.0.0.1',
  payload: '{}',
  headers: { host: '127.0.0.1:43123', 'content-type': 'application/json', authorization: `Bearer ${DESKTOP_SECRET}` },
});

const STATUS: DesktopUpdateStatus = { state: 'installing', installed: '0.14.2', running: '0.14.2', from: null, to: null, startedAt: '2026-11-08T12:00:00.000Z', endedAt: null, restartNeeded: false };

test('the status answers unavailable outside a .deb desktop app, with the running version', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await core.shutdown();
    await app.close();
  });
  const res = await app.inject('/api/system/desktop-update');
  assert.equal(res.statusCode, 200);
  const status = res.json() as DesktopUpdateStatus;
  assert.equal(status.state, 'unavailable');
  assert.deepEqual(status.reason, { code: 'update.unit-missing' });
  assert.equal(status.running, core.version);
  assert.equal(status.restartNeeded, false);
});

test("the owner's token starts the update and asks the restart; the module's refusals keep their codes", async (t) => {
  launcher(t, undefined);
  const { app, core } = await wrapper();
  t.after(async () => {
    await core.shutdown();
    await app.close();
  });
  const token = await withToken(app);
  // Without the unit and without a desktop shell, the module's own answers
  const start = await app.inject({ method: 'POST', url: '/api/system/desktop-update', ...json({}, token) });
  assert.equal(start.statusCode, 412);
  assert.equal(start.json().code, 'update.unit-missing');
  const restart = await app.inject({ method: 'POST', url: '/api/system/restart', ...json({}, token) });
  assert.equal(restart.statusCode, 412);
  assert.equal(restart.json().code, 'update.no-shell');

  core.desktopUpdates.start = async () => STATUS;
  const started = await app.inject({ method: 'POST', url: '/api/system/desktop-update', ...json({}, token) });
  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.json(), STATUS);
  core.desktopUpdates.start = async () => {
    throw new DesktopUpdateRefusal(403, 'update.needs-login', 'refused');
  };
  const login = await app.inject({ method: 'POST', url: '/api/system/desktop-update', ...json({}, token) });
  assert.deepEqual([login.statusCode, login.json()], [403, { error: 'refused', code: 'update.needs-login' }]);

  // The write is in the audit, as every write is
  const audit = core.db.auditPage({ path: '/api/system/desktop-update' }).entries[0];
  assert.ok(audit?.actor.startsWith('token:'), JSON.stringify(audit));
});

test('a restart over live work is 409 with the counts; whenIdle reaches the module only as a true boolean', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await core.shutdown();
    await app.close();
  });
  const token = await withToken(app);
  const asked: RestartRequest[] = [];
  core.desktopUpdates.restart = async (request = {}) => {
    asked.push(request);
    if (!request.whenIdle) throw new DesktopUpdateRefusal(409, 'update.live-work', 'busy', { working: 1, waiting: 0, running: 0, terminals: 2 });
    return { scheduled: 'when-idle' };
  };
  const busy = await app.inject({ method: 'POST', url: '/api/system/restart', ...json({}, token) });
  assert.equal(busy.statusCode, 409);
  assert.deepEqual(busy.json(), { error: 'busy', code: 'update.live-work', live: { working: 1, waiting: 0, running: 0, terminals: 2 } });
  const later = await app.inject({ method: 'POST', url: '/api/system/restart', ...json({ whenIdle: true }, token) });
  assert.equal(later.statusCode, 202);
  assert.deepEqual(later.json(), { scheduled: 'when-idle' });
  await app.inject({ method: 'POST', url: '/api/system/restart', ...json({ whenIdle: 'yes' }, token) });
  assert.deepEqual(asked, [{ whenIdle: false }, { whenIdle: true }, { whenIdle: false }]);
});

test("a chat's token is refused on the reads and the writes", async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await core.shutdown();
    await app.close();
  });
  await withToken(app);
  let called = 0;
  core.desktopUpdates.start = async () => {
    called += 1;
    return STATUS;
  };
  core.desktopUpdates.restart = async () => {
    called += 1;
    return { scheduled: 'now' };
  };
  const chat = core.security.chatTokens.mint('chat-42');
  const headers = { host: '127.0.0.1:34331', authorization: `Bearer ${chat}` };
  for (const [method, url] of [['GET', '/api/system/desktop-update'], ...WRITES] as const) {
    const options: InjectOptions =
      method === 'GET' ? { method, url, remoteAddress: '127.0.0.1', headers } : { method, url, remoteAddress: '127.0.0.1', payload: '{}', headers: { ...headers, 'content-type': 'application/json' } };
    assert.equal((await app.inject(options)).statusCode, 403, `${method} ${url}`);
  }
  assert.equal(called, 0);
});

test("the desktop shell's own credential opens neither new write, under auth none or a token (D8)", async (t) => {
  launcher(t, 'desktop');
  const { app, core } = await wrapper({ CLAUDIO_DESKTOP_TOKEN: DESKTOP_SECRET, CLAUDIO_DISTRIBUTION: 'deb' });
  t.after(async () => {
    await core.shutdown();
    await app.close();
  });
  let called = 0;
  core.desktopUpdates.start = async () => {
    called += 1;
    return STATUS;
  };
  core.desktopUpdates.restart = async () => {
    called += 1;
    return { scheduled: 'now' };
  };
  assert.equal(core.security.mode, 'none');
  for (const [method, url] of WRITES) {
    const res = await app.inject({ ...fromShell(method), url });
    assert.equal(res.statusCode, 403, `none: ${method} ${url}`);
    assert.equal(res.json().code, 'update.needs-auth', `none: ${method} ${url}`);
  }
  // And nobody on this machine without a token, either: `local` is not the owner
  for (const [method, url] of WRITES) {
    assert.equal((await app.inject({ method, url, ...json({}) })).json().code, 'update.needs-auth', `local: ${method} ${url}`);
  }
  await withToken(app);
  for (const [method, url] of WRITES) {
    const res = await app.inject({ ...fromShell(method), url });
    assert.equal(res.statusCode, 403, `token: ${method} ${url}`);
    assert.match(res.json().error, /only reads/, `token: ${method} ${url}`);
  }
  assert.equal(called, 0);
  // Its four payload writes are as they were: still let through to the module
  const download = await app.inject({ ...fromShell('POST'), url: '/api/system/server-update/download' });
  assert.notEqual(download.statusCode, 403, download.body);
});

test("the owner's actors include a hub's server:* actor, so a hub can update and restart a remote", () => {
  assert.equal(isOwnerActor('server:hub-1'), true);
  assert.equal(isOwnerActor('desktop'), false);
});
