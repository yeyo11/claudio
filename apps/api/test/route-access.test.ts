import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions, RouteOptions } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';
import { ROUTE_DOCS, accessOf } from '../src/openapi/routes.ts';

// D1 of docs/plans/regression-fixes-2026-10-29.md: what a chat's own token may call is the class each
// route declares in ROUTE_DOCS, so a write nobody classified is caught here, before it ships open.
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const roots = new Set<string>();
const cores = new Set<Core>();
after(() => {
  for (const core of cores) core.shutdown();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function wrapper(onRoute?: (route: RouteOptions) => void): Promise<{ app: FastifyInstance; core: Core }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-route-access-'));
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
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui'), ...(onRoute ? { onRoute } : {}) }), core };
}

/** Every `METHOD /path` the server registers under `/api`, keyed as ROUTE_DOCS keys it */
async function registeredRoutes(): Promise<string[]> {
  const seen = new Set<string>();
  const { app } = await wrapper((route) => {
    if (!route.url.startsWith('/api/')) return;
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== 'HEAD' && method !== 'OPTIONS') seen.add(`${method} ${route.url.slice('/api'.length)}`);
    }
  });
  await app.close();
  return [...seen];
}

/** The owner's token, with the wrapper in token mode */
async function withToken(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/security/token', payload: '{}', headers: { 'content-type': 'application/json' } });
  const { token } = created.json() as { token: string };
  await app.inject({ method: 'PUT', url: '/api/security/auth', payload: JSON.stringify({ mode: 'token' }), headers: { 'content-type': 'application/json' } });
  return token;
}

/** A request from a chat's own process: loopback, dialled on loopback, with its token */
function fromChat(token: string, method: string, path: string): InjectOptions {
  const url = `/api${path.replace(/:(\w+)/g, 'nope')}`;
  const headers = { host: '127.0.0.1:34331', authorization: `Bearer ${token}` };
  return WRITES.has(method)
    ? { method: method as InjectOptions['method'], url, remoteAddress: '127.0.0.1', payload: '{}', headers: { ...headers, 'content-type': 'application/json' } }
    : { method: method as InjectOptions['method'], url, remoteAddress: '127.0.0.1', headers };
}

test('every registered write route declares its access class', async () => {
  const routes = await registeredRoutes();
  const writes = routes.filter((route) => WRITES.has(route.split(' ')[0] ?? ''));
  assert.ok(writes.length > 250, `only ${String(writes.length)} write routes found`);
  const unclassified = writes.filter((route) => ROUTE_DOCS[route]?.access === undefined);
  assert.deepEqual(unclassified, [], 'give each an `access` in apps/api/src/openapi/routes.ts: `person` unless an agent needs it for its work');
});

test('a class is one of the three, `workFields` only narrows a work write, and only the receivers and probes are open', () => {
  const open: string[] = [];
  for (const [route, doc] of Object.entries(ROUTE_DOCS)) {
    if (doc.access !== undefined) assert.ok(['open', 'person', 'work'].includes(doc.access), route);
    if (doc.workFields) assert.equal(doc.access, 'work', `${route}: workFields on a route a chat cannot call`);
    if (doc.access === 'open') open.push(route);
  }
  assert.deepEqual(open.sort(), [
    'DELETE /openai/client-tools/:id/mcp',
    'GET /health',
    'GET /openai/client-tools/:id/mcp',
    'GET /ready',
    'POST /openai/client-tools/:id/mcp',
    'POST /webhooks/github/:registrationId',
    'POST /webhooks/gitlab/:registrationId',
  ]);
  // A read is work unless it says otherwise; a write nobody classified would be the person's
  assert.equal(accessOf('GET', '/chats'), 'work');
  assert.equal(accessOf('POST', '/no/such/route'), 'person');
});

