import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerUpdateStatus } from '@claudio/shared';
import {
  canRetryUpdate,
  dismissRollback,
  dismissedRollback,
  isLoopback,
  liveWorkOf,
  parseInstallAnswer,
  parsePayloadAnswer,
  parseSwitchState,
  parseUpdateState,
  payloadActionsVia,
  payloadHasPrimary,
  updateErrorCode,
  updateRoute,
  type PayloadAction,
} from '../src/lib/updates.ts';

// The Updates card offers one way to take a release, chosen from the kind of install the server is
// and from where the page runs; the desktop shell's answers arrive as `unknown` and are checked.

test('the desktop window updates itself, whatever the server reports as its distribution', () => {
  for (const distribution of ['appimage', 'deb', 'source'] as const) {
    assert.deepEqual(updateRoute({ distribution, desktopUpdates: true, hostname: '127.0.0.1' }), { kind: 'desktop' });
  }
});

test('a browser on the same machine gets the steps addressed to its reader', () => {
  assert.deepEqual(updateRoute({ distribution: 'docker', desktopUpdates: false, hostname: 'localhost' }), { kind: 'steps', how: 'docker', remote: false });
  assert.deepEqual(updateRoute({ distribution: 'source', desktopUpdates: false, hostname: '127.0.0.1' }), { kind: 'steps', how: 'source', remote: false });
  assert.deepEqual(updateRoute({ distribution: 'appimage', desktopUpdates: false, hostname: '[::1]' }), { kind: 'steps', how: 'desktop-app', remote: false });
});

test('a phone or another computer gets the same steps, addressed to whoever runs the server', () => {
  assert.deepEqual(updateRoute({ distribution: 'docker', desktopUpdates: false, hostname: '192.168.1.20' }), { kind: 'steps', how: 'docker', remote: true });
  assert.deepEqual(updateRoute({ distribution: 'deb', desktopUpdates: false, hostname: 'claudio.example.com' }), { kind: 'steps', how: 'desktop-app', remote: true });
});

test('loopback names and addresses count as this machine, and nothing else does', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.equal(isLoopback(host), true, host);
  for (const host of ['192.168.1.2', '10.0.0.1', 'claudio.lan', 'localhost.example.com', '1127.0.0.1']) assert.equal(isLoopback(host), false, host);
});

test('the shell state is read as the desktop updater sends it', () => {
  assert.deepEqual(parseUpdateState({ status: 'idle' }), { status: 'idle' });
  assert.deepEqual(parseUpdateState({ status: 'available', version: '0.19.0' }), { status: 'available', version: '0.19.0' });
  assert.deepEqual(parseUpdateState({ status: 'downloading', version: '0.19.0', percent: 42.6 }), { status: 'downloading', version: '0.19.0', percent: 43 });
  assert.deepEqual(parseUpdateState({ status: 'ready', version: '0.19.0' }), { status: 'ready', version: '0.19.0' });
  assert.deepEqual(parseUpdateState({ status: 'unsupported', reason: 'development', message: 'Updates are off.' }), {
    status: 'unsupported',
    reason: 'development',
    message: 'Updates are off.',
  });
  assert.deepEqual(parseUpdateState({ status: 'error', message: 'offline' }), { status: 'error', code: 'other', message: 'offline' });
});

test('a progress out of range is clamped, and a state this build does not know is dropped', () => {
  assert.deepEqual(parseUpdateState({ status: 'downloading', version: '1.0.0', percent: 140 }), { status: 'downloading', version: '1.0.0', percent: 100 });
  assert.equal(parseUpdateState({ status: 'ready' }), null, 'ready without a version');
  assert.equal(parseUpdateState({ status: 'paused' }), null);
  assert.equal(parseUpdateState('ready'), null);
  assert.equal(parseUpdateState(null), null);
});

