import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  checkJoin,
  createInvite,
  decodeInvite,
  encodeInvite,
  INVITE_PREFIX,
  InviteFormatError,
  isInviteExpired,
  joinPayloadFor,
  openJoin,
  sealJoin,
  secretHash,
  x25519PrivateFromSeed,
  x25519PublicFromEndpointId,
} from '../src/collab/invite.ts';
import { addMember, createGenesis, endpointIdFromSeed, transferOwnership, verifyJoinerChain } from '../src/collab/roster.ts';

function install(name: string) {
  const seed = randomBytes(32);
  return { seed, id: endpointIdFromSeed(seed), name };
}

const owner = install('Ana');
const joiner = install('Ben');
const relay = install('Cris');
const now = new Date('2026-10-16T10:00:00.000Z');
const genesis = createGenesis({ seed: owner.seed, name: 'Platform', owner: { name: 'Ana' }, now });
const head = addMember(genesis, owner.seed, relay.id, { name: 'Cris' }, now);

const freshInvite = () => createInvite({ seed: owner.seed, head, ticket: 'endpointaticket', relays: ['t1', 't2', 't3', 't4'], now });

/** The owner's one-time ledger, `collab_used_invites`, as a set that outlives an "install". */
function ledger() {
  const used = new Set<string>();
  return { isUsed: (hash: string) => used.has(hash), use: (hash: string) => void used.add(hash), used };
}

test('an invite round-trips through its text, ignoring the line breaks a chat app adds', () => {
  const invite = freshInvite();
  assert.equal(invite.owner, owner.id);
  assert.equal(invite.groupId, genesis.groupId);
  assert.equal(invite.ownerName, 'Ana');
  assert.match(invite.secret, /^[0-9a-f]{32}$/);
  assert.deepEqual(invite.relays, ['t1', 't2', 't3']);
  assert.equal(invite.expiresAt, '2026-10-23T10:00:00.000Z');
  const text = encodeInvite(invite);
  assert.ok(text.startsWith(INVITE_PREFIX));
  assert.deepEqual(decodeInvite(text), invite);
  assert.deepEqual(decodeInvite(`  ${text.slice(0, 30)}\n${text.slice(30)}\n`), invite);
  assert.notEqual(freshInvite().secret, invite.secret);
});

test('damaged or foreign invite text is refused', () => {
  const text = encodeInvite(freshInvite());
  assert.throws(() => decodeInvite('hello'), InviteFormatError);
  assert.throws(() => decodeInvite(`${INVITE_PREFIX}!!!`), InviteFormatError);
  assert.throws(() => decodeInvite(text.slice(0, -10)), InviteFormatError);
  const tamper = (patch: Record<string, unknown>) =>
    INVITE_PREFIX + Buffer.from(JSON.stringify({ ...freshInvite(), ...patch })).toString('base64url');
  assert.throws(() => decodeInvite(tamper({ v: 2 })), /newer/);
  assert.throws(() => decodeInvite(tamper({ owner: 'ana' })), InviteFormatError);
  assert.throws(() => decodeInvite(tamper({ secret: 'short' })), InviteFormatError);
  assert.throws(() => decodeInvite(tamper({ relays: ['a', 'b', 'c', 'd'] })), InviteFormatError);
});

test('only the owner can invite', () => {
  assert.throws(() => createInvite({ seed: relay.seed, head, ticket: 't' }));
});

test('X25519 derived from the Ed25519 key: both conversions meet', () => {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), x25519PrivateFromSeed(owner.seed)]), format: 'der', type: 'pkcs8' });
  const fromSeed = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  assert.deepEqual(fromSeed, x25519PublicFromEndpointId(owner.id));
  // And ECDH agrees with a stranger's key.
  const other = generateKeyPairSync('x25519');
  const ours = diffieHellman({ privateKey: priv, publicKey: other.publicKey });
  const theirs = diffieHellman({
    privateKey: other.privateKey,
    publicKey: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), x25519PublicFromEndpointId(owner.id)]), format: 'der', type: 'spki' }),
  });
  assert.deepEqual(ours, theirs);
});

