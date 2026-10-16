import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ChatActivity, ClaudioEvent } from '@claudio/shared';
import { toChatSubagent, toChildren } from '../src/chat-branches.ts';
import { foldEvent } from '../src/chat-fold.ts';
import { ChatManager, type ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { RunEventPublisher } from '../src/event-sources.ts';
import { EventBus } from '../src/events.ts';
import { LiveChat, type ChatHost } from '../src/live-chat.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import type { DriverSession } from '../src/providers/driver.ts';
import { tempConfig } from './helpers.ts';

// What a subagent is doing right now, read from its own sidechain on the stream: one ticker per
// running subagent, keyed by the call that launched it, fed by its calls and results only, and
// gone when it reports back, when its task notification ends it, and when the turn or the process
// ends. Then the feed: `subagent.activity`, under the same one-second window as `chat.activity`.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

/** What the fold asks of the manager, none of which a ticker depends on. */
const host = {
  db: {},
  modelIds: { record: () => {} },
  environments: new Map(),
  permissions: null,
  emit: () => {},
  persist: () => {},
  noteActivity: () => {},
  observeLimit: () => {},
  observeSignIn: () => {},
  learnModelCosts: () => {},
  learnWindows: () => {},
  maybeLimit: () => {},
  recordSpend: () => {},
  failProtocol: () => {},
} as unknown as ChatHost;

interface Rig {
  chat: LiveChat;
  /** One stream-json line, as the CLI writes it */
  line(raw: Record<string, unknown>): void;
  /** The subagent launched by `toolUseId`, as the chat's summary reports it */
  sub(toolUseId: string): ChatRuntime['subagents'][number] | undefined;
}

/** A chat with a process that looks alive, read through the real Claude Code stream parser. */
function rig(): Rig {
  const driver = new ClaudeCodeDriver('claude');
  const chat = new LiveChat('sess-1', { prompt: 'p', cwd: '/work' }, {}, 'claudio', null, { workspaceDir: '/work', defaultPermissionMode: 'manual' }, driver, true);
  chat.proc = { pid: 1, exitCode: null, signalCode: null } as unknown as ChildProcessWithoutNullStreams;
  const session: DriverSession = driver.attach({ write: () => true, end: () => {}, up: () => true }, (event) => foldEvent(host, chat, event), chat.branches);
  return {
    chat,
    line: (raw) => session.readLine(JSON.stringify(raw)),
    sub: (toolUseId) => chat.summary().subagents.find((s) => s.toolUseId === toolUseId),
  };
}

const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const answer = (id: string, parent: string | null = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const agent = (id: string, description: string, background = false) =>
  call(id, 'Agent', { description, subagent_type: 'Explore', prompt: 'Look around', ...(background ? { run_in_background: true } : {}) });

test("a sidechain's calls feed its own ticker, and the main agent's ignores them", () => {
  const { chat, line, sub } = rig();
  line(agent('toolu_a', 'Find the feed'));
  assert.equal(sub('toolu_a')?.activity, undefined, 'a subagent that has called nothing has no ticker yet');

  line(call('toolu_r', 'Read', { file_path: '/work/packages/core/src/chats.ts' }, 'toolu_a'));
  const activity = sub('toolu_a')?.activity;
  assert.deepEqual(activity, { kind: 'tool', tool: 'Read', target: 'packages/core/src/chats.ts', since: activity?.since ?? '' } satisfies ChatActivity);
  assert.equal(chat.summary().activity?.tool, 'Agent', "the chat is still doing what it was: waiting on the call that launched it");

  // Two subagents side by side each have their own line
  line(agent('toolu_b', 'Check the tests'));
  line(call('toolu_g', 'Grep', { pattern: 'activityKey' }, 'toolu_b'));
  assert.equal(sub('toolu_b')?.activity?.target, 'activityKey');
  assert.equal(sub('toolu_a')?.activity?.tool, 'Read');

  line(answer('toolu_r', 'toolu_a'));
  assert.equal(sub('toolu_a')?.activity, null, 'a subagent with no open call reads as just working');
  assert.equal(chat.branchActivity.size, 2, 'it is still running, so its ticker stays');
});

test("the result of the call that launched a subagent clears its ticker", () => {
  const { chat, line, sub } = rig();
  line(agent('toolu_a', 'Find the feed'));
  line(call('toolu_r', 'Read', { file_path: '/work/a.ts' }, 'toolu_a'));
  line(answer('toolu_a'));
  assert.equal(chat.branchActivity.has('toolu_a'), false);
  assert.equal(sub('toolu_a')?.status, 'completed');
  assert.equal(sub('toolu_a')?.activity, undefined);
  // A late line of the agent that reported back does not bring a ticker back
  line(call('toolu_late', 'Read', { file_path: '/work/b.ts' }, 'toolu_a'));
  assert.equal(chat.branchActivity.has('toolu_a'), false);
});

test("a background subagent keeps its ticker past its launch result, until its task notification", () => {
  const { chat, line, sub } = rig();
  line(agent('toolu_a', 'Watch the build', true));
  line({ type: 'system', subtype: 'task_started', task_id: 'agent-1', task_type: 'local_agent', tool_use_id: 'toolu_a', is_backgrounded: true });
  line(answer('toolu_a'));
  line(call('toolu_b', 'Bash', { command: 'pnpm build' }, 'toolu_a'));
  assert.equal(sub('toolu_a')?.activity?.target, 'pnpm build');
  // Its launch result said "launched", and a repeat of it changes nothing
  line(answer('toolu_a'));
  assert.equal(sub('toolu_a')?.activity?.target, 'pnpm build');

  line({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'completed', summary: 'built' });
  assert.equal(chat.branchActivity.has('toolu_a'), false);
  assert.equal(sub('toolu_a')?.status, 'completed');
});

test('the end of the turn clears every ticker, and a process that is gone reports none', () => {
  const { chat, line, sub } = rig();
  line(agent('toolu_a', 'Find the feed'));
  line(call('toolu_r', 'Read', { file_path: '/work/a.ts' }, 'toolu_a'));
  line({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0 });
  assert.equal(chat.branchActivity.size, 0);

  line(agent('toolu_b', 'Again'));
  line(call('toolu_s', 'Read', { file_path: '/work/b.ts' }, 'toolu_b'));
  assert.equal(sub('toolu_b')?.activity?.tool, 'Read');
  chat.proc = null;
  assert.equal(sub('toolu_b')?.activity, undefined, 'without a process nothing is being done');
});

test('a subagent carries its activity while it runs, and none once ended or when read from disk', () => {
  const base = { toolUseId: 'toolu_a', subagentType: 'Explore', description: 'Find the feed', startedAt: '1', endedAt: null };
  const activity: ChatActivity = { kind: 'tool', tool: 'Read', target: 'a.ts', since: '2' };
  assert.deepEqual(toChatSubagent({ ...base, status: 'running', activity }, [], 's').activity, activity);
  assert.equal(toChatSubagent({ ...base, status: 'completed', endedAt: '3', activity }, [], 's').activity, null, 'an ended agent is doing nothing');
  assert.equal(toChatSubagent({ ...base, status: 'running' }, [], 's').activity, null, 'the files on disk say nothing about the present');
  assert.equal(toChildren({ subagents: [{ ...base, status: 'running', agentId: 'agent-1', activity }], tasks: [], workflows: [] }, 's').subagents[0]?.activity, activity);
});

// ---------- the feed ----------

function runtime(subagents: ChatRuntime['subagents'] = []): ChatRuntime {
  return {
    id: 'sess-1',
    name: 'demo',
    cwd: '/work',
    workingDir: '/work',
    origin: 'claudio',
    derivedFrom: null,
    model: null,
    permissionMode: 'manual',
    status: 'busy',
    pid: 1,
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    turns: 0,
    costUsd: 0,
    prompt: 'p',
    lastText: null,
    error: null,
    orchestrationId: null,
    orchestrationTaskId: null,
    permissionPrompts: 'none',
    pendingPrompts: 0,
    activity: null,
    executions: [],
    backgroundTasks: [],
    subagents,
    workflows: [],
  };
}

test('what a subagent is doing goes out at most once per subagent per window, never twice the same', async () => {
  const seen: ClaudioEvent[] = [];
  const publisher = new RunEventPublisher((e) => seen.push({ ...e, id: seen.length + 1, at: '' } as ClaudioEvent), 250, 60);
  const run = runtime([{ toolUseId: 'toolu_a', subagentType: 'Explore', description: 'Find the feed', status: 'running', startedAt: '', endedAt: null }]);
  const at = (tool: string, since: string): ChatActivity => ({ kind: 'tool', tool, since });
  const said = () => seen.flatMap((e) => (e.type === 'subagent.activity' ? [e] : []));

  publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: null, activity: at('Read', '1') });
  assert.equal(said().length, 1, 'the first one is news and goes out at once');
  assert.equal(said()[0]?.toolUseId, 'toolu_a');
  assert.equal(said()[0]?.runId, 'sess-1');
  assert.match(said()[0]?.title ?? '', /^Find the feed is using Read/);

  // Another subagent is not held back by the first one's window
  publisher.subagentActivity(run, { toolUseId: 'toolu_b', agentId: 'agent-2', activity: at('Grep', '1') });
  assert.equal(said().length, 2);
  assert.equal(said()[1]?.agentId, 'agent-2');

  for (const n of ['2', '3', '4']) publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: 'agent-1', activity: at('Edit', n) });
  assert.equal(said().length, 2, 'nothing more inside the window');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(said().length, 3);
  assert.deepEqual(said()[2]?.activity, at('Edit', '4'), 'the newest, not the ones it skipped');
  assert.equal(said()[2]?.agentId, 'agent-1');

  publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: 'agent-1', activity: at('Edit', '4') });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(said().length, 3, 'an unchanged line is never announced');

  // A change held inside the window and taken back before it closes is no news either
  publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: 'agent-1', activity: at('Bash', '5') });
  assert.equal(said().length, 4);
  publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: 'agent-1', activity: at('Grep', '6') });
  publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: 'agent-1', activity: at('Bash', '5') });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(said().length, 4);

  publisher.subagentActivity(run, { toolUseId: 'toolu_a', agentId: 'agent-1', activity: null });
  assert.equal(said().length, 5);
  assert.equal(said()[4]?.activity, null);
  assert.match(said()[4]?.title ?? '', /is not doing anything/);
  publisher.dispose();
});

