import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollaboratorsKind, CollaboratorsPath, Localized, SyncState } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { CollabShareRef, CollabStore } from '../db.ts';
import type { GroupsStore } from './groups-store.ts';
import type { HostReplyPart } from './host-client.ts';
import type { HostTarget } from './host/protocol.ts';
import { denialTag, secretHash, type Invite } from './invite.ts';
import { shortEndpoint } from './names.ts';
import { compareHeads, headOf, isEndpointId, verifyJoinerChain, type RosterHead, type RosterVersion } from './roster.ts';
import { isAgentFile, isSessionId, isTicket, parseDenials, rawLength, type CatalogEntry, type WireErrorCode, type WireReply } from './wire.ts';

/*
 * The receiving side of `claudio/collab/1` (docs/plans/collaborators.md §3.3, §4.1, §4.2): what this
 * install asks of each teammate's install and what it keeps of the answers. Per peer, a sync is
 * `hello` (and the roster suffix when this side is behind), the catalog of every group both hold,
 * the reconcile that drops what the owner no longer lists, a `pull` per kind from its cursor, the
 * transcripts of the chats that changed from their byte offsets, and a `watch` that pulls again on
 * every `changed` notice. It runs on connect, when a peer says something changed, and every 10 min.
 * Joins are sent from here too: to the owner, else to a member that holds the request for it.
 *
 * Nothing here answers a peer: that is `serve.ts`. Nothing here decides who is a member either: the
 * service hands over the verified chains and is handed back the roster versions a peer sent.
 */

/** What carries requests to peers: `CollabHost` */
export interface Transport {
  request(to: HostTarget, frame: unknown): AsyncIterableIterator<HostReplyPart>;
}

