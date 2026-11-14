import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Execution, OrchestrationTaskState } from '@claudio/shared';
import { ChatManager } from '../src/chats.ts';
import { Db, migrate, RESUMED_COSTS_SCHEMA_VERSION } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { RESUMED_COSTS_FIX, recomputeResumedCosts, resumedCostsFixedAt } from '../src/session-totals.ts';
import { tempConfig } from './helpers.ts';

// Claude Code's `total_cost_usd` and `modelUsage` are the session's, across its processes: a resume
// goes on from the session's last totals and a fork starts from its parent's (spike S1 of
// docs/plans/decision-engine-v2.md). Each execution is billed only its own turns, however the
// process that ran it began, and the stored executions billed the old way are mended once.

const CONTROL = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const WORKER = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const near = (actual: number | null | undefined, expected: number, what: string) => assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9, `${what}: ${String(actual)}, expected ${String(expected)}`);

const finished = (core: Core, id: string, executions: number) =>
  until(() => {
    const runtime = core.runtime.get(id);
    return runtime && runtime.executions.length === executions && runtime.executions.every((e) => e.endedAt !== null) && runtime;
  }, `${String(executions)} finished execution(s) of ${id}`);

const ledger = (core: Core, id: string) =>
  (core.db.connection.prepare('SELECT usd FROM spend_ledger WHERE chat_id = ? ORDER BY seq').all(id) as Array<{ usd: number }>).map((r) => Math.round(r.usd * 1000) / 1000);

test('a resumed execution is billed only its own turn, in cost and in tokens', async () => {
  const core = new Core({ ...tempConfig(), claudeBin: CONTROL });
  try {
    const chat = core.runtime.start({ prompt: 'one', keepAlive: false });
    await finished(core, chat.id, 1);
    // The resumed process reports the session's 0.02 and two turns of tokens; this execution ran one
    await core.chats.resume(chat.id, { prompt: 'two' });
    const runtime = await finished(core, chat.id, 2);
    const [first, second] = runtime.executions;
    near(first?.costUsd, 0.01, 'the first execution');
    near(second?.costUsd, 0.01, 'the resumed execution');
    near(second?.modelCosts?.['claude-opus-5[1m]'], 0.01, "the resumed execution's split by model");
    near(runtime.costUsd, 0.02, 'the chat: what the session cost');
    assert.deepEqual(ledger(core, chat.id), [0.01, 0.01], 'the ledger is written the turn, not the session');
    const turn = core.runtime.lastTurn(chat.id);
    near(turn?.costUsd, 0.01, "the last turn's cost");
    assert.deepEqual([turn?.tokens?.input, turn?.tokens?.output], [1, 1], "the last turn's tokens are its own");
  } finally {
    core.shutdown();
  }
});

test('a fork is billed only its own turns, not the history it copied', async () => {
  const core = new Core({ ...tempConfig(), claudeBin: CONTROL });
  try {
    const source = core.runtime.start({ prompt: 'one', keepAlive: false });
    await finished(core, source.id, 1);
    await core.chats.resume(source.id, { prompt: 'two' });
    await finished(core, source.id, 2);
    // The copy's first result reports its source's 0.02 plus its own turn
    const fork = await core.chats.fork(source.id, { prompt: 'another way' });
    await until(() => core.runtime.get(fork.id)?.status === 'idle', 'the fork to answer');
    const next = core.runtime.nextResult(fork.id);
    core.runtime.send(fork.id, 'and again');
    await next;
    const copy = core.runtime.get(fork.id);
    near(copy?.executions[0]?.costUsd, 0.02, "the fork's two turns");
    near(copy?.costUsd, 0.02, 'the fork');
    assert.deepEqual(ledger(core, fork.id), [0.01, 0.01]);
    near(core.runtime.get(source.id)?.costUsd, 0.02, 'the source is billed what it was before');
  } finally {
    core.shutdown();
  }
});

