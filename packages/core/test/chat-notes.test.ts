import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ChatCompaction, TranscriptEntry } from '@claudio/shared';
import { ChatNotes, ContextRefusal, NOTE_REQUEST_PROMPT, parseSessionNote, SESSION_NOTE_INSTRUCTIONS } from '../src/context-notes.ts';
import { COMPACTION_LEASE_MS, Db } from '../src/db.ts';
import type { RunResult } from '../src/live-chat.ts';
import { tempConfig } from './helpers.ts';

// Session notes: the six sections, the three ways a note comes to be, and the texts that ask for one.

const NOTE = [
  'This session is being continued from a previous conversation.',
  '',
  '## Goal',
  'Make the parser accept trailing commas.',
  '## Done (with evidence)',
  '- `pnpm test parser` passed, 41/41',
  '## Failed',
  'Tried a regex: it broke nested arrays.',
  '## Not tried yet',
  'A real tokenizer.',
  '## Files in flight',
  'src/parser.ts',
  '## Next step',
  'Write the tokenizer test first.',
].join('\n');

const summaryEntry = (uuid: string, text: string): TranscriptEntry => ({
  uuid,
  role: 'user',
  timestamp: '2026-03-10T10:05:00Z',
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text }],
  compaction: { part: 'summary', trigger: null, preTokens: null, postTokens: null, durationMs: null },
});
const boundaryEntry = (uuid: string): TranscriptEntry => ({ ...summaryEntry(uuid, ''), blocks: [], compaction: { part: 'boundary', trigger: 'manual', preTokens: 10, postTokens: 1, durationMs: 1 } });

function rig(over: { entries?: TranscriptEntry[]; check?: () => Promise<void>; turn?: (chatId: string, text: string) => Promise<void> } = {}) {
  const db = new Db(tempConfig());
  const turns: string[] = [];
  const notes = new ChatNotes({
    db,
    check: over.check ?? (async () => undefined),
    turn: over.turn ?? (async (_chatId, text) => void turns.push(text)),
    compactionEntries: async () => over.entries ?? [],
  });
  return { db, notes, turns };
}

const compaction = (db: Db, chatId: string, structuredNote = true): ChatCompaction => {
  const now = new Date().toISOString();
  const claimed = db.claimHousekeeping(chatId, { kind: 'compaction', leaseUntil: new Date(Date.now() + COMPACTION_LEASE_MS).toISOString(), row: { id: `c-${chatId}`, origin: 'person', focus: null, structuredNote, flowRunId: null, requestedBy: null, requestedAt: now } }, now);
  assert.ok(claimed);
  db.updateCompaction(`c-${chatId}`, { state: 'done', boundaryUuid: 'b1' }, { from: ['requested'] });
  const row = db.compactionById(`c-${chatId}`);
  assert.ok(row);
  return row;
};

// ---------- the texts ----------

