import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AuthMode, ClaudioEvent, LiveWork } from '@claudio/shared';
import { EventBus } from '../src/events.ts';
import { EMPTY_STATE, readState, writeState } from '../src/launcher/protocol.ts';
import { ServerUpdateRefusal, ServerUpdates } from '../src/updates/server-update.ts';
import { releaseAssets, signingKey, type SigningKey } from './bundle-helpers.ts';

const FILES = { 'api.mjs': 'export {};\n', 'mcp.mjs': '', 'web/index.html': '<!doctype html>', 'node_modules/node-pty/package.json': '{}' };

interface World {
  updates: ServerUpdates;
  /** Another server on the same data dir, as after a restart */
  make: () => ServerUpdates;
  dataDir: string;
  key: SigningKey;
  urls: string[];
  serve: Map<string, Buffer | string>;
  audits: { method: string; path: string; summary: string }[];
  restarts: number;
  live: LiveWork;
  security: { mode: AuthMode; readOnly: boolean };
  events: ClaudioEvent[];
  assets: { name: string; url: string }[];
  release: { version: string } | null;
}

function world(options: { env?: NodeJS.ProcessEnv; distribution?: string; running?: string; signWith?: SigningKey; extra?: Parameters<typeof releaseAssets>[4]; tamper?: boolean; fromOverlay?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'claudio-server-update-'));
  const dataDir = join(root, 'data');
  const keysDir = join(root, 'keys');
  mkdirSync(keysDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const key = signingKey();
  writeFileSync(join(keysDir, 'test.pub'), key.publicPem);
  const imageDir = join(root, 'app');
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(join(imageDir, 'image.json'), JSON.stringify({ version: '0.6.0', imageInputs: 'x', nodeAbi: process.versions.modules, claudeCode: null }));

  const assets = releaseAssets(root, '0.7.0', FILES, options.signWith ?? key, options.extra);
  const serve = new Map<string, Buffer | string>([
    ['https://r.test/m.json', assets.bytes],
    ['https://r.test/m.json.sig', assets.signature],
    ['https://r.test/t.tar.gz', options.tamper ? Buffer.concat([assets.tarball.subarray(0, -1), Buffer.from([(assets.tarball.at(-1) ?? 0) ^ 0xff])]) : assets.tarball],
  ]);
  const w: World = {
    dataDir,
    key,
    urls: [],
    serve,
    audits: [],
    restarts: 0,
    live: { working: 0, waiting: 0, running: 0 },
    security: { mode: 'token', readOnly: false },
    events: [],
    assets: [
      { name: 'claudio-server-0.7.0-linux-x64.json', url: 'https://r.test/m.json' },
      { name: 'claudio-server-0.7.0-linux-x64.json.sig', url: 'https://r.test/m.json.sig' },
      { name: 'claudio-server-0.7.0-linux-x64.tar.gz', url: 'https://r.test/t.tar.gz' },
    ],
    release: { version: '0.7.0' },
    updates: undefined as unknown as ServerUpdates,
    make: () => undefined as unknown as ServerUpdates,
  };
  const events = new EventBus();
  events.observe((event) => {
    if (event.type === 'system.server-update') w.events.push(event);
  });
  const fetchFn = (async (url: string | URL | Request) => {
    w.urls.push(String(url));
    const body = w.serve.get(String(url));
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body));
  }) as typeof fetch;
  w.make = () => new ServerUpdates({
    dataDir,
    distribution: options.distribution ?? 'docker',
    running: options.running ?? '0.6.0',
    env: {
      CLAUDIO_LAUNCHER: '1',
      CLAUDIO_BUNDLE_KEYS_DIR: keysDir,
      ...(options.fromOverlay ? { CLAUDIO_APP_DIR: join(dataDir, 'app', options.fromOverlay) } : {}),
      ...options.env,
    },
    fetch: fetchFn,
    release: () => (w.release ? { version: w.release.version, assets: w.assets } : null),
    security: () => w.security,
    liveWork: async () => w.live,
    audit: (row) => w.audits.push(row),
    events,
    imageDir,
    idleCheckMs: 20,
  });
  w.updates = w.make();
  w.updates.onRestart = () => {
    w.restarts += 1;
  };
  return w;
}

