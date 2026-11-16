import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Orchestration } from '@claudio/shared';
import { ChatManager } from '../src/chats.ts';
import { Db, migrate } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import type { CoreConfig } from '../src/paths.ts';
import { PermissionBroker } from '../src/permissions.ts';
import { ParkedProcess } from '../src/parked/process.ts';
import { ParkedProcesses } from '../src/parked/registry.ts';
import { CliProcessStore } from '../src/parked/store.ts';
import { PARKED_FILES } from '../src/parked/wrapper.ts';
import { pendingPermissionRequests } from '../src/providers/claude-code/driver.ts';
import { processEntry } from '../src/processes.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

// Layer 2 of docs/plans/survive-restarts.md, t4: a server that goes away lets its parked CLIs run on,
// and the next start takes them over (adoption) instead of stopping them and continuing their turns.
// Two servers are two ChatManagers on two connections to one data dir; a server that "crashed" is one
// whose rows name an owner that no longer runs. Over the control fake CLI only: no real turn.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const STORE_MODULE = fileURLToPath(new URL('../src/parked/store.ts', import.meta.url));
const REGISTRY_MODULE = fileURLToPath(new URL('../src/parked/registry.ts', import.meta.url));
const DEAD = { pid: 999_999_999, started: 1 };

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Server {
  db: Db;
  runs: ChatManager;
}

function parkedConfig(): CoreConfig {
  return { ...tempConfig(), claudeBin: FAKE, parked: { handoverSeconds: 300, scopes: false } };
}

function server(config: CoreConfig, broker = false): Server {
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  if (broker) runs.permissions = new PermissionBroker();
  return { db, runs };
}

/** A clean shutdown with parking on: the processes are let go, the database closed. */
async function shutDown(s: Server): Promise<void> {
  await s.runs.stopAll(500);
  s.db.close();
}

/** Ends for good what a test left parked: a shutdown only lets it go. */
async function endAll(s: Server): Promise<void> {
  for (const parked of s.runs.parked.held()) {
    const closed = once(parked, 'close');
    parked.kill('SIGKILL');
    await closed;
  }
  await s.runs.stopAll(500);
  s.db.close();
}

const rowsOf = (db: Db) => new CliProcessStore(db.connection).all();
const spendOf = (db: Db, chatId: string) => db.connection.prepare('SELECT usd, source FROM spend_ledger WHERE chat_id = ?').all(chatId) as Array<{ usd: number; source: string | null }>;

