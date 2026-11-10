import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AGENT_MESSAGE_AUTO_PREFIX,
  AGENT_MESSAGE_PERSON_PREFIX,
  AUTO_CANCEL_NOTICE_PREFIX,
  AUTO_HINT_PREFIX,
  CANCEL_NOTICE_PREFIX,
  CHAT_HINT_PREFIX,
  CONTINUATION_PREFIX,
  entryText,
  FLOW_RESTART_PREFIX,
  LIMIT_CONTINUE_TEXT,
  NOTE_PREFIX,
  normalizeMessage,
  ORCHESTRATION_HINT_PREFIX,
  readSystemMessage,
  RESUME_PROMPT,
  SUPERVISOR_HINT_PREFIX,
} from '../src/index.ts';

/** Lines recorded with the installed CLI 2.1.319 (haiku), ids and paths redacted */
function line(name: string, index = 0): Record<string, unknown> {
  const text = readFileSync(new URL(`../../core/test/fixtures/agent-messages/${name}.jsonl`, import.meta.url), 'utf8');
  const l = text.split('\n').filter(Boolean)[index];
  assert.ok(l, name);
  return JSON.parse(l) as Record<string, unknown>;
}

test("the lead's SendMessage to a subagent is a coordinator entry without a plugin, in the sidechain", () => {
  const entry = normalizeMessage(line('subagent-coordinator-lead'));
  assert.ok(entry);
  assert.equal(entry.role, 'user');
  assert.equal(entry.isSidechain, true);
  assert.equal(entryText(entry), 'hello from lead');
  assert.deepEqual(entry.origin, { kind: 'coordinator' });
  assert.equal(entry.uuid, '0ac7f74c-569e-4076-9cc4-4f0975476204', 'the id is the source_uuid');
});

test("a bridge mod's message names the plugin", () => {
  const entry = normalizeMessage(line('subagent-coordinator-bridge'));
  assert.ok(entry);
  assert.deepEqual(entry.origin, { kind: 'coordinator', plugin: 'claudio-bridge' });
  assert.match(entryText(entry), /^Message from Claudio:/);
});

test("a bridge message to a subagent busy in a tool round is a meta user line, kept with its coordinator origin", () => {
  const entry = normalizeMessage(line('subagent-coordinator-bridge-busy'));
  assert.ok(entry);
  assert.equal(entry.role, 'user');
  assert.equal(entry.isSidechain, true);
  assert.deepEqual(entry.origin, { kind: 'coordinator', plugin: 'claudio-bridge' });
  assert.match(entryText(entry), /^The coordinator sent a message while you were working:\nA message from the person following this chat, written to you directly/);
  assert.match(entryText(entry), /The codeword is PAPAYA-7\./);
});

test("a subagent's SendMessage to the lead keeps its peer origin although the CLI marks the line meta", () => {
  const entry = normalizeMessage(line('lead-peer-from-subagent'));
  assert.ok(entry);
  assert.equal(entry.role, 'user');
  assert.deepEqual(entry.origin, { kind: 'peer', from: 'a0000000000000001', name: 'general-purpose', body: 'ping from subagent' });
  assert.match(entryText(entry), /^Another Claude session sent a message:\n<agent-message from="a0000000000000001">\nping from subagent/);
});

test('a subagent message that reached a busy lead (a queued prompt) keeps its peer origin', () => {
  // Recorded with CLI 2.1.319: the lead was inside a 30 s Bash call when the subagent's SendMessage
  // arrived, so the CLI wrote it as a queued_command attachment, without its frame
  const entry = normalizeMessage(line('lead-peer-queued-busy'));
  assert.ok(entry);
  assert.equal(entry.role, 'user');
  assert.equal(entry.uuid, '022d632f-aab9-4fe5-b015-13e27071ea8e');
  assert.deepEqual(entry.origin, { kind: 'peer', from: 'a0000000000000002', name: 'general-purpose', body: 'ping while the lead was busy' });
  assert.match(entryText(entry), /^<agent-message from="a0000000000000002">/);
});

