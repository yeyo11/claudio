// Preloaded into every test process by scripts/test-tmp.mjs (NODE_OPTIONS=--import). Tests make their
// scratch dirs with mkdtemp(tmpdir()) and most never remove them; this removes each one when the
// process that made it exits, so a suite's dirs do not pile up while it runs the next file.
// What it cannot remove (a process killed outright) is left for the wrapper's guard to report.
import fs, { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';

const root = resolve(tmpdir()) + sep;

// A test run from a chat Claudio started inherits that chat's account: CLAUDE_CONFIG_DIR is the
// account's real dir, CLAUDIO_DATA_DIR and CLAUDIO_WORKSPACE_DIR are the server's. A test that
// builds a store or a child environment from process.env then reaches the owner's real data: the
// unit tests' fake CLI signed in and counted its probes in two real account dirs (2026-10-19 and
// 2026-11-07, docs/reports/test-writes-real-dirs.md). A directory selector outside this run's tmp
// is dropped, and a test that wants one sets it to a dir of its own, which stays. NODE_OPTIONS
// carries this to the processes a test spawns, so the rule holds there too.
for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDIO_DATA_DIR', 'CLAUDIO_WORKSPACE_DIR']) {
  const value = process.env[name];
  if (value !== undefined && !(resolve(value) + sep).startsWith(root)) delete process.env[name];
}

const made = new Set();
const track = (dir) => {
  if (typeof dir === 'string' && resolve(dir).startsWith(root)) made.add(resolve(dir));
  return dir;
};

const sync = fs.mkdtempSync;
fs.mkdtempSync = (...args) => track(sync(...args));
const callback = fs.mkdtemp;
fs.mkdtemp = (prefix, ...rest) => {
  const done = rest.pop();
  return callback(prefix, ...rest, (err, dir) => {
    if (!err) track(dir);
    done(err, dir);
  });
};
const promise = fs.promises.mkdtemp;
fs.promises.mkdtemp = async (...args) => track(await promise(...args));
syncBuiltinESMExports();

// Worktrees of a repository are made next to it, as <repo>-<branch>
const siblings = (dir) => {
  try {
    return fs.readdirSync(dirname(dir)).filter((name) => name.startsWith(`${basename(dir)}-`)).map((name) => resolve(dirname(dir), name));
  } catch {
    return [];
  }
};

const clean = () => {
  for (const dir of [...made].flatMap((one) => [one, ...siblings(one)])) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left behind, the wrapper's guard names it
    }
  }
};

process.on('exit', clean);
// A runner that ends a file's process with a signal never reaches 'exit'. NODE_OPTIONS reaches the
// processes a test spawns too, and one with a handler of its own (a server that shuts down on
// SIGTERM) must keep its exit code, so this only ends the process when nobody else listens.
for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2]]) {
  process.on(signal, () => {
    clean();
    if (process.listenerCount(signal) === 1) process.exit(128 + number);
  });
}
