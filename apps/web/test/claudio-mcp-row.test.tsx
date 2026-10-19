/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, ChatClaudioMcp, ChatMcpServers, LiveMcpServer } from '@claudio/shared';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
// Not one of the package's exports: the app reaches it through the composer
import { mcpKey, ServersPanel, serversOn } from '../../../packages/chat-ui/src/composer/ServersPanel.tsx';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';

// Claudio's own server in the "+" menu's Servers panel (docs/plans/owner-report-fixes.md, D6): its
// row comes first, apart from the CLI's list, shows once when the CLI lists it too, warns only when
// the chat skips permission checks, and is not offered where it does not apply.

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

const config = { agentNameFor: () => 'Claude', paths: { chat: (id: string) => `/chats/${id}`, connectors: '/connectors' }, client: {} } as unknown as ChatUiConfig;

const docs: LiveMcpServer = { name: 'docs', label: 'docs', kind: 'server', status: 'connected', scope: 'user', tools: [{ name: 'search', readOnly: true, destructive: false }], error: null };
const ours: LiveMcpServer = { name: 'claudio', label: 'claudio', kind: 'server', status: 'connected', scope: 'dynamic', tools: Array.from({ length: 25 }, (_, i) => ({ name: `t${i}`, readOnly: false, destructive: false })), error: null };
const state = (patch: Partial<ChatClaudioMcp> = {}): ChatClaudioMcp => ({ on: false, unavailable: null, error: null, ...patch });

function render(servers: ChatMcpServers, mode: string = 'default', lang: 'en' | 'es' = 'en'): string {
  setLanguage(lang);
  const chat = { id: 'c1', execution: { permissionMode: mode } } as unknown as Chat;
  const queries = new QueryClient();
  queries.setQueryData(mcpKey(chat.id), servers);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queries}>
        <ChatUiProvider value={config}>
          <TooltipProvider>
            <ServersPanel chat={chat} live onChooseTools={() => {}} onDone={() => {}} />
          </TooltipProvider>
        </ChatUiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the Claudio row comes first, outside the list the e2e specs count, with its switch off', () => {
  const html = render({ live: true, servers: [docs], claudio: state() });
  assert.ok(html.indexOf('composer-servers-claudio') < html.indexOf('class="composer-servers"'), 'the row is above the list');
  assert.equal((html.match(/class="composer-server( |")/g) ?? []).length, 1, 'the list keeps only the CLI’s servers');
  assert.match(text(html), /Claudio Edits projects, tasks, chats and orchestrations/);
  assert.match(html, /aria-label="Turn Claudio on"/);
  assert.equal(html.includes('composer-servers-claudio-warn'), false);
});

test('once on, the CLI’s own entry for it merges into the row: shown once, with its tools and status in words', () => {
  const html = render({ live: true, servers: [docs, ours], claudio: state({ on: true }) }, 'default', 'es');
  assert.equal((html.match(/class="composer-server( |")/g) ?? []).length, 1);
  assert.match(text(html), /25 herramientas Conectado/);
  assert.match(html, /aria-label="Desactivar Claudio"/);
});

test('the bypass hint shows only when the chat skips permission checks', () => {
  const bypass = render({ live: true, servers: [], claudio: state({ on: true }) }, 'bypassPermissions', 'es');
  assert.match(text(bypass), /Con «Sin comprobar permisos» sus cambios se aplican sin preguntar/);
  assert.equal(render({ live: true, servers: [], claudio: state({ on: true }) }, 'acceptEdits').includes('composer-servers-claudio-warn'), false);
});

test('a clash or a missing API address disables the switch and says why; a refusal shows the CLI’s words in mono', () => {
  const clash = render({ live: true, servers: [docs], claudio: state({ unavailable: 'clash' }) }, 'default', 'es');
  assert.match(text(clash), /Ya hay un servidor llamado claudio/);
  assert.match(clash, /role="switch"[^>]*disabled/);
  const refused = render({ live: true, servers: [], claudio: state({ error: 'spawn ENOENT' }) });
  assert.match(refused, /<code class="mono">spawn ENOENT<\/code>/);
});

test('the assistant chat and another agent’s chat are not offered the row', () => {
  for (const unavailable of ['assistant', 'provider'] as const) {
    const html = render({ live: true, servers: [docs], claudio: state({ unavailable }) });
    assert.equal(html.includes('composer-servers-claudio'), false, unavailable);
  }
});

test('the Claudio row keeps its status line while off, so switching it on does not push the list down', () => {
  const off = render({ live: true, servers: [docs], claudio: state() });
  assert.match(off, /class="composer-server-meta composer-servers-claudio-status small" aria-hidden="true"><\/span>/);
  const on = render({ live: true, servers: [docs, ours], claudio: state({ on: true }) });
  assert.match(on, /composer-servers-claudio-status[^>]*>.*Connected/);
});

test('the summaries count Claudio’s row as one more switch, on when it is switched on, never twice', () => {
  const off = { ...docs, name: 'off', status: 'disabled' as const };
  assert.deepEqual(serversOn({ servers: [docs, off], claudio: state() }), { on: 1, total: 3 });
  assert.deepEqual(serversOn({ servers: [docs, off, ours], claudio: state({ on: true }) }), { on: 2, total: 3 });
  assert.deepEqual(serversOn({ servers: [docs, off], claudio: state({ unavailable: 'assistant' }) }), { on: 1, total: 2 }, 'not offered, not counted');
  assert.deepEqual(serversOn({ servers: [docs, off] }), { on: 1, total: 2 });
  assert.equal(serversOn(undefined), null);
});
