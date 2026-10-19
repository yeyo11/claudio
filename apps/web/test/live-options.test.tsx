// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { Chat } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { mcpKey } from '@claudio/chat-ui/composer/ServersPanel';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';
import { LiveOptions } from '../src/pages/chat/Controls';

// The chat package is compiled with the classic runtime here and does not import React
(globalThis as { React?: typeof React }).React = React;

afterEach(() => setLanguage('en'));

const config = { agentNameFor: () => 'Claude', paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' } } as unknown as ChatUiConfig;

const chat = (tools: unknown) => ({ id: 'c1', execution: { model: 'opus', permissionMode: 'default' }, executions: [], tools }) as unknown as Chat;

const render = (c: Chat, lang: 'en' | 'es', handlers: { servers?: () => void; env?: () => void } = {}) => {
  setLanguage(lang);
  const client = new QueryClient();
  client.setQueryData(mcpKey(c.id), {
    servers: [
      { name: 'a', status: 'connected' },
      { name: 'b', status: 'connected' },
      { name: 'c', status: 'disabled' },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ChatUiProvider value={config}>
            <LiveOptions chat={c} onOpenServers={handlers.servers} onOpenEnvironment={handlers.env} />
          </ChatUiProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

test('the options popover shows the live server count and links to the Servers panel and the rules', () => {
  const html = render(chat({ preset: { name: 'Read only' } }), 'en', { servers: () => {}, env: () => {} });
  assert.match(html, /2 of 3 on/);
  assert.match(html, /Read only · View rules/);
  assert.equal((html.match(/class="link-btn"/g) ?? []).length, 2);
  assert.match(html, /The tool preset was fixed when the chat started; resuming it can change it\./);
});

test('the same rows are plain text when the page gives no way to open the lists, and speak Spanish', () => {
  const html = render(chat(undefined), 'es');
  assert.match(html, /2 de 3 activos/);
  assert.match(html, /Sin preset · Ver reglas/, 'a row starts in sentence case');
  assert.doesNotMatch(html, /link-btn/);
});
