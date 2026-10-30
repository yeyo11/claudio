import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Execution, RunEvent } from '@claudio/shared';
import type { StoredChat } from '../src/chat-records.ts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { SessionStore } from '../src/sessions.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// A long-lived server holds the chats that work, not every chat it ever touched (regression audit
// 2026-10-29, 9.7 and 9.9): an ended chat is retired to its summary and woken from its row, a save
// writes what changed, a restart reads rows and no transcript, a spawn that throws ends what it
// began, and stopping every chat waits for their processes.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A zombie waiting to be reaped is not running anything
    return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));
  } catch {
    return false;
  }
};

function rig(claudeBin = FAKE_CLAUDE) {
  const config = { ...tempConfig(), claudeBin };
  mkdirSync(config.workspaceDir, { recursive: true });
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  return { config, db, runs };
}

/** A chat that ran one turn to its end, its process gone */
async function ended(runs: ChatManager, cwd: string, prompt = 'hello'): Promise<string> {
  const chat = runs.start({ prompt, cwd, name: prompt, keepAlive: false });
  await runs.waitForResult(chat.id);
  await until(() => runs.get(chat.id)?.status === 'completed' && runs.get(chat.id)?.pid === null, 'the chat to end');
  return chat.id;
}

test('an ended chat is retired to its summary, listed as before, and woken from its row when it goes on', async () => {
  const { config, db, runs } = rig();
  try {
    const id = await ended(runs, config.workspaceDir);
    const before = runs.get(id);
    assert.ok(runs.events(id).length > 0, 'a resident chat holds its event buffer');

    // Not yet: it ended a moment ago
    assert.deepEqual(runs.retireEnded(), []);
    assert.deepEqual(runs.retireEnded(Date.now() + runs.retireAfterMs + 1000), [id]);

    // The list and a read answer as before, without waking it
    assert.ok(runs.list().some((c) => c.id === id));
    assert.equal(runs.get(id)?.status, before?.status);
    assert.equal(runs.get(id)?.name, before?.name);

    // Woken from its row: what a restart would restore, with no buffer of its earlier events
    runs.resume(id, { prompt: 'again' });
    const result = await runs.waitForResult(id);
    assert.equal(result.isError, false);
    await until(() => runs.get(id)?.status === 'completed', 'the resumed turn to end');
    assert.equal(runs.get(id)?.executions.length, 2, 'the chat goes on in the same history');
  } finally {
    await runs.stopAll();
    db.close();
  }
});

test('a chat someone reads, or waits on, stays in memory', async () => {
  const { config, db, runs } = rig();
  try {
    const id = await ended(runs, config.workspaceDir);
    const later = Date.now() + runs.retireAfterMs + 1000;
    const unsubscribe = runs.subscribe(id, () => undefined);
    assert.deepEqual(runs.retireEnded(later), [], 'a person has its page open');
    unsubscribe();
    const waiting = new AbortController();
    const next = runs.nextResult(id, waiting.signal).catch(() => null);
    assert.deepEqual(runs.retireEnded(later), [], 'a caller waits for its next result');
    waiting.abort(new Error('gave up'));
    await next;
    assert.deepEqual(runs.retireEnded(later), [id]);
  } finally {
    await runs.stopAll();
    db.close();
  }
});

test('a save writes the chat that changed, not every chat the process holds', async () => {
  const { config, db, runs } = rig();
  try {
    const first = await ended(runs, config.workspaceDir, 'first');
    const saved: string[][] = [];
    const save = db.saveChats.bind(db);
    db.saveChats = (chats, keep, protect) => {
      saved.push(chats.map((c) => c.record.id));
      return save(chats, keep, protect);
    };
    const second = await ended(runs, config.workspaceDir, 'second');
    assert.ok(saved.length > 0);
    assert.ok(saved.every((ids) => !ids.includes(first)), 'the chat that did nothing was not written again');
    assert.ok(saved.some((ids) => ids.includes(second)));
  } finally {
    await runs.stopAll();
    db.close();
  }
});

const execution = (startedAt: string, endedAt: string | null): Execution => ({
  id: randomUUID(),
  startedAt,
  endedAt,
  outcome: endedAt ? 'completed' : null,
  error: null,
  permissionMode: 'plan',
  model: null,
  maxBudgetUsd: null,
  costUsd: endedAt ? 0.1 : null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
});

