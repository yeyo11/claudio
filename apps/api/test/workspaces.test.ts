import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Workspace } from '@claudio/shared';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';

// The three workspace routes over a real core (docs/plans/headless-image.md, D7): the archive as the
// body, the URL source's refusals, and the codes a client acts on. The extraction's own rules are
// covered in packages/core/test/workspaces.test.ts.

let app: FastifyInstance;
let core: Core;
let root: string;

function entry(name: string, body: string, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const data = Buffer.from(body);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const tgz = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const gzip = (payload: Buffer) => ({ method: 'POST' as const, url: '/api/workspaces', payload, headers: { 'content-type': 'application/gzip' } });
const json = (body: unknown) => ({ method: 'POST' as const, url: '/api/workspaces', payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-workspaces-'));
  // The core reads the workspace settings from the environment, as the server does
  process.env.CLAUDIO_WORKSPACE_HOSTS = 'localhost';
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
});

after(async () => {
  await app.close();
  await core.shutdown();
  delete process.env.CLAUDIO_WORKSPACE_HOSTS;
  const unseal = (path: string): void => {
    if (!statSync(path).isDirectory()) return;
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) unseal(join(path, name));
  };
  unseal(root);
  rmSync(root, { recursive: true, force: true });
});

test('an archive sent as the body becomes a workspace that GET reads and DELETE removes', async () => {
  assert.equal(core.workspaces.root, join(root, 'workspaces'));
  const created = await app.inject(gzip(tgz(entry('repo-abc/', '', '5'), entry('repo-abc/README.md', '# hi\n'))));
  assert.equal(created.statusCode, 201, created.body);
  const ws = created.json<Workspace>();
  assert.equal(ws.source, 'upload');
  assert.equal(ws.files, 1);
  assert.equal(ws.state, 'ready');
  assert.equal(core.workspaces.resolve(ws.id), join(root, 'workspaces', ws.id, 'repo-abc'));

  const read = await app.inject(`/api/workspaces/${ws.id}`);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), ws);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}` })).statusCode, 204);
  assert.equal(existsSync(join(root, 'workspaces', ws.id)), false);
  const gone = await app.inject(`/api/workspaces/${ws.id}`);
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.json<{ code: string }>().code, 'workspace-expired');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}` })).statusCode, 204);
});

test('a hostile archive is a 400 with its code, and an unknown id a 404', async () => {
  const link = await app.inject(gzip(tgz(entry('repo/link', '', '2'))));
  assert.equal(link.statusCode, 400);
  assert.equal(link.json<{ code: string }>().code, 'workspace-bad-archive');
  const git = await app.inject(gzip(tgz(entry('repo/.git/config', '[core]\n'))));
  assert.equal(git.json<{ code: string }>().code, 'workspace-bad-archive');
  assert.deepEqual(readdirSync(join(root, 'workspaces')), []);

  const unknown = await app.inject('/api/workspaces/ws_AAAAAAAAAAAAAAAA');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json<{ code: string }>().code, 'workspace-not-found');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/workspaces/nope' })).statusCode, 404);
});

test('a body declared larger than the compressed cap is a 413 before it is read', async () => {
  const res = await app.inject({ ...gzip(Buffer.alloc(16)), headers: { 'content-type': 'application/gzip', 'content-length': String(200 * 1024 * 1024) } });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json<{ code: string }>().code, 'workspace-too-large');
});

test('a body larger than the JSON limit still streams through the gzip parser', async () => {
  // Random base64 barely compresses, so the body is past Fastify's 1 MB default
  const big = randomBytes(1536 * 1024).toString('base64');
  const archive = tgz(entry('repo/big.txt', big));
  assert.ok(archive.length > 1024 * 1024);
  const res = await app.inject(gzip(archive));
  assert.equal(res.statusCode, 201, res.body);
  await app.inject({ method: 'DELETE', url: `/api/workspaces/${res.json<Workspace>().id}` });
});

test('the URL source refuses a host off the list or a private address, and never echoes the URL', async () => {
  const off = await app.inject(json({ url: 'https://example.com/o/r/tar.gz/main?token=SECRET_TOKEN' }));
  assert.equal(off.statusCode, 400);
  assert.equal(off.json<{ code: string }>().code, 'workspace-host-not-allowed');
  assert.doesNotMatch(off.body, /SECRET_TOKEN|tar\.gz/);

  // localhost is on the list here, and resolves to loopback: the address guard stops it at lookup
  const loop = await app.inject(json({ url: 'https://localhost:9/o/r/tar.gz/main?token=SECRET_TOKEN' }));
  assert.equal(loop.statusCode, 400);
  assert.equal(loop.json<{ code: string }>().code, 'workspace-address-blocked');
  assert.doesNotMatch(loop.body, /SECRET_TOKEN|tar\.gz/);

  const plain = await app.inject(json({ url: 'http://localhost/x?token=SECRET_TOKEN' }));
  assert.equal(plain.statusCode, 400);
  assert.doesNotMatch(plain.body, /SECRET_TOKEN/);

  assert.equal((await app.inject(json({}))).statusCode, 400);
  assert.deepEqual(readdirSync(join(root, 'workspaces')), []);
});
