import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

/*
 * The server and the launcher keep going through an error nothing caught (regression audit
 * 2026-10-29, §2.1: on 10-25 one throw out of a stream handler took the server down). Run in a child
 * process of its own: the guards are process-wide, and this test's process must keep Node's default.
 */

const GUARDS = pathToFileURL(fileURLToPath(new URL('../src/launcher/process-guards.ts', import.meta.url))).href;

test('an unhandled rejection and an uncaught exception are logged, and the process goes on', () => {
  const script = `
    import { installProcessGuards } from ${JSON.stringify(GUARDS)};
    installProcessGuards((line) => process.stdout.write('LOG ' + line.split('\\n')[0] + '\\n'));
    void Promise.reject(new Error('a rejection nobody awaited'));
    setTimeout(() => { throw new Error('a throw out of a handler'); }, 10);
    setTimeout(() => { process.stdout.write('still alive\\n'); process.exit(0); }, 200);
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /LOG unhandled promise rejection, the process goes on: Error: a rejection nobody awaited/);
  assert.match(run.stdout, /LOG uncaught exception, the process goes on: Error: a throw out of a handler/);
  assert.match(run.stdout, /still alive/);
});

test('uninstalled, the guards leave Node\'s default: an uncaught exception ends the process', () => {
  const script = `
    import { installProcessGuards } from ${JSON.stringify(GUARDS)};
    const release = installProcessGuards(() => {});
    release();
    setTimeout(() => { throw new Error('nobody catches this'); }, 10);
    setTimeout(() => { process.stdout.write('still alive\\n'); }, 200);
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /still alive/);
});
