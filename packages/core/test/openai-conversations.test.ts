import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ApiChatPolicy } from '@claudio/shared';
import { Db, migrate } from '../src/db.ts';
import { historyKey, keyAfterAnswer, policyKey, stableStringify, type KeySeed } from '../src/openai/conversation-key.ts';
import { OpenAiConversationStore } from '../src/openai/conversations.ts';
import { parseChatCompletionRequest } from '../src/openai/request.ts';
import type { ChatMessage } from '../src/openai/wire.ts';
import { tempConfig } from './helpers.ts';

// A stateless client resends the whole history; the key finds the chat that already holds it, and
// the rows keep that across restarts (docs/openai-compatible-api.md, the conversation key).

function messagesOf(messages: unknown[], extra: Record<string, unknown> = {}): { seed: KeySeed; messages: ChatMessage[] } {
  const result = parseChatCompletionRequest({ model: 'sonnet', messages, ...extra });
  if (!result.ok) assert.fail(JSON.stringify(result.error.body));
  const systemPrompt = result.value.messages.flatMap((m) => (m.role === 'system' || m.role === 'developer' ? [m.text] : [])).join('\n\n') || null;
  return { seed: { model: result.value.model, systemPrompt, user: result.value.user }, messages: result.value.messages };
}

const keyOf = (messages: unknown[], extra: Record<string, unknown> = {}): string | null => {
  const { seed, messages: parsed } = messagesOf(messages, extra);
  return historyKey(seed, parsed);
};

const history = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'What is the capital of France?' },
  { role: 'assistant', content: 'Paris.' },
  { role: 'user', content: 'And Spain?' },
];

test('the same history gives the same key, whatever the new message says', () => {
  const a = keyOf(history);
  assert.equal(typeof a, 'string');
  assert.equal(keyOf(history), a);
  assert.equal(keyOf([...history.slice(0, 3), { role: 'user', content: 'Something else entirely' }]), a, 'only the history through the last answer is hashed');
});

test('a changed earlier message, model, system prompt or user is another conversation', () => {
  const base = keyOf(history);
  assert.notEqual(keyOf([history[0], { role: 'user', content: 'What is the capital of Italy?' }, ...history.slice(2)]), base);
  assert.notEqual(keyOf([history[0], history[1], { role: 'assistant', content: 'Lyon.' }, history[3]]), base);
  assert.notEqual(keyOf(history.slice(1)), base, 'no system prompt');
  assert.notEqual(keyOf([{ role: 'system', content: 'Be long.' }, ...history.slice(1)]), base);
  assert.notEqual(keyOf(history, { model: 'opus' }), base);
  assert.notEqual(keyOf(history, { user: 'alice' }), base);
  assert.notEqual(keyOf(history, { user: 'alice' }), keyOf(history, { user: 'bob' }));
});

test("the chat's policy is in the seed: any field of it changed is another conversation (D8)", () => {
  const { seed, messages } = messagesOf(history);
  const policy: ApiChatPolicy = { workspaceId: null, allowedTools: ['Read'], maxTurns: null, maxBudgetUsd: 1, schema: false };
  const keyed = (patch: Partial<ApiChatPolicy>): string | null => historyKey({ ...seed, policy: policyKey({ ...policy, ...patch }) }, messages);
  const base = keyed({});
  assert.equal(keyed({}), base);
  assert.notEqual(base, historyKey(seed, messages), 'a key with a policy is never one without');
  for (const patch of [{ workspaceId: 'ws_a' }, { allowedTools: ['Read', 'Grep'] }, { allowedTools: [] }, { maxTurns: 3 }, { maxBudgetUsd: 0.5 }, { schema: true }]) {
    assert.notEqual(keyed(patch), base, JSON.stringify(patch));
  }
});

test('what clients change without meaning anything does not change the key', () => {
  const base = keyOf(history);
  assert.equal(keyOf([history[0], { role: 'user', content: [{ type: 'text', text: 'What is the capital of France?' }] }, ...history.slice(2)]), base, 'array content');
  assert.equal(keyOf([history[0], history[1], { role: 'assistant', content: 'Paris.\n\n' }, history[3]]), base, 'trailing whitespace');
  assert.equal(keyOf([history[0], { role: 'user', content: 'What is the capital of France?\r\n' }, ...history.slice(2)]), base, 'CRLF');
  assert.equal(keyOf([{ role: 'developer', content: 'Be brief.' }, ...history.slice(1)]), base, 'developer is system');
  assert.notEqual(keyOf([history[0], { role: 'user', content: 'What is the  capital of France?' }, ...history.slice(2)]), base, 'whitespace inside a message counts');
  assert.notEqual(keyOf([history[0], { role: 'user', content: 'what is the capital of France?' }, ...history.slice(2)]), base, 'case counts');
});

