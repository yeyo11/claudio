import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import test, { after } from 'node:test';
import type * as IrohModule from '@number0/iroh';
import { CollabHost, type HostStatus, type HostUnavailable } from '../src/collab/host-client.ts';
import { CollabHostCore } from '../src/collab/host/host.ts';
import { IROH_MODULE_ENV, type HostStartOptions, type HostToCore } from '../src/collab/host/protocol.ts';
import { endpointIdFromSeed, signBytes, verifyBytes } from '../src/collab/roster.ts';
import type { ReplySink } from '../src/collab/serve.ts';

/*
 * The Collaborators host (docs/plans/collaborators.md §3.2): the binding loaded lazily and softly,
 * two endpoints talking over loopback on the minimal preset (no network), the forked host restarted
 * and reported when it dies, and given up as unavailable when it keeps dying.
 */

let iroh: typeof IrohModule | null = null;
let irohError = '';
try {
  iroh = await import('@number0/iroh');
} catch (error) {
  irohError = error instanceof Error ? error.message : String(error);
}
const needsIroh = iroh ? {} : { skip: `@number0/iroh does not load here: ${irohError}` };

const options = (seed: Buffer = randomBytes(32)): HostStartOptions => ({ secretKey: [...seed], preset: 'minimal', relayUrls: [], bindAddr: '127.0.0.1:0', pollMs: 100 });

