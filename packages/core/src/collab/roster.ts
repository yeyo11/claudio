import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes } from './canonical.ts';

/**
 * The signed roster chain of a group (docs/plans/collaborators.md §3.3). Pure: no iroh, no disk.
 * Keys are the install's iroh endpoint key, handled here as the 32-byte Ed25519 seed the endpoint
 * shares, so a signature made with `node:crypto` verifies with iroh's `EndpointId.verify` and back.
 *
 * The shapes mirror `RosterVersion` and `RosterMember` of `@claudio/shared`; they are declared here
 * structurally so this module stands on its own.
 */
export interface RosterMember {
  endpointId: string;
  name: string;
  label?: string;
  role: 'owner' | 'member';
  addedAt: string;
}

export interface RosterVersion {
  groupId: string;
  version: number;
  prevHash: string | null;
  name: string;
  owner: string;
  members: RosterMember[];
  issuedAt: string;
  signature: string;
}

export type UnsignedVersion = Omit<RosterVersion, 'signature'>;

/** A chain's tip, what `hello` carries per group (§4.2). */
export interface RosterHead {
  version: number;
  hash: string;
}

export type RosterFailure =
  | 'malformed'
  | 'not-genesis'
  | 'bad-group-id'
  | 'second-genesis'
  | 'wrong-group'
  | 'bad-version'
  | 'bad-prev-hash'
  | 'bad-signature'
  | 'wrong-owner'
  | 'not-listed'
  | 'equivocation'
  | 'empty';

export class RosterError extends Error {
  constructor(readonly reason: RosterFailure, readonly version: number | null, message: string) {
    super(message);
    this.name = 'RosterError';
  }
}

export type VerifyResult =
  | { ok: true; head: RosterVersion }
  | { ok: false; reason: RosterFailure; version: number | null; message: string };

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

// DER wrappers of RFC 8410: a raw 32-byte Ed25519 seed or public key becomes a KeyObject.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function isEndpointId(value: unknown): value is string {
  return typeof value === 'string' && HEX_32.test(value);
}

function seedBuffer(seed: Uint8Array): Buffer {
  if (seed.length !== 32) throw new TypeError('An endpoint secret key is 32 bytes');
  return Buffer.from(seed);
}

export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seedBuffer(seed)]), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(endpointId: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(endpointId, 'hex')]), format: 'der', type: 'spki' });
}

/** The endpoint id (lower-case hex of the Ed25519 public key) that a seed signs as. */
export function endpointIdFromSeed(seed: Uint8Array): string {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('hex');
}

export function signBytes(seed: Uint8Array, bytes: Uint8Array): string {
  return edSign(null, bytes, privateKeyFromSeed(seed)).toString('hex');
}

export function verifyBytes(endpointId: string, bytes: Uint8Array, signature: string): boolean {
  if (!isEndpointId(endpointId) || typeof signature !== 'string' || !HEX_64.test(signature)) return false;
  try {
    return edVerify(null, bytes, publicKeyObject(endpointId), Buffer.from(signature, 'hex'));
  } catch {
    // A public key that is not a curve point is a forged id, not a crash.
    return false;
  }
}

