import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ReadyStatus, SystemInfo } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { HEADLESS_ROUTES, servedInHeadless } from '../src/headless.ts';
import { isSingleLabel } from '../src/security.ts';
import { startServer } from '../src/server.ts';
import { signInDefault } from './helpers.ts';

const TOKEN = 'headless-test-token';

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  root: string;
  /** Every route as its plugin registered it, before the profile judged it */
  routes: Array<{ method: string; url: string }>;
}

const roots = new Set<string>();
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function wrapper(env: NodeJS.ProcessEnv = {}): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-headless-'));
  roots.add(root);
  // A built UI on disk, so a profile that served it would show
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'index.html'), '<!doctype html><title>Claudio</title>');
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
      CLAUDIO_PROFILE: 'headless',
      CLAUDIO_AUTH_MODE: 'token',
      CLAUDIO_AUTH_TOKEN: TOKEN,
      ...env,
    }),
  );
  const routes: Wrapper['routes'] = [];
  const onRoute = (route: RouteOptions) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.push({ method, url: route.url });
  };
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'web'), onRoute });
  return { app, core, root, routes };
}

const auth = { authorization: `Bearer ${TOKEN}` };
/** A path that matches a registered url, its parameters filled in */
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, 'x').replace(/\*$/, 'x');

test('every route a headless Claudio registers is in the allowlist or answers 404 route not found', async (t) => {
  const { app, core, routes } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  const hidden = routes.filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS' && !servedInHeadless(r.method, r.url));
  assert.ok(hidden.length > 300, `only ${hidden.length} routes hidden: the full app registers many more than D1`);
  const leaks: string[] = [];
  for (const route of hidden) {
    const res = await app.inject({ method: route.method as 'GET', url: concrete(route.url), headers: auth });
    if (res.statusCode !== 404 || res.json<{ error?: string }>().error !== 'route not found') leaks.push(`${route.method} ${route.url} → ${res.statusCode}`);
  }
  assert.deepEqual(leaks, []);

  // Each D1 route is really registered
  const registered = new Set(routes.map((r) => `${r.method} ${r.url}`));
  const missing = [...HEADLESS_ROUTES].filter((route) => !registered.has(route));
  assert.deepEqual(missing, []);
});

test('the routes the plan names are refused in headless, and the web UI is not served', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  for (const [method, url] of [
    ['GET', '/api/work-items'],
    ['GET', '/api/terminals'],
    ['PATCH', '/api/chats/abc'],
    ['POST', '/api/chats/abc/resume'],
    ['PUT', '/api/config/tool-presets/abc'],
    ['PUT', '/api/config/tool-presets/default'],
    ['POST', '/api/config/tool-presets/restore'],
    ['DELETE', '/api/config/tool-presets/abc'],
    ['POST', '/api/system/cli-version/install'],
    ['POST', '/api/system/server-update/apply'],
    ['PUT', '/api/security/auth'],
    ['GET', '/api/never-registered'],
    ['GET', '/'],
    ['GET', '/index.html'],
  ] as const) {
    const res = await app.inject({ method, url, headers: { ...auth, 'content-type': 'application/json' }, payload: method === 'GET' ? undefined : '{}' });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: 'route not found' }, `${method} ${url}`);
  }
  // Fastify answers a HEAD with its GET's handler: a hidden GET's HEAD is hidden too
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/work-items', headers: auth })).statusCode, 404);
  // A body the hidden route's parser would refuse never reaches it
  const malformed = await app.inject({ method: 'PATCH', url: '/api/chats/abc', headers: { ...auth, 'content-type': 'application/json' }, payload: '{not json' });
  assert.equal(malformed.statusCode, 404);
});

