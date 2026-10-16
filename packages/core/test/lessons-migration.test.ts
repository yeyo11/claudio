import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Db, LESSONS_SCHEMA_VERSION, migrate } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

const at = '2026-10-16T10:00:00.000Z';

const lesson = (sql: DatabaseSync, id: string): void => {
  sql
    .prepare(
      `INSERT INTO lessons (id, project_id, status, trigger, action, confidence, proposed_by_kind, last_seen_at, last_confirmed_at, created_at, updated_at)
       VALUES (?, 'p1', 'proposed', 'When x', 'Do y', 0.6, 'system', ?, ?, ?, ?)`,
    )
    .run(id, at, at, at, at);
};

test('the lessons migration upgrades a database from the version before it', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, LESSONS_SCHEMA_VERSION - 1);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'lessons'").get(), undefined);
  raw
    .prepare(
      `INSERT INTO memory_proposals (id, project_id, target_kind, text, reason, status, proposed_by_kind, created_at)
       VALUES ('m1', 'p1', 'memory', 'text', 'why', 'pending', 'person', ?)`,
    )
    .run(at);
  raw.close();

  const db = new Db(config);
  const sql = db.connection;
  try {
    for (const name of ['lessons', 'lesson_evidence', 'lesson_signals', 'lesson_jobs', 'lessons_project', 'lesson_evidence_lesson', 'lesson_signals_chat', 'lesson_jobs_project', 'lesson_jobs_open']) {
      assert.ok(sql.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), name);
    }
    const version = (sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.ok(version >= LESSONS_SCHEMA_VERSION);
    const proposal = sql.prepare("SELECT lesson_id, text FROM memory_proposals WHERE id = 'm1'").get() as { lesson_id: string | null; text: string };
    assert.equal(proposal.text, 'text', 'the existing proposal survived');
    assert.equal(proposal.lesson_id, null, 'lesson_id defaults to null');
  } finally {
    db.close();
  }
});

test('deleting a lesson cascades to its evidence and clears the proposal that pointed at it', () => {
  const db = new Db(tempConfig());
  const sql = db.connection;
  try {
    lesson(sql, 'l1');
    sql.prepare("INSERT INTO lesson_evidence (id, lesson_id, signal, quote, context, at) VALUES ('e1', 'l1', 'correction', 'no', 'Edit a.ts', ?)").run(at);
    sql
      .prepare(
        `INSERT INTO memory_proposals (id, project_id, target_kind, text, reason, status, proposed_by_kind, created_at, lesson_id)
         VALUES ('m1', 'p1', 'lesson', 't', 'r', 'pending', 'system', ?, 'l1')`,
      )
      .run(at);
    sql.prepare("DELETE FROM lessons WHERE id = 'l1'").run();
    assert.equal((sql.prepare('SELECT COUNT(*) AS n FROM lesson_evidence').get() as { n: number }).n, 0);
    assert.equal((sql.prepare("SELECT lesson_id FROM memory_proposals WHERE id = 'm1'").get() as { lesson_id: string | null }).lesson_id, null);
  } finally {
    db.close();
  }
});

test('the open-job index refuses a second open job for a chat and allows one once the first is done', () => {
  const db = new Db(tempConfig());
  const sql = db.connection;
  const job = (id: string, chat: string | null, status: string) =>
    sql.prepare("INSERT INTO lesson_jobs (id, project_id, chat_id, trigger, status, created_at) VALUES (?, 'p1', ?, 'run-ended', ?, ?)").run(id, chat, status, at);
  try {
    job('j1', 'c1', 'queued');
    assert.throws(() => job('j2', 'c1', 'running'), /UNIQUE/);
    job('j3', 'c2', 'queued');
    job('j4', null, 'queued');
    job('j5', null, 'queued');
    sql.prepare("UPDATE lesson_jobs SET status = 'done' WHERE id = 'j1'").run();
    job('j6', 'c1', 'queued');
  } finally {
    db.close();
  }
});
