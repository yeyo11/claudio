import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runsElapsedMs, type ChatBackgroundTask, type ChatChildren, type ChatSubagent, type ChatWorkflow } from '@claudio/shared';
import {
  BRANCH_GRACE_MS,
  agentBranch,
  branchElapsed,
  branchCounts as countsOf,
  branchesOfStep as stepBranches,
  liveBranches as strip,
  newestBranch as newestOf,
  nextExpiry,
  type Branch,
  type BranchCall,
  type BranchChat,
} from '../src/lib/chat-branches';

// The rules of what is running at a glance (plans/tool-rows-and-live-branches.md §3.3)

const NOW = Date.parse('2026-10-16T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const sub = (over: Partial<ChatSubagent> = {}): ChatSubagent => ({
  id: 'agent-1',
  sessionId: 'chat-1',
  kind: 'Explore',
  description: 'Read the stream',
  status: 'running',
  startedAt: ago(42_000),
  endedAt: null,
  runs: [],
  lastActivityAt: null,
  cwd: null,
  tasks: [],
  activity: null,
  ...over,
});

const task = (over: Partial<ChatBackgroundTask> = {}): ChatBackgroundTask => ({
  id: 'task-1',
  kind: 'local_bash',
  description: '',
  command: 'pnpm test',
  status: 'running',
  startedAt: ago(70_000),
  endedAt: null,
  summary: null,
  byPerson: false,
  ownerId: null,
  ...over,
});

const workflow = (over: Partial<ChatWorkflow> = {}): ChatWorkflow => ({
  id: 'wf-1',
  name: 'review',
  description: 'Review the branch',
  status: 'running',
  startedAt: ago(10_000),
  endedAt: null,
  phases: ['Read', 'Judge'],
  agents: [
    { index: 0, label: 'a', status: 'completed', id: null, phase: 'Read', model: null, startedAt: null, durationMs: null, tokens: null, toolCalls: null, promptPreview: null, resultPreview: null },
    { index: 1, label: 'b', status: 'running', id: null, phase: 'Judge', model: null, startedAt: null, durationMs: null, tokens: null, toolCalls: null, promptPreview: null, resultPreview: null },
  ],
  summary: null,
  totalTokens: null,
  script: null,
  ...over,
});

const children = (over: Partial<ChatChildren> = {}): ChatChildren => ({ subagents: [], backgroundTasks: [], workflows: [], ...over });

// A chat something holds, unless a test says it is gone
const chatOf = (c: ChatChildren, alive = true): BranchChat => ({ alive, state: alive ? 'working' : 'idle', updatedAt: ago(20_000), children: c });
const liveBranches = (c: ChatChildren, now: number, alive = true) => strip(chatOf(c, alive), now);
const branchCounts = (rows: Branch[]) => countsOf({ alive: true, state: 'working' }, rows);
const newestBranch = (rows: Branch[]) => newestOf({ alive: true, state: 'working' }, rows);
const branchesOfStep = (calls: BranchCall[], span: { startedAt: string | null; endedAt: string | null }, c: ChatChildren, alive = true) => stepBranches(chatOf(c, alive), calls, span);

test('nothing running and nothing just ended: no rows', () => {
  assert.deepEqual(liveBranches(children(), NOW), []);
  assert.deepEqual(liveBranches(children({ subagents: [sub({ status: 'completed', endedAt: ago(60_000) })] }), NOW), []);
  // An ended branch with no end time has nothing to count its grace from
  assert.deepEqual(liveBranches(children({ subagents: [sub({ status: 'completed', endedAt: null })] }), NOW), []);
});

test('an ended branch stays for the grace, then leaves', () => {
  const ended = children({ subagents: [sub({ status: 'completed', endedAt: ago(BRANCH_GRACE_MS - 1000) })] });
  assert.equal(liveBranches(ended, NOW).length, 1);
  assert.equal(liveBranches(ended, NOW + 1000).length, 0);
  const rows = liveBranches(ended, NOW);
  assert.equal(nextExpiry(rows, NOW), NOW + 1000);
  assert.equal(nextExpiry(liveBranches(children({ subagents: [sub()] }), NOW), NOW), null);
});

