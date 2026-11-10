import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { SentToAgent, TranscriptEntry } from '@claudio/shared';
import { relayWords, subagentComposerState } from '../src/composer/SubagentComposer';
import { transcriptRows } from '../src/lib/chat-steps';
import { withRelays } from '../src/lib/relay-rows';

// The footer of a subagent's drawer and the lead's record of what was written to it
// (docs/plans/agent-messages.md, D5 and "The subagent composer").

test('the box reads the subagent and the chat: running, finished, stopped by the person, chat gone', () => {
  assert.equal(subagentComposerState(true, 'running'), 'running');
  assert.equal(subagentComposerState(true, 'waiting'), 'running');
  assert.equal(subagentComposerState(true, 'completed'), 'finished');
  assert.equal(subagentComposerState(true, 'failed'), 'finished');
  assert.equal(subagentComposerState(true, 'stopped'), 'stopped');
  // Nothing holds the chat, so no bridge can carry anything, whatever the agent was doing
  for (const status of ['running', 'completed', 'stopped'] as const) assert.equal(subagentComposerState(false, status), 'gone');
});

test('the hint to the lead names the subagent and carries the words, and a backtick cannot end the name', () => {
  assert.equal(relayWords('check the logs', 'try the other port'), 'Relay this to your background agent `check the logs` with SendMessage: try the other port');
  assert.match(relayWords('a `b` c', 'x'), /`a 'b' c`/);
});

test('every state of the box has its note, in both languages', () => {
  const read = (lang: string) => (JSON.parse(readFileSync(new URL(`../src/locales/${lang}/chat.json`, import.meta.url), 'utf8')) as { agentComposer: Record<string, string> }).agentComposer;
  const en = read('en');
  const es = read('es');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  for (const key of ['placeholder', 'note', 'resumes', 'stopped', 'chatGone', 'viaLead', 'discard', 'bridgeDown', 'waiting']) assert.ok(en[key] && es[key], key);
  assert.equal(es.viaLead, 'Enviar a través del principal');
});

const entry = (uuid: string, timestamp: string, role: TranscriptEntry['role'] = 'user'): TranscriptEntry => ({
  uuid,
  role,
  timestamp,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text: uuid }],
});
const sent = (id: string, at: string, agentId = 'ag1'): SentToAgent => ({ id, agentId, text: `words ${id}`, at });

test('a message to a subagent is a row in the lead at the time it was taken', () => {
  const rows = transcriptRows([entry('u1', '2026-11-10T10:00:00.000Z'), entry('a1', '2026-11-10T10:01:00.000Z', 'assistant'), entry('u2', '2026-11-10T10:05:00.000Z')]);
  const listed = withRelays(rows, [sent('m1', '2026-11-10T10:03:00.000Z')]);
  assert.deepEqual(
    listed.map((row) => row.kind),
    ['entry', 'entry', 'relay', 'entry'],
  );
  const relay = listed[2];
  assert.ok(relay && relay.kind === 'relay');
  assert.equal(relay.agentId, 'ag1');
  assert.equal(relay.text, 'words m1');
});

test('relays after the last row go last, in order, and one older than the page held is left out', () => {
  const rows = transcriptRows([entry('u1', '2026-11-10T10:00:00.000Z')]);
  const listed = withRelays(rows, [sent('late2', '2026-11-10T11:00:00.000Z'), sent('late1', '2026-11-10T10:30:00.000Z'), sent('old', '2026-11-10T09:00:00.000Z')]);
  assert.deepEqual(
    listed.map((row) => (row.kind === 'relay' ? row.key : row.kind)),
    ['entry', 'relay-late1', 'relay-late2'],
  );
});

test('nothing to place gives the very same rows', () => {
  const rows = transcriptRows([entry('u1', '2026-11-10T10:00:00.000Z')]);
  assert.equal(withRelays(rows, undefined), rows);
  assert.equal(withRelays(rows, []), rows);
});
