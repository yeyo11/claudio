import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SyncClient, type Transport } from '../src/collab/client.ts';
import { GroupsStore } from '../src/collab/groups-store.ts';
import type { HostReplyPart } from '../src/collab/host-client.ts';
import { addMember, createGenesis, endpointIdFromSeed, genesisGroupId, headOf } from '../src/collab/roster.ts';
import { CollabStore, Db } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

/*
 * A peer that answers `forbidden` no longer lists this install: its share was revoked or this
 * install was removed. The client records that once on its copies and in the log, asks again ever
 * more rarely instead of on every tick, and says once when the peer answers again. Any other
 * failure that repeats is logged once too. The peer is a stand-in transport, no network.
 */

/**
 * `serving`: the owner lists `k1`, a pull of it ends with its cursor, and it refuses the `watch` (a
 * share it no longer serves). `listening`: the same, but it keeps the `watch` open and acknowledges
 * it once `heard` resolves, as an owner does once its listeners are subscribed
 */
type Mode = 'forbidden' | 'ok' | 'down' | 'serving' | 'listening';

const seedOwner = randomBytes(32);
const owner = endpointIdFromSeed(seedOwner);
const me = endpointIdFromSeed(randomBytes(32));
const genesis = createGenesis({ seed: seedOwner, name: 'Platform', owner: { name: 'Ana' } });
const chain = [genesis, addMember(genesis, seedOwner, me, { name: 'Ben' })];
const groupId = genesisGroupId(genesis);

function setup(mode: { now: Mode; heard?: Promise<void> }, opts: { reconcileMs?: number; refusedMaxMs?: number; config?: ReturnType<typeof tempConfig>; seed?: boolean } = {}) {
  const config = opts.config ?? tempConfig();
  const dir = join(config.dataDir, 'collaborators');
  mkdirSync(dir, { recursive: true });
  // The copy this install kept from the owner's last catalog
  if (opts.seed !== false) writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({ [owner]: { at: new Date().toISOString(), shares: [{ shareKey: 'k1', name: 'api', remote: null, subpath: null, kinds: ['chats'], counts: {}, groupIds: [groupId] }] } }),
  );
  const asked: string[] = [];
  const transport: Transport = {
    request(_to, frame) {
      const type = (frame as { type: string }).type;
      asked.push(type);
      return (async function* (): AsyncGenerator<HostReplyPart> {
        await Promise.resolve();
        if (mode.now === 'down') throw new Error('no route to the peer');
        if (mode.now === 'forbidden') {
          yield { frame: { type: 'error', code: 'forbidden' } };
          return;
        }
        const serving = mode.now === 'serving' || mode.now === 'listening';
        if (type === 'watch' && mode.now === 'listening') {
          await mode.heard;
          yield { frame: { type: 'ack' } };
          // Open until the client lets go of it
          await new Promise<never>(() => undefined);
        }
        if (type === 'hello') yield { frame: { type: 'hello', heads: { [groupId]: headOf(chain) } } };
        else if (type === 'catalog' && serving) yield { frame: { type: 'catalog', groupId, projects: [{ shareKey: 'k1', name: 'api', kinds: ['chats'], counts: {}, versions: { chats: {} } }] } };
        else if (type === 'catalog') yield { frame: { type: 'catalog', groupId, projects: [] } };
        else if (type === 'pull' && serving) yield { frame: { type: 'cursor', cursor: null } };
        else yield { frame: { type: 'error', code: 'not-found' } };
      })();
    },
  };
  const logs: string[] = [];
  const client = new SyncClient({
    transport,
    store: new CollabStore(new Db(config).connection),
    groups: new GroupsStore(config),
    dir,
    ticket: () => null,
    target: (endpointId) => ({ endpointId, ticket: null }),
    sawTicket: () => undefined,
    groupsWith: () => [{ groupId, chain }],
    applyRoster: async () => undefined,
    conflict: () => undefined,
    synced: () => undefined,
    sharesChanged: () => undefined,
    log: (message) => logs.push(message),
    who: (id) => (id === owner ? 'Ana' : id.slice(0, 8)),
    retryMs: 5,
    reconcileMs: opts.reconcileMs ?? 60_000,
    ...(opts.refusedMaxMs !== undefined ? { refusedMaxMs: opts.refusedMaxMs } : {}),
  });
  return { client, logs, asked };
}

