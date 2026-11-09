// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrchestrationTemplate, PermissionRequest } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, chatKeys, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { PermissionPrompts } from '@claudio/chat-ui/components/PermissionPrompts';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';

// The prompt of a launch from a saved template: the call names only the template, so the prompt
// reads its stored permissions, tools, guards and checks from the server and holds the answers back
// until it has them (docs/plans/claudio-servers.md §12.2, E5).

(globalThis as { React?: typeof React }).React = React;

const CHAT = 'c1';
const request = { id: 'p1', runId: CHAT, toolName: 'mcp__claudio__launch_orchestration_template', input: { templateId: 't1', objective: 'tonight' }, createdAt: '2026-11-09T10:00:00.000Z' } as unknown as PermissionRequest;
const template = {
  id: 't1',
  name: 'Nightly',
  spec: { name: 'Nightly', tasks: [], permissionMode: 'bypassPermissions', allowedTools: ['Bash'], verification: { commands: [['pnpm lint', 'pnpm test']] } },
  createdAt: '',
  updatedAt: '',
} as unknown as OrchestrationTemplate;
const config = {
  agentNameFor: () => 'Claude',
  paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' },
  client: { chatPermissions: async () => [request], orchestrationTemplate: () => new Promise<OrchestrationTemplate>(() => {}) },
} as unknown as ChatUiConfig;

function render(read: OrchestrationTemplate | null, withReader = true): string {
  setLanguage('en');
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(chatKeys.chatPermissions(CHAT), [request]);
  if (read) queries.setQueryData(['template-prompt', 't1'], read);
  const client = withReader ? config.client : { chatPermissions: async () => [request] };
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queries}>
        <ChatUiProvider value={{ ...config, client } as unknown as ChatUiConfig}>
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

test('while the template is read, the answers keep their room but are not shown', () => {
  const html = render(null);
  assert.equal(actionsClass(html), 'permission-actions is-waiting');
  assert.deepEqual(previewText(html), ['Reading the template…']);
});

test('once read, the prompt says what the template runs its workers with', () => {
  const html = render(template);
  assert.equal(actionsClass(html), 'permission-actions');
  assert.deepEqual(previewText(html), ['This template runs its workers with:', 'Permission mode: bypassPermissions', 'Allowed without asking: Bash', 'Checks: pnpm lint + pnpm test']);
});

test('a client that cannot read templates leaves the prompt as the call has it', () => {
  const html = render(null, false);
  assert.equal(actionsClass(html), 'permission-actions');
  assert.doesNotMatch(html, /permission-preview/);
});
