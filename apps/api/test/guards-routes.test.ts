import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ClaudioEvent, GuardCheckResult, GuardEventPage, GuardSettingsView } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The guard routes (docs/plans/guards.md, API): settings, the events trail and the check endpoint,
// with the 400s, the chat-token 403s and read-only mode's 405.

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  root: string;
}

async function wrapper(t: { after: (fn: () => unknown) => void }): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-guards-routes-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  t.after(async () => {
    core.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, core, root };
}

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const fromChat = (token: string) => ({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } });
const fromChatWith = (token: string, body: unknown) => ({
  remoteAddress: '127.0.0.1',
  payload: JSON.stringify(body),
  headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

let calls = 0;
const seed = (core: Core, chatId: string, extra: { orchestrationId?: string } = {}) =>
  core.guardEvents.insert({ chatId, toolName: 'Bash', rule: 'push', matcher: 'push.git-verb', outcome: 'blocked', reason: 'no pushing', excerpt: 'git push', toolUseId: `tu-${(calls += 1)}`, ...extra });

test('GET and PUT /settings/guards read, merge, and emit guards.changed', async (t) => {
  const { app, core } = await wrapper(t);
  const seen: ClaudioEvent[] = [];
  const stop = core.events.subscribe((event) => seen.push(event));
  t.after(stop);
  const first = (await app.inject('/api/settings/guards')).json<GuardSettingsView>();
  assert.equal(first.settings.rules.push, true);
  assert.equal(first.settings.rules['protect-configs'], false);
  assert.deepEqual(first.rules.map((rule) => rule.id), ['integrity', 'no-verify', 'push', 'destructive', 'secrets', 'protect-configs']);
  assert.equal(first.status.available, true);

  const put = await app.inject({ method: 'PUT', url: '/api/settings/guards', ...json({ mode: 'observe', rules: { push: false } }) });
  assert.equal(put.statusCode, 200, put.body);
  const view = put.json<GuardSettingsView>();
  assert.equal(view.settings.mode, 'observe');
  assert.equal(view.settings.rules.push, false);
  assert.equal(view.settings.rules.destructive, true, 'rules merge over the stored ones');
  assert.ok(seen.some((event) => event.type === 'guards.changed'), 'guards.changed was emitted');
});

test('PUT /settings/guards answers 400 for a body the store refuses', async (t) => {
  const { app, root } = await wrapper(t);
  const put = (body: unknown) => app.inject({ method: 'PUT', url: '/api/settings/guards', ...json(body) });
  assert.equal((await put({ nope: true })).statusCode, 400);
  assert.equal((await put({ automated: 'yes' })).statusCode, 400);
  assert.equal((await put({ mode: 'loud' })).statusCode, 400);
  assert.equal((await put({ rules: { integrity: false } })).statusCode, 400);
  assert.equal((await put({ protectConfigs: Array.from({ length: 201 }, (_, i) => `f${i}`) })).statusCode, 400);
  assert.equal((await put({ protectConfigs: ['/etc/passwd'] })).statusCode, 400);
  assert.equal((await put({ protectConfigs: ['../x'] })).statusCode, 400);
  assert.equal((await put({ extraRoots: ['relative'] })).statusCode, 400);
  assert.equal((await put({ extraRoots: ['/'] })).statusCode, 400);
  assert.equal((await put({ extraRoots: [join(root, 'missing')] })).statusCode, 400);
  assert.equal((await put({ extraRoots: [join(root, 'data')] })).statusCode, 400, 'the data dir is no root');
  assert.equal((await put({ extraRoots: [root] })).statusCode, 200);
});

test("a chat's token reads the guard settings but cannot change them or call /guards/check", async (t) => {
  const { app, core } = await wrapper(t);
  const token = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ url: '/api/settings/guards', ...fromChat(token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/guards', ...fromChatWith(token, { rules: { push: false } }) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guards/check', ...fromChatWith(token, { tool: 'Bash', input: { command: 'ls' } }) })).statusCode, 403);
  assert.equal(core.guards.get().rules.push, true, 'nothing changed');
});

