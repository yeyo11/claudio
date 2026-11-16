import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { NODE_RUNNER, attachDecision, daemonLaunch, startDaemon, type LaunchInput, type Runner } from '../src/daemon-launch.ts';
import {
  APPIMAGE_DAEMON_WRAPPER,
  DAEMON_PROTOCOL,
  daemonUnitName,
  parseDaemonRecord,
  parseFromDaemon,
  parseToDaemon,
  readDaemonRecord,
  rebaseLaunch,
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
  assert.ok(args.includes('--property=StartLimitBurst=5'), 'a daemon that cannot start is not restarted for ever');
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

test("the AppImage's daemon runs from a mount of its own, through a wrapper, as Node", () => {
  const plan = daemonLaunch({ ...INPUT, appImage: '/home/someone/Claudio.AppImage' });
  const command = plan.args.slice(plan.args.indexOf('--') + 1);
  assert.deepEqual(command.slice(0, 5), ['/bin/sh', '-c', APPIMAGE_DAEMON_WRAPPER, 'claudio-daemon', '/home/someone/Claudio.AppImage']);
  assert.deepEqual(command.slice(5, 7), ['--data-dir', INPUT.dataDir]);
  const fallback = daemonLaunch({ ...INPUT, userManager: false, appImage: '/home/someone/Claudio.AppImage' });
  assert.equal(fallback.command, '/bin/sh');
  assert.deepEqual(fallback.args.slice(2, 5), ['claudio-daemon', '/home/someone/Claudio.AppImage', '--data-dir']);
});

/** An AppImage stand-in: `--appimage-mount` prints a directory with a `claudio` and holds it until killed */
function fakeAppImage(dir: string): { image: string; mount: string; log: string } {
  const mount = join(dir, 'mnt');
  const log = join(dir, 'log');
  mkdirSync(join(mount, 'resources', 'daemon'), { recursive: true });
  // The "binary" records how it was run, then lives until it is told to stop
  writeFileSync(
    join(mount, 'claudio'),
    `#!/bin/sh\necho "run $ELECTRON_RUN_AS_NODE $APPDIR $*" >> ${JSON.stringify(log)}\ntrap 'echo "daemon got TERM" >> ${JSON.stringify(log)}; exit 0' TERM\nwhile :; do sleep 0.05; done\n`,
  );
  chmodSync(join(mount, 'claudio'), 0o755);
  const image = join(dir, 'Claudio.AppImage');
  writeFileSync(
    image,
    `#!/bin/sh\n[ "$1" = --appimage-mount ] || exit 9\necho ${JSON.stringify(mount)}\ntrap 'echo "mount let go" >> ${JSON.stringify(log)}; exit 0' TERM\nwhile :; do sleep 0.05; done\n`,
  );
  chmodSync(image, 0o755);
  return { image, mount, log };
}

test('the wrapper runs the mount\'s binary as Node on the daemon entry, passes a stop on, and lets the mount go after', async () => {
  const dir = scratch();
  const fake = fakeAppImage(dir);
  const plan = daemonLaunch({ ...INPUT, userManager: false, appImage: fake.image, dataDir: join(dir, 'data'), logsDir: join(dir, 'logs') });
  const child = spawn(plan.command, plan.args, { env: { PATH: process.env.PATH ?? '' }, stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (!(existsSync(fake.log) && readFileSync(fake.log, 'utf8').includes('run '))) {
    if (Date.now() > deadline) throw new Error('the daemon did not start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(readFileSync(fake.log, 'utf8'), new RegExp(`^run 1 ${fake.mount} ${fake.mount}/resources/daemon/daemon\\.cjs --data-dir ${join(dir, 'data')}`, 'm'));
  child.kill('SIGTERM');
  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 0, "the daemon's own code");
  const lines = readFileSync(fake.log, 'utf8').trim().split('\n');
  assert.deepEqual(lines.slice(1), ['daemon got TERM', 'mount let go'], 'the daemon is stopped first, then the mount it runs from');
});

test('an AppImage that does not mount ends the wrapper with an error instead of hanging', async () => {
  const dir = scratch();
  const image = join(dir, 'broken.AppImage');
  writeFileSync(image, '#!/bin/sh\nexit 3\n');
  chmodSync(image, 0o755);
  const plan = daemonLaunch({ ...INPUT, userManager: false, appImage: image, logsDir: join(dir, 'logs') });
  const child = spawn(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 1);
  assert.match(stderr, /did not mount/);
});

test("what the daemon says before its own log opens is kept, under a unit and under setsid", () => {
  const output = '/home/someone/.config/Claudio/logs/daemon.out.log';
  assert.equal(daemonLaunch(INPUT).output, output);
  assert.ok(daemonLaunch(INPUT).args.includes(`--property=StandardError=append:${output}`));
  assert.equal(daemonLaunch({ ...INPUT, userManager: false }).output, output);
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

test("an AppImage daemon moves the window's mount paths onto its own mount, and leaves the rest", () => {
  const win = '/tmp/.mount_ClaudiWINDOW';
  const own = '/tmp/.mount_ClaudiDAEMON';
  const launch = {
    env: { APPDIR: win, LD_LIBRARY_PATH: `${win}/usr/lib:/usr/lib`, HOME: '/home/someone' },
    PATH: `${win}:/usr/bin`,
    secretKey: 'k',
    userData: '/home/someone/.config/Claudio',
    dataDir: '/home/someone/.config/Claudio/data',
    workspaceDir: '/home/someone/Claudio',
    logsDir: '/home/someone/.config/Claudio/logs',
    bundledDir: `${win}/resources/server`,
    bundledWeb: `${win}/resources/web`,
    guardEntry: `${win}/resources/server/guard.mjs`,
    keysDir: `${win}/resources/keys`,
    shellJson: `${win}/resources/shell.json`,
    version: '0.19.0',
    distribution: 'appimage',
    aptManaged: false,
    ignoreOverlays: false,
  };
  const moved = rebaseLaunch(launch, own);
  assert.equal(moved.bundledDir, `${own}/resources/server`);
  assert.equal(moved.bundledWeb, `${own}/resources/web`);
  assert.equal(moved.guardEntry, `${own}/resources/server/guard.mjs`);
  assert.equal(moved.keysDir, `${own}/resources/keys`);
  assert.equal(moved.shellJson, `${own}/resources/shell.json`);
  assert.equal(moved.env.APPDIR, own);
  assert.equal(moved.env.LD_LIBRARY_PATH, `${own}/usr/lib:/usr/lib`);
  assert.equal(moved.PATH, `${own}:/usr/bin`);
  assert.equal(moved.dataDir, launch.dataDir, 'the data stays where it is');
  const deb = { ...launch, env: { HOME: '/h' } };
  assert.equal(rebaseLaunch(deb, own), deb, 'a window not in an AppImage is left as it is');
});