test('the classes C1 names: what a chat may never do, and what is its work', () => {
  const person = [
    'PUT /auth/credentials',
    'PUT /security/auth',
    'PUT /accounts/settings',
    'PUT /settings/app',
    'PUT /config/instructions',
    'PUT /config/resources/:kind/:name',
    'PUT /config/files/content',
    'PUT /memory/:project/:name',
    'POST /plugins/install',
    'POST /push/subscriptions',
    'POST /schedules',
    'POST /tunnel/stop',
    'PUT /decisions/settings',
    'POST /chats/:id/permissions/:requestId',
    'PUT /chats/:id/mcp/:name',
    'PUT /chats/:id/claudio-mcp',
    'POST /projects/:id/journal',
    'POST /orchestrations/:id/pull-request',
    'POST /orchestrations/:id/integrate',
    'POST /work-items/:itemId/pull-request',
    'POST /chats/:id/supervisor/:proposalId/send',
    'POST /orchestrations/:id/review/accept',
    'POST /orchestrations/:id/spend-pass',
    'DELETE /chats/:id',
    'DELETE /projects/:id',
  ];
  const work = [
    'POST /chats',
    'POST /chats/:id/messages',
    'POST /chats/:id/resume',
    'POST /chats/:id/fork',
    'POST /chats/:id/stop',
    'POST /chats/:id/interrupt',
    'POST /chats/:id/hint',
    'POST /chats/:id/compact',
    'POST /chats/:id/notes',
    'PATCH /chats/:id',
    'POST /orchestrations',
    'POST /orchestrations/plan',
    'POST /orchestrations/:id/stop',
    'POST /orchestrations/:id/resume',
    'POST /orchestrations/:id/tasks/:taskId/retry',
    'POST /orchestrations/:id/tasks/:taskId/skip',
    'POST /orchestrations/:id/tasks/:taskId/hint',
    'POST /orchestrations/:id/verify',
    'POST /orchestrations/:id/review/retry',
    'POST /projects/:id/work-items',
    'PATCH /work-items/:itemId',
    'POST /work-items/:itemId/move',
    'POST /work-items/:itemId/comments',
    'POST /work-items/:itemId/links',
    'PATCH /work-items/:itemId/criteria/:criterionId',
    'POST /assistant/proposals/:proposalId/accept',
    'POST /assistant/proposals/:proposalId/discard',
    'POST /flow-runs/:runId/retry',
    'POST /decisions/:id/feedback',
    'POST /uploads',
  ];
  for (const route of person) assert.equal(ROUTE_DOCS[route]?.access, 'person', route);
  for (const route of work) assert.equal(ROUTE_DOCS[route]?.access, 'work', route);
  // Every DELETE is the person's
  const deletes = Object.entries(ROUTE_DOCS).filter(([route, doc]) => route.startsWith('DELETE ') && doc.access !== 'person' && doc.access !== 'open');
  assert.deepEqual(deletes.map(([route]) => route), []);
});

test("a chat's token gets 403 on every person route and is let through to every work route", async (t) => {
  const { app, core } = await wrapper();
  t.after(() => app.close());
  await withToken(app);
  const token = core.security.chatTokens.mint('chat-42');

  const refused: string[] = [];
  const through: string[] = [];
  const asked = { person: 0, work: 0 };
  for (const [route, doc] of Object.entries(ROUTE_DOCS)) {
    if (doc.access === 'open') continue;
    const [method, path] = route.split(' ') as [string, string];
    const access = accessOf(method, path);
    // The terminal's socket is opened by its ticket, which the route checks, not by a token
    if (route === 'GET /terminals/:id/socket') continue;
    // Only the writes of the work class: a read is a read, and some of them stream for ever
    if (access === 'work' && !WRITES.has(method)) continue;
    asked[access === 'person' ? 'person' : 'work'] += 1;
    const answer = await app.inject(fromChat(token, method, path));
    const code = (answer.headers['content-type'] ?? '').includes('json') ? (answer.json() as { code?: unknown }).code : undefined;
    if (access === 'person' && answer.statusCode !== 403) refused.push(`${route} answered ${String(answer.statusCode)}`);
    if (access === 'work' && (answer.statusCode === 401 || code === 'chat-forbidden' || code === 'chat-forbidden-field')) through.push(`${route} answered ${String(answer.statusCode)} ${String(code)}`);
  }
  assert.ok(asked.person > 200 && asked.work > 40, JSON.stringify(asked));
  assert.deepEqual(refused, [], 'a person route a chat reached');
  assert.deepEqual(through, [], 'a work route the guard refused to a chat');
});
