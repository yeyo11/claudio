import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopUpdateStatus, LiveWork } from '@claudio/shared';
import { EventBus } from '../src/events.ts';
import { RELAUNCH_EXIT_CODE, RESTART_EXIT_CODE } from '../src/launcher/protocol.ts';
import { DesktopUpdateRefusal, DesktopUpdates, UPDATE_STATUS_FILE, parseUnitStatus, startRefusal, type CommandResult } from '../src/updates/desktop-update.ts';

// docs/plans/remote-updates.md, D3 and D4: the unit is started and read through an injected runner,
// so nothing here ever reaches the real systemctl, polkit or apt

const SHELL_JSON = '/opt/Claudio/resources/shell.json';
const IDLE: LiveWork = { working: 0, waiting: 0, running: 0, terminals: 0 };
const BUSY: LiveWork = { working: 1, waiting: 0, running: 1, terminals: 1 };

/** The desktop shell's variables for a `.deb` that relaunches on 76 */
const DEB_ENV: NodeJS.ProcessEnv = {
  CLAUDIO_LAUNCHER: 'desktop',
  CLAUDIO_SHELL_VERSION: '0.14.2',
  CLAUDIO_SHELL_PACKAGE: 'deb',
  CLAUDIO_SHELL_INPUTS: 'x',
  CLAUDIO_SHELL_JSON: SHELL_JSON,
  CLAUDIO_SHELL_RELAUNCH: '1',
  CLAUDIO_BUNDLE_KEYS_DIR: '/opt/Claudio/resources/keys',
};

interface Unit {
  load: 'loaded' | 'not-found';
  active: string;
  /** systemd's `Result`; left out of the answer when unset, the way an older systemd might */
  result?: string;
  startedAt?: number;
}

