// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderMove, ProviderStatus } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import { WaitActions, WaitLine } from '../src/components/WaitLine';
import i18n from '../src/i18n';
import { OpenWaitList, type OpenWait } from '../src/pages/dashboard/widgets/waits';

(globalThis as { React?: typeof React }).React = React;

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const claude = { id: 'claude-code', label: 'Claude Code', state: 'ready' } as unknown as ProviderStatus;

const render = (node: React.ReactNode, chatRead = true): string => {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [claude]);
  if (chatRead) client.setQueryData(['home', 'wait-chat', 'c1'], { chat: { id: 'c1', title: 'Review the PWA', firstPrompt: 'Review the PWA', account: null } } as never);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <TooltipProvider>{node}</TooltipProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const move = (over: Partial<ProviderMove> = {}): ProviderMove => ({
  id: 'm1',
  at: '2026-10-02T10:00:00Z',
  subjectKind: 'chat',
  subjectId: 'c1',
  projectId: null,
  fromChat: 'c1',
  toChat: null,
  fromProvider: 'claude-code',
  toProvider: null,
  fromModel: null,
  toModel: null,
  action: 'wait',
  state: 'waiting',
  decidedBy: 'setting',
  decisionId: null,
  resetsAt: null,
  reason: null,
  updatedAt: 't',
  ...over,
});

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a wait with a known reset says when it goes on and not when it looks again', () => {
  const html = render(<WaitLine wait={{ provider: 'claude-code', resetsAt: '2099-01-01T14:05:00Z', nextLookAt: '2099-01-01T14:05:05Z', state: 'waiting' }} />);
  assert.match(text(html), /Waiting for Claude Code · resumes at/);
  assert.doesNotMatch(text(html), /looking again/);
});

test('a wait with no known reset says the hour of its next look', () => {
  const html = render(<WaitLine wait={{ provider: 'claude-code', resetsAt: null, nextLookAt: '2099-01-01T17:15:00Z', state: 'waiting' }} />);
  assert.match(text(html), /the reset time is not known · looking again at/);
});

test('a wait whose turn is being sent says it goes on now, and names the account', () => {
  const html = render(<WaitLine account="Work" wait={{ provider: 'claude-code', resetsAt: '2099-01-01T14:05:00Z', state: 'resuming' }} />);
  assert.match(text(html), /going on now/);
  assert.match(text(html), /account Work/);
});

test('a wait line is warn and still: the clock, no spinner, nothing live', () => {
  const html = render(<WaitLine banner wait={{ provider: 'claude-code', resetsAt: null }} />);
  assert.match(html, /class="wait-line is-banner"/);
  assert.doesNotMatch(html, /spinner|shimmer|energy|dot-live|is-live/);
});

test('the wait actions are the two that already exist: stop waiting and run now', () => {
  const words = text(render(<WaitActions moveId="m1" />));
  assert.match(words, /Stop waiting/);
  assert.match(words, /Run now/);
});

test('Home lists an open wait with what waits, since when, when it goes on and a way to it', () => {
  const waits: OpenWait[] = [{ move: move({ resetsAt: '2099-01-01T14:05:00Z' }), orchestration: null }];
  const html = render(<OpenWaitList waits={waits} />);
  assert.match(text(html), /Waiting for Claude Code · resumes at/);
  assert.match(text(html), /since/);
  assert.match(html, /href="\/chats\/c1"/);
  assert.doesNotMatch(html, /btn-primary/);
});

test('Home links a task\'s wait to its orchestration and shows nothing when no wait is open', () => {
  const orchestration = { id: 'o1', name: 'Ship it' } as never;
  const html = render(<OpenWaitList waits={[{ move: move({ subjectKind: 'task', subjectId: 'o1:t1', state: 'resuming' }), orchestration }]} />);
  assert.match(html, /href="\/orchestration\/o1"/);
  assert.match(text(html), /Ship it/);
  assert.match(text(html), /going on now/);
  assert.doesNotMatch(render(<OpenWaitList waits={[]} />), /wait-list/);
});

test('Home holds a chat wait as a skeleton while the chat is read, so the row does not jump', () => {
  const html = render(<OpenWaitList waits={[{ move: move(), orchestration: null }]} />, false);
  assert.match(html, /skeleton/);
  assert.doesNotMatch(text(html), /Waiting for Claude Code/);
});
