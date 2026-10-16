import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { GUARD_EVENTS_SCHEMA_VERSION, migrate, pruneGuardEvents } from '../src/db.ts';
import { GuardEventStore, type NewGuardEvent } from '../src/guards/events.ts';

const base: NewGuardEvent = { chatId: 'c1', toolName: 'Bash', rule: 'push', matcher: 'push.git-verb', outcome: 'blocked', reason: 'no push', excerpt: 'git push' };

test('the guard events migration applies on an existing db', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, GUARD_EVENTS_SCHEMA_VERSION - 1);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'guard_events'").get(), undefined);
  migrate(raw);
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'guard_events_once'").get());
  raw.close();
});

test('a replayed insert is ignored, and an event without a call id is not', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  const store = new GuardEventStore(raw);
  assert.ok(store.insert({ ...base, toolUseId: 't1' }));
  assert.equal(store.insert({ ...base, toolUseId: 't1' }), null);
  assert.ok(store.insert({ ...base, toolUseId: 't1', outcome: 'observed' }));
  assert.ok(store.insert(base));
  assert.ok(store.insert(base));
  assert.equal(store.list().events.length, 4);
  raw.close();
});

test('excerpts and reasons are masked, then cut to 240 characters', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  const store = new GuardEventStore(raw);
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const stored = store.insert({ ...base, excerpt: `curl -H "x-api-key: ${secret}" ${'a'.repeat(400)}`, reason: `saw ${secret}` });
  assert.ok(stored);
  assert.ok(!stored.excerpt.includes('sk-ant'));
  assert.ok(!stored.reason.includes('sk-ant'));
  assert.ok([...stored.excerpt].length <= 240);
  const row = raw.prepare('SELECT excerpt, reason FROM guard_events').get() as { excerpt: string; reason: string };
  assert.ok(!row.excerpt.includes('sk-ant') && !row.reason.includes('sk-ant'));
  raw.close();
});

test('list filters and pages newest first; counts group blocks by task and flow run', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  const store = new GuardEventStore(raw);
  for (let i = 0; i < 5; i += 1) store.insert({ ...base, orchestrationId: 'o1', taskId: i < 3 ? 'a' : 'b', flowRunId: i === 0 ? 'f1' : null, toolUseId: `t${i}` });
  store.insert({ ...base, orchestrationId: 'o1', taskId: 'a', outcome: 'observed', toolUseId: 'x' });
  store.insert({ ...base, chatId: 'c2', rule: 'secrets' });
  const first = store.list({ chatId: 'c1', limit: 4 });
  assert.equal(first.events.length, 4);
  assert.ok(first.next !== null);
  const second = store.list({ chatId: 'c1', limit: 4, before: first.next });
  assert.equal(second.events.length, 2);
  assert.equal(second.next, null);
  assert.equal(store.list({ rule: 'secrets' }).events.length, 1);
  assert.equal(store.list({ outcome: 'observed' }).events.length, 1);
  assert.deepEqual([...store.countByTask('o1')].sort(), [['a', 3], ['b', 2]]);
  assert.deepEqual([...store.countByFlowRun(['f1', 'f2'])], [['f1', 1]]);
  assert.equal(store.countByFlowRun([]).size, 0);
  raw.close();
});

test('pruning keeps the newest 20,000 rows', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  raw.exec('BEGIN');
  const insert = raw.prepare("INSERT INTO guard_events (at, chat_id, tool_name, rule, matcher, outcome, reason, excerpt) VALUES ('2026-01-01T00:00:00Z', 'c', 'Bash', 'push', 'm', 'blocked', 'r', 'e')");
  for (let i = 0; i < 20_050; i += 1) insert.run();
  raw.exec('COMMIT');
  assert.equal(pruneGuardEvents(raw), 50);
  const left = raw.prepare('SELECT COUNT(*) AS n, MIN(seq) AS lo FROM guard_events').get() as { n: number; lo: number };
  assert.equal(left.n, 20_000);
  assert.equal(left.lo, 51);
  raw.close();
});