const stateOf = (w: World) => readState(join(w.dataDir, 'app', 'state.json'));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function refusal(promise: Promise<unknown> | (() => unknown)): Promise<ServerUpdateRefusal> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (err) {
    assert.ok(err instanceof ServerUpdateRefusal, String(err));
    return err;
  }
  assert.fail('expected a refusal');
}

test('a signed release is downloaded, checked, unpacked into /data/app/<v> and made the trial', async () => {
  const w = world();
  const started = await w.updates.download();
  assert.equal(started.state, 'downloading');
  assert.equal(started.target, '0.7.0');
  await w.updates.pending;
  const status = w.updates.status();
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.error, null);
  const dir = join(w.dataDir, 'app', '0.7.0');
  assert.equal(readFileSync(join(dir, 'api.mjs'), 'utf8'), FILES['api.mjs']);
  assert.ok(existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'manifest.json.sig')));
  assert.equal(stateOf(w).trial, '0.7.0');
  assert.deepEqual(w.events.map((e) => (e.type === 'system.server-update' ? e.status.state : '')), ['downloading', 'verifying', 'ready']);
  assert.deepEqual(w.urls, ['https://r.test/m.json', 'https://r.test/m.json.sig', 'https://r.test/t.tar.gz']);
  assert.equal(w.make().status().state, 'ready', 'a staged bundle is still ready after a restart');
});

test('a manifest signed by another key is refused before the tarball is fetched', async () => {
  const w = world({ signWith: signingKey() });
  const status = await w.updates.download();
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'bad-signature');
  assert.equal(w.urls.includes('https://r.test/t.tar.gz'), false);
  assert.equal(existsSync(join(w.dataDir, 'app', '0.7.0')), false);
});

test('a tarball that does not match its signed manifest is discarded', async () => {
  const w = world({ tamper: true });
  await w.updates.download();
  await w.updates.pending;
  const status = w.updates.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'bad-signature');
  assert.equal(existsSync(join(w.dataDir, 'app', '0.7.0')), false);
  assert.equal(existsSync(join(w.dataDir, 'app', '.staging-0.7.0')), false);
  assert.equal(stateOf(w).trial, null);
});

test('a release that needs a newer image answers 412 and says so in the status, also after a release check', async () => {
  const w = world({ extra: { minImage: '0.7.0' } });
  const refused = await refusal(w.updates.download());
  assert.equal(refused.statusCode, 412);
  assert.equal(refused.reason, 'update.needs-image');
  assert.deepEqual(w.updates.status().needsImage, { version: '0.7.0', minImage: '0.7.0' });
  assert.equal(w.updates.status().state, 'idle');

  const fresh = world({ extra: { minImage: '0.7.0' } });
  await fresh.updates.inspect();
  assert.deepEqual(fresh.updates.status().needsImage, { version: '0.7.0', minImage: '0.7.0' });
});

test('nothing newer, no bundle, or a version that was rolled back is not offered', async () => {
  const w = world({ running: '0.7.0' });
  assert.equal((await refusal(w.updates.download())).reason, 'update.no-release');
  const other = world();
  assert.equal((await refusal(other.updates.download('0.7.1'))).statusCode, 404);
  mkdirSync(join(other.dataDir, 'app'), { recursive: true });
  writeState(join(other.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: ['0.7.0'] });
  assert.match((await refusal(other.updates.download())).message, /did not start here before/);
  other.assets = [];
  assert.equal((await refusal(other.updates.download())).reason, 'update.no-release');
});

test('why a container cannot update itself, in the order the card reads it', async () => {
  assert.equal(world({ distribution: 'deb' }).updates.status().unsupportedReason, 'not-docker');
  assert.equal(world({ env: { CLAUDIO_LAUNCHER: '' } }).updates.status().unsupportedReason, 'no-launcher');
  assert.equal(world({ env: { CLAUDIO_SERVER_UPDATE: 'off' } }).updates.status().unsupportedReason, 'no-launcher');
  assert.equal(world({ env: { CLAUDIO_BUNDLE_KEYS_DIR: join(tmpdir(), 'no-such-keys') } }).updates.status().unsupportedReason, 'no-keys');
  const w = world();
  w.security = { mode: 'none', readOnly: false };
  assert.equal(w.updates.status().unsupportedReason, 'needs-auth');
  assert.equal((await refusal(w.updates.download())).reason, 'update.needs-auth');
  w.security = { mode: 'token', readOnly: true };
  assert.equal(w.updates.status().unsupportedReason, 'read-only');
  assert.equal((await refusal(w.updates.download())).statusCode, 400);
  w.security = { mode: 'token', readOnly: false };
  assert.equal(w.updates.status().unsupportedReason, null);
  assert.equal(w.updates.status().image, '0.6.0');
  assert.equal(w.updates.status().source, 'image');
});

