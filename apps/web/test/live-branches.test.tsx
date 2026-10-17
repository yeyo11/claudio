// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { ChatBackgroundTask, ChatChildren, ChatDetail, ChatSubagent, ChatSubagentEntry, SubagentActivityEvent, TranscriptEntry } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { BRANCHES_STORAGE_KEY, BranchCard, LiveBranches } from '@claudio/chat-ui/components/LiveBranches';
import { branchesOfStep, liveBranches } from '@claudio/chat-ui/lib/chat-branches';
import { transcriptRows } from '@claudio/chat-ui/lib/chat-steps';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { keys } from '../src/api';
import { patchSubagentActivity } from '../src/lib/events';
import { setLanguage } from '../src/i18n';

// What the chat has running beside it, over the composer and under the step that started it
// (docs/plans/tool-rows-and-live-branches.md §3.3).

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

const config = { agentNameFor: () => 'Claude', paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' } } as unknown as ChatUiConfig;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  // setLanguage, not i18n.changeLanguage: Intl follows the stored language, which otherwise stays the machine's
  setLanguage(lang);
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatUiProvider value={config}>
        <TooltipProvider>
          <ToastProvider>{node}</ToastProvider>
        </TooltipProvider>
      </ChatUiProvider>
    </MemoryRouter>,
  );
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const reading = { kind: 'tool' as const, tool: 'Read', target: 'packages/core/src/chats.ts', since: ago(3000) };

const sub = (over: Partial<ChatSubagent> = {}): ChatSubagent => ({
  id: 'agent-1',
  sessionId: 'chat-1',
  kind: 'Explore',
  description: 'Read the stream',
  status: 'running',
  startedAt: ago(42_000),
  endedAt: null,
  lastActivityAt: null,
  cwd: null,
  tasks: [],
  activity: null,
  ...over,
});
const task = (over: Partial<ChatBackgroundTask> = {}): ChatBackgroundTask => ({
  id: 'task-1',
  kind: 'local_bash',
  description: 'Run the suite',
  command: 'pnpm test',
  status: 'running',
  startedAt: ago(70_000),
  endedAt: null,
  summary: null,
  byPerson: false,
  ownerId: null,
  ...over,
});
const children = (over: Partial<ChatChildren> = {}): ChatChildren => ({ subagents: [], backgroundTasks: [], workflows: [], ...over });

/** A `localStorage` holding what the person chose, for as long as `run` takes */
function withStorage<T>(stored: Record<string, string>, run: () => T): T {
  const holder = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> };
  const before = holder.localStorage;
  holder.localStorage = { getItem: (key) => stored[key] ?? null, setItem: (key, value) => void (stored[key] = value) };
  try {
    return run();
  } finally {
    holder.localStorage = before;
  }
}

const strip = (branches: ChatChildren, lang: 'en' | 'es' = 'en') => render(<LiveBranches branches={branches} onOpen={() => {}} />, lang);

test('with nothing running the strip is not on the page', () => {
  const bare = (branches: ChatChildren) => renderToStaticMarkup(<LiveBranches branches={branches} onOpen={() => {}} />);
  assert.equal(bare(children()), '');
  assert.equal(bare(children({ subagents: [sub({ status: 'completed', endedAt: ago(60_000) })] })), '');
});

test('it starts folded: one line with the count and the newest activity', () => {
  const html = strip(children({ subagents: [sub({ activity: reading }), sub({ id: 'agent-2', kind: 'general-purpose', description: 'Check the inspector' })], backgroundTasks: [task()] }));
  assert.match(html, /class="[^"]*chat-branches-bar[^"]*"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*class="[^"]*chat-branches-bar/);
  assert.match(html, /<span class="chat-branches-count">2 agents · 1 background task<\/span>/);
  assert.match(html, /chat-branches-now">Explore · <span class="verb">reading<\/span> packages\/core\/src\/chats\.ts · 0:4\d/);
  assert.doesNotMatch(html, /chat-branch-row/, 'the list waits for the person to open it');
  assert.match(strip(children({ backgroundTasks: [task()] }), 'es'), /1 tarea en segundo plano/);
});

test('the fold is remembered', () => {
  const stored = { [BRANCHES_STORAGE_KEY]: 'open' };
  const html = withStorage(stored, () => strip(children({ subagents: [sub({ id: 'a', activity: reading, tasks: [task({ id: 'n', ownerId: 'a', description: '', command: 'grep -rn parent_tool_use_id' })] })] })));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="Running now"/);
  // A row per branch, named by what it shows; the one the subagent launched nested under it says so off screen
  assert.match(html, /<button type="button" class="chat-branch-row is-running">/);
  assert.match(html, /class="chat-branch-row is-running is-nested">(?:(?!<\/button>).)*<span class="sr-only"> · from Read the stream<\/span><\/button>/);
  assert.match(html, /<span class="badge chat-branch-kind">bash<\/span> <span class="chat-branch-desc mono">grep -rn parent_tool_use_id<\/span>/);
  assert.match(html, /<span class="chat-branch-act"><span class="verb">reading<\/span> packages\/core\/src\/chats\.ts<\/span>/);
});

