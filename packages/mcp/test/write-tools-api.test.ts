import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CLAUDIO_MCP_WRITE_TOOL_NAMES } from '../src/names.ts';
import { WRITE_TOOLS } from '../src/write-tools.ts';
import { FAKE_CLI, injectFetch, routeOf, seed, type SeenRequest, type Seeded } from './fixture.ts';

/*
 * Every write tool against the real API, its bodies included, with the e2e fake CLI behind the chats
 * and the orchestrations it starts. A stub answers whatever route it is told to, which is how a tool
 * calling a route that does not exist once passed (report §4.3): here every request each tool makes
 * must reach a route the router knows, be one of the routes the API documents (`ROUTE_DOCS`), and be
 * one the tool declares.
 */

let s: Seeded;
before(async () => {
  // What is under test is the route each tool reaches, not whether this machine has room for a chat
  // right now: the fake CLI is a few megabytes, and a busy host would refuse its start (system-load.ts)
  process.env.CLAUDIO_ADMIT_MEMORY_PRESSURE = '100';
  process.env.CLAUDIO_ADMIT_MEMORY_FLOOR_MB = '0';
  s = await seed({ claudeBin: FAKE_CLI });
});
after(async () => {
  delete process.env.CLAUDIO_ADMIT_MEMORY_PRESSURE;
  delete process.env.CLAUDIO_ADMIT_MEMORY_FLOOR_MB;
  await s.close();
});

const covered = new Set<string>();

/** Calls a tool and holds every request it made to the route table; `ok` says whether the call must succeed */
async function write(name: string, args: Record<string, unknown>, ok = true): Promise<{ isError: boolean; text: string; json: unknown }> {
  const from = s.seen.length;
  const out = await s.call(name, args);
  const tool = WRITE_TOOLS.find((t) => t.name === name);
  assert.ok(tool, name);
  const made = s.seen.slice(from);
  assert.ok(made.length > 0, `${name} made no request: ${out.text}`);
  for (const request of made) {
    const label = `${name}: ${request.method} ${request.url}`;
    assert.equal(request.routed, true, `${label} reached no route of the API`);
    const route = routeOf(request.method, request.url);
    assert.ok(route, `${label} is not a documented route`);
    assert.ok(tool.routes.includes(route), `${label} (${route}) is not among the routes ${name} declares`);
  }
  if (ok) assert.equal(out.isError, false, `${name}: ${out.text}`);
  covered.add(name);
  return out;
}

