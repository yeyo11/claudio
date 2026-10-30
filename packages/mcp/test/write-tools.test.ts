import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDIO_MCP_READ_TOOLS, CLAUDIO_MCP_WRITE_TOOLS, CLAUDIO_MCP_WRITE_TOOL_NAMES, isClaudioMcpWriteTool } from '../src/names.ts';
import { createClient, type FetchLike } from '../src/client.ts';
import { createServer } from '../src/server.ts';
import { COLLAB_TOOLS } from '../src/collab-tools.ts';
import { TOOLS } from '../src/tools.ts';
import { WRITE_TOOLS } from '../src/write-tools.ts';
import { ROUTE_DOCS } from '../../../apps/api/src/openapi/routes.ts';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** A stand-in for the API: it records each request and answers from a table by `METHOD /path` */
function stub(routes: Record<string, { status?: number; body: unknown }>, chatId = 'c1') {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    seen.push({ method: init.method, url: path, authorization: init.headers.authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const route = routes[`${init.method} ${path}`] ?? { status: 404, body: { error: 'not found' } };
    return { status: route.status ?? 200, text: async () => JSON.stringify(route.body) };
  };
  const server = createServer({ api: createClient({ baseUrl: 'http://x/api', token: 'tok', chatId, fetch }), version: 't' });
  let n = 0;
  const call = async (name: string, args: unknown) => {
    const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }));
    const result = (JSON.parse(line ?? 'null') as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    return { isError: result.isError, text: result.content[0]?.text ?? '' };
  };
  return { seen, call };
}

const item = { id: 'item_one', key: 'AGN-7', title: 'Cart', status: 'todo', description: 'long text that is not echoed', history: [1, 2, 3] };

test('the write tools are named and never pre-allowed', () => {
  assert.equal(CLAUDIO_MCP_WRITE_TOOL_NAMES.length, 20);
  for (const tool of CLAUDIO_MCP_WRITE_TOOLS) {
    assert.ok(isClaudioMcpWriteTool(tool));
    assert.ok(!CLAUDIO_MCP_READ_TOOLS.includes(tool));
  }
});

const draft = {
  name: 'Split the API',
  cwd: '/work/shop',
  objective: 'split it',
  permissionMode: 'bypassPermissions',
  allowedTools: ['Bash'],
  guards: { enabled: false },
  tasks: [{ id: 'a', name: 'A', prompt: 'do a', cwd: '/elsewhere', workItemId: 'w1' }],
};

