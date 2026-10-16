import { COLLABORATORS_KINDS, type CollaboratorsKind } from '@claudio/shared';
import type { RosterHead, RosterVersion } from './roster.ts';

/*
 * The wire of `claudio/collab/1` (docs/plans/collaborators.md §4.2): length-prefixed JSON frames on
 * bidirectional QUIC streams, one stream per request. A frame is a 4-byte big-endian length and that
 * many bytes of UTF-8 JSON. A reply frame that declares `bytes` is followed on the stream by exactly
 * that many raw bytes (a blob, the appended part of a transcript), written in 1 MiB pieces: the
 * binding takes `Array<number>` only, and a larger write costs more to convert than it gains (§7.2).
 *
 * Pure: no iroh, no disk. The host process frames streams with it, and `serve.ts` and the client
 * parse what arrives with it.
 */

export const ALPN = 'claudio/collab/1';
export const ALPN_BYTES: readonly number[] = Array.from(new TextEncoder().encode(ALPN));

/** How raw bytes are written: one binding call per piece (§3.2, §7.2) */
export const PIECE_BYTES = 1024 * 1024;
/** A request is a few fields; anything larger is not one of ours */
export const MAX_REQUEST_FRAME = 64 * 1024;
/** A reply frame (a batch of records, a roster, a catalog); raw bytes are not counted here */
export const MAX_REPLY_FRAME = 4 * 1024 * 1024;
/** What a batch of `pull` aims to stay under, so a frame is far from the limit */
export const BATCH_TARGET_BYTES = 512 * 1024;
export const BATCH_MAX_RECORDS = 200;
/** The most raw bytes one reply carries: an upload is at most 50 MB (`UPLOAD_LIMITS.file`) */
export const MAX_RAW_BYTES = 64 * 1024 * 1024;
/** The most of a transcript one `transcript` reply carries; the receiver asks again from the new offset */
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** Share keys a single `watch` may name */
export const MAX_WATCH_KEYS = 256;

const SHA256 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const GROUP_ID = SHA256;
/** A session id of the CLI is a UUID; anything else never names a transcript */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A subagent's transcript beside the session's, `subagents/[workflows/<runId>/]agent-<id>.jsonl` (sessions.ts) */
const AGENT_FILE = /^(?:workflows\/[A-Za-z0-9_-]{1,64}\/)?agent-[A-Za-z0-9_-]{1,64}\.jsonl$/;
/** Sealed join payloads are base64url of a small box (invite.ts) */
const SEALED = /^[A-Za-z0-9_-]{16,8192}$/;
/** An iroh endpoint ticket: a lower-case base32 string */
const TICKET = /^[A-Za-z0-9]{1,4096}$/;
export const isTicket = (value: unknown): value is string => typeof value === 'string' && TICKET.test(value);

// ---------- Requests ----------

export type WireRequest =
  /**
   * `ticket`: the sender's own, so a member can later dial it or hand it to an invitee as a relay.
   * `changed`: what the sender shares changed, so the receiver pulls its catalog again now
   */
  | { type: 'hello'; heads: Record<string, RosterHead>; ticket?: string; changed?: boolean }
  /**
   * `denial`: from a joiner that is no member yet, the `denialTag` of its invite, so an install that
   * holds a denial of it answers `denied` rather than `forbidden`. A peer from before it drops the
   * field and answers `forbidden`, which the joiner reads as still waiting
   */
  | { type: 'roster'; groupId: string; sinceVersion: number; denial?: string }
  | { type: 'join'; groupId: string; sealed: string }
  | { type: 'joinRelay'; groupId: string; sealed: string; from: string; receivedAt: string; expiresAt: string | null }
  /** Member → owner: the joins of the group the owner denied, so the member answers the joiner while the owner is away */
  | { type: 'joinAnswers'; groupId: string }
  | { type: 'leave'; groupId: string }
  | { type: 'catalog'; groupId: string }
  | { type: 'pull'; shareKey: string; kind: CollaboratorsKind; since: string | null }
  | { type: 'transcript'; shareKey: string; session: string; agent: string | null; offset: number }
  | { type: 'blob'; shareKey: string; sha256: string }
  | { type: 'watch'; shareKeys: string[] };

export type WireRequestType = WireRequest['type'];

// ---------- Replies ----------

/** A denied join as the owner hands it to a member: who, the tag the joiner asks with, when, and until when */
export interface WireDenial {
  from: string;
  tag: string;
  deniedAt: string;
  expiresAt: string;
}

/** One record of a `pull`: `version` changes whenever the record does, `cursor` orders the pull */
export interface WireRecord {
  id: string;
  version: string;
  data: unknown;
}

/** One project of a `catalog`; `versions` is what the receiver reconciles its copy against (§4.1) */
export interface CatalogEntry {
  shareKey: string;
  name: string;
  remote: string | null;
  subpath: string | null;
  kinds: CollaboratorsKind[];
  counts: Partial<Record<CollaboratorsKind, number>>;
  versions: Partial<Record<CollaboratorsKind, Record<string, string>>>;
}

