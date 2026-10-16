// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemoryProposal } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { Proposals } from '../src/pages/home/memory/Proposals';
import { lesson } from './lesson-fixtures';

const proposal = (over: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: 'mp1',
  projectId: 'p',
  target: { kind: 'lesson', file: null, section: null },
  text: '- When installing packages: use pnpm',
  reason: '',
  status: 'pending',
  proposedBy: { kind: 'agent' },
  source: null,
  flowRunId: null,
  itemId: null,
  item: null,
  approvedText: null,
  decidedBy: null,
  decidedAt: null,
  rejectReason: null,
  journalEntryId: null,
  lesson: null,
  lessonId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const wrap = (client: QueryClient, node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: (<>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider><DirtyProvider>{node}</DirtyProvider></ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </>) }])} />
    </QueryClientProvider>,
  );

test('a lesson proposal shows its sentence, two quotes of the evidence and the badges in words', async () => {
  await i18n.changeLanguage('en');
  const client = new QueryClient();
  const at = '2026-10-01T00:00:00.000Z';
  const evidence = ['uno', 'dos', 'tres'].map((quote, i) => ({ id: `e${String(i)}`, signal: 'correction' as const, quote, context: 'Bash: npm install', chatId: 'c1', chatTitle: null, entryUuid: null, at }));
  client.setQueryData(keys.lessons('p', 'all'), { lessons: [lesson('7')], handed: { lessons: 0, bytes: 0, budget: 1, overBudget: 0 } });
  client.setQueryData(keys.memoryProposals('p', 'pending'), [proposal({ lesson: lesson('8', { status: 'proposed', contradicts: '7', conflictsWithInstructions: true, evidence }) })]);
  const html = wrap(client, <Proposals projectId="p" />);
  assert.match(html, /When installing packages:/);
  assert.match(html, /Contradicts L-7/);
  assert.match(html, /Conflicts with CLAUDE\.md/);
  assert.match(html, /uno/);
  assert.match(html, /dos/);
  assert.doesNotMatch(html, /tres/);
  assert.match(html, /1 more/);
  assert.match(html, /lessons/);
});

