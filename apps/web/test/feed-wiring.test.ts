import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  ChatActivityEvent,
  ChatSummary,
  ClaudioEvent,
  HealthChangedEvent,
  Orchestration,
  OrchestrationSummary,
  OrchestrationTaskEvent,
  OrchestrationTaskState,
  RunUpdatedEvent,
  SpendChangedEvent,
  SpendState,
} from '@claudio/shared';
import { mcpKey } from '@claudio/chat-ui/composer/ServersPanel';
import { keys } from '../src/api';
import { loadChunk } from '../src/components/ReloadOffer';
import { applyEvent, onResync, patchActivity, patchOrchestrationTask, patchRun, subscribeEvents, targetMatches, targetsFor, type Target } from '../src/lib/events';
import { dispatchResync } from '../src/lib/feed';
import { setupGateState } from '../src/lib/first-run';
import { usageDay } from '../src/lib/usage-now';

// The app's one event handler: what each event makes stale, what it writes in place, and what is
// told when events were missed. A cache shaped otherwise than a patcher expects must cost that
// patch, never the rest of the event (report §10.1).

const task = (id: string): OrchestrationTaskState => ({ id, name: id, prompt: '', status: 'running' }) as OrchestrationTaskState;
const graph = { id: 'graph-1', name: 'redesign', engine: 'workflow', tasks: [task('a'), task('b')] } as unknown as Orchestration;

const activity = (over: Partial<ChatActivityEvent> = {}): ChatActivityEvent => ({
  id: 1,
  at: '2026-10-29T10:00:00.000Z',
  title: 'demo is using Edit',
  type: 'chat.activity',
  runId: 'chat-1',
  runName: 'demo',
  sessionId: 'chat-1',
  orchestrationId: 'graph-1',
  internal: false,
  taskId: 'b',
  activity: { kind: 'tool', tool: 'Edit', target: 'src/app.ts', since: '2026-10-29T10:00:00.000Z' },
  ...over,
});

const moved: OrchestrationTaskEvent = {
  id: 2,
  at: '2026-10-29T10:01:00.000Z',
  title: 'Task b completed',
  type: 'orchestration.task',
  orchestrationId: 'graph-1',
  orchestrationName: 'redesign',
  taskId: 'b',
  taskName: 'b',
  status: 'completed',
  previousStatus: 'running',
  runId: 'chat-b',
  error: null,
};

/** What a workflow orchestration's page and the other lists under the same prefixes put in the cache. */
function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.orchestrations, [graph]);
  client.setQueryData(keys.orchestrationTemplates, [{ id: 'tpl-1', name: 'template' }]);
  client.setQueryData(keys.planDrafts, [{ runId: 'plan-1' }]);
  client.setQueryData(keys.orchestration('graph-1'), graph);
  client.setQueryData(keys.orchestrationWorkflow('graph-1'), { path: '.claude/workflows/x.js', script: 'export default 1' });
  client.setQueryData(keys.orchestrationWorkflowRun('graph-1', 'run-1'), { chat: { id: 'run-1' }, entries: [] });
  client.setQueryData(keys.orchestrationReview('graph-1'), { rounds: [] });
  return client;
}

test("a workflow orchestration's page keeps its reads under the graph's key, never under the list's", () => {
  for (const key of [keys.orchestrationWorkflow('g'), keys.orchestrationWorkflowRun('g', 'r')]) {
    assert.deepEqual(key.slice(0, 2), keys.orchestration('g'));
    assert.notEqual(key[0], keys.orchestrations[0]);
  }
});

test('the patchers write the graphs and leave every other read under the prefixes alone', () => {
  const client = seeded();
  const before = client.getQueryData(keys.orchestrationWorkflow('graph-1'));
  assert.doesNotThrow(() => patchActivity(client, activity()));
  assert.doesNotThrow(() => patchOrchestrationTask(client, moved));

  assert.equal(client.getQueryData<Orchestration>(keys.orchestration('graph-1'))?.tasks[1]?.activity?.tool, 'Edit');
  const list = client.getQueryData<OrchestrationSummary[]>(keys.orchestrations);
  assert.equal(list?.[0]?.tasks[1]?.status, 'completed');
  assert.equal(client.getQueryData(keys.orchestrationWorkflow('graph-1')), before, 'the workflow script is not a graph');
  assert.deepEqual(client.getQueryData(keys.orchestrationTemplates), [{ id: 'tpl-1', name: 'template' }]);
});

