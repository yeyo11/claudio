// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionRequest, SchedulePreview } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, chatKeys, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { PermissionPrompts } from '@claudio/chat-ui/components/PermissionPrompts';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';

// The permission prompt of a schedule the assistant asks to create (docs/plans/terminal-menu-schedules-v1-tools.md
// §2.3): the server's preview arrives after the prompt, so Allow and Deny wait for it rather than
// jump down under a pointer on its way to them; and the next fires are read on the schedule's clock.

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

const CHAT = 'c1';
const INPUT = { name: 'Nightly digest', cron: '0 3 * * *', timezone: 'Europe/Madrid', target: { kind: 'chat', prompt: 'Summarise' }, overlap: 'skip', enabled: true };
const request = { id: 'p1', runId: CHAT, toolName: 'mcp__claudio__create_schedule', input: INPUT, createdAt: '2026-11-07T10:00:00.000Z' } as unknown as PermissionRequest;
const config = {
  agentNameFor: () => 'Claude',
  paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' },
  client: { chatPermissions: async () => [request], schedulePreview: () => new Promise<SchedulePreview>(() => {}) },
} as unknown as ChatUiConfig;

function render(preview: SchedulePreview | null): string {
  setLanguage('en');
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(chatKeys.chatPermissions(CHAT), [request]);
  if (preview) queries.setQueryData(['schedule-prompt-preview', INPUT.cron, INPUT.timezone], preview);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queries}>
        <ChatUiProvider value={config}>
          <TooltipProvider>
            <PermissionPrompts chatId={CHAT} live />
          </TooltipProvider>
        </ChatUiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const actionsClass = (html: string): string | undefined => /<div class="(permission-actions[^"]*)"/.exec(html)?.[1];
const previewText = (html: string): string[] => [...(/<div class="permission-preview">(.*?)<\/div>/.exec(html)?.[1] ?? '').matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => m[1] ?? '');

test('while the preview is read, Allow and Deny keep their room but are not shown', () => {
  const html = render(null);
  assert.equal(actionsClass(html), 'permission-actions is-waiting');
  assert.deepEqual(previewText(html), ['Checking the expression…']);
  assert.match(html, /Allow/, 'the answers are laid out already, so they appear where they stay');
});

test('once the preview is in, the answers show and the next fires are on the schedule’s clock', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 02:00 UTC is 03:00 in Madrid in winter, whatever zone the machine running this is in
  const html = render({ valid: true, description: 'At 03:00', timezone: 'Europe/Madrid', next: ['2026-11-08T02:00:00.000Z'] });
  assert.equal(actionsClass(html), 'permission-actions');
  const label = zone === 'Europe/Madrid' ? 'Next fires' : 'Next fires, Europe/Madrid time';
  assert.deepEqual(previewText(html), ['In words: At 03:00', `${label}: 11/8/2026, 3:00 AM`]);
});

test('a preview that cannot be read leaves the answers to the person', () => {
  const noPreview = { ...config, client: { chatPermissions: async () => [request] } } as unknown as ChatUiConfig;
  setLanguage('en');
  const queries = new QueryClient();
  queries.setQueryData(chatKeys.chatPermissions(CHAT), [request]);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queries}>
        <ChatUiProvider value={noPreview}>
          <TooltipProvider>
            <PermissionPrompts chatId={CHAT} live />
          </TooltipProvider>
        </ChatUiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  assert.equal(actionsClass(html), 'permission-actions');
  assert.doesNotMatch(html, /permission-preview/);
});
