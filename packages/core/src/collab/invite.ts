import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { canonicalize } from './canonical.ts';
import { endpointIdFromSeed, isEndpointId, isMember, type RosterVersion } from './roster.ts';

/**
 * Invites and joins (docs/plans/collaborators.md §3.3). Pure: no iroh, no disk.
 *
 * The secret is not stored when the invite is made: it is an HMAC, under a key derived from the
 * owner's seed, of the group, the invite id and the expiry. The owner recomputes it from what the
 * `join` carries, so an expiry cannot be stretched and nothing has to survive until the join
 * arrives; what must survive a restart is the list of used secrets (`collab_used_invites`).
 */

export const INVITE_PREFIX = 'claudio-invite:';
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RELAY_TICKETS = 3;

export interface Invite {
  v: 1;
  groupId: string;
  groupName: string;
  /** The endpoint id of the owner who made the invite; the one key that can sign the join in. */
  owner: string;
  ownerName: string;
  /** The owner's endpoint ticket. */
  ticket: string;
  /** Up to three other members the owner's install saw online, to relay a join through. */
  relays: string[];
  inviteId: string;
  /** 128 bits, hex. */
  secret: string;
  expiresAt: string;
}

/** What the joiner seals to the owner's key: the `sealed` of `join` and `joinRelay` (§4.2). */
export interface JoinPayload {
  groupId: string;
  inviteId: string;
  expiresAt: string;
  secret: string;
  endpointId: string;
  name: string;
  label?: string;
}

const HEX_16 = /^[0-9a-f]{32}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const MAX_TEXT = 200;
const MAX_TICKET = 4096;

function inviteKey(seed: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(seed), Buffer.alloc(0), 'claudio/collab/invite-secret/1', 32));
}

function secretFor(seed: Uint8Array, fields: { groupId: string; inviteId: string; expiresAt: string }): string {
  const mac = createHmac('sha256', inviteKey(seed))
    .update(canonicalize({ groupId: fields.groupId, inviteId: fields.inviteId, expiresAt: fields.expiresAt }))
    .digest();
  return mac.subarray(0, 16).toString('hex');
}

/** What the owner's install records as used, so the secret itself never sits in the database. */
export function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function createInvite(input: {
  seed: Uint8Array;
  head: RosterVersion;
  ticket: string;
  relays?: string[];
  now?: Date;
  ttlMs?: number;
}): Invite {
  const owner = endpointIdFromSeed(input.seed);
  if (input.head.owner !== owner) throw new Error('Only the group owner can invite');
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? INVITE_TTL_MS)).toISOString();
  const inviteId = randomBytes(16).toString('hex');
  const ownerName = input.head.members.find((m) => m.endpointId === owner)?.name ?? '';
  return {
    v: 1,
    groupId: input.head.groupId,
    groupName: input.head.name,
    owner,
    ownerName,
    ticket: input.ticket,
    relays: (input.relays ?? []).slice(0, MAX_RELAY_TICKETS),
    inviteId,
    secret: secretFor(input.seed, { groupId: input.head.groupId, inviteId, expiresAt }),
    expiresAt,
  };
}

export function encodeInvite(invite: Invite): string {
  return INVITE_PREFIX + Buffer.from(canonicalize(invite), 'utf8').toString('base64url');
}

export class InviteFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteFormatError';
  }
}

