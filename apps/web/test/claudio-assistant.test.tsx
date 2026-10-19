// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api';
import { phoneHeaderOf } from '../src/components/shell/phone-header';
import i18n from '../src/i18n';
import { ClaudioAssistant } from '../src/pages/claudio-assistant/Entry';
import { Recents } from '../src/pages/claudio-assistant/Recents';
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
    assert.match(words, language === 'es' ? /Hola, soy Claudio/ : /Hi, I'm Claudio/);
    assert.equal((html.match(/class="as-starter"/g) ?? []).length, STARTERS.length);
    for (const { key } of STARTERS) {
      assert.ok(words.includes(i18n.t(`assistant:claudio.starter.${key}.title`)), key);
      assert.ok(words.includes(i18n.t(`assistant:claudio.starter.${key}.ask`)), key);
    }
    // A starter only fills the composer: the one start button is disabled until there is text
    assert.match(html, /<button type="submit" class="btn btn-primary new-start"[^>]*disabled/);
    assert.doesNotMatch(html, /as-context/, 'with no project in scope there is no context chip');
    // Claudio is the page's face, always there; it is not an `Empty`, and no live figure sits beside it
    assert.match(html, /<div class="as-hello"><svg class="il[^"]*"[^>]*data-illustration="claudio"/);
    assert.doesNotMatch(html, /as-figures/);
  });

  test(`the entry's box is New chat's, centred under the greeting, without what the assistant cannot use (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<ClaudioAssistant />);
    // New chat's card: the editor, then a foot with the chips, the key hint and the start button
    const order = ['class="as-hello"', 'class="new-composer-wrap"', '<form class="composer grad-border new-composer"', 'class="composer-editor"', 'class="new-composer-foot"', 'class="composer-status"', 'class="composer-keys"', 'new-start', 'class="as-starters-section"'];
    const at = order.map((mark) => html.indexOf(mark));
    assert.ok(at.every((i) => i >= 0), `every part of the start box is drawn (${order.filter((_, i) => at[i]! < 0).join(', ')})`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'greeting, then the box, then the starters');
    assert.equal((html.match(/class="new-composer-wrap"/g) ?? []).length, 1, 'one composer');
    // The shared rule: Enter breaks the line, Ctrl/⌘+Enter starts
    assert.match(html, /<kbd>Ctrl<\/kbd>/);
    // The model and the effort are the chips; no permission mode is offered, so none is in the accent
    assert.match(html, /class="composer-status-text">sonnet</);
    assert.doesNotMatch(html, /composer-status-word is-accent/);
    // Hidden: files, the "+" (commands, servers, account), the stop, and the energy of a working chat
    assert.doesNotMatch(html, /composer-attach|composer-plus|composer-stop|live-energy|is-working/);
    // The duplicate is gone: no textarea of its own, no foot of its own
    assert.doesNotMatch(html, /<textarea|as-composer/);
  });

  test(`the greeting is the first message of an assistant's chat (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<AssistantGreeting />);
    assert.match(html, /class="as-greeting"/);
    assert.ok(text(html).includes(i18n.t('assistant:claudio.greeting')));
    assert.match(html, /class="mascot-mark"/, "Claudio's colour mark speaks the greeting");
  });
}

/** Renders the recents with the list already in the cache, as the page reads it */
const recentsOf = (client: QueryClient, narrow = false) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <Recents narrow={narrow} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const withRecents = (chats: unknown, narrow = false) => {
  const client = new QueryClient();
  client.setQueryData(['chats', { assistant: true, limit: 5 }], chats);
  return recentsOf(client, narrow);
};
const summary = (over: Record<string, unknown>) => ({ id: 'c', title: 'T', firstPrompt: 'T', state: 'idle', alive: false, activity: null, updatedAt: null, executions: [], ...over });

for (const language of ['en', 'es'] as const) {
  test(`the recents list the assistant's chats with a word for working and waiting, and none for idle (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = withRecents([
      summary({ id: 'a', title: 'Working one', state: 'working', alive: true }),
      summary({ id: 'b', title: 'Waiting one', state: 'waiting', alive: true }),
      summary({ id: 'c', title: 'Idle one' }),
    ]);
    assert.ok(text(html).includes(i18n.t('assistant:claudio.recent.title')));
    assert.match(html, /href="\/chats\/a"/);
    assert.match(html, /as-recent-word is-live/);
    assert.match(html, /as-recent-word is-idle/);
    assert.equal((html.match(/as-recent-word/g) ?? []).length, 2, 'an idle chat shows no word, only a screen reader line');
    assert.match(html, /href="\/chats\?assistant=1"/, 'Ver todas opens Chats filtered to the assistant');
    assert.doesNotMatch(html, /spinner|ticker|live-rail/);
  });
}

test('a chat whose last run failed says it in the bad colour', async () => {
  await i18n.changeLanguage('en');
  const failed = summary({ id: 'f', executions: [{ id: 'e', outcome: 'failed', endedAt: '2026-01-01T00:00:00.000Z' }] });
  const html = withRecents([failed]);
  assert.match(html, /as-recent-word is-bad/);
});

test('the recents show three rows on a phone, and nothing at all for an empty list', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((id) => summary({ id }));
  assert.equal((withRecents(many, true).match(/class="as-recent"/g) ?? []).length, 3);
  assert.equal((withRecents(many).match(/class="as-recent"/g) ?? []).length, 5);
  assert.equal(withRecents([]), '');
});

test('a failed read of the recents says so and offers Reintentar', async () => {
  await i18n.changeLanguage('es');
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  // A cached failure: a fresh observer would otherwise count as pending while it tries again
  const key = ['chats', { assistant: true, limit: 5 }];
  client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', error: new Error('down'), fetchStatus: 'idle', errorUpdatedAt: Date.now() });
  const html = recentsOf(client);
  assert.match(html, /as-recents-error/);
  assert.ok(text(html).includes('Reintentar'));
});

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