test('oldest first, and what a subagent launched right under it', () => {
  const rows = liveBranches(
    children({
      subagents: [sub({ id: 'a', startedAt: ago(30_000), tasks: [task({ id: 'nested', ownerId: 'a', startedAt: ago(5000), command: 'grep -rn x' })] }), sub({ id: 'b', startedAt: ago(40_000) })],
      backgroundTasks: [task({ id: 't', startedAt: ago(70_000) })],
      workflows: [workflow()],
    }),
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => row.key),
    ['task:t', 'agent:b', 'agent:a', 'task:nested', 'workflow:wf-1'],
  );
  assert.equal(rows[3]?.parent, 'agent:a');
  assert.equal(rows[3]?.label, 'bash');
  // A command with no description shows the command, in mono
  assert.equal(rows[3]?.description, 'grep -rn x');
  assert.equal(rows[3]?.mono, true);
});

test('a launched branch whose owner has left stands on its own', () => {
  const rows = liveBranches(children({ subagents: [sub({ id: 'a', status: 'completed', endedAt: ago(60_000), tasks: [task({ id: 'n', ownerId: 'a' })] })] }), NOW);
  assert.deepEqual(rows.map((row) => [row.key, row.parent]), [['task:n', null]]);
});

test('the count is what still runs, by kind', () => {
  const rows = liveBranches(
    children({
      subagents: [sub({ id: 'a' }), sub({ id: 'b' }), sub({ id: 'c', status: 'failed', endedAt: ago(1000) })],
      backgroundTasks: [task()],
    }),
    NOW,
  );
  assert.deepEqual(branchCounts(rows), { agents: 2, tasks: 1, workflows: 0 });
});

test('the newest activity wins, else the branch that started last', () => {
  const reading = { kind: 'tool' as const, tool: 'Read', target: 'packages/core/src/chats.ts', since: ago(2000) };
  const grepping = { kind: 'tool' as const, tool: 'Grep', target: 'BranchesCard', since: ago(9000) };
  const rows = liveBranches(children({ subagents: [sub({ id: 'a', activity: grepping }), sub({ id: 'b', activity: reading, startedAt: ago(90_000) })], backgroundTasks: [task({ startedAt: ago(1000) })] }), NOW);
  assert.equal(newestBranch(rows)?.id, 'b');
  const quiet = liveBranches(children({ subagents: [sub({ id: 'a' })], backgroundTasks: [task({ startedAt: ago(1000) })] }), NOW);
  assert.equal(newestBranch(quiet)?.id, 'task-1');
  // An ended subagent says nothing more about what it does
  const ended = liveBranches(children({ subagents: [sub({ status: 'completed', endedAt: ago(1000), activity: reading })] }), NOW);
  assert.equal(ended[0]?.activity, null);
  assert.equal(newestBranch(ended), null);
});

const call = (over: Partial<BranchCall> = {}): BranchCall => ({ id: 'toolu_1', name: 'Agent', input: { description: 'Read the stream', subagent_type: 'Explore' }, result: null, ...over });

test('an Agent call finds its subagent by the agent id the CLI recorded', () => {
  // Two agents asked for the same thing: the description alone matches neither
  const twins = children({ subagents: [sub({ id: 'agent-1' }), sub({ id: 'agent-2' })] });
  const found = branchesOfStep([call({ result: { isError: false, detail: { kind: 'agent', agentId: 'agent-2', background: true, model: null } } })], { startedAt: null, endedAt: null }, twins);
  assert.deepEqual(found.map((b) => b.key), ['agent:agent-2']);
  assert.deepEqual(branchesOfStep([call()], { startedAt: null, endedAt: null }, twins), []);
});

test('a subagent still named by its call matches the call', () => {
  const found = branchesOfStep([call({ id: 'toolu_9' })], { startedAt: null, endedAt: null }, children({ subagents: [sub({ id: 'toolu_9', description: 'Something else' })] }));
  assert.deepEqual(found.map((b) => b.key), ['agent:toolu_9']);
});

test('without a recorded id, the description decides when only one fits', () => {
  const found = branchesOfStep([call()], { startedAt: null, endedAt: null }, children({ subagents: [sub()] }));
  assert.deepEqual(found.map((b) => b.key), ['agent:agent-1']);
  // A recorded id that names no subagent is not second-guessed by the description
  const stale = branchesOfStep([call({ result: { isError: false, detail: { kind: 'agent', agentId: 'gone', background: false, model: null } } })], { startedAt: null, endedAt: null }, children({ subagents: [sub()] }));
  assert.deepEqual(stale, []);
});