test('a branch that just ended keeps its word for the grace, then the strip goes', () => {
  const ended = children({ subagents: [sub({ status: 'failed', endedAt: ago(1000) })] });
  const html = withStorage({ [BRANCHES_STORAGE_KEY]: 'open' }, () => strip(ended));
  assert.match(html, /chat-branch-row is-failed/);
  assert.match(html, /<span class="word">failed<\/span>/);
  assert.equal(liveBranches(ended, Date.now() + 5000).length, 0);
});

test('a card under the step: live rail while it runs, never a gradient', () => {
  const [running] = liveBranches(children({ subagents: [sub({ activity: reading })] }), Date.now());
  const html = render(<BranchCard branch={running!} onOpen={() => {}} />, 'es');
  assert.match(html, /class="chat-launch is-agent live-rail is-running"/);
  assert.match(html, /chat-launch-status is-running">trabajando</);
  assert.match(html, /aria-label="Abrir Read the stream"/);
  assert.doesNotMatch(html, /grad-border/);
  const [done] = liveBranches(children({ backgroundTasks: [task({ status: 'completed', endedAt: ago(100) })] }), Date.now());
  const record = render(<BranchCard branch={done!} />);
  assert.match(record, /class="chat-launch is-task"/);
  assert.match(record, /chat-launch-status is-completed">done</);
  assert.match(record, /chat-launch-facts">pnpm test · 1m 10s</);
});

test("a step's calls lead to the branches they started", () => {
  const entry = (blocks: TranscriptEntry['blocks'], role: 'user' | 'assistant', uuid: string): TranscriptEntry => ({
    uuid,
    role,
    timestamp: ago(40_000),
    model: null,
    isSidechain: false,
    parentToolUseId: null,
    blocks,
  });
  const rows = transcriptRows([
    entry([{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Read the stream', subagent_type: 'Explore' } }], 'assistant', 'a1'),
    entry([{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pnpm test', run_in_background: true } }], 'assistant', 'a2'),
    entry([{ type: 'tool_result', toolUseId: 'toolu_2', content: 'Command running in background', isError: false }], 'user', 'r2'),
  ]);
  const step = rows.find((row) => row.kind === 'step');
  assert.ok(step && step.kind === 'step');
  const calls = step.parts.flatMap((part) => (part.kind === 'call' ? [part] : []));
  // Two agents asked for the same thing: the one still named by its call is the one it started
  const found = branchesOfStep(calls, step, children({ subagents: [sub({ id: 'agent-1' }), sub({ id: 'toolu_1' })], backgroundTasks: [task()] }));
  assert.deepEqual(found.map((branch) => branch.key), ['agent:toolu_1', 'task:task-1']);
});

const activityEvent = (over: Partial<SubagentActivityEvent> = {}): SubagentActivityEvent => ({
  id: 1,
  at: reading.since,
  title: '',
  type: 'subagent.activity',
  runId: 'chat-1',
  runName: 'demo',
  sessionId: 'chat-1',
  toolUseId: 'toolu_1',
  agentId: 'agent-1',
  activity: reading,
  ...over,
});

test('subagent.activity is written into both chat pages and the subagents list, in place', () => {
  const client = new QueryClient();
  const detail = (subs: ChatSubagent[]) => ({ chat: { id: 'chat-1', children: children({ subagents: subs }) }, entries: [], from: 0, total: 0 }) as unknown as ChatDetail;
  client.setQueryData(keys.chat('chat-1', false), detail([sub(), sub({ id: 'agent-9' })]));
  client.setQueryData(keys.chat('chat-1', true), detail([sub()]));
  const listed: ChatSubagentEntry[] = [
    { ...sub(), chat: { id: 'chat-1' } } as ChatSubagentEntry,
    { ...sub({ sessionId: 'chat-2' }), chat: { id: 'chat-2' } } as ChatSubagentEntry,
  ];
  client.setQueryData(keys.subagents, listed);
  patchSubagentActivity(client, activityEvent());
  for (const sidechains of [false, true]) {
    assert.deepEqual(client.getQueryData<ChatDetail>(keys.chat('chat-1', sidechains))?.chat.children.subagents[0]?.activity, reading);
  }
  assert.equal(client.getQueryData<ChatDetail>(keys.chat('chat-1', false))?.chat.children.subagents[1]?.activity, null, 'only the subagent it names');
  const list = client.getQueryData<ChatSubagentEntry[]>(keys.subagents);
  assert.deepEqual(list?.[0]?.activity, reading);
  assert.equal(list?.[1]?.activity, null, "another chat's subagent with the same id is left alone");
  // Before the CLI names the agent, the call that launched it is its id
  client.setQueryData(keys.chat('chat-3', false), { ...detail([sub({ id: 'toolu_7', sessionId: 'chat-3' })]), chat: { id: 'chat-3', children: children({ subagents: [sub({ id: 'toolu_7', sessionId: 'chat-3' })] }) } } as unknown as ChatDetail);
  patchSubagentActivity(client, activityEvent({ sessionId: 'chat-3', runId: 'chat-3', toolUseId: 'toolu_7', agentId: null }));
  assert.deepEqual(client.getQueryData<ChatDetail>(keys.chat('chat-3', false))?.chat.children.subagents[0]?.activity, reading);
  patchSubagentActivity(client, activityEvent({ sessionId: 'chat-3', runId: 'chat-3', toolUseId: 'toolu_7', agentId: null, activity: null }));
  assert.equal(client.getQueryData<ChatDetail>(keys.chat('chat-3', false))?.chat.children.subagents[0]?.activity, null);
});