test('each tool sends its routes, its body and the token, and nothing that widens what runs', async () => {
  const s = stub({
    'GET /projects': { body: [{ id: 'p1', path: '/work/shop' }, { id: 'p2', path: '/work/other' }] },
    'POST /projects/p1/work-items': { status: 201, body: item },
    'GET /work-items/by-key/AGN-7': { body: item },
    'PATCH /work-items/item_one': { body: item },
    'PATCH /work-items/item_one/criteria/cr-1': { body: item },
    'POST /work-items/item_one/move': { body: { item, column: { status: 'in_progress', count: 2 } } },
    'POST /work-items/item_one/comments': { status: 201, body: { id: 'cm-1', body: 'hello' } },
    'POST /flow-runs/run-1/retry': { status: 201, body: { id: 'run-2', state: 'queued', error: null } },
    'POST /orchestrations/plan/start': { status: 201, body: { id: 'planner-1', state: 'working' } },
    'GET /orchestrations/plans/planner-1': { body: draft },
    'POST /orchestrations': { status: 201, body: { id: 'o2', name: 'Split the API', status: 'running', tasks: [1] } },
    'POST /orchestrations/o1/stop': { body: { id: 'o1', status: 'stopped' } },
    'POST /orchestrations/o1/resume': { body: { id: 'o1', status: 'running' } },
    'POST /orchestrations/o1/tasks/t1/retry': { body: { id: 'o1', state: 'running', tasks: [1, 2, 3] } },
    'POST /chats': { status: 201, body: { id: 'chat-9', state: 'working' } },
    'POST /chats/chat-9/messages': { body: { id: 'chat-9', state: 'working', message: { id: 'm1', state: 'written' } } },
    'POST /chats/chat-9/hint': { body: { id: 'chat-9', state: 'working' } },
    'POST /chats/chat-9/interrupt': { body: { id: 'chat-9', state: 'idle' } },
    'POST /chats/chat-9/stop': { body: { id: 'chat-9', state: 'idle' } },
    'POST /chats/chat-9/resume': { body: { id: 'chat-9', state: 'working' } },
    'POST /chats/chat-9/fork': { status: 201, body: { id: 'chat-10', state: 'working' } },
    'POST /assistant/proposals/pr1/accept': { body: { id: 'pr1', status: 'accepted' } },
    'POST /assistant/proposals/pr1/discard': { body: { id: 'pr1', status: 'discarded' } },
  });
  const criteria = [{ id: 'cr-1', text: 'still holds' }, { text: 'new one' }];
  const calls: Array<[string, Record<string, unknown>, string, string, unknown]> = [
    ['create_work_item', { projectId: 'p1', title: 'Cart', labels: ['a'], acceptanceCriteria: [{ text: 'works' }] }, 'POST', '/projects/p1/work-items', { title: 'Cart', labels: ['a'], acceptanceCriteria: [{ text: 'works' }] }],
    ['update_work_item', { item: 'agn-7', priority: 'high', acceptanceCriteria: criteria }, 'PATCH', '/work-items/item_one', { priority: 'high', acceptanceCriteria: criteria }],
    ['check_criterion', { item: 'AGN-7', criterionId: 'cr-1', checked: true }, 'PATCH', '/work-items/item_one/criteria/cr-1', { checked: true }],
    ['move_work_item', { item: 'item_one', status: 'in_progress', afterId: 'x' }, 'POST', '/work-items/item_one/move', { status: 'in_progress', afterId: 'x' }],
    ['comment_work_item', { item: 'AGN-7', body: 'hello' }, 'POST', '/work-items/item_one/comments', { body: 'hello' }],
    ['retry_flow_run', { runId: 'run-1' }, 'POST', '/flow-runs/run-1/retry', {}],
    ['plan_orchestration', { objective: 'split the API', projectId: 'p1', maxTasks: 4 }, 'POST', '/orchestrations/plan/start', { objective: 'split the API', cwd: '/work/shop', maxTasks: 4 }],
    [
      'launch_orchestration',
      { fromPlan: 'planner-1', concurrency: 2 },
      'POST',
      '/orchestrations',
      { name: 'Split the API', objective: 'split it', concurrency: 2, cwd: '/work/shop', tasks: [{ id: 'a', name: 'A', prompt: 'do a' }], plannerRunId: 'planner-1' },
    ],
    ['stop_orchestration', { orchestrationId: 'o1' }, 'POST', '/orchestrations/o1/stop', {}],
    ['resume_orchestration', { orchestrationId: 'o1' }, 'POST', '/orchestrations/o1/resume', {}],
    ['retry_orchestration_task', { orchestrationId: 'o1', taskId: 't1' }, 'POST', '/orchestrations/o1/tasks/t1/retry', {}],
    ['start_chat', { prompt: 'go', projectId: 'p1', model: 'sonnet', name: 'Go' }, 'POST', '/chats', { prompt: 'go', cwd: '/work/shop', model: 'sonnet', name: 'Go' }],
    ['send_chat_message', { chatId: 'chat-9', text: 'and then?' }, 'POST', '/chats/chat-9/messages', { text: 'and then?' }],
    ['hint_chat', { chatId: 'chat-9', text: 'look at the logs' }, 'POST', '/chats/chat-9/hint', { text: 'look at the logs' }],
    ['interrupt_chat', { chatId: 'chat-9' }, 'POST', '/chats/chat-9/interrupt', {}],
    ['stop_chat', { chatId: 'chat-9' }, 'POST', '/chats/chat-9/stop', {}],
    ['resume_chat', { chatId: 'chat-9', prompt: 'again' }, 'POST', '/chats/chat-9/resume', { prompt: 'again' }],
    ['fork_chat', { chatId: 'chat-9', prompt: 'another way' }, 'POST', '/chats/chat-9/fork', { prompt: 'another way' }],
    ['accept_assistant_proposal', { proposalId: 'pr1' }, 'POST', '/assistant/proposals/pr1/accept', {}],
    ['discard_assistant_proposal', { proposalId: 'pr1' }, 'POST', '/assistant/proposals/pr1/discard', {}],
  ];
  const covered: string[] = [];
  for (const [name, args, method, path, body] of calls) {
    s.seen.length = 0;
    const out = await s.call(name, args);
    assert.equal(out.isError, false, `${name}: ${out.text}`);
    const sent = s.seen.at(-1);
    assert.deepEqual([sent?.method, sent?.url, sent?.body], [method, path, body], name);
    assert.ok(s.seen.every((r) => r.authorization === 'Bearer tok'), name);
    // Every request it made is one of the routes it declares
    const tool = WRITE_TOOLS.find((t) => t.name === name);
    for (const r of s.seen) assert.ok(tool?.routes.some((route) => matches(route, r.method, r.url)), `${name} called ${r.method} ${r.url}, which it does not declare`);
    covered.push(name);
  }
  assert.deepEqual(covered, [...CLAUDIO_MCP_WRITE_TOOL_NAMES]);
});