test('a refusal is said once on the copy and in the log, however often the peer is asked', async () => {
  const mode = { now: 'forbidden' as Mode };
  const { client, logs } = setup(mode);
  client.setPeers([owner]);
  // Each run is waited for, not a fixed delay: on a loaded machine a run takes longer than any guess
  await client.idle(owner);
  for (let i = 0; i < 5; i++) {
    client.poke(owner);
    await client.idle(owner);
    await client.announce(owner, true);
  }
  assert.equal(client.isRefused(owner), true);
  assert.deepEqual(logs, ['collab: Ana no longer lists this install; its copies stop syncing until it does']);
  const state = client.state(owner, 'k1', { path: null });
  assert.equal(state.error?.code, 'collaborators.sync.forbidden');

  // It lists this install again: said once, and the refusal is over
  mode.now = 'ok';
  client.poke(owner);
  await client.idle(owner);
  assert.equal(client.isRefused(owner), false);
  client.poke(owner);
  await client.idle(owner);
  assert.equal(client.isRefused(owner), false);
  assert.deepEqual(logs.slice(1), ['collab: sync with Ana works again']);
  client.stop();
});

test('idle waits for the run in flight and for the re-run a poke asked for during it', async () => {
  const mode = { now: 'ok' as Mode };
  const { client, asked } = setup(mode);
  client.setPeers([owner]);
  // Poked while the first run is in flight: idle resolves only after the second one, its hello included
  client.poke(owner);
  await client.idle(owner);
  assert.equal(asked.filter((t) => t === 'hello').length, 2);
  assert.equal(asked.at(-1), 'catalog', 'the second run went all the way through');
  // Nothing in flight: it resolves at once
  await client.idle(owner);
  await client.idle(endpointIdFromSeed(randomBytes(32)));
  client.stop();
});

/**
 * How long the mocked clock has to move, a millisecond at a time, before the peer is asked again.
 * The waits are read off the client's own timers, so a loaded machine changes nothing: a run cannot
 * be slower or faster than the clock the test moves (R17 of docs/plans/ci-and-regression-open.md).
 */
async function waitBeforeNextAsk(t: TestContext, client: SyncClient, asks: () => number, limit = 1_000): Promise<number | null> {
  const before = asks();
  for (let ms = 1; ms <= limit; ms++) {
    t.mock.timers.tick(1);
    await client.idle(owner);
    if (asks() > before) return ms;
  }
  return null;
}

async function waitsBeforeAsks(t: TestContext, client: SyncClient, asks: () => number, count: number): Promise<Array<number | null>> {
  const waits: Array<number | null> = [];
  for (let i = 0; i < count; i++) waits.push(await waitBeforeNextAsk(t, client, asks));
  return waits;
}

test('a peer that refuses is asked ever more rarely, not on every tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = { now: 'forbidden' as Mode };
  // A tick every 20 ms: a refusing peer waits 20, 40, 80, 160 ms
  const { client, asked, logs } = setup(mode, { reconcileMs: 20, refusedMaxMs: 10_000 });
  const hellos = () => asked.filter((type) => type === 'hello').length;
  client.setPeers([owner]);
  await client.idle(owner);
  assert.equal(hellos(), 1);
  assert.deepEqual(await waitsBeforeAsks(t, client, hellos, 4), [20, 40, 80, 160]);
  client.stop();
  assert.equal(logs.length, 1);
});

test('the wait before a refusing peer is asked again stops growing at its cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = { now: 'forbidden' as Mode };
  const { client, asked } = setup(mode, { reconcileMs: 10, refusedMaxMs: 20 });
  const hellos = () => asked.filter((type) => type === 'hello').length;
  client.setPeers([owner]);
  await client.idle(owner);
  // Capped at 20 ms; uncapped it would go on 40, 80, 160
  assert.deepEqual(await waitsBeforeAsks(t, client, hellos, 5), [10, 20, 20, 20, 20]);
  client.stop();
});

test('an unreachable peer that stays so is logged once, not on every retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = { now: 'down' as Mode };
  const { client, logs, asked } = setup(mode, { reconcileMs: 20 });
  client.setPeers([owner]);
  await client.idle(owner);
  // Retried from 5 ms, doubling up to the reconcile's 20
  assert.deepEqual(await waitsBeforeAsks(t, client, () => asked.length, 4), [5, 10, 20, 20]);
  client.stop();
  assert.deepEqual(logs, ['collab: sync with Ana failed: no route to the peer']);
  assert.equal(client.isRefused(owner), false);
});

test('a client that is not running reads paused, and syncs again once peers are set', async () => {
  const { client } = setup({ now: 'ok' as Mode });
  // Collaborators off at boot: setPeers never ran
  assert.equal(client.state(owner, 'k1', { path: null }).state, 'paused');
  client.setPeers([owner]);
  await client.idle(owner);
  assert.notEqual(client.state(owner, 'k1', { path: null }).state, 'paused');
  client.stop();
  assert.equal(client.state(owner, 'k1', { path: null }).state, 'paused');
});