test('a non-list under a list prefix is left alone, even the old keys a page left in the cache', () => {
  const client = new QueryClient();
  // Where the orchestration page used to keep its workflow, and a chat count under the chats' prefix
  client.setQueryData(['orchestrations', 'graph-1', 'workflow'], { path: 'x', script: 'y' });
  client.setQueryData(['orchestrations', 'graph-1', 'workflow-run', 'run-1'], { chat: { id: 'run-1' } });
  client.setQueryData([...keys.chats, 'count'], { total: 3 });
  client.setQueryData(keys.overview, { recentChats: null });
  const run: RunUpdatedEvent = {
    id: 3, at: '2026-10-29T10:02:00.000Z', title: 'demo', type: 'run.updated', runId: 'chat-1', runName: 'demo', sessionId: 'chat-1',
    orchestrationId: null, internal: false, status: 'running', previousStatus: null, turns: 1, costUsd: 0.1, pendingPrompts: 0, lastText: null,
  } as unknown as RunUpdatedEvent;
  assert.doesNotThrow(() => patchActivity(client, activity()));
  assert.doesNotThrow(() => patchOrchestrationTask(client, moved));
  assert.doesNotThrow(() => patchRun(client, run));
  assert.deepEqual(client.getQueryData([...keys.chats, 'count']), { total: 3 });
});

test('a patcher that throws costs only its own write: the stale reads are scheduled and every listener hears the event', () => {
  const client = new QueryClient();
  // A list whose entry is broken: the patcher of `orchestration.task` throws on it
  client.setQueryData(keys.orchestrations, [{ id: 'graph-1', name: 'redesign', tasks: [null] }]);
  const scheduled: Target[] = [];
  const heard: ClaudioEvent[] = [];
  const stop = subscribeEvents((event) => heard.push(event));
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => applyEvent(client, (targets) => scheduled.push(...targets), moved));
  } finally {
    console.error = quiet;
    stop();
  }
  assert.deepEqual(heard, [moved]);
  const named = new Set(scheduled.map((target) => JSON.stringify(target)));
  for (const target of targetsFor(moved)) assert.ok(named.has(JSON.stringify(target)), JSON.stringify(target[0]));
});

test('the stale reads are scheduled and the listeners told before any patch runs', () => {
  const client = seeded();
  const order: string[] = [];
  const stop = subscribeEvents(() => order.push(`heard:${String(client.getQueryData<OrchestrationSummary[]>(keys.orchestrations)?.[0]?.tasks[1]?.status)}`));
  applyEvent(client, (targets) => targets.length > 0 && order.push('scheduled'), moved);
  stop();
  assert.equal(order[0], 'scheduled');
  assert.equal(order[1], 'heard:running', 'the listener runs before the list is patched');
  assert.equal(client.getQueryData<OrchestrationSummary[]>(keys.orchestrations)?.[0]?.tasks[1]?.status, 'completed', 'and the patch still runs after it');
});

test('a resync tells every listener, and one that throws does not deafen the rest', () => {
  const calls: string[] = [];
  const stops = [
    onResync(() => calls.push('first')),
    onResync(() => {
      throw new Error('broken listener');
    }),
    onResync(() => calls.push('third')),
  ];
  dispatchResync();
  assert.deepEqual(calls, ['first', 'third']);
  for (const stop of stops) stop();
  dispatchResync();
  assert.deepEqual(calls, ['first', 'third'], 'an unsubscribed listener hears nothing more');
});

// ---------- the MCP servers of a chat's process (report §10.2) ----------

const reaches = (targets: Target[], key: QueryKey) => targets.some((target) => targetMatches(target, key));
const chat = { id: 'chat-1', execution: { id: 'exec-1' } } as unknown as ChatSummary & { execution: { id: string } };

test("the servers' read is outside the chat's scope: a branch or status event never asks the CLI again", () => {
  const key = mcpKey(chat);
  assert.notDeepEqual(key.slice(0, 2), keys.chatScope('chat-1'));
  const statusChange = { type: 'run.updated', runId: 'chat-1', sessionId: 'chat-1', previousStatus: 'idle', status: 'running', orchestrationId: null } as unknown as ClaudioEvent;
  const subagent = { type: 'subagent.started', runId: 'chat-1', sessionId: 'chat-1' } as unknown as ClaudioEvent;
  const sessions = { type: 'sessions.changed' } as unknown as ClaudioEvent;
  for (const event of [statusChange, subagent, sessions]) assert.equal(reaches(targetsFor(event), key), false, event.type);
});

test('health moving reads the servers again, and a new process has a key of its own', () => {
  const health = { type: 'health.changed', runId: 'chat-1', sessionId: 'chat-1', orchestrationId: null } as unknown as HealthChangedEvent;
  assert.equal(reaches(targetsFor(health), mcpKey(chat)), true);
  assert.notDeepEqual(mcpKey({ id: 'chat-1', execution: { id: 'exec-2' } } as never), mcpKey(chat));
});

// ---------- what a tool call changes (the polls that follow the feed) ----------