test('apply over live work answers 409 with the counts; with force it restarts and leaves an audit row', async () => {
  const w = world();
  assert.equal((await refusal(w.updates.apply())).reason, 'update.not-ready');
  await w.updates.download();
  await w.updates.pending;
  w.live = { working: 1, waiting: 2, running: 0 };
  const busy = await refusal(w.updates.apply());
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.reason, 'update.live-work');
  assert.deepEqual(busy.live, { working: 1, waiting: 2, running: 0 });
  assert.equal(w.restarts, 0);

  const status = await w.updates.apply({ force: true });
  assert.equal(status.state, 'restarting');
  assert.equal(status.target, '0.7.0');
  await sleep(400);
  assert.equal(w.restarts, 1);
  assert.match(w.audits[0]?.summary ?? '', /restarting onto Claudio 0\.7\.0/);
  assert.equal((await refusal(w.updates.download())).reason, 'update.busy');
});

test('whenIdle waits until nothing is live, and a scheduled restart can be called off', async () => {
  const w = world();
  await w.updates.download();
  await w.updates.pending;
  w.live = { working: 0, waiting: 0, running: 1 };
  assert.equal((await w.updates.apply({ whenIdle: true })).state, 'scheduled');
  assert.equal(stateOf(w).scheduled, '0.7.0');
  await sleep(100);
  assert.equal(w.restarts, 0);
  assert.equal(w.updates.cancelScheduled().state, 'ready');
  assert.equal(stateOf(w).scheduled, null);

  await w.updates.apply({ whenIdle: true });
  w.live = { working: 0, waiting: 0, running: 0 };
  await sleep(400);
  assert.equal(w.restarts, 1);
  assert.equal(w.updates.status().state, 'restarting');
  w.updates.close();
});

test("revert forgets every overlay and restarts onto the image's /app", async () => {
  const image = world();
  assert.equal((await refusal(image.updates.revert({ force: true }))).reason, 'update.not-overlay');
  assert.equal(world({ env: { CLAUDIO_APP_DIR: join(tmpdir(), 'elsewhere', 'app', '0.7.0') } }).updates.status().source, 'image', 'judged against its own data dir');

  const w = world({ running: '0.7.0', fromOverlay: '0.7.0' });
  mkdirSync(join(w.dataDir, 'app'), { recursive: true });
  writeState(join(w.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: [], active: '0.7.0', previous: '0.6.5' });
  assert.equal(w.updates.status().source, 'overlay');
  w.live = { working: 1, waiting: 0, running: 0 };
  assert.equal((await refusal(w.updates.revert())).reason, 'update.live-work');
  const status = await w.updates.revert({ force: true });
  assert.equal(status.state, 'restarting');
  assert.equal(status.target, '0.6.0');
  const after = stateOf(w);
  assert.equal(after.active, null);
  assert.equal(after.previous, null);
  await sleep(400);
  assert.equal(w.restarts, 1);
});

test('a rollback the launcher made is written to the audit trail once', () => {
  const w = world();
  mkdirSync(join(w.dataDir, 'app'), { recursive: true });
  writeState(join(w.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: ['0.7.0'], lastRollback: { from: '0.7.0', to: '0.6.0', at: '2026-10-18T10:00:00.000Z' } });
  w.updates.auditRollback();
  w.updates.auditRollback();
  assert.equal(w.audits.length, 1);
  assert.match(w.audits[0]?.summary ?? '', /0\.7\.0 did not start; the launcher went back to 0\.6\.0/);
  assert.deepEqual(w.updates.status().lastRollback, { from: '0.7.0', to: '0.6.0', at: '2026-10-18T10:00:00.000Z' });
});
