import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatChildren, ChatSubagent, TranscriptEntry } from '@claudio/shared';
import { anyBranchLive, branchLive, chatAlive, chatBusy, effectiveBranch, openCallInTurn, workflowAgentLive } from '../src/lib/liveness';

// One answer to "is it still going on?" for every screen

const held = { alive: true, state: 'working' } as const;
const gone = { alive: false, state: 'idle', updatedAt: '2026-10-17T10:00:30.000Z' } as const;

const sub = (over: Partial<ChatSubagent> = {}): ChatSubagent => ({
  id: 'a1',
  sessionId: 'c1',
  kind: 'Explore',
  description: 'look',
  status: 'running',
  startedAt: '2026-10-17T10:00:00.000Z',
  endedAt: null,
  lastActivityAt: null,
  cwd: null,
  tasks: [],
  activity: null,
  ...over,
});
const children = (over: Partial<ChatChildren> = {}): ChatChildren => ({ subagents: [], backgroundTasks: [], workflows: [], ...over });

test('a chat is alive when the server says a process holds it, not when its status says running', () => {
  assert.equal(chatAlive(held), true);
  assert.equal(chatAlive(gone), false);
  assert.equal(branchLive(gone, { status: 'running' }), false);
  assert.equal(branchLive(held, { status: 'running' }), true);
  assert.equal(branchLive(held, { status: 'completed' }), false);
});

test('a running branch of a chat nothing holds reads as stopped, ended at the last execution or else the last write', () => {
  const branch = { status: 'running', endedAt: null } as const;
  assert.deepEqual(effectiveBranch(gone, branch), { status: 'stopped', endedAt: gone.updatedAt });
  const withExecutions = { ...gone, executions: [{ endedAt: '2026-10-17T10:00:10.000Z' }, { endedAt: '2026-10-17T10:00:20.000Z' }] };
  assert.equal(effectiveBranch(withExecutions, branch).endedAt, '2026-10-17T10:00:20.000Z');
  // What already ended keeps its own end, and a held chat is left as it is
  assert.deepEqual(effectiveBranch(gone, { status: 'completed', endedAt: '2026-10-17T10:00:05.000Z' }), { status: 'completed', endedAt: '2026-10-17T10:00:05.000Z' });
  assert.equal(effectiveBranch(held, branch), branch);
});

test('a workflow agent is working only while its workflow is', () => {
  assert.equal(workflowAgentLive({ status: 'running' }, { status: 'running' }), true);
  assert.equal(workflowAgentLive({ status: 'stopped' }, { status: 'running' }), false);
  assert.equal(workflowAgentLive({ status: 'running' }, { status: 'completed' }), false);
});

test('a chat is busy when its agent works or a branch does, and never when nothing holds it', () => {
  assert.equal(chatBusy({ alive: true, state: 'working' }), true);
  assert.equal(chatBusy({ alive: true, state: 'idle' }), false);
  assert.equal(chatBusy({ alive: true, state: 'idle', children: children({ subagents: [sub()] }) }), true);
  assert.equal(chatBusy({ alive: true, state: 'idle', children: children({ subagents: [sub({ status: 'completed' })] }) }), false);
  assert.equal(chatBusy({ ...gone, children: children({ subagents: [sub()] }) }), false);
  assert.equal(anyBranchLive({ ...gone, children: children({ subagents: [sub()] }) }), false);
});

let n = 0;
const entry = (role: 'user' | 'assistant', blocks: TranscriptEntry['blocks'], over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `u${n++}`,
  role,
  timestamp: `2026-10-17T10:00:${String(n).padStart(2, '0')}.000Z`,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks,
  ...over,
});
const prompt = (text: string) => entry('user', [{ type: 'text', text }]);
const call = (id: string, name = 'Bash') => entry('assistant', [{ type: 'tool_use', id, name, input: { command: 'sleep 9' } }]);
const answer = (id: string) => entry('user', [{ type: 'tool_result', toolUseId: id, content: 'ok', isError: false }]);

test('a call is open only in the turn that is under way', () => {
  assert.equal(openCallInTurn([prompt('go'), call('t1')])?.id, 't1');
  assert.equal(openCallInTurn([prompt('go'), call('t1'), answer('t1')]), null);
});

test('a call an interrupt left unanswered in an earlier turn is not open', () => {
  assert.equal(openCallInTurn([prompt('go'), call('t1'), prompt('never mind'), entry('assistant', [{ type: 'text', text: 'ok' }])]), null);
  assert.equal(openCallInTurn([prompt('go'), call('t1'), prompt('again'), call('t2')])?.id, 't2');
});

test('a subagent call is not the chat\'s open call', () => {
  assert.equal(openCallInTurn([prompt('go'), entry('assistant', [{ type: 'tool_use', id: 's1', name: 'Grep', input: {} }], { isSidechain: true, parentToolUseId: 'p' })]), null);
});