function unsigned(version: RosterVersion | UnsignedVersion): UnsignedVersion {
  const { signature: _signature, ...rest } = version as RosterVersion;
  return rest;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** sha256 of the canonical bytes of a version without its signature: what `prevHash` names. */
export function versionHash(version: RosterVersion | UnsignedVersion): string {
  return sha256Hex(canonicalBytes(unsigned(version)));
}

/**
 * The self-certifying group id. Version 1 cannot contain its own hash, so the id is the hash of the
 * genesis without `signature` and without `groupId`; the signature then covers the id too.
 */
export function genesisGroupId(genesis: RosterVersion | UnsignedVersion): string {
  const { groupId: _groupId, ...rest } = unsigned(genesis);
  return sha256Hex(canonicalBytes(rest));
}

export function headOf(chain: readonly RosterVersion[]): RosterHead {
  const head = chain.at(-1);
  if (!head) throw new RosterError('empty', null, 'The chain is empty');
  return { version: head.version, hash: versionHash(head) };
}

function signVersion(seed: Uint8Array, body: UnsignedVersion): RosterVersion {
  return { ...body, signature: signBytes(seed, canonicalBytes(body)) };
}

function iso(now: Date | string | undefined): string {
  if (typeof now === 'string') return now;
  return (now ?? new Date()).toISOString();
}

export interface MemberInput {
  name: string;
  label?: string;
}

/** A new group with its creator as owner, at version 1. */
export function createGenesis(input: { seed: Uint8Array; name: string; owner: MemberInput; now?: Date | string }): RosterVersion {
  const issuedAt = iso(input.now);
  const owner = endpointIdFromSeed(input.seed);
  const body: Omit<UnsignedVersion, 'groupId'> = {
    version: 1,
    prevHash: null,
    name: input.name,
    owner,
    members: [member(owner, input.owner, 'owner', issuedAt)],
    issuedAt,
  };
  return signVersion(input.seed, { groupId: genesisGroupId(body as UnsignedVersion), ...body });
}

function member(endpointId: string, input: MemberInput, role: RosterMember['role'], addedAt: string): RosterMember {
  return { endpointId, name: input.name, ...(input.label !== undefined ? { label: input.label } : {}), role, addedAt };
}

/**
 * Signs the version after `prev`. Only `prev.owner` can: the next version's signer is the previous
 * version's owner, which is what lets the current owner hand the group over (§3.3).
 */
export function signNext(
  prev: RosterVersion,
  seed: Uint8Array,
  change: { name?: string; owner?: string; members: RosterMember[] },
  now?: Date | string,
): RosterVersion {
  if (endpointIdFromSeed(seed) !== prev.owner) {
    throw new RosterError('wrong-owner', prev.version + 1, 'Only the group owner can sign the next roster version');
  }
  const next: UnsignedVersion = {
    groupId: prev.groupId,
    version: prev.version + 1,
    prevHash: versionHash(prev),
    name: change.name ?? prev.name,
    owner: change.owner ?? prev.owner,
    members: change.members,
    issuedAt: iso(now),
  };
  const problem = shapeProblem(next);
  if (problem) throw new RosterError('malformed', next.version, problem);
  return signVersion(seed, next);
}

export function addMember(prev: RosterVersion, seed: Uint8Array, endpointId: string, input: MemberInput, now?: Date | string): RosterVersion {
  if (isMember(prev, endpointId)) throw new RosterError('malformed', prev.version + 1, `${endpointId} is already a member`);
  const at = iso(now);
  return signNext(prev, seed, { members: [...prev.members, member(endpointId, input, 'member', at)] }, at);
}

export function removeMember(prev: RosterVersion, seed: Uint8Array, endpointId: string, now?: Date | string): RosterVersion {
  if (endpointId === prev.owner) throw new RosterError('malformed', prev.version + 1, 'The owner cannot be removed; transfer the group first');
  if (!isMember(prev, endpointId)) throw new RosterError('not-listed', prev.version + 1, `${endpointId} is not a member`);
  return signNext(prev, seed, { members: prev.members.filter((m) => m.endpointId !== endpointId) }, now);
}

/** Signed by the current owner; the new owner signs every version after this one. */
export function transferOwnership(prev: RosterVersion, seed: Uint8Array, newOwner: string, now?: Date | string): RosterVersion {
  if (!isMember(prev, newOwner)) throw new RosterError('not-listed', prev.version + 1, `${newOwner} is not a member`);
  const members = prev.members.map((m): RosterMember => ({ ...m, role: m.endpointId === newOwner ? 'owner' : 'member' }));
  return signNext(prev, seed, { owner: newOwner, members }, now);
}

function shapeProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'A roster version is an object';
  const r = v as Partial<RosterVersion>;
  if (typeof r.groupId !== 'string' || !HEX_32.test(r.groupId)) return 'groupId is not a sha256';
  if (!Number.isSafeInteger(r.version) || (r.version as number) < 1) return 'version is not a positive integer';
  if (r.version === 1 ? r.prevHash !== null : typeof r.prevHash !== 'string' || !HEX_32.test(r.prevHash)) return 'prevHash does not fit the version';
  if (typeof r.name !== 'string' || r.name.trim() === '') return 'The group has no name';
  if (!isEndpointId(r.owner)) return 'owner is not an endpoint id';
  if (typeof r.issuedAt !== 'string' || Number.isNaN(Date.parse(r.issuedAt))) return 'issuedAt is not a time';
  if (!Array.isArray(r.members)) return 'members is not a list';
  const seen = new Set<string>();
  let owners = 0;
  for (const m of r.members as unknown[]) {
    if (typeof m !== 'object' || m === null) return 'A member is not an object';
    const e = m as Partial<RosterMember>;
    if (!isEndpointId(e.endpointId)) return 'A member has no endpoint id';
    if (seen.has(e.endpointId)) return `${e.endpointId} is listed twice`;
    seen.add(e.endpointId);
    if (typeof e.name !== 'string') return 'A member has no name';
    if (e.label !== undefined && typeof e.label !== 'string') return 'A member label is not text';
    if (e.role !== 'owner' && e.role !== 'member') return 'A member has no role';
    if (typeof e.addedAt !== 'string') return 'A member has no addedAt';
    if (e.role === 'owner') {
      owners += 1;
      if (e.endpointId !== r.owner) return 'A member other than the owner has the owner role';
    }
  }
  if (owners !== 1) return 'The owner is not listed exactly once with the owner role';
  if (typeof r.signature !== 'string' && 'signature' in r) return 'signature is not text';
  return null;
}

