import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type { Verified } from '../src/desktop-manifest.ts';
import { EMPTY_SNAPSHOT, trayMenu } from '../src/live.ts';
import {
  APT_KEYRING,
  APT_SOURCE,
  aptManaged,
  appImageRelaunch,
  DesktopUpdater,
  distributionOf,
  installDecision,
  liveWorkOf,
  parseInstallRequest,
  updateSupport,
  workWords,
  type Distribution,
  type LiveWork,
  type Support,
  type UpdaterEngine,
  type UpdateState,
} from '../src/updater.ts';

const roots: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SHA = 'a'.repeat(64);

/** electron-updater's events, driven by hand: each call says what the real engine would emit */
class FakeEngine extends EventEmitter implements UpdaterEngine {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  logger: UpdaterEngine['logger'] = null;
  latest: string | null = '0.18.0';
  failCheck: Error | null = null;
  failDownload: Error | null = null;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  installResult = true;
  file = '/home/me/.cache/claudio-updater/pending/Claudio-0.18.0-amd64.deb';

  async checkForUpdates() {
    this.emit('checking-for-update');
    if (this.failCheck) {
      this.emit('error', this.failCheck);
      throw this.failCheck;
    }
    if (!this.latest) {
      this.emit('update-not-available', { version: '0.17.1' });
      return { isUpdateAvailable: false, updateInfo: { version: '0.17.1' } };
    }
    this.emit('update-available', { version: this.latest });
    return { isUpdateAvailable: true, updateInfo: { version: this.latest } };
  }

  async downloadUpdate() {
    this.downloads += 1;
    if (this.failDownload) {
      this.emit('error', this.failDownload);
      throw this.failDownload;
    }
    this.emit('download-progress', { percent: 12.4 });
    this.emit('download-progress', { percent: 99.6 });
    this.emit('update-downloaded', { version: this.latest, downloadedFile: this.file });
    return [this.file];
  }

  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean {
    this.installs.push([isSilent, isForceRunAfter]);
    return this.installResult;
  }
}

const APPIMAGE: Support = { supported: true, distribution: 'appimage' };
const DEB: Support = { supported: true, distribution: 'deb' };

function setup(support: Support = APPIMAGE, { apt = false }: { apt?: boolean } = {}) {
  const engine = new FakeEngine();
  let made = 0;
  const checks: Array<[string, string, Distribution]> = [];
  let answer: Verified = { ok: true, sha256: SHA };
  const flags = { apt };
  const updater = new DesktopUpdater({
    support,
    engine: () => {
      made++;
      return engine;
    },
    aptManaged: () => flags.apt,
    verify: async (version, file, kind) => {
      checks.push([version, file, kind]);
      return answer;
    },
    log: () => undefined,
  });
  const seen: UpdateState[] = [];
  updater.onState((s) => seen.push(s));
  return {
    engine,
    updater,
    seen,
    checks,
    flags,
    made: () => made,
    verifyAnswers: (next: Verified) => {
      answer = next;
    },
  };
}

test('the package is told apart the way electron-updater does: APPIMAGE first, then package-type', () => {
  assert.equal(distributionOf({ appImage: '/home/me/Claudio.AppImage', packageType: undefined }), 'appimage');
  assert.equal(distributionOf({ appImage: undefined, packageType: 'deb\n' }), 'deb');
  assert.equal(distributionOf({ appImage: undefined, packageType: 'rpm' }), undefined);
  assert.equal(distributionOf({ appImage: undefined, packageType: undefined }), undefined);
});

test('a dev build, an unknown package and a read-only AppImage cannot update; a .deb always can, with no password tool', () => {
  const writable = () => true;
  const dev = updateSupport({ dev: true, appImage: '/a/Claudio.AppImage', packageType: undefined, appImageWritable: writable });
  assert.equal('reason' in dev && dev.reason, 'development');
  const unknown = updateSupport({ dev: false, appImage: undefined, packageType: undefined, appImageWritable: writable });
  assert.equal('reason' in unknown && unknown.reason, 'unknown-package');
  const readOnly = updateSupport({ dev: false, appImage: '/opt/Claudio.AppImage', packageType: undefined, appImageWritable: () => false });
  assert.equal('reason' in readOnly && readOnly.reason, 'read-only');
  // Nothing about pkexec is asked any more: the .deb never escalates from inside the app
  assert.deepEqual(updateSupport({ dev: false, appImage: undefined, packageType: 'deb', appImageWritable: () => false }), { supported: true, distribution: 'deb' });
});