test('a shutdown lets a parked CLI go mid-turn, and the next start adopts it: the same process finishes the turn, with no resume', async () => {
  const config = parkedConfig();
  const spawns = join(mkdtempSync(join(tmpdir(), 'claudio-adopt-spawns-')), 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  try {
    const before = server(config);
    const chat = before.runs.start({ prompt: 'SLEEP 2', cwd: config.workspaceDir });
    await until(() => before.runs.get(chat.id)?.status, (s) => s === 'busy', 'the turn under way');
    const parked = before.runs.parked.held()[0] as ParkedProcess;
    const cli = await until(() => parked.cli(), (c) => c !== null, 'the CLI pid');
    const pid = before.runs.get(chat.id)?.pid;
    await shutDown(before);
    assert.equal(processEntry(cli?.pid ?? 0)?.started, cli?.started, 'the shutdown did not stop the CLI');
    const after = server(config);
    assert.equal(rowsOf(after.db)[0]?.owner, null, 'the row was let go');
    try {
      await after.runs.restore(new SessionStore(config));
      assert.equal(after.runs.adopted(chat.id), true);
      assert.deepEqual(after.runs.strays(), [], 'an adopted CLI is no stray');
      assert.deepEqual(after.runs.cutTurns(), [], 'nothing to continue: the turn was never cut');
      assert.equal(after.runs.get(chat.id)?.status, 'busy', 'it reads running at once');
      assert.equal(after.runs.get(chat.id)?.pid, pid, 'on the same process');
      const done = await until(() => after.runs.get(chat.id), (c) => c?.status === 'idle', 'the turn to finish');
      assert.equal(done?.executions.length, 1, 'in the same execution');
      assert.equal(done?.executions[0]?.outcome, null);
      assert.equal(done?.turns, 1);
      assert.match((await after.runs.waitForResult(chat.id)).result, /the command finished/);
      assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 1, 'one CLI start for the whole turn');
      assert.equal(spendOf(after.db, chat.id).length, 1, 'one spend row for one turn');
      assert.equal(rowsOf(after.db)[0]?.owner?.pid, process.pid, 'the row is this server\'s now');
    } finally {
      await endAll(after);
    }
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
});

test('a turn that ended while no server was there is read from the replay: the adopter finds the chat idle with its result', async () => {
  const config = parkedConfig();
  const before = server(config);
  const chat = before.runs.start({ prompt: 'SLEEP 1', cwd: config.workspaceDir });
  await until(() => before.runs.get(chat.id)?.status, (s) => s === 'busy', 'the turn under way');
  const parked = before.runs.parked.held()[0] as ParkedProcess;
  const output = join(parked.dir, PARKED_FILES.output);
  before.runs.detachParked();
  // A crash: the rows name a server that no longer runs
  before.db.connection.prepare('UPDATE cli_processes SET owner_pid = ?, owner_started = ?').run(DEAD.pid, DEAD.started);
  await before.runs.stopAll(500);
  before.db.close();
  await until(() => readFileSync(output, 'utf8'), (text) => text.includes('"type":"result"'), 'the result written with nobody reading');
  const after = server(config);
  try {
    await after.runs.restore(new SessionStore(config));
    const restored = after.runs.get(chat.id);
    assert.equal(restored?.status, 'idle', 'the replay closed the turn before the start resolved');
    assert.equal(restored?.turns, 1);
    assert.equal(spendOf(after.db, chat.id).length, 1);
    assert.equal(rowsOf(after.db)[0]?.committedOffset, after.runs.parked.held()[0]?.offset, 'the replayed result is committed');
    // The adopted process takes the next turn
    after.runs.sendMessage(chat.id, 'second');
    await until(() => after.runs.get(chat.id), (c) => c?.turns === 2 && c.status === 'idle', 'the second turn');
    assert.equal(after.runs.get(chat.id)?.pid, parked.pid);
  } finally {
    await endAll(after);
  }
});

test('a result replayed after an adoption is never counted twice, even when the server before died between its spend row and its chat row', async () => {
  const config = parkedConfig();
  const before = server(config);
  const chat = before.runs.start({ prompt: 'first', cwd: config.workspaceDir });
  await until(() => before.runs.get(chat.id)?.status, (s) => s === 'idle', 'the turn');
  assert.equal(spendOf(before.db, chat.id).length, 1);
  before.runs.detachParked();
  // What a death right after the ledger row leaves: the offset and the session's totals not moved yet
  const sql = before.db.connection;
  sql.prepare('UPDATE cli_processes SET committed_offset = 0, owner_pid = ?, owner_started = ?').run(DEAD.pid, DEAD.started);
  sql.prepare("UPDATE chats SET json = json_set(json, '$.reported.costUsd', 0) WHERE id = ?").run(chat.id);
  sql.prepare("UPDATE executions SET json = json_set(json, '$.costUsd', NULL, '$.turns', 0) WHERE chat_id = ?").run(chat.id);
  await before.runs.stopAll(500);
  before.db.close();
  const after = server(config);
  try {
    await after.runs.restore(new SessionStore(config));
    const restored = after.runs.get(chat.id);
    assert.equal(restored?.turns, 1, 'the replayed result is the turn the chat row had lost');
    assert.ok(Math.abs((restored?.costUsd ?? 0) - 0.01) < 1e-9, `cost ${String(restored?.costUsd)}`);
    const rows = spendOf(after.db, chat.id);
    assert.equal(rows.length, 1, 'the ledger refused the replayed row');
    assert.match(rows[0]?.source ?? '', /^[0-9a-f]{16}:\d+$/);
  } finally {
    await endAll(after);
  }
});

test('a pending prompt reaches the adopter from the CLI\'s own list, and answering it finishes the turn', async () => {
  const config = parkedConfig();
  const before = server(config, true);
  const chat = before.runs.start({ prompt: 'ASK Bash', cwd: config.workspaceDir, permissionPrompts: 'host' });
  const asked = await until(() => before.runs.permissions?.list(chat.id) ?? [], (l) => l.length === 1, 'the prompt');
  await shutDown(before);
  const after = server(config, true);
  try {
    await after.runs.restore(new SessionStore(config));
    await after.runs.reattached();
    const again = after.runs.permissions?.list(chat.id) ?? [];
    assert.deepEqual(again.map((r) => r.id), asked.map((r) => r.id), 'the same request, asked once');
    assert.equal(again[0]?.toolName, 'Bash');
    after.runs.permissions?.answer(again[0]?.id ?? '', { behavior: 'allow' }, chat.id);
    await until(() => after.runs.get(chat.id), (c) => c?.status === 'idle', 'the turn to finish');
    assert.match((await after.runs.waitForResult(chat.id)).result, /decision=.*allow/);
  } finally {
    await endAll(after);
  }
});

test('a CLI that lists nothing has its unanswered prompt rebuilt from the replay, and a prompt already answered is never asked again', async () => {
  process.env.FAKE_CLAUDE_PENDING_LIST = 'off';
  try {
    const config = parkedConfig();
    const before = server(config, true);
    const answeredChat = before.runs.start({ prompt: 'ASK Edit', cwd: config.workspaceDir, permissionPrompts: 'host' });
    const first = await until(() => before.runs.permissions?.list(answeredChat.id) ?? [], (l) => l.length === 1, 'the first prompt');
    before.runs.permissions?.answer(first[0]?.id ?? '', { behavior: 'allow' }, answeredChat.id);
    await until(() => before.runs.get(answeredChat.id)?.status, (s) => s === 'idle', 'the answered turn');
    const waiting = before.runs.start({ prompt: 'ASK Bash', cwd: config.workspaceDir, permissionPrompts: 'host' });
    const pending = await until(() => before.runs.permissions?.list(waiting.id) ?? [], (l) => l.length === 1, 'the second prompt');
    await shutDown(before);
    // The answered request is in the replay again, as when its turn end was never committed
    const sql = new DatabaseSync(join(config.dataDir, 'wrapper.db'), { timeout: 5000 });
    sql.prepare('UPDATE cli_processes SET committed_offset = 0').run();
    sql.close();
    const after = server(config, true);
    try {
      await after.runs.restore(new SessionStore(config));
      await after.runs.reattached();
      assert.deepEqual((after.runs.permissions?.list(answeredChat.id) ?? []).map((r) => r.id), [], 'an answered request is not asked again');
      assert.deepEqual((after.runs.permissions?.list(waiting.id) ?? []).map((r) => r.id), pending.map((r) => r.id), 'rebuilt from the replay');
    } finally {
      await endAll(after);
    }
  } finally {
    delete process.env.FAKE_CLAUDE_PENDING_LIST;
  }
});

test('a parked process that cannot be adopted is stopped, and its cut turn goes to layer 3', async () => {
  const config = parkedConfig();
  const before = server(config);
  const chat = before.runs.start({ prompt: 'BASH sleep 600', cwd: config.workspaceDir });
  await until(() => before.runs.get(chat.id)?.activity, (a) => a !== null && a !== undefined, 'the hanging call under way');
  const parked = before.runs.parked.held()[0] as ParkedProcess;
  const cli = await until(() => parked.cli(), (c) => c !== null, 'the CLI pid');
  await shutDown(before);
  // A layout this server does not know: its files are not a contract it can read
  const sql = new DatabaseSync(join(config.dataDir, 'wrapper.db'), { timeout: 5000 });
  sql.prepare('UPDATE cli_processes SET layout = 99').run();
  sql.close();
  const after = server(config);
  try {
    await after.runs.restore(new SessionStore(config));
    assert.equal(after.runs.adopted(chat.id), false);
    await until(() => processEntry(cli?.pid ?? 0)?.started, (s) => s !== cli?.started, 'the CLI to be stopped');
    assert.equal(rowsOf(after.db).length, 0);
    assert.equal(after.runs.cutTurns().find((c) => c.chatId === chat.id)?.continuable, true);
  } finally {
    await endAll(after);
  }
});

test('with parking off, a shutdown still stops the chats', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE };
  const s = server(config);
  const chat = s.runs.start({ prompt: 'BASH sleep 600', cwd: config.workspaceDir });
  await until(() => s.runs.get(chat.id)?.pid, (p) => typeof p === 'number', 'the process');
  assert.deepEqual(s.runs.detachParked(), []);
  await s.runs.stopAll(500);
  assert.equal(s.runs.get(chat.id)?.status, 'stopped');
  s.db.close();
});

