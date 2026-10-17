import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { Account, AccountLoginSession, AccountsSettings, RotationEvent, RotationPolicy, UsageHistoryPoint } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// The accounts over HTTP, against the accounts package's fake `claude`, which honours
// CLAUDE_CONFIG_DIR and signs in when it is handed `good-code`.
const FAKE_CLAUDE = join(import.meta.dirname, '../../../packages/accounts/test/fake-claude.mjs');
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-accounts-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
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

const accounts = async (): Promise<Account[]> => (await app.inject('/api/accounts')).json<Account[]>();

async function untilEnded(id: string): Promise<AccountLoginSession> {
  for (let i = 0; i < 100; i += 1) {
    const session = (await app.inject(`/api/accounts/logins/${id}`)).json<AccountLoginSession>();
    if (session.endedAt) return session;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the sign-in did not end');
}

async function untilUrl(id: string): Promise<AccountLoginSession> {
  for (let i = 0; i < 100; i += 1) {
    const session = (await app.inject(`/api/accounts/logins/${id}`)).json<AccountLoginSession>();
    if (session.url) return session;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the CLI printed no URL');
}

test('the default account is listed first, and the list is the same as the store', async () => {
  const list = await accounts();
  assert.equal(list[0]?.id, 'default');
  assert.equal(list[0]?.kind, 'login');
  assert.deepEqual(list, core.accounts.list());
});

test('a token account needs an alias and a secret, keeps the secret in a 0600 file and never answers it back', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'token', secret: 's' }) });
  assert.equal(bad.statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'login', alias: 'x', secret: 's' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'token', alias: 'ci' }) })).statusCode, 400);

  const secret = 'sk-ant-oat01-very-secret';
  const created = await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'token', alias: 'ci', secret }) });
  assert.equal(created.statusCode, 201);
  const account = created.json<Account>();
  assert.equal(account.kind, 'token');
  assert.equal(account.alias, 'ci');
  assert.equal(account.signedIn, true);
  assert.ok(!created.payload.includes(secret));
  assert.ok(!(await app.inject('/api/accounts')).payload.includes(secret));

  const dir = core.accounts.ref(account.id).dir;
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && (statSync(join(dir, f)).mode & 0o777) === 0o600);
  assert.ok(files.length >= 1, 'the secret sits in a 0600 file of the account dir');

  const taken = await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'api-key', alias: 'ci', secret: 'k' }) });
  assert.equal(taken.statusCode, 400);
});

test('PATCH renames and disables, and DELETE removes the account and its dir', async () => {
  const { id } = (await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'api-key', alias: 'spare', secret: 'k' }) })).json<Account>();
  const dir = core.accounts.ref(id).dir;
  assert.equal(existsSync(dir), true);

  const patched = await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, ...json({ alias: 'spare 2', enabled: false }) });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json<Account>().alias, 'spare 2');
  assert.equal(patched.json<Account>().enabled, false);
  // A token account has no identity to fall back on
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, ...json({ alias: null }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/accounts/nope', ...json({ enabled: true }) })).statusCode, 404);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/${id}` })).statusCode, 200);
  assert.equal(existsSync(dir), false);
  assert.ok(!(await accounts()).some((a) => a.id === id));
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/accounts/default' })).statusCode, 400);
});

test('a login account answers a sign-in: the URL, the code, and the account once signed in', async () => {
  const started = await app.inject({ method: 'POST', url: '/api/accounts', ...json({}) });
  assert.equal(started.statusCode, 201);
  const session = started.json<AccountLoginSession>();
  assert.equal(session.account, null);
  assert.ok((await accounts()).some((a) => a.id === session.accountId), 'the account exists while it signs in');

  const waiting = await untilUrl(session.id);
  assert.equal(waiting.url, 'https://claude.example/authorize?state=x');
  assert.equal(waiting.state, 'waiting-for-person');

  assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/logins/${session.id}/code`, ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/logins/${session.id}/code`, ...json({ code: 'good-code' }) })).statusCode, 200);

  const ended = await untilEnded(session.id);
  assert.equal(ended.state, 'succeeded');
  assert.equal(ended.account?.signedIn, true);
  assert.match(ended.account?.email ?? '', /@example\.com$/);
  assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/logins/${session.id}/code`, ...json({ code: 'x' }) })).statusCode, 409);
  assert.equal((await app.inject('/api/accounts/logins/nope')).statusCode, 404);
});

test('a sign-in that fails or is cancelled takes its empty account away again', async () => {
  const failing = (await app.inject({ method: 'POST', url: '/api/accounts', ...json({}) })).json<AccountLoginSession>();
  await untilUrl(failing.id);
  await app.inject({ method: 'POST', url: `/api/accounts/logins/${failing.id}/code`, ...json({ code: 'wrong' }) });
  const failed = await untilEnded(failing.id);
  assert.equal(failed.state, 'failed');
  assert.ok(!(await accounts()).some((a) => a.id === failing.accountId));

  const cancelling = (await app.inject({ method: 'POST', url: '/api/accounts', ...json({}) })).json<AccountLoginSession>();
  await untilUrl(cancelling.id);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/logins/${cancelling.id}` })).statusCode, 200);
  const cancelled = await untilEnded(cancelling.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(!(await accounts()).some((a) => a.id === cancelling.accountId));
});