function isText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Reads a pasted or scanned invite; whitespace and line breaks a chat app adds are ignored. */
export function decodeInvite(text: string): Invite {
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith(INVITE_PREFIX)) throw new InviteFormatError('Not a Claudio invite');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(compact.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new InviteFormatError('The invite is damaged');
  }
  const r = parsed as Partial<Invite> | null;
  if (typeof r !== 'object' || r === null) throw new InviteFormatError('The invite is damaged');
  if (r.v !== 1) throw new InviteFormatError('The invite was made by a newer Claudio');
  if (typeof r.groupId !== 'string' || !HEX_32.test(r.groupId)
    || !isText(r.groupName) || !isEndpointId(r.owner) || !isText(r.ownerName)
    || !isText(r.ticket, MAX_TICKET) || r.ticket === ''
    || !Array.isArray(r.relays) || r.relays.length > MAX_RELAY_TICKETS || !r.relays.every((t) => isText(t, MAX_TICKET) && t !== '')
    || typeof r.inviteId !== 'string' || !HEX_16.test(r.inviteId)
    || typeof r.secret !== 'string' || !HEX_16.test(r.secret)
    || !isTime(r.expiresAt)) {
    throw new InviteFormatError('The invite is damaged');
  }
  return {
    v: 1,
    groupId: r.groupId,
    groupName: r.groupName,
    owner: r.owner,
    ownerName: r.ownerName,
    ticket: r.ticket,
    relays: [...r.relays],
    inviteId: r.inviteId,
    secret: r.secret,
    expiresAt: r.expiresAt,
  };
}

export function isInviteExpired(invite: { expiresAt: string }, now: Date = new Date()): boolean {
  return Date.parse(invite.expiresAt) <= now.getTime();
}

export function joinPayloadFor(invite: Invite, joiner: { endpointId: string; name: string; label?: string }): JoinPayload {
  return {
    groupId: invite.groupId,
    inviteId: invite.inviteId,
    expiresAt: invite.expiresAt,
    secret: invite.secret,
    endpointId: joiner.endpointId,
    name: joiner.name,
    ...(joiner.label !== undefined ? { label: joiner.label } : {}),
  };
}

// --- Sealing: X25519 from the Ed25519 endpoint key, the standard conversion (RFC 7748 §4.1,
// libsodium's crypto_sign_ed25519_*_to_curve25519), then ECIES with HKDF-SHA256 and AES-256-GCM.

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const P = (1n << 255n) - 19n;
const SEALED_VERSION = 1;
const SEAL_INFO = 'claudio/collab/join/1';

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i] as number);
  return n;
}

function bigIntToLittleEndian(n: bigint): Buffer {
  const out = Buffer.alloc(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The Montgomery u of an Edwards public key: u = (1 + y) / (1 - y) mod p. */
export function x25519PublicFromEndpointId(endpointId: string): Buffer {
  if (!isEndpointId(endpointId)) throw new TypeError('Not an endpoint id');
  const bytes = Buffer.from(endpointId, 'hex');
  bytes[31] = (bytes[31] as number) & 0x7f;
  const y = littleEndianToBigInt(bytes);
  if (y >= P || y === 1n) throw new TypeError('Not an endpoint id');
  const u = ((1n + y) * modPow(1n - y, P - 2n)) % P;
  return bigIntToLittleEndian(u);
}

/** The X25519 scalar of an Ed25519 seed: the clamped first half of sha512(seed), as RFC 8032 uses it. */
export function x25519PrivateFromSeed(seed: Uint8Array): Buffer {
  if (seed.length !== 32) throw new TypeError('An endpoint secret key is 32 bytes');
  const scalar = createHash('sha512').update(seed).digest().subarray(0, 32);
  scalar[0] = (scalar[0] as number) & 248;
  scalar[31] = ((scalar[31] as number) & 127) | 64;
  return Buffer.from(scalar);
}

function x25519Private(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

function x25519Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function rawPublic(key: KeyObject): Buffer {
  const spki = key.export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

function sealKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), SEAL_INFO, 32));
}

/**
 * Seals a join to the owner's key, so a member relaying it carries an opaque blob. The group id is
 * authenticated data: a sealed join cannot be replayed into another group's frame.
 */
