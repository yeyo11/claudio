// Preloaded into every test process by scripts/test-tmp.mjs (NODE_OPTIONS=--import). Tests make their
// scratch dirs with mkdtemp(tmpdir()) and most never remove them; this removes each one when the
// process that made it exits, so a suite's dirs do not pile up while it runs the next file.
// What it cannot remove (a process killed outright) is left for the wrapper's guard to report.
import fs, { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';

const root = resolve(tmpdir()) + sep;
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
