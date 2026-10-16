import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { ProjectSettings } from '@claudio/shared';
import type { ReaderSources } from '../src/collab/readers.ts';
import { GroupsStore } from '../src/collab/groups-store.ts';
import { addMember, createGenesis, endpointIdFromSeed, genesisGroupId, transferOwnership, type RosterVersion } from '../src/collab/roster.ts';
import { CollaboratorsService, type HostHandle } from '../src/collab/service.ts';
import { CollabStore, Db } from '../src/db.ts';
import type { CoreConfig } from '../src/paths.ts';
import { tempConfig } from './helpers.ts';

/*
 * `Group.frozen` (docs/plans/collaborators.md §3.3): the install that held a group as its owner and
 * holds another key now (its vault lost, or the data restored without it) knows nobody can sign the
 * group's next version. No endpoint is bound: the host is a stand-in that never connects.
 */

const host = (): HostHandle => ({
  start: () => undefined,
  stop: async () => undefined,
  dispose: () => undefined,
  request: () => {
    throw new Error('no network in this test');
  },
  disconnect: () => undefined,
  unavailable: null,
  status: null,
});

const sources = { events: { subscribe: () => () => undefined } } as unknown as ReaderSources;

type Vault = Map<string, Record<string, string>>;

function service(config: CoreConfig, db: Db, vault: Vault): CollaboratorsService {
  return new CollaboratorsService({
    config,
    store: new CollabStore(db.connection),
    vault: { get: (tool) => ({ ...(vault.get(tool) ?? {}) }), set: async (tool, values) => void vault.set(tool, { ...(vault.get(tool) ?? {}), ...values }) },
    emit: () => undefined,
    projects: () => [],
    projectSettings: {
      stored: () => ({}) as ProjectSettings,
      update: async () => ({ before: {} as ProjectSettings, after: {} as ProjectSettings }),
      shareKeyHolder: () => null,
    },
    sources,
    host,
  });
}

const vaultWith = (seed: Buffer): Vault => new Map([['collaborators', { secretKey: seed.toString('hex') }]]);

/** A chain written as an install before `heldAs` was kept would have left it */
async function legacy(groups: GroupsStore, chain: RosterVersion[]): Promise<string> {
  const id = genesisGroupId(chain[0] as RosterVersion);
  await groups.setChain(id, chain);
  return id;
}

test('the owner whose key is lost sees the groups it owned frozen; a group it was a member of or handed over is not', async () => {
  const config = tempConfig();
  const db = new Db(config);
  const groups = new GroupsStore(config);
  const seedA = randomBytes(32);
  const seedO = randomBytes(32);
  const seedB = randomBytes(32);
  const a = endpointIdFromSeed(seedA);
  const b = endpointIdFromSeed(seedB);

  // Chains this install held as `a` before it recorded which key it held them as
  const ownedGenesis = createGenesis({ seed: seedA, name: 'Owned before', owner: { name: 'Ana' } });
  const owned = await legacy(groups, [ownedGenesis]);
  const theirsGenesis = createGenesis({ seed: seedO, name: 'Theirs', owner: { name: 'Olga' } });
  const theirs = await legacy(groups, [theirsGenesis, addMember(theirsGenesis, seedO, a, { name: 'Ana' })]);
  const handedGenesis = createGenesis({ seed: seedA, name: 'Handed over', owner: { name: 'Ana' } });
  const withLuis = addMember(handedGenesis, seedA, b, { name: 'Luis' });
  const handed = await legacy(groups, [handedGenesis, withLuis, transferOwnership(withLuis, seedA, b)]);

  // The install with its key: every chain learns `heldAs`, a new one records it, nothing is frozen
  const vault = vaultWith(seedA);
  const first = service(config, db, vault);
  await first.start();
  await first.update({ enabled: true, displayName: 'Ana' });
  const created = await first.createGroup('Backend');
  assert.equal(created.frozen, false);
  assert.equal(created.isOwner, true);
  for (const g of first.groupList().groups) assert.equal(g.frozen, false, `${g.name} is not frozen while its key is held`);
  for (const id of [owned, theirs, handed, created.id]) assert.equal(groups.read(id)?.heldAs, a);
  await first.dispose();

  // The vault is gone and a new key is made: the groups `a` owned are frozen, the others are not
  const second = service(config, db, new Map());
  await second.start();
  await second.update({ enabled: true });
  const now = second.endpointId();
  assert.ok(now && now !== a);
  const frozen = Object.fromEntries(second.groupList().groups.map((g) => [g.name, g.frozen]));
  assert.deepEqual(frozen, { Backend: true, 'Handed over': false, 'Owned before': true, Theirs: false });
  assert.ok(second.groupList().groups.every((g) => !g.isOwner), 'a frozen group has no owner here');
  assert.equal(second.getGroup(created.id).frozen, true);
  assert.equal(groups.read(created.id)?.heldAs, a, 'the new key is never recorded over the one the chain was held as');
  assert.throws(() => second.createInvite(created.id), /Only the group owner can invite/);
  assert.equal(second.getGroup(theirs).frozen, false, 'to a member, an owner whose key is lost only looks offline');

  // Leaving is the way out, and it takes the record with it
  await second.leaveGroup(created.id);
  assert.equal(groups.read(created.id), null);
  assert.ok(!second.groupList().groups.some((g) => g.id === created.id));
  await second.dispose();

  // The old key back (the vault restored): nothing is frozen any more
  const third = service(config, db, vaultWith(seedA));
  await third.start();
  assert.ok(third.groupList().groups.every((g) => !g.frozen));
  assert.equal(third.getGroup(owned).isOwner, true);
  await third.dispose();
  db.close();
});

test('a chain stored before `heldAs` was kept, found by a key it does not list, is not frozen: nothing tells whose it was', async () => {
  const config = tempConfig();
  const db = new Db(config);
  const groups = new GroupsStore(config);
  const seedA = randomBytes(32);
  const genesis = createGenesis({ seed: seedA, name: 'Unknown', owner: { name: 'Ana' } });
  const id = await legacy(groups, [genesis]);

  const svc = service(config, db, new Map());
  await svc.start();
  await svc.update({ enabled: true });
  assert.equal(svc.getGroup(id).frozen, false);
  assert.equal(groups.read(id)?.heldAs, null, 'a key the head does not list is never recorded');
  await svc.dispose();
  db.close();
});