test('two servers starting at once never both adopt one process', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-adopt-race-'));
  const file = join(dataDir, 'wrapper.db');
  const sql = new DatabaseSync(file);
  migrate(sql);
  const store = new CliProcessStore(sql);
  const first = new ParkedProcesses({ dataDir, store, handoverSeconds: 300, scopes: false, userManager: () => false, stopGraceSeconds: 2 });
  const parked = first.start({ chatId: 'chat-1', bin: FAKE, args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], cwd: dataDir, env: { ...process.env } });
  try {
    await until(() => parked.cli(), (c) => c !== null, 'the CLI pid');
    first.detach();
    assert.equal(store.get(parked.id)?.owner, null);
    // 8 s: the children load the registry first, which under a loaded machine takes longer than the 1.5 s this had
    // Each child is a server: its own connection and its own pid, both reading the row at the same instant
    const at = Date.now() + 8000;
    const script = `
      const { DatabaseSync } = await import('node:sqlite');
      const { CliProcessStore } = await import(${JSON.stringify(STORE_MODULE)});
      const { ParkedProcesses } = await import(${JSON.stringify(REGISTRY_MODULE)});
      const sql = new DatabaseSync(${JSON.stringify(file)}, { timeout: 5000 });
      const store = new CliProcessStore(sql);
      const registry = new ParkedProcesses({ dataDir: ${JSON.stringify(dataDir)}, store, handoverSeconds: 300, scopes: false, userManager: () => false });
      while (Date.now() < ${String(at)}) {}
      const row = store.get(${JSON.stringify(parked.id)});
      const got = registry.adopt(row);
      console.log(typeof got === 'string' ? got : 'adopted');
      sql.close();
      process.exit(0);`;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.on('error', reject);
        child.on('exit', () => resolve(out.trim()));
      });
    const answers = await Promise.all([run(), run()]);
    assert.equal(answers.filter((a) => a === 'adopted').length, 1, answers.join(', '));
    assert.ok(answers.every((a) => ['adopted', 'held', 'taken'].includes(a)), answers.join(', '));
  } finally {
    // The CLI outlived both: a reap from this side (its owner is gone) ends it
    sql.prepare('UPDATE cli_processes SET owner_pid = ?, owner_started = ?').run(DEAD.pid, DEAD.started);
    await new ParkedProcesses({ dataDir, store, handoverSeconds: 300, scopes: false, userManager: () => false, stopGraceSeconds: 2 }).reap();
    sql.close();
  }
});

