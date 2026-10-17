// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeMessage, type TranscriptEntry } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChatUiProvider, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { transcriptRows } from '@claudio/chat-ui/lib/chat-steps';
import { readNotices } from '@claudio/chat-ui/lib/chat-notice';
import { CompactionDivider, compactionLabel, type CompactionActions } from '@claudio/chat-ui/components/CompactionDivider';
import { EntryView, Transcript } from '@claudio/chat-ui/components/Transcript';
import { formatClock } from '@claudio/ui/lib/format';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import i18n, { setLanguage } from '../src/i18n';

// A compaction is the system's line, never a person's message: the divider says it in one sentence
// and the summary Claude continued from sits in its fold (docs/plans/context-control.md, "The divider").

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/test/fixtures');
const recorded = readFileSync(join(fixtures, 'recordings/claude/compacted.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => normalizeMessage(JSON.parse(line) as Record<string, unknown>))
  .filter((entry): entry is TranscriptEntry => entry !== null);

// tsx compiles the packages' files with the classic runtime too, and they do not import React
(globalThis as { React?: typeof React }).React = React;

const config = { agentNameFor: () => 'Claude', paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '/', connectors: '/connectors' } } as unknown as ChatUiConfig;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  setLanguage(lang);
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatUiProvider value={config}>
        <TooltipProvider>
          <ToastProvider>{node}</ToastProvider>
        </TooltipProvider>
      </ChatUiProvider>
    </MemoryRouter>,
  );
}

const t = i18n.getFixedT(null, 'chat');
const AT = '2026-10-16T14:02:00.000Z';
const boundary = (over: Partial<NonNullable<TranscriptEntry['compaction']>> = {}): TranscriptEntry => ({
  uuid: 'b1',
  role: 'user',
  timestamp: AT,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [],
  compaction: { part: 'boundary', trigger: 'manual', preTokens: 142_000, postTokens: 18_000, durationMs: 7000, ...over },
});
const summary = (uuid = 's1'): TranscriptEntry => ({
  uuid,
  role: 'user',
  timestamp: null,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text: 'This session is being continued.\n\n## Primary Request\nShip the divider' }],
  compaction: { part: 'summary', trigger: null, preTokens: null, postTokens: null, durationMs: null },
});

test('the label says how it compacted, from what to what, and when, its figures in the language', async () => {
  // setLanguage, not i18n alone: the figures follow the language Intl formats with
  setLanguage('en');
  await i18n.changeLanguage('en');
  assert.equal(compactionLabel(boundary(), t), `Compacted · by hand · 142k → 18.0k tokens · ${formatClock(AT)}`);
  assert.match(compactionLabel(boundary({ trigger: 'auto' }), t), /^Compacted · automatic · /);
  // The CLI gave no figure after: the label says only where it came from
  assert.match(compactionLabel(boundary({ postTokens: null }), t), /142k → tokens/);
  setLanguage('es');
  await i18n.changeLanguage('es');
  assert.match(compactionLabel(boundary({ trigger: 'auto' }), t), /^Compactado · automático · /);
  assert.match(compactionLabel(boundary(), t), /142k → 18,0k tokens/);
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('the divider is a separator named by its whole line and carries no message chrome', () => {
  const html = render(<CompactionDivider boundary={boundary()} summary={null} summaryBody={null} />);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-label="Compacted · by hand · 142k/);
  assert.doesNotMatch(html, /class="msg|avatar|msg-actions/);
});

test('a summary right after its boundary folds into the divider, with the save button only when the app offers it', () => {
  const entries = [boundary(), summary()];
  const rows = transcriptRows(entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, 'compaction');
  const body = <p>the summary</p>;
  const divider = (extra: { actions?: CompactionActions; focused?: boolean }, lang: 'en' | 'es' = 'en') =>
    render(<CompactionDivider boundary={entries[0] ?? null} summary={entries[1] ?? null} summaryBody={body} {...extra} />, lang);
  const closed = divider({});
  assert.match(closed, /See the summary the conversation continues from/);
  assert.doesNotMatch(closed, /the summary<\/p>/);
  // A search hit inside the summary opens the fold
  const open = divider({ focused: true });
  assert.match(open, /the summary<\/p>/);
  assert.doesNotMatch(open, /Save as note/);
  assert.match(divider({ focused: true, actions: { saveAsNote: () => undefined } }), /Save as note/);
  assert.doesNotMatch(divider({ focused: true, actions: { saveAsNote: () => undefined, noted: new Set(['s1']) } }), /Save as note/);
  assert.match(divider({}, 'es'), /Ver el resumen con el que sigue la conversación/);
});

test('a summary with no boundary before it is a lone fold', () => {
  const rows = transcriptRows([summary()]);
  assert.deepEqual(rows.map((row) => row.kind), ['compaction']);
  const html = render(<CompactionDivider boundary={null} summary={summary()} summaryBody="x" />);
  assert.doesNotMatch(html, /role="separator"/);
  assert.match(html, /Summary the conversation continues from/);
});

test('a boundary without a summary after it stands alone, and the next message is not folded in', () => {
  const next: TranscriptEntry = { ...summary('m1'), compaction: undefined, blocks: [{ type: 'text', text: 'carry on' }] };
  const rows = transcriptRows([boundary(), next]);
  assert.deepEqual(rows.map((row) => row.kind), ['compaction', 'entry']);
});

test("no recorded summary is ever drawn as a person's message", () => {
  const summaries = recorded.filter((entry) => entry.compaction?.part === 'summary');
  assert.ok(summaries.length > 0);
  for (const entry of summaries) {
    assert.doesNotMatch(render(<EntryView entry={entry} />), /class="msg /);
  }
  const rows = transcriptRows(recorded);
  assert.ok(rows.some((row) => row.kind === 'compaction'));
  for (const row of rows) {
    if (row.kind === 'entry') assert.equal(row.entry.compaction, undefined);
  }
  const html = render(<Transcript entries={recorded} rows={rows} />);
  assert.doesNotMatch(html, /This session is being continued/);
});

test('a failed compaction is a notice of its own kind', () => {
  const { prose, notices } = readNotices('<local-command-stderr>Error during compaction: API Error: Request was aborted.\nmore</local-command-stderr>');
  assert.equal(prose, '');
  assert.equal(notices[0]?.kind, 'compaction-failed');
  assert.equal(notices[0]?.body, 'more');
  assert.equal(readNotices('<local-command-stderr>boom</local-command-stderr>').notices[0]?.kind, 'output');
});