// ---------- Offline cases (docs/reports/regression-audit-2026-10-29.md §5.5, §5.7, §5.8) ----------

test('a fresh read of a copy whose owner is offline answers at once from the copy, without dialling', async () => {
  const mode = { now: 'down' as Mode };
  const { client, asked } = setup(mode, { reconcileMs: 60_000 });
  client.setPeers([owner]);
  await client.idle(owner);
  assert.equal(client.isOnline(owner), false);
  const before = asked.length;
  // "At once" is "before any timer or I/O could run", not a guessed number of milliseconds: the
  // answer must settle on the microtasks that follow the call, ahead of the next immediate
  const pull = client.pull(owner, 'k1', 'chats');
  const settled = await Promise.race([pull.then(() => 'resolved', () => 'rejected'), new Promise<string>((r) => setImmediate(() => r('waiting')))]);
  assert.equal(settled, 'rejected', 'the read answered without waiting on anything');
  await assert.rejects(pull, /offline/);
  assert.equal(asked.length, before, 'nothing was asked of the owner');
  client.stop();
});

test('a watch the owner refuses waits like any failure before the peer is synced again, never at once', async () => {
  const mode = { now: 'serving' as Mode };
  const { client, asked } = setup(mode, { reconcileMs: 60_000 });
  client.setPeers([owner]);
  // The window opens once the first run is through, so a loaded machine that takes longer over the
  // hello, the catalog and the pulls does not eat into it: the first watch is opened at the run's end
  await client.idle(owner);
  await new Promise((r) => setTimeout(r, 400));
  client.stop();
  const watches = asked.filter((t) => t === 'watch').length;
  // Backing off from 5 ms and doubling, a handful in 400 ms; at once after each refusal, hundreds
  assert.ok(watches >= 1, 'the watch was opened');
  assert.ok(watches <= 12, `the watch was opened ${String(watches)} times`);
});

test('a copy is live only once its owner acknowledges the watch, and then pulls what changed before it listened', async () => {
  let hear: () => void = () => undefined;
  const mode = { now: 'listening' as Mode, heard: new Promise<void>((resolve) => (hear = resolve)) };
  const { client, asked } = setup(mode, { reconcileMs: 60_000 });
  const pulls = () => asked.filter((t) => t === 'pull').length;
  client.setPeers([owner]);
  await client.idle(owner);
  assert.equal(asked.at(-1), 'watch', 'the run ended by opening the watch');
  // The owner has not subscribed yet: a change it makes now reaches nobody, so the copy is not live
  assert.equal(client.state(owner, 'k1', { path: null }).state, 'synced');
  assert.equal(pulls(), 1);
  hear();
  const deadline = Date.now() + 5_000;
  while (pulls() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(pulls(), 2, `asked ${JSON.stringify(asked)}: no catch-up pull followed the acknowledgement`);
  assert.equal(client.state(owner, 'k1', { path: null }).state, 'live');
  client.stop();
});

test('when a copy last synced is kept across restarts, and a copy never pulled has no such time', async () => {
  const config = tempConfig();
  const fresh = setup({ now: 'down' as Mode }, { config });
  // Listed by the catalog read before the restart, never pulled: not "last synced" at the read
  assert.equal(fresh.client.state(owner, 'k1', { path: null }).lastSyncedAt, null);
  fresh.client.setPeers([owner]);
  await fresh.client.idle(owner);
  assert.equal(fresh.client.state(owner, 'k1', { path: null }).state, 'pending', 'away, and never synced');
  fresh.client.stop();

  const mode = { now: 'serving' as Mode };
  const first = setup(mode, { config, seed: false });
  first.client.setPeers([owner]);
  await first.client.idle(owner);
  const synced = first.client.state(owner, 'k1', { path: null }).lastSyncedAt;
  assert.ok(synced, 'the pull dated the copy');
  first.client.stop();

  // A restart, with the owner away: the copy still says when it synced, and reads offline
  const next = setup({ now: 'down' as Mode }, { config, seed: false });
  assert.equal(next.client.state(owner, 'k1', { path: null }).lastSyncedAt, synced);
  next.client.setPeers([owner]);
  await next.client.idle(owner);
  assert.equal(next.client.state(owner, 'k1', { path: null }).state, 'offline');
  next.client.stop();
});

test('a change announced to a peer that is not reached is dialled once, not twice in a row', async () => {
  const mode = { now: 'down' as Mode };
  const { client, asked } = setup(mode, { reconcileMs: 60_000 });
  // Not among the peers the client follows, so no run of its own asks it anything
  await client.announce(owner, true);
  assert.equal(asked.filter((t) => t === 'hello').length, 1);
  client.stop();
});