test('the guarded take lets exactly one of two servers that read the same owner have the row', () => {
  const sql = new DatabaseSync(':memory:');
  migrate(sql);
  const a = new CliProcessStore(sql);
  a.insert({ id: 'p1', chatId: 'c', layout: 1, dir: '/x', scope: null, wrapper: { pid: 1, started: 1 }, cli: null, owner: DEAD, leaseUntil: '2026-11-16T00:00:00.000Z', committedOffset: 0, stdinSeq: 0, turnOffset: null, tokenHash: null, payloadDir: null, cliVersion: null, startedAt: '2026-11-16T00:00:00.000Z' });
  const read = a.get('p1')?.owner ?? null;
  assert.equal(a.take('p1', read, { pid: 10, started: 1 }, '2026-11-16T00:05:00.000Z'), true);
  assert.equal(a.take('p1', read, { pid: 11, started: 1 }, '2026-11-16T00:05:00.000Z'), false);
  assert.equal(a.get('p1')?.owner?.pid, 10);
  assert.equal(a.release('p1', { pid: 11, started: 1 }), false, 'only its holder lets it go');
  assert.equal(a.release('p1', { pid: 10, started: 1 }), true);
  assert.equal(a.take('p1', null, { pid: 11, started: 1 }, '2026-11-16T00:05:00.000Z'), true, 'a released row is taken from nobody');
});

