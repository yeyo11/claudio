import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { keyId } from '@claudio/core/launcher/protocol';
import {
  PayloadHost,
  forgetOverlays,
  parsePayloadAction,
  parsePayloadFacts,
  payloadAnswer,
  payloadRequest,
  readShellJson,
  type PayloadBoot,
  type PayloadHostOptions,
  type ServerHandle,
} from '../src/payload.ts';

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SHELL = { version: '0.7.0', shellInputs: 'shell-inputs' };

/** A throwaway signing key, never a release key */
const newKey = () => generateKeyPairSync('ed25519');

function world() {
  const root = mkdtempSync(join(tmpdir(), 'claudio-payload-'));
  roots.push(root);
  const resources = join(root, 'resources');
  const bundledDir = join(resources, 'server');
  const keysDir = join(resources, 'keys');
  const dataDir = join(root, 'data');
  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(keysDir, { recursive: true });
  mkdirSync(join(dataDir, 'app'), { recursive: true });
  writeFileSync(join(bundledDir, 'server.mjs'), '// bundled\n');
  const key = newKey();
  writeFileSync(join(keysDir, 'release.pub'), key.publicKey.export({ type: 'spki', format: 'pem' }));
  return { root, resources, bundledDir, keysDir, dataDir, key };
}

/** An unpacked, signed payload in `<dataDir>/app/<version>`, as the server leaves one after a download */
function overlay(dataDir: string, version: string, signer: { privateKey: KeyObject; publicKey: KeyObject }, { minShell = '0.7.0', keyed = false } = {}) {
  const dir = join(dataDir, 'app', version);
  mkdirSync(join(dir, 'web'), { recursive: true });
  const contents: Record<string, string> = { 'server.mjs': `// ${version}\n`, 'web/index.html': `<!doctype html><title>${version}</title>\n` };
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(contents)) {
    writeFileSync(join(dir, path), text);
    files[path] = createHash('sha256').update(text).digest('hex');
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      version,
      platform: 'linux-x64',
      nodeAbi: '141',
      minImage: '0.7.0',
      imageInputs: 'image-inputs',
      minShell,
      shellInputs: SHELL.shellInputs,
      commit: 'abc',
      builtAt: '2026-10-18T00:00:00Z',
      tarball: { name: `claudio-server-${version}-linux-x64.tar.gz`, sha256: 'x', size: 1 },
      files,
    }),
  );
  writeFileSync(join(dir, 'manifest.json'), manifest);
  const sig = sign(null, manifest, signer.privateKey).toString('base64');
  writeFileSync(join(dir, 'manifest.json.sig'), keyed ? `${keyId(signer.publicKey)} ${sig}\n` : `${sig}\n`);
  return dir;
}

const stateFile = (dataDir: string) => join(dataDir, 'app', 'state.json');
const writeState = (dataDir: string, state: Record<string, unknown>) =>
  writeFileSync(
    stateFile(dataDir),
    JSON.stringify({ active: null, previous: null, trial: null, attempts: 0, bad: [], lastRollback: null, scheduled: null, rollbackAudited: null, ...state }),
  );
const readState = (dataDir: string) => JSON.parse(readFileSync(stateFile(dataDir), 'utf8')) as Record<string, unknown>;

/** How one fake server behaves: whether it listens, answers health, whether its page renders */
interface Plan {
  ready?: boolean;
  health?: boolean;
  page?: boolean;
}

interface Started {
  boot: PayloadBoot;
  exit(code: number): void;
  stopped: boolean;
}

