import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { NODE_RUNNER, attachDecision, daemonLaunch, startDaemon, type LaunchInput, type Runner } from '../src/daemon-launch.ts';
import {
  DAEMON_FLAG,
  DAEMON_PROTOCOL,
  daemonUnitName,
  parseDaemonRecord,
  parseFromDaemon,
  parseToDaemon,
  readDaemonRecord,
  recordAlive,
  removeDaemonRecord,
  writeDaemonRecord,
  type DaemonRecord,
} from '../src/daemon-protocol.ts';

// How a window finds its daemon or starts one (D2 of docs/plans/survive-restarts.md), with a fake
// systemd-run and fake runners: no unit is ever created here.

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-launch-'));
  roots.push(dir);
  return dir;
};

const INPUT: LaunchInput = {
  userManager: true,
  unit: 'claudio-daemon-0123456789ab.service',
  execPath: '/opt/Claudio/claudio',
  daemonEntry: '/opt/Claudio/resources/daemon.cjs',
  dataDir: '/home/someone/.config/Claudio/data',
  logsDir: '/home/someone/.config/Claudio/logs',
  env: { HOME: '/home/someone', CLAUDIO_SECRET_KEY: 'never-on-a-command-line' },
};

const record = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  protocol: DAEMON_PROTOCOL,
  pid: 4242,
  started: 99,
  version: '0.19.0',
  followsShell: true,
  unit: INPUT.unit,
  socket: '/tmp/daemon.sock',
  url: null,
  token: 'secret',
  ...over,
});

test('with a user manager the daemon starts in a transient unit that restarts it, keeps its scopes, and runs Electron as Node', () => {
  const plan = daemonLaunch(INPUT);
  assert.equal(plan.command, 'systemd-run');
  assert.equal(plan.detached, false);
  const args = plan.args;
  assert.ok(args.includes('--user'));
  assert.ok(args.includes(`--unit=${INPUT.unit}`));
  assert.ok(args.includes('--property=Restart=on-failure'));
  // SIGTERM to the daemon alone: parked CLIs sit in scopes of their own (#79569)
  assert.ok(args.includes('--property=KillMode=mixed'));
  assert.ok(args.includes('--setenv=ELECTRON_RUN_AS_NODE=1'));
  assert.ok(args.includes('--description=Claudio server supervisor'), 'the description is one argument, spaces and all');
  const command = args.slice(args.indexOf('--') + 1);
  assert.deepEqual(command, [INPUT.execPath, INPUT.daemonEntry, '--data-dir', INPUT.dataDir, '--logs', INPUT.logsDir, '--unit', INPUT.unit]);
  assert.ok(!args.join(' ').includes('never-on-a-command-line'), 'secrets travel over the socket, never in the unit');
});

test('without a user manager the daemon starts under setsid, in its own session', () => {
  const plan = daemonLaunch({ ...INPUT, userManager: false });
  assert.equal(plan.command, INPUT.execPath);
  assert.equal(plan.detached, true);
  assert.deepEqual(plan.args, [INPUT.daemonEntry, '--data-dir', INPUT.dataDir, '--logs', INPUT.logsDir]);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, '1');
});

test("the AppImage's daemon is the AppImage itself with the flag, so its mount lives as long as the daemon", () => {
  const plan = daemonLaunch({ ...INPUT, appImage: '/home/someone/Claudio.AppImage' });
  const command = plan.args.slice(plan.args.indexOf('--') + 1);
  assert.deepEqual(command.slice(0, 2), ['/home/someone/Claudio.AppImage', DAEMON_FLAG]);
  assert.ok(!plan.args.some((a) => a.startsWith('--setenv=ELECTRON_RUN_AS_NODE')));
  const fallback = daemonLaunch({ ...INPUT, userManager: false, appImage: '/home/someone/Claudio.AppImage' });
  assert.equal(fallback.command, '/home/someone/Claudio.AppImage');
  assert.equal(fallback.args[0], DAEMON_FLAG);
});

test('each argument reaches systemd-run whole, the description with its spaces included', async () => {
  const dir = scratch();
  const out = join(dir, 'argv.json');
  const fake = join(dir, 'systemd-run');
  writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(fake, 0o755);
  const plan = daemonLaunch(INPUT);
  const result = await NODE_RUNNER.run(fake, plan.args, { ...process.env });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), plan.args);
});

function fakeRunner(codes: number[]): Runner & { runs: string[][]; detached: string[][] } {
  const runs: string[][] = [];
  const detached: string[][] = [];
  return {
    runs,
    detached,
    run: (command, args) => {
      runs.push([command, ...args]);
      const code = command === 'systemd-run' ? (codes.shift() ?? 0) : 0;
      return Promise.resolve({ code, stderr: code ? 'Unit already exists' : '' });
    },
    detach: (command, args) => void detached.push([command, ...args]),
  };
}

test('a unit systemd accepts is how the daemon runs', async () => {
  const runner = fakeRunner([0]);
  assert.equal(await startDaemon(INPUT, runner, () => undefined), 'unit');
  assert.equal(runner.runs.length, 1);
  assert.equal(runner.detached.length, 0);
});