/** A request that got no usable answer: the peer's own refusal, or no peer to ask */
export class PeerError extends Error {
  constructor(
    readonly code: WireErrorCode | 'unreachable' | 'protocol',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PeerError';
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Reply {
  reply: WireReply;
  /** The raw bytes a `blob` or `transcript` frame announced, whole; null for any other frame */
  raw: Uint8Array | null;
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** How long a request may go without a word from the peer before it is given up */
const IDLE_MS = 30 * 1000;

export interface AskOptions {
  /** How long the peer may stay silent between two parts of its answer */
  idleMs?: number;
  /** The peer stopped answering on a stream it had taken: its connection is not to be trusted */
  stalled?(endpointId: string): void;
}

/** A request's replies, each with the raw bytes it announced; an `error` frame is thrown as a PeerError */
export async function* replies(transport: Transport, to: HostTarget, frame: unknown, opts: AskOptions = {}): AsyncGenerator<Reply> {
  let open: { reply: WireReply; need: number; parts: Uint8Array[]; got: number } | null = null;
  let finished = false;
  const stream = transport.request(to, frame);
  try {
    for (;;) {
      let timer: NodeJS.Timeout | null = null;
      const idle = new Promise<'idle'>((resolve) => (timer = setTimeout(() => resolve('idle'), opts.idleMs ?? IDLE_MS)));
      let next: IteratorResult<HostReplyPart> | 'idle';
      try {
        next = await Promise.race([stream.next(), idle]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (next === 'idle') {
        opts.stalled?.(to.endpointId);
        throw new PeerError('unreachable', 'the peer stopped answering');
      }
      if (next.done) {
        finished = true;
        break;
      }
      const part = next.value;
      if ('frame' in part) {
        if (open) throw new PeerError('protocol', 'a frame arrived inside raw bytes');
        const reply = part.frame as WireReply | null;
        if (!reply || typeof reply !== 'object' || typeof reply.type !== 'string') throw new PeerError('protocol', 'a reply is not a frame');
        if (reply.type === 'error') throw new PeerError(reply.code, reply.reason);
        const need = rawLength(reply);
        if (need < 0) throw new PeerError('protocol', 'a frame announces raw bytes it cannot carry');
        if (reply.type !== 'blob' && reply.type !== 'transcript') yield { reply, raw: null };
        else if (need === 0) yield { reply, raw: new Uint8Array(0) };
        else open = { reply, need, parts: [], got: 0 };
      } else {
        if (!open) throw new PeerError('protocol', 'raw bytes arrived without a frame');
        open.parts.push(part.bytes);
        open.got += part.bytes.length;
        if (open.got > open.need) throw new PeerError('protocol', 'more raw bytes than announced');
        if (open.got === open.need) {
          const done: Reply = { reply: open.reply, raw: concat(open.parts, open.got) };
          open = null;
          yield done;
        }
      }
    }
  } catch (error) {
    if (error instanceof PeerError) throw error;
    // The host could not dial, the stream or the host went away
    throw new PeerError('unreachable', describe(error));
  } finally {
    // Left early, by the caller or by an error: the stream is cancelled
    if (!finished) void stream.return?.();
  }
  if (open) throw new PeerError('protocol', 'the reply was cut short');
}

/** The first reply of a request; the stream is let go after it */
export async function first(transport: Transport, to: HostTarget, frame: unknown, opts: AskOptions = {}): Promise<Reply> {
  for await (const reply of replies(transport, to, frame, opts)) return reply;
  throw new PeerError('protocol', 'the peer answered nothing');
}

// ---------- Relays in an invite ----------

/**
 * An invite's `relays` entry for a member: `<endpointId>:<ticket>` when its ticket is known, which a
 * test or the e2e harness on the minimal preset needs; the bare id otherwise, which n0's discovery
 * dials by key.
 */
export function relayEntry(endpointId: string, ticket: string | null): string {
  return ticket ? `${endpointId}:${ticket}` : endpointId;
}

export function relayTarget(entry: string): HostTarget | null {
  const [id, ticket] = entry.split(':', 2);
  if (!isEndpointId(id)) return null;
  return { endpointId: id, ticket: ticket && isTicket(ticket) ? ticket : null };
}

export type JoinOutcome = { state: 'joined'; chain: RosterVersion[] } | { state: 'pending'; relayedBy: string } | { state: 'denied'; by: string };

/** What a joiner learns when it asks after its request: in, or denied; null while nobody knows yet */
export type JoinAnswerOutcome = { state: 'joined'; chain: RosterVersion[] } | { state: 'denied'; by: string } | null;

/** What a joiner asks with to learn it was denied: never the secret, nor the hash the owner spends it by */
export const inviteDenialTag = (invite: Invite): string => denialTag(secretHash(invite.secret));

// ---------- The catalog kept between runs ----------

/** What a peer's last catalog said, so the Collaborators page lists its shares while it is offline */
export interface KnownShare {
  shareKey: string;
  name: string;
  remote: string | null;
  subpath: string | null;
  kinds: CollaboratorsKind[];
  counts: Partial<Record<CollaboratorsKind, number>>;
  /** The groups this install sees it through, sorted; the first holds its cursors */
  groupIds: string[];
}

interface CatalogDoc {
  [owner: string]: { at: string; shares: KnownShare[] };
}

/**
 * `<dataDir>/collaborators/catalog.json`: per peer, the shares its last catalog listed. A document,
 * rewritten whole when a catalog is read: it is small and replaced, not accumulated.
 */
class CatalogCache {
  private doc: CatalogDoc;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    this.doc = Object.create(null) as CatalogDoc;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [owner, entry] of Object.entries(raw as Record<string, unknown>)) {
          const e = entry as { at?: unknown; shares?: unknown };
          if (isEndpointId(owner) && typeof e?.at === 'string' && Array.isArray(e.shares)) this.doc[owner] = { at: e.at, shares: e.shares as KnownShare[] };
        }
      }
    } catch {
      // A cache: what does not parse is read again from the peers
    }
  }

  owners(): string[] {
    return Object.keys(this.doc);
  }

  of(owner: string): KnownShare[] {
    return this.doc[owner]?.shares ?? [];
  }

  at(owner: string): string | null {
    return this.doc[owner]?.at ?? null;
  }

  set(owner: string, shares: KnownShare[] | null): Promise<void> {
    if (shares) this.doc[owner] = { at: new Date().toISOString(), shares };
    else delete this.doc[owner];
    const text = `${JSON.stringify(this.doc, null, 2)}\n`;
    const run = this.lock.then(() => writeAtomic(this.file, text));
    this.lock = run.catch(() => undefined);
    return run;
  }
}

// ---------- The client ----------

export interface SyncDeps {
  transport: Transport;
  store: CollabStore;
  groups: GroupsStore;
  /** `<dataDir>/collaborators`: the blobs and the catalog cache live under it */
  dir: string;
  /** This install's own ticket while its endpoint is bound, sent in every `hello` */
  ticket(): string | null;
  /** Where to dial a peer: its ticket when one is known, else its id alone */
  target(endpointId: string): HostTarget;
  /** A peer told its ticket */
  sawTicket(endpointId: string, ticket: string): void;
  /**
   * Whether dialling a peer can work: without discovery (the minimal preset) a peer with no known
   * ticket and no open connection cannot be found, and a dial would only wait for its timeout
   */
  reachable?(endpointId: string): boolean;
  /** A peer took a request and went silent: its connections are closed, so the next request dials anew */
  stalled?(endpointId: string): void;
  /** How long a peer may stay silent in the middle of an answer */
  idleMs?: number;
  /** The verified chains of the groups whose head lists both this install and `peer` */
  groupsWith(peer: string): Array<{ groupId: string; chain: readonly RosterVersion[] }>;
  /** Versions a peer sent past the head held: the service verifies them, stores them and acts on them */
  applyRoster(groupId: string, versions: readonly RosterVersion[], from: string): Promise<void>;
  /** A peer holds another version under a number this install holds: the owner signed twice */
  conflict(groupId: string, version: number, hashes: string[]): void;
  /** A kind of a copy was pulled, or the copy went */
  synced(owner: string, shareKey: string, kind: CollaboratorsKind): void;
  /** The shares a peer lists changed: one appeared or went */
  sharesChanged(owner: string): void;
  log(message: string): void;
  /** A peer in a log line, by its roster name; the start of its endpoint id when absent */
  who?(endpointId: string): string;
  /** How often a connected peer's catalog is read again to find removed records (§4.1) */
  reconcileMs?: number;
  /** The first wait before an unreachable peer is tried again; it doubles up to `reconcileMs` */
  retryMs?: number;
  /** The longest wait before a peer that refused this install is asked again; the wait doubles from `reconcileMs` */
  refusedMaxMs?: number;
  /** How long `changed` notices are gathered before they are pulled */
  debounceMs?: number;
}

interface ShareState {
  owner: string;
  share: KnownShare;
  lastSyncedAt: string | null;
  error: Localized | null;
}

interface PeerState {
  id: string;
  run: Promise<void> | null;
  again: boolean;
  timer: NodeJS.Timeout | null;
  /** The open `watch` stream and the keys it names */
  watch: AbortController | null;
  watchKeys: string;
  /** The last run reached the peer */
  online: boolean;
  failures: number;
  /**
   * The peer answered `forbidden`: it no longer lists this install (the share was revoked or this
   * install was removed). Its copies say so, and it is asked again ever more rarely until a hello
   * from it or a roster change says it may list this install again.
   */
  refused: boolean;
  /** How many runs in a row it refused; the wait before the next one doubles with it */
  refusals: number;
  /** The failure last logged for this peer: the same one again is not logged, a change is */
  lastFailure: string | null;
  /** Network work on this peer, one at a time: a run and the pulls `changed` notices ask for */
  lock: Promise<unknown>;
  notices: Set<string>;
  noticeTimer: NodeJS.Timeout | null;
}

const RECONCILE_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const REFUSED_MAX_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 150;
/** A transcript is read in pieces of at most 4 MiB (`MAX_TRANSCRIPT_BYTES`); this caps one catch-up */
const TRANSCRIPT_ROUNDS = 256;
const MAX_RECORD_ID = 400;
const MAX_VERSION = 200;

const shareRef = (owner: string, shareKey: string): CollabShareRef => ({ ownerId: owner, shareKey });
const stateKey = (owner: string, shareKey: string): string => `${owner}\u0000${shareKey}`;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The transcript cursor beside a session's byte offset: the line seq that offset starts at */
const seqKey = (session: string): string => `${session}#seq`;
/** Where an agent's copied transcript is held, beside its chat's: in the store and in the cursors */
export const agentKey = (chatId: string, agentFile: string): string => `${chatId}/${agentFile}`;
/** The agent file of a subagent or workflow agent, as the wire names it (`wire.ts`) */
export const agentFile = (agentId: string, workflowRunId: string | null): string => (workflowRunId ? `workflows/${workflowRunId}/agent-${agentId}.jsonl` : `agent-${agentId}.jsonl`);
/** More agents than a chat record lists (`readers.ts`) */
const MAX_AGENTS = 500;

/** The agents a peer's chat record lists, as files the wire accepts; anything else of it is ignored */
function agentFiles(data: unknown): Array<{ file: string; size: number }> {
  const list = (data as { subagents?: unknown } | null)?.subagents;
  if (!Array.isArray(list)) return [];
  const out: Array<{ file: string; size: number }> = [];
  for (const item of list.slice(-MAX_AGENTS)) {
    if (!item || typeof item !== 'object') continue;
    const { agentId, workflowRunId, size } = item as { agentId?: unknown; workflowRunId?: unknown; size?: unknown };
    if (typeof agentId !== 'string' || (workflowRunId !== null && typeof workflowRunId !== 'string')) continue;
    const file = agentFile(agentId, workflowRunId);
    if (!isAgentFile(file)) continue;
    out.push({ file, size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : -1 });
  }
  return out;
}

const ERRORS: Record<string, Localized> = {
  forbidden: { code: 'collaborators.sync.forbidden', text: 'The owner no longer shares this project with this install: it stopped sharing it or removed this install from the group' },
  failed: { code: 'collaborators.sync.failed', text: 'The last pull failed' },
};

export class SyncClient {
  private readonly peers = new Map<string, PeerState>();
  private readonly shares = new Map<string, ShareState>();
  private readonly catalog: CatalogCache;
  private stopped = false;