function host(w: ReturnType<typeof world>, plans: Plan[], extra: Partial<PayloadHostOptions> = {}) {
  const started: Started[] = [];
  const lines: string[] = [];
  let current: Plan = {};
  const h: PayloadHost = new PayloadHost({
    bundledDir: w.bundledDir,
    bundledWeb: join(w.resources, 'web'),
    keysDir: w.keysDir,
    dataDir: w.dataDir,
    shell: SHELL,
    trialMs: 2_000,
    pageReadyMs: 120,
    pollMs: 5,
    spawn: (boot): ServerHandle => {
      const plan = plans.shift() ?? { page: true };
      current = plan;
      let resolveExit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const entry: Started = { boot, exit: (code) => resolveExit(code), stopped: false };
      started.push(entry);
      const listens = plan.ready !== false;
      if (!listens) setTimeout(() => resolveExit(1), 5);
      return {
        ready: listens ? Promise.resolve('http://127.0.0.1:41000/') : Promise.reject(new Error('exited before READY')),
        exited,
        stop: () => {
          entry.stopped = true;
          resolveExit(143);
        },
        kill: () => resolveExit(137),
        detail: () => 'The server exited with code 1.',
      };
    },
    // The window: it starts loading the page, and the page says it rendered unless its web is broken
    onReady: () => {
      const plan = current;
      setTimeout(() => {
        h.windowLoading();
        if (plan.page !== false) setTimeout(() => h.pageReady(), 10);
      }, 5);
    },
    health: async () => current.health !== false,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { h, started, lines };
}

const until = async (what: string, probe: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('with nothing downloaded the bundled payload boots, and a server that goes on its own ends the run', async () => {
  const w = world();
  const { h, started } = host(w, [{}]);
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(started[0]?.boot.dir, w.bundledDir);
  assert.equal(started[0]?.boot.bundled, true);
  assert.equal(started[0]?.boot.webDist, join(w.resources, 'web'));
  assert.equal(started[0]?.boot.version, '0.7.0');
  await until('ready', () => h.current !== null);
  started[0]?.exit(1);
  const end = await run;
  assert.equal(end.why, 'exited');
  assert.equal(end.why === 'exited' && end.ready, true);
});

test('a trial is kept once /api/health answers and its page renders', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { trial: '0.8.0' });
  const { h, started } = host(w, [{ page: true }]);
  const run = h.run();
  await until('the trial promoted', () => readState(w.dataDir).active === '0.8.0');
  const boot = started[0]?.boot;
  assert.equal(boot?.trial, true);
  assert.equal(boot?.dir, join(w.dataDir, 'app', '0.8.0'));
  assert.equal(boot?.entry, join(w.dataDir, 'app', '0.8.0', 'server.mjs'));
  assert.equal(boot?.webDist, join(w.dataDir, 'app', '0.8.0', 'web'));
  assert.equal(readState(w.dataDir).trial, null);
  await h.stop();
  assert.equal((await run).why, 'stopped');
});

test('a payload whose server answers but whose page never renders is tried twice, then rolled back', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  overlay(w.dataDir, '0.9.0', w.key);
  writeState(w.dataDir, { active: '0.8.0', trial: '0.9.0' });
  const { h, started, lines } = host(w, [{ page: false }, { page: false }, { page: true }]);
  const run = h.run();
  await until('three boots', () => started.length === 3);
  assert.deepEqual(
    started.map((s) => [s.boot.version, s.boot.trial]),
    [
      ['0.9.0', true],
      ['0.9.0', true],
      ['0.8.0', false],
    ],
  );
  assert.ok(started[0]?.stopped && started[1]?.stopped, 'each failed trial was asked to stop');
  const state = readState(w.dataDir);
  assert.equal(state.active, '0.8.0');
  assert.equal(state.trial, null);
  assert.deepEqual(state.bad, ['0.9.0']);
  assert.deepEqual((state.lastRollback as { from: string; to: string }).from, '0.9.0');
  assert.deepEqual((state.lastRollback as { from: string; to: string }).to, '0.8.0');
  assert.ok(lines.some((l) => /page did not render/.test(l)));
  await h.stop();
  await run;
});

test('a trial whose server never listens fails the same way', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { trial: '0.8.0' });
  const { h, started } = host(w, [{ ready: false }, { ready: false }, {}]);
  const run = h.run();
  await until('three boots', () => started.length === 3);
  assert.equal(started[2]?.boot.bundled, true);
  assert.deepEqual(readState(w.dataDir).bad, ['0.8.0']);
  await h.stop();
  await run;
});

test('an overlay changed after it was signed is refused at boot, marked bad, and the bundled payload boots', async () => {
  const w = world();
  const dir = overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { active: '0.8.0' });
  // An agent running as the person rewrites the server in the user-writable data dir
  writeFileSync(join(dir, 'server.mjs'), 'process.env.EVIL = 1;\n');
  const { h, started, lines } = host(w, [{}]);
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(started[0]?.boot.bundled, true);
  const state = readState(w.dataDir);
  assert.deepEqual(state.bad, ['0.8.0']);
  assert.equal(state.active, null);
  assert.ok(lines.some((l) => /overlay 0\.8\.0 refused: server\.mjs does not match/.test(l)));
  await h.stop();
  await run;
});

test('a planted file the manifest does not list is refused', async () => {
  const w = world();
  const dir = overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { active: '0.8.0' });
  mkdirSync(join(dir, 'node_modules', 'evil'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'evil', 'index.js'), '');
  const { h, started } = host(w, [{}]);
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(started[0]?.boot.bundled, true);
  await h.stop();
  await run;
});

