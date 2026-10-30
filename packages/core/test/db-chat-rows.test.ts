import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Execution } from '@claudio/shared';
import type { StoredChat } from '../src/chat-records.ts';
import { CHAT_ORPHAN_SWEEP_SCHEMA_VERSION, Db, migrate, prepared, USAGE_ACCOUNT_TEXT_SCHEMA_VERSION } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

// The chat store's own rows (regression audit 2026-10-29, 9.8 and 9.9): a chat that goes takes all
// of its rows with it, whichever way it goes, and the ids of accounts stay strings.

const execution = (id: string, startedAt: string): Execution => ({
  id,
  startedAt,
  endedAt: startedAt,
  outcome: 'completed',
  error: null,
  permissionMode: 'plan',
  model: null,
  maxBudgetUsd: null,
  costUsd: 0.5,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
});

const chat = (id: string, createdAt: string): StoredChat => ({
  record: {
    id,
    name: id,
    cwd: '/tmp',
    workingDir: null,
    origin: 'claudio',
    orchestrationId: null,
    orchestrationTaskId: null,
    derivedFrom: null,
    prompt: 'hi',
    lastText: 'ok',
    model: null,
    permissionMode: 'plan',
    permissionPrompts: 'none',
    createdAt,
    updatedAt: createdAt,
  },
  executions: [execution(`${id}-1`, createdAt)],
});

/** One row of the chat in every table that keeps rows by chat id */
function rowsFor(sql: DatabaseSync, id: string): void {
  const at = '2026-10-29T10:00:00.000Z';
  sql.prepare('INSERT INTO chat_entries (chat_id, seq, at, entry) VALUES (?, 0, ?, ?)').run(id, at, '{}');
  sql.prepare("INSERT INTO chat_compactions (id, chat_id, origin, state, requested_at, lease_until) VALUES (?, ?, 'auto', 'done', ?, ?)").run(`c-${id}`, id, at, at);
  sql.prepare("INSERT INTO chat_notes (id, chat_id, source, state, created_at) VALUES (?, ?, 'manual', 'ready', ?)").run(`n-${id}`, id, at);
  sql.prepare('INSERT INTO chat_uploads (chat_id, upload_id, attached_at) VALUES (?, ?, ?)').run(id, `u-${id}`, at);
  sql.prepare('INSERT INTO chat_upload_scans (chat_id, scanned_at) VALUES (?, ?)').run(id, at);
  sql.prepare('INSERT INTO openai_conversations (hash, chat_id, client_user, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)').run(`h-${id}`, id, at, at);
  sql.prepare("INSERT INTO openai_responses (id, chat_id, conversation_key, response, input_items, created_at) VALUES (?, ?, 'k', '{}', '[]', ?)").run(`r-${id}`, id, at);
  sql.prepare("INSERT INTO openai_chat_prompts (chat_id, instructions, conversation, updated_at) VALUES (?, '', '', ?)").run(id, at);
}

const TABLES = ['chat_entries', 'chat_compactions', 'chat_notes', 'chat_uploads', 'chat_upload_scans', 'openai_conversations', 'openai_responses', 'openai_chat_prompts'];

/** The tables that still hold a row of the chat */
const holding = (sql: DatabaseSync, id: string): string[] => TABLES.filter((t) => sql.prepare(`SELECT 1 FROM ${t} WHERE chat_id = ?`).get(id));

test('the chat trim takes every row of a trimmed chat with it, as a delete does', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('old', '2026-10-29T09:00:00Z'), chat('kept', '2026-10-29T10:00:00Z')], 200);
  rowsFor(db.connection, 'old');
  rowsFor(db.connection, 'kept');

  const trimmed = db.saveChats([chat('new', '2026-10-29T11:00:00Z')], 2);

  assert.deepEqual(trimmed, ['old']);
  assert.deepEqual(holding(db.connection, 'old'), [], 'no orphan row of the trimmed chat is left');
  assert.deepEqual(holding(db.connection, 'kept'), TABLES, 'the chats that stay keep theirs');
  assert.equal((db.connection.prepare("SELECT COUNT(*) AS n FROM executions WHERE chat_id = 'old'").get() as { n: number }).n, 0);
  db.close();
});

