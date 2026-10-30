import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AuthMode, ClaudioEvent, LiveWork } from '@claudio/shared';
import { EventBus } from '../src/events.ts';
import { EMPTY_STATE, readState, writeState } from '../src/launcher/protocol.ts';
import type { DownloadTuning } from '../src/updates/download.ts';
import { ServerUpdateRefusal, ServerUpdates } from '../src/updates/server-update.ts';
import { releaseAssets, signingKey, type SigningKey } from './bundle-helpers.ts';
import { head, rawServer, writeInPieces, type RawServer } from './raw-http-server.ts';
import { setTimeout as sleep } from 'node:timers/promises';

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

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function world(
  options: {
    env?: NodeJS.ProcessEnv;
    distribution?: string;
    running?: string;
    signWith?: SigningKey;
    extra?: Parameters<typeof releaseAssets>[4];
    tamper?: boolean;
    fromOverlay?: string;
    desktop?: boolean;
    /** Serve the release from this origin over real HTTP instead of an injected `fetch` */
    origin?: string;
    download?: DownloadTuning;
  } = {},
): World {
  const root = mkdtempSync(join(tmpdir(), 'claudio-server-update-'));
  roots.push(root);
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
  const origin = options.origin ?? 'https://r.test';
  const serve = new Map<string, Buffer | string>([
    [`${origin}/m.json`, assets.bytes],
    [`${origin}/m.json.sig`, assets.signature],
    [`${origin}/t.tar.gz`, options.tamper ? Buffer.concat([assets.tarball.subarray(0, -1), Buffer.from([(assets.tarball.at(-1) ?? 0) ^ 0xff])]) : assets.tarball],
  ]);
  const w: World = {
    dataDir,
    key,
    urls: [],
    serve,
    audits: [],
    restarts: 0,
    live: { working: 0, waiting: 0, running: 0, terminals: 0 },
    security: { mode: 'token', readOnly: false },
    events: [],
    assets: [
      { name: 'claudio-server-0.7.0-linux-x64.json', url: `${origin}/m.json` },
      { name: 'claudio-server-0.7.0-linux-x64.json.sig', url: `${origin}/m.json.sig` },
      { name: 'claudio-server-0.7.0-linux-x64.tar.gz', url: `${origin}/t.tar.gz` },
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
    distribution: options.distribution ?? (options.desktop ? 'deb' : 'docker'),
    running: options.running ?? '0.6.0',
    env: {
      // The desktop shell 0.6.0 bundles the payload 0.6.0, as the image does
      ...(options.desktop
        ? { CLAUDIO_LAUNCHER: 'desktop', CLAUDIO_SHELL_VERSION: '0.6.0', CLAUDIO_SHELL_PACKAGE: 'deb', CLAUDIO_SHELL_INPUTS: 'shell-inputs', CLAUDIO_SHELL_APT: '1' }
        : { CLAUDIO_LAUNCHER: '1' }),
      CLAUDIO_BUNDLE_KEYS_DIR: keysDir,
      ...(options.fromOverlay ? { CLAUDIO_APP_DIR: join(dataDir, 'app', options.fromOverlay) } : {}),
      ...options.env,
    },
    ...(options.origin ? {} : { fetch: fetchFn }),
    ...(options.download ? { download: options.download } : {}),
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
  assert.equal(world({ distribution: 'source' }).updates.status().unsupportedReason, 'not-docker');
  assert.equal(world({ distribution: 'deb' }).updates.status().unsupportedReason, 'no-launcher', 'a desktop install its shell does not supervise');
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
  w.live = { working: 1, waiting: 2, running: 0, terminals: 0 };
  const busy = await refusal(w.updates.apply());
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.reason, 'update.live-work');
  assert.deepEqual(busy.live, { working: 1, waiting: 2, running: 0, terminals: 0 });
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
  w.live = { working: 0, waiting: 0, running: 1, terminals: 0 };
  assert.equal((await w.updates.apply({ whenIdle: true })).state, 'scheduled');
  assert.equal(stateOf(w).scheduled, '0.7.0');
  await sleep(100);
  assert.equal(w.restarts, 0);
  assert.equal(w.updates.cancelScheduled().state, 'ready');
  assert.equal(stateOf(w).scheduled, null);

  await w.updates.apply({ whenIdle: true });
  w.live = { working: 0, waiting: 0, running: 0, terminals: 0 };
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
  w.live = { working: 1, waiting: 0, running: 0, terminals: 0 };
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

test('an open terminal is live work: a restart over it answers 409 with the count', async () => {
  const w = world();
  await w.updates.download();
  await w.updates.pending;
  w.live = { working: 0, waiting: 0, running: 0, terminals: 2 };
  const busy = await refusal(w.updates.apply());
  assert.equal(busy.reason, 'update.live-work');
  assert.equal(busy.live?.terminals, 2);
  assert.equal(w.restarts, 0);
});

test('the installable check offers a signed release that fits, before any download', async () => {
  const w = world();
  assert.equal(w.updates.status().offer, null, 'nothing judged yet');
  await w.updates.inspect();
  assert.deepEqual(w.updates.status().offer, { version: '0.7.0', installable: true, blocked: null });
  assert.deepEqual(w.urls, ['https://r.test/m.json', 'https://r.test/m.json.sig'], 'only the manifest is fetched');
  assert.equal(existsSync(join(w.dataDir, 'app')), false, 'nothing written');

  // Once this server runs it, there is nothing to offer
  const running = world({ running: '0.7.0' });
  await running.updates.inspect();
  assert.equal(running.updates.status().offer, null);
});

test('a release without a bundle, or whose manifest names a tarball it does not attach, is not installable', async () => {
  const w = world();
  w.assets = [];
  await w.updates.inspect();
  assert.deepEqual(w.updates.status().offer, { version: '0.7.0', installable: false, blocked: 'no-bundle' });
  assert.deepEqual(w.urls, [], 'nothing to fetch');
  // The download still refuses on its own
  assert.equal((await refusal(w.updates.download())).reason, 'update.no-release');

  const noTarball = world();
  noTarball.assets = noTarball.assets.filter((a) => !a.name.endsWith('.tar.gz'));
  await noTarball.updates.inspect();
  assert.equal(noTarball.updates.status().offer?.blocked, 'no-bundle');
});

test('a manifest that does not verify, or cannot be fetched, is not offered', async () => {
  const forged = world({ signWith: signingKey() });
  await forged.updates.inspect();
  assert.deepEqual(forged.updates.status().offer, { version: '0.7.0', installable: false, blocked: 'unverified' });

  const unreachable = world();
  unreachable.serve.clear();
  await unreachable.updates.inspect();
  assert.equal(unreachable.updates.status().offer?.blocked, 'unverified');
});

test('a release that failed here before is not offered again, also when it failed after it was judged', async () => {
  const w = world();
  mkdirSync(join(w.dataDir, 'app'), { recursive: true });
  writeState(join(w.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: ['0.7.0'] });
  await w.updates.inspect();
  assert.deepEqual(w.updates.status().offer, { version: '0.7.0', installable: false, blocked: 'failed-before' });

  const later = world();
  await later.updates.inspect();
  assert.equal(later.updates.status().offer?.installable, true);
  mkdirSync(join(later.dataDir, 'app'), { recursive: true });
  writeState(join(later.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: ['0.7.0'] });
  assert.equal(later.updates.status().offer?.blocked, 'failed-before');
});

test('a release that needs a newer image is judged needs-image by the check', async () => {
  const w = world({ extra: { minImage: '0.7.0' } });
  await w.updates.inspect();
  assert.deepEqual(w.updates.status().offer, { version: '0.7.0', installable: false, blocked: 'needs-image' });
  assert.equal(w.updates.status().needsShell, null);
});

test('a host that cannot update at all is not judged and fetches nothing', async () => {
  const w = world({ distribution: 'source' });
  await w.updates.inspect();
  assert.equal(w.updates.status().offer, null);
  assert.deepEqual(w.urls, []);
});

test('on the desktop the base is the shell: its version, its facts, and keys only where the shell says', () => {
  const w = world({ desktop: true });
  const status = w.updates.status();
  assert.equal(status.base, 'shell');
  assert.equal(status.image, '0.6.0');
  assert.equal(status.unsupportedReason, null);
  assert.deepEqual(status.shell, { version: '0.6.0', package: 'deb', shellInputs: 'shell-inputs', aptManaged: true });
  assert.equal(world().updates.status().base, 'image');
  assert.equal(world().updates.status().shell, null);
  assert.equal(world({ desktop: true, env: { CLAUDIO_BUNDLE_KEYS_DIR: '' } }).updates.status().unsupportedReason, 'no-keys', 'never /app/keys on the desktop');
  assert.equal(world({ desktop: true, distribution: 'source' }).updates.status().unsupportedReason, 'development');
  assert.equal(world({ desktop: true, env: { CLAUDIO_SERVER_UPDATE: 'off' } }).updates.status().unsupportedReason, 'no-launcher');
});

test('under auth none only the desktop shell itself may update its payload', async () => {
  const w = world({ desktop: true });
  w.security = { mode: 'none', readOnly: false };
  assert.equal(w.updates.status().unsupportedReason, 'needs-auth');
  assert.equal((await refusal(w.updates.download())).reason, 'update.needs-auth');
  assert.equal(w.updates.status(true).unsupportedReason, null);
  assert.equal((await w.updates.download(undefined, true)).state, 'downloading');
  await w.updates.pending;
  assert.equal(w.updates.status().state, 'ready');
  w.security = { mode: 'none', readOnly: true };
  assert.equal(w.updates.status(true).unsupportedReason, 'read-only', 'read-only holds for the shell too');

  // A container has no shell: `fromShell` changes nothing there
  const container = world();
  container.security = { mode: 'none', readOnly: false };
  assert.equal(container.updates.status(true).unsupportedReason, 'needs-auth');
});

test('on the desktop a bundle built for another Node ABI installs, and one that needs a newer shell answers 412 needs-shell', async () => {
  const w = world({ desktop: true, extra: { nodeAbi: '1' } });
  await w.updates.inspect();
  assert.equal(w.updates.status().offer?.installable, true, "the ABI is not the desktop's test: both native modules are N-API");
  await w.updates.download();
  await w.updates.pending;
  assert.equal(w.updates.status().state, 'ready', JSON.stringify(w.updates.status()));

  const old = world({ desktop: true, extra: { minShell: '0.7.0' } });
  await old.updates.inspect();
  assert.deepEqual(old.updates.status().offer, { version: '0.7.0', installable: false, blocked: 'needs-shell' });
  assert.deepEqual(old.updates.status().needsShell, { version: '0.7.0', minShell: '0.7.0' });
  assert.equal(old.updates.status().needsImage, null);
  const refused = await refusal(old.updates.download());
  assert.equal(refused.statusCode, 412);
  assert.equal(refused.reason, 'update.needs-shell');
  assert.equal(old.updates.status().state, 'idle');
  assert.equal(old.urls.includes('https://r.test/t.tar.gz'), false, 'the tarball is never fetched');

  // In the container a bundle's minShell is not a test
  const container = world({ extra: { minShell: '9.0.0' } });
  await container.updates.inspect();
  assert.equal(container.updates.status().offer?.installable, true);
});

test("on the desktop revert restarts onto the shell's bundled payload", async () => {
  const w = world({ desktop: true, running: '0.7.0', fromOverlay: '0.7.0' });
  mkdirSync(join(w.dataDir, 'app'), { recursive: true });
  writeState(join(w.dataDir, 'app', 'state.json'), { ...EMPTY_STATE, bad: [], active: '0.7.0' });
  const status = await w.updates.revert({ force: true });
  assert.equal(status.target, '0.6.0');
  assert.match(w.audits[0]?.summary ?? '', /the desktop app's Claudio 0\.6\.0/);
  assert.equal(stateOf(w).active, null);
  await sleep(400);
  assert.equal(w.restarts, 1);
});

/**
 * The release served over real HTTP by a raw server whose tarball answers come from `tarball`;
 * the manifest and its signature are served whole.
 */
async function overHttp(tarball: (index: number, body: Buffer, socket: Socket, range: string | undefined) => Promise<void>, download: DownloadTuning) {
  let w: World | null = null;
  let tarballRequests = 0;
  const server: RawServer = await rawServer(async (req, socket) => {
    const body = w?.serve.get(server.url(req.path));
    if (body === undefined) return void socket.end(head('404 Not Found', { 'content-length': 0 }));
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    if (req.path !== '/t.tar.gz') return void socket.end(Buffer.concat([Buffer.from(head('200 OK', { 'content-length': bytes.length })), bytes]));
    await tarball(tarballRequests++, bytes, socket, req.headers.range);
  });
  after(() => server.close());
  w = world({ origin: server.url(''), download });
  return { w, server };
}

test('a bundle download that loses its connection is resumed with Range, verified whole and staged', async () => {
  const waits: number[] = [];
  const { w, server } = await overHttp(
    async (index, body, socket, range) => {
      if (index === 0) {
        socket.write(head('200 OK', { 'content-length': body.length, 'accept-ranges': 'bytes', etag: '"b1"' }));
        await writeInPieces(socket, body.subarray(0, Math.floor(body.length / 2)), 256);
        setTimeout(() => socket.destroy(), 50);
        return;
      }
      const from = Number(/^bytes=(\d+)-$/.exec(range ?? '')?.[1] ?? 0);
      socket.write(head('206 Partial Content', { 'content-length': body.length - from, 'content-range': `bytes ${String(from)}-${String(body.length - 1)}/${String(body.length)}` }));
      await writeInPieces(socket, body.subarray(from), 256);
      socket.end();
    },
    { wait: async (ms) => void waits.push(ms) },
  );
  await w.updates.download();
  await w.updates.pending;
  const status = w.updates.status();
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(stateOf(w).trial, '0.7.0');
  assert.deepEqual(waits, [2_000]);
  const ranged = server.requests.filter((r) => r.path === '/t.tar.gz').map((r) => r.headers.range ?? null);
  assert.equal(ranged.length, 2);
  assert.equal(ranged[0], null);
  assert.match(ranged[1] ?? '', /^bytes=\d+-$/);
  assert.equal(readFileSync(join(w.dataDir, 'app', '0.7.0', 'api.mjs'), 'utf8'), FILES['api.mjs']);
});

test('a bundle download whose connection keeps dropping fails as download-interrupted and leaves nothing behind', async () => {
  const { w } = await overHttp(
    async (_index, body, socket) => {
      socket.write(head('200 OK', { 'content-length': body.length, connection: 'close' }));
      await writeInPieces(socket, body.subarray(0, Math.floor(body.length / 3)), 256);
      socket.end();
    },
    { wait: async () => undefined },
  );
  await w.updates.download();
  await w.updates.pending;
  const status = w.updates.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'download-interrupted');
  assert.equal(stateOf(w).trial, null);
  const left = existsSync(join(w.dataDir, 'app')) ? readdirSync(join(w.dataDir, 'app')).filter((name) => name !== 'state.json') : [];
  assert.deepEqual(left, [], 'no partial tarball and no staging directory');
});
