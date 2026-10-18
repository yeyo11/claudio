import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, test } from 'node:test';
import { DownloadError, downloadFile, hashFile } from '../src/updates/download.ts';
import { head, rawServer, writeInPieces, type RawHandler } from './raw-http-server.ts';

// Every error of a connection must end in the downloader's promise. One that reaches the process
// instead takes the server down with the update half done (the desktop smoke run, Node 24.22).
const escaped: unknown[] = [];
const onEscape = (err: unknown) => escaped.push(err);
process.on('uncaughtException', onEscape);
process.on('unhandledRejection', onEscape);

const roots: string[] = [];
after(() => {
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const BODY = randomBytes(300 * 1024);

function target(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudio-download-'));
  roots.push(root);
  return join(root, 'file.bin');
}

/** Retries without the real back-off: the waits are recorded instead */
function quick() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => void waits.push(ms) };
}

async function serve(handler: RawHandler) {
  const server = await rawServer(handler);
  after(() => server.close());
  return server;
}

/** A writer that takes its time over every chunk, so the body stays paused by back-pressure */
function slowWriter(file: string, flags: 'w' | 'a'): Writable {
  const out = createWriteStream(file, { flags });
  return new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      setTimeout(() => out.write(chunk, (err) => done(err ?? null)), 1);
    },
    final(done) {
      out.end(() => done());
    },
    destroy(err, done) {
      out.destroy();
      done(err);
    },
  });
}

test('a connection closed in the middle of the body is retried from scratch when the server takes no ranges', async () => {
  const server = await serve(async (req, socket) => {
    socket.write(head('200 OK', { 'content-length': BODY.length, connection: 'close' }));
    if (req.index === 0) {
      await writeInPieces(socket, BODY.subarray(0, 100_000));
      socket.destroy();
      return;
    }
    await writeInPieces(socket, BODY);
    socket.end();
  });
  const file = target();
  const { waits, wait } = quick();
  const done = await downloadFile(server.url('/f'), file, { wait, size: BODY.length });
  assert.deepEqual(readFileSync(file), BODY);
  assert.deepEqual({ attempts: done.attempts, resumed: done.resumed }, { attempts: 2, resumed: 0 });
  assert.deepEqual(waits, [2_000]);
  assert.equal(server.requests[1]?.headers.range, undefined, 'no range without Accept-Ranges');
  assert.deepEqual(escaped, []);
});

test('an HTTP/1.0 body delimited by the close reaches a slow writer whole, and no error escapes to the process', async () => {
  const server = await serve(async (_req, socket) => {
    // What Python's http.server does: no keep-alive, the end of the body is the end of the socket
    socket.write(head('200 OK', { 'content-type': 'application/octet-stream' }, '1.0'));
    await writeInPieces(socket, BODY, 64 * 1024);
    socket.end();
  });
  for (let i = 0; i < 8; i += 1) {
    const file = target();
    const done = await downloadFile(server.url('/f'), file, { ...quick(), size: BODY.length, createWriter: slowWriter });
    assert.equal(done.attempts, 1);
    assert.equal(await hashFile(file, 'sha256'), createHash('sha256').update(BODY).digest('hex'));
  }
  assert.deepEqual(escaped, []);
});

test('a dropped transfer goes on with Range from where the partial file ends, and only the rest is sent', async () => {
  const cut = 120_000;
  let resentBytes = -1;
  const server = await serve(async (req, socket) => {
    if (req.index === 0) {
      socket.write(head('200 OK', { 'content-length': BODY.length, 'accept-ranges': 'bytes', etag: '"v1"' }));
      await writeInPieces(socket, BODY.subarray(0, cut));
      // Let the client write what it has before the link drops
      setTimeout(() => socket.destroy(), 50);
      return;
    }
    const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? NaN);
    const rest = BODY.subarray(from);
    resentBytes = rest.length;
    socket.write(head('206 Partial Content', { 'content-length': rest.length, 'content-range': `bytes ${String(from)}-${String(BODY.length - 1)}/${String(BODY.length)}`, etag: '"v1"' }));
    await writeInPieces(socket, rest);
    socket.end();
  });
  const file = target();
  const retries: number[] = [];
  const done = await downloadFile(server.url('/f'), file, { ...quick(), size: BODY.length, onRetry: (_n, _err, from) => retries.push(from) });
  assert.deepEqual(readFileSync(file), BODY);
  assert.deepEqual({ attempts: done.attempts, resumed: done.resumed }, { attempts: 2, resumed: 1 });
  assert.equal(server.requests[1]?.headers.range, `bytes=${String(cut)}-`);
  assert.equal(server.requests[1]?.headers['if-range'], '"v1"', 'a changed file would come whole');
  assert.deepEqual(retries, [cut]);
  assert.equal(resentBytes, BODY.length - cut);
  assert.deepEqual(escaped, []);
});

test('a server that answers a Range with the whole file has it written from the start', async () => {
  const server = await serve(async (req, socket) => {
    socket.write(head('200 OK', { 'content-length': BODY.length, 'accept-ranges': 'bytes' }));
    if (req.index === 0) {
      await writeInPieces(socket, BODY.subarray(0, 50_000));
      setTimeout(() => socket.destroy(), 50);
      return;
    }
    await writeInPieces(socket, BODY);
    socket.end();
  });
  const file = target();
  const done = await downloadFile(server.url('/f'), file, { ...quick(), size: BODY.length });
  assert.ok(server.requests[1]?.headers.range, 'the resume was asked for');
  assert.deepEqual(readFileSync(file), BODY, 'not appended to the partial file');
  assert.equal(done.resumed, 0);
});

