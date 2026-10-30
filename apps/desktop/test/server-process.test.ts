import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { monitorHeaders } from '../src/live-monitor.ts';
import { LogFile } from '../src/log.ts';
import { newDesktopSecret, ServerProcess, serverEnv } from '../src/server-process.ts';

const SHELL = { appDir: '/res/server', guardEntry: '/res/server/guard.mjs', keysDir: '/res/keys', shell: { inputs: 'abc', aptManaged: true } };
const envFor = (desktopSecret: string, base: NodeJS.ProcessEnv = {}) =>
  serverEnv({ base, PATH: '/usr/bin', rememberedPort: 43123, webDist: '/web', dataDir: '/data', workspaceDir: '/ws', version: '1.2.3', distribution: 'deb', desktopSecret, ...SHELL });

test('each launch has a secret of its own, long enough that nobody guesses it', () => {
  const a = newDesktopSecret();
  const b = newDesktopSecret();
  assert.notEqual(a, b);
  // 32 random bytes in base64url
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("the server the app spawns is handed the launch's secret, beside what the person set", async () => {
  const secret = newDesktopSecret();
  const env = envFor(secret, { PORT: '9999', SOMETHING_OF_MINE: 'kept' });
  assert.equal(env.CLAUDIO_DESKTOP_TOKEN, secret);
  assert.equal(env.SOMETHING_OF_MINE, 'kept');
  assert.equal(env.PORT, '9999', 'PORT from the environment still wins');
  assert.equal(envFor(secret).PORT, '43123');
  assert.equal(env.HOST, '127.0.0.1');

  // And it really reaches the child: a stand-in server writes down what it was given
  const dir = mkdtempSync(join(tmpdir(), 'claudio-desktop-server-'));
  const seen = join(dir, 'seen');
  const entry = join(dir, 'server.mjs');
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SEEN_FILE, process.env.CLAUDIO_DESKTOP_TOKEN ?? '');
console.log('CLAUDIO_READY ' + JSON.stringify({ url: 'http://127.0.0.1:1', port: 1 }));
setInterval(() => {}, 1000);
`,
  );
  const log = new LogFile(dir, 'server.log');
  const server = new ServerProcess({ entry, cwd: dir, env: { ...envFor(secret), SEEN_FILE: seen } }, log, () => undefined);
  try {
    assert.equal(await server.start(), 'http://127.0.0.1:1');
    assert.equal(readFileSync(seen, 'utf8'), secret);
  } finally {
    await server.stop();
    await log.close();
  }
  assert.equal(readFileSync(log.path, 'utf8').includes(secret), false, 'the secret is never logged');
});

test("the tray sends the launch's secret, and CLAUDIO_AUTH_TOKEN only when there is none", () => {
  assert.deepEqual(monitorHeaders('launch-secret', { CLAUDIO_AUTH_TOKEN: 'from-env' }), { Authorization: 'Bearer launch-secret' });
  assert.deepEqual(monitorHeaders(undefined, { CLAUDIO_AUTH_TOKEN: ' from-env ' }), { Authorization: 'Bearer from-env' });
  assert.deepEqual(monitorHeaders(undefined, {}), {});
});

test("the server is told the shell supervises it, which payload it runs, and that the guard and keys are the shell's", () => {
  const env = serverEnv({
    base: { CLAUDIO_GUARD_ENTRY: '/home/me/evil-guard.mjs', CLAUDIO_BUNDLE_KEYS_DIR: '/home/me/keys', CLAUDIO_LAUNCHER: '1' },
    PATH: '/usr/bin',
    rememberedPort: null,
    webDist: '/data/app/0.8.0/web',
    dataDir: '/data',
    workspaceDir: '/ws',
    version: '0.7.0',
    distribution: 'appimage',
    desktopSecret: 's',
    ...SHELL,
    appDir: '/data/app/0.8.0',
    shell: { inputs: 'abc', aptManaged: false },
  });
  assert.equal(env.CLAUDIO_LAUNCHER, 'desktop');
  assert.equal(env.CLAUDIO_APP_DIR, '/data/app/0.8.0');
  assert.equal(env.CLAUDIO_WEB_DIST, '/data/app/0.8.0/web');
  // Whatever the person's environment says: an overlay never brings its own guard or keys
  assert.equal(env.CLAUDIO_GUARD_ENTRY, '/res/server/guard.mjs');
  assert.equal(env.CLAUDIO_BUNDLE_KEYS_DIR, '/res/keys');
  assert.equal(env.CLAUDIO_SHELL_VERSION, '0.7.0');
  assert.equal(env.CLAUDIO_SHELL_INPUTS, 'abc');
  assert.equal(env.CLAUDIO_SHELL_PACKAGE, 'appimage');
  assert.equal(env.CLAUDIO_SHELL_APT, '0');
  assert.equal(envFor('s').CLAUDIO_SHELL_APT, '1');
  // A dev build names no package; the server then says updates are off there
  const dev = serverEnv({ ...SHELL, base: {}, PATH: '/usr/bin', rememberedPort: null, webDist: '/w', dataDir: '/d', workspaceDir: '/s', version: '1.0.0', distribution: undefined, desktopSecret: 's' });
  assert.equal(dev.CLAUDIO_SHELL_PACKAGE, undefined);
  assert.equal(dev.CLAUDIO_LAUNCHER, 'desktop');
});

test('the desktop server listens on the local network with a sign-in method on, unless the person’s environment says otherwise', () => {
  const base = { ...SHELL, PATH: '/usr/bin', rememberedPort: null, webDist: '/w', dataDir: '/d', workspaceDir: '/s', version: '1.0.0', distribution: undefined, desktopSecret: 's' };
  const env = serverEnv({ ...base, base: {} });
  assert.equal(env.CLAUDIO_LAN, 'auto');
  // The main listener stays on loopback whatever the LAN does
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(serverEnv({ ...base, base: { CLAUDIO_LAN: 'off' } }).CLAUDIO_LAN, 'off');
});

async function standIn(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-desktop-server-'));
  const entry = join(dir, 'server.mjs');
  writeFileSync(entry, `console.log('CLAUDIO_READY ' + JSON.stringify({ url: 'http://127.0.0.1:1' }));\n${body}\n`);
  const log = new LogFile(dir, 'server.log');
  const crashes: string[] = [];
  const server = new ServerProcess({ entry, cwd: dir, env: envFor('s') }, log, (detail) => crashes.push(detail));
  const done = async () => {
    await log.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { server, crashes, done };
}

test('a server that exits on its own resolves `exited` with its code, and says how it went', async () => {
  const { server, crashes, done } = await standIn(`console.error('restarting for an update');\nsetTimeout(() => process.exit(75), 50);`);
  try {
    assert.equal(await server.start(), 'http://127.0.0.1:1');
    assert.equal(await server.exited, 75);
    assert.match(server.detail, /code 75/);
    assert.match(server.detail, /restarting for an update/);
    assert.equal(crashes.length, 1);
  } finally {
    await done();
  }
});

test('a server stopped by a signal resolves `exited`, and that is no crash', async () => {
  const { server, crashes, done } = await standIn('setInterval(() => {}, 1000);');
  try {
    await server.start();
    server.signal('SIGTERM');
    assert.equal(await server.exited, 128 + 15);
    assert.deepEqual(crashes, []);
  } finally {
    await done();
  }
});

test('a server that cannot be spawned still resolves `exited`', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-desktop-server-'));
  const log = new LogFile(dir, 'server.log');
  const server = new ServerProcess({ entry: join(dir, 'server.mjs'), cwd: join(dir, 'missing-cwd'), env: envFor('s') }, log);
  try {
    await assert.rejects(server.start());
    assert.equal(typeof (await server.exited), 'number');
  } finally {
    await log.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
