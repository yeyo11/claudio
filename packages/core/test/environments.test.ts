import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { EffectiveEnvironment } from '@claudio/shared';
import { Db, ENVIRONMENTS_BY_CHAT_SCHEMA_VERSION, migrate } from '../src/db.ts';
import { EnvironmentIndex } from '../src/environments.ts';
import { tempConfig } from './helpers.ts';

/*
 * What Claude loaded is a chat's: two chats in one folder load different servers and models, and
 * each chat's page shows its own, never the other's (report §4.11, plan C5). A chat with no process
 * of its own here shows the folder's last, and says so.
 */

const env = (chatId: string, cwd: string, observedAt: string, over: Partial<EffectiveEnvironment> = {}): EffectiveEnvironment => ({
  cwd,
  observedAt,
  chatId,
  cliVersion: '2.1.312',
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  outputStyle: null,
  tools: ['Bash'],
  mcpServers: [],
  agents: [],
  skills: [],
  slashCommands: [],
  plugins: [],
  memoryPaths: {},
  ...over,
});

test("two chats in one folder each keep what their own process loaded; a chat with none gets the folder's last, labelled", () => {
  const db = new Db(tempConfig());
  try {
    const index = new EnvironmentIndex(db);
    index.observe(env('a', '/work/shop', '2026-10-29T10:00:00Z', { model: 'claude-opus-5-5', mcpServers: [{ name: 'docs', status: 'connected' }], slashCommands: ['/deploy'] }));
    index.observe(env('b', '/work/shop', '2026-10-29T11:00:00Z', { model: 'claude-sonnet-5-5', slashCommands: [] }));

    const a = index.forChat('a', '/work/shop');
    assert.equal(a?.source, 'chat');
    assert.equal(a?.env.model, 'claude-opus-5-5');
    assert.deepEqual(a?.env.mcpServers.map((s) => s.name), ['docs'], "b's start did not replace a's servers");
    assert.deepEqual(a?.env.slashCommands, ['/deploy']);
    assert.equal(index.forChat('b', '/work/shop')?.env.model, 'claude-sonnet-5-5');

    // A chat from a terminal never started here: the folder's last, which says where it came from
    const terminal = index.forChat('from-terminal', '/work/shop');
    assert.deepEqual([terminal?.source, terminal?.env.chatId], ['folder', 'b']);
    assert.equal(index.forChat('elsewhere', '/work/other'), null);

    // The per-folder panel keeps showing each folder's last
    assert.deepEqual(index.latest().map((e) => [e.cwd, e.chatId]), [['/work/shop', 'b']]);
    assert.equal(index.ofDir('/work/shop')?.chatId, 'b');

    // A chat's next process replaces its own row, nobody else's
    index.observe(env('a', '/work/shop', '2026-10-29T12:00:00Z', { model: 'claude-haiku-5-5' }));
    assert.equal(index.forChat('a', '/work/shop')?.env.model, 'claude-haiku-5-5');
    assert.equal(index.forChat('b', '/work/shop')?.env.model, 'claude-sonnet-5-5');

    // A new process of the wrapper reads the same from the rows
    const again = new EnvironmentIndex(db);
    assert.equal(again.forChat('b', '/work/shop')?.env.model, 'claude-sonnet-5-5');
    assert.equal(again.ofDir('/work/shop')?.chatId, 'a');

    // A deleted chat's row goes with it
    db.deleteChat('a');
    assert.equal(db.environmentOf('a'), null);
  } finally {
    db.close();
  }
});

test('the migration moves each folder row under the chat that last started there, and drops one that names no chat', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, ENVIRONMENTS_BY_CHAT_SCHEMA_VERSION - 1);
  const insert = raw.prepare('INSERT INTO environments (cwd, observed_at, json) VALUES (?, ?, ?)');
  insert.run('/work/shop', '2026-10-01T10:00:00Z', JSON.stringify(env('chat-1', '/work/shop', '2026-10-01T10:00:00Z')));
  insert.run('/work/api', '2026-10-02T10:00:00Z', JSON.stringify(env('chat-2', '/work/api', '2026-10-02T10:00:00Z')));
  insert.run('/work/old', '2026-09-01T10:00:00Z', JSON.stringify({ ...env('', '/work/old', '2026-09-01T10:00:00Z') }));
  insert.run('/work/broken', '2026-09-01T10:00:00Z', 'not json');
  raw.close();

  const db = new Db(config);
  try {
    assert.equal(db.environmentOf('chat-1')?.cwd, '/work/shop');
    assert.equal(db.environmentOf('chat-2')?.cwd, '/work/api');
    assert.deepEqual(db.loadEnvironments().map((e) => e.chatId), ['chat-2', 'chat-1']);
  } finally {
    db.close();
  }
});

test('the table keeps the newest chats and every folder newest, never one row per chat ever started', () => {
  const db = new Db(tempConfig());
  try {
    // An old folder nobody started a chat in since: its one row stays, whatever its age
    db.saveEnvironment(env('lonely', '/work/old', '2026-01-01T00:00:00.000Z'), 3);
    for (let i = 0; i < 10; i++) db.saveEnvironment(env(`busy-${i}`, '/work/busy', new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()), 3);
    const kept = ['lonely', ...Array.from({ length: 10 }, (_, i) => `busy-${i}`)].filter((id) => db.environmentOf(id));
    assert.deepEqual(kept, ['lonely', 'busy-6', 'busy-7', 'busy-8', 'busy-9'], "three besides each folder's newest");
    // A chat whose row went shows its folder's last, labelled
    assert.deepEqual(new EnvironmentIndex(db).forChat('busy-0', '/work/busy')?.source, 'folder');
  } finally {
    db.close();
  }
});