// ---------- end to end, over a real process ----------

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("a subagent's open call is on the chat's summary and on the feed, and is gone with the process", async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const bus = new EventBus();
  runs.bus = bus;
  const seen: ClaudioEvent[] = [];
  bus.observe((e) => seen.push(e));

  const turn = join(config.dataDir, 'subagent.jsonl');
  writeFileSync(
    turn,
    [agent('toolu_a', 'Find the feed'), call('toolu_r', 'Bash', { command: 'pnpm test' }, 'toolu_a')].map((e) => JSON.stringify(e)).join('\n'),
  );

  const chat = runs.start({ prompt: `REPLAY-RAW ${turn}` });
  const activity = await until(() => runs.get(chat.id)?.subagents.find((s) => s.toolUseId === 'toolu_a')?.activity, 'the subagent to report what it is doing');
  assert.equal(activity.target, 'pnpm test');

  const announced = await until(() => seen.find((e) => e.type === 'subagent.activity'), 'the feed to carry it');
  assert.ok(announced.type === 'subagent.activity');
  assert.equal(announced.runId, chat.id);
  assert.equal(announced.toolUseId, 'toolu_a');
  assert.deepEqual(announced.activity, activity);

  runs.stop(chat.id);
  await runs.exited(chat.id);
  const cleared = await until(() => seen.find((e) => e.type === 'subagent.activity' && e.activity === null), 'the feed to say it stopped');
  assert.equal(cleared.type === 'subagent.activity' ? cleared.toolUseId : '', 'toolu_a');
  assert.equal(seen.filter((e) => e.type === 'subagent.activity').length, 2, 'said once each, never repeated');
  runs.stopAll();
  db.close();
});