/** Whether `METHOD /pattern` names this request */
function matches(route: string, method: string, url: string): boolean {
  const [m, pattern = ''] = route.split(' ');
  const want = pattern.split('/');
  const got = url.split('/');
  return m === method && want.length === got.length && want.every((w, i) => (w.startsWith(':') ? got[i] !== '' : w === got[i]));
}

test('every route a tool declares is a route of the API, and a chat token may call it (work)', () => {
  const docs = ROUTE_DOCS as Record<string, { access?: string }>;
  for (const tool of [...TOOLS, ...WRITE_TOOLS, ...COLLAB_TOOLS]) {
    assert.ok(tool.routes.length > 0, `${tool.name} declares its routes`);
    for (const route of tool.routes) {
      assert.ok(route in docs, `${tool.name} calls ${route}, which the API does not have`);
      // A GET is `work` unless it says otherwise; a write must say (C1). `person` is never reachable with a chat's token
      assert.equal(docs[route]?.access ?? 'work', 'work', `${tool.name} calls ${route}, which only a person may call`);
    }
  }
});

test('the chat lifecycle tools refuse to act on the chat they run in, before any request', async () => {
  const s = stub({}, 'chat-9');
  for (const [name, args] of [
    ['stop_chat', { chatId: 'chat-9' }],
    ['interrupt_chat', { chatId: 'chat-9' }],
    ['send_chat_message', { chatId: 'chat-9', text: 'x' }],
    ['hint_chat', { chatId: 'chat-9', text: 'x' }],
  ] as const) {
    const out = await s.call(name, args);
    assert.equal(out.isError, true, name);
    assert.match(out.text, /cannot \w+ itself/);
  }
  assert.equal(s.seen.length, 0);
});

test('a project that does not exist is named plainly, and nothing is written', async () => {
  const s = stub({ 'GET /projects': { body: [{ id: 'p1', path: '/work/shop' }] } });
  for (const [name, args] of [
    ['start_chat', { prompt: 'go', projectId: 'nope' }],
    ['plan_orchestration', { objective: 'x', projectId: 'nope' }],
    ['launch_orchestration', { projectId: 'nope', name: 'x', tasks: [{ id: 'a', name: 'a', prompt: 'p' }] }],
  ] as const) {
    const out = await s.call(name, args);
    assert.equal(out.isError, true, name);
    assert.match(out.text, /no project has the id nope/);
  }
  assert.deepEqual([...new Set(s.seen.map((r) => r.method))], ['GET']);
});

test('launch_orchestration needs tasks or a plan, a project and a name', async () => {
  const s = stub({ 'GET /projects': { body: [{ id: 'p1', path: '/work/shop' }] } });
  assert.match((await s.call('launch_orchestration', { projectId: 'p1', name: 'x' })).text, /needs tasks/);
  assert.match((await s.call('launch_orchestration', { name: 'x', tasks: [{ id: 'a', name: 'a', prompt: 'p' }] })).text, /needs a project/);
  assert.match((await s.call('launch_orchestration', { projectId: 'p1', tasks: [{ id: 'a', name: 'a', prompt: 'p' }] })).text, /needs a name/);
  assert.equal(s.seen.filter((r) => r.method === 'POST').length, 0);
});

