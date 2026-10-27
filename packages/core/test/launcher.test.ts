import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { readState, writeState, EMPTY_STATE, type LauncherState } from '../src/launcher/protocol.ts';
import { signingKey, writeOverlay, writeTree, type SigningKey } from './bundle-helpers.ts';

const harness = fileURLToPath(new URL('./fixtures/launcher-harness.ts', import.meta.url));

/**
 * A stand-in for api.mjs. What it does comes from `behaviour` beside it; every boot appends a line
 * to `<data>/boots.log` with its directory and the environment the launcher gave it.
 */
const FAKE_API = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const behaviour = readFileSync(join(here, 'behaviour'), 'utf8').trim();
const log = join(process.env.CLAUDIO_DATA_DIR, 'boots.log');
const boots = (() => { try { return readFileSync(log, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } })();
appendFileSync(log, JSON.stringify({ dir: here, launcher: process.env.CLAUDIO_LAUNCHER, appDir: process.env.CLAUDIO_APP_DIR, guard: process.env.CLAUDIO_GUARD_ENTRY, web: process.env.CLAUDIO_WEB_DIST ?? null }) + '\\n');
process.on('SIGTERM', () => { appendFileSync(join(process.env.CLAUDIO_DATA_DIR, 'signals.log'), 'SIGTERM\\n'); process.exit(7); });
if (behaviour === 'exit0') process.exit(0);
if (behaviour === 'exit1') process.exit(1);
if (behaviour === 'restart-once') process.exit(boots === 0 ? 75 : 0);
if (behaviour === 'hang') setInterval(() => {}, 1000);
if (behaviour === 'health') {
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404).end('{}');
    if (req.url === '/api/health') setTimeout(() => process.exit(0), 300);
  });
  server.listen(Number(process.env.PORT), '127.0.0.1');
}
`;

interface Setup {
  appDir: string;
  dataDir: string;
  key: SigningKey;
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(base: string, { image = true }: { image?: boolean } = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), 'claudio-launcher-'));
  roots.push(root);
  const appDir = join(root, 'app');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeTree(appDir, { 'api.mjs': FAKE_API, behaviour: base, 'guard.mjs': '' });
  const key = signingKey();
  writeTree(appDir, { 'keys/test.pub': key.publicPem });
  if (image) writeFileSync(join(appDir, 'image.json'), JSON.stringify({ version: '0.6.0', imageInputs: 'x', nodeAbi: process.versions.modules, claudeCode: '2.1.278' }));
  return { appDir, dataDir, key };
}

function overlay(s: Setup, version: string, behaviour: string, key = s.key): string {
  const dir = join(s.dataDir, 'app', version);
  writeOverlay(dir, version, { 'api.mjs': FAKE_API, behaviour, 'web/index.html': '<!doctype html>' }, key);
  return dir;
}

function state(s: Setup, patch: Partial<LauncherState>): void {
  mkdirSync(join(s.dataDir, 'app'), { recursive: true });
  writeState(join(s.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: [], ...patch });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Run {
  code: number | null;
  boots: { dir: string; launcher: string; appDir: string; guard: string; web: string | null }[];
  stderr: string;
}

async function run(s: Setup, { env = {}, onStart }: { env?: NodeJS.ProcessEnv; onStart?: (child: ReturnType<typeof spawn>) => void } = {}): Promise<Run> {
  const port = await freePort();
  const child = spawn(process.execPath, [...process.execArgv, harness, s.appDir, s.dataDir], {
    env: { ...process.env, CLAUDIO_DATA_DIR: s.dataDir, PORT: String(port), TRIAL_MS: '3000', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  onStart?.(child);
  const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  const log = join(s.dataDir, 'boots.log');
  const boots = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Run['boots'][number]) : [];
  return { code, boots, stderr };
}

const readLauncherState = (s: Setup) => readState(join(s.dataDir, 'app', 'state.json'));

test('the plain image boots /app as before, with the image guard, and ends with the server\'s exit code', async () => {
  const s = setup('exit1', { image: false });
  const result = await run(s);
  assert.equal(result.code, 1);
  assert.equal(result.boots.length, 1);
  assert.equal(result.boots[0]?.dir, s.appDir);
  assert.equal(result.boots[0]?.launcher, '1');
  assert.equal(result.boots[0]?.appDir, s.appDir);
  assert.equal(result.boots[0]?.guard, join(s.appDir, 'guard.mjs'));
  assert.equal(existsSync(join(s.dataDir, 'app')), false, 'nothing is written without an update');
});

test('exit 75 starts the server again; any other exit ends the launcher with it', async () => {
  const s = setup('restart-once');
  const result = await run(s);
  assert.equal(result.code, 0);
  assert.equal(result.boots.length, 2);
});

test('a trial that answers /api/health becomes the active version, with its own web build', async () => {
  const s = setup('exit0');
  const dir = overlay(s, '0.7.0', 'health');
  state(s, { trial: '0.7.0' });
  const result = await run(s);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.boots.length, 1);
  assert.equal(result.boots[0]?.dir, dir);
  assert.equal(result.boots[0]?.web, join(dir, 'web'));
  assert.equal(result.boots[0]?.guard, join(s.appDir, 'guard.mjs'), 'never an overlay guard');
  const after = readLauncherState(s);
  assert.equal(after.active, '0.7.0');
  assert.equal(after.trial, null);
  assert.equal(after.attempts, 0);
});

test('a trial that fails twice is marked bad, the rollback is recorded, and /app boots', async () => {
  const s = setup('exit0');
  overlay(s, '0.7.0', 'exit1');
  state(s, { trial: '0.7.0' });
  const result = await run(s);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.boots.map((b) => b.dir),
    [join(s.dataDir, 'app', '0.7.0'), join(s.dataDir, 'app', '0.7.0'), s.appDir],
  );
  const after = readLauncherState(s);
  assert.deepEqual(after.bad, ['0.7.0']);
  assert.equal(after.trial, null);
  assert.equal(after.lastRollback?.from, '0.7.0');
  assert.equal(after.lastRollback?.to, '0.6.0');
  assert.equal(existsSync(join(s.dataDir, 'app', '0.7.0')), false, 'collected once nothing points at it');
});

test('a trial that never answers is stopped and counted as a failed boot', async () => {
  const s = setup('exit0');
  overlay(s, '0.7.0', 'hang');
  state(s, { trial: '0.7.0' });
  // 1.5 s, not 400 ms: on a loaded machine the hanging overlay could be stopped before it had even
  // recorded its boot, and the test counted two boots where three happened
  const result = await run(s, { env: { TRIAL_MS: '1500' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.boots.length, 3);
  assert.deepEqual(readLauncherState(s).bad, ['0.7.0']);
});

test('an overlay changed after it was signed is refused, marked bad, and the image runs', async () => {
  const s = setup('exit0');
  const dir = overlay(s, '0.7.0', 'exit0');
  appendFileSync(join(dir, 'api.mjs'), '\n// changed by an agent\n');
  state(s, { active: '0.7.0' });
  const result = await run(s);
  assert.equal(result.code, 0);
  assert.equal(result.boots[0]?.dir, s.appDir);
  const after = readLauncherState(s);
  assert.equal(after.active, null);
  assert.deepEqual(after.bad, ['0.7.0']);
  assert.equal(after.lastRollback?.from, '0.7.0');
  assert.match(result.stderr, /api\.mjs does not match/);
});

test('an overlay signed by a key the image does not carry, or with a planted file, is refused', async () => {
  const s = setup('exit0');
  overlay(s, '0.7.0', 'exit0', signingKey());
  const planted = overlay(s, '0.7.1', 'exit0');
  writeTree(planted, { 'node_modules/evil/index.js': 'process.exit(3)' });
  state(s, { trial: '0.7.1', active: '0.7.0' });
  const result = await run(s);
  assert.equal(result.boots[0]?.dir, s.appDir);
  assert.deepEqual(readLauncherState(s).bad.sort(), ['0.7.0', '0.7.1']);
  assert.match(result.stderr, /not signed by an accepted key/);
  assert.match(result.stderr, /node_modules\/evil\/index\.js is not in the manifest/);
});

test('an overlay not newer than the image is refused, and the previous good one is the fallback', async () => {
  const s = setup('exit0');
  overlay(s, '0.5.0', 'exit0');
  const previous = overlay(s, '0.6.5', 'exit0');
  state(s, { active: '0.5.0', previous: '0.6.5' });
  const result = await run(s);
  assert.equal(result.boots[0]?.dir, previous);
  const after = readLauncherState(s);
  assert.equal(after.active, '0.6.5');
  assert.equal(after.previous, null);
});

test('a trial not newer than the active overlay is refused, and the active one keeps running', async () => {
  const s = setup('exit0');
  overlay(s, '0.6.8', 'exit0');
  const active = overlay(s, '0.7.0', 'exit0');
  state(s, { trial: '0.6.8', active: '0.7.0' });
  const result = await run(s);
  assert.equal(result.boots[0]?.dir, active);
  const after = readLauncherState(s);
  assert.equal(after.trial, null);
  assert.equal(after.active, '0.7.0');
  assert.deepEqual(after.bad, ['0.6.8']);
  assert.equal(after.lastRollback?.to, '0.7.0');
  assert.match(result.stderr, /0\.6\.8 is not newer than the active 0\.7\.0/);
});

test('a version in state.json is never a path', async () => {
  const s = setup('exit0');
  mkdirSync(join(s.dataDir, 'app'), { recursive: true });
  writeFileSync(join(s.dataDir, 'app', 'state.json'), JSON.stringify({ trial: '../../app', active: '/etc', bad: ['x/../y'] }));
  const result = await run(s);
  assert.equal(result.boots[0]?.dir, s.appDir);
  assert.deepEqual(readLauncherState(s), { ...EMPTY_STATE, bad: [] });
});

test('overlays and CLI versions nobody points at are collected; a CLI not newer than the pin gives way', async () => {
  const s = setup('exit0');
  overlay(s, '0.7.0', 'exit0');
  overlay(s, '0.6.9', 'exit0');
  mkdirSync(join(s.dataDir, 'app', '.staging-0.8.0'), { recursive: true });
  mkdirSync(join(s.dataDir, 'app', 'not-a-version'), { recursive: true });
  state(s, { active: '0.7.0' });
  const cli = join(s.dataDir, 'cli');
  for (const v of ['2.1.290', '2.1.300']) writeTree(join(cli, v), { 'bin/claude': '' });
  symlinkSync('2.1.300', join(cli, 'current'));
  await run(s);
  assert.equal(existsSync(join(s.dataDir, 'app', '0.7.0')), true);
  assert.equal(existsSync(join(s.dataDir, 'app', '0.6.9')), false);
  assert.equal(existsSync(join(s.dataDir, 'app', '.staging-0.8.0')), false);
  assert.equal(existsSync(join(s.dataDir, 'app', 'not-a-version')), true, 'only names that are versions are touched');
  assert.equal(readlinkSync(join(cli, 'current')), '2.1.300');
  assert.equal(existsSync(join(cli, '2.1.290')), false);

  // A newer image pins past the CLI installed in /data: the link goes, and so does the version
  writeFileSync(join(s.appDir, 'image.json'), JSON.stringify({ version: '0.6.0', imageInputs: 'x', nodeAbi: process.versions.modules, claudeCode: '2.1.300' }));
  await run(s);
  assert.equal(existsSync(join(cli, 'current')), false);
  assert.equal(existsSync(join(cli, '2.1.300')), false);
});

test('SIGTERM goes to the server, and the launcher ends with the server\'s code', async () => {
  const s = setup('hang');
  const result = await run(s, {
    onStart: (child) => {
      const timer = setInterval(() => {
        if (existsSync(join(s.dataDir, 'boots.log'))) {
          clearInterval(timer);
          child.kill('SIGTERM');
        }
      }, 50);
    },
  });
  assert.equal(result.code, 7);
  assert.equal(readFileSync(join(s.dataDir, 'signals.log'), 'utf8'), 'SIGTERM\n');
  assert.equal(result.boots.length, 1, 'not started again');
});
