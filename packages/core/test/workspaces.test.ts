import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { migrate } from '../src/db.ts';
import { WorkspaceRefusal, Workspaces, workspaceSettingsFromEnv, type WorkspaceChats, type WorkspaceSettings } from '../src/workspaces/index.ts';

// Workspaces take archives from outside (docs/plans/headless-image.md, D7): every refusal below is
// an archive built here to break one rule, and each must leave nothing behind, neither a folder nor
// a row.

// ---------- a tar writer, for the archives the tests need ----------

function header(name: string, opts: { type?: string; size?: number; linkname?: string; prefix?: string } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${(opts.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(opts.type ?? '0', 156, 'latin1');
  if (opts.linkname) h.write(opts.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  if (opts.prefix) h.write(opts.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function file(name: string, body: string | Buffer = '', opts: { type?: string; linkname?: string; prefix?: string } = {}): Buffer {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  return Buffer.concat([header(name, { ...opts, size: data.length }), pad(data)]);
}

const dir = (name: string): Buffer => header(name.endsWith('/') ? name : `${name}/`, { type: '5' });

function pax(records: Record<string, string>, type = 'x'): Buffer {
  const body = Object.entries(records)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let len = rest.length + 1;
      while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
      return `${String(len)}${rest}`;
    })
    .join('');
  return file('PaxHeader', body, { type });
}

const gnuLong = (name: string): Buffer => file('././@LongLink', `${name}\0`, { type: 'L' });

const tar = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, Buffer.alloc(1024)]);
const tgz = (...parts: Buffer[]): Buffer => gzipSync(tar(...parts));

// ---------- a service over a temporary root ----------

const MB = 1024 * 1024;
const bases: string[] = [];

interface Rig {
  ws: Workspaces;
  root: string;
  sql: DatabaseSync;
  running: Array<{ id: string; dirs: string[] }>;
  stopped: string[];
  clock: { now: number };
}

function rig(settings: Partial<WorkspaceSettings> = {}, download?: ConstructorParameters<typeof Workspaces>[0]['download']): Rig {
  const base = mkdtempSync(join(tmpdir(), 'claudio-ws-'));
  bases.push(base);
  const root = join(base, 'workspaces');
  const sql = new DatabaseSync(':memory:');
  migrate(sql);
  const running: Rig['running'] = [];
  const stopped: string[] = [];
  const clock = { now: Date.parse('2026-10-28T10:00:00Z') };
  const chats: WorkspaceChats = {
    running: () => running,
    stop: (id) => {
      stopped.push(id);
      const at = running.findIndex((c) => c.id === id);
      if (at >= 0) running.splice(at, 1);
    },
    exited: async () => undefined,
  };
  const ws = new Workspaces({
    sql,
    chats,
    now: () => clock.now,
    settings: {
      root,
      hosts: ['localhost'],
      maxCompressedBytes: 100 * MB,
      maxExtractedBytes: 500 * MB,
      maxEntries: 50_000,
      timeoutMs: 60_000,
      maxCount: 20,
      maxTotalBytes: 2048 * MB,
      ttlMs: 2 * 60 * 60_000,
      ...settings,
    },
    ...(download ? { download } : {}),
  });
  return { ws, root, sql, running, stopped, clock };
}

/** Workspaces are sealed read-only: their folders are made writable again before they go */
function unseal(path: string): void {
  if (!statSync(path).isDirectory()) return;
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) unseal(join(path, name));
}

after(() => {
  for (const server of servers) server.close();
  for (const base of bases) {
    unseal(base);
    rmSync(base, { recursive: true, force: true });
  }
});

const upload = (ws: Workspaces, archive: Buffer) => ws.create({ kind: 'upload', body: Readable.from([archive]) });

async function refused(promise: Promise<unknown>, code: string): Promise<WorkspaceRefusal> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkspaceRefusal, `expected a refusal, got ${String(err)}`);
    assert.equal(err.reason, code, err.message);
    return err;
  }
  assert.fail(`expected ${code}`);
}

/** Nothing left: no folder under the root and no row */
function empty(r: Rig): void {
  const left = existsSync(r.root) ? readdirSync(r.root) : [];
  assert.deepEqual(left, []);
  assert.deepEqual(r.sql.prepare('SELECT id FROM workspaces').all(), []);
}

// ---------- extraction ----------

