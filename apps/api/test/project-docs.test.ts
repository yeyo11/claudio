import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Project, ProjectDoc, ProjectDocsOverview } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// The Claude Docs routes over a real core with a missing CLI: nothing here starts Claude. The
// registry is seeded through the store, and what needs a session is checked at its refusals.
let app: FastifyInstance;
let core: Core;
let root: string;
let project: Project;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const doc = (id: string): ProjectDoc => ({ id, url: `https://claude.ai/docs/${id}`, title: `Doc ${id}`, kind: 'doc', createdBy: 'person', addedAt: '2026-01-01T00:00:00.000Z', status: 'unread', checkedAt: null });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-project-docs-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: mkdtempSync(join(tmpdir(), 'agentry-api-pd-proj-')), name: 'Docs' }) });
  assert.equal(res.statusCode, 201, res.body);
  project = res.json<Project>();
});

after(async () => {
  await app.close();
  core.shutdown();
});

test('an unknown project is 404 on every route', async () => {
  for (const [method, url] of [
    ['GET', '/api/projects/nope/docs'],
    ['POST', '/api/projects/nope/docs/refresh'],
    ['DELETE', '/api/projects/nope/docs/a'],
    ['POST', '/api/projects/nope/docs/a/ask'],
  ] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 404, `${method} ${url}`);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/nope/docs', ...json({ url: 'https://claude.ai/x' }) })).statusCode, 404);
});

test('the registry starts empty, lists what was seeded and removes an entry without a session', async () => {
  const base = `/api/projects/${project.id}/docs`;
  assert.deepEqual((await app.inject(base)).json<ProjectDocsOverview>().docs, []);
  await core.projectDocs.store.update(project.id, (current) => ({ next: { ...current, docs: [doc('a'), doc('b')] }, value: undefined }));
  assert.deepEqual((await app.inject(base)).json<ProjectDocsOverview>().docs.map((d) => d.id), ['a', 'b']);

  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/a` })).statusCode, 204);
  assert.deepEqual((await app.inject(base)).json<ProjectDocsOverview>().docs.map((d) => d.id), ['b']);
  assert.equal((await app.inject({ method: 'DELETE', url: `${base}/a` })).statusCode, 404);
});

test('adding is refused before any session: bad body 400, no Docs connector 409', async () => {
  const base = `/api/projects/${project.id}/docs`;
  assert.equal((await app.inject({ method: 'POST', url: base, ...json({}) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: base, ...json({ url: 'https://claude.ai/x', create: { title: 't', body: '' } }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: base, ...json({ url: 'http://example.com/x' }) })).statusCode, 400);
  const noConnector = await app.inject({ method: 'POST', url: base, ...json({ url: 'https://claude.ai/docs/c' }) });
  assert.equal(noConnector.statusCode, 409, noConnector.body);
  assert.match(noConnector.json<{ error: string }>().error, /Docs connector/);
});

test('ask on a document that is not in the project is 404', async () => {
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/docs/missing/ask` })).statusCode, 404);
});

test("a chat's token can read the registry but not change it or ask", async () => {
  const secured = mkdtempSync(join(tmpdir(), 'agentry-api-pd-sec-'));
  const c = new Core(loadConfig({ CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(secured, 'claude'), CLAUDIO_WORKSPACE_DIR: join(secured, 'workspace'), CLAUDIO_DATA_DIR: join(secured, 'data') }));
  const a = await buildApp(c, { logLevel: 'silent', webDist: join(secured, 'no-ui') });
  try {
    const created = await a.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
    assert.equal(created.statusCode, 200);
    assert.equal((await a.inject({ method: 'PUT', url: '/api/security/auth', ...json({ mode: 'token' }) })).statusCode, 200);
    const token = c.security.chatTokens.mint('chat-42');
    const fromChat = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
    for (const [method, url] of [
      ['POST', '/api/projects/p/docs'],
      ['POST', '/api/projects/p/docs/refresh'],
      ['DELETE', '/api/projects/p/docs/a'],
      ['POST', '/api/projects/p/docs/a/ask'],
    ] as const) {
      const res = await a.inject({ method, url, ...fromChat, ...(method === 'POST' ? { payload: '{}' } : {}) });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
    }
    assert.notEqual((await a.inject({ method: 'GET', url: '/api/projects/p/docs', ...fromChat })).statusCode, 403);
  } finally {
    await a.close();
    c.shutdown();
  }
});
