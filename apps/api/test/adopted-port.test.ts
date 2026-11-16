import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AdoptedPortTakenError, startServer } from '../src/server.ts';

// t5 of docs/plans/survive-restarts.md: a CLI that outlived the last server carries its address in
// CLAUDIO_API_URL, so a server that starts beside it answers on that port or does not start.

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Clock ticks after boot, `/proc/<pid>/stat` field 22 */
const startedOf = (pid: number): number => {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
};

/** A data directory a first server has made, with a row for a CLI that is still running and holds `port` */
async function leftBehind(t: TestContext, port: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-adopted-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const shared = { CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'), CLAUDIO_DATA_DIR: dataDir, CLAUDIO_CLI_UPDATE_CHECK: 'off' };
  const before = Object.fromEntries(Object.keys(shared).map((key) => [key, process.env[key]]));
  Object.assign(process.env, shared);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // The first server only makes the database and its tables
  await (await startServer({ port: 0, portFallback: false })).close();
  // A stand-in for the parked CLI, in a row whose owner is this process (a server that runs), so the
  // restore at start leaves it alone
  const cli = spawn('sleep', ['600'], { stdio: 'ignore' });
  t.after(() => cli.kill('SIGKILL'));
  const pid = cli.pid ?? 0;
  const dir = join(dataDir, 'procs', 'aaaaaaaaaaaaaaaa');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'api-url'), `http://127.0.0.1:${String(port)}/api\n`);
  const sql = new DatabaseSync(join(dataDir, 'wrapper.db'));
  sql
    .prepare(
      `INSERT INTO cli_processes (id, chat_id, layout, dir, wrapper_pid, wrapper_started, cli_pid, cli_started, owner_pid, owner_started, lease_until, started_at)
       VALUES ('aaaaaaaaaaaaaaaa', 'chat', 1, ?, ?, ?, ?, ?, ?, ?, '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(dir, pid, startedOf(pid), pid, startedOf(pid), process.pid, startedOf(process.pid));
  sql.close();
}

test('a server that starts beside a running parked CLI listens on the port that CLI was given, whatever port it was asked for', { timeout: 120_000 }, async (t) => {
  const held = await freePort();
  await leftBehind(t, held);
  const server = await startServer({ port: 0, portFallback: true });
  t.after(() => server.close());
  assert.equal(server.port, held);
});

test('it does not move to another port when that one is taken: the CLI could not reach it there', { timeout: 120_000 }, async (t) => {
  const held = await freePort();
  await leftBehind(t, held);
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(held, '127.0.0.1', resolve));
  t.after(() => squatter.close());
  await assert.rejects(
    startServer({ port: 0, portFallback: true }),
    (err: NodeJS.ErrnoException) => err instanceof AdoptedPortTakenError && err.code === 'EADDRINUSE' && err.message.includes(String(held)),
  );
});

test('with no parked CLI running, the port it asks for is the port it gets, and it may still fall back', { timeout: 120_000 }, async (t) => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => taken.close());
  const { port } = taken.address() as { port: number };
  const root = mkdtempSync(join(tmpdir(), 'claudio-no-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shared = { CLAUDE_BIN: '/nonexistent/claude', CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'), CLAUDIO_DATA_DIR: join(root, 'data'), CLAUDIO_CLI_UPDATE_CHECK: 'off' };
  const before = Object.fromEntries(Object.keys(shared).map((key) => [key, process.env[key]]));
  Object.assign(process.env, shared);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const server = await startServer({ port, portFallback: true });
  t.after(() => server.close());
  assert.notEqual(server.port, port);
});