  constructor(private readonly deps: SyncDeps) {
    this.catalog = new CatalogCache(join(deps.dir, 'catalog.json'));
    for (const owner of this.catalog.owners()) {
      for (const share of this.catalog.of(owner)) this.shares.set(stateKey(owner, share.shareKey), { owner, share, lastSyncedAt: null, error: null });
    }
  }

  private who(id: string): string {
    return this.deps.who?.(id) ?? shortEndpoint(id);
  }

  private get askOptions(): AskOptions {
    return { ...(this.deps.idleMs !== undefined ? { idleMs: this.deps.idleMs } : {}), stalled: (id) => this.deps.stalled?.(id) };
  }

  private ask(to: HostTarget, frame: unknown): Promise<Reply> {
    return first(this.deps.transport, to, frame, this.askOptions);
  }

  private to(id: string): HostTarget {
    if (this.deps.reachable && !this.deps.reachable(id)) throw new PeerError('unreachable', 'no address is known for the peer');
    return this.deps.target(id);
  }

  private get blobsDir(): string {
    return join(this.deps.dir, 'blobs');
  }

  // ---------- Peers ----------

  /** The peers to keep in sync with: every other member of a group this install holds */
  setPeers(ids: Iterable<string>): void {
    this.stopped = false;
    const wanted = new Set(ids);
    for (const [id, peer] of this.peers) {
      if (wanted.has(id)) continue;
      this.release(peer);
      this.peers.delete(id);
    }
    for (const id of wanted) {
      if (this.peers.has(id)) continue;
      const peer: PeerState = { id, run: null, again: false, timer: null, watch: null, watchKeys: '', online: false, failures: 0, refused: false, refusals: 0, lastFailure: null, lock: Promise.resolve(), notices: new Set(), noticeTimer: null };
      this.peers.set(id, peer);
      this.start(peer);
    }
  }

  /** Syncs with a peer now: it connected, said what it shares changed, or holds a newer roster */
  poke(id: string): void {
    const peer = this.peers.get(id);
    if (peer) this.start(peer);
  }

  /** Every peer again: the endpoint came (back) up */
  pokeAll(): void {
    for (const peer of this.peers.values()) this.start(peer);
  }

  isOnline(id: string): boolean {
    return this.peers.get(id)?.online ?? false;
  }

  /** The peer's last answer was `forbidden`: it does not list this install */
  isRefused(id: string): boolean {
    return this.peers.get(id)?.refused ?? false;
  }

  /** Lets every peer go: Collaborators was turned off */
  stop(): void {
    this.stopped = true;
    for (const peer of this.peers.values()) this.release(peer);
    this.peers.clear();
  }

  private release(peer: PeerState): void {
    if (peer.timer) clearTimeout(peer.timer);
    if (peer.noticeTimer) clearTimeout(peer.noticeTimer);
    peer.timer = null;
    peer.noticeTimer = null;
    peer.watch?.abort();
    peer.watch = null;
    peer.watchKeys = '';
    peer.online = false;
  }