/** A machine: the unit as systemd would describe it, the files on disk, and what was asked of systemctl */
function machine(env: NodeJS.ProcessEnv = DEB_ENV) {
  const calls: string[][] = [];
  const files = new Map<string, string>([[SHELL_JSON, JSON.stringify({ version: '0.14.2', shellInputs: 'x' })]]);
  const unit: Unit = { load: 'loaded', active: 'inactive' };
  let startAnswer: CommandResult = { code: 0, stdout: '', stderr: '' };
  let live: LiveWork = IDLE;
  let clock = Date.parse('2026-11-08T12:00:00.000Z');
  const events = new EventBus();
  const seen: DesktopUpdateStatus[] = [];
  events.subscribe((event) => {
    if (event.type === 'desktop-update.changed') seen.push(event.status);
  });
  const audits: string[] = [];
  const relaunches: number[] = [];
  const updates = new DesktopUpdates({
    version: '0.15.1',
    env,
    systemctl: async (args) => {
      calls.push([...args]);
      if (args[0] === 'show') {
        const lines = [
          `LoadState=${unit.load}`,
          `ActiveState=${unit.active}`,
          ...(unit.result === undefined ? [] : [`Result=${unit.result}`]),
          `ExecMainStartTimestamp=${unit.startedAt ? `@${String(Math.floor(unit.startedAt / 1000))}` : 'n/a'}`,
        ];
        return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
      }
      return startAnswer;
    },
    readFile: (path) => files.get(path) ?? null,
    liveWork: async () => live,
    audit: (row) => audits.push(row.summary),
    events,
    now: () => clock,
    pollMs: 5,
    idleCheckMs: 5,
  });
  updates.onRelaunch = (code) => {
    relaunches.push(code);
  };
  return {
    updates,
    calls,
    files,
    unit,
    seen,
    audits,
    relaunches,
    answerStart: (res: CommandResult) => {
      startAnswer = res;
    },
    setLive: (next: LiveWork) => {
      live = next;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

const until = async (what: string, probe: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const refusal = async (promise: Promise<unknown>): Promise<DesktopUpdateRefusal> => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof DesktopUpdateRefusal, String(err));
    return err;
  }
  assert.fail('expected a refusal');
};

test('outside a .deb desktop app nothing runs systemctl: the update is unavailable and a restart has no app to relaunch', async () => {
  for (const env of [{}, { ...DEB_ENV, CLAUDIO_SHELL_PACKAGE: 'appimage' }]) {
    const m = machine(env);
    const status = await m.updates.status();
    assert.equal(status.state, 'unavailable');
    assert.deepEqual(status.reason, { code: 'update.unit-missing' });
    const start = await refusal(m.updates.start());
    assert.deepEqual([start.statusCode, start.reason], [412, 'update.unit-missing']);
    assert.deepEqual(m.calls, [], 'systemctl is never run where there is no unit to start');
  }
  const headless = machine({});
  assert.equal((await headless.updates.status()).running, '0.15.1', "the server's own version stands in for the shell's");
  const restart = await refusal(headless.updates.restart());
  assert.deepEqual([restart.statusCode, restart.reason], [412, 'update.no-shell']);
});

test('a package older than the unit: systemd knows no claudio-update.service, so the start is 412', async () => {
  const m = machine();
  m.unit.load = 'not-found';
  assert.equal((await m.updates.status()).state, 'unavailable');
  const start = await refusal(m.updates.start());
  assert.deepEqual([start.statusCode, start.reason], [412, 'update.unit-missing']);
  assert.ok(!m.calls.some((args) => args[0] === 'start'), 'not even tried');
});

test('a unit that never ran is idle, with the versions on disk and running', async () => {
  const m = machine();
  const status = await m.updates.status();
  assert.deepEqual(status, { state: 'idle', installed: '0.14.2', running: '0.14.2', restartNeeded: false, from: null, to: null, startedAt: null, endedAt: null });
  assert.deepEqual(m.calls[0], ['show', 'claudio-update.service', '--property=LoadState,ActiveState,Result,ExecMainStartTimestamp', '--timestamp=unix']);
});

test('the start is exactly the one unit, no-block and never a password prompt; the feed follows it to installed', async () => {
  const m = machine();
  const started = await m.updates.start();
  assert.equal(started.state, 'installing', 'queued and not seen running yet still reads as installing');
  assert.deepEqual(
    m.calls.filter((args) => args[0] === 'start'),
    [['start', '--no-block', '--no-ask-password', 'claudio-update.service']],
  );
  // A second start while it runs
  m.unit.active = 'activating';
  m.unit.startedAt = m.now;
  const busy = await refusal(m.updates.start());
  assert.deepEqual([busy.statusCode, busy.reason], [409, 'update.busy']);
  // apt installed 0.15.0: the unit ended, wrote its status file, and replaced shell.json
  m.tick(40_000);
  m.files.set(SHELL_JSON, JSON.stringify({ version: '0.15.0', shellInputs: 'y' }));
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.15.0', result: 'installed', startedAt: new Date(m.now - 40_000).toISOString(), endedAt: new Date(m.now).toISOString() }));
  m.unit.active = 'inactive';
  await until('the installed state on the feed', () => m.seen.at(-1)?.state === 'installed');
  const last = m.seen.at(-1);
  assert.equal(last?.installed, '0.15.0');
  assert.equal(last?.running, '0.14.2');
  assert.equal(last?.restartNeeded, true);
  assert.deepEqual([last?.from, last?.to], ['0.14.2', '0.15.0']);
  assert.ok(m.seen.some((s) => s.state === 'installing'));
  m.updates.close();
});

test('polkit refusing the start is needs-login, on the answer, the status and the feed', async () => {
  const m = machine();
  m.answerStart({ code: 4, stdout: '', stderr: 'Failed to start claudio-update.service: Access denied\nSee system logs and \'systemctl status claudio-update.service\' for details.\n' });
  const refused = await refusal(m.updates.start());
  assert.deepEqual([refused.statusCode, refused.reason], [403, 'update.needs-login']);
  const status = await m.updates.status();
  assert.equal(status.state, 'needs-login');
  assert.deepEqual(status.reason, { code: 'update.needs-login' });
  assert.equal(m.seen.at(-1)?.state, 'needs-login');
  // Once the group applies (a new session), a start succeeds and the refusal is forgotten
  m.answerStart({ code: 0, stdout: '', stderr: '' });
  assert.equal((await m.updates.start()).state, 'installing');
  m.updates.close();
});

test("systemctl's refusals are told apart by their LSB code or their words", () => {
  assert.equal(startRefusal({ code: 1, stdout: '', stderr: 'Failed to start claudio-update.service: Interactive authentication required.' }), 'needs-login');
  assert.equal(startRefusal({ code: 4, stdout: '', stderr: '' }), 'needs-login');
  assert.equal(startRefusal({ code: 5, stdout: '', stderr: 'Failed to start claudio-update.service: Unit claudio-update.service not found.' }), 'unit-missing');
  assert.equal(startRefusal({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }), 'other');
});

test('a unit gone between the look and the start is 412; any other refusal is 500 start-failed', async () => {
  const m = machine();
  m.answerStart({ code: 5, stdout: '', stderr: 'Unit claudio-update.service not found.' });
  assert.equal((await refusal(m.updates.start())).reason, 'update.unit-missing');
  m.answerStart({ code: 1, stdout: '', stderr: 'Failed to connect to bus: No such device' });
  const other = await refusal(m.updates.start());
  assert.deepEqual([other.statusCode, other.reason], [500, 'update.start-failed']);
  assert.match(other.message, /Failed to connect to bus/);
});

test('the last run decides the rest: failed with its reason, up-to-date, or installed and already running', async () => {
  const m = machine();
  const ended = '2026-11-08T11:00:00.000Z';
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.14.2', result: 'failed', code: 'apt-locked', error: 'Could not get lock /var/lib/dpkg/lock-frontend', endedAt: ended }));
  let status = await m.updates.status();
  assert.deepEqual([status.state, status.reason?.code, status.endedAt], ['failed', 'update.apt-locked', ended]);
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: null, result: 'failed', error: 'E: Sub-process /usr/bin/dpkg returned an error code (1)', endedAt: ended }));
  assert.equal((await m.updates.status()).reason?.code, 'update.apt-failed');
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.14.2', result: 'up-to-date', endedAt: ended }));
  status = await m.updates.status();
  assert.deepEqual([status.state, status.reason], ['up-to-date', undefined]);
  // Installed, and the app already restarted onto it: nothing left to do
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.1', to: '0.14.2', result: 'installed', endedAt: ended }));
  status = await m.updates.status();
  assert.deepEqual([status.state, status.restartNeeded], ['up-to-date', false]);
});