test('a body shorter than its Content-Length is an interruption; after every retry it fails and leaves no file', async () => {
  const server = await serve(async (_req, socket) => {
    socket.write(head('200 OK', { 'content-length': BODY.length, connection: 'close' }));
    await writeInPieces(socket, BODY.subarray(0, BODY.length - 10));
    socket.end();
  });
  const file = target();
  const { waits, wait } = quick();
  const err = await downloadFile(server.url('/f'), file, { wait }).then(
    () => assert.fail('a short body must not count as a download'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof DownloadError && err.kind === 'interrupted', String(err));
  assert.deepEqual(waits, [2_000, 8_000, 30_000], 'three retries, with back-off');
  assert.equal(server.requests.length, 4);
  assert.equal(existsSync(file), false, 'the partial file never stays');
  assert.deepEqual(escaped, []);
});

test('a close-delimited body that ends short of the expected size is an interruption, not a download', async () => {
  const server = await serve(async (req, socket) => {
    socket.write(head('200 OK', {}, '1.0'));
    await writeInPieces(socket, req.index === 0 ? BODY.subarray(0, 1000) : BODY);
    socket.end();
  });
  const file = target();
  const done = await downloadFile(server.url('/f'), file, { ...quick(), size: BODY.length });
  assert.equal(done.attempts, 2);
  assert.deepEqual(readFileSync(file), BODY);
});

test('a reset connection and a stalled one are retried', async () => {
  const server = await serve(async (req, socket) => {
    socket.write(head('200 OK', { 'content-length': BODY.length }));
    await writeInPieces(socket, BODY.subarray(0, 20_000));
    if (req.index === 0) return void socket.resetAndDestroy();
    // The second stays silent past the idle timeout
    if (req.index === 1) return;
    await writeInPieces(socket, BODY.subarray(20_000));
    socket.end();
  });
  const file = target();
  const failures: string[] = [];
  const done = await downloadFile(server.url('/f'), file, { ...quick(), idleTimeoutMs: 300, onRetry: (_n, err) => failures.push(err.kind) });
  assert.equal(done.attempts, 3);
  assert.deepEqual(failures, ['interrupted', 'interrupted']);
  assert.deepEqual(readFileSync(file), BODY);
  assert.deepEqual(escaped, []);
});

test('a 404 is not retried, a 503 is', async () => {
  const server = await serve((req, socket) => {
    const status = req.path === '/missing' ? '404 Not Found' : req.index === 1 ? '503 Service Unavailable' : '200 OK';
    const body = status.startsWith('200') ? BODY : Buffer.from('no');
    socket.end(Buffer.concat([Buffer.from(head(status, { 'content-length': body.length })), body]));
  });
  const missing = quick();
  const err = await downloadFile(server.url('/missing'), target(), { wait: missing.wait }).catch((e: unknown) => e);
  assert.ok(err instanceof DownloadError && err.kind === 'http' && err.status === 404, String(err));
  assert.deepEqual(missing.waits, []);
  const done = await downloadFile(server.url('/busy'), target(), quick());
  assert.equal(done.attempts, 2);
});

test('more bytes than the expected size, or another announced size, fail at once without a retry', async () => {
  const server = await serve((_req, socket) => {
    socket.end(Buffer.concat([Buffer.from(head('200 OK', {}, '1.0')), BODY]));
  });
  const { waits, wait } = quick();
  const err = await downloadFile(server.url('/f'), target(), { wait, size: BODY.length - 1 }).catch((e: unknown) => e);
  assert.ok(err instanceof DownloadError && err.kind === 'wrong-size', String(err));
  assert.deepEqual(waits, []);
  const announced = await rawServer((_req, socket) => {
    socket.end(Buffer.concat([Buffer.from(head('200 OK', { 'content-length': BODY.length - 5 })), BODY.subarray(5)]));
  });
  after(() => announced.close());
  const shorter = await downloadFile(announced.url('/f'), target(), { wait, size: BODY.length }).catch((e: unknown) => e);
  assert.ok(shorter instanceof DownloadError && shorter.kind === 'wrong-size', String(shorter));
  assert.deepEqual(waits, []);
});

test('a redirect is followed, as GitHub sends a release asset to its CDN', async () => {
  const server = await serve(async (req, socket) => {
    if (req.path === '/asset') return void socket.end(head('302 Found', { location: '/cdn/asset', 'content-length': 0 }));
    socket.write(head('200 OK', { 'content-length': BODY.length }));
    await writeInPieces(socket, BODY);
    socket.end();
  });
  const file = target();
  await downloadFile(server.url('/asset'), file, quick());
  assert.deepEqual(readFileSync(file), BODY);
  assert.deepEqual(
    server.requests.map((r) => r.path),
    ['/asset', '/cdn/asset'],
  );
});

test('no error of any connection above reached the process, late ones included', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(escaped, []);
});