test('the D1 routes are served in headless, and the system says which profile it runs', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  for (const url of ['/api/system', '/api/chats', '/api/providers', '/api/config/tool-presets', '/api/accounts', '/api/accounts/settings', '/api/security/auth', '/api/v1/models', '/openapi.json']) {
    const res = await app.inject({ url, headers: auth });
    assert.equal(res.statusCode, 200, `${url}: ${res.body.slice(0, 200)}`);
  }
  assert.equal((await app.inject({ url: '/api/system', headers: auth })).json<SystemInfo>().profile, 'headless');
  assert.notEqual((await app.inject({ url: '/api/chats/missing', headers: auth })).json<{ error?: string }>().error, 'route not found');
  assert.notEqual((await app.inject({ method: 'DELETE', url: '/api/chats/missing', headers: auth })).json<{ error?: string }>().error, 'route not found');
  // The token still guards what is served
  assert.equal((await app.inject('/api/chats')).statusCode, 401);
});

test('the OpenAPI document of a headless Claudio describes only what it serves', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  const spec = (await app.inject({ url: '/openapi.json', headers: auth })).json<{ paths: Record<string, Record<string, unknown>> }>();
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => ({ method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ':$1') })));
  assert.ok(operations.length >= 20, `only ${operations.length} operations`);
  assert.deepEqual(operations.filter((op) => !servedInHeadless(op.method, op.url)), []);
  assert.equal(spec.paths['/api/work-items'], undefined);
  assert.ok(spec.paths['/api/ready']?.get, 'readiness is documented');
});

test('the app profile still serves every route and the web UI, and says full', async (t) => {
  const { app, core } = await wrapper({ CLAUDIO_PROFILE: 'full' });
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  assert.equal((await app.inject({ url: '/api/work-items?projectId=none', headers: auth })).json<{ error?: string }>().error === 'route not found', false);
  assert.equal((await app.inject({ url: '/api/system', headers: auth })).json<SystemInfo>().profile, 'full');
  const ui = await app.inject('/');
  assert.equal(ui.statusCode, 200);
  assert.match(ui.body, /<title>Claudio<\/title>/);
});

test('a single-label Host such as a compose service name reaches a headless Claudio, and only that one', async (t) => {
  const headless = await wrapper();
  const full = await wrapper({ CLAUDIO_PROFILE: 'full' });
  t.after(async () => {
    await headless.app.close();
    await full.app.close();
    await headless.core.shutdown();
    await full.core.shutdown();
  });
  const ask = (w: Wrapper, host: string) => w.app.inject({ url: '/api/system', headers: { ...auth, host } });
  assert.equal((await ask(headless, 'claudio:8797')).statusCode, 200);
  assert.equal((await ask(headless, 'claudio')).statusCode, 200);
  assert.equal((await ask(full, 'claudio:8797')).statusCode, 421);
  // A name with a dot is one a stranger's resolver may answer for, and an address is not a name
  assert.equal((await ask(headless, 'claudio.attacker.example')).statusCode, 421);
  assert.equal((await ask(headless, '2130706433')).statusCode, 421);
  assert.equal((await ask(headless, '10.0.0.5')).statusCode, 421);
  assert.equal(isSingleLabel('my-app'), true);
  assert.equal(isSingleLabel('0x7f000001'), false);
  assert.equal(isSingleLabel('-bad'), false);
});

