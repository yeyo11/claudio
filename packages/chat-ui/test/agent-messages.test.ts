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
  LIMIT_CONTINUE_TEXT,
  normalizeMessage,
  ORCHESTRATION_HINT_PREFIX,
  SUPERVISOR_HINT_PREFIX,
  type TranscriptEntry,
} from '@claudio/shared';
import { listedAgents, readAgentEntry, sentMessageOf, systemFolds, systemLabelKey, systemWords } from '../src/lib/agent-messages';

// Which rendering each line takes (docs/plans/agent-messages.md, D5), read from the lines the CLI
// 2.1.319 recorded (packages/core/test/fixtures/agent-messages, ids and paths redacted).

function recorded(name: string, index = 0): Record<string, unknown> {
  const text = readFileSync(new URL(`../../core/test/fixtures/agent-messages/${name}.jsonl`, import.meta.url), 'utf8');
  const line = text.split('\n').filter(Boolean)[index];
  assert.ok(line, name);
  return JSON.parse(line) as Record<string, unknown>;
}

function entryOf(name: string, index = 0): TranscriptEntry {
  const entry = normalizeMessage(recorded(name, index));
  assert.ok(entry, name);
  return entry;
}

const typed = (text: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: 'u1',
  role: 'user',
  timestamp: '2026-11-10T10:00:00.000Z',
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text }],
  ...over,
});

test("a subagent's SendMessage to the lead reads as a peer message, without the harness frame", () => {
  assert.deepEqual(readAgentEntry(entryOf('lead-peer-from-subagent')), {
    kind: 'peer',
    from: 'a0000000000000001',
    fallbackName: 'general-purpose',
    body: 'ping from subagent',
    handback: false,
  });
});

test("a busy lead's queued peer message reads as the peer's, body without the tag", () => {
  assert.deepEqual(readAgentEntry(entryOf('lead-peer-queued-busy')), {
    kind: 'peer',
    from: 'a0000000000000002',
    fallbackName: 'general-purpose',
    body: 'ping while the lead was busy',
    handback: false,
  });
});

test('a hand-back is a peer message whose body is the report, not the frame', () => {
  const read = readAgentEntry(entryOf('lead-handback'));
  assert.equal(read?.kind, 'peer');
  if (read?.kind !== 'peer') return;
  assert.equal(read.handback, true);
  assert.equal(read.body, '7 launches seeded; running it twice gives identical row counts.');
});

test('a hand-back without the report apart is read out of the frame, its indentation removed', () => {
  const line = recorded('lead-handback');
  const origin = { ...(line.origin as Record<string, unknown>) };
  delete origin.handbackReportText;
  const entry = normalizeMessage({ ...line, origin });
  assert.ok(entry);
  const read = readAgentEntry(entry);
  assert.equal(read?.kind === 'peer' ? read.body : null, '7 launches seeded; running it twice gives identical row counts.');
});

test("the lead's SendMessage lands in the subagent's transcript as a message from the lead", () => {
  assert.deepEqual(readAgentEntry(entryOf('subagent-coordinator-lead')), { kind: 'from-lead', body: 'hello from lead' });
});

test("a bridge message is Claudio's: a system row, never a bubble, even without a known prefix", () => {
  const read = readAgentEntry(entryOf('subagent-coordinator-bridge'));
  assert.equal(read?.kind, 'system');
  assert.equal(systemLabelKey(read?.kind === 'system' ? read.message : null), 'system.auto');
});

test("the person's message to a subagent is their bubble; Claudio's automatic one is a system row", () => {
  const coordinator = (text: string): TranscriptEntry => typed(text, { isSidechain: true, origin: { kind: 'coordinator', plugin: 'claudio-bridge' } });
  assert.deepEqual(readAgentEntry(coordinator(`${AGENT_MESSAGE_PERSON_PREFIX}\n\nCheck the lockfile first.`)), { kind: 'person-to-agent', words: 'Check the lockfile first.' });
  const auto = readAgentEntry(coordinator(`${SUPERVISOR_HINT_PREFIX}\n\nYou have read the same file five times.`));
  assert.equal(auto?.kind, 'system');
  if (auto?.kind !== 'system') return;
  assert.equal(systemLabelKey(auto.message), 'system.supervisor');
  assert.equal(readAgentEntry(coordinator(`${AGENT_MESSAGE_AUTO_PREFIX}\n\nThe chat is about to end.`))?.kind, 'system');
});

test('a coordinator message to a busy subagent is read without the frame the CLI puts around it', () => {
  // The busy form `bridge` recorded on 2026-11-10: a meta user line, the frame inside its text
  const framed = (said: string) => `The coordinator sent a message while you were working:\n${said}\n\nAddress this before completing your current task.`;
  const coordinator = (text: string, plugin?: string): TranscriptEntry => typed(text, { isSidechain: true, origin: plugin ? { kind: 'coordinator', plugin } : { kind: 'coordinator' } });
  assert.deepEqual(readAgentEntry(coordinator(framed(`${AGENT_MESSAGE_PERSON_PREFIX}\n\nCheck the lockfile first.`), 'claudio-bridge')), { kind: 'person-to-agent', words: 'Check the lockfile first.' });
  const auto = readAgentEntry(coordinator(framed(`${SUPERVISOR_HINT_PREFIX}\n\nYou are looping.`), 'claudio-bridge'));
  assert.ok(auto?.kind === 'system');
  assert.equal(systemLabelKey(auto.message), 'system.supervisor');
  assert.equal(systemWords(auto.message, auto.text), 'You are looping.');
  assert.deepEqual(readAgentEntry(coordinator(framed('hello from lead'))), { kind: 'from-lead', body: 'hello from lead' });
});

