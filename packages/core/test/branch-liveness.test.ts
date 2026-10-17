import assert from 'node:assert/strict';
import test from 'node:test';
import { toChildren, type LiveSubagent } from '../src/chat-branches.ts';
import type { BackgroundTask, WorkflowRun } from '../src/cli-facts.ts';
import { ClaudeBranches } from '../src/providers/claude-code/branches.ts';

// What a chat nothing holds reports of what it delegated: nothing running.

const sub = (over: Partial<LiveSubagent> = {}): LiveSubagent => ({ toolUseId: 't1', subagentType: 'Explore', description: 'look', status: 'running', startedAt: '2026-01-01T10:00:00.000Z', endedAt: null, agentId: 'a1', ...over });
const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({ id: 'b1', type: 'local_bash', description: 'serve', status: 'running', toolUseId: null, startedAt: '2026-01-01T10:00:00.000Z', endedAt: null, summary: null, ...over });
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'wf_1',
  taskId: null,
  name: 'review',
  description: 'review',
  status: 'running',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: null,
  sessionId: 's',
  phases: [],
  agents: [{ index: 0, agentId: 'x', label: 'one', state: 'start', phaseTitle: null, model: null, startedAt: null, durationMs: null, tokens: null, toolCalls: null, promptPreview: null, resultPreview: null }],
  summary: null,
  totalTokens: null,
  script: null,
  ...over,
});

test('a chat nothing holds reports every running child stopped, ended when the chat did', () => {
  const stoppedAt = '2026-01-01T10:09:00.000Z';
  const children = toChildren({ subagents: [sub({ activity: { kind: 'tool', tool: 'Grep', since: stoppedAt } })], tasks: [task({ ownerAgentId: 'a1' }), task({ id: 'b2' })], workflows: [run()] }, 's', stoppedAt);
  const [agent] = children.subagents;
  assert.deepEqual([agent?.status, agent?.endedAt, agent?.activity], ['stopped', stoppedAt, null]);
  assert.deepEqual(agent?.tasks.map((t) => [t.status, t.endedAt]), [['stopped', stoppedAt]]);
  assert.deepEqual(children.backgroundTasks.map((t) => [t.status, t.endedAt]), [['stopped', stoppedAt]]);
  const [workflow] = children.workflows;
  assert.deepEqual([workflow?.status, workflow?.endedAt], ['stopped', stoppedAt]);
  assert.deepEqual(workflow?.agents.map((a) => a.status), ['stopped']);
});

test('a chat something holds keeps its running children, and what ended keeps its own end', () => {
  const live = toChildren({ subagents: [sub(), sub({ toolUseId: 't2', agentId: 'a2', status: 'completed', endedAt: '2026-01-01T10:01:00.000Z' })], tasks: [], workflows: [] }, 's');
  assert.deepEqual(live.subagents.map((s) => s.status).sort(), ['completed', 'running']);
  const settled = toChildren({ subagents: [sub({ status: 'completed', endedAt: '2026-01-01T10:01:00.000Z' })], tasks: [], workflows: [] }, 's', '2026-01-01T10:09:00.000Z');
  assert.equal(settled.subagents[0]?.endedAt, '2026-01-01T10:01:00.000Z');
});

test('a workflow agent that never reported is as ended as its workflow', () => {
  const ended = toChildren({ subagents: [], tasks: [], workflows: [run({ status: 'failed', endedAt: '2026-01-01T10:02:00.000Z' })] }, 's');
  assert.equal(ended.workflows[0]?.agents[0]?.status, 'failed');
  const running = toChildren({ subagents: [], tasks: [], workflows: [run()] }, 's');
  assert.equal(running.workflows[0]?.agents[0]?.status, 'running');
});

test('the end of a turn closes a foreground agent it never heard back from, and leaves a background one running', () => {
  const branches = new ClaudeBranches();
  branches.subagents.set('t1', sub());
  branches.subagents.set('t2', sub({ toolUseId: 't2', agentId: 'a2', background: true }));
  branches.endForeground('2026-01-01T10:03:00.000Z');
  assert.deepEqual([branches.subagents.get('t1')?.status, branches.subagents.get('t1')?.endedAt], ['stopped', '2026-01-01T10:03:00.000Z']);
  assert.equal(branches.subagents.get('t2')?.status, 'running');
});

test('when the process ends, an agent it took down is stopped, as the screens call it', () => {
  const branches = new ClaudeBranches();
  branches.subagents.set('t1', sub({ background: true }));
  branches.endAll('2026-01-01T10:04:00.000Z');
  assert.equal(branches.subagents.get('t1')?.status, 'stopped');
});