test('a unit that failed after its status file was written failed without saying why: unit-failed', async () => {
  const m = machine();
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.1', to: '0.14.2', result: 'installed', endedAt: '2026-11-07T10:00:00.000Z' }));
  m.unit.active = 'failed';
  m.unit.startedAt = Date.parse('2026-11-08T10:00:00.000Z');
  for (const result of [undefined, 'exit-code', 'timeout', 'signal', 'oom-kill']) {
    m.unit.result = result;
    const status = await m.updates.status();
    assert.deepEqual([status.state, status.reason?.code], ['failed', 'update.unit-failed'], String(result));
  }
});

test("a start StartLimitBurst refused is failed start-limited, never the previous run's outcome", async () => {
  const m = machine();
  // The run before: up to date, an hour ago. The refused start runs nothing, so neither the status file
  // nor ExecMainStartTimestamp moves, and both still describe that run
  const before = Date.parse('2026-11-08T11:00:00.000Z');
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.14.2', result: 'up-to-date', startedAt: new Date(before - 30_000).toISOString(), endedAt: new Date(before).toISOString() }));
  m.unit.startedAt = before - 30_000;
  m.unit.result = 'success';
  assert.equal((await m.updates.status()).state, 'up-to-date');
  m.unit.active = 'failed';
  m.unit.result = 'start-limit-hit';
  const status = await m.updates.status();
  assert.deepEqual([status.state, status.reason?.code], ['failed', 'update.start-limited']);
  // The last run's versions stay what they were: the refused start installed nothing
  assert.deepEqual([status.from, status.to], ['0.14.2', '0.14.2']);
});

test('a start refused for coming too often reaches the feed as start-limited once the grace is over', async () => {
  const m = machine();
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.14.2', result: 'up-to-date', endedAt: '2026-11-08T11:00:00.000Z' }));
  // `--no-block` queues the job and answers 0; systemd refuses it when it comes to run it
  assert.equal((await m.updates.start()).state, 'installing');
  m.unit.active = 'failed';
  m.unit.result = 'start-limit-hit';
  m.tick(20_000);
  await until('start-limited on the feed', () => m.seen.at(-1)?.reason?.code === 'update.start-limited');
  assert.equal(m.seen.at(-1)?.state, 'failed');
  m.updates.close();
});