function fail(reason: RosterFailure, version: number | null, message: string): VerifyResult {
  return { ok: false, reason, version, message };
}

function checkGenesis(genesis: RosterVersion, expected: { groupId?: string }): VerifyResult {
  const problem = shapeProblem(genesis);
  if (problem) return fail('malformed', 1, problem);
  if (genesis.version !== 1) return fail('not-genesis', genesis.version, 'A chain starts at version 1');
  if (genesisGroupId(genesis) !== genesis.groupId) return fail('bad-group-id', 1, 'The genesis does not hash to its group id');
  if (expected.groupId !== undefined && genesis.groupId !== expected.groupId) return fail('wrong-group', 1, 'The chain belongs to another group');
  if (!verifyBytes(genesis.owner, canonicalBytes(unsigned(genesis)), genesis.signature)) {
    return fail('bad-signature', 1, 'The genesis is not signed by its owner');
  }
  return { ok: true, head: genesis };
}

/** One link: `next` follows `prev`, is signed by `prev.owner`, and is well formed. */
export function checkLink(prev: RosterVersion, next: RosterVersion): VerifyResult {
  const problem = shapeProblem(next);
  if (problem) return fail('malformed', typeof next?.version === 'number' ? next.version : null, problem);
  if (next.version === 1) return fail('second-genesis', 1, 'A second genesis cannot extend a chain');
  if (next.groupId !== prev.groupId) return fail('wrong-group', next.version, 'The version belongs to another group');
  if (next.version !== prev.version + 1) return fail('bad-version', next.version, `Version ${next.version} cannot follow version ${prev.version}`);
  if (next.prevHash !== versionHash(prev)) return fail('bad-prev-hash', next.version, `Version ${next.version} does not name version ${prev.version}`);
  if (!verifyBytes(prev.owner, canonicalBytes(unsigned(next)), next.signature)) {
    return fail('bad-signature', next.version, `Version ${next.version} is not signed by the owner of version ${prev.version}`);
  }
  return { ok: true, head: next };
}

/** A whole chain from its genesis; `groupId`, when given, is the group the caller expects. */
export function verifyChain(chain: readonly RosterVersion[], expected: { groupId?: string } = {}): VerifyResult {
  const [genesis, ...rest] = chain;
  if (!genesis) return fail('empty', null, 'The chain is empty');
  let result = checkGenesis(genesis, expected);
  for (const next of rest) {
    if (!result.ok) return result;
    result = checkLink(result.head, next);
  }
  return result;
}

/** A suffix on top of a head the caller already verified: each link in order. */
export function verifySuffix(head: RosterVersion, suffix: readonly RosterVersion[]): VerifyResult {
  let result: VerifyResult = { ok: true, head };
  for (const next of suffix) {
    if (!result.ok) return result;
    result = checkLink(result.head, next);
  }
  return result;
}

/**
 * Extends a verified chain with what a peer sent (`roster {groupId, sinceVersion}`). Versions the
 * chain already holds are skipped when identical; one that disagrees is an equivocation, and the
 * version verified first is kept (§3.3). Returns the new chain, or throws a RosterError.
 */
