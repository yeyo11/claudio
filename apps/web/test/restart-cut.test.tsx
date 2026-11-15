// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Chat, Execution } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { RestartCutBanner, restartCut } from '../src/pages/chat/RestartCut';

// The Resume a person's chat offers when Claudio restarted mid-turn and did not continue it by
// itself (docs/plans/survive-restarts.md, D7): which chats show it, and what it says.

(globalThis as { React?: typeof React }).React = React;

const HOUR = 60 * 60_000;

const execution = (over: Partial<Execution> = {}): Execution => ({
  id: 'e1',
  startedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
  endedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  outcome: 'interrupted',
  error: 'interrupted by a wrapper restart',
  permissionMode: 'acceptEdits',
  model: 'opus',
  maxBudgetUsd: null,
  costUsd: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
  purpose: 'person',
  turnOpen: true,
  ...over,
});

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    id: 'c1',
    title: 'Fix the login',
    provider: 'claude-code',
    origin: 'claudio',
    alive: false,
    control: { mode: 'resumable' },
    state: 'idle',
    execution: null,
    executions: [execution()],
    ...over,
  }) as unknown as Chat;

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test("a person's chat a restart cut, and nothing continued, offers Resume", () => {
  assert.equal(restartCut(chat())?.id, 'e1');
  assert.equal(restartCut(chat({ origin: 'external' }))?.id, 'e1', 'a terminal chat Claudio drove');
  assert.equal(restartCut(chat({ executions: [execution({ purpose: undefined })] }))?.id, 'e1', 'one recorded before executions kept their purpose');
});

test('no Resume where it would not be the person’s to give', () => {
  assert.equal(restartCut(chat({ alive: true })), null, 'it runs again');
  assert.equal(restartCut(chat({ control: { mode: 'readOnly', reason: 'x', action: 'fork' } })), null);
  for (const origin of ['api', 'internal', 'orchestration'] as const) assert.equal(restartCut(chat({ origin })), null, origin);
  assert.equal(restartCut(chat({ executions: [execution({ purpose: 'flow' })] })), null, 'its flow run continues it');
  assert.equal(restartCut(chat({ executions: [execution({ outcome: 'completed' })] })), null);
  assert.equal(restartCut(chat({ executions: [execution({ turnOpen: false })] })), null, 'its process sat idle waiting for the person: nothing was cut');
  assert.equal(restartCut(chat({ executions: [execution({ turnOpen: undefined })] })), null, 'one recorded before the turn was kept says nothing either way');
  assert.equal(restartCut(chat({ executions: [execution(), execution({ id: 'e2', outcome: 'failed' })] })), null, 'only the last execution counts');
});

test('the banner says when the turn stopped and offers Resume, in both languages', async () => {
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RestartCutBanner chat={chat()} cut={execution()} />
      </QueryClientProvider>,
    );
  const en = text(render());
  assert.match(en, /Claudio restarted while this chat was working/);
  assert.match(en, /Its turn stopped \S.*\. Resume it where it left off\./);
  assert.match(en, /Resume/);
  await i18n.changeLanguage('es');
  const es = text(render());
  assert.match(es, /Claudio se reinició mientras este chat trabajaba/);
  assert.match(es, /Reanudar/);
});

test('a cut older than a month is dated, not "stopped Oct 12"', () => {
  const old = execution({ endedAt: new Date(Date.now() - 60 * 24 * HOUR).toISOString() });
  const html = text(
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RestartCutBanner chat={chat({ executions: [old] })} cut={old} />
      </QueryClientProvider>,
    ),
  );
  assert.match(html, /Its turn stopped on .+\. Resume it where it left off\./);
});

test('the line under the title always holds two lines, so a failed resume’s error takes its place without moving anything', () => {
  const css = readFileSync(new URL('../../../packages/chat-ui/src/styles/chat.css', import.meta.url), 'utf8');
  const rule = /\.restart-cut-lines\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /min-height:\s*2lh/, 'the cell reserves the error’s two lines in both states');
  const clamp = /\.restart-cut-error > span\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(clamp, /-webkit-line-clamp:\s*2/, 'and the error never grows past them');
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RestartCutBanner chat={chat()} cut={execution()} />
    </QueryClientProvider>,
  );
  assert.match(html, /class="restart-cut-lines" data-failed="false"/, 'both lines are in the cell from the start');
  assert.match(html, /class="restart-cut-error"/);
});