test('a busy answer carries what a restart would stop, so the page can ask first', () => {
  assert.deepEqual(parseInstallAnswer({ status: 'busy', version: '0.19.0', live: { working: 2, waiting: 1, running: 0, terminals: 3 } }), {
    status: 'busy',
    version: '0.19.0',
    live: { working: 2, waiting: 1, running: 0, terminals: 3 },
  });
  assert.deepEqual(parseInstallAnswer({ status: 'busy', version: '0.19.0', live: { working: -1, waiting: 'x' } }), {
    status: 'busy',
    version: '0.19.0',
    live: { working: 0, waiting: 0, running: 0, terminals: 0 },
  });
  assert.deepEqual(parseInstallAnswer({ status: 'scheduled', version: '0.19.0' }), { status: 'scheduled', version: '0.19.0' });
  assert.deepEqual(parseInstallAnswer({ status: 'restarting', version: '0.19.0' }), { status: 'restarting', version: '0.19.0' });
  assert.deepEqual(parseInstallAnswer({ status: 'not-ready', state: { status: 'idle' } }), { status: 'not-ready', state: { status: 'idle' } });
  assert.equal(parseInstallAnswer({ status: 'busy', version: '0.19.0' }), null);
  assert.equal(parseInstallAnswer(undefined), null);
});

test('a rollback notice put away is remembered by its time, in this browser', () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> };
  const before = g.localStorage;
  g.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) };
  try {
    assert.equal(dismissedRollback(), null);
    dismissRollback('2026-10-18T10:00:00.000Z');
    assert.equal(dismissedRollback(), '2026-10-18T10:00:00.000Z');
  } finally {
    g.localStorage = before;
  }
});

test('the shell states of the unified update are read, and a half-sent one is dropped', () => {
  assert.deepEqual(parseUpdateState({ status: 'verifying', version: '0.7.0' }), { status: 'verifying', version: '0.7.0' });
  assert.deepEqual(parseUpdateState({ status: 'shell-replaced', version: '0.7.0' }), { status: 'shell-replaced', version: '0.7.0' });
  assert.deepEqual(parseUpdateState({ status: 'apt-managed', latest: '0.7.0' }), { status: 'apt-managed', latest: '0.7.0' });
  assert.deepEqual(parseUpdateState({ status: 'apt-managed' }), { status: 'apt-managed', latest: null });
  assert.deepEqual(parseUpdateState({ status: 'copy-command', version: '0.7.0', command: "/usr/bin/sudo /usr/bin/apt install -- 'x'" }), {
    status: 'copy-command',
    version: '0.7.0',
    command: "/usr/bin/sudo /usr/bin/apt install -- 'x'",
  });
  assert.equal(parseUpdateState({ status: 'copy-command', version: '0.7.0' }), null, 'a command-less copy-command has nothing to show');
  assert.equal(parseUpdateState({ status: 'shell-replaced' }), null);
  assert.deepEqual(parseUpdateState({ status: 'error', code: 'bad-signature', message: 'x' }), { status: 'error', code: 'bad-signature', message: 'x' });
  assert.deepEqual(parseUpdateState({ status: 'error', code: 'invented', message: 'x' }), { status: 'error', code: 'other', message: 'x' });
});

test('the switch offer is read defensively, and a shell that has none offers nothing', () => {
  assert.deepEqual(parseSwitchState({ available: true, reason: null, debStillInstalled: false }), { available: true, reason: null, debStillInstalled: false });
  assert.deepEqual(parseSwitchState({ available: false, reason: 'sandbox-restricted', debStillInstalled: true }), {
    available: false,
    reason: 'sandbox-restricted',
    debStillInstalled: true,
  });
  assert.deepEqual(parseSwitchState({ available: false, reason: 'whatever' }), { available: false, reason: null, debStillInstalled: false });
  assert.equal(parseSwitchState({ reason: null }), null);
  assert.equal(parseSwitchState(undefined), null);
});