  private exclusive<T>(peer: PeerState, fn: () => Promise<T>): Promise<T> {
    const run = peer.lock.then(fn, fn);
    peer.lock = run.catch(() => undefined);
    return run;
  }

  private start(peer: PeerState): void {
    if (this.stopped) return;
    if (peer.run) {
      peer.again = true;
      return;
    }
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
    peer.run = (async () => {
      let ok = false;
      do {
        peer.again = false;
        if (this.peers.get(peer.id) !== peer) return;
        try {
          await this.exclusive(peer, () => this.runOnce(peer));
          ok = true;
          this.recovered(peer);
        } catch (error) {
          ok = false;
          this.failed(peer, error);
        }
      } while (peer.again && !this.stopped);
      this.schedule(peer, ok);
    })().finally(() => {
      peer.run = null;
    });
  }

  private schedule(peer: PeerState, ok: boolean): void {
    if (this.stopped || this.peers.get(peer.id) !== peer) return;
    const reconcile = this.deps.reconcileMs ?? RECONCILE_MS;
    const delay = ok
      ? reconcile
      : peer.refused
        ? Math.max(reconcile, Math.min(this.deps.refusedMaxMs ?? REFUSED_MAX_MS, reconcile * 2 ** Math.min(peer.refusals - 1, 20)))
        : Math.min(reconcile, (this.deps.retryMs ?? RETRY_MS) * 2 ** Math.min(peer.failures - 1, 10));
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = setTimeout(() => {
      peer.timer = null;
      this.start(peer);
    }, delay);
    peer.timer.unref?.();
  }

  private failed(peer: PeerState, error: unknown): void {
    peer.failures += 1;
    const unreachable = !(error instanceof PeerError) || error.code === 'unreachable';
    if (unreachable) {
      const was = peer.online;
      peer.online = false;
      peer.watch?.abort();
      peer.watch = null;
      peer.watchKeys = '';
      if (was) for (const share of this.sharesOf(peer.id)) this.deps.synced(peer.id, share.share.shareKey, share.share.kinds[0] ?? 'chats');
    } else {
      // Reached, and refused or misunderstood: shown on its copies, and tried again at the reconcile's pace or slower
      peer.online = true;
      peer.failures = 64;
      if (error.code === 'forbidden') {
        this.refuse(peer);
        return;
      }
      for (const share of this.sharesOf(peer.id)) share.error = ERRORS.failed ?? null;
    }
    this.note(peer, error, `collab: sync with ${this.who(peer.id)} failed: ${describe(error)}`);
  }

  /** The peer does not list this install: said once on its copies and in the log, not on every retry */
  private refuse(peer: PeerState): void {
    peer.refusals += 1;
    for (const share of this.sharesOf(peer.id)) share.error = ERRORS.forbidden ?? null;
    if (peer.refused) return;
    peer.refused = true;
    peer.lastFailure = 'forbidden';
    this.deps.log(`collab: ${this.who(peer.id)} no longer lists this install; its copies stop syncing until it does`);
  }

  /** A failure is logged when its reason differs from the last one logged for the peer */
  private note(peer: PeerState, error: unknown, message: string): void {
    const reason = describe(error);
    if (peer.lastFailure === reason) return;
    peer.lastFailure = reason;
    this.deps.log(message);
  }

  /** A run went through: what failed before is said to be over, once */
  private recovered(peer: PeerState): void {
    if (peer.lastFailure !== null) this.deps.log(`collab: sync with ${this.who(peer.id)} works again`);
    peer.failures = 0;
    peer.refused = false;
    peer.refusals = 0;
    peer.lastFailure = null;
  }

  // ---------- One run ----------

  private async runOnce(peer: PeerState): Promise<void> {
    const to = this.to(peer.id);
    const groups = this.deps.groupsWith(peer.id);
    if (!groups.length) return;
    await this.hello(peer.id, false);
    peer.online = true;
    await this.forwardJoins(peer.id);
    await this.learnDenials(peer.id);
    await this.readCatalog(peer, this.deps.groupsWith(peer.id));
    for (const state of this.sharesOf(peer.id)) {
      for (const kind of state.share.kinds) await this.pullKind(peer.id, state, kind, to);
    }
    this.follow(peer);
  }

  /**
   * `hello` to a peer, with this install's heads of the groups both hold, and the suffix pulled for
   * each one this side is behind on. `changed` tells the peer to read this install's catalog again.
   */
  async hello(id: string, changed: boolean): Promise<void> {
    const to = this.to(id);
    const groups = this.deps.groupsWith(id);
    const heads: Record<string, RosterHead> = Object.create(null) as Record<string, RosterHead>;
    for (const group of groups) heads[group.groupId] = headOf(group.chain);
    const ticket = this.deps.ticket();
    const { reply } = await this.ask(to, { type: 'hello', heads, ...(ticket ? { ticket } : {}), ...(changed ? { changed: true } : {}) });
    if (reply.type !== 'hello') throw new PeerError('protocol', `hello was answered with ${reply.type}`);
    if (reply.ticket && isTicket(reply.ticket)) this.deps.sawTicket(id, reply.ticket);
    for (const group of groups) {
      const theirs = reply.heads?.[group.groupId];
      if (!theirs) continue;
      const mine = headOf(group.chain);
      const comparison = compareHeads(mine, theirs);
      if (comparison === 'behind') await this.pullRoster(id, group.groupId, mine.version);
      else if (comparison === 'equivocation') this.deps.conflict(group.groupId, mine.version, [mine.hash, theirs.hash].sort());
    }
  }