test('an overlay signed by a key the shell does not carry never boots; a rotated key named by its id does', async () => {
  const w = world();
  const stranger = newKey();
  overlay(w.dataDir, '0.8.0', stranger, { keyed: true });
  writeState(w.dataDir, { active: '0.8.0' });
  const refused = host(w, [{}]);
  const run = refused.h.run();
  await until('a boot', () => refused.started.length === 1);
  assert.equal(refused.started[0]?.boot.bundled, true);
  assert.ok(refused.lines.some((l) => /not signed by an accepted key/.test(l)));
  await refused.h.stop();
  await run;

  // The shell ships the new key beside the old one: a bundle signed with it, its line keyed, boots
  writeFileSync(join(w.keysDir, 'rotated.pub'), stranger.publicKey.export({ type: 'spki', format: 'pem' }));
  overlay(w.dataDir, '0.8.1', stranger, { keyed: true });
  writeState(w.dataDir, { active: '0.8.1' });
  const accepted = host(w, [{}]);
  const again = accepted.h.run();
  await until('a boot', () => accepted.started.length === 1);
  assert.equal(accepted.started[0]?.boot.version, '0.8.1');
  await accepted.h.stop();
  await again;
});

test('a payload that needs a newer shell (minShell) never boots on this one', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key, { minShell: '0.8.0' });
  writeState(w.dataDir, { active: '0.8.0' });
  const { h, started, lines } = host(w, [{}]);
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(started[0]?.boot.bundled, true);
  assert.ok(lines.some((l) => /needs the desktop app 0\.8\.0 or later/.test(l)));
  await h.stop();
  await run;
});

test('CLAUDIO_PAYLOAD=bundled boots the bundled payload and leaves state.json as it is', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { active: '0.8.0' });
  const before = readFileSync(stateFile(w.dataDir), 'utf8');
  const { h, started } = host(w, [{}], { ignoreOverlays: true });
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(started[0]?.boot.bundled, true);
  assert.equal(readFileSync(stateFile(w.dataDir), 'utf8'), before);
  await h.stop();
  await run;
});

test('a shell without shell.json (a dev build) boots only what it bundles', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { active: '0.8.0' });
  const { h, started } = host(w, [{}], { shell: null });
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(started[0]?.boot.bundled, true);
  await h.stop();
  await run;
});

test('exit 75 starts the server again onto what state.json names now', async () => {
  const w = world();
  const { h, started } = host(w, [{}, { page: true }]);
  const run = h.run();
  await until('a boot', () => started.length === 1 && h.current !== null);
  // The server downloaded 0.8.0 and named it the trial, then restarts for it
  overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { trial: '0.8.0' });
  started[0]?.exit(75);
  await until('the trial promoted', () => readState(w.dataDir).active === '0.8.0');
  assert.equal(started[1]?.boot.version, '0.8.0');
  await h.stop();
  assert.equal((await run).why, 'stopped');
});

test('once the shell was replaced underneath, a restart becomes a relaunch of the app', async () => {
  const w = world();
  let replaced = false;
  const { h, started } = host(w, [{}], { relaunchInstead: () => replaced });
  const run = h.run();
  await until('a boot', () => started.length === 1);
  replaced = true;
  started[0]?.exit(75);
  const end = await run;
  assert.equal(end.why, 'relaunch');
  assert.equal(started.length, 1, 'this Electron did not start another server');
});

test('overlays nobody points at and half-done downloads are collected; the ones in use stay', async () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  overlay(w.dataDir, '0.7.5', w.key);
  mkdirSync(join(w.dataDir, 'app', '.staging-123'));
  mkdirSync(join(w.dataDir, 'app', 'not-a-version'));
  writeState(w.dataDir, { active: '0.8.0' });
  const { h, started } = host(w, [{}]);
  const run = h.run();
  await until('a boot', () => started.length === 1);
  assert.equal(existsSync(join(w.dataDir, 'app', '0.8.0')), true);
  assert.equal(existsSync(join(w.dataDir, 'app', '0.7.5')), false);
  assert.equal(existsSync(join(w.dataDir, 'app', '.staging-123')), false);
  // Only names that are versions are ever removed
  assert.equal(existsSync(join(w.dataDir, 'app', 'not-a-version')), true);
  await h.stop();
  await run;
});

test('page-ready from a page counts only while a boot runs', () => {
  const w = world();
  const { h } = host(w, []);
  h.pageReady();
  h.windowLoading();
  assert.equal(h.current, null);
});

