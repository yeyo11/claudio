// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalHistoryEntry } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { HistoryRows, HistoryTable } from '../src/pages/config/security/TerminalCard';

const entry = (over: Partial<TerminalHistoryEntry> = {}): TerminalHistoryEntry => ({
  id: 't1',
  scope: { kind: 'workspace' },
  cwd: '/home/yeyo/Escritorio/claudio/.claude/worktrees/some-long-worktree-name/apps/web/src',
  shell: '/bin/bash',
  actor: 'owner',
  client: 'web',
  startedAt: '2026-10-20T10:00:00Z',
  endedAt: '2026-10-20T10:05:00Z',
  endReason: 'closed',
  exitCode: null,
  attachments: [],
  ...over,
});

async function rows(entries: TerminalHistoryEntry[], language = 'en'): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(<HistoryRows entries={entries} />);
}

test('the rows are list items, not a table, and the directory is shortened as a button', async () => {
  const html = await rows([entry()]);
  assert.match(html, /<li class="term-history-row"/);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<button[^>]*class="term-history-cwd mono small"[^>]*aria-expanded="false"[^>]*>…\//);
});

test('an entry with no directory shows a dash and no button', async () => {
  const html = await rows([entry({ cwd: '' })]);
  assert.doesNotMatch(html, /term-history-cwd/);
  assert.match(html, /—/);
});

test('the actor words are sans and an id is mono, in the rows and in the table', async () => {
  const html = await rows([entry({ actor: 'owner' }), entry({ id: 't2', actor: 'anonymous' }), entry({ id: 't3', actor: 'token:abc123' })]);
  assert.match(html, /Owner/);
  assert.match(html, /Anonymous/);
  assert.doesNotMatch(html, /<span class="mono">owner<\/span>/);
  assert.match(html, /<span class="mono">token:abc123<\/span>/);
  const table = renderToStaticMarkup(<HistoryTable entries={[entry(), entry({ id: 't3', actor: 'token:abc123' })]} />);
  assert.match(table, /Owner/);
  assert.match(table, /<span class="mono">token:abc123<\/span>/);
});

test('the actor words are Spanish in es', async () => {
  const html = await rows([entry({ actor: 'owner' }), entry({ id: 't2', actor: 'anonymous' })], 'es');
  assert.match(html, /Propietario/);
  assert.match(html, /Anónimo/);
  await i18n.changeLanguage('en');
});

test('a refused attempt keeps its warn tag in the rows', async () => {
  const html = await rows([entry({ attachments: [{ refused: 'needs-auth' } as TerminalHistoryEntry['attachments'][number]] })]);
  assert.match(html, /1 attempt refused: no token/);
});