test('the texts that ask for a note are the plan\'s, word for word', () => {
  const plan = readFileSync(fileURLToPath(new URL('../../../docs/plans/context-control.md', import.meta.url)), 'utf8');
  const fenced = /\n    ```text\n((?:    .*\n)+?)    ```/.exec(plan)?.[1];
  assert.ok(fenced, 'the plan has its fixed text');
  const text = fenced
    .split('\n')
    .map((l) => l.replace(/^ {4}/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(SESSION_NOTE_INSTRUCTIONS, text);
  assert.equal(NOTE_REQUEST_PROMPT, text);
});

// ---------- the six sections ----------

test('a summary under the six headings gives six sections', () => {
  const sections = parseSessionNote(NOTE);
  assert.deepEqual(Object.keys(sections ?? {}), ['goal', 'done', 'failed', 'not-tried', 'files', 'next']);
  assert.equal(sections?.goal, 'Make the parser accept trailing commas.');
  assert.match(sections?.done ?? '', /41\/41/);
  assert.equal(sections?.next, 'Write the tokenizer test first.');
});

test('a heading that is missing, or out of order, leaves the text whole and no sections', () => {
  assert.equal(parseSessionNote(NOTE.replace('## Failed', '## What went wrong')), null);
  assert.equal(parseSessionNote(NOTE.replace('## Goal', '## Intent')), null);
  const swapped = NOTE.replace('## Goal', '## TMP').replace('## Next step', '## Goal').replace('## TMP', '## Next step');
  assert.equal(parseSessionNote(swapped), null, 'order matters');
  assert.equal(parseSessionNote('just a paragraph'), null);
});

test('"Done" without the parenthesis still counts: the evidence is what was asked, not the heading\'s spelling', () => {
  assert.ok(parseSessionNote(NOTE.replace('## Done (with evidence)', '## Done')));
});

// ---------- a note from a structured compaction ----------

test('the summary of a structured compaction is kept as a note with its sections, once', () => {
  const { db, notes } = rig();
  try {
    const row = compaction(db, 'c1');
    const kept = notes.fromCompaction(row, summaryEntry('s1', NOTE));
    assert.equal(kept?.source, 'compaction');
    assert.equal(kept?.state, 'ready');
    assert.equal(kept?.sections?.goal, 'Make the parser accept trailing commas.');
    assert.equal(db.compactionById(row.id)?.noteId, kept?.id);
    // The same summary seen again (stream, then transcript) is the same note
    const again = notes.fromCompaction(db.compactionById(row.id) ?? row, summaryEntry('s1', NOTE));
    assert.equal(again, null, 'a compaction that has its note keeps one');
    assert.equal(notes.list('c1').length, 1);
  } finally {
    db.close();
  }
});

test('a summary without every heading is kept whole with no sections, and a compaction that asked for none keeps no note', () => {
  const { db, notes } = rig();
  try {
    const plain = notes.fromCompaction(compaction(db, 'c1'), summaryEntry('s1', 'A summary in prose.'));
    assert.equal(plain?.sections, null);
    assert.equal(plain?.text, 'A summary in prose.');
    assert.equal(notes.fromCompaction(compaction(db, 'c2', false), summaryEntry('s2', NOTE)), null);
  } finally {
    db.close();
  }
});

// ---------- a note asked for with no compaction ----------

test('asking the agent for a note leaves a pending note, sends the fixed request, and the turn\'s text becomes the note', async () => {
  const { db, notes, turns } = rig();
  try {
    const pending = await notes.requestFromAgent('c1', 'owner');
    assert.equal(pending.state, 'pending');
    assert.equal(pending.source, 'agent');
    assert.deepEqual(turns, [NOTE_REQUEST_PROMPT]);
    // One housekeeping turn at a time, notes included
    await assert.rejects(notes.requestFromAgent('c1'), (err: unknown) => err instanceof ContextRefusal && err.reason === 'open');
    const result: RunResult = { purpose: 'note', isError: false, result: NOTE, structuredOutput: undefined, costUsd: 0.01 };
    notes.onResult('c1', result);
    const ready = notes.list('c1')[0];
    assert.equal(ready?.state, 'ready');
    assert.equal(ready?.text, NOTE);
    assert.equal(ready?.sections?.next, 'Write the tokenizer test first.');
    assert.ok(ready?.readyAt);
  } finally {
    db.close();
  }
});

test('a note turn that fails, or whose process ends, is a failed note that says why, and frees the slot', async () => {
  const { db, notes } = rig();
  try {
    await notes.requestFromAgent('c1');
    notes.onResult('c1', { purpose: 'note', isError: true, result: 'maximum budget exceeded', structuredOutput: undefined, costUsd: 0 });
    assert.equal(notes.list('c1')[0]?.state, 'failed');
    assert.match(notes.list('c1')[0]?.error ?? '', /budget/);

    await notes.requestFromAgent('c1');
    notes.onEnded('c1', 'exit code 137');
    assert.equal(notes.list('c1').filter((n) => n.state === 'failed').length, 2);
    await notes.requestFromAgent('c1');
    assert.ok(notes.pendingOf('c1'), 'the slot is free again');
  } finally {
    db.close();
  }
});

test('a note turn that cannot start is failed and the refusal reaches the caller; a refused one claims nothing', async () => {
  const refusing = rig({ check: async () => Promise.reject(new ContextRefusal('busy')) });
  const failing = rig({ turn: async () => Promise.reject(new Error('could not resume')) });
  try {
    await assert.rejects(refusing.notes.requestFromAgent('c1'), (err: unknown) => err instanceof ContextRefusal && err.reason === 'busy');
    assert.equal(refusing.notes.list('c1').length, 0);
    await assert.rejects(failing.notes.requestFromAgent('c1'), /could not resume/);
    assert.equal(failing.notes.list('c1')[0]?.state, 'failed');
    assert.equal(failing.notes.pendingOf('c1'), null);
  } finally {
    refusing.db.close();
    failing.db.close();
  }
});

// ---------- a summary a person saves ----------

test('saving a summary reads it from the transcript; saving it twice is a 409 and a uuid that is no summary is a 400', async () => {
  const { db, notes } = rig({ entries: [boundaryEntry('b1'), summaryEntry('s1', NOTE)] });
  try {
    const saved = await notes.fromSummary('c1', 's1');
    assert.equal(saved.source, 'summary');
    assert.equal(saved.entryUuid, 's1');
    assert.equal(saved.state, 'ready');
    assert.equal(saved.sections?.goal, 'Make the parser accept trailing commas.');
    await assert.rejects(notes.fromSummary('c1', 's1'), (err: unknown) => err instanceof ContextRefusal && err.reason === 'saved' && err.statusCode === 409);
    for (const bad of ['b1', 'nope', '']) {
      await assert.rejects(notes.fromSummary('c1', bad), (err: unknown) => err instanceof Error && !(err instanceof ContextRefusal), `a 400 for ${bad || 'an empty uuid'}`);
    }
    assert.equal(notes.list('c1').length, 1);
  } finally {
    db.close();
  }
});

test('a note is deleted from its own chat only', () => {
  const { db, notes } = rig();
  try {
    const kept = notes.fromCompaction(compaction(db, 'c1'), summaryEntry('s1', NOTE));
    assert.ok(kept);
    assert.equal(notes.remove('other', kept.id), false, 'another chat\'s id says nothing is there');
    assert.equal(notes.remove('c1', kept.id), true);
    assert.equal(notes.list('c1').length, 0);
    assert.equal(notes.remove('c1', kept.id), false);
  } finally {
    db.close();
  }
});