test('a key is resolved through the by-key route, an id is not', async () => {
  const s = stub({ 'GET /work-items/by-key/AGN-7': { body: item }, 'POST /work-items/item_one/comments': { status: 201, body: { id: 'cm' } } });
  await s.call('comment_work_item', { item: 'agn-7', body: 'x' });
  assert.deepEqual(s.seen.map((r) => `${r.method} ${r.url}`), ['GET /work-items/by-key/AGN-7', 'POST /work-items/item_one/comments']);
  s.seen.length = 0;
  await s.call('comment_work_item', { item: 'item_one', body: 'x' });
  assert.deepEqual(s.seen.map((r) => `${r.method} ${r.url}`), ['POST /work-items/item_one/comments']);
});

test('the result carries what identifies it and nothing of the rest', async () => {
  const s = stub({ 'PATCH /work-items/item_one': { body: item } });
  const out = await s.call('update_work_item', { item: 'item_one', title: 'Cart' });
  assert.deepEqual(JSON.parse(out.text), { id: 'item_one', key: 'AGN-7', title: 'Cart', status: 'todo' });
});

test('move_work_item refuses done without calling the API', async () => {
  const s = stub({});
  const out = await s.call('move_work_item', { item: 'item_one', status: 'done' });
  assert.equal(out.isError, true);
  assert.match(out.text, /Done themselves/);
  assert.equal(s.seen.length, 0);
});

test('no tool that starts work has a field that widens it, and none is sent', async () => {
  const s = stub({ 'POST /chats': { status: 201, body: { id: 'c' } } });
  const widening = ['permissionMode', 'allowedTools', 'disallowedTools', 'toolPreset', 'mcp', 'account', 'confine', 'permissionPrompts', 'guards', 'verification'];
  for (const name of ['start_chat', 'resume_chat', 'fork_chat', 'launch_orchestration', 'resume_orchestration', 'plan_orchestration', 'send_chat_message']) {
    for (const field of widening) {
      const out = await s.call(name, { prompt: 'go', [field]: field === 'mcp' ? null : 'bypassPermissions' });
      assert.equal(out.isError, true, `${name} ${field}`);
      assert.match(out.text, /unknown argument/);
    }
  }
  const task = await s.call('launch_orchestration', { projectId: 'p1', name: 'x', tasks: [{ id: 'a', name: 'a', prompt: 'p', cwd: '/' }] });
  assert.match(task.text, /unknown argument: tasks\[0\]\.cwd/);
  assert.equal(s.seen.length, 0);
});

test('an input the schema rejects makes no request', async () => {
  const s = stub({});
  const bad: Array<[string, unknown]> = [
    ['create_work_item', { projectId: 'p1' }],
    ['create_work_item', { projectId: 'p1', title: 'x', type: 'saga' }],
    ['create_work_item', { projectId: 'p1', title: 'x', acceptanceCriteria: [{ text: 'a', extra: 1 }] }],
    ['create_work_item', { projectId: 'p1', title: 'x', labels: 'a' }],
    ['update_work_item', { item: 'item_one', status: 'done' }],
    ['move_work_item', { item: 'item_one', status: 'later' }],
    ['comment_work_item', { item: 'item_one', body: '' }],
    ['retry_flow_run', {}],
    ['retry_orchestration_task', { orchestrationId: 'o1' }],
    ['accept_assistant_proposal', { proposalId: 'p', extra: true }],
    ['discard_assistant_proposal', { proposalId: 5 }],
  ];
  for (const [name, args] of bad) assert.equal((await s.call(name, args)).isError, true, `${name} ${JSON.stringify(args)}`);
  assert.equal(s.seen.length, 0);
});

test('a 4xx from the route is an error result with its status and text, and nothing is retried', async () => {
  const s = stub({ 'POST /flow-runs/run-1/retry': { status: 409, body: { error: 'the run is not failed' } } });
  const out = await s.call('retry_flow_run', { runId: 'run-1' });
  assert.equal(out.isError, true);
  assert.match(out.text, /409: the run is not failed/);
  assert.equal(s.seen.length, 1);
});