test("another mod's message names its plugin", () => {
  assert.deepEqual(readAgentEntry(typed('ping', { origin: { kind: 'coordinator', plugin: 'other-mod' } })), { kind: 'from-plugin', plugin: 'other-mod', body: 'ping' });
});

test("a person's hint is their bubble with the prefix removed", () => {
  assert.deepEqual(readAgentEntry(typed(`${CHAT_HINT_PREFIX}\n\nUse the fake CLI.`)), { kind: 'hint', words: 'Use the fake CLI.' });
  assert.deepEqual(readAgentEntry(typed(`${ORCHESTRATION_HINT_PREFIX}\n\nSkip the e2e.`)), { kind: 'hint', words: 'Skip the e2e.' });
});

test('each of Claudio\'s texts in the lead is a system row with its own label', () => {
  const cases: Array<[string, string]> = [
    [`${AUTO_HINT_PREFIX}\n\nThe tests have been failing for ten minutes.`, 'system.auto'],
    [`${SUPERVISOR_HINT_PREFIX}\n\nThe subagent is looping.`, 'system.supervisor'],
    [`${CANCEL_NOTICE_PREFIX} \`pnpm test\`.`, 'system.cancel'],
    [`${AUTO_CANCEL_NOTICE_PREFIX}: \`sleep 600\`.`, 'system.autoCancel'],
    [LIMIT_CONTINUE_TEXT, 'system.auto'],
  ];
  for (const [text, label] of cases) {
    const read = readAgentEntry(typed(text));
    assert.equal(read?.kind, 'system', text);
    if (read?.kind === 'system') assert.equal(systemLabelKey(read.message), label, text);
  }
});

test("a system row's line drops the prefix, and falls back to the sentence when the prefix is all of it", () => {
  const hint = readAgentEntry(typed(`${AUTO_HINT_PREFIX}\n\nThe tests fail.\nSee the log.`));
  assert.ok(hint?.kind === 'system');
  assert.equal(systemWords(hint.message, hint.text), 'The tests fail.');
  assert.equal(systemFolds(hint.message, hint.text), true);
  const limit = readAgentEntry(typed(LIMIT_CONTINUE_TEXT));
  assert.ok(limit?.kind === 'system');
  assert.equal(systemWords(limit.message, limit.text), LIMIT_CONTINUE_TEXT);
  assert.equal(systemFolds(limit.message, limit.text), false, 'one line, nothing behind it');
});

test('what the person typed, a task notification and a tool result are none of these', () => {
  assert.equal(readAgentEntry(typed('Run the tests')), null);
  assert.equal(readAgentEntry(entryOf('lead-task-notification')), null);
  assert.equal(readAgentEntry(entryOf('lead-sendmessage-to-subagent', 1)), null);
});

test('a SendMessage call names who it went to and what it sent; its JSON result says it went out', () => {
  const call = entryOf('lead-sendmessage-to-subagent', 0).blocks[0];
  const result = entryOf('lead-sendmessage-to-subagent', 1).blocks[0];
  assert.ok(call?.type === 'tool_use' && result?.type === 'tool_result');
  assert.deepEqual(sentMessageOf(call.input, result), { to: 'a0000000000000001', body: 'hello from lead', summary: 'Lead greets the background subagent', sent: true, reason: '' });
  assert.equal(sentMessageOf(call.input, null).sent, null);
});

test('a SendMessage that did not go out keeps the CLI reason', () => {
  const input = { to: 'lead', message: 'ping' };
  assert.deepEqual(sentMessageOf(input, { content: "Not sent: no agent named 'lead' is reachable.", isError: false }), {
    to: 'lead',
    body: 'ping',
    summary: '',
    sent: false,
    reason: "Not sent: no agent named 'lead' is reachable.",
  });
  assert.equal(sentMessageOf(input, { content: '{"success":false,"message":"The agent was stopped."}', isError: false }).reason, 'The agent was stopped.');
  assert.equal(sentMessageOf(input, { content: 'boom', isError: true }).sent, false);
});

test('a ListAgents listing is counted by its rows, not its headings', () => {
  const listing = 'This session is claudio [b80689].\n\nPeer sessions (2):\n  claudio:overflow [b1c793]  ·  interactive  ·  busy\n  claudio:bridge [da2116]  ·  interactive  ·  busy\n';
  assert.equal(listedAgents(listing), 2);
  assert.equal(listedAgents('[{"id":"a"},{"id":"b"},{"id":"c"}]'), 3);
});
