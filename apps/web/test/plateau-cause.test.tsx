// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectFlowSettings, Team, TeamMember } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { DirtyProvider } from '../src/lib/dirty';
import i18n from '../src/i18n';
import { sameFlow } from '../src/pages/team/model';
import { workItemStrip } from '../src/lib/work-items';
import { WorkItemStrip } from '../src/pages/tasks/board/WorkItemStrip';
import { FlowEditor } from '../src/pages/team/Flow';
import { causeLine, historyLine } from '../src/pages/tasks/item/model';

// The plateau rule of idea 14 on the screens: a card stopped by it says "no improvement in two
// rounds" on the board and in its history, apart from the bounce limit, and the Flow screen holds
// the switch that turns the stop on.

const project: Project = { id: 'p', name: 'shop', path: '/tmp/shop', worktrees: [], repo: null, removedWorktrees: 0, insideWorktreeOf: null, exists: true, chatCount: 0, lastActivity: null, key: 'SHOP', modules: ['team'] };
const member: TeamMember = {
  role: 'developer',
  agent: 'developer',
  model: 'sonnet',
  responsibility: '',
  file: { path: '.claude/agents/developer.md', state: 'missing', drift: [], description: null, model: null, updatedAt: null },
  columns: [],
  running: [],
  queued: 0,
  lastRun: null,
};
const team: Team = { projectId: 'p', enabled: true, members: [member], unassignedAgents: [] };
const FLOW: ProjectFlowSettings = { enabled: true, columns: { in_progress: 'developer', in_review: 'qa' }, maxBounces: 5 };

function wrap(children: ReactNode) {
  const page = (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <DirtyProvider>{children}</DirtyProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
  const router = createMemoryRouter([{ path: '*', element: page }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const strip = (waitingCause?: 'plateau') => workItemStrip({ id: 'i', status: 'in_review', activeLink: null, waiting: 'bounces', bounces: 2, pullRequest: null, ...(waitingCause ? { waitingCause } : {}) });
const board = (waitingCause?: 'plateau') => {
  const state = strip(waitingCause);
  assert.ok(state);
  return text(wrap(<WorkItemStrip item={{ id: 'i', key: 'SHOP-1', status: 'in_review' }} strip={state} sources={{ chats: [], orchestrations: [] }} />));
};

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a card stopped by the plateau says so on the board, apart from one that used its bounces', async () => {
  assert.deepEqual(strip('plateau'), { kind: 'bounces', count: 2, plateau: true });
  assert.deepEqual(strip(), { kind: 'bounces', count: 2 });
  assert.match(board('plateau'), /waits for you No improvement in two rounds/);
  assert.match(board(), /Sent back 2 times/);
  assert.doesNotMatch(board(), /No improvement/);
  await i18n.changeLanguage('es');
  assert.match(board('plateau'), /te espera Sin mejora en dos rondas/);
  assert.match(board(), /Devuelta 2 veces/);
});

test("the item's history gives the plateau its own sentence and cause, in both languages", async () => {
  const entry = { change: 'waiting' as const, from: null, to: 'bounces', cause: { kind: 'chat' as const, chatId: 'c', orchestrationId: null, taskId: null, event: 'flow.plateau' } };
  assert.equal(historyLine(entry).key, 'history.waitingPlateau');
  assert.equal(historyLine({ ...entry, cause: { ...entry.cause, event: 'flow.bounces' } }).key, 'history.waitingBounces');
  assert.equal(historyLine({ change: 'waiting', from: null, to: 'bounces' }).key, 'history.waitingBounces');
  assert.deepEqual(causeLine(entry.cause), { key: 'cause.flowPlateau', values: { chat: 'c', noun: 'PR', host: 'GitHub' } });
  assert.equal(i18n.t('workItem:history.waitingPlateau'), 'Waiting for you: two rounds brought no improvement');
  assert.equal(i18n.t('workItem:cause.flowPlateau'), 'no improvement in two rounds');
  await i18n.changeLanguage('es');
  assert.equal(i18n.t('workItem:history.waitingPlateau'), 'Te espera: dos rondas sin mejora');
  assert.equal(i18n.t('workItem:cause.flowPlateau'), 'sin mejora en dos rondas');
});

test('the Flow screen has a three-value control for the plateau rule: observe by default, stop, off, in both languages', async () => {
  const editor = (flow: ProjectFlowSettings) => wrap(<FlowEditor project={project} team={team} flow={flow} proposal={null} switcher={null} activityHref="" />);
  const control = (html: string, label: string) => {
    const group = new RegExp(`role="radiogroup"[^>]*aria-label="${label}"(.*?)</div>`, 's').exec(html)?.[1] ?? '';
    return /aria-checked="true"[^>]*>(?:<[^>]*>)*([^<]+)</.exec(group)?.[1];
  };
  assert.doesNotMatch(editor(FLOW), /role="switch"[^>]*aria-label="Two rounds without improvement"/, 'a switch has two positions and the rule three values');
  assert.match(text(editor(FLOW)), /Observe only notes it in a comment/);
  assert.equal(control(editor(FLOW), 'Two rounds without improvement'), 'Observe');
  assert.equal(control(editor({ ...FLOW, plateau: 'observe' }), 'Two rounds without improvement'), 'Observe');
  assert.equal(control(editor({ ...FLOW, plateau: 'stop' }), 'Two rounds without improvement'), 'Stop');
  assert.equal(control(editor({ ...FLOW, plateau: 'off' }), 'Two rounds without improvement'), 'Off');
  await i18n.changeLanguage('es');
  assert.equal(control(editor({ ...FLOW, plateau: 'stop' }), 'Dos rondas sin mejora'), 'Parar');
  assert.equal(control(editor({ ...FLOW, plateau: 'off' }), 'Dos rondas sin mejora'), 'Desactivado');
});

test('turning the stop on is a change to save, and observe and an absent value are the same', () => {
  assert.equal(sameFlow(FLOW, { ...FLOW, plateau: 'observe' }), true);
  assert.equal(sameFlow(FLOW, { ...FLOW, plateau: 'stop' }), false);
  assert.equal(sameFlow(FLOW, { ...FLOW, plateau: 'off' }), false, 'off is a change from observing');
});
