import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireDataDirLock, DATA_DIR_LOCK_FILE, DataDirLockedError, readDataDirLock, SYSTEM_PROBE, type LockProbe } from '../src/data-dir-lock.ts';

const LOCK_MODULE = fileURLToPath(new URL('../src/data-dir-lock.ts', import.meta.url));

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A pid that ran and is gone */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

/** Another process holding the lock of `dir` until it is killed */
async function holder(t: TestContext, dir: string): Promise<{ pid: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', `const m = await import(${JSON.stringify(LOCK_MODULE)}); m.acquireDataDirLock(${JSON.stringify(dir)}); console.log('held'); setInterval(() => {}, 1000);`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(() => {
    child.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`the holder exited with ${String(code)}`)));
  });
  return {
    pid: child.pid ?? 0,
    kill: async () => {
      // A crash: no exit handler runs, the lock file stays behind
      child.kill('SIGKILL');
      await exited;
    },
  };
}

test('a second server on a data directory a live one holds is refused, naming the directory and the pid, and touches nothing', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'state.json'), '{"keep":true}\n');
  const other = await holder(t, dir);
  const before = readdirSync(dir).sort();
  assert.throws(
    () => acquireDataDirLock(dir),
    (error: unknown) => {
      assert.ok(error instanceof DataDirLockedError);
      assert.equal(error.holder?.pid, other.pid);
      assert.match(error.message, new RegExp(`data directory ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(error.message, new RegExp(`pid ${String(other.pid)}`));
      assert.match(error.message, /CLAUDIO_DATA_DIR and PORT/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(readDataDirLock(dir)?.pid, other.pid);

  // The holder crashes: its lock stays, and the next server finds it stale and takes it
  await other.kill();
  assert.ok(existsSync(join(dir, DATA_DIR_LOCK_FILE)));
  const lock = acquireDataDirLock(dir);
  t.after(() => lock.release());
  assert.equal(readDataDirLock(dir)?.pid, process.pid);
  assert.equal(readDataDirLock(dir)?.id, lock.id);
});

test('a second server in the same process is refused too, and the lock is free again once released', (t) => {
  const dir = tempDir(t);
  const lock = acquireDataDirLock(dir);
  assert.throws(() => acquireDataDirLock(dir), DataDirLockedError);
  lock.release();
  assert.ok(!existsSync(join(dir, DATA_DIR_LOCK_FILE)));
  const again = acquireDataDirLock(dir);
  again.release();
  // Idempotent, and never removes a lock that is not its own
  writeFileSync(join(dir, DATA_DIR_LOCK_FILE), JSON.stringify({ id: 'someone-else', pid: 1, hostname: hostname(), at: 'now' }));
  lock.release();
  again.release();
  assert.ok(existsSync(join(dir, DATA_DIR_LOCK_FILE)));
});

test('a lock left by a process that is gone is stale, and so is one whose pid now belongs to a younger process', (t) => {
  const dir = tempDir(t);
  const file = join(dir, DATA_DIR_LOCK_FILE);
  writeFileSync(file, JSON.stringify({ id: 'crashed', pid: deadPid(), hostname: hostname(), started: null, boot: null, at: 'before' }));
  acquireDataDirLock(dir).release();

  // The pid is alive, but the process with it started later than the one that wrote the lock
  const reused: LockProbe = { ...SYSTEM_PROBE, pid: 4242, alive: () => true, startTime: (pid) => (pid === 777 ? 9000 : 100), boot: () => 'boot-1' };
  writeFileSync(file, JSON.stringify({ id: 'old', pid: 777, hostname: SYSTEM_PROBE.hostname, started: 500, boot: 'boot-1', at: 'before' }));
  acquireDataDirLock(dir, reused).release();

  // The same pid and start time: that process still runs, and holds it
  writeFileSync(file, JSON.stringify({ id: 'live', pid: 777, hostname: SYSTEM_PROBE.hostname, started: 9000, boot: 'boot-1', at: 'before' }));
  assert.throws(() => acquireDataDirLock(dir, reused), DataDirLockedError);

  // Written before the machine last booted: whatever has that pid now is not its writer
  writeFileSync(file, JSON.stringify({ id: 'live', pid: 777, hostname: SYSTEM_PROBE.hostname, started: 9000, boot: 'boot-0', at: 'before' }));
  acquireDataDirLock(dir, reused).release();
});

test('a lock file that cannot be read is a server writing it while young, and stale once old', (t) => {
  const dir = tempDir(t);
  const file = join(dir, DATA_DIR_LOCK_FILE);
  writeFileSync(file, '');
  assert.throws(() => acquireDataDirLock(dir), DataDirLockedError);
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  acquireDataDirLock(dir).release();
});
