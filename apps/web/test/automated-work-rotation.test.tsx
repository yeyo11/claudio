// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, FlowRun, ProviderStatus } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { keys } from '../src/api';
import i18n from '../src/i18n';
import { targetMatches, targetsFor } from '../src/lib/events';
import { stripInList, stripTone, workItemStrip } from '../src/lib/work-items';
import { RunWaitWords } from '../src/pages/tasks/board/WorkItemStrip';

// Automated work at a usage limit: a flow run that waits shows its wait on the board and the item,
// and the wait refreshes what every open item reads.

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: 'Claude Code',
  state: 'ready',
  reason: null,
  version: '2.1.282',
  compatibleRange: '>=2.1 <3',
  binaryPath: '/usr/local/bin/x',
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-10-02T10:00:00Z',
  ...over,
});

const waitingRun = (over: Partial<FlowRun> = {}) =>
  ({
    id: 'r1',
    role: 'developer',
    step: 'work',
    state: 'running',
    startedAt: '2026-10-02T11:00:00.000Z',
    activity: null,
    waiting: { provider: 'claude-code', resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), moveId: 'm1' },
    ...over,
  }) as unknown as FlowRun;

const item = { id: 'i1', status: 'in_progress', activeLink: null, waiting: null, bounces: 0, pullRequest: null } as never;

test('a run that waits for its limit is a warn strip, not a live one, and not in the list\'s Now column', () => {
  const run = waitingRun();
  const strip = workItemStrip(item, { running: new Map([['i1', run]]) });
  assert.equal(strip?.kind, 'run-waiting');
  assert.equal(stripTone(strip!), 'warn');
  assert.equal(stripInList(strip), false);
  assert.equal(workItemStrip(item, { running: new Map([['i1', waitingRun({ waiting: null })]]) })?.kind, 'run');
});

test('the strip words the wait: who is waited for and when it resumes', () => {
  void i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code')]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RunWaitWords wait={{ provider: 'claude-code', resetsAt: null }} />
    </QueryClientProvider>,
  );
  assert.match(html, /Waiting for Claude Code/);
  assert.match(html, /the reset time is not known/);
});

test('a wait refreshes the waits and the runs of every item that is open', () => {
  const events = [{ type: 'run.limitWaiting', runId: 'c1' }] as unknown as AgentryEvent[];
  for (const event of events) {
    const targets = targetsFor(event);
    assert.ok(targets.some((t) => targetMatches(t, keys.limitWaits('project:p1'))), `${event.type} waits`);
    assert.ok(targets.some((t) => targetMatches(t, keys.workItemRuns('i1'))), `${event.type} runs`);
    assert.ok(targets.some((t) => targetMatches(t, keys.workItemBoards('p1'))), `${event.type} board`);
  }
});