test('a relayed join is sealed end to end: the relay cannot read it, the owner can', () => {
  const invite = decodeInvite(encodeInvite(freshInvite()));
  const payload = joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben', label: 'laptop' });
  const sealed = sealJoin(invite.owner, payload);
  assert.ok(!Buffer.from(sealed, 'base64url').toString('latin1').includes(invite.secret));
  assert.equal(openJoin(relay.seed, invite.groupId, sealed), null);
  assert.equal(openJoin(owner.seed, 'f'.repeat(64), sealed), null, 'replayed into another group');
  assert.deepEqual(openJoin(owner.seed, invite.groupId, sealed), payload);
  const flipped = Buffer.from(sealed, 'base64url');
  flipped[50] = (flipped[50] as number) ^ 1;
  assert.equal(openJoin(owner.seed, invite.groupId, flipped.toString('base64url')), null);

  const book = ledger();
  // Relayed: no `from`, the relay is not the joiner.
  const check = checkJoin({ seed: owner.seed, head, sealed, isUsed: book.isUsed, now });
  assert.ok(check.ok);
  assert.equal(check.request.endpointId, joiner.id);
  assert.equal(check.secretHash, secretHash(invite.secret));
  book.use(check.secretHash);
  const signed = addMember(head, owner.seed, check.request.endpointId, { name: check.request.name, label: 'laptop' });
  assert.ok(verifyJoinerChain([genesis, head, signed], invite, joiner.id).ok);
});

test('a direct join must come from the endpoint it names', () => {
  const invite = freshInvite();
  const sealed = sealJoin(owner.id, joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben' }));
  const book = ledger();
  assert.deepEqual(checkJoin({ seed: owner.seed, head, sealed, isUsed: book.isUsed, now, from: relay.id }), { ok: false, reason: 'wrong-endpoint' });
  assert.ok(checkJoin({ seed: owner.seed, head, sealed, isUsed: book.isUsed, now, from: joiner.id }).ok);
});

test('one-time use, across a restart of the owner\'s install', () => {
  const invite = freshInvite();
  const book = ledger();
  const first = sealJoin(owner.id, joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben' }));
  const ok = checkJoin({ seed: owner.seed, head, sealed: first, isUsed: book.isUsed, now });
  assert.ok(ok.ok);
  book.use(ok.secretHash);
  // A restart: nothing in memory but the persisted ledger and the seed from the vault.
  const persisted = [...book.used];
  const restarted = { isUsed: (hash: string) => persisted.includes(hash) };
  const third = install('Dee');
  const second = sealJoin(owner.id, joinPayloadFor(invite, { endpointId: third.id, name: 'Dee' }));
  assert.deepEqual(checkJoin({ seed: Buffer.from(owner.seed), head, sealed: second, ...restarted, now }), { ok: false, reason: 'used' });
  // The ledger never holds the secret itself.
  assert.ok(!persisted.includes(invite.secret));
});

test('expiry: refused at the time in the invite, and it cannot be stretched', () => {
  const invite = freshInvite();
  const book = ledger();
  const later = new Date(Date.parse(invite.expiresAt));
  assert.ok(!isInviteExpired(invite, new Date(later.getTime() - 1)));
  assert.ok(isInviteExpired(invite, later));
  const sealed = sealJoin(owner.id, joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben' }));
  assert.deepEqual(checkJoin({ seed: owner.seed, head, sealed, isUsed: book.isUsed, now: later }), { ok: false, reason: 'expired' });
  // A joiner who moves the expiry forward breaks the secret.
  const stretched = sealJoin(owner.id, { ...joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben' }), expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(checkJoin({ seed: owner.seed, head, sealed: stretched, isUsed: book.isUsed, now: later }), { ok: false, reason: 'bad-secret' });
});

test('a guessed secret, an existing member, and a former owner are refused', () => {
  const invite = freshInvite();
  const book = ledger();
  const guessed = sealJoin(owner.id, { ...joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben' }), secret: randomBytes(16).toString('hex') });
  assert.deepEqual(checkJoin({ seed: owner.seed, head, sealed: guessed, isUsed: book.isUsed, now }), { ok: false, reason: 'bad-secret' });
  const member = sealJoin(owner.id, joinPayloadFor(invite, { endpointId: relay.id, name: 'Cris' }));
  assert.deepEqual(checkJoin({ seed: owner.seed, head, sealed: member, isUsed: book.isUsed, now }), { ok: false, reason: 'already-member' });
  const handedOver = transferOwnership(head, owner.seed, relay.id, now);
  const late = sealJoin(owner.id, joinPayloadFor(invite, { endpointId: joiner.id, name: 'Ben' }));
  assert.deepEqual(checkJoin({ seed: owner.seed, head: handedOver, sealed: late, isUsed: book.isUsed, now }), { ok: false, reason: 'not-owner' });
  assert.deepEqual(checkJoin({ seed: owner.seed, head, sealed: 'garbage', isUsed: book.isUsed, now }), { ok: false, reason: 'unreadable' });
});