  /**
   * Tells a peer, without syncing with it, that this side changed: a new roster version, a share.
   * A connection that was lost is dialled again once; a peer still unreachable is synced with
   * later, and that run's `hello` tells it the same.
   */
  async announce(id: string, changed: boolean): Promise<void> {
    const peer = this.peers.get(id);
    const tell = (): Promise<void> => (peer ? this.exclusive(peer, () => this.hello(id, changed)) : this.hello(id, changed));
    try {
      await tell().catch((error: unknown) => {
        if (error instanceof PeerError && error.code === 'unreachable') return tell();
        throw error;
      });
    } catch (error) {
      if (!peer) this.deps.log(`collab: telling ${this.who(id)} failed: ${describe(error)}`);
      else if (error instanceof PeerError && error.code === 'forbidden') this.refuse(peer);
      else this.note(peer, error, `collab: telling ${this.who(id)} failed: ${describe(error)}`);
      if (peer && error instanceof PeerError && error.code === 'unreachable') this.start(peer);
    }
  }

  private async pullRoster(id: string, groupId: string, sinceVersion: number): Promise<void> {
    const { reply } = await this.ask(this.to(id), { type: 'roster', groupId, sinceVersion });
    if (reply.type !== 'roster' || reply.groupId !== groupId || !Array.isArray(reply.versions)) throw new PeerError('protocol', 'roster was answered with something else');
    if (reply.versions.length) await this.deps.applyRoster(groupId, reply.versions, id);
  }

  /** Hands the owner the joins this install holds for it (§3.3, relayed joins) */
  private async forwardJoins(id: string): Promise<void> {
    const groups = new Map(this.deps.groupsWith(id).map((g) => [g.groupId, g.chain.at(-1)]));
    for (const request of this.deps.store.joinRequests({ pending: true })) {
      // A request this install received as the owner is answered here, never sent on
      if (request.relayedBy !== null) continue;
      const head = groups.get(request.groupId);
      if (head?.owner !== id) continue;
      try {
        const { reply } = await this.ask(this.to(id), {
          type: 'joinRelay',
          groupId: request.groupId,
          sealed: request.sealed,
          from: request.fromEndpointId,
          receivedAt: request.receivedAt,
          expiresAt: request.expiresAt,
        });
        if (reply.type === 'ack') this.deps.store.markJoinForwarded(request.groupId, request.fromEndpointId, new Date().toISOString());
      } catch (error) {
        if (error instanceof PeerError && error.code !== 'unreachable') this.deps.store.deleteJoinRequest(request.groupId, request.fromEndpointId);
        else throw error;
      }
    }
    this.deps.store.pruneJoinRequests(new Date().toISOString());
    this.deps.store.pruneJoinDenials(new Date().toISOString());
  }

  /**
   * Asks the owner which joins of the groups it owns it denied, and keeps them, so a joiner asking
   * this install while the owner is away learns its answer (§3.3, relayed joins). A request still
   * held from before the denial goes: there is nothing left to deliver. An owner from before
   * `joinAnswers` refuses the frame, and nothing is learnt.
   */
  private async learnDenials(id: string): Promise<void> {
    for (const group of this.deps.groupsWith(id)) {
      if (group.chain.at(-1)?.owner !== id) continue;
      let reply: WireReply;
      try {
        reply = (await this.ask(this.to(id), { type: 'joinAnswers', groupId: group.groupId })).reply;
      } catch (error) {
        if (error instanceof PeerError && error.code === 'unreachable') throw error;
        continue;
      }
      if (reply.type !== 'joinAnswers' || reply.groupId !== group.groupId) continue;
      for (const denial of parseDenials(reply.denied)) {
        this.deps.store.putJoinDenial({ groupId: group.groupId, endpointId: denial.from, tag: denial.tag, secretHash: null, deniedAt: denial.deniedAt, expiresAt: denial.expiresAt });
        const held = this.deps.store.joinRequest(group.groupId, denial.from);
        if (held && held.receivedAt <= denial.deniedAt) this.deps.store.deleteJoinRequest(group.groupId, denial.from);
      }
    }
  }