test('forgetting the overlays points state.json at the bundled payload and deletes nothing', () => {
  const w = world();
  overlay(w.dataDir, '0.8.0', w.key);
  writeState(w.dataDir, { active: '0.8.0', previous: '0.7.5', trial: '0.9.0', attempts: 1, bad: ['0.6.9'], scheduled: '0.9.0' });
  forgetOverlays(w.dataDir, () => undefined);
  const state = readState(w.dataDir);
  assert.deepEqual([state.active, state.previous, state.trial, state.attempts, state.scheduled], [null, null, null, 0, null]);
  assert.deepEqual(state.bad, ['0.6.9']);
  assert.equal(existsSync(join(w.dataDir, 'app', '0.8.0')), true);
});

test('shell.json is read only when it is whole and names a version', () => {
  const w = world();
  const file = join(w.resources, 'shell.json');
  assert.equal(readShellJson(file), null);
  writeFileSync(file, '{"version":"0.7.0","shellInputs":"abc"}');
  assert.deepEqual(readShellJson(file), { version: '0.7.0', shellInputs: 'abc' });
  writeFileSync(file, '{"version":"../../etc","shellInputs":"abc"}');
  assert.equal(readShellJson(file), null);
  writeFileSync(file, '{"version":"0.7');
  assert.equal(readShellJson(file), null);
});

test('the page may ask for the four update writes and nothing else, with only the flags each carries', () => {
  assert.deepEqual(parsePayloadAction({ action: 'download', version: '0.8.0' }), { action: 'download', version: '0.8.0' });
  assert.deepEqual(parsePayloadAction({ action: 'download', version: '../x' }), { action: 'download' });
  assert.deepEqual(parsePayloadAction({ action: 'apply', force: 'yes', whenIdle: true, path: '/etc' }), { action: 'apply', force: false, whenIdle: true });
  assert.deepEqual(parsePayloadAction({ action: 'revert', force: true }), { action: 'revert', force: true, whenIdle: false });
  assert.deepEqual(parsePayloadAction({ action: 'cancel-scheduled' }), { action: 'cancel-scheduled' });
  assert.equal(parsePayloadAction({ action: 'install-cli' }), null);
  assert.equal(parsePayloadAction('apply'), null);

  assert.deepEqual(payloadRequest({ action: 'download', version: '0.8.0' }), { method: 'POST', path: '/api/system/server-update/download', body: { version: '0.8.0' } });
  assert.deepEqual(payloadRequest({ action: 'apply', force: true }), { method: 'POST', path: '/api/system/server-update/apply', body: { force: true, whenIdle: false } });
  assert.deepEqual(payloadRequest({ action: 'revert' }), { method: 'POST', path: '/api/system/server-update/revert', body: { force: false, whenIdle: false } });
  assert.deepEqual(payloadRequest({ action: 'cancel-scheduled' }), { method: 'DELETE', path: '/api/system/server-update/scheduled' });
});

test("a refusal reaches the page as its status and code, never the server's text", async () => {
  const refused = new Response(JSON.stringify({ error: 'chats are running', code: 'update.live-work', live: { working: 1, waiting: 0, running: 0, terminals: 2 } }), { status: 409 });
  assert.deepEqual(await payloadAnswer(refused), { status: 409, code: 'update.live-work', live: { working: 1, waiting: 0, running: 0, terminals: 2 } });
  assert.deepEqual(await payloadAnswer(new Response('not json', { status: 502 })), { status: 502, code: null });
  const ok = { state: 'downloading', target: '0.8.0' };
  assert.deepEqual(await payloadAnswer(new Response(JSON.stringify(ok), { status: 202 })), ok);
});

test("the shell reads the server's update status defensively", () => {
  assert.equal(parsePayloadFacts(null), null);
  assert.equal(parsePayloadFacts({ image: '0.7.0' }), null);
  assert.deepEqual(
    parsePayloadFacts({
      unsupportedReason: null,
      image: '0.7.0',
      running: '0.8.0',
      source: 'overlay',
      state: 'ready',
      target: '0.9.0',
      needsShell: { version: '1.0.0', minShell: '0.9.5' },
      offer: { version: '0.9.0', installable: true, blocked: null },
    }),
    {
      unsupportedReason: null,
      base: '0.7.0',
      running: '0.8.0',
      source: 'overlay',
      state: 'ready',
      target: '0.9.0',
      needsShell: { version: '1.0.0', minShell: '0.9.5' },
      offer: { version: '0.9.0', installable: true, blocked: null },
    },
  );
  const odd = parsePayloadFacts({ image: '0.7.0', running: '0.7.0', state: 'idle', source: 'elsewhere', target: '../x', needsShell: { version: 1 }, offer: { version: 'latest' } });
  assert.deepEqual([odd?.source, odd?.target, odd?.needsShell, odd?.offer], ['image', null, null, null]);
});
