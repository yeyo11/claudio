// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat, Execution, ProviderLimit, ProviderMove, ProviderStatus } from '@claudio/shared';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import i18n from '../src/i18n';
import { LimitStopped } from '../src/pages/chat/LimitStopped';
import { LimitBadge } from '../src/pages/chat/LimitBadge';
import { BlockedComposer, LimitBanner, limitPhase, type LimitState } from '../src/pages/chat/LimitBanner';

// The chat package is compiled with the classic runtime here, so its context needs `React` in scope
(globalThis as { React?: typeof React }).React = React;

const FUTURE = '2099-01-01T14:05:00Z';

const execution = (over: Partial<Execution> = {}): Execution => ({
  id: 'e1',
  startedAt: '2026-10-02T10:00:00Z',
  endedAt: '2026-10-02T11:55:00Z',
  outcome: 'failed',
  error: null,
  permissionMode: 'bypassPermissions',
  model: 'opus',
  maxBudgetUsd: null,
  costUsd: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
  ...over,
});

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    id: 'c-old-1',
    title: 'Review the PWA',
    provider: 'claude-code',
    providerSessionId: null,
    firstPrompt: 'Review the PWA and the desktop app',
    model: 'opus',
    cwd: '/work/wrapper',
    state: 'idle',
    execution: null,
    executions: [execution()],
    updatedAt: '2026-10-02T11:55:00Z',
    ...over,
  }) as unknown as Chat;

const limit = (over: Partial<ProviderLimit> = {}): ProviderLimit => ({
  provider: 'claude-code',
  state: 'exhausted',
  window: '5h',
  utilization: 1,
  resetsAt: FUTURE,
  windows: {},
  observedAt: '2026-10-02T11:54:00Z',
  source: 'stream',
  ...over,
});

const status = (id: string, label: string, over: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({ id, label, state: 'ready', reason: null, version: '1', compatibleRange: '*', binaryPath: null, configHome: null, account: null, capabilities: [], ...over }) as ProviderStatus;

const wait = (over: Partial<ProviderMove> = {}): ProviderMove => ({
  id: 'm1',
  at: 't',
  subjectKind: 'chat',
  subjectId: 'c-old-1',
  projectId: null,
  fromChat: 'c-old-1',
  toChat: null,
  fromProvider: 'claude-code',
  toProvider: null,
  fromModel: 'opus',
  toModel: null,
  action: 'wait',
  state: 'waiting',
  decidedBy: 'person',
  decisionId: null,
  resetsAt: FUTURE,
  reason: null,
  updatedAt: 't',
  ...over,
});

const claude = status('claude-code', 'Claude Code', { limit: limit() });

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a chat is at its limit only when the reading says so, it is not working and its last turn did not finish', () => {
  assert.equal(limitPhase(chat(), claude, null), 'limit');
  assert.equal(limitPhase(chat({ state: 'working' }), claude, null), 'none');
  assert.equal(limitPhase(chat({ executions: [execution({ outcome: 'completed' })] }), claude, null), 'none');
  assert.equal(limitPhase(chat(), status('claude-code', 'Claude Code', { limit: limit({ state: 'near' }) }), null), 'none');
  assert.equal(limitPhase(chat(), status('claude-code', 'Claude Code', { limit: limit({ state: 'unknown' }) }), null), 'none');
  assert.equal(limitPhase(chat(), status('claude-code', 'Claude Code', { limit: limit({ resetsAt: '2020-01-01T00:00:00Z' }) }), null), 'none');
  assert.equal(limitPhase(chat(), undefined, null), 'none');
});

test("the server's own fact that the turn died on the limit wins over a reading taken since", () => {
  // A detection or another chat refreshed the reading after this turn ended: the reading alone would hide it
  const later = status('claude-code', 'Claude Code', { limit: limit({ observedAt: '2099-01-01T00:00:00Z' }) });
  assert.equal(limitPhase(chat(), later, null), 'none');
  assert.equal(limitPhase(chat({ atLimit: true }), later, null), 'limit');
  assert.equal(limitPhase(chat({ atLimit: true }), undefined, null), 'limit');
  assert.equal(limitPhase(chat({ atLimit: true, state: 'working' }), claude, null), 'none');
});

test('an open wait is the waiting phase', () => {
  assert.equal(limitPhase(chat(), claude, wait()), 'waiting');
  assert.equal(limitPhase(chat({ state: 'working' }), claude, wait()), 'waiting');
});

function render(page: React.ReactNode, client: QueryClient): string {
  const config = { client: {}, agentNameFor: () => 'x', fallbackInterval: false, paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '' }, slots: {} } as unknown as ChatUiConfig;
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <TooltipProvider>
          <ToastProvider>
            <ChatUiProvider value={config}>{page}</ChatUiProvider>
          </ToastProvider>
        </TooltipProvider>
      ),
    },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [claude]);
  return client;
}

