import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudioChildren, cliProcessOf, cliSessionRecords, commandRoots, descendantsOf, forgetProcessTable, processTable, recentProcessTable, terminateTree, type ProcessEntry } from '../src/processes.ts';

// Cancelling a command kills a process tree, so what is under test is that it is exactly that tree:
// found from the process table by parentage and start time, and nothing else on the machine.

const entry = (pid: number, ppid: number, argv: string[] = []): ProcessEntry => ({ pid, ppid, started: 0, argv });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};
/** A command the way the CLI runs one: a shell with its own child, which has to die with it. */
const shellWithChild = (): ChildProcess => spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' });

test('the descendants of a process are every process under it, deepest first, and nothing beside it', () => {
  const table = [entry(1, 0), entry(10, 1), entry(11, 10), entry(12, 11), entry(20, 1), entry(21, 20)];
  assert.deepEqual(descendantsOf(table, 10).map((p) => p.pid), [12, 11]);
  assert.deepEqual(descendantsOf(table, 1).map((p) => p.pid).sort((a, b) => a - b), [10, 11, 12, 20, 21]);
  assert.deepEqual(descendantsOf(table, 12), []);
  // A cycle in a corrupt table ends the walk instead of never returning
  assert.deepEqual(descendantsOf([entry(1, 2), entry(2, 1)], 1).map((p) => p.pid), [2]);
});

test('the CLI is found under a wrapper by what it drives, not by its name', () => {
  const table = [
    entry(100, 1, ['wrapper', 'chat', 'work', '--']),
    entry(101, 100, ['claude', '--input-format', 'stream-json', '--session-id', 'abc']),
    entry(102, 101, ['bash', '-c', 'pnpm e2e']),
  ];
  assert.equal(cliProcessOf(table, 100, 'abc')?.pid, 101);
  // Started directly, the spawned process is the CLI
  assert.equal(cliProcessOf([entry(200, 1, ['claude', '--input-format', 'stream-json', '--resume', 'abc'])], 200, 'abc')?.pid, 200);
  assert.equal(cliProcessOf([], 200, 'abc'), null);
});

test('two commands running at once each get their own process, in the order they were called', async () => {
  // Each command is called before its process starts, as the CLI's are. Read after `spawn` returned,
  // the time could be well past the fork: on a loaded machine the call blocks until the exec, and
  // that took over 80 ms under the parallel suite, more than the tolerance
  const t1 = Date.now();
  const first = shellWithChild();
  await new Promise((r) => setTimeout(r, 120));
  const t2 = Date.now();
  const second = shellWithChild();
  try {
    assert.ok(first.pid && second.pid);
    await until(() => processTable().some((p) => p.pid === second.pid));
    // This process stands in for the CLI, but it has children of its own (tsx's esbuild service,
    // started moments before the first test), and one inside the window would take the first slot
    const ours = new Set([first.pid, second.pid]);
    const table = processTable().filter((p) => p.ppid !== process.pid || ours.has(p.pid));
    const { roots } = commandRoots(table, process.pid, [t1, t2], 50);
    assert.equal(roots[0]?.pid, first.pid);
    assert.equal(roots[1]?.pid, second.pid);
    // A command called after every process started has none of its own yet
    assert.equal(commandRoots(table, process.pid, [Date.now() + 60_000], 50).roots[0], null);
    // Not a child of that CLI: not a command of it
    assert.equal(commandRoots(table, 1, [t1], 50).roots.every((r) => r?.pid !== first.pid), true);
  } finally {
    first.kill('SIGKILL');
    second.kill('SIGKILL');
  }
});

test('cancelling a command takes its shell and everything it started, and leaves the rest running', async () => {
  const doomed = shellWithChild();
  const bystander = shellWithChild();
  try {
    assert.ok(doomed.pid && bystander.pid);
    await until(() => descendantsOf(processTable(), doomed.pid as number).length > 0);
    const table = processTable();
    const root = table.find((p) => p.pid === doomed.pid);
    assert.ok(root);
    const grandchildren = descendantsOf(table, root.pid).map((p) => p.pid);
    assert.ok(grandchildren.length >= 1, 'the shell started something of its own');

    const signalled = terminateTree(root, table, 200);
    assert.equal(signalled, 1 + grandchildren.length);
    assert.ok(await until(() => ![root.pid, ...grandchildren].some(alive)), 'the whole tree is gone');
    assert.equal(alive(bystander.pid), true, 'a sibling command is untouched');
  } finally {
    doomed.kill('SIGKILL');
    bystander.kill('SIGKILL');
  }
});