export function extendChain(chain: readonly RosterVersion[], received: readonly RosterVersion[]): RosterVersion[] {
  if (chain.length === 0) throw new RosterError('empty', null, 'The chain is empty');
  const head = chain.at(-1) as RosterVersion;
  const fresh: RosterVersion[] = [];
  for (const version of received) {
    if (typeof version?.version === 'number' && version.version <= head.version && fresh.length === 0) {
      const held = chain[version.version - 1];
      if (held) {
        // Same body: the copy held was verified already, whatever the peer's signature bytes are.
        if (versionHash(held) === versionHash(version)) continue;
        const prev = chain[version.version - 2];
        const link = prev ? checkLink(prev, version) : checkGenesis(version, { groupId: held.groupId });
        if (link.ok) throw new RosterError('equivocation', version.version, `Version ${version.version} disagrees with the one held`);
        throw new RosterError(link.reason, link.version, link.message);
      }
    }
    fresh.push(version);
  }
  const result = verifySuffix(head, fresh);
  if (!result.ok) throw new RosterError(result.reason, result.version, result.message);
  return [...chain, ...fresh];
}

/**
 * What a joiner accepts as its first chain: the group the invite names (the self-certifying id
 * binds its genesis), an invite owner who has owned the group at some version (after a transfer the
 * inviter is not the genesis owner), and a head that lists the joiner.
 */
export function verifyJoinerChain(
  chain: readonly RosterVersion[],
  invite: { groupId: string; owner: string },
  joiner: string,
): VerifyResult {
  const result = verifyChain(chain, { groupId: invite.groupId });
  if (!result.ok) return result;
  if (!chain.some((v) => v.owner === invite.owner)) return fail('wrong-owner', null, 'The chain was never owned by the invite\'s owner');
  if (!isMember(result.head, joiner)) return fail('not-listed', result.head.version, 'The chain does not list the joiner');
  return result;
}

export type HeadComparison = 'same' | 'behind' | 'ahead' | 'equivocation';

/** `local` against a peer's `hello` head: who pulls, or a fork made by the owner signing twice. */
export function compareHeads(local: RosterHead, remote: RosterHead): HeadComparison {
  if (local.version === remote.version) return local.hash === remote.hash ? 'same' : 'equivocation';
  return local.version < remote.version ? 'behind' : 'ahead';
}

/**
 * Two validly signed versions of one group with one number and two hashes: proof that the owner's
 * install signed twice. Both must verify against the same predecessor's owner, so a forged copy
 * never counts as one.
 */
export function isEquivocation(prev: RosterVersion, a: RosterVersion, b: RosterVersion): boolean {
  if (a.version !== b.version || versionHash(a) === versionHash(b)) return false;
  return checkLink(prev, a).ok && checkLink(prev, b).ok;
}

/**
 * The owner's way out of an equivocation: the head most connected peers hold, ties to the lower
 * hash so every install picks the same one. The owner then signs a higher version on top of it.
 */
export function majorityHead(heads: readonly RosterHead[]): RosterHead | null {
  const counts = new Map<string, { head: RosterHead; count: number }>();
  for (const head of heads) {
    const key = `${head.version}:${head.hash}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { head, count: 1 });
  }
  let best: { head: RosterHead; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count || (entry.count === best.count && (entry.head.version > best.head.version
      || (entry.head.version === best.head.version && entry.head.hash < best.head.hash)))) {
      best = entry;
    }
  }
  return best?.head ?? null;
}

/** Versions after `sinceVersion`, what `roster {groupId, sinceVersion}` answers with. */
export function suffixSince(chain: readonly RosterVersion[], sinceVersion: number): RosterVersion[] {
  return chain.filter((v) => v.version > sinceVersion);
}

export function findMember(version: RosterVersion, endpointId: string): RosterMember | undefined {
  return version.members.find((m) => m.endpointId === endpointId);
}

export function isMember(version: RosterVersion, endpointId: string): boolean {
  return findMember(version, endpointId) !== undefined;
}

export function isOwner(version: RosterVersion, endpointId: string): boolean {
  return version.owner === endpointId;
}

/** Members of `next` that `prev` did not list, and members `prev` listed that `next` dropped. */
export function membershipChanges(prev: RosterVersion, next: RosterVersion): { added: RosterMember[]; removed: RosterMember[] } {
  const before = new Set(prev.members.map((m) => m.endpointId));
  const after = new Set(next.members.map((m) => m.endpointId));
  return {
    added: next.members.filter((m) => !before.has(m.endpointId)),
    removed: prev.members.filter((m) => !after.has(m.endpointId)),
  };
}