test('settings read as the defaults, merge on PUT and refuse what is out of range', async () => {
  const defaults = (await app.inject('/api/accounts/settings')).json<AccountsSettings>();
  assert.equal(defaults.rotateOnLimit, true);

  const saved = await app.inject({ method: 'PUT', url: '/api/accounts/settings', ...json({ rotateOnLimit: false, threshold: 80 }) });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json<AccountsSettings>().rotateOnLimit, false);
  assert.equal(saved.json<AccountsSettings>().threshold, 80);
  assert.equal((await app.inject('/api/accounts/settings')).json<AccountsSettings>().threshold, 80);

  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/settings', ...json({ threshold: 10 }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/settings', ...json({ strategy: 'random' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/accounts/settings')).json<AccountsSettings>().threshold, 80);
});

test('policies are created, replaced and deleted, and one project has one policy', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ projects: ['p1'], order: ['default'], threshold: 70 }) });
  assert.equal(created.statusCode, 201);
  const policy = created.json<RotationPolicy>();
  assert.deepEqual(policy.projects, ['p1']);

  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ projects: ['p1'] }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ projects: ['p2'], order: ['ghost'] }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/policies', ...json({ projects: [] }) })).statusCode, 400);

  const replaced = await app.inject({ method: 'PUT', url: `/api/accounts/policies/${policy.id}`, ...json({ projects: ['p1', 'p3'] }) });
  assert.equal(replaced.statusCode, 200);
  assert.deepEqual(replaced.json<RotationPolicy>().projects, ['p1', 'p3']);
  assert.equal(replaced.json<RotationPolicy>().order, undefined);
  assert.equal((await app.inject('/api/accounts/policies')).json<RotationPolicy[]>().length, 1);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/policies/nope', ...json({ projects: ['p9'] }) })).statusCode, 404);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/policies/${policy.id}` })).statusCode, 200);
  assert.deepEqual((await app.inject('/api/accounts/policies')).json(), []);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/policies/${policy.id}` })).statusCode, 404);
});

test('usage history and events are read from their tables, oldest first, with filters', async () => {
  core.db.appendUsagePoints([
    { account: 'default', window: 'five_hour', at: '2026-10-01T10:00:00.000Z', pct: 10 },
    { account: 'default', window: 'five_hour', at: '2026-10-01T11:00:00.000Z', pct: 40 },
    { account: 'default', window: 'seven_day', at: '2026-10-01T11:00:00.000Z', pct: 5 },
  ]);
  const all = (await app.inject('/api/accounts/usage-history?account=default')).json<UsageHistoryPoint[]>();
  assert.equal(all.length, 3);
  assert.deepEqual(all.filter((p) => p.window === 'five_hour').map((p) => p.pct), [10, 40]);
  const week = (await app.inject('/api/accounts/usage-history?window=seven_day')).json<UsageHistoryPoint[]>();
  assert.deepEqual(week.map((p) => p.pct), [5]);
  const since = (await app.inject('/api/accounts/usage-history?since=2026-10-01T10:30:00.000Z&window=five_hour')).json<UsageHistoryPoint[]>();
  assert.deepEqual(since.map((p) => p.pct), [40]);
  assert.equal((await app.inject('/api/accounts/usage-history?window=hour')).statusCode, 400);
  assert.equal((await app.inject('/api/accounts/usage-history?limit=0')).statusCode, 400);
  assert.equal((await app.inject('/api/accounts/usage-history?since=yesterday')).statusCode, 400);

  core.db.appendRotationEvent({ ts: '2026-10-01T12:00:00.000Z', event: 'switch', from: 'default', to: 'acc-1', reason: 'limit', detail: 'a chat', data: { chatId: 'c1' } });
  core.db.appendRotationEvent({ ts: '2026-10-01T13:00:00.000Z', event: 'wait', from: 'acc-1', to: null, reason: 'no-account', detail: null, data: null });
  const events = (await app.inject('/api/accounts/events')).json<RotationEvent[]>();
  assert.deepEqual(events.map((e) => e.event), ['switch', 'wait']);
  assert.equal(events[0]?.data?.chatId, 'c1');
  assert.deepEqual((await app.inject('/api/accounts/events?limit=1')).json<RotationEvent[]>().map((e) => e.event), ['wait']);
  assert.equal((await app.inject('/api/accounts/events?limit=x')).statusCode, 400);
});

test("a chat's token reads the accounts but changes none, and cannot read a sign-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-api-accounts-sec-'));
  mkdirSync(join(dir, 'claude')); // the fake CLI writes its probe counter there
  const secured = new Core(
    loadConfig({ CLAUDE_BIN: FAKE_CLAUDE, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDIO_WORKSPACE_DIR: join(dir, 'workspace'), CLAUDIO_DATA_DIR: join(dir, 'data') }),
  );
  const guarded = await buildApp(secured, { logLevel: 'silent', webDist: join(dir, 'no-ui') });
  try {
    const { token: owner } = (await guarded.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>();
    await guarded.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) });
    const chat = secured.security.chatTokens.mint('chat-42');
    const as = (token: string, body?: unknown) => ({
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

    for (const url of ['/api/accounts', '/api/accounts/settings', '/api/accounts/policies', '/api/accounts/usage-history', '/api/accounts/events', '/api/accounts/model-fallbacks', '/api/accounts/default/models']) {
      assert.equal((await guarded.inject({ url, ...as(chat) })).statusCode, 200, url);
    }
    const created = await guarded.inject({ method: 'POST', url: '/api/accounts/token', ...as(owner, { kind: 'token', alias: 'ci', secret: 's' }) });
    assert.equal(created.statusCode, 201);
    const id = created.json<Account>().id;

    const denied: Array<[string, string, unknown]> = [
      ['POST', '/api/accounts', {}],
      ['POST', '/api/accounts/token', { kind: 'token', alias: 'x', secret: 's' }],
      ['GET', '/api/accounts/logins/any', undefined],
      ['POST', '/api/accounts/logins/any/code', { code: 'c' }],
      ['DELETE', '/api/accounts/logins/any', undefined],
      ['PATCH', `/api/accounts/${id}`, { enabled: false }],
      ['DELETE', `/api/accounts/${id}`, undefined],
      ['POST', '/api/accounts/refresh', undefined],
      ['POST', `/api/accounts/${id}/refresh`, undefined],
      ['PUT', '/api/accounts/settings', { threshold: 80 }],
      ['PUT', '/api/accounts/model-fallbacks', { fallbacks: [] }],
      ['POST', '/api/accounts/policies', { projects: ['p'] }],
      ['PUT', '/api/accounts/policies/any', { projects: ['p'] }],
      ['DELETE', '/api/accounts/policies/any', undefined],
    ];
    for (const [method, url, body] of denied) {
      const res = await guarded.inject({ method: method as 'GET', url, ...as(chat, body) });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
    }
    assert.ok(secured.accounts.list().some((a) => a.id === id), 'nothing the chat tried changed the accounts');
  } finally {
    await guarded.close();
    secured.shutdown();
  }
});

test('refreshing reads the CLI itself and answers the plan, the per-model limits and the credits', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/accounts/refresh' });
  assert.equal(res.statusCode, 200);
  const { accounts: list, failed } = res.json<{ accounts: Account[]; failed: unknown[] }>();
  assert.deepEqual(failed, []);
  const fresh = list.find((a) => a.id === 'default');
  assert.equal(fresh?.limits?.source, 'cli');
  assert.equal(fresh?.limits?.cli?.plan, 'max');
  assert.equal(fresh?.limits?.cli?.scoped[0]?.model, 'Fable');
  assert.equal(fresh?.limits?.cli?.credits?.enabled, false);
  assert.deepEqual(await accounts(), list, 'GET /accounts serves what the refresh stored');
});

test('refreshing one account answers it, and an unknown one is a 404', async () => {
  const id = (await core.accounts.add({ kind: 'login' })).id;
  const res = await app.inject({ method: 'POST', url: `/api/accounts/${id}/refresh` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<Account>().plan, 'max');
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/nope/refresh' })).statusCode, 404);
});

test('an api-key account refreshes to a reading that says it has no subscription limits', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'api-key', alias: 'a-key', secret: 'sk-ant-api-r' }) });
  const res = await app.inject({ method: 'POST', url: `/api/accounts/${created.json<Account>().id}/refresh` });
  assert.equal(res.json<Account>().limits?.cli?.available, false);
});