test('a process that ignores SIGTERM is killed after the grace period', async () => {
  const stubborn = spawn('sh', ['-c', "trap '' TERM; sleep 60 & wait"], { stdio: 'ignore' });
  try {
    assert.ok(stubborn.pid);
    await until(() => descendantsOf(processTable(), stubborn.pid as number).length > 0);
    const table = processTable();
    const root = table.find((p) => p.pid === stubborn.pid);
    assert.ok(root);
    terminateTree(root, table, 300);
    assert.ok(await until(() => !alive(root.pid), 4000), 'SIGKILL followed');
  } finally {
    stubborn.kill('SIGKILL');
  }
});

test('claudioChildren finds a process by the chat id in its environment, and no other', { skip: process.platform !== 'linux' }, () => {
  const idle = ['-e', 'setInterval(() => {}, 1000)'];
  const mine = spawn(process.execPath, idle, { env: { ...process.env, CLAUDIO_CHAT_ID: 'chat-under-test' }, stdio: 'ignore' });
  const stranger = spawn(process.execPath, idle, { env: { ...process.env, CLAUDIO_CHAT_ID: '' }, stdio: 'ignore' });
  try {
    const found = claudioChildren();
    const own = found.find((p) => p.pid === mine.pid);
    assert.equal(own?.chatId, 'chat-under-test');
    assert.ok(own?.argv.includes('-e'));
    assert.equal(found.some((p) => p.pid === stranger.pid), false);
  } finally {
    mine.kill();
    stranger.kill();
  }
});

test('recentProcessTable reads the table once per window, and again after it or after being forgotten', () => {
  forgetProcessTable();
  let reads = 0;
  const read = (): ProcessEntry[] => {
    reads += 1;
    return [{ pid: reads, ppid: 1, started: 1, argv: [] }];
  };
  assert.equal(recentProcessTable(read, 10_000)[0]?.pid, 1);
  assert.equal(recentProcessTable(read, 11_500)[0]?.pid, 1, 'inside the window it is the same reading');
  assert.equal(reads, 1);
  assert.equal(recentProcessTable(read, 12_100)[0]?.pid, 2, 'past two seconds it is read again');
  assert.equal(recentProcessTable(read, 5_000)[0]?.pid, 3, 'a clock that went back does not serve a reading from the future');
  forgetProcessTable();
  recentProcessTable(read, 5_001);
  assert.equal(reads, 4);
  forgetProcessTable();
});

// ---------- the CLI's own records of its processes ----------

test("the CLI's sessions are read from the record each process keeps, kept only while that process still runs", { skip: !(existsSync('/proc/self/stat') && existsSync('/etc/machine-id')) && 'only where /proc and a machine id name the processes' }, async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'claudio-cli-records-'));
  try {
    assert.equal(await cliSessionRecords(configDir), null, 'a CLI that keeps no records is asked instead');
    const sessions = join(configDir, 'sessions');
    mkdirSync(sessions);
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const domain = `linux:${readFileSync('/etc/machine-id', 'utf8').trim()}:${readlinkSync('/proc/self/ns/pid')}`;
    const record = (pid: number, over: object = {}) => ({ pid, sessionId: `s-${String(pid)}`, cwd: '/work', kind: 'interactive', status: 'busy', startedAt: 1, name: 'n', procStart, pidDomain: domain, ...over });
    const write = (name: string, body: object | string) => writeFileSync(join(sessions, name), typeof body === 'string' ? body : JSON.stringify(body));
    write(`${String(process.pid)}.json`, record(process.pid));
    // The same pid, but the process that wrote it is gone and the pid was reused
    write('1.json', record(1, { procStart: '999999999999' }));
    // A pid nothing runs
    write('4194303.json', record(4194303));
    // Written in another pid namespace: not a pid of ours to check
    write(`${String(process.ppid)}.json`, record(process.ppid, { pidDomain: 'linux:other:pid:[1]' }));
    write('7.json', '{"half');
    write(`${String(process.pid)}.other.key`, 'not a record');
    assert.deepEqual(await cliSessionRecords(configDir), [{ pid: process.pid, sessionId: `s-${String(process.pid)}`, cwd: '/work', kind: 'interactive', status: 'busy', startedAt: 1, name: 'n' }]);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
