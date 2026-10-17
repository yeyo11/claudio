// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat } from '@claudio/shared';
import { Composer } from '@claudio/chat-ui/composer/Composer';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api';
import { phoneHeaderOf } from '../src/components/shell/phone-header';
import i18n from '../src/i18n';
import { ClaudioAssistant } from '../src/pages/claudio-assistant/Entry';
import { AssistantGreeting } from '../src/pages/claudio-assistant/Greeting';
import { CLAUDIO_ASSISTANT_PATH, STARTERS } from '../src/pages/claudio-assistant/model';
import { ProjectScopeProvider } from '../src/lib/project-scope';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';

// CW-18, the web part: the entry screen, its greeting and starters, the greeting of an assistant's
// chat, and the call that starts it.

// The chat package is compiled with the classic runtime here, and the entry's box is its composer
(globalThis as { React?: typeof React }).React = React;

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <ProjectScopeProvider>{children}</ProjectScopeProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('the entry is a route of its own, headed by its page on a phone, apart from the project assistant', () => {
  assert.equal(CLAUDIO_ASSISTANT_PATH, '/assistant');
  assert.equal(phoneHeaderOf('/assistant'), 'page');
  assert.equal(phoneHeaderOf('/assistant/'), 'page');
  assert.equal(phoneHeaderOf('/projects/p1/assistant'), 'page', 'the project assistant keeps its own entry');
});

for (const language of ['en', 'es'] as const) {
  test(`the entry greets, offers its starters as buttons that fill the box, and has no project required (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<ClaudioAssistant />);
    const words = text(html);
    assert.match(words, language === 'es' ? /Hola, soy el asistente de Claudio/ : /Hi, I'm the Claudio assistant/);
    assert.equal((html.match(/class="as-starter"/g) ?? []).length, STARTERS.length);
    for (const { key } of STARTERS) {
      assert.ok(words.includes(i18n.t(`assistant:claudio.starter.${key}.title`)), key);
      assert.ok(words.includes(i18n.t(`assistant:claudio.starter.${key}.ask`)), key);
    }
    // A starter only fills the composer: the one send button is disabled until there is text
    assert.match(html, /<button type="submit" class="composer-send"[^>]*disabled/);
    assert.doesNotMatch(html, /as-context/, 'with no project in scope there is no context chip');
    // Never the gradient on the mark, never an Empty illustration
    assert.doesNotMatch(html, /grad-border|illustration/);
  });

  test(`the entry's box is a chat's composer, without what the assistant cannot use (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<ClaudioAssistant />);
    // The chat's card, editor, line of chips and keys, in the chat's order
    const order = ['class="composer-wrap"', '<form class="composer"', 'class="composer-editor"', 'class="composer-send"', 'class="composer-foot"', 'class="composer-status"', 'class="composer-keys"'];
    const at = order.map((mark) => html.indexOf(mark));
    assert.ok(at.every((i) => i >= 0), `every part of the chat's composer is drawn (${order.filter((_, i) => at[i]! < 0).join(', ')})`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the order a chat draws them');
    assert.equal((html.match(/class="composer-wrap"/g) ?? []).length, 1, 'one composer');
    assert.ok(text(html).includes(i18n.t('chat:composer.keys')), "the chat's keys hint");
    // The model and the effort are the chips; no permission mode is offered, so none is in the accent
    assert.match(html, /class="composer-status-text">sonnet</);
    assert.doesNotMatch(html, /composer-status-word is-accent/);
    // Hidden: the "+" (files, commands, servers, account), the stop, and the energy of a working chat
    assert.doesNotMatch(html, /composer-plus|composer-stop|live-energy|is-working/);
    // The duplicate is gone: no textarea of its own, no foot of its own
    assert.doesNotMatch(html, /<textarea|as-composer/);
  });

  test(`the entry's box draws what a chat's composer draws, less the "+" (${language})`, async () => {
    await i18n.changeLanguage(language);
    const idle = { id: 'c1', title: 'A chat', provider: 'claude-code', model: 'sonnet', cwd: '/work', state: 'idle', execution: null, executions: [], updatedAt: '2026-10-17T10:00:00Z' } as unknown as Chat;
    const config = { client: {}, agentNameFor: () => 'Claude', fallbackInterval: false, paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '' }, slots: {} } as unknown as ChatUiConfig;
    const chat = wrap(
      <ChatUiProvider value={config}>
        <Composer chat={idle} kind="send" onSent={() => {}} />
      </ChatUiProvider>,
    );
    const entry = wrap(<ClaudioAssistant />);
    // Every composer class, once, in the order it first appears
    const parts = (html: string) => [...new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/)).filter((c) => c.startsWith('composer')))];
    assert.ok(parts(chat).includes('composer-plus'), "a chat's box has its +");
    assert.deepEqual(parts(entry), parts(chat).filter((c) => c !== 'composer-plus'));
  });

  test(`the greeting is the first message of an assistant's chat (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<AssistantGreeting />);
    assert.match(html, /class="as-greeting"/);
    assert.ok(text(html).includes(i18n.t('assistant:claudio.greeting')));
  });
}

test('starting posts the prompt, the project and the model to /assistant/chats', async () => {
  const real = globalThis.fetch;
  let seen: { url: string; method: string; body: unknown; language: string | null } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: JSON.parse(String(init?.body)),
      language: new Headers(init?.headers).get('accept-language'),
    };
    return new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await i18n.changeLanguage('es');
    const chat = await api.startClaudioAssistantChat({ prompt: '¿Cuánto he gastado hoy?', projectId: 'p1', model: 'sonnet' });
    assert.equal(chat.id, 'c1');
    assert.ok(seen?.url.endsWith('/assistant/chats'));
    assert.equal(seen?.method, 'POST');
    assert.deepEqual(seen?.body, { prompt: '¿Cuánto he gastado hoy?', projectId: 'p1', model: 'sonnet' });
    assert.equal(seen?.language, 'es');
  } finally {
    globalThis.fetch = real;
  }
});