test('a wrapper restart between two executions does not bill the history again', async () => {
  const config = { ...tempConfig(), claudeBin: CONTROL };
  const before = new Core(config);
  let id: string;
  try {
    const chat = before.runtime.start({ prompt: 'one', keepAlive: false });
    id = chat.id;
    await finished(before, id, 1);
    await before.chats.resume(id, { prompt: 'two' });
    await finished(before, id, 2);
  } finally {
    before.shutdown();
  }
  const after = new Core(config);
  try {
    await until(() => after.runtime.get(id), 'the chat to be restored');
    // Restored from its row, with no process: the session's totals came back with it
    await after.chats.resume(id, { prompt: 'three' });
    const runtime = await finished(after, id, 3);
    near(runtime.executions[2]?.costUsd, 0.01, 'the execution after the restart');
    near(runtime.costUsd, 0.03, 'the chat');
    assert.deepEqual(ledger(after, id), [0.01, 0.01, 0.01]);
    assert.deepEqual(after.runtime.lastTurn(id)?.tokens?.output, 1, "the turn's tokens after the restart");
  } finally {
    after.shutdown();
  }
});

test('three continuations of one orchestration task cost the sum of their turns, not the session again at each', async () => {
  const config = { ...tempConfig(), claudeBin: WORKER };
  const db = new Db(config);
  const repo = mkdtempSync(join(tmpdir(), 'resumed-costs-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  try {
    const started = orchestrator.create({
      name: 'continuations',
      cwd: repo,
      worktree: true,
      tasks: [{ id: 'owing', name: 'owing', prompt: 'FAKE-TEXT-ALWAYS The schema is in place. Next, I will wire the route.' }],
    });
    const orch = await until(() => {
      const o = orchestrator.get(started.id);
      return o && (o.status === 'completed' || o.status === 'failed' || o.status === 'stopped') && o;
    }, 'the orchestration to settle', 60_000);
    const task = orch.tasks[0] as OrchestrationTaskState;
    assert.equal(task.continuations, 3, 'sent back three times');
    const chat = runs.get(task.runId ?? '');
    assert.equal(chat?.executions.length, 4, 'four executions of one chat');
    // Each process ran one turn of 0.01; the old billing read them as 0.01, 0.02, 0.03 and 0.04
    for (const e of chat?.executions ?? []) near(e.costUsd, 0.01, 'each execution');
    near(task.costUsd, 0.04, 'the task');
    near(orch.costUsd, 0.04, 'the orchestration');
  } finally {
    await runs.stopAll();
    db.close();
  }
});

// ---------- the stored executions (D7) ----------

const execution = (id: string, startedAt: string, costUsd: number | null, modelCosts?: Record<string, number>): Execution => ({
  id,
  startedAt,
  endedAt: startedAt,
  outcome: 'completed',
  error: null,
  permissionMode: 'manual',
  model: 'sonnet',
  maxBudgetUsd: null,
  costUsd,
  ...(modelCosts ? { modelCosts } : {}),
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
});

/** A database as the last release left it, with chats billed the old way. */
function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, RESUMED_COSTS_SCHEMA_VERSION - 1);
  const chat = (id: string, executions: Execution[]) => {
    db.prepare("INSERT INTO chats (id, created_at, provider, json) VALUES (?, ?, 'claude-code', ?)").run(id, '2026-11-01T00:00:00.000Z', JSON.stringify({ id, name: id, cwd: '/work', prompt: 'p' }));
    for (const e of executions) db.prepare('INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)').run(e.id, id, e.startedAt, JSON.stringify(e));
  };
  // Resumed twice: the session's running total at each end, which is how the old billing stored it
  chat('grows', [
    execution('g1', '2026-11-01T01:00:00.000Z', 1, { opus: 1 }),
    execution('g2', '2026-11-01T02:00:00.000Z', 2, { opus: 1.7, haiku: 0.3 }),
    execution('g3', '2026-11-01T03:00:00.000Z', null),
    execution('g4', '2026-11-01T04:00:00.000Z', 4, { opus: 3.7, haiku: 0.3 }),
  ]);
  // A cost that went down: not billed that way, or not only, and left alone
  chat('falls', [execution('f1', '2026-11-01T01:00:00.000Z', 2), execution('f2', '2026-11-01T02:00:00.000Z', 0.5)]);
  chat('single', [execution('s1', '2026-11-01T01:00:00.000Z', 3)]);
  chat('unpaid', [execution('u1', '2026-11-01T01:00:00.000Z', null), execution('u2', '2026-11-01T02:00:00.000Z', null)]);
  db.prepare("INSERT INTO spend_ledger (at, chat_id, execution_id, usd, reported, purpose) VALUES ('2026-11-01T02:00:00.000Z', 'grows', 'g2', 2, 1, 'person')").run();
  return db;
}

