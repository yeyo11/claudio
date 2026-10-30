import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { Account, Chat, ChatSummary, SwitchChatAccountResponse } from '@claudio/shared';
import { buildApp } from '../src/app.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { signInDefault } from './helpers.ts';

// `POST /chats/:id/account` over HTTP, on the fake Claude: every status the route answers, and that
// a chat's own token never reaches it.
const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

let app: FastifyInstance;
let core: Core;
let root: string;
let cwd: string;
let alpha: string;
let beta: string;

async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ready()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function idleChat(prompt = 'hello'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt, cwd }) });
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json<ChatSummary>();
  await until('the turn to end', () => core.runtime.get(id)?.status === 'idle');
  return id;
}

const switchTo = (id: string, accountId: unknown) => app.inject({ method: 'POST', url: `/api/chats/${id}/account`, ...json({ accountId }) });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-api-switch-'));
  cwd = join(root, 'cwd');
  mkdirSync(cwd);
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
  const add = async (alias: string) => (await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ kind: 'token', alias, secret: `tok-${alias}` }) })).json<Account>().id;
  alpha = await add('alpha');
  beta = await add('beta');
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('an idle chat moves at once, and the chat reads back its account', async () => {
  const id = await idleChat();
  const res = await switchTo(id, alpha);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<SwitchChatAccountResponse>();
  assert.equal(body.pending, false);
  assert.equal(body.chat.id, id);
  const read = (await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat;
  assert.equal(read.account, alpha);
  assert.ok(!read.pendingAccount);
});

test('a working chat answers pending, and naming its own account cancels the switch', async () => {
  const started = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'FAKE-SLEEP 1500', cwd }) });
  assert.equal(started.statusCode, 201, started.body);
  const { id } = started.json<ChatSummary>();
  const queued = await switchTo(id, beta);
  assert.equal(queued.statusCode, 200, queued.body);
  assert.equal(queued.json<SwitchChatAccountResponse>().pending, true);
  assert.equal((await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.pendingAccount, beta);

  const current = (await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.account ?? 'default';
  const cancelled = await switchTo(id, current);
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<SwitchChatAccountResponse>().pending, false);
  assert.ok(!(await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.pendingAccount);
  await until('the turn to end', () => core.runtime.get(id)?.status === 'idle');
});

test('a missing accountId is 400, an unknown chat or account is 404', async () => {
  const id = await idleChat();
  assert.equal((await switchTo(id, undefined)).statusCode, 400);
  assert.equal((await switchTo(id, '')).statusCode, 400);
  assert.equal((await switchTo(id, 7)).statusCode, 400);
  assert.equal((await switchTo('ghost', alpha)).statusCode, 404);
  assert.equal((await switchTo(id, 'ghost')).statusCode, 404);
});

test('an account that cannot be chosen is 409 with its code', async () => {
  const id = await idleChat();
  const current = (await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.account ?? 'default';
  const same = await switchTo(id, current);
  assert.equal(same.statusCode, 409);
  assert.equal(same.json().code, 'same-account');

  const other = current === alpha ? beta : alpha;
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/accounts/${other}`, ...json({ enabled: false }) })).statusCode, 200);
  const disabled = await switchTo(id, other);
  assert.equal(disabled.statusCode, 409);
  assert.equal(disabled.json().code, 'disabled');
  await app.inject({ method: 'PATCH', url: `/api/accounts/${other}`, ...json({ enabled: true }) });
});

test('an account whose sign-in expired is 409 sign-in-expired, and is chosen again once it signs in', async () => {
  const id = await idleChat();
  const current = (await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.account ?? 'default';
  const other = current === alpha ? beta : alpha;
  await core.accounts.markAuthFailed(other);
  try {
    const listed = (await app.inject('/api/accounts')).json<Account[]>().find((a) => a.id === other);
    assert.deepEqual([listed?.signInState, listed?.signedIn], ['expired', false]);
    const expired = await switchTo(id, other);
    assert.equal(expired.statusCode, 409, expired.body);
    assert.equal(expired.json().code, 'sign-in-expired');
    assert.equal((await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.account ?? 'default', current);
  } finally {
    await core.accounts.clearAuthFailed(other);
  }
  assert.equal((await switchTo(id, other)).statusCode, 200);
});

test("a chat's own token gets 403 and the chat stays where it was", async () => {
  const id = await idleChat();
  const before = (await app.inject(`/api/chats/${id}`)).json<{ chat: Chat }>().chat.account;
  const { token: owner } = (await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) })).json<{ token: string }>();
  await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) });
  try {
    const chatToken = core.security.chatTokens.mint(id);
    const as = (token: string) => ({
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ accountId: alpha }),
    });
    const denied = await app.inject({ method: 'POST', url: `/api/chats/${id}/account`, ...as(chatToken) });
    assert.equal(denied.statusCode, 403, denied.body);
    const allowed = await app.inject({ method: 'POST', url: `/api/chats/${id}/account`, ...as(owner) });
    assert.equal(allowed.statusCode, 200, allowed.body);
  } finally {
    await app.inject({ method: 'PUT', url: '/api/security/auth', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, payload: JSON.stringify({ mode: 'off' }) });
  }
  assert.notEqual(before, alpha);
});