/**
 * Why a request got no answer. `forbidden`: the asker is no member of a group this install holds
 * with it. `not-found`: no project shared with it under that key, a kind it does not share, a
 * transcript or a blob no shared record references, all alike, so a probe learns nothing.
 */
export type WireErrorCode = 'bad-request' | 'forbidden' | 'not-found' | 'refused' | 'unavailable' | 'internal';

export type WireReply =
  | { type: 'hello'; heads: Record<string, RosterHead>; ticket?: string }
  | { type: 'roster'; groupId: string; versions: RosterVersion[] }
  | { type: 'pending'; groupId: string; owner: string }
  /** The owner denied this joiner's request with this invite: to `join`, and to a joiner's `roster` */
  | { type: 'denied'; groupId: string }
  | { type: 'joinAnswers'; groupId: string; denied: WireDenial[] }
  | { type: 'ack' }
  | { type: 'catalog'; groupId: string; projects: CatalogEntry[] }
  | { type: 'records'; kind: CollaboratorsKind; records: WireRecord[] }
  | { type: 'cursor'; kind: CollaboratorsKind; cursor: string | null }
  /** `bytes` raw bytes follow: the file from `offset` to `next`; `size` is the file's size now */
  | { type: 'transcript'; session: string; agent: string | null; offset: number; next: number; size: number; bytes: number }
  | { type: 'blob'; sha256: string; bytes: number }
  | { type: 'changed'; shareKey: string; kind: CollaboratorsKind }
  | { type: 'error'; code: WireErrorCode; reason?: string };

/** How many raw bytes follow a reply frame on the stream; 0 for a frame that carries none */
export function rawLength(frame: { type?: unknown; bytes?: unknown }): number {
  if (frame.type !== 'blob' && frame.type !== 'transcript') return 0;
  const n = frame.bytes;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_RAW_BYTES ? n : -1;
}

// ---------- Frames ----------

export class WireError extends Error {
  constructor(
    readonly code: 'too-large' | 'malformed' | 'truncated',
    message: string,
  ) {
    super(message);
    this.name = 'WireError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A frame: the 4-byte length, then the JSON */
export function encodeFrame(value: unknown, max = MAX_REPLY_FRAME): Uint8Array {
  const json = encoder.encode(JSON.stringify(value));
  if (json.length > max) throw new WireError('too-large', `a frame of ${String(json.length)} bytes is over ${String(max)}`);
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  return out;
}

/** The body length a frame header announces, refused over `max` before anything is read */
export function frameLength(header: Uint8Array, max: number): number {
  if (header.length !== 4) throw new WireError('truncated', 'a frame header is 4 bytes');
  const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
  if (length > max) throw new WireError('too-large', `a frame of ${String(length)} bytes is over ${String(max)}`);
  return length;
}

export function decodeFrameBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(body)) as unknown;
  } catch {
    throw new WireError('malformed', 'a frame is not JSON');
  }
}

/** Splits raw bytes into the pieces the binding is written with */
export function* pieces(bytes: Uint8Array, size = PIECE_BYTES): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, Math.min(bytes.length, at + size));
}

/**
 * Takes bytes as they arrive, in any split, and hands out what they frame: a frame, then the raw
 * bytes a reply frame announces. The host's client side runs a stream's replies through it.
 */
export class FrameParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private rawLeft = 0;

  constructor(
    private readonly max: number,
    /** Whether a frame announces raw bytes; requests never do */
    private readonly raw: (frame: unknown) => number = () => 0,
  ) {}

  /** True while a frame or its raw bytes are cut in the middle */
  get partial(): boolean {
    return this.buffer.length > 0 || this.rawLeft > 0;
  }

  push(chunk: Uint8Array): Array<{ frame: unknown } | { bytes: Uint8Array }> {
    const out: Array<{ frame: unknown } | { bytes: Uint8Array }> = [];
    let data = chunk;
    if (this.buffer.length) {
      const joined = new Uint8Array(this.buffer.length + chunk.length);
      joined.set(this.buffer, 0);
      joined.set(chunk, this.buffer.length);
      data = joined;
      this.buffer = new Uint8Array(0);
    }
    let at = 0;
    while (at < data.length) {
      if (this.rawLeft > 0) {
        const take = Math.min(this.rawLeft, data.length - at);
        out.push({ bytes: data.slice(at, at + take) });
        this.rawLeft -= take;
        at += take;
        continue;
      }
      if (data.length - at < 4) break;
      const length = frameLength(data.subarray(at, at + 4), this.max);
      if (data.length - at - 4 < length) break;
      const frame = decodeFrameBody(data.subarray(at + 4, at + 4 + length));
      at += 4 + length;
      const raw = this.raw(frame);
      if (raw < 0) throw new WireError('malformed', 'a frame announces raw bytes it cannot carry');
      this.rawLeft = raw;
      out.push({ frame });
    }
    if (at < data.length) this.buffer = data.slice(at);
    return out;
  }
}

