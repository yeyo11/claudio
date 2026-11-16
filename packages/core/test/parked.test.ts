import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readlinkSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChatManager } from '../src/chats.ts';
import { SessionStore } from '../src/sessions.ts';
import { Db, migrate } from '../src/db.ts';
import { loadConfig } from '../src/paths.ts';
import { ParkedProcess } from '../src/parked/process.ts';
import { hasUserManager, ParkedProcesses } from '../src/parked/registry.ts';
import { CliProcessStore } from '../src/parked/store.ts';
import { PARKED_FILES, shellQuote } from '../src/parked/wrapper.ts';
import { processEntry } from '../src/processes.ts';
import { tempConfig } from './helpers.ts';

// Layer 2 of docs/plans/survive-restarts.md (t3): a CLI started detached under the parked wrapper,
// read through files and written through a FIFO, over the control fake CLI. The lease is written
// with the test's clock; the watchdog reads it against the wall clock, so a clock an hour behind is
// a lease that ran out an hour ago.

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const HOUR = 3_600_000;

const started: ParkedProcess[] = [];
after(() => {
  // Nothing a test started outlives the file, whatever it failed on
  for (const p of started) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
});

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Rig {
  dataDir: string;
  sql: DatabaseSync;
  store: CliProcessStore;
  registry: (options?: { now?: () => number; tickSeconds?: number; scopes?: boolean }) => ParkedProcesses;
}

function rig(): Rig {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-parked-'));
  const sql = new DatabaseSync(join(dataDir, 'wrapper.db'));
  migrate(sql);
  const store = new CliProcessStore(sql);
  return {
    dataDir,
    sql,
    store,
    registry: (options = {}) =>
      new ParkedProcesses({
        dataDir,
        store,
        handoverSeconds: 300,
        scopes: options.scopes ?? false,
        userManager: options.scopes ? hasUserManager : () => false,
        stopGraceSeconds: 2,
        ...(options.now ? { now: options.now } : {}),
        ...(options.tickSeconds !== undefined ? { tickSeconds: options.tickSeconds } : {}),
      }),
  };
}