const costsOf = (db: DatabaseSync, chatId: string) =>
  (db.prepare('SELECT json FROM executions WHERE chat_id = ? ORDER BY started_at').all(chatId) as Array<{ json: string }>).map((r) => {
    const e = JSON.parse(r.json) as Execution;
    return [e.costUsd === null ? null : Math.round(e.costUsd * 1000) / 1000, e.modelCosts ? Object.fromEntries(Object.entries(e.modelCosts).map(([m, v]) => [m, Math.round(v * 1000) / 1000])) : null];
  });
const recordOf = (db: DatabaseSync, chatId: string) => JSON.parse((db.prepare('SELECT json FROM chats WHERE id = ?').get(chatId) as { json: string }).json) as Record<string, unknown>;

test('the upgrade bills each stored execution of a resumed chat its own turns, and leaves the ledger and the other chats alone', () => {
  const db = legacyDatabase();
  const untouched = { falls: costsOf(db, 'falls'), single: costsOf(db, 'single'), unpaid: costsOf(db, 'unpaid'), record: recordOf(db, 'falls') };
  migrate(db);
  assert.deepEqual(costsOf(db, 'grows'), [
    [1, { opus: 1 }],
    [1, { opus: 0.7, haiku: 0.3 }],
    [null, null],
    [2, { opus: 2, haiku: 0 }],
  ]);
  // The chat's record keeps the session's last totals, which its next process resumes from
  assert.deepEqual(recordOf(db, 'grows').reported, { costUsd: 4, models: [{ model: 'opus', costUsd: 3.7 }, { model: 'haiku', costUsd: 0.3 }] });
  assert.deepEqual(costsOf(db, 'falls'), untouched.falls);
  assert.deepEqual(recordOf(db, 'falls'), untouched.record);
  assert.deepEqual(costsOf(db, 'single'), untouched.single);
  assert.deepEqual(costsOf(db, 'unpaid'), untouched.unpaid);
  assert.deepEqual(db.prepare('SELECT usd FROM spend_ledger').all().map((r) => r.usd), [2], 'the ledger is what the cap decided with');
  // The day of the fix is recorded with what it mended
  assert.ok(resumedCostsFixedAt(db));
  assert.deepEqual({ ...db.prepare('SELECT chats, executions FROM cost_corrections WHERE name = ?').get(RESUMED_COSTS_FIX) }, { chats: 1, executions: 2 });
  db.close();
});

test('the upgrade run again on a database it already mended changes nothing', () => {
  const db = legacyDatabase();
  migrate(db);
  const fixedAt = resumedCostsFixedAt(db);
  const once = ['grows', 'falls', 'single', 'unpaid'].map((id) => [costsOf(db, id), recordOf(db, id)]);
  // Mended, 1, 1 and 2 still only grow: the totals on the record are what keep them from a second pass
  recomputeResumedCosts(db, '2099-01-01T00:00:00.000Z');
  assert.deepEqual(['grows', 'falls', 'single', 'unpaid'].map((id) => [costsOf(db, id), recordOf(db, id)]), once);
  assert.equal(resumedCostsFixedAt(db), fixedAt, 'the first date stays');
  db.close();
});
