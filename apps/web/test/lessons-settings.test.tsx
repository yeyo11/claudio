// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonSettings } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { LessonsTab, lessonSettingsProblem } from '../src/pages/config/LessonsTab';
import { detailsOf, sectionsOf } from '../src/pages/config/settingsGroups';
import { lesson } from './lesson-fixtures';

const settings: LessonSettings = {
  manualMining: true,
  miner: { model: 'sonnet', effort: null, maxCostUsd: 0.05, deadlineSeconds: 120 },
  caps: { perProjectDailyUsd: 1, globalDailyUsd: 5, perChatMinMinutes: 10, perProjectDailyJobs: 20 },
  confidence: { approveFloor: 0.8, deliverAt: 0.7, seenStep: 0.05, confirmStep: 0.1, max: 0.95 },
  decay: { graceDays: 60, periodDays: 30, step: 0.1, retireBelow: 0.4 },
  delivery: { handoffBytes: 2048, looseChats: false },
  signals: { repeatedErrorsTrigger: true },
};

test('the settings validate ranges and the retire threshold before saving', () => {
  assert.equal(lessonSettingsProblem(settings), null);
  assert.equal(lessonSettingsProblem({ ...settings, miner: { ...settings.miner, maxCostUsd: 5 } }), 'range');
  assert.equal(lessonSettingsProblem({ ...settings, delivery: { ...settings.delivery, handoffBytes: 100 } }), 'range');
  assert.equal(lessonSettingsProblem({ ...settings, decay: { ...settings.decay, retireBelow: 0.7 } }), 'order');
});

test('Settings → Lessons lists the global lessons with "Back to a project" and the settings fields', async () => {
  await i18n.changeLanguage('en');
  assert.ok(sectionsOf('instructions').includes('lessons') && detailsOf('instructions').includes('lessons'));
  const client = new QueryClient();
  client.setQueryData(keys.lessons(null, 'all'), { lessons: [lesson('9', { projectId: null })], handed: { lessons: 1, bytes: 1, budget: 1, overBudget: 0 } });
  client.setQueryData(keys.lessonSettings, settings);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: (<>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <DirtyProvider><LessonsTab /></DirtyProvider>
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </>) }])} />
    </QueryClientProvider>,
  );
  assert.match(html, /Global lessons/);
  assert.match(html, /L-9/);
  assert.match(html, /Cost per run/);
  assert.match(html, /Allow “Look for lessons”/);
});