export function sealJoin(ownerEndpointId: string, payload: JoinPayload): string {
  const recipient = x25519PublicFromEndpointId(ownerEndpointId);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublic(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519Public(recipient) });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(shared, ephemeralRaw, recipient), nonce);
  cipher.setAAD(Buffer.from(payload.groupId, 'utf8'));
  const body = Buffer.concat([cipher.update(canonicalize(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([SEALED_VERSION]), ephemeralRaw, nonce, body, cipher.getAuthTag()]).toString('base64url');
}

/** Opens a sealed join with the owner's seed; null for anything not sealed to it for this group. */
export function openJoin(seed: Uint8Array, groupId: string, sealed: string): JoinPayload | null {
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.length < 1 + 32 + 12 + 16 + 2 || bytes[0] !== SEALED_VERSION) return null;
  const ephemeralRaw = bytes.subarray(1, 33);
  const nonce = bytes.subarray(33, 45);
  const tag = bytes.subarray(bytes.length - 16);
  const body = bytes.subarray(45, bytes.length - 16);
  try {
    const recipient = x25519PublicFromEndpointId(endpointIdFromSeed(seed));
    const shared = diffieHellman({ privateKey: x25519Private(x25519PrivateFromSeed(seed)), publicKey: x25519Public(Buffer.from(ephemeralRaw)) });
    const decipher = createDecipheriv('aes-256-gcm', sealKey(shared, Buffer.from(ephemeralRaw), recipient), nonce);
    decipher.setAAD(Buffer.from(groupId, 'utf8'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return joinPayloadOf(JSON.parse(plain), groupId);
  } catch {
    return null;
  }
}

function joinPayloadOf(value: unknown, groupId: string): JoinPayload | null {
  const r = value as Partial<JoinPayload> | null;
  if (typeof r !== 'object' || r === null) return null;
  if (r.groupId !== groupId || typeof r.inviteId !== 'string' || !HEX_16.test(r.inviteId)
    || typeof r.secret !== 'string' || !HEX_16.test(r.secret) || !isTime(r.expiresAt)
    || !isEndpointId(r.endpointId) || !isText(r.name) || r.name.trim() === ''
    || (r.label !== undefined && !isText(r.label))) {
    return null;
  }
  return {
    groupId: r.groupId,
    inviteId: r.inviteId,
    expiresAt: r.expiresAt,
    secret: r.secret,
    endpointId: r.endpointId,
    name: r.name,
    ...(r.label !== undefined ? { label: r.label } : {}),
  };
}

export type JoinRefusal = 'unreadable' | 'not-owner' | 'bad-secret' | 'expired' | 'used' | 'already-member' | 'wrong-endpoint';

export type JoinCheck =
  | { ok: true; request: JoinPayload; secretHash: string }
  | { ok: false; reason: JoinRefusal };

/**
 * The owner's check of a `join` or `joinRelay`. `isUsed` answers from `collab_used_invites`; the
 * caller records `secretHash` as used in the same step that signs the member in. `from`, when the
 * join came straight from the joiner, is the endpoint id iroh authenticated, which must be the one
 * the joiner sealed.
 */
export function checkJoin(input: {
  seed: Uint8Array;
  head: RosterVersion;
  sealed: string;
  isUsed: (secretHash: string) => boolean;
  now?: Date;
  from?: string;
}): JoinCheck {
  if (input.head.owner !== endpointIdFromSeed(input.seed)) return { ok: false, reason: 'not-owner' };
  const request = openJoin(input.seed, input.head.groupId, input.sealed);
  if (!request) return { ok: false, reason: 'unreadable' };
  const expected = Buffer.from(secretFor(input.seed, request), 'hex');
  const given = Buffer.from(request.secret, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad-secret' };
  if (isInviteExpired(request, input.now)) return { ok: false, reason: 'expired' };
  if (input.from !== undefined && input.from !== request.endpointId) return { ok: false, reason: 'wrong-endpoint' };
  if (isMember(input.head, request.endpointId)) return { ok: false, reason: 'already-member' };
  const hash = secretHash(request.secret);
  if (input.isUsed(hash)) return { ok: false, reason: 'used' };
  return { ok: true, request, secretHash: hash };
}