test('readiness answers without a credential: starting, then the CLI missing, then each sign-in state', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  const ready = async (): Promise<{ status: number; body: ReadyStatus }> => {
    const res = await app.inject('/api/ready');
    return { status: res.statusCode, body: res.json<ReadyStatus>() };
  };
  // The detector's and the accounts' last readings are what it reads; the start-up's own reads
  // race the first request, so the states before and after them are stood in where they would
  const detector = { knownOne: core.providers.knownOne.bind(core.providers) };
  // Nothing detected yet: not a failure, and nothing is spawned to find out
  Object.assign(core.providers, { knownOne: () => null });
  assert.deepEqual(await ready(), { status: 503, body: { ready: false, reason: 'starting' } });
  Object.assign(core.providers, detector);
  await core.providers.refresh();
  assert.deepEqual(await ready(), { status: 503, body: { ready: false, reason: 'cli-missing' } });

  const installed = { ...core.providers.knownOne('claude-code'), binaryPath: '/usr/bin/claude', version: '2.1.300' };
  Object.assign(core.providers, { knownOne: () => installed, knownSignedIn: () => false });
  assert.deepEqual(await ready(), { status: 503, body: { ready: false, reason: 'signed-out' } });
  // A sign-in state is an account's: the CLI's own login is one once it has a credential (§2.9)
  signInDefault(core.config.configDir);
  const account = core.accounts.list()[0];
  assert.ok(account, 'the CLI login is listed');
  Object.assign(core.accounts, { list: () => [{ ...account, enabled: true, signedIn: true, signInState: 'expired' }] });
  assert.deepEqual(await ready(), { status: 503, body: { ready: false, reason: 'sign-in-expired' } });
  Object.assign(core.providers, { knownSignedIn: () => true });
  assert.deepEqual(await ready(), { status: 200, body: { ready: true } });

  // Liveness is unchanged, and still open
  const health = await app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(Object.keys(health.json()).sort(), ['cli', 'loggedIn', 'ok']);
});

/** Runs `startServer` with this environment and restores `process.env` after */
async function withEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a headless server does not start without a spend cap or in a mode but dontAsk, and starts with both', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-headless-start-'));
  roots.add(root);
  const base = {
    CLAUDE_BIN: '/nonexistent/claude',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
    CLAUDIO_PROFILE: 'headless',
    CLAUDIO_AUTH_MODE: 'token',
    CLAUDIO_AUTH_TOKEN: TOKEN,
    CLAUDIO_TUNNEL: 'off',
    CLAUDIO_DAILY_SPEND_CAP_USD: undefined,
    CLAUDIO_DEFAULT_PERMISSION_MODE: 'dontAsk',
    CLAUDIO_WEB_DIST: undefined,
    CLAUDIO_API_URL: undefined,
    CLAUDIO_API_TOKEN: undefined,
  };
  await assert.rejects(withEnv(base, () => startServer({ port: 0, portFallback: false })), /CLAUDIO_DAILY_SPEND_CAP_USD is not set/);
  await assert.rejects(
    withEnv({ ...base, CLAUDIO_DAILY_SPEND_CAP_USD: '5', CLAUDIO_DEFAULT_PERMISSION_MODE: 'bypassPermissions' }, () => startServer({ port: 0, portFallback: false })),
    /runs every chat in 'dontAsk'/,
  );
  // The refused starts let go of the data directory: this one takes it
  const server = await withEnv({ ...base, CLAUDIO_DAILY_SPEND_CAP_USD: '5' }, () => startServer({ port: 0, portFallback: false }));
  try {
    const res = await fetch(`${server.url}/api/system`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as SystemInfo).profile, 'headless');
    assert.equal((await fetch(`${server.url}/api/ready`)).status, 503);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(join(root, 'data')), true);
});

test('over the daily spend cap a headless /v1 call is a 429 with Retry-After, on both endpoints (D13)', async (t) => {
  const { app, core } = await wrapper({ CLAUDIO_DAILY_SPEND_CAP_USD: '1' });
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  core.db.addSpend({ at: new Date().toISOString(), chatId: 'seed', executionId: 'seed', usd: 5, reported: true, purpose: 'flow', account: null, accountKind: null, projectId: null, orchestrationId: null });
  for (const [url, payload] of [
    ['/api/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }],
    ['/api/v1/responses', { model: 'sonnet', input: 'x' }],
  ] as const) {
    const res = await app.inject({ method: 'POST', url, headers: { ...auth, 'content-type': 'application/json' }, payload });
    assert.equal(res.statusCode, 429, `${url}: ${res.body.slice(0, 200)}`);
    assert.ok(Number(res.headers['retry-after']) >= 1, url);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'rate_limit_exceeded', url);
  }
});