// ---------- Validation of what a peer sends ----------

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isKind = (value: unknown): value is CollaboratorsKind => typeof value === 'string' && (COLLABORATORS_KINDS as readonly string[]).includes(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is string => isString(value, 40) && !Number.isNaN(Date.parse(value));

/** A share key as `project-settings.ts` stores it: 3 to 200 printable characters */
export function isWireShareKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}

export const isGroupIdOnWire = (value: unknown): value is string => typeof value === 'string' && GROUP_ID.test(value);
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
export const isSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);
export const isAgentFile = (value: unknown): value is string => typeof value === 'string' && AGENT_FILE.test(value);
const isEndpointHex = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && HEX.test(value);

function parseHeads(value: unknown): Record<string, RosterHead> | null {
  if (!isObject(value)) return null;
  const heads: Record<string, RosterHead> = Object.create(null) as Record<string, RosterHead>;
  const entries = Object.entries(value);
  if (entries.length > 256) return null;
  for (const [groupId, head] of entries) {
    if (!isGroupIdOnWire(groupId) || !isObject(head)) return null;
    if (!isCount(head.version) || head.version < 1 || !isSha256(head.hash)) return null;
    heads[groupId] = { version: head.version, hash: head.hash };
  }
  return heads;
}

/**
 * A request frame as a peer sent it, or null when it is not one: unknown type, a missing or
 * ill-shaped field, an id that could walk a path. Nothing past this point trusts a peer's strings.
 */
export function parseRequest(value: unknown): WireRequest | null {
  if (!isObject(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'hello': {
      const heads = parseHeads(value.heads);
      if (!heads) return null;
      return { type: 'hello', heads, ...(isTicket(value.ticket) ? { ticket: value.ticket } : {}), ...(value.changed === true ? { changed: true } : {}) };
    }
    case 'roster':
      if (!isGroupIdOnWire(value.groupId) || !isCount(value.sinceVersion)) return null;
      if (value.denial !== undefined && !isSha256(value.denial)) return null;
      return { type: 'roster', groupId: value.groupId, sinceVersion: value.sinceVersion, ...(value.denial !== undefined ? { denial: value.denial } : {}) };
    case 'joinAnswers':
      return isGroupIdOnWire(value.groupId) ? { type: 'joinAnswers', groupId: value.groupId } : null;
    case 'join':
      return isGroupIdOnWire(value.groupId) && typeof value.sealed === 'string' && SEALED.test(value.sealed) ? { type: 'join', groupId: value.groupId, sealed: value.sealed } : null;
    case 'joinRelay':
      if (!isGroupIdOnWire(value.groupId) || typeof value.sealed !== 'string' || !SEALED.test(value.sealed) || !isEndpointHex(value.from) || !isTime(value.receivedAt)) return null;
      if (value.expiresAt !== null && !isTime(value.expiresAt)) return null;
      return { type: 'joinRelay', groupId: value.groupId, sealed: value.sealed, from: value.from, receivedAt: value.receivedAt, expiresAt: value.expiresAt };
    case 'leave':
      return isGroupIdOnWire(value.groupId) ? { type: 'leave', groupId: value.groupId } : null;
    case 'catalog':
      return isGroupIdOnWire(value.groupId) ? { type: 'catalog', groupId: value.groupId } : null;
    case 'pull':
      if (!isWireShareKey(value.shareKey) || !isKind(value.kind)) return null;
      if (value.since !== null && !isString(value.since, 400)) return null;
      return { type: 'pull', shareKey: value.shareKey, kind: value.kind, since: value.since };
    case 'transcript':
      if (!isWireShareKey(value.shareKey) || !isSessionId(value.session) || !isCount(value.offset)) return null;
      if (value.agent !== null && value.agent !== undefined && !isAgentFile(value.agent)) return null;
      return { type: 'transcript', shareKey: value.shareKey, session: value.session, agent: typeof value.agent === 'string' ? value.agent : null, offset: value.offset };
    case 'blob':
      return isWireShareKey(value.shareKey) && isSha256(value.sha256) ? { type: 'blob', shareKey: value.shareKey, sha256: value.sha256 } : null;
    case 'watch':
      if (!Array.isArray(value.shareKeys) || value.shareKeys.length === 0 || value.shareKeys.length > MAX_WATCH_KEYS) return null;
      if (!value.shareKeys.every(isWireShareKey)) return null;
      return { type: 'watch', shareKeys: [...new Set(value.shareKeys)] };
    default:
      return null;
  }
}

/** The denials of a `joinAnswers` reply that are well formed; anything else in it is dropped */
export function parseDenials(value: unknown): WireDenial[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((d: unknown): WireDenial[] =>
    isObject(d) && isEndpointHex(d.from) && isSha256(d.tag) && isTime(d.deniedAt) && isTime(d.expiresAt) ? [{ from: d.from, tag: d.tag, deniedAt: d.deniedAt, expiresAt: d.expiresAt }] : [],
  );
}