test('a final report handed back is a peer entry with handback and the report text', () => {
  const entry = normalizeMessage(line('lead-handback'));
  assert.ok(entry);
  assert.equal(entry.origin?.kind, 'peer');
  if (entry.origin?.kind !== 'peer') return;
  assert.equal(entry.origin.handback, true);
  assert.equal(entry.origin.handbackReportText, '7 launches seeded; running it twice gives identical row counts.');
  assert.match(entryText(entry), /\[Subagent hand-back\]/);
});

test('a task notification keeps its origin and nothing else of it', () => {
  const entry = normalizeMessage(line('lead-task-notification'));
  assert.ok(entry);
  assert.deepEqual(entry.origin, { kind: 'task-notification' });
});

test('a meta line without a peer origin stays out, and what the person typed has no origin', () => {
  assert.equal(normalizeMessage({ type: 'user', isMeta: true, message: { role: 'user', content: 'x' } }), null);
  const typed = normalizeMessage({ type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' }, origin: { kind: 'human' } });
  assert.ok(typed);
  assert.equal(typed.origin, undefined);
  const odd = normalizeMessage({ type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' }, origin: { kind: 'from-the-future' } });
  assert.equal(odd?.origin, undefined);
});

test('a queued prompt of the person is still read, and a meta one that is not the coordinator is not', () => {
  const person = normalizeMessage({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'more', commandMode: 'prompt', source_uuid: 's1' } });
  assert.ok(person);
  assert.equal(person.origin, undefined);
  assert.equal(normalizeMessage({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'x', isMeta: true } }), null);
});

test('every prefix Claudio writes is read, with the words that follow', () => {
  const cases: [string, string, string, string][] = [
    [`${CHAT_HINT_PREFIX}\n\nlook at x`, 'hint', 'person', 'look at x'],
    [`${ORCHESTRATION_HINT_PREFIX}\n\nuse y`, 'orchestration-hint', 'person', 'use y'],
    [`${AUTO_HINT_PREFIX}\n\nstuck`, 'auto-hint', 'claudio', 'stuck'],
    [`${SUPERVISOR_HINT_PREFIX}\n\nstuck on z`, 'auto-hint', 'supervisor', 'stuck on z'],
    [`${CANCEL_NOTICE_PREFIX} \`sleep 9\` while it was running.`, 'cancel', 'person', '`sleep 9` while it was running.'],
    [`${AUTO_CANCEL_NOTICE_PREFIX} \`sleep 9\`.`, 'auto-cancel', 'claudio', '`sleep 9`.'],
    [`${NOTE_PREFIX}\n\nWrap up now.`, 'note', 'claudio', 'Wrap up now.'],
    [`${CONTINUATION_PREFIX} (continuation 1 of 3): finish`, 'continuation', 'claudio', '(continuation 1 of 3): finish'],
    [`${FLOW_RESTART_PREFIX} Carry on.`, 'flow-restart', 'claudio', 'Carry on.'],
    [LIMIT_CONTINUE_TEXT, 'limit-continue', 'claudio', ''],
    [RESUME_PROMPT, 'assistant-resume', 'claudio', ''],
    [`${AGENT_MESSAGE_PERSON_PREFIX}\n\ncheck the log`, 'agent-message-person', 'person', 'check the log'],
    [`${AGENT_MESSAGE_AUTO_PREFIX}\n\nstop`, 'agent-message-auto', 'claudio', 'stop'],
  ];
  for (const [text, kind, source, words] of cases) assert.deepEqual(readSystemMessage(text), { kind, source, words }, kind);
});

test("a person's own words and an agent's are not system messages", () => {
  assert.equal(readSystemMessage('please fix the build'), null);
  assert.equal(readSystemMessage('A hint from someone else: x'), null);
  assert.equal(readSystemMessage(''), null);
});
