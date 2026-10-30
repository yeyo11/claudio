import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ChatSummary, ProviderMove, ProviderStatus } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { signInDefault } from './helpers.ts';

// What happens at a usage limit, over HTTP: a chat on the fake Claude that dies against its limit
// (`FAKE-LIMIT-REPORTED-ONCE`: the CLI's rejected report, then its 429; the 429 alone records no
// limit) and the routes a person's click calls: a wait, and cancelling it.
const FIXTURES = fileURLToPath(new URL('../../../packages/core/test/fixtures/', import.meta.url));
const FAKE_CLAUDE = `${FIXTURES}fake-claude.mjs`;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;
let repo: string;

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ready()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A chat whose first turn dies against the provider's usage limit, reported as the CLI reports it. */
async function chatAtLimit(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'FAKE-LIMIT-REPORTED-ONCE', cwd: repo }) });
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json<ChatSummary>();
  await until('the chat to reach its limit', () => core.runtime.atLimit(id));
  return id;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-rotation-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

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
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/providers/settings',
    ...json({ rotation: { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 1 } } }),
  });
  assert.equal(saved.statusCode, 200, saved.body);
});

after(async () => {
  await app.close();
  core.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('a chat that does not exist cannot wait', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/wait' })).statusCode, 404);
  assert.equal((await app.inject('/api/providers/candidates')).statusCode, 404);
  assert.equal((await app.inject('/api/chats/nope/handoff')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chats/nope/move', ...json({}) })).statusCode, 404);
  assert.equal((await app.inject('/api/providers/moves')).statusCode, 404);
});

test("a provider's status carries its limit once a chat reached it: what the chat banner and the limit bars read", async () => {
  await chatAtLimit();
  const status = (await app.inject('/api/providers/claude-code')).json<ProviderStatus>();
  assert.equal(status.limit?.state, 'exhausted', JSON.stringify(status));
  const listed = (await app.inject('/api/providers')).json<ProviderStatus[]>().find((s) => s.id === 'claude-code');
  assert.equal(listed?.limit?.state, 'exhausted');
});

test('the wait list validates its filters before anything happens', async () => {
  assert.equal((await app.inject('/api/limits/waits?state=nope')).statusCode, 400);
  assert.equal((await app.inject('/api/limits/waits?limit=0')).statusCode, 400);
});

test('waiting is the person\'s click: a wait row opens, a second is refused, and cancelling closes it', async () => {
  const id = await chatAtLimit();
  const wait = await app.inject({ method: 'POST', url: `/api/chats/${id}/wait` });
  assert.equal(wait.statusCode, 201, wait.body);
  const move = wait.json<ProviderMove>();
  assert.deepEqual([move.state, move.action, move.fromChat, move.decidedBy], ['waiting', 'wait', id, 'person']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/chats/${id}/wait` })).statusCode, 409);

  const open = (await app.inject(`/api/limits/waits?chatId=${id}&state=waiting`)).json<ProviderMove[]>();
  assert.deepEqual(open.map((m) => m.id), [move.id]);

  const cancelled = await app.inject({ method: 'POST', url: `/api/limits/waits/${move.id}/cancel` });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<ProviderMove>().state, 'cancelled');
  assert.equal((await app.inject({ method: 'POST', url: `/api/limits/waits/${move.id}/cancel` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/limits/waits/nope/cancel' })).statusCode, 404);
  assert.deepEqual((await app.inject(`/api/limits/waits?chatId=${id}&state=waiting`)).json(), []);
});

test('run now is refused with its code while every account reads out, and once the wait is over (R11)', async () => {
  // The CLI's report says the only account is out for an hour: there is no account to run on now.
  // That a wait with an account that has room goes on at once is core's test (accounts-rotation)
  const id = await chatAtLimit();
  const move = (await app.inject({ method: 'POST', url: `/api/chats/${id}/wait` })).json<ProviderMove>();
  const refused = await app.inject({ method: 'POST', url: `/api/limits/waits/${move.id}/run-now` });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json<{ code?: string }>().code, 'no-room');
  assert.match(refused.json<{ error: string }>().error, /until/);
  assert.equal(core.db.providerMove(move.id)?.state, 'waiting', 'the wait stays');

  assert.equal((await app.inject({ method: 'POST', url: `/api/limits/waits/${move.id}/cancel` })).statusCode, 200);
  const over = await app.inject({ method: 'POST', url: `/api/limits/waits/${move.id}/run-now` });
  assert.equal(over.statusCode, 409);
  assert.equal(over.json<{ code?: string }>().code, 'wait-over');
  assert.equal((await app.inject({ method: 'POST', url: '/api/limits/waits/nope/run-now' })).statusCode, 404);
});

test("the removed routes are gone, and a chat's token cannot wait, cancel a wait or run it now", async () => {
  for (const url of ['/api/accounts/usage', '/api/providers/candidates', '/api/providers/moves', '/api/providers/model-map/suggestions', '/api/providers/cswap-retirement']) assert.equal((await app.inject(url)).statusCode, 404, url);

  const id = await chatAtLimit();
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token } = created.json<{ token: string }>();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  try {
    const chat = core.security.chatTokens.mint(id);
    const fromChat = (method: string, url: string, body?: unknown) => ({
      method: method as 'GET',
      url,
      remoteAddress: '127.0.0.1',
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${chat}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    const before = core.db.providerMoves().length;
    for (const [method, url, body] of [
      ['POST', `/api/chats/${id}/wait`, undefined],
      ['POST', '/api/limits/waits/some/cancel', undefined],
      ['POST', '/api/limits/waits/some/run-now', undefined],
    ] as const) {
      assert.equal((await app.inject(fromChat(method, url, body))).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(core.db.providerMoves().length, before, 'nothing moved or waited');
    // Nor can it decide through its project what a limit does: a project's settings are the person's
    const owner = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const imported = await app.inject({ method: 'POST', url: '/api/projects/import', headers: owner, payload: JSON.stringify({ path: repo, name: 'rotation' }) });
    assert.ok(imported.statusCode < 300, imported.body);
    const project = imported.json<{ id: string }>().id;
    const kept = { onLimit: { action: 'wait', allowed: ['wait'] } };
    const current = (await app.inject({ url: `/api/projects/${project}/settings`, headers: owner })).json<Record<string, unknown>>();
    assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project}/settings`, headers: owner, payload: JSON.stringify({ ...current, providers: kept }) })).statusCode, 200);
    const widened = { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 99 } };
    assert.equal((await app.inject(fromChat('PUT', `/api/projects/${project}/settings`, { ...current, providers: widened }))).statusCode, 403);
    assert.deepEqual((await app.inject({ url: `/api/projects/${project}/settings`, headers: { authorization: `Bearer ${token}` } })).json<{ providers?: unknown }>().providers, kept);
    // What it may read: the candidates, the preview's refusal and the history
    assert.equal((await app.inject(fromChat('GET', '/api/limits/waits'))).statusCode, 200);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ mode: 'none' }) });
  }
});

test('the routes of a limit are documented with a summary and a tag', async () => {
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  for (const [method, path, tag] of [
    ['post', '/api/chats/{id}/wait', 'Chats'],
    ['get', '/api/limits/waits', 'Providers'],
    ['post', '/api/limits/waits/{id}/cancel', 'Providers'],
    ['post', '/api/limits/waits/{id}/run-now', 'Providers'],
  ] as const) {
    const op = spec.paths[path]?.[method];
    assert.ok(op?.summary, `${method} ${path} has no summary`);
    assert.deepEqual(op.tags, [tag], `${method} ${path}`);
  }
});
