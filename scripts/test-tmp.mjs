#!/usr/bin/env node
// Runs a test command with TMPDIR pointed at a directory of its own, and removes that directory when
// the command ends, however it ends. Tests create their scratch dirs with mkdtemp(tmpdir()), and many
// never remove them: a few orchestrations' verifications left ~21,000 dirs (9.6 GB) in /tmp in three
// hours, filled the tmpfs and broke the runs themselves. One directory per run also keeps two runs
// at once (several orchestrations) from sharing scratch space.
//
// The caches tools keep under the system temp dir (tsx's transform cache, Node's compile cache) are
// linked into the run's directory, so moving TMPDIR does not throw them away on every run.
//
//   node scripts/test-tmp.mjs <command> [args...]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { constants, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/test-tmp.mjs <command> [args...]');
  process.exit(2);
}

const system = tmpdir();
const run = mkdtempSync(join(system, 'claudio-run-'));
for (const cache of [`tsx-${userInfo().uid}`, 'node-compile-cache']) {
  const shared = join(system, cache);
  try {
    mkdirSync(shared, { recursive: true });
    symlinkSync(shared, join(run, cache), 'dir');
  } catch {
    // A cache that cannot be shared is only rebuilt in the run's dir: slower, never wrong
  }
}

// A test that makes a claudio-* directory and does not remove it is a leak: it only stays out of the
// system tmp because this wrapper isolates it. Say so, and fail under CI so it cannot come back.
let leaked = [];
const findLeaks = () => {
  try {
    leaked = readdirSync(run).filter((name) => name.startsWith('claudio-'));
  } catch {
    leaked = [];
  }
  if (leaked.length === 0) return;
  const ci = Boolean(process.env.CI);
  console.error(`${ci ? 'error' : 'warning'}: ${leaked.length} test director${leaked.length === 1 ? 'y' : 'ies'} left in the run's tmp (remove it in the test, with after()):`);
  for (const name of leaked.slice(0, 30)) console.error(`  ${name}`);
  if (leaked.length > 30) console.error(`  ... and ${leaked.length - 30} more`);
  if (!ci) leaked = [];
};

let cleaned = false;
const clean = () => {
  if (cleaned) return;
  cleaned = true;
  findLeaks();
  // rmSync does not follow the cache symlinks: it removes the links, not the shared caches
  rmSync(run, { recursive: true, force: true });
};

const preload = join(dirname(fileURLToPath(import.meta.url)), 'test-tmp-preload.mjs');
const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: run, TMP: run, TEMP: run, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim() } });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on('error', (err) => {
  console.error(err.message);
  clean();
  process.exit(127);
});
child.on('exit', (code, signal) => {
  clean();
  // 128 + the signal's number, as a shell reports a command a signal ended
  const status = signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1);
  process.exit(status === 0 && leaked.length > 0 ? 1 : status);
});