test('a later run that succeeds replaces start-limited with its own outcome', async () => {
  const m = machine();
  m.unit.active = 'inactive';
  m.unit.result = 'success';
  m.unit.startedAt = Date.parse('2026-11-08T11:50:00.000Z');
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.14.2', result: 'up-to-date', endedAt: '2026-11-08T11:51:00.000Z' }));
  assert.equal((await m.updates.status()).state, 'up-to-date');
});

test("a run whose script said why keeps the script's reason, whatever systemd's Result", async () => {
  const m = machine();
  m.unit.active = 'failed';
  m.unit.result = 'exit-code';
  m.unit.startedAt = Date.parse('2026-11-08T11:00:00.000Z');
  m.files.set(UPDATE_STATUS_FILE, JSON.stringify({ from: '0.14.2', to: '0.14.2', result: 'failed', code: 'update.source-missing', error: '/etc/apt/sources.list.d/claudio.sources is missing', endedAt: '2026-11-08T11:00:05.000Z' }));
  const status = await m.updates.status();
  assert.deepEqual([status.state, status.reason?.code], ['failed', 'update.source-missing']);
});

test('the version on disk falls back to shell.json beside the keys (an older shell), then to the running one', async () => {
  const env = { ...DEB_ENV, CLAUDIO_SHELL_JSON: undefined };
  const m = machine(env);
  assert.equal((await m.updates.status()).installed, '0.14.2');
  m.files.set(SHELL_JSON, 'half written {');
  const status = await m.updates.status();
  assert.deepEqual([status.installed, status.restartNeeded], ['0.14.2', false]);
});

test('the status file is read defensively', () => {
  assert.equal(parseUnitStatus(null), null);
  assert.equal(parseUnitStatus('not json'), null);
  assert.equal(parseUnitStatus('[]'), null);
  assert.equal(parseUnitStatus(JSON.stringify({ result: 'rm -rf' })), null);
  // Only declared codes come out: the helper's own source-missing, and apt-failed for anything unknown
  const failed = (code: string) => parseUnitStatus(JSON.stringify({ result: 'failed', code, error: 'x' }))?.code;
  assert.equal(failed('update.source-missing'), 'update.source-missing');
  assert.equal(failed('source-missing'), 'update.source-missing');
  assert.equal(failed('update.made-up'), 'update.apt-failed');
  assert.deepEqual(parseUnitStatus(JSON.stringify({ from: '../etc', to: '0.15.0', result: 'installed', endedAt: 'yesterday' })), { from: null, to: '0.15.0', result: 'installed', startedAt: null, endedAt: null, code: null });
});

test('a restart over live work is 409 with the counts; nothing relaunches', async () => {
  const m = machine();
  m.setLive(BUSY);
  const refused = await refusal(m.updates.restart());
  assert.deepEqual([refused.statusCode, refused.reason, refused.live], [409, 'update.live-work', BUSY]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(m.relaunches, []);
});

test('a restart with nothing live relaunches with exit 76 after answering', async () => {
  const m = machine();
  assert.deepEqual(await m.updates.restart({}), { scheduled: 'now' });
  assert.deepEqual(m.relaunches, [], 'the answer goes out first');
  await until('the relaunch', () => m.relaunches.length === 1);
  assert.deepEqual(m.relaunches, [RELAUNCH_EXIT_CODE]);
  // A second request while it goes is the same restart
  assert.deepEqual(await m.updates.restart({}), { scheduled: 'now' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(m.relaunches.length, 1);
});

test('whenIdle over live work waits, then relaunches once nothing is live, and says so in the audit', async () => {
  const m = machine();
  m.setLive(BUSY);
  assert.deepEqual(await m.updates.restart({ whenIdle: true }), { scheduled: 'when-idle' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(m.relaunches, []);
  m.setLive(IDLE);
  await until('the relaunch', () => m.relaunches.length === 1);
  assert.deepEqual(m.relaunches, [RELAUNCH_EXIT_CODE]);
  assert.equal(m.audits.length, 1);
  m.updates.close();
});

test('under an older shell, which does not relaunch on 76, the restart is asked with 75', async () => {
  const m = machine({ ...DEB_ENV, CLAUDIO_SHELL_RELAUNCH: undefined });
  await m.updates.restart();
  await until('the relaunch', () => m.relaunches.length === 1);
  assert.deepEqual(m.relaunches, [RESTART_EXIT_CODE]);
});
