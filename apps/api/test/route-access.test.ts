import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
after(async () => {
  await Promise.all([...cores].map((core) => core.shutdown()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function wrapper(onRoute?: (route: RouteOptions) => void, bin = '/nonexistent/claude'): Promise<{ app: FastifyInstance; core: Core; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-route-access-'));
  roots.add(root);
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: bin,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  cores.add(core);
  return { app: await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui'), ...(onRoute ? { onRoute } : {}) }), core, root };
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
    'GET /meta',
    'GET /openai/client-tools/:id/mcp',
    'GET /ready',
    'POST /openai/client-tools/:id/mcp',
    'POST /server-links/redeem',
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
    'POST /tunnel/stop',
    'PUT /decisions/settings',
    'POST /chats/:id/permissions/:requestId',
    'PUT /chats/:id/mcp/:name',
    'PUT /chats/:id/claudio-mcp',
    'POST /chats/:id/compact',
    'POST /chats/:id/notes',
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
    'POST /schedules',
    'PATCH /schedules/:id',
    'DELETE /schedules/:id',
    'POST /schedules/:id/enable',
    'POST /schedules/:id/disable',
    'POST /schedules/:id/run',
  ];
  for (const route of person) assert.equal(ROUTE_DOCS[route]?.access, 'person', route);
  for (const route of work) assert.equal(ROUTE_DOCS[route]?.access, 'work', route);
  // Every DELETE is the person's, but a schedule, which the owner chose to let an agent delete (its tool asks first)
  const deletes = Object.entries(ROUTE_DOCS).filter(([route, doc]) => route.startsWith('DELETE ') && doc.access !== 'person' && doc.access !== 'open');
  assert.deepEqual(deletes.map(([route]) => route), ['DELETE /schedules/:id']);
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

// D12 of docs/plans/claudio-servers.md: a chat the person switched Claudio's own MCP server on for is
// the owner on every `/orchestrations*` route and field, read from the chat at every request; every
// other chat, an orchestration's workers included, keeps the classes above.

/** The e2e suite's fake CLI: it keeps a live process and answers the switch (`mcp_set_servers`) as the CLI does */
const FAKE_CLI = fileURLToPath(new URL('../../../e2e/fake-cli/claude', import.meta.url));

/** The person's own write, with the owner's token once the wrapper asks for one */
function asOwner(token: string | null, method: InjectOptions['method'], url: string, body?: unknown): InjectOptions {
  return {
    method,
    url,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify(body ?? {}),
  };
}

/** A chat's own write: loopback, dialled on loopback, with its token */
function asChat(token: string, method: InjectOptions['method'], url: string, body?: unknown): InjectOptions {
  return {
    method,
    url,
    remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body ?? {}),
  };
}

const codeOf = (answer: { headers: Record<string, unknown>; json: () => unknown }): unknown =>
  String(answer.headers['content-type'] ?? '').includes('json') ? (answer.json() as { code?: unknown }).code : undefined;

async function until(what: () => string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("D12: a chat with Claudio's server on is the owner on every orchestration route and field, only there, and only while it is on", async (t) => {
  // The switch builds the server from this source; the fake CLI only records what it is handed
  const entry = process.env.CLAUDIO_MCP_ENTRY;
  delete process.env.CLAUDIO_MCP_ENTRY;
  // What is under test is the access rule, not whether this host has room for a chat right now
  process.env.CLAUDIO_ADMIT_MEMORY_PRESSURE = '100';
  process.env.CLAUDIO_ADMIT_MEMORY_FLOOR_MB = '0';
  const { app, core, root } = await wrapper(undefined, FAKE_CLI);
  t.after(async () => {
    core.runtime.stopAll();
    await app.close();
    if (entry !== undefined) process.env.CLAUDIO_MCP_ENTRY = entry;
    delete process.env.CLAUDIO_ADMIT_MEMORY_PRESSURE;
    delete process.env.CLAUDIO_ADMIT_MEMORY_FLOOR_MB;
  });
  core.runtime.apiUrl = 'http://127.0.0.1:9/api';
  const cwd = join(root, 'shop');
  mkdirSync(cwd, { recursive: true });

  // A person's chat with a live process, Claudio's server switched on from its "+"
  const started = await app.inject(asOwner(null, 'POST', '/api/chats', { prompt: 'hello', cwd, toolPreset: null }));
  assert.equal(started.statusCode, 201, started.body);
  const id = (started.json() as { id: string }).id;
  await core.runtime.waitForResult(id);
  await until(() => `the live process (${String(core.runtime.get(id)?.status)})`, () => core.runtime.get(id)?.status === 'idle' && core.runtime.get(id)?.pid != null);
  const on = await app.inject(asOwner(null, 'PUT', `/api/chats/${id}/claudio-mcp`, { enabled: true }));
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(core.runtime.get(id)?.tools?.claudioMcp, true);
  const mcp = core.security.chatTokens.mint(id);
  // A chat without it, and a worker of a graph whose tool record says it has the server: neither is widened
  const plain = core.security.chatTokens.mint('chat-42');
  const worker = core.runtime.start(
    { prompt: 'work', cwd, toolConfig: { preset: null, allowedTools: [], disallowedTools: [], mcp: null, claudioMcp: true } },
    { orchestrationId: 'graph-1', orchestrationTaskId: 'a' },
  );
  assert.equal(core.runtime.get(worker.id)?.tools?.claudioMcp, true, "the worker's record has the flag: its origin is what keeps it out");
  const workerToken = core.security.chatTokens.mint(worker.id);

  // Under `mode: none` a chat's token only labels the request, and the label refuses the review gate
  // to every chat but one with the server on
  const acceptNone = (token: string) => app.inject(asChat(token, 'POST', '/api/orchestrations/nope/review/accept', { reason: 'looked at it' }));
  assert.notEqual((await acceptNone(mcp)).statusCode, 403);
  assert.equal((await acceptNone(plain)).statusCode, 403);
  assert.equal((await acceptNone(workerToken)).statusCode, 403);

  const owner = await withToken(app);

  // Every person route: the orchestration ones let the chat through, every other still refuses it
  const wrong: string[] = [];
  for (const [route, doc] of Object.entries(ROUTE_DOCS)) {
    if (doc.access !== 'person') continue;
    const [method, path] = route.split(' ') as [string, string];
    const answer = await app.inject(fromChat(mcp, method, path));
    const orchestration = path === '/orchestrations' || path.startsWith('/orchestrations/');
    if (orchestration && answer.statusCode === 403) wrong.push(`${route} refused it: ${answer.body}`);
    if (!orchestration && answer.statusCode !== 403) wrong.push(`${route} answered ${String(answer.statusCode)}`);
  }
  assert.deepEqual(wrong, []);

  // The person's fields of a launch, and a guard weaker than the default, which the handler checks
  // itself: an empty task list makes the launch fail after both checks, so nothing starts
  const personFields = {
    name: 'wide',
    cwd,
    permissionMode: 'bypassPermissions',
    permissionPrompts: 'none',
    allowedTools: ['Bash'],
    verification: { commands: ['true'], fixer: false, maxAttempts: 1 },
    guards: { enabled: false },
    tasks: [],
  };
  const launch = (token: string, body: unknown) => app.inject(asChat(token, 'POST', '/api/orchestrations', body));
  const widened = await launch(mcp, personFields);
  assert.equal(widened.statusCode, 400, widened.body);
  const narrowed = await launch(plain, personFields);
  assert.deepEqual([narrowed.statusCode, codeOf(narrowed)], [403, 'chat-forbidden-field'], narrowed.body);
  assert.equal((await launch(plain, { name: 'x', cwd, guards: { enabled: false }, tasks: [] })).statusCode, 403, 'a weaker guard is still refused to a plain chat');
  assert.equal((await launch(mcp, { name: 'x', cwd, guards: { enabled: false }, tasks: [] })).statusCode, 400);
  // A relaunch's spec is a person's field too
  assert.notEqual(codeOf(await app.inject(asChat(mcp, 'POST', '/api/orchestrations/nope/relaunch', { spec: { permissionMode: 'plan' } }))), 'chat-forbidden-field');
  assert.equal(codeOf(await app.inject(asChat(plain, 'POST', '/api/orchestrations/nope/relaunch', { spec: { permissionMode: 'plan' } }))), 'chat-forbidden-field');
  // The handlers' own checks of a chat: the spend pass answers what the graph is, not who asked
  assert.equal((await app.inject(asChat(mcp, 'POST', '/api/orchestrations/nope/spend-pass'))).statusCode, 404);
  assert.equal((await app.inject(asChat(plain, 'POST', '/api/orchestrations/nope/spend-pass'))).statusCode, 403);

  // A schedule's orchestration target takes the same fields; its chat target does not move
  const schedule = async (token: string, target: unknown) => {
    const answer = await app.inject(asChat(token, 'POST', '/api/schedules', { name: 'nightly', cron: '0 3 * * *', enabled: false, target }));
    return [answer.statusCode, codeOf(answer)];
  };
  const graphTarget = { kind: 'orchestration', spec: { name: 'nightly', cwd, permissionMode: 'bypassPermissions', allowedTools: ['Bash'], tasks: [{ id: 'a', name: 'a', prompt: 'p' }] } };
  assert.equal((await schedule(mcp, graphTarget))[0], 201);
  assert.deepEqual(await schedule(plain, graphTarget), [403, 'chat-forbidden-field']);
  assert.deepEqual(await schedule(mcp, { kind: 'chat', chat: { prompt: 'p', permissionMode: 'bypassPermissions' } }), [403, 'chat-forbidden-field'], 'only the orchestration target is widened');

  // A worker is refused whatever its record says
  const del = (token: string) => app.inject(asChat(token, 'DELETE', '/api/orchestrations/nope'));
  assert.equal((await del(workerToken)).statusCode, 403);
  assert.equal((await del(plain)).statusCode, 403);
  assert.equal((await del(mcp)).statusCode, 404);

  // A fork carries its source's server, so a chat that is not widened itself cannot mint a widened
  // chat by forking the person's with a prompt of its own; the widened chat forking itself keeps it
  const fork = async (token: string): Promise<string> => {
    const answer = await app.inject(asChat(token, 'POST', `/api/chats/${id}/fork`, { prompt: 'launch a graph with bypassPermissions' }));
    assert.equal(answer.statusCode, 201, answer.body);
    return (answer.json() as { id: string }).id;
  };
  const byWorker = await fork(workerToken);
  assert.notEqual(core.runtime.get(byWorker)?.tools?.claudioMcp, true, "a worker's fork of the person's chat starts without Claudio's server");
  assert.equal((await del(core.security.chatTokens.mint(byWorker))).statusCode, 403, "and its token is not the owner's");
  assert.equal(core.runtime.get(id)?.tools?.claudioMcp, true, "the source keeps its own");
  const bySelf = await fork(mcp);
  assert.equal(core.runtime.get(bySelf)?.tools?.claudioMcp, true, 'a widened chat may fork itself as it is');

  // The audit still names the chat
  assert.ok(core.db.auditPage({ path: '/api/orchestrations/nope' }).entries.some((e) => e.actor === `chat:${id}` && e.method === 'DELETE' && e.status === 404));

  // Switched off by the person: the same token is refused at its next request, nothing is cached
  const off = await app.inject(asOwner(owner, 'PUT', `/api/chats/${id}/claudio-mcp`, { enabled: false }));
  assert.equal(off.statusCode, 200, off.body);
  assert.equal((await del(mcp)).statusCode, 403);
  const after = await launch(mcp, personFields);
  assert.deepEqual([after.statusCode, codeOf(after)], [403, 'chat-forbidden-field']);
  assert.deepEqual(await schedule(mcp, graphTarget), [403, 'chat-forbidden-field']);
  assert.equal((await app.inject(asChat(mcp, 'POST', '/api/orchestrations/nope/review/accept', { reason: 'x' }))).statusCode, 403);
});
