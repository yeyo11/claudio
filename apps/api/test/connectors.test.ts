import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ConnectorAuthorisation } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// Authorising a connector over a real core whose CLI is a stand-in answering mcp_status and mcp_authenticate
let app: FastifyInstance;
let core: Core;
let root: string;

const SERVERS = [
  { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai', source: 'claudeai' },
  { name: 'claude.ai Claude Docs', status: 'connected', scope: 'claudeai', source: 'claudeai', tools: [{ name: 'read' }] },
];
const STUB = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const servers = ${JSON.stringify(SERVERS)};
createInterface({ input: process.stdin }).on('line', (line) => {
  const { request_id, request } = JSON.parse(line);
  const response = request.subtype === 'mcp_authenticate'
    ? { authUrl: 'https://claude.ai/start-auth/x', requiresUserAction: true, callbackExpected: false }
    : { mcpServers: servers };
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response } }));
});
`;

const json = { payload: '{}', headers: { 'content-type': 'application/json' } };

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-connectors-'));
  const bin = join(root, 'claude-stub.mjs');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  core = new Core(loadConfig({ CLAUDE_BIN: bin, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'), CLAUDIO_DATA_DIR: join(root, 'data') }));
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('authorising a connector that needs it returns the CLI sign-in link', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/connectors/${encodeURIComponent('claude.ai Gmail')}/authorise` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json<ConnectorAuthorisation>(), { authUrl: 'https://claude.ai/start-auth/x', requiresUserAction: true, callbackExpected: false });
});

test('an unknown connector is 404 and a connected one is 409', async () => {
  const unknown = await app.inject({ method: 'POST', url: `/api/connectors/${encodeURIComponent('claude.ai Nope')}/authorise` });
  assert.equal(unknown.statusCode, 404);
  const connected = await app.inject({ method: 'POST', url: `/api/connectors/${encodeURIComponent('claude.ai Claude Docs')}/authorise` });
  assert.equal(connected.statusCode, 409);
});

test("a chat's token cannot authorise a connector", async () => {
  const secured = mkdtempSync(join(tmpdir(), 'agentry-api-conn-sec-'));
  const c = new Core(loadConfig({ CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(secured, 'claude'), CLAUDIO_WORKSPACE_DIR: join(secured, 'workspace'), CLAUDIO_DATA_DIR: join(secured, 'data') }));
  const a = await buildApp(c, { logLevel: 'silent', webDist: join(secured, 'no-ui') });
  try {
    assert.equal((await a.inject({ method: 'POST', url: '/api/security/token', ...json })).statusCode, 200);
    assert.equal((await a.inject({ method: 'PUT', url: '/api/security/auth', ...json, payload: JSON.stringify({ mode: 'token' }) })).statusCode, 200);
    const token = c.security.chatTokens.mint('chat-42');
    const res = await a.inject({ method: 'POST', url: '/api/connectors/x/authorise', remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403);
  } finally {
    await a.close();
    c.shutdown();
  }
});