test('a backgrounded Bash call finds its task by id, or by its command', () => {
  const bash = (over: Partial<BranchCall> = {}) => call({ name: 'Bash', input: { command: 'pnpm test', run_in_background: true }, ...over });
  const tasks = children({ backgroundTasks: [task({ id: 'b1' }), task({ id: 'b2', command: 'pnpm build' })] });
  assert.deepEqual(branchesOfStep([bash({ result: { isError: false, detail: { kind: 'command', stderr: '', interrupted: false, backgroundTaskId: 'b2' } } })], { startedAt: null, endedAt: null }, tasks).map((b) => b.key), ['task:b2']);
  assert.deepEqual(branchesOfStep([bash()], { startedAt: null, endedAt: null }, tasks).map((b) => b.key), ['task:b1']);
  // A command run in the foreground started nothing
  assert.deepEqual(branchesOfStep([bash({ input: { command: 'pnpm test' } })], { startedAt: null, endedAt: null }, tasks), []);
});

test('a workflow belongs to the step it started during', () => {
  const flows = children({ workflows: [workflow({ startedAt: ago(10_000) }), workflow({ id: 'old', startedAt: ago(3_600_000) })] });
  const found = branchesOfStep([call({ name: 'Workflow', input: {} })], { startedAt: ago(12_000), endedAt: ago(9000) }, flows);
  assert.deepEqual(found.map((b) => b.key), ['workflow:wf-1']);
  assert.deepEqual(found[0]?.progress, { done: 1, total: 2, phase: 2 });
  assert.deepEqual(found[0]?.segments, ['completed', 'running']);
});

test('in a chat nothing holds, what said running is stopped, ended when the chat last wrote', () => {
  const left = children({ subagents: [sub({ activity: { kind: 'tool', tool: 'Grep', since: ago(1000) } })], backgroundTasks: [task()] });
  // The chat wrote last 20 s ago: past the grace, nothing of it is left on the strip
  assert.deepEqual(liveBranches(left, NOW, false), []);
  const recent = strip({ ...chatOf(left, false), updatedAt: ago(1000) }, NOW);
  assert.deepEqual(
    recent.map((r) => [r.kind, r.status, r.endedAt, r.activity]),
    [
      ['task', 'stopped', ago(1000), null],
      ['agent', 'stopped', ago(1000), null],
    ],
  );
});

test('a workflow agent still running in a workflow that ended is shown as its workflow ended', () => {
  const stopped = children({ workflows: [workflow({ status: 'stopped', endedAt: ago(1000) })] });
  const [row] = liveBranches(stopped, NOW);
  assert.deepEqual(row?.segments, ['completed', 'stopped']);
  assert.equal(branchCounts(liveBranches(stopped, NOW)).workflows, 0);
});

test('a chat nothing holds counts nothing as running and has no newest branch', () => {
  const rows = liveBranches(children({ backgroundTasks: [task({ status: 'stopped', endedAt: ago(1000) })] }), NOW);
  const gone = { alive: false, state: 'idle' } as const;
  assert.deepEqual(countsOf(gone, [{ ...rows[0]!, status: 'running', endedAt: null }]), { agents: 0, tasks: 0, workflows: 0 });
  assert.equal(newestOf(gone, [{ ...rows[0]!, status: 'running', endedAt: null }]), null);
});

test('the strip and the panel show one duration for an agent that was resumed', () => {
  const first = { startedAt: ago(3_600_000), endedAt: ago(3_300_000) };
  const chat = { alive: true, state: 'working' } as const;
  // Running again: the clock is the current run, not the hour since the first start
  const resumed = agentBranch(chat, sub({ startedAt: first.startedAt, runs: [first, { startedAt: ago(90_000), endedAt: null }] }));
  assert.equal(branchElapsed(resumed, NOW), 90_000);
  assert.equal(branchElapsed(resumed, NOW), runsElapsedMs(resumed.runs, NOW));
  // Done: the time it worked over both runs, not the wait between them
  const second = { startedAt: ago(120_000), endedAt: ago(60_000) };
  const done = agentBranch(chat, sub({ status: 'completed', startedAt: first.startedAt, endedAt: second.endedAt, runs: [first, second] }));
  assert.equal(branchElapsed(done, NOW), 300_000 + 60_000);
  assert.equal(branchElapsed(done, NOW + 600_000), 360_000);
});

test('an agent of a chat nothing holds stops its clock with the chat', () => {
  const gone = { alive: false, state: 'idle', updatedAt: ago(30_000) } as const;
  const branch = agentBranch(gone, sub({ runs: [{ startedAt: ago(100_000), endedAt: null }] }));
  assert.equal(branchElapsed(branch, NOW), 70_000);
  assert.equal(branchElapsed(branch, NOW + 60_000), 70_000);
});