test('an edit reads the chat’s changes again, a checklist tool its plan, and other calls nothing', () => {
  const edit = targetsFor(activity());
  assert.equal(reaches(edit, keys.chatChanges('chat-1')), true);
  assert.equal(reaches(edit, keys.chatSteps('chat-1')), true);
  const plan = targetsFor(activity({ activity: { kind: 'tool', tool: 'TodoWrite', since: '2026-10-29T10:00:00.000Z' } }));
  assert.equal(reaches(plan, ['chat', 'chat-1', 'checklist']), true);
  assert.equal(reaches(plan, [...keys.orchestration('graph-1'), 'checklist', 'b']), true, "a worker's plan sits under its graph");
  assert.deepEqual(targetsFor(activity({ activity: { kind: 'tool', tool: 'Bash', since: '2026-10-29T10:00:00.000Z' } })), []);
  assert.deepEqual(targetsFor(activity({ activity: { kind: 'thinking', since: '2026-10-29T10:00:00.000Z' } })), []);
});

test('the audit log is read again as the feed moves, at a slow pace', () => {
  const scheduled: Target[] = [];
  applyEvent(new QueryClient(), (targets) => scheduled.push(...targets), { type: 'sessions.changed', id: 9 } as unknown as ClaudioEvent);
  const audit = scheduled.find((target) => targetMatches(target, keys.audit({ from: 0 })));
  assert.ok(audit && audit[1] >= 10_000);
});

// ---------- "Today" (report §10.4) ----------

const spend = (day: string): SpendState => ({ day, timezone: 'UTC' }) as SpendState;

test("'Today' is the server's day, and the browser's only when the server's cannot be read", () => {
  const evening = new Date(2026, 9, 29, 23, 30);
  assert.equal(usageDay({ data: spend('2026-10-30'), isError: false }, evening), '2026-10-30');
  assert.equal(usageDay({ data: undefined, isError: false }, evening), undefined, 'nothing is read for a day still unknown');
  assert.equal(usageDay({ data: undefined, isError: true }, evening), '2026-10-29');
});

test("a change of spend writes the meter and reads that day's usage again", () => {
  const event: SpendChangedEvent = { id: 4, at: '2026-10-30T00:10:00.000Z', title: 'spend', type: 'spend.changed', spend: spend('2026-10-30') };
  const client = new QueryClient();
  const scheduled: Target[] = [];
  applyEvent(client, (targets) => scheduled.push(...targets), event);
  assert.equal(client.getQueryData<SpendState>(keys.spend)?.day, '2026-10-30');
  assert.equal(reaches(scheduled, keys.usage({ from: '2026-10-30', to: '2026-10-30' })), true);
  assert.equal(reaches(scheduled, keys.usage({ from: '2026-10-29', to: '2026-10-29' })), false);
});

// ---------- the first-run gate (report §10.6) ----------

test('a failed refetch with data held keeps the setup assistant; a read that never answered hides it', () => {
  const seen = (setupSeen: boolean, isError = false) => ({ data: { setupSeen }, isError });
  const setup = (s: boolean | undefined, isError = false) => ({ data: s === undefined ? undefined : { seen: s }, isError });
  assert.equal(setupGateState(seen(false, true), setup(false, true), false), 'shown', 'held data wins over a failed refetch');
  assert.equal(setupGateState({ data: undefined, isError: true }, setup(undefined), false), 'hidden');
  assert.equal(setupGateState(seen(false), setup(undefined, true), false), 'hidden');
  assert.equal(setupGateState({ data: undefined, isError: false }, setup(undefined), false), 'pending');
  assert.equal(setupGateState(seen(false), setup(undefined), false), 'pending');
  assert.equal(setupGateState(seen(true), setup(undefined), false), 'hidden');
  assert.equal(setupGateState(seen(false), setup(true), false), 'hidden');
  assert.equal(setupGateState(seen(false), setup(false), true), 'hidden', 'finished in this page');
});

// ---------- a lazy chunk that fails once (report §10.7) ----------

const chunkError = () => new TypeError('Failed to fetch dynamically imported module: /assets/Usage-abc.js');
const noWait = async () => {};

test('a chunk that fails once is asked for again and loads', async () => {
  let calls = 0;
  const page = await loadChunk(async () => {
    calls++;
    if (calls === 1) throw chunkError();
    return 'page';
  }, noWait);
  assert.equal(page, 'page');
  assert.equal(calls, 2);
});

test('a chunk that fails twice is gone, and any other failure is thrown as it is', async () => {
  let calls = 0;
  assert.equal(
    await loadChunk(async () => {
      calls++;
      throw chunkError();
    }, noWait),
    null,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    loadChunk(async () => {
      throw new RangeError('a bug in the page');
    }, noWait),
    RangeError,
  );
});
