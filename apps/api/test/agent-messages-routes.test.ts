import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest, type TestFn } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// Who may reach the routes of messages to subagents (docs/agent-messages.md, D8 of
// docs/plans/agent-messages.md). The bridge's two routes take only the chat's own token, from this
// machine: never a person's session, the owner's token or another chat's token. A chat may not write
// to its own subagents as the person. The answers past the gate are the routes' own (404 for a chat
// nobody runs here): what is asserted is whether the gate let the request through.

const test = (name: string, fn: TestFn) => nodeTest(name, { timeout: 60_000 }, fn);

const roots = new Set<string>();
const cores = new Set<Core>();
after(async () => {
  await Promise.all([...cores].map((core) => core.shutdown()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function wrapper(): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-agent-messages-'));
  roots.add(root);
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  cores.add(core);
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') }), core };
}

async function tokenMode(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', payload: '{}', headers: { 'content-type': 'application/json' } });
  const { token } = created.json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', payload: JSON.stringify({ mode: 'token' }), headers: { 'content-type': 'application/json' } })).statusCode, 200);
  return token;
}

const local = (token: string | null, body?: unknown, extra: Record<string, string> = {}): Partial<InjectOptions> => ({
  remoteAddress: '127.0.0.1',
  ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  headers: { host: '127.0.0.1:34331', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
});

const NEXT = '/api/chats/chat-42/bridge/next?wait=0';
const REPORT = '/api/chats/chat-42/bridge/m1';
const REPORT_BODY = { isDelivered: true };

test("guarded: the bridge routes take the chat's own token, and refuse the owner's and another chat's with 403", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await tokenMode(app);
  const own = core.security.chatTokens.mint('chat-42');
  const other = core.security.chatTokens.mint('chat-7');

  for (const [method, url, body] of [
    ['GET', NEXT, undefined],
    ['POST', REPORT, REPORT_BODY],
  ] as const) {
    const ok = await app.inject({ method, url, ...local(own, body) });
    assert.notEqual(ok.statusCode, 403, `${method} ${url}: the chat's own token passes the gate`);
    assert.equal(ok.statusCode, 404, 'and the route answers for a chat nobody runs here');
    for (const [who, token] of [
      ["the owner's token", owner],
      ["another chat's token", other],
    ] as const) {
      const refused = await app.inject({ method, url, ...local(token, body) });
      assert.equal(refused.statusCode, 403, `${method} ${url}: ${who}`);
      assert.equal(refused.json().code, 'bridge.own-chat-only', who);
    }
  }
});

test("open mode: a person's session and another chat's token get 403, and the chat's own token only from this machine", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const own = core.security.chatTokens.mint('chat-42');
  const other = core.security.chatTokens.mint('chat-7');
  for (const [method, url, body] of [
    ['GET', NEXT, undefined],
    ['POST', REPORT, REPORT_BODY],
  ] as const) {
    assert.equal((await app.inject({ method, url, ...local(null, body) })).statusCode, 403, `${method}: a person's session`);
    assert.equal((await app.inject({ method, url, ...local(other, body) })).statusCode, 403, `${method}: another chat's token`);
    assert.equal((await app.inject({ method, url, ...local(own, body) })).statusCode, 404, `${method}: the chat's own token`);
    const relayed = await app.inject({ method, url, ...local(own, body, { 'x-forwarded-for': '203.0.113.9' }) });
    assert.equal(relayed.statusCode, 403, `${method}: the chat's own token, relayed from elsewhere`);
  }
});

test("a chat's token may not write to its own subagents as the person; another chat's may, and the owner may", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  const owner = await tokenMode(app);
  const own = core.security.chatTokens.mint('chat-42');
  const other = core.security.chatTokens.mint('chat-7');
  const url = '/api/chats/chat-42/subagents/a1/messages';
  const self = await app.inject({ method: 'POST', url, ...local(own, { text: 'hi' }) });
  assert.equal(self.statusCode, 403);
  assert.equal(self.json().code, 'chat-not-self');
  const withdrawn = await app.inject({ method: 'DELETE', url: `${url}/m1`, ...local(own) });
  assert.equal(withdrawn.statusCode, 403);
  // Past the gate, the route answers for a chat nobody runs here
  assert.equal((await app.inject({ method: 'POST', url, ...local(other, { text: 'hi' }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url, ...local(owner, { text: 'hi' }) })).statusCode, 404);
  // A chat's token sends only `text`
  const field = await app.inject({ method: 'POST', url, ...local(other, { text: 'hi', source: 'supervisor' }) });
  assert.equal(field.statusCode, 403);
  assert.equal(field.json().code, 'chat-forbidden-field');
});