  /**
   * The catalog of every group both hold, merged by share key, and the reconcile of §4.1: a share the
   * peer no longer lists is deleted, and so is every record it no longer lists. Nothing is deleted
   * unless every catalog was read, so a peer that stopped listing this install leaves the copies be.
   */
  private async readCatalog(peer: PeerState, groups: Array<{ groupId: string }>): Promise<void> {
    const found = new Map<string, { entry: CatalogEntry; groupIds: string[] }>();
    let complete = true;
    for (const group of groups) {
      let reply: WireReply;
      try {
        reply = (await this.ask(this.to(peer.id), { type: 'catalog', groupId: group.groupId })).reply;
      } catch (error) {
        if (error instanceof PeerError && (error.code === 'forbidden' || error.code === 'not-found')) {
          complete = false;
          continue;
        }
        throw error;
      }
      if (reply.type !== 'catalog' || !Array.isArray(reply.projects)) throw new PeerError('protocol', 'catalog was answered with something else');
      for (const entry of reply.projects) {
        if (!entry || typeof entry.shareKey !== 'string' || !Array.isArray(entry.kinds)) continue;
        const held = found.get(entry.shareKey);
        if (held) held.groupIds.push(group.groupId);
        else found.set(entry.shareKey, { entry, groupIds: [group.groupId] });
      }
    }
    if (!complete && found.size === 0) throw new PeerError('forbidden');

    let reshaped = false;
    const { store } = this.deps;
    if (complete) {
      for (const ref of store.shares()) {
        if (ref.ownerId !== peer.id || found.has(ref.shareKey)) continue;
        await this.dropShare(peer.id, ref.shareKey);
        reshaped = true;
      }
      for (const state of this.sharesOf(peer.id)) {
        if (found.has(state.share.shareKey)) continue;
        this.shares.delete(stateKey(peer.id, state.share.shareKey));
        reshaped = true;
      }
    }

    const known: KnownShare[] = [];
    for (const [shareKey, { entry, groupIds }] of found) {
      const share: KnownShare = {
        shareKey,
        name: typeof entry.name === 'string' ? entry.name : shareKey,
        remote: typeof entry.remote === 'string' ? entry.remote : null,
        subpath: typeof entry.subpath === 'string' ? entry.subpath : null,
        kinds: entry.kinds.filter((k): k is CollaboratorsKind => typeof k === 'string'),
        counts: entry.counts && typeof entry.counts === 'object' ? entry.counts : {},
        groupIds: [...groupIds].sort(),
      };
      known.push(share);
      const key = stateKey(peer.id, shareKey);
      const state = this.shares.get(key);
      if (state) state.share = share;
      else {
        this.shares.set(key, { owner: peer.id, share, lastSyncedAt: null, error: null });
        reshaped = true;
      }
      // Records the owner no longer lists, and kinds it no longer shares
      const ref = shareRef(peer.id, shareKey);
      for (const [kind, n] of Object.entries(store.recordCounts(ref)) as Array<[CollaboratorsKind, number]>) {
        if (!n) continue;
        const listed = share.kinds.includes(kind) ? entry.versions?.[kind] : {};
        if (!listed) continue;
        const gone = [...store.recordVersions(ref, kind).keys()].filter((id) => !Object.hasOwn(listed, id));
        if (!gone.length) continue;
        store.deleteRecords(ref, kind, gone);
        if (kind === 'chats') for (const id of gone) store.deleteChatTranscripts(ref, id);
        this.deps.synced(peer.id, shareKey, kind);
      }
    }
    await this.catalog.set(peer.id, known);
    if (reshaped) this.deps.sharesChanged(peer.id);
  }

  /** Deletes a whole copy and where it stood: the owner stopped sharing it, or left this install's groups */
  async dropShare(owner: string, shareKey: string): Promise<void> {
    this.deps.store.dropShare(shareRef(owner, shareKey));
    for (const groupId of this.deps.groups.ids()) {
      if (this.deps.groups.read(groupId)?.cursors[owner]?.[shareKey]) await this.deps.groups.dropCursors(groupId, owner, shareKey);
    }
    this.shares.delete(stateKey(owner, shareKey));
  }

  /** Deletes every copy of a peer: it is no longer in any group with this install */
  async dropOwner(owner: string): Promise<void> {
    const keys = new Set([...this.deps.store.shares().filter((s) => s.ownerId === owner).map((s) => s.shareKey), ...this.sharesOf(owner).map((s) => s.share.shareKey)]);
    for (const key of keys) await this.dropShare(owner, key);
    await this.catalog.set(owner, null);
    if (keys.size) this.deps.sharesChanged(owner);
  }

  // ---------- Pulls ----------

  private cursorGroup(state: ShareState): string | null {
    return state.share.groupIds[0] ?? null;
  }

  private async pullKind(owner: string, state: ShareState, kind: CollaboratorsKind, to = this.to(owner)): Promise<void> {
    const groupId = this.cursorGroup(state);
    if (!groupId) return;
    const { store, groups } = this.deps;
    const { shareKey } = state.share;
    const ref = shareRef(owner, shareKey);
    const since = groups.cursors(groupId, owner, shareKey).kinds[kind] ?? null;
    const before = kind === 'chats' ? store.recordVersions(ref, 'chats') : null;
    const transcripts: Array<{ chatId: string; data: unknown }> = [];
    let cursor: string | null = null;
    let ended = false;
    try {
      for await (const { reply } of replies(this.deps.transport, to, { type: 'pull', shareKey, kind, since }, this.askOptions)) {
        if (reply.type === 'records' && reply.kind === kind && Array.isArray(reply.records)) {
          const now = new Date().toISOString();
          const rows = reply.records
            .filter((r) => typeof r?.id === 'string' && r.id.length <= MAX_RECORD_ID && typeof r.version === 'string' && r.version.length <= MAX_VERSION)
            .map((r) => ({ recordId: r.id, version: r.version, json: JSON.stringify(r.data ?? null) }));
          store.upsertRecords(ref, kind, rows, now);
          if (before) {
            for (const r of reply.records) {
              const live = !!(r.data as { live?: unknown } | null)?.live;
              if (before.get(r.id) !== r.version || live) transcripts.push({ chatId: r.id, data: r.data });
            }
          }
        } else if (reply.type === 'cursor') {
          cursor = typeof reply.cursor === 'string' ? reply.cursor : null;
          ended = true;
        }
      }
    } catch (error) {
      // A kind the owner stopped sharing since the catalog: the next reconcile drops it
      if (error instanceof PeerError && error.code === 'not-found') return;
      throw error;
    }
    if (!ended) throw new PeerError('protocol', 'a pull ended without its cursor');
    if (cursor !== null && cursor !== since) await groups.setKindCursor(groupId, owner, shareKey, kind, cursor);
    for (const { chatId, data } of transcripts) {
      await this.pullTranscript(owner, state, chatId, null, to);
      for (const agent of agentFiles(data)) {
        const held = groupId ? groups.cursors(groupId, owner, shareKey).transcripts[agentKey(chatId, agent.file)] : undefined;
        // Only an agent whose transcript is not the size already copied: a chat delegates to many
        if (held !== undefined && held === agent.size) continue;
        await this.pullTranscript(owner, state, chatId, agent.file, to);
      }
    }
    // A chat's uploads come with it: what a changed chat attached is listed under artifacts, which
    // the owner only announces for orchestrations and runs
    if (transcripts.length && state.share.kinds.includes('artifacts')) await this.pullKind(owner, state, 'artifacts', to);
    state.lastSyncedAt = new Date().toISOString();
    state.error = null;
    this.deps.synced(owner, shareKey, kind);
  }

