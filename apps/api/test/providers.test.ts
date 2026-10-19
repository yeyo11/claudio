import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ModelOption, ProviderStatus, ProvidersSettings } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The providers over HTTP. Nothing real is needed: the routes are exercised against whatever this
// host has, and only what holds on any host is asserted.
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-providers-'));
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
  core.shutdown();
});

test('Claude Code is listed with a status, and one by id', async () => {
  const all = (await app.inject('/api/providers')).json<ProviderStatus[]>();
  assert.deepEqual(all.map((s) => s.id), ['claude-code']);
  const one = await app.inject('/api/providers/claude-code');
  assert.equal(one.statusCode, 200);
  assert.equal(one.json<ProviderStatus>().id, 'claude-code');
  assert.equal((await app.inject('/api/providers/codex')).statusCode, 404);
  assert.equal((await app.inject('/api/providers/nope')).statusCode, 404);
});

test('settings read as the defaults until the first save, then persist in providers.json', async () => {
  const defaults = (await app.inject('/api/providers/settings')).json<ProvidersSettings>();
  assert.equal(defaults.defaultProvider, null);
  assert.deepEqual(defaults.order, ['claude-code']);
  assert.ok(Object.values(defaults.providers).every((p) => p.binaryPath === null));
  assert.equal(existsSync(join(root, 'data', 'providers.json')), false);

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/providers/settings',
    ...json({ providers: { 'claude-code': { enabled: false, binaryPath: '/opt/claude' } }, defaultProvider: 'claude-code' }),
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json<ProvidersSettings>();
  assert.deepEqual(body.providers['claude-code'], { enabled: false, binaryPath: '/opt/claude' });
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'providers.json'), 'utf8')).defaultProvider, 'claude-code');
  assert.deepEqual((await app.inject('/api/providers/settings')).json(), body);

  // A disabled provider is not probed
  const refreshed = (await app.inject({ method: 'POST', url: '/api/providers/refresh' })).json<ProviderStatus[]>();
  assert.equal(refreshed.find((s) => s.id === 'claude-code')?.reason, 'disabled');
});

test('settings that name an unknown provider, or a relative binary, are refused and change nothing', async () => {
  const before = (await app.inject('/api/providers/settings')).json();
  for (const bad of [
    { providers: { nope: { enabled: true } } },
    { providers: { 'claude-code': { binaryPath: 'claude' } } },
    { providers: { 'claude-code': { enabled: 'yes' } } },
    { order: ['claude-code', 'claude-code'] },
    { providers: { codex: { enabled: true } } },
    { order: ['codex'] },,
    { order: ['nope'] },
    { defaultProvider: 'nope' },
    [],
  ]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/providers/settings', ...json(bad) })).statusCode, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await app.inject('/api/providers/settings')).json(), before);
});

test('the rotation block is saved whole, read back and refused when out of range', async () => {
  const rotation = { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 12 } };
  const saved = await app.inject({ method: 'PUT', url: '/api/providers/settings', ...json({ rotation }) });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json<ProvidersSettings>().rotation, rotation);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'providers.json'), 'utf8')).rotation, rotation);
  assert.deepEqual((await app.inject('/api/providers/settings')).json<ProvidersSettings>().rotation, rotation);
  const bad = await app.inject({ method: 'PUT', url: '/api/providers/settings', ...json({ rotation: { onLimit: { maxWaitHours: 99 } } }) });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual((await app.inject('/api/providers/settings')).json<ProvidersSettings>().rotation, rotation);
  await app.inject({ method: 'PUT', url: '/api/providers/settings', ...json({}) });
});

test("a chat's token can read the providers but not change the settings or force a detection", async () => {
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
    const stored = readFileSync(join(root, 'data', 'providers.json'), 'utf8');
    for (const [method, url, body] of [
      ['PUT', '/api/providers/settings', { defaultProvider: 'claude-code' }],
      ['POST', '/api/providers/refresh', undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(readFileSync(join(root, 'data', 'providers.json'), 'utf8'), stored);
    assert.equal((await app.inject(fromChat('GET', '/api/providers'))).statusCode, 200);
    assert.equal((await app.inject(fromChat('GET', '/api/providers/settings'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('every provider route is documented with a summary and the Providers tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const routes = Object.entries(spec.paths).filter(([path]) => path === '/api/providers' || path.startsWith('/api/providers/'));
  // Detection and settings (six), the models of a driver
  assert.equal(routes.reduce((n, [, methods]) => n + Object.keys(methods).length, 0), 6);
  for (const [path, methods] of routes) {
    for (const [method, op] of Object.entries(methods)) {
      assert.ok(op.summary, `${method} ${path} has no summary`);
      assert.deepEqual(op.tags, ['Providers'], `${method} ${path}`);
    }
  }
});

test('a provider\'s catalog is the CLI\'s own list, empty rather than guessed with no CLI to read, and one with no driver is 404', async () => {
  // This host's CLI is a path that does not exist: its `initialize` list can never be read
  const models = (await app.inject('/api/providers/claude-code/models')).json<ModelOption[]>();
  assert.deepEqual(models, []);
  assert.equal((await app.inject('/api/providers/nope/models')).statusCode, 404);
});