test("under token auth the same two routes are forbidden to a chat's token", async (t) => {
  const { app, core } = await wrapper(t);
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token: owner } = created.json<{ token: string }>();
  const person = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${owner}` } };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...person, payload: JSON.stringify({ mode: 'token' }) })).statusCode, 200);
  const chat = core.security.chatTokens.mint('chat-42');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/guards', ...fromChatWith(chat, { mode: 'observe' }) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/guards/check', ...fromChatWith(chat, { tool: 'Bash', input: { command: 'ls' } }) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/guards', ...person, payload: JSON.stringify({ mode: 'observe' }) })).statusCode, 200);
});

test('read-only mode refuses PUT /settings/guards with 405', async (t) => {
  const { app } = await wrapper(t);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/guards', ...json({ mode: 'observe' }) })).statusCode, 405);
  assert.equal((await app.inject('/api/settings/guards')).statusCode, 200);
});

test('GET /guard-events filters, pages, and limits a chat token to its own chat', async (t) => {
  const { app, core } = await wrapper(t);
  for (let i = 0; i < 3; i += 1) seed(core, 'chat-42');
  seed(core, 'chat-43', { orchestrationId: 'orch-1' });

  const all = (await app.inject('/api/guard-events')).json<GuardEventPage>();
  assert.equal(all.events.length, 4);
  assert.ok(all.events[0] && all.events[0].seq > (all.events[1]?.seq ?? 0), 'newest first');
  assert.equal((await app.inject('/api/guard-events?chatId=chat-43')).json<GuardEventPage>().events.length, 1);
  assert.equal((await app.inject('/api/guard-events?orchestrationId=orch-1')).json<GuardEventPage>().events.length, 1);
  assert.equal((await app.inject('/api/guard-events?rule=destructive')).json<GuardEventPage>().events.length, 0);

  const page = (await app.inject('/api/guard-events?limit=2')).json<GuardEventPage>();
  assert.equal(page.events.length, 2);
  assert.notEqual(page.next, null);
  const rest = (await app.inject(`/api/guard-events?limit=2&before=${page.next}`)).json<GuardEventPage>();
  assert.equal(rest.events.length, 2);
  assert.equal(rest.next, null);

  for (const bad of ['limit=0', 'limit=201', 'limit=soon', 'before=x', 'rule=nope', 'outcome=nope']) {
    assert.equal((await app.inject(`/api/guard-events?${bad}`)).statusCode, 400, bad);
  }

  const token = core.security.chatTokens.mint('chat-42');
  const own = await app.inject({ url: '/api/guard-events?chatId=chat-42', ...fromChat(token) });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json<GuardEventPage>().events.length, 3);
  assert.equal((await app.inject({ url: '/api/guard-events?chatId=chat-43', ...fromChat(token) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/guard-events', ...fromChat(token) })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/guard-events?chatId=chat-42&orchestrationId=orch-1', ...fromChat(token) })).statusCode, 403);
});

test("POST /guards/check gives the engine's verdict with the current settings unless overridden", async (t) => {
  const { app, root } = await wrapper(t);
  const check = (body: unknown) => app.inject({ method: 'POST', url: '/api/guards/check', ...json(body) });
  const pushed = await check({ tool: 'Bash', input: { command: 'git push origin main' } });
  assert.equal(pushed.statusCode, 200, pushed.body);
  const blocked = pushed.json<GuardCheckResult>();
  assert.equal(blocked.verdict, 'block');
  assert.equal(blocked.rule, 'push');
  assert.ok(blocked.matcher?.startsWith('push.'));
  assert.ok(blocked.reason);

  assert.equal((await check({ tool: 'Bash', input: { command: 'ls -la' } })).json<GuardCheckResult>().verdict, 'pass');
  // Overridden: with `push` left out of the rules the same call passes
  assert.equal((await check({ tool: 'Bash', input: { command: 'git push origin main' }, rules: ['secrets'] })).json<GuardCheckResult>().verdict, 'pass');

  await app.inject({ method: 'PUT', url: '/api/settings/guards', ...json({ rules: { push: false } }) });
  assert.equal((await check({ tool: 'Bash', input: { command: 'git push origin main' } })).json<GuardCheckResult>().verdict, 'pass', 'the current settings apply');

  assert.equal((await check({ input: {} })).statusCode, 400);
  assert.equal((await check({ tool: 'Bash', input: 'ls' })).statusCode, 400);
  assert.equal((await check({ tool: 'Bash', input: {}, rules: ['integrity'] })).statusCode, 400);
  assert.equal((await check({ tool: 'Bash', input: {}, roots: ['relative'] })).statusCode, 400);
  assert.equal((await check({ tool: 'Bash', input: { command: 'ls' }, roots: [root] })).statusCode, 200);
});

test('the four guard routes are documented with a summary and the Security tag', async (t) => {
  const { app } = await wrapper(t);
  const spec = (await app.inject('/openapi.json')).json<{ paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> }>();
  const wanted = [
    ['/api/settings/guards', 'get'],
    ['/api/settings/guards', 'put'],
    ['/api/guard-events', 'get'],
    ['/api/guards/check', 'post'],
  ] as const;
  for (const [path, method] of wanted) {
    const op = spec.paths[path]?.[method];
    assert.ok(op?.summary, `${method} ${path} has no summary`);
    assert.deepEqual(op?.tags, ['Security'], `${method} ${path}`);
  }
});