  /**
   * What was appended to a chat's transcript, or with `agent` to one of its agents' (held under
   * `agentKey`), since the offset held; a shorter file is copied again whole
   */
  private async pullTranscript(owner: string, state: ShareState, chatId: string, agent: string | null, to: HostTarget): Promise<void> {
    const groupId = this.cursorGroup(state);
    if (!groupId || !isSessionId(chatId) || (agent !== null && !isAgentFile(agent))) return;
    const { store, groups } = this.deps;
    const { shareKey } = state.share;
    const ref = shareRef(owner, shareKey);
    const key = agent === null ? chatId : agentKey(chatId, agent);
    for (let round = 0; round < TRANSCRIPT_ROUNDS; round++) {
      const held = groups.cursors(groupId, owner, shareKey).transcripts;
      const offset = held[key] ?? 0;
      const fromSeq = offset === 0 ? 0 : held[seqKey(key)];
      let got: Reply;
      try {
        got = await this.ask(to, { type: 'transcript', shareKey, session: chatId, agent, offset });
      } catch (error) {
        // The chat has no transcript yet, or went since the pull
        if (error instanceof PeerError && error.code === 'not-found') return;
        throw error;
      }
      const { reply, raw } = got;
      if (reply.type !== 'transcript' || !raw) throw new PeerError('protocol', 'transcript was answered with something else');
      if (reply.offset < offset) {
        // The file is shorter than what was held: it was rewritten, so the copy starts over
        store.deleteTranscript(ref, key);
        await this.setTranscriptCursor(groupId, owner, shareKey, key, 0, 0);
        continue;
      }
      const lines = new TextDecoder().decode(raw).split('\n');
      if (lines.at(-1) === '') lines.pop();
      const nextSeq = store.appendTranscriptLines(ref, key, lines, fromSeq);
      await this.setTranscriptCursor(groupId, owner, shareKey, key, reply.next, nextSeq);
      if (raw.length === 0 || reply.next >= reply.size) return;
    }
  }

  private setTranscriptCursor(groupId: string, owner: string, shareKey: string, chatId: string, offset: number, seq: number): Promise<unknown> {
    return this.deps.groups.update(groupId, (doc) => {
      const byKey = (doc.cursors[owner] ??= Object.create(null) as Record<string, { kinds: Partial<Record<CollaboratorsKind, string>>; transcripts: Record<string, number> }>);
      const share = (byKey[shareKey] ??= { kinds: {}, transcripts: Object.create(null) as Record<string, number> });
      share.transcripts[chatId] = offset;
      share.transcripts[seqKey(chatId)] = seq;
    });
  }

  /** Pulls one kind of a copy now, as a route that wants it fresh asks */
  async pull(owner: string, shareKey: string, kind: CollaboratorsKind): Promise<void> {
    const state = this.shares.get(stateKey(owner, shareKey));
    const peer = this.peers.get(owner);
    if (!state || !peer) throw new PeerError('not-found');
    await this.exclusive(peer, () => this.pullKind(owner, state, kind));
  }

  // ---------- Live ----------

  /** Opens, or re-opens with new keys, the `watch` of everything the peer shares with this install */
  private follow(peer: PeerState): void {
    const keys = this.sharesOf(peer.id).map((s) => s.share.shareKey).sort();
    const joined = keys.join('\n');
    if (peer.watch && peer.watchKeys === joined) return;
    peer.watch?.abort();
    peer.watch = null;
    peer.watchKeys = '';
    if (!keys.length) return;
    const controller = new AbortController();
    peer.watch = controller;
    peer.watchKeys = joined;
    for (const state of this.sharesOf(peer.id)) this.deps.synced(peer.id, state.share.shareKey, state.share.kinds[0] ?? 'chats');
    void this.listen(peer, controller, keys);
  }

  private async listen(peer: PeerState, controller: AbortController, keys: string[]): Promise<void> {
    // Leaving the loop from outside: the stream's `next` may wait for a notice that never comes
    const aborted = new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    let lost = false;
    try {
      const stream = this.deps.transport.request(this.to(peer.id), { type: 'watch', shareKeys: keys });
      for (;;) {
        const next = await Promise.race([stream.next(), aborted]);
        if (next === null) {
          void stream.return?.();
          return;
        }
        if (next.done) break;
        const part = next.value;
        if (!('frame' in part)) continue;
        const reply = part.frame as WireReply | null;
        if (reply?.type === 'changed' && typeof reply.shareKey === 'string') this.notice(peer, reply.shareKey, reply.kind);
        else if (reply?.type === 'error') break;
      }
    } catch {
      lost = true;
    }
    if (controller.signal.aborted || peer.watch !== controller) return;
    peer.watch = null;
    peer.watchKeys = '';
    if (lost) {
      // The connection went: the peer is offline until a run reaches it again
      peer.online = false;
      peer.failures = Math.max(peer.failures, 1);
      for (const state of this.sharesOf(peer.id)) this.deps.synced(peer.id, state.share.shareKey, state.share.kinds[0] ?? 'chats');
      this.schedule(peer, false);
    } else {
      // The peer ended it: what it shares changed, or this install is no longer listed
      this.start(peer);
    }
  }