const idOf = (value: unknown): string => {
  assert.ok(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string', JSON.stringify(value));
  return value.id;
};

test('the work item tools: create, check a criterion, replace the checklist keeping ids and checks, move, comment', async () => {
  const created = await write('create_work_item', { projectId: s.project.id, title: 'Checkout total is wrong', type: 'bug', acceptanceCriteria: [{ text: 'totals add up' }, { text: 'taxes shown' }] });
  const key = (created.json as { key: string }).key;
  const read = async () => (await s.call('get_work_item', { item: key })).json as { acceptanceCriteria: Array<{ id: string; text: string; checked: boolean }>; status: string; comments?: unknown[] };
  const [first, second] = (await read()).acceptanceCriteria;
  assert.ok(first && second);

  await write('check_criterion', { item: key, criterionId: first.id, checked: true });
  assert.equal((await read()).acceptanceCriteria[0]?.checked, true);

  // The checklist the model read comes back with its ids: the check stays, the text changes, one is added and one removed
  await write('update_work_item', { item: key, priority: 'high', acceptanceCriteria: [{ id: first.id, text: 'totals add up, cents included' }, { text: 'a receipt is sent' }] });
  const after = (await read()).acceptanceCriteria;
  assert.deepEqual(
    after.map((c) => [c.id === first.id, c.text, c.checked]),
    [
      [true, 'totals add up, cents included', true],
      [false, 'a receipt is sent', false],
    ],
  );

  await write('move_work_item', { item: key, status: 'in_progress' });
  assert.equal((await read()).status, 'in_progress');
  await write('comment_work_item', { item: key, body: 'Looking into it.' });
});

test('the flow and proposal tools reach their routes; what they act on decides the answer', async () => {
  // run-1 ended done: the route answers that it cannot be retried, which is the call made and answered
  const retry = await write('retry_flow_run', { runId: 'run-1' }, false);
  assert.match(retry.text, /^retry_flow_run failed: 4\d\d/);
  for (const name of ['accept_assistant_proposal', 'discard_assistant_proposal']) {
    const out = await write(name, { proposalId: 'no-such-proposal' }, false);
    assert.match(out.text, /failed: 404/);
  }
});

test('the orchestration tools: plan, launch, stop, resume, retry a task', async () => {
  const plan = await write('plan_orchestration', { objective: 'Split the checkout module in two', projectId: s.project.id });
  const planner = idOf(plan.json);
  await s.core.runtime.waitForResult(planner);

  const launched = await write('launch_orchestration', {
    projectId: s.project.id,
    name: 'Checkout split',
    concurrency: 1,
    tasks: [
      { id: 'a', name: 'Extract totals', prompt: 'hello' },
      { id: 'b', name: 'Extract taxes', prompt: 'hello', dependsOn: ['a'] },
    ],
  });
  const id = idOf(launched.json);
  const stored = s.core.orchestrator.get(id);
  assert.equal(stored?.cwd, s.project.path, "the project's folder, from GET /projects");
  assert.deepEqual(stored?.tasks.map((t) => t.id), ['a', 'b']);

  await write('stop_orchestration', { orchestrationId: id });
  await write('resume_orchestration', { orchestrationId: id }, false);
  // Nothing failed, so the retry is refused by the route, not missed by the tool
  await write('retry_orchestration_task', { orchestrationId: id, taskId: 'b' }, false);
  await write('stop_orchestration', { orchestrationId: id }, false);
});

test("the chat tools: start in a project's folder, message, hint, interrupt, stop, resume and fork", async () => {
  const started = await write('start_chat', { prompt: 'hello', projectId: s.project.id, name: 'From the assistant' });
  const chat = idOf(started.json);
  assert.equal(s.core.runtime.get(chat)?.cwd, s.project.path);
  await s.core.runtime.waitForResult(chat);

  await write('send_chat_message', { chatId: chat, text: 'and one more thing' });
  await s.core.runtime.waitForResult(chat);
  // A hint needs a turn under way; between turns the route says so
  await write('hint_chat', { chatId: chat, text: 'look at the totals first' }, false);
  await write('interrupt_chat', { chatId: chat }, false);
  await write('stop_chat', { chatId: chat });
  await write('resume_chat', { chatId: chat, prompt: 'carry on' });
  await s.core.runtime.waitForResult(chat);
  const fork = await write('fork_chat', { chatId: chat, prompt: 'try another way' });
  assert.notEqual(idOf(fork.json), chat);
  await s.core.runtime.waitForResult(idOf(fork.json));
});

test('the check catches a tool that calls a route the API does not have', async () => {
  // The route start_chat once called: projects have no detail route
  const seen: SeenRequest[] = [];
  await injectFetch(s.app, seen)(`http://wrapper.test/api/projects/${s.project.id}`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000) });
  assert.equal(seen[0]?.routed, false);
  assert.equal(routeOf('GET', `/api/projects/${s.project.id}`), null);
  // A handler's own 404 is a route that exists
  await injectFetch(s.app, seen)('http://wrapper.test/api/orchestrations/nope', { method: 'GET', headers: {}, signal: AbortSignal.timeout(5_000) });
  assert.deepEqual([seen[1]?.status, seen[1]?.routed], [404, true]);
});

test('every write tool was driven against the real API', () => {
  assert.deepEqual([...covered].sort(), [...CLAUDIO_MCP_WRITE_TOOL_NAMES].sort());
});
