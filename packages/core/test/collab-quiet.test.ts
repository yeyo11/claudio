import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
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

type Mode = 'forbidden' | 'ok' | 'down';

const seedOwner = randomBytes(32);
const owner = endpointIdFromSeed(seedOwner);
const me = endpointIdFromSeed(randomBytes(32));
const genesis = createGenesis({ seed: seedOwner, name: 'Platform', owner: { name: 'Ana' } });
const chain = [genesis, addMember(genesis, seedOwner, me, { name: 'Ben' })];
const groupId = genesisGroupId(genesis);

function setup(mode: { now: Mode }, opts: { reconcileMs?: number; refusedMaxMs?: number } = {}) {
  const config = tempConfig();
  const dir = join(config.dataDir, 'collaborators');
  mkdirSync(dir, { recursive: true });
  // The copy this install kept from the owner's last catalog
  writeFileSync(
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
        if (type === 'hello') yield { frame: { type: 'hello', heads: { [groupId]: headOf(chain) } } };
        else if (type === 'catalog') yield { frame: { type: 'catalog', groupId, projects: [] } };
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
  const state = client.state(owner, 'k1', { path: null, lastSeenAt: null });
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

test('a peer that refuses is asked ever more rarely, not on every tick', async () => {
  const mode = { now: 'forbidden' as Mode };
  // Every 20 ms on a tick: a refusing peer waits 20, 40, 80, 160 ms
  const { client, asked, logs } = setup(mode, { reconcileMs: 20, refusedMaxMs: 10_000 });
  client.setPeers([owner]);
  await new Promise((r) => setTimeout(r, 400));
  client.stop();
  const hellos = asked.filter((t) => t === 'hello').length;
  assert.ok(hellos >= 2, `asked ${String(hellos)} times`);
  assert.ok(hellos <= 7, `asked ${String(hellos)} times: it did not back off`);
  assert.equal(logs.length, 1);
});

test('the wait before a refusing peer is asked again stops growing at its cap', async () => {
  const mode = { now: 'forbidden' as Mode };
  const { client, asked } = setup(mode, { reconcileMs: 10, refusedMaxMs: 20 });
  client.setPeers([owner]);
  await new Promise((r) => setTimeout(r, 400));
  client.stop();
  // Capped at 20 ms, about one ask in each 20 ms; uncapped it would be about five in 400 ms
  assert.ok(asked.filter((t) => t === 'hello').length >= 8);
});

test('an unreachable peer that stays so is logged once, not on every retry', async () => {
  const mode = { now: 'down' as Mode };
  const { client, logs, asked } = setup(mode, { reconcileMs: 20 });
  client.setPeers([owner]);
  await new Promise((r) => setTimeout(r, 200));
  client.stop();
  assert.ok(asked.length >= 3, `asked ${String(asked.length)} times`);
  assert.deepEqual(logs, ['collab: sync with Ana failed: no route to the peer']);
  assert.equal(client.isRefused(owner), false);
});

test('a client that is not running reads paused, and syncs again once peers are set', async () => {
  const { client } = setup({ now: 'ok' as Mode });
  // Collaborators off at boot: setPeers never ran
  assert.equal(client.state(owner, 'k1', { path: null, lastSeenAt: null }).state, 'paused');
  client.setPeers([owner]);
  await client.idle(owner);
  assert.notEqual(client.state(owner, 'k1', { path: null, lastSeenAt: null }).state, 'paused');
  client.stop();
  assert.equal(client.state(owner, 'k1', { path: null, lastSeenAt: null }).state, 'paused');
});