  private notice(peer: PeerState, shareKey: string, kind: CollaboratorsKind): void {
    peer.notices.add(`${shareKey}\u0000${kind}`);
    if (peer.noticeTimer) return;
    peer.noticeTimer = setTimeout(() => {
      peer.noticeTimer = null;
      const due = [...peer.notices];
      peer.notices.clear();
      void this.exclusive(peer, async () => {
        for (const item of due) {
          const [key, k] = item.split('\u0000') as [string, CollaboratorsKind];
          const state = this.shares.get(stateKey(peer.id, key));
          if (!state || !state.share.kinds.includes(k)) continue;
          await this.pullKind(peer.id, state, k);
        }
      }).catch((error: unknown) => {
        if (error instanceof PeerError && error.code === 'forbidden') this.refuse(peer);
        else this.note(peer, error, `collab: pulling from ${this.who(peer.id)} failed: ${describe(error)}`);
      });
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  // ---------- What the service reads ----------

  sharesOf(owner: string): ShareState[] {
    return [...this.shares.values()].filter((s) => s.owner === owner);
  }

  /** Every share known, from the last catalogs, whether or not its owner is reachable now */
  known(): Array<{ owner: string; share: KnownShare }> {
    return [...this.shares.values()].map((s) => ({ owner: s.owner, share: s.share }));
  }

  share(owner: string, shareKey: string): KnownShare | null {
    return this.shares.get(stateKey(owner, shareKey))?.share ?? null;
  }

  /** How current a copy is, in the words of §5.1 */
  state(owner: string, shareKey: string, presence: { path: CollaboratorsPath | null; lastSeenAt: string | null }): SyncState {
    const state = this.shares.get(stateKey(owner, shareKey));
    const peer = this.peers.get(owner);
    const lastSyncedAt = state?.lastSyncedAt ?? this.catalog.at(owner) ?? presence.lastSeenAt;
    const online = !!peer?.online;
    const error = state?.error ?? null;
    if (!online) return { state: lastSyncedAt ? 'offline' : 'pending', lastSyncedAt, path: null, error };
    if (!state?.lastSyncedAt) return { state: 'pending', lastSyncedAt, path: presence.path, error };
    return { state: peer.watch ? 'live' : 'synced', lastSyncedAt, path: presence.path, error };
  }

  // ---------- Blobs ----------

  /** A blob's file, fetched from its owner on first open (§4.3) and kept by its hash */
  async blob(owner: string, shareKey: string, hash: string): Promise<string> {
    const file = join(this.blobsDir, hash);
    if (existsSync(file)) return file;
    const got = await this.ask(this.to(owner), { type: 'blob', shareKey, sha256: hash });
    if (got.reply.type !== 'blob' || !got.raw) throw new PeerError('protocol', 'blob was answered with something else');
    if (sha256(got.raw) !== hash) throw new PeerError('protocol', 'the blob does not match its hash');
    await mkdir(this.blobsDir, { recursive: true });
    const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
    try {
      await writeFile(tmp, got.raw);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return file;
  }

  // ---------- Joins ----------

  private static joinTargets(invite: Invite): HostTarget[] {
    const relays = invite.relays.map(relayTarget).filter((t): t is HostTarget => !!t && t.endpointId !== invite.owner);
    return [{ endpointId: invite.owner, ticket: invite.ticket }, ...relays];
  }

  /**
   * Sends a sealed `join`: to the owner, which signs it in one round trip, else to each member the
   * invite names until one holds it for the owner. A refusal (a used, expired or wrong secret) ends
   * it: no relay would get another answer from the owner.
   */
  async sendJoin(invite: Invite, sealed: string, joiner: string): Promise<JoinOutcome> {
    let last: unknown = new PeerError('unreachable', 'nobody named in the invite answered');
    for (const target of SyncClient.joinTargets(invite)) {
      try {
        const { reply } = await this.ask(target, { type: 'join', groupId: invite.groupId, sealed });
        if (reply.type === 'roster') {
          const result = verifyJoinerChain(reply.versions, invite, joiner);
          if (!result.ok) throw new PeerError('protocol', `the chain does not verify: ${result.message}`);
          return { state: 'joined', chain: reply.versions };
        }
        if (reply.type === 'pending') return { state: 'pending', relayedBy: target.endpointId };
        if (reply.type === 'denied' && reply.groupId === invite.groupId) return { state: 'denied', by: target.endpointId };
        throw new PeerError('protocol', `join was answered with ${reply.type}`);
      } catch (error) {
        if (error instanceof PeerError && (error.code === 'refused' || error.code === 'bad-request')) throw error;
        last = error;
      }
    }
    throw last;
  }

  /**
   * Whether the owner answered this install's join: the group's chain once it signed this install
   * in, or `denied`, from the owner or a member it told; null while nobody knows. An answer this
   * install does not know (a newer peer's) reads as no answer yet.
   */
  async fetchJoinAnswer(invite: Invite, joiner: string): Promise<JoinAnswerOutcome> {
    const denial = inviteDenialTag(invite);
    for (const target of SyncClient.joinTargets(invite)) {
      try {
        const { reply } = await this.ask(target, { type: 'roster', groupId: invite.groupId, sinceVersion: 0, denial });
        if (reply.type === 'denied' && reply.groupId === invite.groupId) return { state: 'denied', by: target.endpointId };
        if (reply.type !== 'roster') continue;
        if (verifyJoinerChain(reply.versions, invite, joiner).ok) return { state: 'joined', chain: reply.versions };
      } catch {
        // Not a member there yet, or not reachable: the next one may know
      }
    }
    return null;
  }

  /** Tells a peer this install left a group */
  async sendLeave(id: string, groupId: string): Promise<boolean> {
    try {
      const { reply } = await this.ask(this.to(id), { type: 'leave', groupId });
      return reply.type === 'ack';
    } catch {
      return false;
    }
  }
}