const stored = (id: string, cwd: string, at: string, endedAt: string | null): StoredChat => ({
  record: {
    id,
    name: id,
    cwd,
    workingDir: cwd,
    origin: 'claudio',
    orchestrationId: null,
    orchestrationTaskId: null,
    derivedFrom: null,
    prompt: 'hi',
    lastText: 'done',
    model: null,
    permissionMode: 'plan',
    permissionPrompts: 'none',
    createdAt: at,
    updatedAt: endedAt ?? at,
  },
  executions: [execution(at, endedAt)],
});

test('a restart restores chats from their rows, replays no transcript, and retires the ones that ended long ago', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.workspaceDir, { recursive: true });
  const old = randomUUID();
  const cut = randomUUID();
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const before = new Db(config);
  before.saveChats([stored(old, config.workspaceDir, hoursAgo(3), hoursAgo(2)), stored(cut, config.workspaceDir, hoursAgo(0.1), null)], 200);
  before.close();
  // Both have a transcript; neither is read into the chat's buffer
  const dir = join(config.projectsDir, encodeProjectId(config.workspaceDir));
  mkdirSync(dir, { recursive: true });
  for (const id of [old, cut]) {
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: `u-${id}`, timestamp: hoursAgo(1), cwd: config.workspaceDir, sessionId: id, message: { role: 'user', content: 'hi' } })}\n`,
    );
  }
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  try {
    await runs.restore(new SessionStore(config));
    assert.deepEqual(new Set(runs.list().map((c) => c.id)), new Set([old, cut]));
    assert.equal(runs.get(old)?.status, 'completed');
    assert.deepEqual(runs.get(cut)?.executions.map((e) => e.outcome), ['interrupted']);
    const messages = (events: RunEvent[]) => events.filter((e) => e.kind === 'message');
    assert.deepEqual(messages(runs.events(cut)), [], 'a chat in memory starts with no replayed transcript');
    assert.deepEqual(messages(runs.events(old)), [], 'nor one woken from its row');
  } finally {
    await runs.stopAll();
    db.close();
  }
});

test('a spawn that throws at once ends the execution it began, and a new chat it refused leaves no row', async () => {
  const { config, db, runs } = rig();
  try {
    const id = await ended(runs, config.workspaceDir);
    // An argument the kernel cannot take is refused by spawn itself, before any process exists
    assert.throws(() => runs.resume(id, { prompt: 'again', model: 'bad\0model' }));
    const chat = runs.get(id);
    assert.equal(chat?.status, 'failed');
    assert.equal(chat?.executions.length, 2);
    assert.ok(chat?.executions.at(-1)?.endedAt, 'the execution it began has ended');
    assert.equal(chat?.executions.at(-1)?.outcome, 'failed');

    const rows = db.loadChats().length;
    assert.throws(() => runs.start({ prompt: 'new', cwd: config.workspaceDir, model: 'bad\0model', keepAlive: false }));
    assert.equal(runs.list().length, 1);
    assert.equal(db.loadChats().length, rows, 'the start that never was is not a chat at the next restart');
  } finally {
    await runs.stopAll();
    db.close();
  }
});

test('stopping every chat waits for their processes, and kills one that ignores SIGTERM once the grace is over', async () => {
  const scratch = tempConfig().dataDir;
  const bin = join(scratch, 'stubborn-claude.mjs');
  const ready = join(scratch, 'ready');
  // It says it is ready only once SIGTERM can no longer end it
  writeFileSync(bin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(${JSON.stringify(ready)}, 'up');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  chmodSync(bin, 0o755);
  const { config, db, runs } = rig(bin);
  let pid: number | null = null;
  try {
    const chat = runs.start({ prompt: 'hello', cwd: config.workspaceDir, keepAlive: false });
    pid = await until(() => runs.get(chat.id)?.pid, 'the process to start');
    await until(() => existsSync(ready), 'the process to ignore SIGTERM');
    const started = Date.now();
    await runs.stopAll(400);
    assert.ok(Date.now() - started >= 350, 'it waited for the grace before giving up on SIGTERM');
    const stubborn = pid;
    await until(() => !alive(stubborn), 'the stubborn process to be killed');
  } finally {
    // Whatever the outcome, the stub that ignores SIGTERM does not outlive the test
    if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    db.close();
  }
});