test('an archive with one top-level directory becomes a read-only workspace whose working directory is that directory', async () => {
  const r = rig();
  const created = await upload(r.ws, tgz(pax({ comment: 'abc123' }, 'g'), dir('owner-repo-abc123'), file('owner-repo-abc123/README.md', '# hi\n'), dir('owner-repo-abc123/src'), file('owner-repo-abc123/src/a.ts', 'export {};\n')));
  assert.match(created.id, /^ws_[A-Za-z0-9_-]{16}$/);
  assert.equal(created.source, 'upload');
  assert.equal(created.host, null);
  assert.equal(created.state, 'ready');
  assert.equal(created.files, 2);
  assert.equal(created.bytes, '# hi\n'.length + 'export {};\n'.length);
  assert.equal(created.expiresAt, new Date(r.clock.now + 2 * 60 * 60_000).toISOString());
  assert.equal(Object.hasOwn(created, 'cwd') || Object.hasOwn(created, 'path'), false, 'the folder is never returned');

  const cwd = r.ws.resolve(created.id);
  assert.equal(cwd, join(r.root, created.id, 'owner-repo-abc123'));
  assert.equal(readFileSync(join(cwd, 'src/a.ts'), 'utf8'), 'export {};\n');
  assert.equal(statSync(join(cwd, 'README.md')).mode & 0o777, 0o444);
  assert.equal(statSync(join(cwd, 'src')).mode & 0o777, 0o555);
  assert.deepEqual(r.ws.get(created.id), created);
});

test('an archive with several top-level entries runs in the workspace folder itself', async () => {
  const r = rig();
  const created = await upload(r.ws, tgz(file('a.txt', 'a'), file('./b/c.txt', 'c')));
  assert.equal(r.ws.resolve(created.id), join(r.root, created.id));
  assert.equal(created.files, 2);
});

test('PAX and GNU long names are what the entry is written under', async () => {
  const r = rig();
  const long = `top/${'d'.repeat(120)}/file.txt`;
  const created = await upload(r.ws, tgz(pax({ path: long }), file('short-name', 'pax'), gnuLong(`top/${'g'.repeat(130)}.txt`), file('trunc', 'gnu'), file('x.txt', 'p', { prefix: 'top/prefixed' })));
  const cwd = r.ws.resolve(created.id);
  assert.equal(readFileSync(join(cwd, 'd'.repeat(120), 'file.txt'), 'utf8'), 'pax');
  assert.equal(readFileSync(join(cwd, `${'g'.repeat(130)}.txt`), 'utf8'), 'gnu');
  assert.equal(readFileSync(join(cwd, 'prefixed', 'x.txt'), 'utf8'), 'p');
});

for (const [what, archive] of [
  ['a symbolic link', () => tgz(file('top/a.txt', 'a'), file('top/link', '', { type: '2', linkname: '/data/auth.json' }))],
  ['a hard link', () => tgz(file('top/a.txt', 'a'), file('top/hard', '', { type: '1', linkname: 'top/a.txt' }))],
  ['a character device', () => tgz(file('top/dev', '', { type: '3' }))],
  ['a FIFO', () => tgz(file('top/fifo', '', { type: '6' }))],
  ['a path with ..', () => tgz(file('top/../../escape.txt', 'x'))],
  ['an absolute path', () => tgz(file('/etc/cron.d/x', 'x'))],
  ['a PAX long name with ..', () => tgz(pax({ path: 'top/../../../escape.txt' }), file('innocent.txt', 'x'))],
  ['a GNU long name with ..', () => tgz(gnuLong('../escape.txt'), file('innocent.txt', 'x'))],
  ['a .git folder', () => tgz(dir('top'), dir('top/.git'), file('top/.git/config', '[core]\n\tfsmonitor = touch /tmp/pwned\n'))],
  ['a .git file in any case', () => tgz(file('top/sub/.GIT', 'gitdir: /data'))],
  ['a name repeated', () => tgz(file('top/a.txt', 'a'), file('top/a.txt', 'b'))],
  ['a damaged header', () => {
    const t = tar(file('top/a.txt', 'a'));
    t[10] = (t[10] ?? 0) ^ 0xff;
    return gzipSync(t);
  }],
  ['a truncated archive', () => gzipSync(tar(file('top/a.txt', 'a'.repeat(5000))).subarray(0, 2048))],
  ['a body that is not gzip', () => Buffer.from('this is not an archive at all')],
] as const) {
  test(`${what} refuses the archive as workspace-bad-archive and leaves nothing`, async () => {
    const r = rig();
    await refused(upload(r.ws, archive()), 'workspace-bad-archive');
    empty(r);
    assert.equal(existsSync(join(r.root, '..', 'escape.txt')), false);
  });
}