/** A fake CLI under the wrapper, with its stdout lines gathered as parsed JSON. */
function launch(registry: ParkedProcesses, cwd: string) {
  const parked = registry.start({ chatId: 'chat-1', bin: FAKE, args: ARGS, cwd, env: { ...process.env } });
  started.push(parked);
  const lines: Array<Record<string, unknown>> = [];
  parked.listen(
    (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    () => {},
  );
  const send = (text: string) => parked.stdin.write(`${JSON.stringify({ type: 'user', uuid: `m-${String(lines.length)}`, message: { role: 'user', content: text } })}\n`);
  const results = () => lines.filter((l) => l.type === 'result');
  return { parked, lines, send, results };
}

async function cliOf(parked: ParkedProcess): Promise<{ pid: number; started: number }> {
  const cli = await until(() => parked.cli(), (c) => c !== null, 'the CLI pid');
  if (!cli) throw new Error('no CLI');
  return cli;
}
const sessionOf = (pid: number): number => Number(readFileSync(`/proc/${String(pid)}/stat`, 'utf8').split(') ')[1]?.split(' ')[3]);

test('shellQuote keeps every word of a command as it was, quotes and spaces included', () => {
  const words = ["it's", 'a b', '$HOME', '`x`', '"q"', '', 'back\\slash'];
  const printed = execFileSync('sh', ['-c', `set -- ${words.map(shellQuote).join(' ')}; for w in "$@"; do printf '%s\\0' "$w"; done`], { encoding: 'utf8' });
  assert.deepEqual(printed.split('\0').slice(0, -1), words);
});

test('a parked CLI reads its stdin from a FIFO, writes stdout to a file, and runs in a session of its own', async () => {
  const r = rig();
  const { parked, send, results } = launch(r.registry(), r.dataDir);
  const cli = await cliOf(parked);
  assert.equal(readlinkSync(`/proc/${String(cli.pid)}/fd/0`), join(parked.dir, PARKED_FILES.fifo));
  assert.equal(readlinkSync(`/proc/${String(cli.pid)}/fd/1`), join(parked.dir, PARKED_FILES.output));
  assert.notEqual(sessionOf(cli.pid), sessionOf(process.pid), 'not in the server session, so nothing of the server takes it down');
  assert.equal(processEntry(cli.pid)?.ppid, parked.pid, 'the wrapper is its parent');
  // The wrapper's own command line carries none of the CLI's arguments: it is never taken for a second CLI on the session
  assert.deepEqual(processEntry(parked.pid as number)?.argv, ['sh', join(parked.dir, PARKED_FILES.script)]);
  send('first');
  send('second');
  await until(results, (rs) => rs.length === 2, 'two turns on one process');
  assert.equal(processEntry(cli.pid)?.started, cli.started, 'the same process answered both');
  const row = r.store.get(parked.id);
  assert.equal(row?.cli?.pid, cli.pid);
  assert.equal(row?.owner?.pid, process.pid);
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('the files of a parked process are its owner\'s alone', async () => {
  const r = rig();
  const { parked } = launch(r.registry(), r.dataDir);
  await cliOf(parked);
  const mode = (path: string) => spawnSync('stat', ['-c', '%a', path], { encoding: 'utf8' }).stdout.trim();
  assert.equal(mode(join(r.dataDir, 'procs')), '700');
  assert.equal(mode(parked.dir), '700');
  for (const name of ['fifo', 'input', 'output', 'errors', 'script', 'lease', 'pid'] as const) assert.equal(mode(join(parked.dir, PARKED_FILES[name])), '600', name);
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('ending the input lets the CLI read EOF and exit, and its row and directory go with it', async () => {
  const r = rig();
  const { parked, send, results } = launch(r.registry(), r.dataDir);
  send('hello');
  await until(results, (rs) => rs.length === 1, 'the turn');
  await cliOf(parked);
  const closed = once(parked, 'close');
  parked.stdin.end();
  const [code] = (await closed) as [number | null];
  assert.equal(code, 0);
  assert.equal(parked.exitCode, 0);
  assert.equal(r.store.get(parked.id), null);
  assert.equal(existsSync(parked.dir), false);
});

test('a CLI killed by a signal closes with that signal, as a child on pipes would', async () => {
  const r = rig();
  const { parked } = launch(r.registry(), r.dataDir);
  await cliOf(parked);
  const closed = once(parked, 'close');
  assert.equal(parked.kill('SIGTERM'), true);
  const [code, signal] = (await closed) as [number | null, NodeJS.Signals | null];
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
});

test('the input record names what was sent, by kind and id, never its text', async () => {
  const r = rig();
  const { parked, send, results } = launch(r.registry(), r.dataDir);
  send('a secret prompt');
  parked.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-7', response: {} } })}\n`);
  await until(results, (rs) => rs.length === 1, 'the turn');
  const record = readFileSync(join(parked.dir, PARKED_FILES.input), 'utf8');
  assert.doesNotMatch(record, /secret/);
  assert.deepEqual(
    record.trim().split('\n').map((l) => JSON.parse(l) as unknown),
    [
      { seq: 1, type: 'user', id: 'm-0' },
      { seq: 2, type: 'control_response', id: 'req-7' },
    ],
  );
  assert.equal(r.store.get(parked.id)?.stdinSeq, 2);
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('a turn\'s end commits the offset the fold read to, and the bytes before it become a hole', async () => {
  const r = rig();
  const { parked, send, lines, results } = launch(r.registry(), r.dataDir);
  // Enough output that the committed offset passes a whole block
  for (let i = 0; i < 40; i++) {
    parked.turn(true);
    assert.equal(r.store.get(parked.id)?.turnOffset, parked.offset);
    assert.equal(readFileSync(join(parked.dir, PARKED_FILES.turn), 'utf8').trim(), String(parked.offset));
    send(`turn ${String(i)} ${'x'.repeat(200)}`);
    await until(results, (rs) => rs.length === i + 1, `turn ${String(i)}`);
    parked.turn(false);
  }
  const row = r.store.get(parked.id);
  assert.equal(row?.committedOffset, parked.offset);
  assert.equal(row?.turnOffset, null);
  assert.equal(existsSync(join(parked.dir, PARKED_FILES.turn)), false);
  assert.ok(lines.length > 0 && parked.offset > 8192);
  const output = join(parked.dir, PARKED_FILES.output);
  // fallocate runs on its own: the first block reads as zeros once it did, where the filesystem has holes
  const firstBlock = () => {
    const fd = openSync(output, 'r');
    const buffer = Buffer.alloc(4096);
    readSync(fd, buffer, 0, 4096, 0);
    closeSync(fd);
    return buffer;
  };
  const punched = spawnSync('fallocate', ['--help'], { stdio: 'ignore' }).status === 0;
  if (punched) await until(firstBlock, (b) => b.every((byte) => byte === 0), 'the read prefix punched out');
  // What follows the committed offset is intact, and the CLI keeps writing at the end
  send('after the holes');
  await until(results, (rs) => rs.length === 41, 'a turn after the holes');
  const tail = readFileSync(output).subarray(row?.committedOffset ?? 0).toString('utf8');
  assert.ok(tail.trim().split('\n').every((l) => JSON.parse(l) !== null));
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('the watchdog ends an open turn once the lease ran out, and leaves an idle CLI and a held lease alone', async () => {
  const r = rig();
  const expired = r.registry({ now: () => Date.now() - HOUR, tickSeconds: 0.2 });
  const held = r.registry({ tickSeconds: 0.2 });
  const working = launch(expired, r.dataDir);
  const idle = launch(expired, r.dataDir);
  const leased = launch(held, r.dataDir);
  for (const p of [working, leased]) {
    // A Bash call the fake never answers: the turn stays open until something ends it. Marked open
    // once the CLI is on it: a CLI that has not read its message yet is idle, and SIGINT would end it
    p.send('BASH sleep 600');
    await until(() => p.lines, (ls) => ls.some((l) => l.type === 'assistant'), 'the hanging call');
    p.parked.turn(true);
  }
  const ended = await until(working.results, (rs) => rs.length === 1, 'the watchdog to end the turn');
  assert.equal(ended[0]?.subtype, 'error_during_execution', 'SIGINT ended the turn, not the process');
  assert.ok(existsSync(join(working.parked.dir, PARKED_FILES.watchdog)));
  assert.equal(working.parked.exitCode, null);
  assert.equal(processEntry((await cliOf(working.parked)).pid)?.started, (await cliOf(working.parked)).started, 'the CLI is still up');
  // The same ticks went by for the others
  assert.equal(idle.parked.exitCode, null, 'an idle CLI is never sent SIGINT: it would end');
  assert.equal(existsSync(join(idle.parked.dir, PARKED_FILES.watchdog)), false);
  assert.equal(leased.results().length, 0, 'a lease a server holds keeps the turn going');
  for (const p of [working, idle, leased]) {
    const closed = once(p.parked, 'close');
    p.parked.kill('SIGKILL');
    await closed;
  }
});

test('a turn that ended while no server was there is not interrupted by the watchdog', async () => {
  const r = rig();
  const expired = r.registry({ now: () => Date.now() - HOUR, tickSeconds: 0.2 });
  const p = launch(expired, r.dataDir);
  // The server marked the turn open and went away before the result: the result is in the file all the same
  p.parked.turn(true);
  p.send('done at once');
  await until(p.results, (rs) => rs.length === 1, 'the turn');
  const cli = await cliOf(p.parked);
  // Several ticks later the CLI is still idle and up, and nothing was signalled
  p.send('BASH sleep 600');
  await until(() => p.lines, (ls) => ls.some((l) => l.type === 'assistant'), 'the second turn under way');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(join(p.parked.dir, PARKED_FILES.watchdog)), false);
  assert.equal(processEntry(cli.pid)?.started, cli.started);
  const closed = once(p.parked, 'close');
  p.parked.kill('SIGKILL');
  await closed;
});

test('renewing the lease moves it in the files and in the rows this server holds', async () => {
  const r = rig();
  let clock = Date.parse('2026-11-16T10:00:00Z');
  const registry = r.registry({ now: () => clock });
  const { parked } = launch(registry, r.dataDir);
  assert.equal(r.store.get(parked.id)?.leaseUntil, '2026-11-16T10:05:00.000Z');
  clock += 60_000;
  registry.renew();
  assert.equal(r.store.get(parked.id)?.leaseUntil, '2026-11-16T10:06:00.000Z');
  assert.equal(readFileSync(join(parked.dir, PARKED_FILES.lease), 'utf8').trim(), String(Date.parse('2026-11-16T10:06:00Z') / 1000));
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('only the server that holds a row moves it', () => {
  const r = rig();
  r.store.insert({
    id: 'p1',
    chatId: 'c',
    layout: 1,
    dir: '/nowhere',
    scope: null,
    wrapper: { pid: 1, started: 1 },
    cli: null,
    owner: { pid: 10, started: 5 },
    leaseUntil: '2026-11-16T10:00:00.000Z',
    committedOffset: 100,
    stdinSeq: 0,
    turnOffset: null,
    startedAt: '2026-11-16T09:00:00.000Z',
  });
  const stranger = { pid: 11, started: 5 };
  assert.equal(r.store.commit('p1', stranger, 500), false);
  assert.equal(r.store.renew(stranger, '2026-11-16T11:00:00.000Z'), 0);
  assert.equal(r.store.commit('p1', { pid: 10, started: 5 }, 50), true);
  assert.equal(r.store.get('p1')?.committedOffset, 100, 'the committed offset never goes back');
});

test('a start reaps what a server that is gone left: its CLI is stopped, its row and files removed', async () => {
  const r = rig();
  const before = r.registry();
  const { parked } = launch(before, r.dataDir);
  const cli = await cliOf(parked);
  // As a crashed server leaves it: the row names an owner that no longer runs
  r.sql.prepare('UPDATE cli_processes SET owner_pid = 999999999, owner_started = 1').run();
  const leftover = join(r.dataDir, 'procs', 'feedface');
  mkdirSync(leftover);
  writeFileSync(join(leftover, PARKED_FILES.exitCode), '0\n');
  const closed = once(parked, 'close');
  const reaped = await r.registry().reap();
  assert.deepEqual(reaped.sort(), [parked.id, 'feedface'].sort());
  await until(() => processEntry(cli.pid), (e) => e?.started !== cli.started, 'the CLI to be gone');
  assert.equal(r.store.all().length, 0);
  assert.equal(existsSync(parked.dir), false);
  assert.equal(existsSync(leftover), false);
  await closed;
});

test('a start leaves alone the rows of a server that is still running', async () => {
  const r = rig();
  const { parked } = launch(r.registry(), r.dataDir);
  await cliOf(parked);
  assert.deepEqual(await r.registry().reap(), []);
  assert.equal(r.store.all().length, 1);
  parked.kill('SIGKILL');
  await once(parked, 'close');
});

test('with a user manager, each CLI runs in its own scope, which is gone once the CLI ends', { skip: !hasUserManager() && 'no systemd user manager here' }, async () => {
  const r = rig();
  const { parked } = launch(r.registry({ scopes: true }), r.dataDir);
  assert.ok(parked.scope?.startsWith('claudio-cli-'));
  const cli = await cliOf(parked);
  assert.match(readFileSync(`/proc/${String(cli.pid)}/cgroup`, 'utf8'), new RegExp(`/${(parked.scope as string).replace(/\./g, '\\.')}$`, 'm'));
  const closed = once(parked, 'close');
  const asked = Date.now();
  parked.stdin.end();
  await closed;
  assert.ok(Date.now() - asked < 5000, 'the watchdog\'s nap does not hold the end for a tick');
  // systemd sees the scope empty on its own clock
  await until(() => spawnSync('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', parked.scope as string], { encoding: 'utf8' }).stdout.trim(), (state) => state === 'not-found', 'the scope collected, with no failed unit left behind', 10_000);
});

test('parking is off unless CLAUDIO_PARKED_PROCESSES asks for it, with a five-minute hand-over by default', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'claudio-parked-config-'));
  const base = { CLAUDIO_DATA_DIR: dataDir, CLAUDIO_WORKSPACE_DIR: join(dataDir, 'w'), CLAUDE_CONFIG_DIR: join(dataDir, 'c') };
  assert.equal(loadConfig(base).parked, undefined);
  assert.deepEqual(loadConfig({ ...base, CLAUDIO_PARKED_PROCESSES: '1' }).parked, { handoverSeconds: 300, scopes: true });
  assert.deepEqual(loadConfig({ ...base, CLAUDIO_PARKED_PROCESSES: 'on', CLAUDIO_HANDOVER_SECONDS: '90', CLAUDIO_PARKED_SCOPES: 'off' }).parked, { handoverSeconds: 90, scopes: false });
  assert.throws(() => loadConfig({ ...base, CLAUDIO_PARKED_PROCESSES: '1', CLAUDIO_HANDOVER_SECONDS: '5' }), /CLAUDIO_HANDOVER_SECONDS/);
});

test('with parking on, a chat runs on a parked process: its turns go through the FIFO and the file, and stopping it leaves nothing', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE, parked: { handoverSeconds: 300, scopes: false } };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  try {
    const chat = runs.start({ prompt: 'first', cwd: config.workspaceDir });
    const id = chat.id;
    await until(() => runs.get(id)?.status, (s) => s === 'idle', 'the first turn');
    const parked = runs.parked.held()[0];
    assert.ok(parked instanceof ParkedProcess);
    const pid = runs.get(id)?.pid;
    assert.equal(pid, parked.pid);
    runs.sendMessage(id, 'second');
    await until(() => runs.get(id), (c) => c?.turns === 2 && c.status === 'idle', 'the second turn');
    assert.equal(runs.get(id)?.pid, pid, 'one process for both');
    const row = new CliProcessStore(db.connection).get(parked.id);
    assert.equal(row?.committedOffset, parked.offset, 'committed at the last result');
    const closed = once(parked, 'close');
    runs.stop(id);
    await closed;
    await until(() => runs.get(id)?.status, (s) => s === 'stopped', 'the stop');
    assert.equal(new CliProcessStore(db.connection).all().length, 0);
    assert.equal(existsSync(parked.dir), false);
  } finally {
    await runs.stopAll(500);
    db.close();
  }
});

test('with parking off, a chat still runs on pipes and writes no row', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  try {
    const chat = runs.start({ prompt: 'first', cwd: config.workspaceDir });
    await until(() => runs.get(chat.id)?.status, (s) => s === 'idle', 'the turn');
    assert.equal(runs.parked.held().length, 0);
    assert.equal(new CliProcessStore(db.connection).all().length, 0);
    assert.equal(existsSync(join(config.dataDir, 'procs')), false);
  } finally {
    await runs.stopAll(500);
    db.close();
  }
});

test('a start with parking switched off stops what a gone server left parked mid-turn, and the turn is a cut turn layer 3 continues, not a stray', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE, parked: { handoverSeconds: 300, scopes: false } };
  const db = new Db(config);
  const before = new ChatManager(config, db);
  const chat = before.start({ prompt: 'BASH sleep 600', cwd: config.workspaceDir });
  await until(() => before.get(chat.id)?.activity, (a) => a !== null && a !== undefined, 'the hanging call under way');
  const parked = before.parked.held()[0] as ParkedProcess;
  const cli = await cliOf(parked);
  const closed = once(parked, 'close');
  // The server that started it is gone, as after a crash: its rows name an owner that no longer runs
  db.connection.prepare('UPDATE cli_processes SET owner_pid = 999999999, owner_started = 1').run();
  // With parking on it would be adopted instead (adopt.test.ts)
  const { parked: _on, ...off } = config;
  const after = new ChatManager(off, db);
  const restoring = after.restore(new SessionStore(config));
  assert.deepEqual(after.strays(), [], 'the parked CLI is not taken for a stray');
  await restoring;
  await closed;
  assert.notEqual(processEntry(cli.pid)?.started, cli.started, 'the CLI was stopped');
  assert.equal(new CliProcessStore(db.connection).all().length, 0);
  const cut = after.cutTurns().find((c) => c.chatId === chat.id);
  assert.equal(cut?.continuable, true);
  await before.stopAll(500);
  await after.stopAll(500);
  db.close();
});