const state = (phase: LimitState['phase'], wt: ProviderMove | null = null): LimitState => ({ phase, status: claude, wait: wt, resetsAt: wt?.resetsAt ?? FUTURE });

test('at a limit the banner names the window and the reset, and offers to wait as its one primary', () => {
  const html = render(<LimitBanner chat={chat()} state={state('limit')} />, seeded());
  const words = text(html);
  assert.match(words, /Claude Code reached its 5 h limit/);
  assert.match(words, /Resets/);
  assert.match(words, /Wait for the reset/);
  assert.deepEqual([...html.matchAll(/<button[^>]*class="btn btn-primary"[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1] ?? '').trim()), ['Wait for the reset']);
  // Nothing moves to another chat or program, and nothing animates
  assert.doesNotMatch(words, /Continue on|Start over on|handoff|Move now/);
  assert.doesNotMatch(html, /spinner|shimmer|energy/);
});

test('a waiting chat says what it waits for, offers Stop waiting, and has no primary action', () => {
  const html = render(<LimitBanner chat={chat()} state={state('waiting', wait())} />, seeded());
  const words = text(html);
  assert.match(words, /Waiting for Claude Code/);
  assert.match(words, /Then your last message is sent again in this same chat/);
  assert.match(words, /Stop waiting/);
  assert.doesNotMatch(words, /Move now/);
  assert.doesNotMatch(html, /btn-primary/);
});

test('a chat that is not at a limit draws no banner', () => {
  assert.doesNotMatch(render(<LimitBanner chat={chat()} state={state('none')} />, seeded()), /class="lim"/);
});

test('the box under the banner says why a message cannot be typed', () => {
  const says = (c: Chat, s: LimitState) => /placeholder="([^"]*)"/.exec(render(<BlockedComposer chat={c} state={s} />, seeded()))?.[1];
  assert.equal(says(chat(), state('limit')), 'Choose what to do with this chat to go on');
  assert.equal(says(chat(), state('waiting', wait())), 'This chat waits for Claude Code&#x27;s reset');
});

test('the line where the old chat stopped says which provider and when, and no time while it waits', () => {
  const client = seeded();
  assert.match(text(render(<LimitStopped chat={chat()} at="2026-10-02T11:55:00Z" />, client)), /Claude Code stopped: it reached its limit\. \d\d:\d\d/);
  assert.doesNotMatch(text(render(<LimitStopped chat={chat()} at="2026-10-02T11:55:00Z" waiting />, client)), /\d\d:\d\d/);
});

test('the copy of the chat at a limit exists in Spanish, once per key, with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const es = new Map(flat((i18n.getResourceBundle('es', 'chats') as { limit: Record<string, unknown> }).limit));
  for (const [key, value] of flat((i18n.getResourceBundle('en', 'chats') as { limit: Record<string, unknown> }).limit)) {
    const other = es.get(key);
    assert.ok(other, `es limit.${key}`);
    assert.equal(holes(value), holes(other), key);
  }
});

test('a chat whose last turn ended before the reading was taken is not at that limit, nor is one that has no end', () => {
  const at = (endedAt: string | null) => chat({ executions: [execution({ endedAt })] });
  assert.equal(limitPhase(at('2026-10-02T11:55:00Z'), claude, null), 'limit');
  // An old failure of an idle chat, on a provider another chat found exhausted since
  assert.equal(limitPhase(at('2026-10-02T09:00:00Z'), claude, null), 'none');
  assert.equal(limitPhase(at(null), claude, null), 'none');
});

test('the banner names a window by the words of the app, and a window it does not know is not named', () => {
  const title = (window: string | null) => {
    const s = status('claude-code', 'Claude Code', { limit: limit({ window }) });
    return text(render(<LimitBanner chat={chat()} state={{ ...state('limit'), status: s }} />, seeded()));
  };
  assert.match(title('five_hour'), /Claude Code reached its 5 h limit/);
  assert.match(title('seven_day'), /Claude Code reached its 7 d limit/);
  assert.match(title('primary'), /Claude Code reached its main window limit/);
  assert.match(title('weekly_opus'), /Claude Code reached its usage limit/);
  assert.doesNotMatch(title('weekly_opus'), /weekly_opus/);
  assert.match(title(null), /Claude Code reached its usage limit/);
});

test('the header says the limit in a warn badge, with the hour it resumes when it waits', () => {
  const badge = (phase: 'limit' | 'waiting', resetsAt: string | null) => text(render(<LimitBadge phase={phase} resetsAt={resetsAt} />, seeded()));
  assert.match(badge('limit', FUTURE), /Limit reached/);
  assert.match(badge('waiting', FUTURE), /waiting · \d\d:\d\d/);
  assert.equal(badge('waiting', null).trim(), 'waiting');
  assert.match(render(<LimitBadge phase="limit" resetsAt={null} />, seeded()), /badge-warn/);
});
