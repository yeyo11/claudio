import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const authed = (token: string, body: unknown) => ({
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
});
const fromChat = (token: string, body: unknown) => ({
  remoteAddress: '127.0.0.1',
  payload: JSON.stringify(body),
  headers: { host: '127.0.0.1:34331', 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

const ROUTES = [
  { pattern: '/api/orchestrations/:id/review/accept', url: '/api/orchestrations/o1/review/accept', body: { reason: 'checked by hand' } },
  { pattern: '/api/projects/:id/review-roles/:role', url: '/api/projects/p1/review-roles/security', body: {} },
];

async function wrapper(): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-security-review-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  // The refusal is a hook on the route's pattern, so a stub shows it before the real handlers land
  for (const { pattern } of ROUTES) {
    try {
      app.post(pattern, async () => ({ ok: true }));
    } catch {
      // The real route is registered already
    }
  }
  return { app, core };
}

test("a chat's token cannot accept a review gate or write a reviewer's role, and the owner can", async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => { await app.close(); await core.shutdown(); });
  const created = await app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const { token: owner } = created.json() as { token: string };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
  const chat = core.security.chatTokens.mint('chat-42');
  for (const { url, body } of ROUTES) {
    assert.equal((await app.inject({ method: 'POST', url, ...fromChat(chat, body) })).statusCode, 403, url);
    const allowed = await app.inject({ method: 'POST', url, ...authed(owner, body) });
    assert.notEqual(allowed.statusCode, 403, url);
    assert.notEqual(allowed.statusCode, 401, url);
  }
});

test('under mode none the chat label refuses the review gate routes and an unlabelled caller passes', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => { await app.close(); await core.shutdown(); });
  const chat = core.security.chatTokens.mint('chat-42');
  for (const { url, body } of ROUTES) {
    assert.equal((await app.inject({ method: 'POST', url, ...fromChat(chat, body) })).statusCode, 403, url);
    assert.notEqual((await app.inject({ method: 'POST', url, ...json(body) })).statusCode, 403, url);
  }
});