test('the trim never takes a chat its process still runs, however old it is', () => {
  const db = new Db(tempConfig());
  // A conversation started weeks ago and resumed today is the oldest by creation
  db.saveChats([chat('resumed', '2026-09-01T09:00:00Z'), chat('b', '2026-10-29T10:00:00Z')], 200);
  rowsFor(db.connection, 'resumed');

  const trimmed = db.saveChats([chat('c', '2026-10-29T11:00:00Z')], 2, new Set(['resumed']));

  assert.deepEqual(trimmed, []);
  assert.deepEqual([...db.storedChats(['resumed', 'b', 'c'])].sort(), ['b', 'c', 'resumed']);
  assert.deepEqual(holding(db.connection, 'resumed'), TABLES);
  db.close();
});

test('the rows an earlier trim left without their chat are swept once, and a scan of a session from elsewhere stays', () => {
  const config = tempConfig();
  const sql = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(sql, CHAT_ORPHAN_SWEEP_SCHEMA_VERSION - 1);
  sql.prepare("INSERT INTO chats (id, created_at, provider, json) VALUES ('kept', '2026-10-29T10:00:00Z', 'claude-code', '{}')").run();
  rowsFor(sql, 'kept');
  rowsFor(sql, 'trimmed');
  // What a scan found in a terminal's session: it never had a row in `chats`
  sql.prepare("INSERT INTO chat_uploads (chat_id, upload_id, attached_at) VALUES ('terminal', 'u-t', '2026-10-29T10:00:00Z')").run();

  migrate(sql);

  assert.deepEqual(holding(sql, 'kept'), TABLES);
  assert.deepEqual(holding(sql, 'trimmed'), ['chat_uploads', 'chat_upload_scans'], 'only the tables a scan of any session writes keep their rows');
  assert.ok(sql.prepare("SELECT 1 FROM chat_uploads WHERE chat_id = 'terminal'").get());
  sql.close();
});

test('an account id that looks like a number stays the string it is in the usage history', () => {
  const config = tempConfig();
  const sql = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(sql, USAGE_ACCOUNT_TEXT_SCHEMA_VERSION - 1);
  // The INTEGER affinity claude-swap left made '0042' the number 42
  sql.prepare("INSERT INTO usage_history (account, window, at, pct) VALUES ('0042', 'five_hour', '2026-10-29T10:00:00Z', 0.5)").run();
  assert.equal((sql.prepare('SELECT typeof(account) AS t FROM usage_history').get() as { t: string }).t, 'integer');
  migrate(sql);
  assert.equal((sql.prepare('SELECT typeof(account) AS t FROM usage_history').get() as { t: string }).t, 'text');
  sql.close();

  const db = new Db(config);
  db.appendUsagePoints([{ account: '0042', window: 'five_hour', at: '2026-10-29T11:00:00Z', pct: 0.6 }]);
  assert.equal(db.latestUsagePoint('0042', 'five_hour')?.pct, 0.6, 'read back under the id it was written with');
  db.close();
});

test('a hot statement is prepared once per connection and reused', () => {
  const a = new Db(tempConfig());
  const b = new Db(tempConfig());
  const first = prepared(a.connection, 'SELECT 1 FROM chats WHERE id = ?');
  assert.equal(prepared(a.connection, 'SELECT 1 FROM chats WHERE id = ?'), first);
  assert.notEqual(prepared(b.connection, 'SELECT 1 FROM chats WHERE id = ?'), first, 'a statement belongs to its connection');
  a.close();
  b.close();
});

test('one chat is read back from its row with its executions, and a chat with no row is null', () => {
  const db = new Db(tempConfig());
  db.saveChats([chat('a', '2026-10-29T10:00:00Z')], null);
  const loaded = db.loadChat('a');
  assert.equal(loaded?.record.id, 'a');
  assert.equal(loaded?.record.provider, 'claude-code');
  assert.deepEqual(loaded?.executions.map((e) => e.id), ['a-1']);
  assert.equal(db.loadChat('missing'), null);
  db.close();
});