test('a unit left failed by its own restarts is reset and tried once more', async () => {
  const runner = fakeRunner([1, 0]);
  const logs: string[] = [];
  assert.equal(await startDaemon(INPUT, runner, (l) => logs.push(l)), 'unit');
  assert.deepEqual(runner.runs[1], ['systemctl', '--user', 'reset-failed', INPUT.unit]);
  assert.equal(runner.runs.length, 3);
  assert.match(logs[0] ?? '', /Unit already exists/);
});

test('a manager that refuses twice gets the setsid start instead', async () => {
  const runner = fakeRunner([1, 1]);
  assert.equal(await startDaemon(INPUT, runner, () => undefined), 'setsid');
  assert.deepEqual(runner.detached[0], [INPUT.execPath, INPUT.daemonEntry, '--data-dir', INPUT.dataDir, '--logs', INPUT.logsDir]);
});

test('no user manager: setsid at once, systemd never asked', async () => {
  const runner = fakeRunner([]);
  assert.equal(await startDaemon({ ...INPUT, userManager: false }, runner, () => undefined), 'setsid');
  assert.equal(runner.runs.length, 0);
});

test('a window starts a daemon when none is recorded or the recorded one is gone, and attaches to a live one', () => {
  const alive = (pid: number) => (pid === 4242 ? 99 : null);
  assert.equal(recordAlive(record(), alive), true);
  assert.equal(recordAlive(record({ pid: 5151 }), alive), false, 'that pid is gone: start one');
  assert.equal(recordAlive(record({ started: 100 }), alive), false, 'the pid was reused by another process: start one');
  assert.equal(attachDecision({ ...record(), boot: null }, { protocol: DAEMON_PROTOCOL, version: '0.19.0' }), 'attach');
  assert.equal(attachDecision({ ...record(), boot: null }, { protocol: DAEMON_PROTOCOL, version: '0.20.0' }), 'attach', 'a daemon that follows the shell needs no restart');
});

test('a daemon of another protocol, or an AppImage daemon of another version, is replaced', () => {
  assert.equal(attachDecision({ ...record({ protocol: DAEMON_PROTOCOL + 1 }), boot: null }, { protocol: DAEMON_PROTOCOL, version: '0.19.0' }), 'replace');
  assert.equal(attachDecision({ ...record({ followsShell: false, version: '0.18.0' }), boot: null }, { protocol: DAEMON_PROTOCOL, version: '0.19.0' }), 'replace');
  assert.equal(attachDecision({ ...record({ followsShell: false }), boot: null }, { protocol: DAEMON_PROTOCOL, version: '0.19.0' }), 'attach');
});

test('a daemon still serving an older bundled payload than the shell restarts its server onto the new files', () => {
  const state = { ...record(), boot: { version: '0.18.0', bundled: true, trial: false } };
  assert.equal(attachDecision(state, { protocol: DAEMON_PROTOCOL, version: '0.19.0' }), 'restart-server');
  assert.equal(attachDecision({ ...state, boot: { version: '0.18.0', bundled: false, trial: false } }, { protocol: DAEMON_PROTOCOL, version: '0.19.0' }), 'attach', 'an overlay is newer than any bundle it replaced');
});

test('daemon.json is written owner-only and whole, read back checked, and removed only by its writer', () => {
  const dir = scratch();
  writeDaemonRecord(dir, record());
  assert.equal(statSync(join(dir, 'daemon.json')).mode & 0o777, 0o600);
  assert.deepEqual(readDaemonRecord(dir), record());
  removeDaemonRecord(dir, 1);
  assert.ok(readDaemonRecord(dir), "another daemon's record is never taken away");
  removeDaemonRecord(dir, 4242);
  assert.equal(readDaemonRecord(dir), null);
  writeFileSync(join(dir, 'daemon.json'), '{"protocol":1}');
  assert.equal(readDaemonRecord(dir), null, 'a partial record is no daemon');
  assert.equal(parseDaemonRecord({ ...record(), token: '' }), null);
});

test('one unit name per data directory, so the installed app and a dev build never share one', () => {
  assert.equal(daemonUnitName('/a/data'), daemonUnitName('/a/data'));
  assert.notEqual(daemonUnitName('/a/data'), daemonUnitName('/b/data'));
  assert.match(daemonUnitName('/a/data'), /^claudio-daemon-[0-9a-f]{12}\.service$/);
});

test('messages are checked, not trusted, on both sides of the socket', () => {
  assert.deepEqual(parseToDaemon('{"type":"stop","work":"stop-work"}'), { type: 'stop', work: 'stop-work' });
  assert.equal(parseToDaemon('{"type":"stop","work":"everything"}'), null);
  assert.equal(parseToDaemon('{"type":"hello","protocol":1,"version":"0.19.0","launch":{}}'), null);
  assert.equal(parseToDaemon('not json'), null);
  assert.deepEqual(parseFromDaemon('{"type":"relaunch-window"}'), { type: 'relaunch-window' });
  assert.equal(parseFromDaemon('{"type":"state","state":{"phase":"dancing"}}'), null);
});