test('a gzip bomb stops at the extracted cap, counted as bytes are written', async () => {
  const r = rig({ maxExtractedBytes: 1 * MB });
  // 64 MB of zeros compress to some 64 KB
  const bomb = tgz(file('top/zeros.bin', Buffer.alloc(64 * MB)));
  assert.ok(bomb.length < 1 * MB);
  await refused(upload(r.ws, bomb), 'workspace-too-large');
  empty(r);
});

test('the compressed cap, the entry cap and the total under the root are each a 413 that leaves nothing', async () => {
  const random = randomBytes(200_000);
  const compressed = rig({ maxCompressedBytes: 50_000 });
  await refused(upload(compressed.ws, tgz(file('top/r.bin', random))), 'workspace-too-large');
  empty(compressed);

  const entries = rig({ maxEntries: 3 });
  await refused(upload(entries.ws, tgz(dir('top'), file('top/1', '1'), file('top/2', '2'), file('top/3', '3'))), 'workspace-too-large');
  empty(entries);

  const total = rig({ maxTotalBytes: 300_000 });
  const first = await upload(total.ws, tgz(file('top/r.bin', random)));
  await refused(upload(total.ws, tgz(file('top/r.bin', random))), 'workspace-too-large');
  assert.deepEqual(readdirSync(total.root), [first.id]);
  assert.equal((total.sql.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n, 1);
});

test('two creations at the count cap: the reservation lets one through and refuses the other with 429', async () => {
  const r = rig({ maxCount: 1 });
  const slow = new PassThrough();
  const pending = r.ws.create({ kind: 'upload', body: slow });
  const second = await refused(upload(r.ws, tgz(file('a', 'a'))), 'workspace-limit');
  assert.equal(second.statusCode, 429);
  slow.end(tgz(file('top/a', 'a')));
  const first = await pending;
  assert.equal(first.state, 'ready');
  assert.deepEqual(readdirSync(r.root), [first.id]);
});

test('an archive that takes longer than the timeout is refused and leaves nothing', async () => {
  const r = rig({ timeoutMs: 150 });
  const never = new PassThrough();
  never.write(gzipSync(file('top/a', 'a')).subarray(0, 10));
  await refused(r.ws.create({ kind: 'upload', body: never }), 'workspace-timeout');
  empty(r);
});

// ---------- the URL source ----------

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

const loopback = { protocols: ['http:', 'https:'], allowAddress: () => true } as const;

test('a URL on an allowed host is downloaded, and only its host is kept', async () => {
  const archive = tgz(dir('o-r-1'), file('o-r-1/a.txt', 'a'));
  const port = await serve((_req, res) => res.writeHead(200, { 'content-type': 'application/gzip' }).end(archive));
  const r = rig({}, loopback);
  const url = `http://localhost:${String(port)}/o/r/legacy.tar.gz/main?token=SECRET_TOKEN`;
  const created = await r.ws.create({ kind: 'url', url });
  assert.equal(created.source, 'url');
  assert.equal(created.host, 'localhost');
  assert.equal(readFileSync(join(r.ws.resolve(created.id), 'a.txt'), 'utf8'), 'a');
  const stored = JSON.stringify(r.sql.prepare('SELECT * FROM workspaces').all());
  assert.doesNotMatch(stored, /SECRET_TOKEN|legacy\.tar\.gz/);
});

test('a host off the list, and a redirect to one, are refused naming the host and never the URL', async () => {
  const r = rig({ hosts: ['localhost'] }, loopback);
  const off = await refused(r.ws.create({ kind: 'url', url: 'http://example.com/x.tar.gz?token=SECRET_TOKEN' }), 'workspace-host-not-allowed');
  assert.match(off.message, /example\.com/);
  assert.doesNotMatch(off.message, /SECRET_TOKEN|x\.tar\.gz/);

  const target = await serve((_req, res) => res.end(tgz(file('a', 'a'))));
  const port = await serve((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${String(target)}/y.tar.gz?token=OTHER_SECRET` }).end());
  const hop = await refused(r.ws.create({ kind: 'url', url: `http://localhost:${String(port)}/x?token=SECRET_TOKEN` }), 'workspace-host-not-allowed');
  assert.match(hop.message, /127\.0\.0\.1/);
  assert.doesNotMatch(hop.message, /SECRET|y\.tar\.gz/);
  empty(r);
});

test('more than three redirects is a download failure', async () => {
  let port = 0;
  port = await serve((req, res) => res.writeHead(302, { location: `http://localhost:${String(port)}${req.url ?? '/'}x` }).end());
  const r = rig({}, loopback);
  await refused(r.ws.create({ kind: 'url', url: `http://localhost:${String(port)}/` }), 'workspace-download-failed');
  empty(r);
});

test('a server error is a download failure that names the host only', async () => {
  const port = await serve((_req, res) => res.writeHead(404).end());
  const r = rig({}, loopback);
  const err = await refused(r.ws.create({ kind: 'url', url: `http://localhost:${String(port)}/x?token=SECRET_TOKEN` }), 'workspace-download-failed');
  assert.equal(err.statusCode, 502);
  assert.doesNotMatch(err.message, /SECRET_TOKEN/);
});

test('a name resolving to 127.0.0.1, or a private literal address, is blocked by the address guard', async () => {
  const port = await serve((_req, res) => res.end(tgz(file('a', 'a'))));
  // The public-address guard of the real fetch: only the scheme is widened for the test server
  const r = rig({ hosts: ['localhost', '127.0.0.1', '10.0.0.1'] }, { protocols: ['http:', 'https:'] });
  await refused(r.ws.create({ kind: 'url', url: `http://localhost:${String(port)}/x` }), 'workspace-address-blocked');
  await refused(r.ws.create({ kind: 'url', url: `http://127.0.0.1:${String(port)}/x` }), 'workspace-address-blocked');
  await refused(r.ws.create({ kind: 'url', url: 'http://10.0.0.1/x' }), 'workspace-address-blocked');
  empty(r);
});

test('only https is downloaded by default, and a URL with credentials never is', async () => {
  const r = rig();
  await assert.rejects(r.ws.create({ kind: 'url', url: 'http://localhost/x.tar.gz' }), (err: Error & { statusCode?: number }) => err.statusCode === 400 && /https/.test(err.message));
  await assert.rejects(r.ws.create({ kind: 'url', url: 'https://user:pw@localhost/x' }), (err: Error & { statusCode?: number }) => err.statusCode === 400 && !/pw/.test(err.message));
  await assert.rejects(r.ws.create({ kind: 'url', url: 'not a url' }), (err: Error & { statusCode?: number }) => err.statusCode === 400);
  empty(r);
});

test('a declared length over the compressed cap is refused before the body is read', async () => {
  const port = await serve((_req, res) => res.writeHead(200, { 'content-length': String(10 * MB) }).end(Buffer.alloc(10)));
  const r = rig({ maxCompressedBytes: 1 * MB }, loopback);
  await refused(r.ws.create({ kind: 'url', url: `http://localhost:${String(port)}/x` }), 'workspace-too-large');
  empty(r);
});

// ---------- lifetime ----------

test('a workspace expires a TTL after its last use, is kept while a chat runs in it, and answers 410 once removed', async () => {
  const r = rig();
  const created = await upload(r.ws, tgz(dir('top'), file('top/a', 'a')));
  const cwd = r.ws.resolve(created.id);

  r.clock.now += 60 * 60_000;
  r.ws.touch(created.id);
  assert.equal(r.ws.get(created.id).expiresAt, new Date(r.clock.now + 2 * 60 * 60_000).toISOString());

  r.clock.now += 3 * 60 * 60_000;
  assert.throws(() => r.ws.resolve(created.id), (err: WorkspaceRefusal) => err.reason === 'workspace-expired' && err.statusCode === 410);
  r.running.push({ id: 'chat-1', dirs: [cwd, cwd] });
  assert.equal(await r.ws.sweep(), 0, 'a chat still runs in it');
  assert.ok(existsSync(cwd));

  r.running.length = 0;
  assert.equal(await r.ws.sweep(), 1);
  assert.equal(existsSync(join(r.root, created.id)), false);
  assert.throws(() => r.ws.get(created.id), (err: WorkspaceRefusal) => err.reason === 'workspace-expired');
  assert.throws(() => r.ws.resolve(created.id), (err: WorkspaceRefusal) => err.reason === 'workspace-expired');
  assert.throws(() => r.ws.get('ws_AAAAAAAAAAAAAAAA'), (err: WorkspaceRefusal) => err.reason === 'workspace-not-found' && err.statusCode === 404);
  assert.throws(() => r.ws.get('../../etc'), (err: WorkspaceRefusal) => err.reason === 'workspace-not-found');
});

test('DELETE stops the chats running in the workspace before removing it', async () => {
  const r = rig();
  const created = await upload(r.ws, tgz(dir('top'), file('top/a', 'a')));
  const cwd = r.ws.resolve(created.id);
  r.running.push({ id: 'inside', dirs: [cwd, join(cwd, 'sub')] }, { id: 'elsewhere', dirs: ['/tmp/other', '/tmp/other'] });
  await r.ws.remove(created.id);
  assert.deepEqual(r.stopped, ['inside']);
  assert.equal(existsSync(join(r.root, created.id)), false);
  assert.throws(() => r.ws.get(created.id), (err: WorkspaceRefusal) => err.reason === 'workspace-expired');
  // Removing it again is no error
  await r.ws.remove(created.id);
  await assert.rejects(r.ws.remove('ws_AAAAAAAAAAAAAAAA'), (err: WorkspaceRefusal) => err.reason === 'workspace-not-found');
});

test('the start sweep removes ws_* folders no row knows, and nothing else under the root or outside it', async () => {
  const r = rig();
  const kept = await upload(r.ws, tgz(file('a', 'a')));
  const orphan = join(r.root, 'ws_BBBBBBBBBBBBBBBB');
  mkdirSync(join(orphan, 'deep'), { recursive: true });
  writeFileSync(join(orphan, 'deep', 'f'), 'x');
  mkdirSync(join(r.root, 'not-a-workspace'));
  writeFileSync(join(r.root, 'ws_CCCCCCCCCCCCCCCC'), 'a file, not a folder');
  const outside = join(r.root, '..', 'ws_DDDDDDDDDDDDDDDD');
  mkdirSync(outside);

  assert.equal(await r.ws.sweep({ orphans: true }), 1);
  assert.deepEqual(readdirSync(r.root).sort(), [kept.id, 'not-a-workspace', 'ws_CCCCCCCCCCCCCCCC'].sort());
  assert.ok(existsSync(outside));
});

test('overlaps names the root, what is inside it and what holds it, so none can be a cwd', () => {
  const r = rig();
  assert.equal(r.ws.overlaps(r.root), true);
  assert.equal(r.ws.overlaps(join(r.root, 'ws_AAAAAAAAAAAAAAAA', 'x')), true);
  assert.equal(r.ws.overlaps(join(r.root, '..')), true);
  assert.equal(r.ws.overlaps(join(r.root, '..', 'workspace')), false);
});

// ---------- settings ----------

test('settings default to codeload.github.com and the plan caps, and refuse a root that overlaps Claudio\'s own folders', () => {
  const places = { dataDir: '/srv/claudio/data', workspaceDir: '/srv/claudio/workspace', configDir: '/home/node/.claude' };
  const s = workspaceSettingsFromEnv({}, places);
  assert.equal(s.root, '/srv/claudio/workspaces');
  assert.deepEqual(s.hosts, ['codeload.github.com']);
  assert.deepEqual([s.maxCompressedBytes, s.maxExtractedBytes, s.maxEntries, s.timeoutMs, s.maxCount, s.maxTotalBytes, s.ttlMs], [100 * MB, 500 * MB, 50_000, 60_000, 20, 2048 * MB, 2 * 60 * 60_000]);
  assert.equal(workspaceSettingsFromEnv({}, { ...places, distribution: 'docker' }).root, '/workspaces');
  assert.deepEqual(workspaceSettingsFromEnv({ CLAUDIO_WORKSPACE_HOSTS: 'codeload.github.com, Example.org' }, places).hosts, ['codeload.github.com', 'example.org']);

  assert.throws(() => workspaceSettingsFromEnv({ CLAUDIO_WORKSPACES_DIR: '/srv/claudio/workspace/ws' }, places), /overlaps CLAUDIO_WORKSPACE_DIR/);
  assert.throws(() => workspaceSettingsFromEnv({ CLAUDIO_WORKSPACES_DIR: '/srv' }, places), /overlaps/);
  assert.throws(() => workspaceSettingsFromEnv({ CLAUDIO_WORKSPACES_DIR: '/srv/claudio/data/ws' }, places), /overlaps CLAUDIO_DATA_DIR/);
  assert.throws(() => workspaceSettingsFromEnv({ CLAUDIO_WORKSPACE_MAX_COUNT: 'many' }, places), /CLAUDIO_WORKSPACE_MAX_COUNT/);
  assert.throws(() => workspaceSettingsFromEnv({ CLAUDIO_WORKSPACE_HOSTS: 'https://codeload.github.com' }, places), /CLAUDIO_WORKSPACE_HOSTS/);
});