const serverStatus = (over: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus => ({
  unsupportedReason: null,
  image: '0.6.0',
  running: '0.6.0',
  source: 'image',
  state: 'idle',
  target: null,
  progress: null,
  error: null,
  needsImage: null,
  lastRollback: null,
  base: 'shell',
  shell: null,
  needsShell: null,
  offer: null,
  ...over,
});

test('the shell answers a payload action with the route’s status or its refusal, and anything else is dropped', () => {
  const status = serverStatus({ state: 'ready', target: '0.7.0' });
  assert.deepEqual(parsePayloadAnswer(status), { status });
  assert.deepEqual(parsePayloadAnswer({ status: 409, code: 'update.live-work', live: { working: 1, waiting: 0, running: 0, terminals: 2 } }), {
    refusal: { status: 409, code: 'update.live-work', live: { working: 1, waiting: 0, running: 0, terminals: 2 } },
  });
  assert.deepEqual(parsePayloadAnswer({ status: 412, code: 'update.needs-shell' }), { refusal: { status: 412, code: 'update.needs-shell', live: null } });
  assert.equal(parsePayloadAnswer({ hello: 1 }), null);
  assert.equal(parsePayloadAnswer('ok'), null);
});

test('actions through the shell throw a refusal as the page’s own client does, so one handler reads both', async () => {
  const sent: PayloadAction[] = [];
  const answers: unknown[] = [serverStatus({ state: 'downloading' }), { status: 409, code: 'update.live-work', live: { working: 2 } }, { nonsense: true }];
  const actions = payloadActionsVia(async (action) => {
    sent.push(action);
    return answers.shift();
  });
  assert.equal((await actions.download()).state, 'downloading');
  await assert.rejects(actions.apply({ whenIdle: true }), (error: unknown) => {
    assert.deepEqual(liveWorkOf(error), { working: 2, waiting: 0, running: 0, terminals: 0 });
    return true;
  });
  await assert.rejects(actions.revert({}), /does not know/);
  assert.deepEqual(sent, [{ action: 'download' }, { action: 'apply', whenIdle: true }, { action: 'revert' }]);
});

test('every refusal and every status error has a code the card words, and an unknown one has none', () => {
  assert.equal(updateErrorCode({ code: 'update.needs-auth' }), 'needs-auth');
  assert.equal(updateErrorCode('bad-signature'), 'bad-signature');
  assert.equal(updateErrorCode('download-interrupted'), 'download-interrupted', 'a status error the server sets after every retry failed');
  assert.equal(updateErrorCode({ code: 'update.no-release' }), 'no-release');
  assert.equal(updateErrorCode({ code: 'update.something-new' }), null);
  assert.equal(updateErrorCode(new Error('the release 0.6.1 has no server bundle')), null);
  assert.equal(updateErrorCode(null), null);
});

test('only a failure another try can change offers Try again', () => {
  for (const code of ['fetch-failed', 'download-interrupted', 'bad-signature', 'bad-manifest', 'disk', 'busy', null] as const) assert.equal(canRetryUpdate(code), true, String(code));
  for (const code of ['needs-image', 'needs-shell', 'needs-auth', 'not-owner', 'unsupported', 'no-release', 'not-ready', 'not-overlay'] as const) assert.equal(canRetryUpdate(code), false, code);
});

test('the Claudio zone owns the card’s primary action only when it offers one it can take', () => {
  assert.equal(payloadHasPrimary(serverStatus(), true), true, 'an installable update');
  assert.equal(payloadHasPrimary(serverStatus(), false), false, 'nothing newer');
  assert.equal(payloadHasPrimary(serverStatus({ state: 'ready' }), false), true, 'ready to restart');
  assert.equal(payloadHasPrimary(serverStatus({ needsShell: { version: '0.8.0', minShell: '0.7.0' } }), true), false, 'the Desktop app zone has it');
  assert.equal(payloadHasPrimary(serverStatus({ offer: { version: '0.7.0', installable: false, blocked: 'no-bundle' } }), true), false);
  assert.equal(payloadHasPrimary(serverStatus({ unsupportedReason: 'development' }), true), false);
  assert.equal(payloadHasPrimary(undefined, true), false);
});