test('tool-call arguments compare as JSON, so key order does not matter', () => {
  const call = (args: string) => [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: args } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
  ];
  assert.equal(keyOf(call('{"a":1,"b":2}')), keyOf(call('{ "b": 2, "a": 1 }')));
  assert.notEqual(keyOf(call('{"a":1}')), keyOf(call('{"a":2}')));
  assert.equal(stableStringify({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
});

test('a history with no answer in it has no key', () => {
  assert.equal(keyOf([{ role: 'user', content: 'hi' }]), null);
});

test("the key remembered after an answer is the one the client's next request carries", () => {
  const first = messagesOf(history);
  const remembered = keyAfterAnswer(first.seed, first.messages, { text: 'Madrid.' });
  assert.equal(keyOf([...history, { role: 'assistant', content: 'Madrid.' }, { role: 'user', content: 'And Italy?' }]), remembered);
  const withCalls = keyAfterAnswer(first.seed, first.messages, { text: '', toolCalls: [{ id: 'c9', type: 'function', function: { name: 'f', arguments: '{}' } }] });
  assert.equal(
    keyOf([...history, { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c9', content: 'ok' }]),
    withCalls,
  );
});

// ---------- the rows ----------

function store(now: () => string): { conversations: OpenAiConversationStore; db: Db } {
  const db = new Db(tempConfig());
  return { conversations: new OpenAiConversationStore(db.connection, now), db };
}

test('a remembered key is found again, with its chat, user and times', () => {
  const { conversations, db } = store(() => '2026-10-25T10:00:00.000Z');
  try {
    assert.equal(conversations.find('h1'), null);
    conversations.remember('h1', 'chat-1', 'alice');
    assert.deepEqual(conversations.find('h1'), { hash: 'h1', chatId: 'chat-1', user: 'alice', createdAt: '2026-10-25T10:00:00.000Z', updatedAt: '2026-10-25T10:00:00.000Z' });
  } finally {
    db.close();
  }
});

test('remembering a key again updates its row in place and keeps when it was created', () => {
  let now = '2026-10-25T10:00:00.000Z';
  const { conversations, db } = store(() => now);
  try {
    conversations.remember('h1', 'chat-1', null);
    now = '2026-10-25T11:00:00.000Z';
    conversations.remember('h1', 'chat-2', 'bob');
    assert.deepEqual(conversations.find('h1'), { hash: 'h1', chatId: 'chat-2', user: 'bob', createdAt: '2026-10-25T10:00:00.000Z', updatedAt: '2026-10-25T11:00:00.000Z' });
    const count = db.connection.prepare('SELECT COUNT(*) AS n FROM openai_conversations').get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    db.close();
  }
});

test('two connections writing the same key leave one whole row', () => {
  const config = tempConfig();
  const one = new Db(config);
  const two = new Db(config);
  try {
    const a = new OpenAiConversationStore(one.connection, () => '2026-10-25T10:00:00.000Z');
    const b = new OpenAiConversationStore(two.connection, () => '2026-10-25T10:00:01.000Z');
    for (let i = 0; i < 20; i++) {
      a.remember('shared', 'chat-a', 'a');
      b.remember('shared', 'chat-b', 'b');
    }
    const row = a.find('shared');
    assert.equal(row?.chatId, 'chat-b');
    assert.equal(row?.user, 'b', "the chat and the user come from the same writer");
    assert.equal(row?.createdAt, '2026-10-25T10:00:00.000Z');
    const count = one.connection.prepare("SELECT COUNT(*) AS n FROM openai_conversations WHERE hash = 'shared'").get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    one.close();
    two.close();
  }
});

test("forgetting a chat drops every key that led to it, and only those", () => {
  const { conversations, db } = store(() => '2026-10-25T10:00:00.000Z');
  try {
    conversations.remember('h1', 'chat-1', null);
    conversations.remember('h2', 'chat-1', null);
    conversations.remember('h3', 'chat-2', null);
    assert.equal(conversations.forgetChat('chat-1'), 2);
    assert.equal(conversations.find('h1'), null);
    assert.equal(conversations.find('h2'), null);
    assert.equal(conversations.find('h3')?.chatId, 'chat-2');
  } finally {
    db.close();
  }
});

test("deleting a chat from the store drops its conversation keys with it", () => {
  const { conversations, db } = store(() => '2026-10-25T10:00:00.000Z');
  try {
    conversations.remember('h1', 'chat-1', null);
    conversations.remember('h2', 'chat-2', null);
    db.deleteChat('chat-1');
    assert.equal(conversations.find('h1'), null);
    assert.equal(conversations.find('h2')?.chatId, 'chat-2');
  } finally {
    db.close();
  }
});

test('expiring drops the keys not answered under since the cut-off', () => {
  let now = '2026-10-01T00:00:00.000Z';
  const { conversations, db } = store(() => now);
  try {
    conversations.remember('old', 'chat-1', null);
    conversations.remember('refreshed', 'chat-2', null);
    now = '2026-10-20T00:00:00.000Z';
    conversations.remember('refreshed', 'chat-2', null);
    conversations.remember('new', 'chat-3', null);
    assert.equal(conversations.expire('2026-10-10T00:00:00.000Z'), 1);
    assert.equal(conversations.find('old'), null);
    assert.ok(conversations.find('refreshed'));
    assert.ok(conversations.find('new'));
  } finally {
    db.close();
  }
});

test('the migrations create the table with its columns as rows, not a blob', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    migrate(sql);
    const columns = (sql.prepare("PRAGMA table_info('openai_conversations')").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(columns, ['hash', 'chat_id', 'client_user', 'created_at', 'updated_at']);
  } finally {
    sql.close();
  }
});
