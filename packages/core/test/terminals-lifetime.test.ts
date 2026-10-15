import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Terminal, TerminalServerFrame } from '@claudio/shared';
import { Db } from '../src/db.ts';
import { loadConfig } from '../src/paths.ts';
import { descendantsOf, processEntry, processTable } from '../src/processes.ts';
import { forkedHost, terminalHostLaunch } from '../src/terminals/host-client.ts';
import { loadNodePty } from '../src/terminals/host/pty.ts';
import { TerminalService, type TerminalClient } from '../src/terminals/service.ts';
import { TerminalSettingsStore } from '../src/terminals/settings.ts';
import { TerminalStore } from '../src/terminals/store.ts';

// These run real shells in real PTYs, in a host process of their own: they are skipped where node-pty cannot load
let ptyAvailable = true;
try {
  loadNodePty();
} catch {
  ptyAvailable = false;
}
const real = { skip: ptyAvailable ? false : 'node-pty is not loadable here' };

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const alive = (pid: number): boolean => processEntry(pid) !== null;

async function until(what: string, check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

class Client implements TerminalClient {
  readonly actor = 'local';
  readonly client = 'local';
  readonly origin = null;
  frames: TerminalServerFrame[] = [];
  chunks: Buffer[] = [];
  frame(frame: TerminalServerFrame): void {
    this.frames.push(frame);
  }
  output(data: Buffer): void {
    this.chunks.push(data);
  }
  close(): void {}
  get text(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'claudio-terminal-real-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const config = loadConfig({ CLAUDIO_DATA_DIR: join(root, 'data'), CLAUDIO_WORKSPACE_DIR: join(root, 'ws'), CLAUDE_CONFIG_DIR: join(root, 'claude') });
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config);
  const store = new TerminalStore(db.connection);
  const service = new TerminalService({
    store,
    settings: new TerminalSettingsStore(config, {}),
    lookup: {
      project: async (id) => (id === 'p1' ? { path: project, worktrees: [] } : null),
      chat: async () => null,
    },
    emit: () => undefined,
    host: forkedHost(),
    // An interactive bash with no startup files: job control on, a known prompt
    env: { PATH: process.env.PATH ?? '/usr/bin', HOME: root, SHELL: '/bin/bash', CLAUDIO_CHAT_ID: 'must-not-reach-the-shell' },
    ptyResolvable: () => true,
  });
  const pidOf = (terminal: Terminal): number => (db.connection.prepare('SELECT pid FROM terminal_sessions WHERE id = ?').get(terminal.id) as { pid: number }).pid;
  return { service, db, store, project, root, pidOf };
}

async function open(ctx: ReturnType<typeof setup>) {
  await ctx.service.updateSettings({ enabled: true, loginShell: false });
  const terminal = await ctx.service.create({ projectId: 'p1' }, { actor: 'local', client: 'local' });
  const client = new Client();
  const connection = await ctx.service.attach(terminal.id, client);
  return { terminal, client, connection, pid: ctx.pidOf(terminal) };
}

const spawned: ChildProcess[] = [];
test.after(() => {
  for (const child of spawned) child.kill('SIGKILL');
});

/** What is running below the shell, matched by its command line: a job the person started */
function jobsOf(pid: number, name: string): number[] {
  const table = processTable();
  return descendantsOf(table, pid)
    .filter((p) => p.argv.join(' ').includes(name))
    .map((p) => p.pid);
}

test('a real shell: input in, output out, the size reaches the PTY, and a reattach repaints the screen', real, async () => {
  const ctx = setup();
  const { terminal, client, connection } = await open(ctx);
  connection.resize(97, 31);
  connection.input(Buffer.from('echo $((6*7)); stty size\r'));
  await until('the answer', () => client.text.includes('42') && client.text.includes('31 97'));

  const again = new Client();
  const second = await ctx.service.attach(terminal.id, again);
  const hello = again.frames.find((f) => f.type === 'hello');
  assert.ok(hello && hello.type === 'hello');
  assert.match(hello.snapshot, /42/);
  assert.deepEqual([hello.cols, hello.rows], [97, 31]);
  second.detach();
  await ctx.service.shutdown();
});

test('the shell is a login shell of the project and carries nothing of Claudio or of Claude', real, async () => {
  const ctx = setup();
  process.env.CLAUDIO_TEST_SECRET = 'in the server only';
  try {
    const { client, connection } = await open(ctx);
    connection.input(Buffer.from('pwd; env | grep -c "^CLAUDIO_"; echo TERM=$TERM\r'));
    await until('the output', () => client.text.includes('TERM=xterm-256color'));
    assert.ok(client.text.includes(ctx.project));
    assert.match(client.text, /\r\n0\r\n/);
  } finally {
    delete process.env.CLAUDIO_TEST_SECRET;
  }
  await ctx.service.shutdown();
});

test('closing a terminal ends the shell and a background job it started', real, async () => {
  const ctx = setup();
  const { terminal, connection, pid } = await open(ctx);
  connection.input(Buffer.from('sleep 1000 &\r'));
  await until('the job', () => jobsOf(pid, 'sleep 1000').length === 1);
  const [job] = jobsOf(pid, 'sleep 1000') as [number];
  ctx.service.close(terminal.id);
  await until('the shell and the job to be gone', () => !alive(pid) && !alive(job), 6000);
  assert.equal(ctx.service.get(terminal.id), null, 'a terminal the person closed is no longer listed');
  await ctx.service.shutdown();
});

test('a job that ignores the hangup and SIGTERM is killed after the grace, and an unrelated process lives', real, async () => {
  const canary = spawn('sleep', ['1001'], { stdio: 'ignore' });
  spawned.push(canary);
  const ctx = setup();
  const { terminal, connection, pid } = await open(ctx);
  connection.input(Buffer.from("(trap '' HUP TERM; exec sleep 1002) &\r"));
  await until('the stubborn job', () => jobsOf(pid, 'sleep 1002').length === 1);
  const [job] = jobsOf(pid, 'sleep 1002') as [number];
  ctx.service.close(terminal.id);
  await sleep(1500);
  assert.ok(alive(job), 'it ignored the hangup and the term');
  await until('the kill after the grace', () => !alive(job) && !alive(pid), 6000);
  assert.ok(alive(canary.pid as number), 'a process that is not the shell\'s is left alone');
  await ctx.service.shutdown();
});

test('stopping the server ends every shell', real, async () => {
  const ctx = setup();
  const one = await open(ctx);
  const two = await ctx.service.create({ projectId: 'p1' }, { actor: 'local', client: 'local' });
  const pids = [one.pid, ctx.pidOf(two)];
  await ctx.service.shutdown();
  await until('both shells gone', () => pids.every((pid) => !alive(pid)));
  const rows = ctx.service.history().entries.map((e) => e.endReason);
  assert.deepEqual(rows, ['server-stopping', 'server-stopping']);
});

test('killing the server with SIGKILL leaves no shell behind: the host sees the channel close and ends them', real, async () => {
  const parent = spawn(process.execPath, [...(terminalHostLaunch()?.execArgv ?? []), fileURLToPath(new URL('./fixtures/terminal-parent.mts', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: tmpdir(),
  });
  spawned.push(parent);
  const line = await new Promise<string>((resolve, reject) => {
    let text = '';
    parent.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(text);
    });
    parent.once('exit', () => reject(new Error('the stand-in server exited before opening a shell')));
  });
  const shell = (JSON.parse(line) as { pid: number }).pid;
  const host = processEntry(shell)?.ppid as number;
  assert.ok(host && host !== parent.pid, 'the shell hangs under the host, which hangs under the server');
  assert.equal(processEntry(host)?.ppid, parent.pid);

  process.kill(parent.pid as number, 'SIGKILL');
  await until('the shell and the host to be gone', () => !alive(shell) && !alive(host), 10_000);
});

test('no process the server starts after a terminal opened holds a PTY master, and a shell holds only its own slave', real, async () => {
  const ctx = setup();
  const first = await open(ctx);
  const second = await ctx.service.create({ projectId: 'p1' }, { actor: 'local', client: 'local' });
  const secondPid = ctx.pidOf(second);
  // A shell that has only just forked is still a copy of the host, holding what the host holds, until it
  // execs: look once both have answered
  first.connection.input(Buffer.from('echo ready-1\r'));
  await until('the first shell', () => first.client.text.includes('ready-1'));
  const seen = new Client();
  const conn = await ctx.service.attach(second.id, seen);
  conn.input(Buffer.from('echo ready-2\r'));
  await until('the second shell', () => seen.text.includes('ready-2'));

  // A claude-like child of the server, started after the terminals opened
  const child = spawn('sleep', ['1003'], { stdio: 'ignore' });
  spawned.push(child);
  const targets = (pid: number): string[] =>
    readdirSync(`/proc/${String(pid)}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${String(pid)}/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  const ptyTargets = (pid: number): string[] => targets(pid).filter((t) => t.startsWith('/dev/pts/') || t.includes('ptmx'));
  assert.deepEqual(ptyTargets(child.pid as number), []);

  // The shells: no master (ptmx) at all, and only their own slave
  for (const pid of [first.pid, secondPid]) {
    const held = ptyTargets(pid);
    assert.equal(held.some((t) => t.includes('ptmx')), false, `shell ${String(pid)} holds a master`);
    assert.equal(new Set(held).size, 1, `shell ${String(pid)} holds more than its own slave: ${held.join(', ')}`);
  }
  assert.notEqual(ptyTargets(first.pid)[0], ptyTargets(secondPid)[0]);

  // The host carries no secret of the server's
  process.env.CLAUDIO_TEST_SECRET = 'x';
  const host = processEntry(first.pid)?.ppid as number;
  const environ = readFileSync(`/proc/${String(host)}/environ`, 'utf8').split('\0');
  delete process.env.CLAUDIO_TEST_SECRET;
  assert.deepEqual(environ.filter((entry) => entry.startsWith('CLAUDIO_')), []);
  await ctx.service.shutdown();
});

test('reapStrays ends the tree a previous server left, and leaves a pid the system reused alone', real, async () => {
  const ctx = setup();
  const stray = spawn('sleep', ['1004'], { stdio: 'ignore' });
  const reused = spawn('sleep', ['1005'], { stdio: 'ignore' });
  spawned.push(stray, reused);
  await until('both started', () => alive(stray.pid as number) && alive(reused.pid as number));
  const dead = 4_000_000;
  const row = (id: string, pid: number, started: number, serverPid: number) => {
    ctx.store.startSession({ id, scope: { kind: 'project', projectId: 'p1', worktree: null }, cwd: '/', shell: '/bin/sh', actor: 'local', client: 'local', serverPid, startedAt: new Date().toISOString() });
    ctx.store.setProcess(id, pid, started);
  };
  row('stray', stray.pid as number, processEntry(stray.pid as number)?.started as number, dead);
  // The recorded start time is not this process's: the pid was reused
  row('reused', reused.pid as number, (processEntry(reused.pid as number)?.started as number) + 1, dead);
  // A server that is still alive owns its rows
  row('owned', reused.pid as number, processEntry(reused.pid as number)?.started as number, process.ppid);

  assert.equal(ctx.service.reapStrays(), 1);
  const exited = await new Promise<boolean>((resolve) => {
    if (stray.exitCode !== null || stray.signalCode !== null) resolve(true);
    stray.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 6000).unref();
  });
  assert.ok(exited, 'the stray tree was ended');
  assert.ok(alive(reused.pid as number), 'a reused pid is somebody else\'s');
  const ended = Object.fromEntries(ctx.service.history().entries.map((e) => [e.id, e.endReason]));
  assert.equal(ended.stray, 'server-crashed');
  assert.equal(ended.reused, 'server-crashed');
  assert.equal(ended.owned, null, 'a live server\'s row is not touched');
  await ctx.service.shutdown();
});
