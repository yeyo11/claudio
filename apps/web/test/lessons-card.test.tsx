// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonList } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls';
import i18n from '../src/i18n';
import { lesson } from './lesson-fixtures';
import { LessonsCard } from '../src/pages/home/memory/Lessons';

const render = (list: LessonList | null, phone = false, error = false): string => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (list) client.setQueryData(keys.lessons('p', 'all'), list);
  void error;
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider><ToastProvider>
          <ConfirmProvider>
            <LessonsCard projectId="p" phone={phone} settingsHref="/?view=settings" />
          </ConfirmProvider>
        </ToastProvider></TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const handed = { lessons: 1, bytes: 100, budget: 2048, overBudget: 0 };

test('a row says its key, sentence, confidence and the words for pinned and fading', async () => {
  await i18n.changeLanguage('en');
  const html = render({
    lessons: [
      lesson('1', { pinned: true }),
      lesson('2', { confidence: 0.85, effectiveConfidence: 0.7 }),
      lesson('3', { evidence: [{ id: 'e', signal: 'correction', quote: 'no, usa pnpm siempre', context: 'Bash: npm install', chatId: null, chatTitle: null, entryUuid: null, at: '2026-10-01T00:00:00.000Z' }] }),
    ],
    handed,
  });
  assert.match(html, /L-1/);
  assert.match(html, /When installing packages:/);
  assert.match(html, /pinned/);
  assert.match(html, /fading/);
  assert.match(html, /delivered/);
  assert.match(html, /0\.70/);
  assert.match(html, /3 active/);
  assert.doesNotMatch(html, /<select|type="checkbox"/);
});

test('retired lessons stay out of the Active view, and a card with none says how they come', async () => {
  await i18n.changeLanguage('en');
  const html = render({ lessons: [lesson('1', { status: 'retired', retiredReason: 'decayed' })], handed });
  assert.doesNotMatch(html, /L-1/);
  assert.match(html, /No active lessons/);
  const empty = render({ lessons: [], handed: { ...handed, lessons: 0 } });
  assert.match(empty, /No lessons yet\. They come from your corrections/);
});

test('over budget is a warn word beside the handed count', async () => {
  await i18n.changeLanguage('en');
  const html = render({ lessons: [lesson('1')], handed: { ...handed, overBudget: 2 } });
  assert.match(html, /handed: 1 of 3/);
  assert.match(html, /badge-warn[^>]*>.*over budget/s);
});

test('loading shows a skeleton and the Spanish copy is in place', async () => {
  await i18n.changeLanguage('es');
  const loading = render(null);
  assert.match(loading, /Lecciones/);
  const html = render({ lessons: [lesson('1', { pinned: true })], handed });
  assert.match(html, /fijada/);
  assert.match(html, /1 activa/);
  await i18n.changeLanguage('en');
});