async function until<T>(what: string, probe: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const hosts: CollabHost[] = [];
const cores: CollabHostCore[] = [];
after(async () => {
  for (const host of hosts) host.dispose();
  for (const core of cores) await core.shutdown();
});

test('signatures made with node:crypto and with iroh verify each other', needsIroh, () => {
  assert.ok(iroh);
  const seed = randomBytes(32);
  const key = iroh.SecretKey.fromBytes([...seed]);
  assert.equal(Buffer.from(key.public().toBytes()).toString('hex'), endpointIdFromSeed(seed));
  assert.equal(key.public().toString(), endpointIdFromSeed(seed), 'iroh prints an endpoint id as the same hex');
  const message = Buffer.from('a roster version, canonical');
  const ours = signBytes(seed, message);
  key.public().verify([...message], iroh.Signature.fromBytes([...Buffer.from(ours, 'hex')]));
  const theirs = Buffer.from(key.sign([...message]).toBytes()).toString('hex');
  assert.ok(verifyBytes(endpointIdFromSeed(seed), message, theirs));
  assert.throws(() => key.public().verify([...Buffer.from('another message')], iroh!.Signature.fromBytes([...Buffer.from(ours, 'hex')])));
});

test('a platform without a prebuild is unavailable without loading anything', async () => {
  const sent: HostToCore[] = [];
  let loads = 0;
  const core = new CollabHostCore({
    send: (m) => sent.push(m),
    load: async () => {
      loads++;
      throw new Error('should not be called');
    },
    log: () => undefined,
    platform: 'darwin',
    arch: 'x64',
  });
  core.handle({ type: 'start', options: options() });
  await until('unavailable', () => sent.find((m) => m.type === 'unavailable'));
  assert.deepEqual(sent, [{ type: 'unavailable', code: 'platform', message: '@number0/iroh has no build for darwin-x64' }]);
  assert.equal(loads, 0);
});

test('a binding that does not load is reported, and the host stays up', async () => {
  const sent: HostToCore[] = [];
  const core = new CollabHostCore({
    send: (m) => sent.push(m),
    load: () => Promise.reject(new Error('Cannot find native binding. npm has a bug related to optional dependencies')),
    log: () => undefined,
  });
  core.handle({ type: 'start', options: options() });
  const unavailable = await until('unavailable', () => sent.find((m) => m.type === 'unavailable'));
  assert.deepEqual(unavailable, { type: 'unavailable', code: 'load', message: 'Cannot find native binding. npm has a bug related to optional dependencies' });
});

test('two endpoints on loopback: a request, a reply frame and 3 MiB of raw bytes, in order', needsIroh, async () => {
  assert.ok(iroh);
  const module = iroh;
  const fromA: HostToCore[] = [];
  const fromB: HostToCore[] = [];
  const payload = randomBytes(3 * 1024 * 1024 + 17);
  const seedB = randomBytes(32);
  // A answers every request with a blob header and the bytes in 1 MiB pieces, as serve.ts does through host-client.ts
  const a: CollabHostCore = new CollabHostCore({
    send: (m) => {
      fromA.push(m);
      if (m.type !== 'incoming') return;
      a.handle({ type: 'reply', stream: m.stream, frame: { type: 'blob', sha256: 'f'.repeat(64), bytes: payload.length, asked: m.frame, from: m.from } });
      for (let at = 0; at < payload.length; at += 1024 * 1024) a.handle({ type: 'reply-bytes', stream: m.stream, data: payload.subarray(at, at + 1024 * 1024) });
      a.handle({ type: 'reply-end', stream: m.stream });
    },
    load: async () => module,
    log: () => undefined,
  });
  const b = new CollabHostCore({ send: (m) => fromB.push(m), load: async () => module, log: () => undefined });
  cores.push(a, b);
  a.handle({ type: 'start', options: options() });
  b.handle({ type: 'start', options: options(seedB) });
  const statusA = await until('A bound', () => fromA.find((m): m is Extract<HostToCore, { type: 'status' }> => m.type === 'status' && m.directAddresses.length > 0 && m.connection !== 'starting'));
  await until('B bound', () => fromB.find((m) => m.type === 'status'));
  assert.equal(statusA.connection, 'no-relay', 'the minimal preset has no relay');

  b.handle({ type: 'request', req: 1, to: { endpointId: statusA.endpointId, ticket: statusA.ticket }, frame: { type: 'blob', shareKey: 'github.com/acme/api', sha256: 'f'.repeat(64) } });
  await until('the reply', () => fromB.find((m) => (m.type === 'response-end' || m.type === 'response-error') && m.req === 1));
  const replies = fromB.filter((m) => 'req' in m && m.req === 1);
  assert.equal(replies.find((m) => m.type === 'response-error'), undefined);
  const head = replies[0];
  assert.equal(head?.type, 'response');
  if (head?.type === 'response') {
    assert.deepEqual(head.frame, { type: 'blob', sha256: 'f'.repeat(64), bytes: payload.length, asked: { type: 'blob', shareKey: 'github.com/acme/api', sha256: 'f'.repeat(64) }, from: endpointIdFromSeed(seedB) });
  }
  const bytes = Buffer.concat(replies.flatMap((m) => (m.type === 'response-bytes' ? [m.data] : [])));
  assert.ok(bytes.equals(payload));
  assert.equal(replies.at(-1)?.type, 'response-end');

  // Both sides see the other, polled, never watched
  await until('A sees B', () => fromA.find((m) => m.type === 'peer' && m.endpointId === endpointIdFromSeed(seedB) && m.connected));
  const peer = await until('B sees A on a path', () => fromB.find((m) => m.type === 'peer' && m.endpointId === statusA.endpointId && m.connected && m.path !== null));
  assert.equal(peer.type === 'peer' ? peer.path : null, 'direct');

  // A request to an endpoint nobody runs fails as an error, not as a crash
  b.handle({ type: 'request', req: 2, to: { endpointId: endpointIdFromSeed(randomBytes(32)), ticket: null }, frame: { type: 'hello', heads: {} } });
  await until('the failure', () => fromB.find((m) => m.type === 'response-error' && m.req === 2), 30_000);
});

const hostEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => extra;

test('Claudio goes on when the binding is absent: the forked host reports it unavailable', async () => {
  let reason: HostUnavailable | null = null;
  const host = new CollabHost({
    serve: async () => undefined,
    listener: { unavailable: (r) => (reason = r) },
    env: hostEnv({ [IROH_MODULE_ENV]: join(import.meta.dirname, 'no-such-iroh', 'index.js') }),
  });
  hosts.push(host);
  host.start(options());
  const got = await until('unavailable', () => reason);
  assert.equal(got.code, 'load');
  assert.equal(host.unavailable?.code, 'load');
  // Nothing more is tried, and a request says why instead of hanging
  await assert.rejects(async () => {
    for await (const _ of host.request({ endpointId: 'a'.repeat(64), ticket: null }, { type: 'hello', heads: {} })) break;
  }, /not running/);
  await until('the host process let go', () => host.pid === null);
});

test('a killed host is restarted and reported, and its endpoint comes back with the same id', needsIroh, async () => {
  const statuses: HostStatus[] = [];
  const restarts: Array<{ reason: string; attempt: number }> = [];
  const seed = randomBytes(32);
  const host = new CollabHost({
    serve: async () => undefined,
    listener: { status: (s) => statuses.push(s), restarted: (r) => restarts.push(r) },
    restartDelayMs: () => 50,
  });
  hosts.push(host);
  host.start(options(seed));
  await until('the first status', () => statuses.length > 0);
  const firstPid = host.pid;
  assert.ok(firstPid);
  process.kill(firstPid, 'SIGKILL');
  await until('the restart', () => restarts.length > 0);
  assert.equal(restarts[0]?.attempt, 1);
  assert.match(restarts[0]?.reason ?? '', /exited \(SIGKILL\)/);
  const count = statuses.length;
  await until('a status from the new host', () => statuses.length > count && host.pid !== firstPid);
  assert.equal(statuses.at(-1)?.endpointId, endpointIdFromSeed(seed));
  await host.stop();
  assert.equal(host.pid, null, 'with Collaborators off, no host process runs');
});

test('a host that keeps dying is given up as unavailable', needsIroh, async () => {
  const restarts: number[] = [];
  let reason: HostUnavailable | null = null;
  const statuses: HostStatus[] = [];
  const host = new CollabHost({
    serve: async () => undefined,
    listener: { status: (s) => statuses.push(s), restarted: (r) => restarts.push(r.attempt), unavailable: (r) => (reason = r) },
    maxRestarts: 1,
    restartDelayMs: () => 20,
  });
  hosts.push(host);
  host.start(options());
  await until('the first status', () => statuses.length > 0);
  const firstPid = await until('the first host', () => host.pid);
  process.kill(firstPid, 'SIGKILL');
  await until('the restart', () => restarts.length === 1);
  const count = statuses.length;
  await until('a status from the second host', () => statuses.length > count && host.pid !== null && host.pid !== firstPid);
  process.kill(await until('the second host', () => host.pid), 'SIGKILL');
  const got = await until('unavailable', () => reason);
  assert.equal(got.code, 'host');
  assert.deepEqual(restarts, [1]);
});

test('two forked hosts: the serving side answers through IPC and the bytes arrive whole', needsIroh, async () => {
  const payload = randomBytes(2 * 1024 * 1024 + 5);
  const statusA: HostStatus[] = [];
  const statusB: HostStatus[] = [];
  const asked: Array<{ from: string; frame: unknown }> = [];
  const serving = new CollabHost({
    serve: async (from: string, frame: unknown, sink: ReplySink) => {
      asked.push({ from, frame });
      await sink.frame({ type: 'blob', sha256: 'e'.repeat(64), bytes: payload.length });
      for (let at = 0; at < payload.length; at += 1024 * 1024) await sink.bytes(payload.subarray(at, at + 1024 * 1024));
    },
    listener: { status: (s) => statusA.push(s) },
  });
  const seedB = randomBytes(32);
  const asking = new CollabHost({ serve: async () => undefined, listener: { status: (s) => statusB.push(s) } });
  hosts.push(serving, asking);
  serving.start(options());
  asking.start(options(seedB));
  const a = await until('A bound', () => statusA.find((s) => s.directAddresses.length > 0));
  await until('B bound', () => statusB.length > 0);

  const frames: unknown[] = [];
  const parts: Uint8Array[] = [];
  for await (const part of asking.request({ endpointId: a.endpointId, ticket: a.ticket }, { type: 'blob', shareKey: 'github.com/acme/api', sha256: 'e'.repeat(64) })) {
    if ('frame' in part) frames.push(part.frame);
    else parts.push(part.bytes);
  }
  assert.deepEqual(frames, [{ type: 'blob', sha256: 'e'.repeat(64), bytes: payload.length }]);
  assert.ok(Buffer.concat(parts).equals(payload));
  assert.deepEqual(asked, [{ from: endpointIdFromSeed(seedB), frame: { type: 'blob', shareKey: 'github.com/acme/api', sha256: 'e'.repeat(64) } }]);
  await serving.stop();
  await asking.stop();
});