test('the pending list of an initialize answer is read beside the inner response, in either shape', () => {
  const request = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } };
  assert.deepEqual(pendingPermissionRequests({ response: {}, pending_permission_requests: [{ type: 'control_request', request_id: 'r1', request }] }), [{ id: 'r1', request }]);
  assert.deepEqual(pendingPermissionRequests({ pending_permission_requests: [{ request_id: 'r2', ...request }] }), [{ id: 'r2', request: { request_id: 'r2', ...request } }]);
  assert.deepEqual(pendingPermissionRequests({ pending_permission_requests: [] }), []);
  assert.equal(pendingPermissionRequests({ response: { pending_permission_requests: [] } }), null, 'not inside the inner response');
});

test('a graph task whose worker was adopted goes on in the same attempt and is not run again', async () => {
  const config = parkedConfig();
  const spawns = join(mkdtempSync(join(tmpdir(), 'claudio-adopt-graph-')), 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  try {
    const before = server(config);
    const beforeOrch = new Orchestrator(config, before.runs, before.db);
    const started = beforeOrch.create({ name: 'Adopted', cwd: config.workspaceDir, tasks: [{ id: 'a', name: 'A', prompt: 'SLEEP 2' }] });
    const running = await until(() => beforeOrch.get(started.id), (o) => !!o?.tasks[0]?.runId && before.runs.get(o.tasks[0].runId)?.status === 'busy', 'the worker under way');
    const worker = running?.tasks[0]?.runId as string;
    beforeOrch.close();
    await shutDown(before);
    const after = server(config);
    const afterOrch = new Orchestrator(config, after.runs, after.db);
    try {
      await after.runs.restore(new SessionStore(config));
      afterOrch.recover();
      const recovered = afterOrch.get(started.id) as Orchestration;
      assert.equal(recovered.tasks[0]?.status, 'running', 'running, not interrupted');
      assert.equal(recovered.tasks[0]?.attempts, 1, 'no attempt spent');
      const done = await until(() => afterOrch.get(started.id) as Orchestration, (o) => o.status !== 'running', 'the graph to end');
      assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((t) => [t.status, t.error])));
      assert.equal(done.tasks[0]?.attempts, 1);
      assert.equal(done.tasks[0]?.runId, worker);
      assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 1, 'the worker started once');
    } finally {
      afterOrch.close();
      await endAll(after);
    }
  } finally {
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
});

test('a detached process writes nothing more and is never signalled by the server that let it go', async () => {
  const config = parkedConfig();
  const s = server(config);
  const chat = s.runs.start({ prompt: 'first', cwd: config.workspaceDir });
  await until(() => s.runs.get(chat.id)?.status, (st) => st === 'idle', 'the turn');
  const parked = s.runs.parked.held()[0] as ParkedProcess;
  const input = join(parked.dir, PARKED_FILES.input);
  const recorded = readFileSync(input, 'utf8');
  s.runs.detachParked();
  assert.equal(parked.stdin.write('{"type":"user","message":{"role":"user","content":"x"}}\n'), false);
  parked.stdin.end();
  assert.equal(parked.kill('SIGTERM'), false);
  assert.equal(readFileSync(input, 'utf8'), recorded);
  assert.ok(existsSync(parked.dir), 'its files stay for the next server');
  await s.runs.stopAll(500);
  s.db.close();
  // A start with nobody to adopt it (parking off now) ends it
  const { parked: _on, ...off } = config;
  const after = server(off);
  await after.runs.restore(new SessionStore(config));
  assert.equal(after.runs.adopted(chat.id), false);
  assert.equal(rowsOf(after.db).length, 0);
  await after.runs.stopAll(500);
  after.db.close();
});