test('the shell never asks for a password: no pkexec, no sudo prompt, nothing that escalates', () => {
  const src = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /pkexec|gksudo|kdesudo|debCanElevate|no-elevation/);
  // The .deb's engine is only ever checked and downloaded: install() is called on the AppImage's alone
  assert.match(readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8'), /this\.distribution !== 'appimage'/);
});

test('apt manages the shell only when both the source and its keyring are there', () => {
  const has = (paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(aptManaged(has([APT_SOURCE, APT_KEYRING])), true);
  assert.equal(aptManaged(has([APT_SOURCE])), false);
  assert.equal(aptManaged(has([APT_KEYRING])), false);
});

test('an unsupported copy never loads the engine and stays unsupported', async () => {
  const unsupported = updateSupport({ dev: true, appImage: undefined, packageType: undefined, appImageWritable: () => true });
  const { updater, made } = setup(unsupported);
  assert.equal(updater.state.status, 'unsupported');
  assert.equal((await updater.check()).status, 'unsupported');
  assert.equal((await updater.download()).status, 'unsupported');
  assert.equal(await updater.install(), false);
  assert.equal(made(), 0);
});

test('the engine never downloads or installs on its own', async () => {
  const { engine, updater } = setup();
  await updater.check();
  assert.equal(engine.autoDownload, false);
  assert.equal(engine.autoInstallOnAppQuit, false);
});

test('check: checking, then available with the version, or back to idle', async () => {
  const { engine, updater, seen } = setup();
  assert.deepEqual(updater.state, { status: 'idle' });
  assert.deepEqual(await updater.check(), { status: 'available', version: '0.18.0' });
  assert.equal(seen[0]?.status, 'checking');
  assert.equal(updater.latest, '0.18.0');

  engine.latest = null;
  assert.deepEqual(await updater.check(), { status: 'idle' });
  assert.equal(updater.latest, undefined);
});

test('a failed check is an error with a code, and a later check recovers', async () => {
  const { engine, updater } = setup();
  engine.failCheck = new Error('net::ERR_INTERNET_DISCONNECTED');
  assert.deepEqual(await updater.check(), { status: 'error', code: 'fetch-failed', message: 'net::ERR_INTERNET_DISCONNECTED' });
  engine.failCheck = null;
  assert.equal((await updater.check()).status, 'available');
});

test('AppImage: download checks first, reports whole percents, verifies against the signed manifest, and ends ready', async () => {
  const { engine, updater, seen, checks } = setup();
  engine.file = '/home/me/.cache/claudio-updater/pending/Claudio-0.18.0-x86_64.AppImage';
  assert.deepEqual(await updater.download(), { status: 'ready', version: '0.18.0' });
  assert.deepEqual(
    seen.map((s) => (s.status === 'downloading' ? `downloading ${s.percent}` : s.status)),
    ['checking', 'available', 'downloading 0', 'downloading 12', 'downloading 100', 'verifying', 'ready'],
  );
  assert.deepEqual(checks, [['0.18.0', engine.file, 'appimage']]);
  assert.equal(updater.readyVersion, '0.18.0');
  // Nothing more to do once it is ready: a second download does not start another
  assert.deepEqual(await updater.download(), { status: 'ready', version: '0.18.0' });
  assert.equal(engine.downloads, 1);
});

test('a download whose signature does not verify is discarded with bad-signature, never ready', async () => {
  const { updater, verifyAnswers } = setup();
  verifyAnswers({ ok: false, code: 'bad-signature', message: 'Claudio-0.18.0-x86_64.AppImage does not match the signed desktop manifest' });
  const state = await updater.download();
  assert.equal(state.status, 'error');
  assert.equal(state.status === 'error' && state.code, 'bad-signature');
  assert.equal(updater.readyVersion, undefined);
  assert.equal(await updater.install(), false);
});

test("electron-updater's own sha512 mismatch is a bad download too", async () => {
  const { engine, updater } = setup();
  engine.failDownload = new Error('sha512 checksum mismatch, expected …');
  const state = await updater.download();
  assert.equal(state.status === 'error' && state.code, 'bad-signature');
});

test('download with nothing newer stays idle and downloads nothing', async () => {
  const { engine, updater } = setup();
  engine.latest = null;
  assert.deepEqual(await updater.download(), { status: 'idle' });
  assert.equal(engine.downloads, 0);
});

test('install checks the AppImage again, runs silently and without a run-after, and only once ready', async () => {
  const { engine, updater, checks, verifyAnswers } = setup();
  assert.equal(await updater.install(), false);
  await updater.download();
  assert.equal(await updater.install(), true);
  assert.deepEqual(engine.installs, [[true, false]]);
  assert.equal(checks.length, 2, 'verified after the download and again before installing');

  // Changed in the cache since: refused, and nothing is installed
  verifyAnswers({ ok: false, code: 'bad-signature', message: 'changed' });
  assert.equal(await updater.install(), false);
  assert.equal(engine.installs.length, 1);
  assert.equal(updater.state.status, 'error');
});

test('install on quit is only armed with a download ready', async () => {
  const { updater } = setup();
  assert.equal(updater.requestInstallOnQuit(), false);
  assert.equal(updater.installOnQuit, false);
  await updater.download();
  assert.equal(updater.requestInstallOnQuit(), true);
  assert.equal(updater.installOnQuit, true);
});

test('a renamed AppImage is remembered for the relaunch', async () => {
  const { engine, updater } = setup();
  await updater.check();
  engine.emit('appimage-filename-updated', '/home/me/Claudio-0.18.0-x86_64.AppImage');
  assert.equal(updater.installedAppImage, '/home/me/Claudio-0.18.0-x86_64.AppImage');
});

test('.deb under apt: the state says apt updates it, a check only learns the version, and nothing downloads', async () => {
  const { engine, updater, seen } = setup(DEB, { apt: true });
  assert.deepEqual(updater.state, { status: 'apt-managed', latest: null });
  assert.deepEqual(await updater.check(), { status: 'apt-managed', latest: '0.18.0' });
  assert.ok(!seen.some((s) => s.status === 'checking'), 'no flicker through checking');
  assert.deepEqual(await updater.download(), { status: 'apt-managed', latest: '0.18.0' });
  assert.equal(engine.downloads, 0);
  assert.equal(await updater.install(), false);
  // A check that fails changes nothing the person can act on
  engine.failCheck = new Error('offline');
  assert.deepEqual(await updater.check(), { status: 'apt-managed', latest: null });
});

test('.deb without apt: downloads, verifies, and offers the command, never installs', async () => {
  const { engine, updater, checks } = setup(DEB);
  const state = await updater.download();
  assert.equal(state.status, 'copy-command');
  assert.deepEqual(checks, [['0.18.0', engine.file, 'deb']]);
  if (state.status !== 'copy-command') return;
  assert.equal(state.version, '0.18.0');
  assert.match(state.command, /^\/usr\/bin\/sudo \/usr\/bin\/install -D -m 0644 -o root -g root -- '\/home\/me\/\.cache\/claudio-updater\/pending\/Claudio-0\.18\.0-amd64\.deb' '\/var\/cache\/claudio\/claudio_0\.18\.0_amd64\.deb'/);
  assert.ok(state.command.includes(SHA));
  assert.doesNotMatch(state.command, /-y\b/);
  assert.equal(await updater.install(), false);
  assert.deepEqual(engine.installs, []);
});

test('a .deb that does not verify shows no command', async () => {
  const { updater, verifyAnswers } = setup(DEB);
  verifyAnswers({ ok: false, code: 'fetch-failed', message: 'GitHub answered 502' });
  const state = await updater.download();
  assert.equal(state.status === 'error' && state.code, 'fetch-failed');
});

test('once apt replaced the app underneath, a restart is all that is left', async () => {
  const { updater, engine } = setup(DEB, { apt: true });
  updater.markReplaced('0.18.0');
  assert.deepEqual(updater.state, { status: 'shell-replaced', version: '0.18.0' });
  assert.equal(updater.readyVersion, '0.18.0');
  // A later check does not take it back
  assert.deepEqual(await updater.check(), { status: 'shell-replaced', version: '0.18.0' });
  engine.emit('update-available', { version: '0.19.0' });
  assert.equal(updater.state.status, 'shell-replaced');
  assert.equal(await updater.install(), false);
});

const idle: LiveWork = liveWorkOf(EMPTY_SNAPSHOT, 0);
const busy: LiveWork = liveWorkOf({ ...EMPTY_SNAPSHOT, working: 2, running: 1 }, 0);
const ready: UpdateState = { status: 'ready', version: '0.18.0' };

test('the restart refuses while work is live, and says what is', () => {
  assert.deepEqual(installDecision(ready, busy, {}), {
    status: 'busy',
    version: '0.18.0',
    live: { working: 2, waiting: 0, running: 1, terminals: 0 },
  });
  // A chat waiting for a permission answer has a CLI running as well
  assert.equal(installDecision(ready, liveWorkOf({ ...EMPTY_SNAPSHOT, waiting: 1 }, 0), {}).status, 'busy');
  assert.deepEqual(installDecision(ready, idle, {}), { status: 'restarting', version: '0.18.0' });
});

test('an open terminal is live work: its shell ends with the restart', () => {
  const terminals = liveWorkOf(EMPTY_SNAPSHOT, 1);
  assert.equal(installDecision(ready, terminals, {}).status, 'busy');
  assert.equal(workWords(terminals), '1 terminal');
  assert.equal(workWords({ working: 1, waiting: 0, running: 2, terminals: 3 }), '1 working · 2 orchestrations · 3 terminals');
  assert.equal(workWords(idle), null);
});

test('once asked, the person can restart anyway or leave it for the next quit; a replaced shell restarts the same way', () => {
  assert.equal(installDecision(ready, busy, { force: true }).status, 'restarting');
  assert.deepEqual(installDecision(ready, busy, { whenIdle: true }), { status: 'scheduled', version: '0.18.0' });
  assert.equal(installDecision({ status: 'idle' }, idle, {}).status, 'not-ready');
  assert.equal(installDecision({ status: 'copy-command', version: '0.18.0', command: 'x' }, idle, {}).status, 'not-ready');
  const replaced: UpdateState = { status: 'shell-replaced', version: '0.18.0' };
  assert.deepEqual(installDecision(replaced, idle, {}), { status: 'restarting', version: '0.18.0' });
  assert.equal(installDecision(replaced, busy, {}).status, 'busy');
});

test('the page only passes the two flags, and only as true booleans', () => {
  assert.deepEqual(parseInstallRequest({ whenIdle: true, force: 'yes', extra: 1 }), { whenIdle: true, force: false });
  assert.deepEqual(parseInstallRequest(null), {});
  assert.deepEqual(parseInstallRequest('force'), {});
});

test('the tray offers one restart above Quit: to update, or to finish an update apt installed', () => {
  const labels = (restart?: { version: string; finish: boolean }) => trayMenu(EMPTY_SNAPSHOT, restart).flatMap((e) => (e.type === 'item' ? [e.label] : []));
  assert.ok(!labels().some((l) => l.startsWith('Restart')));
  const items = trayMenu(EMPTY_SNAPSHOT, { version: '0.18.0', finish: false }).flatMap((e) => (e.type === 'item' ? [e] : []));
  assert.deepEqual(items.slice(-2), [
    { type: 'item', label: 'Restart to update to 0.18.0', action: { kind: 'update' } },
    { type: 'item', label: 'Quit Claudio', action: { kind: 'quit' } },
  ]);
  assert.ok(labels({ version: '0.18.0', finish: true }).includes('Restart to finish the update to 0.18.0'));
});

test('the AppImage relaunch waits for the old process to exit, then runs the new file with its arguments and no inherited descriptors', async () => {
  const dir = tempDir('claudio-relaunch-');
  const appImage = join(dir, 'Claudio.AppImage');
  const ran = join(dir, 'ran');
  const fds = join(dir, 'fds');
  writeFileSync(appImage, `#!/bin/sh\nls /proc/$$/fd > ${JSON.stringify(fds)}\necho "$@" > ${JSON.stringify(ran)}\n`);
  chmodSync(appImage, 0o755);

  // The "old process" is a sleep that is still alive when the relaunch starts
  const old = spawn('sleep', ['0.6']);
  const oldExited = new Promise((resolve) => old.once('exit', resolve));
  const relaunch = appImageRelaunch(old.pid!, appImage, ['--flag', 'two']);
  assert.equal(relaunch.command, '/bin/bash');
  // Descriptors 3 and 4 stand for what Chromium leaves inheritable
  const child = spawn(relaunch.command, relaunch.args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const done = new Promise((resolve) => child.once('exit', resolve));

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(existsSync(ran), false, 'nothing starts while the old process lives');
  await oldExited;
  await done;
  assert.equal(readFileSync(ran, 'utf8').trim(), '--flag two');
  const open = readFileSync(fds, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.ok(!open.includes(3) && !open.includes(4), `inherited descriptors were closed: ${open.join(' ')}`);
});
