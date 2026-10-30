import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { CLAUDIO_MCP_READ_TOOLS, CLAUDIO_MCP_READ_TOOL_NAMES, CLAUDIO_MCP_WRITE_TOOL_NAMES } from '../src/names.ts';
import { createClient } from '../src/client.ts';
import { createServer, internalError } from '../src/server.ts';
import { TOOLS } from '../src/tools.ts';
import { WRITE_TOOLS } from '../src/write-tools.ts';
import { injectFetch, seed, type SeenRequest, type Seeded } from './fixture.ts';

let s: Seeded;
before(async () => {
  s = await seed();
});
after(() => s.close());

const rpc = (server: ReturnType<typeof createServer>, method: string, params?: unknown) =>
  server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })).then((line) => JSON.parse(line ?? 'null') as Record<string, any>);

test('the catalogue is the list of names, and every tool has a description and a strict schema', async () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    [...CLAUDIO_MCP_READ_TOOL_NAMES],
  );
  assert.deepEqual(WRITE_TOOLS.map((t) => t.name), [...CLAUDIO_MCP_WRITE_TOOL_NAMES]);
  assert.deepEqual(CLAUDIO_MCP_READ_TOOLS, CLAUDIO_MCP_READ_TOOL_NAMES.map((n) => `mcp__claudio__${n}`));
  const server = createServer({ api: createClient({ baseUrl: 'http://x/api', fetch: injectFetch(s.app) }), version: '1.2.3' });
  const listed = (await rpc(server, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { additionalProperties: unknown } }>;
  assert.deepEqual(listed.map((t) => t.name), [...CLAUDIO_MCP_READ_TOOL_NAMES, ...CLAUDIO_MCP_WRITE_TOOL_NAMES]);
  for (const tool of listed) {
    assert.ok(tool.description.length > 10, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  const init = (await rpc(server, 'initialize', { protocolVersion: '2024-11-05' })).result;
  assert.deepEqual([init.protocolVersion, init.serverInfo, init.capabilities], ['2024-11-05', { name: 'claudio', version: '1.2.3' }, { tools: {} }]);
  assert.equal((await rpc(server, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.equal((await rpc(server, 'nope')).error.code, -32601);
  assert.equal(JSON.parse((await server.handleLine('{not json')) ?? '').error.code, -32700);
});

test('every tool is called once and answers with the seeded data', async () => {
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ['list_projects', {}, 'Shop'],
    ['get_overview', {}, '{'],
    ['get_board', { projectId: s.project.id }, 'Cart loses items'],
    ['get_work_item', { item: s.item.key.toLowerCase() }, 'Cart loses items'],
    ['list_orchestrations', { limit: 5 }, s.orchestration.id],
    ['get_orchestration', { orchestrationId: s.orchestration.id }, s.orchestration.id],
    ['get_team', { projectId: s.project.id }, '{'],
    ['list_flow_runs', { projectId: s.project.id }, 'run-1'],
    ['get_journal', { projectId: s.project.id }, '{'],
    ['list_documents', { projectId: s.project.id }, 'plan.md'],
    ['read_document', { projectId: s.project.id, path: 'docs/plan.md' }, '# Shop plan'],
    ['list_chats', {}, '['],
    ['get_usage', { from: '2026-09-01', to: '2026-09-30' }, 'breakdown'],
    ['list_milestones', { projectId: s.project.id }, '['],
    ['list_assistant_proposals', { projectId: s.project.id }, '['],
    ['list_providers', {}, 'claude-code'],
    ['list_accounts', {}, 'default'],
  ];
  for (const [name, args, expected] of calls) {
    const result = await s.call(name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
    assert.ok(result.text.includes(expected), `${name} should mention ${expected}: ${result.text.slice(0, 200)}`);
  }
  // get_chat needs a chat: an unknown one is a 404, which is the call being made and answered
  const chat = await s.call('get_chat', { chatId: 'nope' });
  assert.equal(chat.isError, true);
  assert.match(chat.text, /404/);
  // A planner chat that never ran has no draft: the route is reached and answers so
  const plan = await s.call('get_orchestration_plan', { runId: 'nope' });
  assert.equal(plan.isError, true);
  assert.match(plan.text, /^get_orchestration_plan failed: 4\d\d/);
  const covered = new Set([...calls.map(([n]) => n), 'get_chat', 'get_orchestration_plan']);
  assert.deepEqual([...covered].sort(), [...CLAUDIO_MCP_READ_TOOL_NAMES].sort());
});

test('get_work_item merges the item, its history, links and flow runs, by key in any case or by id', async () => {
  for (const item of [s.item.key.toLowerCase(), s.item.key, s.item.id]) {
    const { json, isError } = await s.call('get_work_item', { item });
    assert.equal(isError, false, item);
    const detail = json as { title: string; status: string; history: unknown[]; links: unknown[]; runs: Array<{ id: string }> };
    assert.equal(detail.title, 'Cart loses items');
    assert.equal(detail.status, 'todo');
    assert.ok(detail.history.length >= 1);
    assert.ok(Array.isArray(detail.links));
    assert.deepEqual(detail.runs.map((r) => r.id), ['run-1']);
  }
});

test('an unknown id or key is an error result with the 404 text', async () => {
  for (const [name, args] of [['get_work_item', { item: `${s.item.key.split('-')[0]}-999` }], ['get_orchestration', { orchestrationId: 'nope' }], ['get_team', { projectId: 'nope' }]] as const) {
    const result = await s.call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /404/, name);
  }
});

test('an input that fails the schema is an error result and no request is made', async () => {
  const seen: SeenRequest[] = [];
  const server = createServer({ api: createClient({ baseUrl: 'http://x/api', fetch: injectFetch(s.app, seen) }), version: 't' });
  for (const args of [{}, { item: 5 }, { item: s.item.key, extra: true }]) {
    const out = (await rpc(server, 'tools/call', { name: 'get_work_item', arguments: args })).result;
    assert.equal(out.isError, true);
  }
  assert.equal((await rpc(server, 'tools/call', { name: 'get_chat', arguments: { chatId: '' } })).result.isError, true);
  assert.equal((await rpc(server, 'tools/call', { name: 'list_chats', arguments: { limit: 500 } })).result.isError, true);
  assert.equal((await rpc(server, 'tools/call', { name: 'no_such_tool', arguments: {} })).result.isError, true);
  assert.equal(seen.length, 0);
});

test('the token is sent when set, and not otherwise; the chat id stays with the server', async () => {
  const seen: SeenRequest[] = [];
  const fetch = injectFetch(s.app, seen);
  await createClient({ baseUrl: 'http://x/api', fetch }).get('/projects');
  assert.equal(seen[0]?.headers.authorization, undefined);
  const client = createClient({ baseUrl: 'http://x/api', token: 'tok', chatId: 'chat-1', fetch });
  await client.get('/projects', { a: 'b' });
  assert.equal(seen[1]?.headers.authorization, 'Bearer tok');
  assert.equal(seen[1]?.headers['x-claudio-chat'], undefined, 'the API never read it');
  assert.equal(seen[1]?.url, 'http://x/api/projects?a=b');
  assert.equal(client.chatId, 'chat-1');
});

test('a line whose handling throws is answered as an internal error with its id, and a notification gets nothing', () => {
  assert.deepEqual(JSON.parse(internalError(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' })) ?? ''), { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'internal error' } });
  assert.equal(JSON.parse(internalError('not json') ?? '').id, null);
  assert.equal(internalError(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), undefined);
});

test('a guarded API says what is missing, and a wrong wrapper is named', async () => {
  const guarded = createClient({ baseUrl: 'http://x/api', fetch: async () => ({ status: 401, text: async () => '{"error":"unauthorized"}' }) });
  await assert.rejects(guarded.get('/projects'), /guarded and this server was given no token/);
  const refused = createClient({ baseUrl: 'http://x/api', token: 'old', fetch: async () => ({ status: 401, text: async () => '{"error":"unauthorized"}' }) });
  await assert.rejects(refused.get('/projects'), /refused this chat's token/);
  const down = createClient({
    baseUrl: 'http://wrong.test:1/api',
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(down.get('/projects'), /could not reach http:\/\/wrong\.test:1\/api: ECONNREFUSED/);
});

test('packages/mcp/src holds no default URL or port', () => {
  const dir = fileURLToPath(new URL('../src', import.meta.url));
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(source, /localhost:|127\.0\.0\.1:|0\.0\.0\.0:/, file);
  }
});
