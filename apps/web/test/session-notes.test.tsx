// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { type ChatSessionNote } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';
import { JOURNAL_ENTRY_MAX, maskSecrets, noteHeadline } from '../src/pages/chat/context-model';
import { JournalForm, SessionNotesView, type SessionNotesViewProps } from '../src/pages/chat/SessionNotes';

// The inspector's notes (docs/plans/context-control.md, "Session notes"): pending, ready, failed and
// empty, from data. The note's fold is closed in static markup, so its inside is asserted on the
// pieces that draw it.

(globalThis as { React?: typeof React }).React = React;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  setLanguage(lang);
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <ToastProvider>{node}</ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const note = (over: Partial<ChatSessionNote> = {}): ChatSessionNote => ({
  id: 'n1',
  chatId: 'c1',
  source: 'compaction',
  state: 'ready',
  text: '## Goal\nShip the panel\n\n## Next step\nWrite the tests',
  sections: null,
  compactionId: 'k1',
  entryUuid: 'u1',
  error: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  readyAt: '2026-10-16T10:01:00.000Z',
  ...over,
});

const view = (over: Partial<SessionNotesViewProps> = {}, lang: 'en' | 'es' = 'en') =>
  render(<SessionNotesView notes={[]} hasProject writeBlocked={null} onWrite={() => undefined} onDelete={() => undefined} onJournal={() => undefined} {...over} />, lang);

test('empty: one quiet sentence and the button, no illustration', () => {
  const html = view();
  assert.match(html, /No notes yet/);
  assert.match(html, /Write a note/);
  assert.doesNotMatch(html, /<svg[^>]*illustration|class="empty/);
});

test('ready: the date, where it came from and its first line, folded', () => {
  const html = view({ notes: [note()] });
  assert.match(html, /from a compaction/);
  assert.match(html, /<span class="note-line small ellipsis">Goal<\/span>/);
  assert.match(html, /collapsible-trigger/);
  assert.equal(noteHeadline(note(), 'x'), 'Goal');
  assert.equal(noteHeadline({ text: null }, 'Session note'), 'Session note');
});

test('pending: the ring spinner and "Writing the note…", and it cannot be deleted yet', () => {
  const html = view({ notes: [note({ state: 'pending', text: null, readyAt: null, source: 'agent' })] });
  assert.match(html, /spinner-ring/);
  assert.match(html, /Writing the note…/);
  assert.match(html, /asked for/);
  assert.match(view({ notes: [note({ state: 'pending', text: null })] }, 'es'), /Escribiendo la nota…/);
});

test('failed: the bad tag with its word', () => {
  const html = view({ notes: [note({ state: 'failed', text: null, error: 'The turn hit its budget' })] });
  assert.match(html, /badge-bad/);
  assert.match(html, />Failed</);
});

test('writing a note is disabled with the same refusal as compacting, and the reason is readable', () => {
  const html = view({ writeBlocked: 'The chat is working. Interrupt it first, or wait for the turn to end.' });
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /aria-description="The chat is working/);
  assert.doesNotMatch(view(), /aria-disabled/);
});

test('an error from the list or from asking for a note is shown', () => {
  assert.match(view({ error: new Error('list down') }), /list down/);
  assert.match(view({ writeError: new Error('already open') }), /already open/);
});

test('Spanish: the section and its button', () => {
  const html = view({}, 'es');
  assert.match(html, /Notas de sesión/);
  assert.match(html, /Escribir una nota/);
});

test('the journal form: counter in mono, saving blocked over the limit by the dialog, the words for it', () => {
  const ok = render(<JournalForm text="short" onText={() => undefined} />);
  assert.match(ok, /5 \/ 8,000 characters/);
  assert.doesNotMatch(ok, /text-bad/);
  const over = render(<JournalForm text={'x'.repeat(JOURNAL_ENTRY_MAX + 1)} onText={() => undefined} />);
  assert.match(over, /text-bad/);
  assert.match(over, /over the limit, trim it/);
  assert.match(over, /aria-invalid="true"/);
});

test('the journal prefill never carries a secret', () => {
  const text = maskSecrets('Run with API_KEY=sk-live-abcdefghijklmnop1234 then ghp_abcdefghijklmnopqrstuvwxyz1234');
  assert.doesNotMatch(text, /sk-live|ghp_/);
});
