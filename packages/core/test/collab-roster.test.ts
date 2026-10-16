import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { canonicalize } from '../src/collab/canonical.ts';
import {
  addMember,
  compareHeads,
  createGenesis,
  endpointIdFromSeed,
  extendChain,
  genesisGroupId,
  headOf,
  isEquivocation,
  isMember,
  isOwner,
  majorityHead,
  membershipChanges,
  removeMember,
  RosterError,
  type RosterVersion,
  signBytes,
  signNext,
  suffixSince,
  transferOwnership,
  verifyBytes,
  verifyChain,
  verifyJoinerChain,
  verifySuffix,
  versionHash,
} from '../src/collab/roster.ts';

const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`;

function install(name: string, label?: string) {
  const seed = randomBytes(32);
  return { seed, id: endpointIdFromSeed(seed), name, ...(label ? { label } : {}) };
}

const ana = install('Ana', 'desktop');
const ben = install('Ben');
const cris = install('Cris', 'laptop');
const mallory = install('Mallory');

function groupOf(): RosterVersion[] {
  const genesis = createGenesis({ seed: ana.seed, name: 'Platform', owner: { name: ana.name, label: 'desktop' }, now: at(0) });
  const v2 = addMember(genesis, ana.seed, ben.id, { name: ben.name }, at(1));
  return [genesis, v2];
}

/** Re-signs a tampered body with `seed`, so only the rule under test can reject it. */
function resign(version: RosterVersion, seed: Buffer): RosterVersion {
  const { signature: _signature, ...body } = version;
  return { ...body, signature: signBytes(seed, Buffer.from(canonicalize(body), 'utf8')) };
}

test('RFC 8785: keys sorted by code unit, no whitespace, undefined fields dropped, numbers in ES form', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalize({ '€': 1, '\r': 2, '😀': 3, 1: 4 }), '{"\\r":2,"1":4,"€":1,"😀":3}');
  assert.equal(canonicalize({ n: 1e21, m: 0.000001, z: -0 }), '{"m":0.000001,"n":1e+21,"z":0}');
  assert.equal(canonicalize(' \u001f'), '" \\u001f"');
  assert.throws(() => canonicalize({ n: Number.NaN }), TypeError);
  assert.throws(() => canonicalize([undefined]), TypeError);
  assert.throws(() => canonicalize(new Date()), TypeError);
});

test('node:crypto signs over the 32-byte seed and verifies by endpoint id', () => {
  const bytes = Buffer.from('hello');
  const signature = signBytes(ana.seed, bytes);
  assert.match(ana.id, /^[0-9a-f]{64}$/);
  assert.ok(verifyBytes(ana.id, bytes, signature));
  assert.ok(!verifyBytes(ben.id, bytes, signature));
  assert.ok(!verifyBytes(ana.id, Buffer.from('hellO'), signature));
  assert.ok(!verifyBytes('zz', bytes, signature));
  // A deterministic scheme: two installs with the same version agree on its signature too.
  assert.equal(signBytes(ana.seed, bytes), signature);
});

test('genesis is self-certifying and verifies from nothing', () => {
  const [genesis] = groupOf();
  assert.ok(genesis);
  assert.equal(genesis.version, 1);
  assert.equal(genesis.prevHash, null);
  assert.equal(genesis.owner, ana.id);
  assert.equal(genesis.groupId, genesisGroupId(genesis));
  assert.deepEqual(genesis.members, [{ endpointId: ana.id, name: 'Ana', label: 'desktop', role: 'owner', addedAt: at(0) }]);
  const result = verifyChain([genesis], { groupId: genesis.groupId });
  assert.ok(result.ok);
  // Field order does not change the hash: canonical bytes.
  const reordered = Object.fromEntries(Object.entries(genesis).reverse()) as unknown as RosterVersion;
  assert.equal(versionHash(reordered), versionHash(genesis));
});

test('every forged variant is rejected', () => {
  const chain = groupOf();
  const [genesis, v2] = chain as [RosterVersion, RosterVersion];
  const reasonOf = (c: RosterVersion[], expected?: { groupId?: string }) => {
    const result = verifyChain(c, expected);
    return result.ok ? 'ok' : result.reason;
  };
  assert.equal(reasonOf(chain), 'ok');

  // Wrong signer: Mallory signs a version that adds herself.
  const byMallory = resign({ ...v2, members: [...v2.members, { endpointId: mallory.id, name: 'Mallory', role: 'member', addedAt: at(2) }] }, mallory.seed);
  assert.equal(reasonOf([genesis, byMallory]), 'bad-signature');
  // Tampered body with the original signature.
  assert.equal(reasonOf([genesis, { ...v2, name: 'Renamed' }]), 'bad-signature');
  // Broken prevHash, even when re-signed by the rightful owner.
  assert.equal(reasonOf([genesis, resign({ ...v2, prevHash: 'a'.repeat(64) }, ana.seed)]), 'bad-prev-hash');
  // Equal version: a second version 2 on top of version 2.
  const sameNumber = resign({ ...v2, prevHash: versionHash(v2), issuedAt: at(3) }, ana.seed);
  assert.equal(reasonOf([genesis, v2, sameNumber]), 'bad-version');
  // A skipped version.
  assert.equal(reasonOf([genesis, resign({ ...v2, version: 3 }, ana.seed)]), 'bad-version');
  // Second genesis: a version 1 appended to a chain.
  const otherGenesis = createGenesis({ seed: ana.seed, name: 'Platform', owner: { name: 'Ana' }, now: at(4) });
  assert.equal(reasonOf([genesis, otherGenesis]), 'second-genesis');
  // A genesis whose group id was set to another group's.
  const mallorysGenesis = createGenesis({ seed: mallory.seed, name: 'Platform', owner: { name: 'Mallory' }, now: at(0) });
  const posing = resign({ ...mallorysGenesis, groupId: genesis.groupId }, mallory.seed);
  assert.equal(reasonOf([posing]), 'bad-group-id');
  assert.equal(reasonOf([posing, resign({ ...v2, prevHash: versionHash(posing) }, mallory.seed)]), 'bad-group-id');
  // Another group's valid chain where this group is expected.
  assert.equal(reasonOf([mallorysGenesis], { groupId: genesis.groupId }), 'wrong-group');
  // A chain that does not start at 1.
  assert.equal(reasonOf([v2]), 'not-genesis');
  // Owner not listed as owner, a duplicate member, an id that is not a key.
  assert.equal(reasonOf([genesis, resign({ ...v2, members: v2.members.map((m) => ({ ...m, role: 'member' as const })) }, ana.seed)]), 'malformed');
  assert.equal(reasonOf([genesis, resign({ ...v2, members: [...v2.members, v2.members[1]!] }, ana.seed)]), 'malformed');
  assert.equal(reasonOf([genesis, { ...v2, signature: 'nope' }]), 'bad-signature');
  assert.equal(reasonOf([]), 'empty');
});

test('signNext refuses any seed but the owner\'s', () => {
  const [, v2] = groupOf() as [RosterVersion, RosterVersion];
  assert.throws(() => addMember(v2, ben.seed, cris.id, { name: 'Cris' }), (e: unknown) => e instanceof RosterError && e.reason === 'wrong-owner');
  assert.throws(() => removeMember(v2, ana.seed, ana.id), RosterError);
  assert.throws(() => addMember(v2, ana.seed, ben.id, { name: 'Ben' }), RosterError);
});

test('a joiner rejects a chain whose owner is not the invite\'s, and one that does not list it', () => {
  const chain = groupOf();
  const genesis = chain[0]!;
  const invite = { groupId: genesis.groupId, owner: ana.id };
  assert.ok(verifyJoinerChain(chain, invite, ben.id).ok);

  // Mallory answers the join with a group of her own, listing Ben.
  const own = createGenesis({ seed: mallory.seed, name: 'Platform', owner: { name: 'Mallory' } });
  const hers = [own, addMember(own, mallory.seed, ben.id, { name: 'Ben' })];
  const refused = verifyJoinerChain(hers, invite, ben.id);
  assert.ok(!refused.ok && refused.reason === 'wrong-group');
  // An invite whose owner never owned the chain.
  const forgedInvite = verifyJoinerChain(chain, { groupId: genesis.groupId, owner: mallory.id }, ben.id);
  assert.ok(!forgedInvite.ok && forgedInvite.reason === 'wrong-owner');
  // The right group, but its head does not list the joiner.
  const notListed = verifyJoinerChain(chain, invite, cris.id);
  assert.ok(!notListed.ok && notListed.reason === 'not-listed');
});

test('a peer offline across five versions converges from the suffix', () => {
  const chain = groupOf();
  const behind = [...chain];
  let head = chain.at(-1)!;
  head = addMember(head, ana.seed, cris.id, { name: 'Cris', label: 'laptop' }, at(10));
  chain.push(head);
  head = signNext(head, ana.seed, { name: 'Platform team', members: head.members }, at(11));
  chain.push(head);
  head = removeMember(head, ana.seed, cris.id, at(12));
  chain.push(head);
  head = addMember(head, ana.seed, cris.id, { name: 'Cris', label: 'desktop' }, at(13));
  chain.push(head);
  head = transferOwnership(head, ana.seed, cris.id, at(14));
  chain.push(head);
  assert.equal(chain.length - behind.length, 5);

  const local = headOf(behind);
  const remote = headOf(chain);
  assert.equal(compareHeads(local, remote), 'behind');
  assert.equal(compareHeads(remote, local), 'ahead');
  const suffix = suffixSince(chain, local.version);
  assert.equal(suffix.length, 5);
  assert.ok(verifySuffix(behind.at(-1)!, suffix).ok);
  const converged = extendChain(behind, suffix);
  assert.deepEqual(headOf(converged), remote);
  assert.ok(verifyChain(converged, { groupId: chain[0]!.groupId }).ok);
  // A peer that sends overlapping versions is fine; one with a link missing is not.
  assert.deepEqual(headOf(extendChain(behind, suffixSince(chain, 0))), remote);
  assert.throws(() => extendChain(behind, suffix.slice(1)), (e: unknown) => e instanceof RosterError && e.reason === 'bad-version');
  assert.equal(compareHeads(headOf(converged), remote), 'same');
});

test('transfer: the old owner signs the hand-over, the new owner signs from then on', () => {
  const chain = groupOf();
  const v2 = chain.at(-1)!;
  const v3 = transferOwnership(v2, ana.seed, ben.id, at(20));
  assert.equal(v3.owner, ben.id);
  assert.ok(isOwner(v3, ben.id) && !isOwner(v3, ana.id));
  assert.deepEqual(v3.members.map((m) => m.role), ['member', 'owner']);
  assert.ok(verifyChain([...chain, v3]).ok);
  // Ana can no longer sign, Ben can, and a version Ana signed anyway is rejected.
  assert.throws(() => addMember(v3, ana.seed, cris.id, { name: 'Cris' }), RosterError);
  const v4 = addMember(v3, ben.seed, cris.id, { name: 'Cris' }, at(21));
  assert.ok(verifyChain([...chain, v3, v4]).ok);
  const byOldOwner = resign(v4, ana.seed);
  const result = verifyChain([...chain, v3, byOldOwner]);
  assert.ok(!result.ok && result.reason === 'bad-signature');
  // Transfer to someone not in the group is refused.
  assert.throws(() => transferOwnership(v2, ana.seed, mallory.id), RosterError);
  // The new owner can remove the old one.
  const v5 = removeMember(v4, ben.seed, ana.id, at(22));
  assert.ok(!isMember(v5, ana.id));
  assert.deepEqual(membershipChanges(v4, v5).removed.map((m) => m.endpointId), [ana.id]);
});

test('equivocation: same version, different hash, the first verified is kept', () => {
  const chain = groupOf();
  const v2 = chain.at(-1)!;
  const left = addMember(v2, ana.seed, cris.id, { name: 'Cris' }, at(30));
  const right = signNext(v2, ana.seed, { name: 'Other', members: v2.members }, at(30));
  assert.equal(compareHeads(headOf([...chain, left]), headOf([...chain, right])), 'equivocation');
  assert.ok(isEquivocation(v2, left, right));
  // A forged "other" version is not proof of the owner signing twice.
  assert.ok(!isEquivocation(v2, left, resign(right, mallory.seed)));

  const held = [...chain, left];
  assert.throws(() => extendChain(held, [right]), (e: unknown) => e instanceof RosterError && e.reason === 'equivocation');
  assert.throws(() => extendChain(held, [resign(right, mallory.seed)]), (e: unknown) => e instanceof RosterError && e.reason === 'bad-signature');
  assert.deepEqual(headOf(held), headOf([...chain, left]));

  // The owner resolves on top of the head most connected peers hold, deterministically on a tie.
  const l = headOf([...chain, left]);
  const r = headOf([...chain, right]);
  assert.deepEqual(majorityHead([l, r, r]), r);
  assert.deepEqual(majorityHead([l, r]), l.hash < r.hash ? l : r);
  assert.equal(majorityHead([]), null);
  const resolved = signNext(right, ana.seed, { members: right.members }, at(31));
  assert.ok(verifyChain([...chain, right, resolved]).ok);
});
