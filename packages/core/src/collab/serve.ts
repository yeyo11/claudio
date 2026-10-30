import type { CollaboratorsKind } from '@claudio/shared';
import type { ChangeListener, ReadEntry, Readers, SharedPlace } from './readers.ts';
import { headOf, isMember, suffixSince, type RosterHead, type RosterVersion } from './roster.ts';
import {
  BATCH_MAX_RECORDS,
  BATCH_TARGET_BYTES,
  MAX_TRANSCRIPT_BYTES,
  parseRequest,
  pieces,
  type CatalogEntry,
  type WireErrorCode,
  type WireRecord,
  type WireReply,
  type WireRequest,
} from './wire.ts';
import { errorMessage } from '@claudio/shared';

/*
 * The serving side of `claudio/collab/1` (docs/plans/collaborators.md §3.5, §4.2). It is built with
 * read-only ports and the groups this install holds, and answers one request per stream. Before
 * anything is read, every request passes the checks of §3.5:
 *
 *   1. the asker is a member of a group, on the chain this install holds;
 *   2. the project named by its share key is shared with a group the asker is a member of;
 *   3. the kind asked for is one the project shares;
 *   4. a blob's hash is referenced by a shared record of that project: a hash is not a credential.
 *
 * `join` is the one frame taken from a non-member, and `roster` the one answered to a non-member
 * otherwise: `denied`, and only to a joiner that names the invite it was denied with. `leave`,
 * `joinRelay` and `joinAnswers` are taken from a member for its own group. Their effects (signing, storing a pending join) are the service's, through
 * `JoinPort`; this file only decides who may ask.
 */

/** A group as this install holds it: its verified chain, oldest first */
export interface HeldGroup {
  groupId: string;
  chain: readonly RosterVersion[];
}

/** What the service does with the frames that change a roster; each answers with the reply to send */
export interface JoinPort {
  /** A `join` straight from the joiner (`from`, authenticated by iroh), or to be stored and relayed */
  join(from: string, group: HeldGroup, sealed: string): Promise<WireReply>;
  /** A pending join a member forwards to this install, the owner */
  joinRelay(relayedBy: string, group: HeldGroup, request: Extract<WireRequest, { type: 'joinRelay' }>): Promise<WireReply>;
  /** A member telling this install it left */
  leave(from: string, group: HeldGroup): Promise<WireReply>;
  /** Whether this install holds a denial of `from`'s request to join with the invite `tag` names */
  denied(from: string, group: HeldGroup, tag: string): boolean;
  /** A member asking the owner which joins of the group it denied */
  joinAnswers(from: string, group: HeldGroup): Promise<WireReply>;
}

export interface ServeDeps {
  groups(): readonly HeldGroup[];
  /** The projects this install shares, with their keys and groups */
  places(): readonly SharedPlace[] | Promise<readonly SharedPlace[]>;
  readers: Readers;
  joins: JoinPort;
  /** How long `changed` notices for one share key and kind are gathered before one is sent */
  debounceMs?: number;
  log?(message: string): void;
}

/** Where a request's answer goes: frames, raw bytes after a frame that announces them, and the stream's end */
export interface ReplySink {
  frame(reply: WireReply): Promise<void>;
  bytes(data: Uint8Array): Promise<void>;
  /** Aborted when the stream or its connection closes; a `watch` ends with it */
  signal: AbortSignal;
}

class Refused extends Error {
  constructor(
    readonly code: WireErrorCode,
    reason?: string,
  ) {
    super(reason ?? code);
  }
}

const KINDS_BY_READER = ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'] as const satisfies readonly CollaboratorsKind[];

export class CollabServer {
  constructor(private readonly deps: ServeDeps) {}

  /**
   * Answers one stream's request. `from` is the endpoint id iroh authenticated in the handshake; the
   * frame is whatever the peer sent. Every refusal is a frame, never a thrown error.
   */
  async handle(from: string, frame: unknown, sink: ReplySink): Promise<void> {
    const request = parseRequest(frame);
    try {
      if (!request) throw new Refused('bad-request');
      await this.answer(from, request, sink);
    } catch (error) {
      if (sink.signal.aborted) return;
      const reply: WireReply = error instanceof Refused ? { type: 'error', code: error.code } : { type: 'error', code: 'internal' };
      if (!(error instanceof Refused)) this.deps.log?.(`collab: ${request?.type ?? 'frame'} from ${from.slice(0, 10)} failed: ${errorMessage(error)}`);
      try {
        await sink.frame(reply);
      } catch {
        // The stream is gone; nobody is left to tell
      }
    }
  }

  // ---------- The checks ----------

  /** The groups this install holds whose head lists `from`: check 1 */
  private memberGroups(from: string): HeldGroup[] {
    return this.deps.groups().filter((group) => {
      const head = group.chain.at(-1);
      return !!head && isMember(head, from);
    });
  }

  private member(from: string): HeldGroup[] {
    const groups = this.memberGroups(from);
    if (groups.length === 0) throw new Refused('forbidden');
    return groups;
  }

  private memberOf(from: string, groupId: string): HeldGroup {
    const group = this.member(from).find((g) => g.groupId === groupId);
    if (!group) throw new Refused('forbidden');
    return group;
  }

  /** The project shared under `shareKey` with a group `from` belongs to: checks 1 and 2 */
  private async place(from: string, shareKey: string): Promise<SharedPlace> {
    const groups = new Set(this.member(from).map((g) => g.groupId));
    const places = await this.deps.places();
    const place = places.find((p) => p.shareKey === shareKey && p.groups.some((g) => groups.has(g)));
    if (!place) throw new Refused('not-found');
    return place;
  }

  /** Check 3 */
  private shares(place: SharedPlace, kind: CollaboratorsKind): void {
    if (!place.kinds.includes(kind)) throw new Refused('not-found');
  }

  // ---------- The frames ----------

  private async answer(from: string, request: WireRequest, sink: ReplySink): Promise<void> {
    switch (request.type) {
      case 'join': {
        // The one frame a non-member may send: the group must be one this install holds
        const group = this.deps.groups().find((g) => g.groupId === request.groupId);
        if (!group) throw new Refused('not-found');
        await sink.frame(await this.deps.joins.join(from, group, request.sealed));
        return;
      }
      case 'joinRelay':
        await sink.frame(await this.deps.joins.joinRelay(from, this.memberOf(from, request.groupId), request));
        return;
      case 'leave':
        await sink.frame(await this.deps.joins.leave(from, this.memberOf(from, request.groupId)));
        return;
      case 'joinAnswers':
        await sink.frame(await this.deps.joins.joinAnswers(from, this.memberOf(from, request.groupId)));
        return;
      case 'hello': {
        const heads: Record<string, RosterHead> = Object.create(null) as Record<string, RosterHead>;
        for (const group of this.member(from)) heads[group.groupId] = headOf(group.chain);
        await sink.frame({ type: 'hello', heads });
        return;
      }
      case 'roster': {
        // A joiner asking whether it is in yet: the answer may be that the owner said no
        if (request.denial !== undefined) {
          const held = this.deps.groups().find((g) => g.groupId === request.groupId);
          const head = held?.chain.at(-1);
          if (held && head && !isMember(head, from) && this.deps.joins.denied(from, held, request.denial)) {
            await sink.frame({ type: 'denied', groupId: held.groupId });
            return;
          }
        }
        const group = this.memberOf(from, request.groupId);
        await sink.frame({ type: 'roster', groupId: group.groupId, versions: suffixSince(group.chain, request.sinceVersion) });
        return;
      }
      case 'catalog':
        await sink.frame(await this.catalog(from, request.groupId));
        return;
      case 'pull':
        await this.pull(from, request, sink);
        return;
      case 'transcript':
        await this.transcript(from, request, sink);
        return;
      case 'blob':
        await this.blob(from, request, sink);
        return;
      case 'watch':
        await this.watch(from, request.shareKeys, sink);
        return;
    }
  }

  private async entries(place: SharedPlace, kind: CollaboratorsKind): Promise<ReadEntry<unknown>[]> {
    const { readers } = this.deps;
    switch (kind) {
      case 'chats':
        return readers.chats.list(place);
      case 'memory':
        return readers.memory.list(place);
      case 'journal':
        return readers.journal.list(place);
      case 'documents':
        return readers.documents.list(place);
      case 'board':
        return readers.workItems.list(place);
      case 'artifacts':
        // Uploads are shared as part of a shared chat, so the chat kind gates them too
        return readers.uploads.list(place, place.kinds.includes('chats') ? await this.chatIds(place) : []);
    }
  }

  private async chatIds(place: SharedPlace): Promise<string[]> {
    return (await this.deps.readers.chats.list(place)).map((entry) => entry.id);
  }

  private async catalog(from: string, groupId: string): Promise<WireReply> {
    const group = this.memberOf(from, groupId);
    const projects: CatalogEntry[] = [];
    for (const place of await this.deps.places()) {
      if (!place.groups.includes(group.groupId)) continue;
      const counts: CatalogEntry['counts'] = {};
      const versions: CatalogEntry['versions'] = {};
      for (const kind of KINDS_BY_READER) {
        if (!place.kinds.includes(kind)) continue;
        const entries = await this.entries(place, kind);
        counts[kind] = entries.length;
        const byId: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const entry of entries) byId[entry.id] = entry.version;
        versions[kind] = byId;
      }
      projects.push({ shareKey: place.shareKey, name: place.name, remote: place.remote, subpath: place.subpath, kinds: [...place.kinds], counts, versions, agentsMayRead: place.agentsMayRead });
    }
    return { type: 'catalog', groupId: group.groupId, projects };
  }

  private async pull(from: string, request: Extract<WireRequest, { type: 'pull' }>, sink: ReplySink): Promise<void> {
    const place = await this.place(from, request.shareKey);
    this.shares(place, request.kind);
    const since = request.since;
    const due = (await this.entries(place, request.kind))
      .filter((entry) => entry.always || since === null || entry.cursor > since)
      .sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
    let cursor = since;
    let batch: WireRecord[] = [];
    let size = 0;
    for (const entry of due) {
      if (sink.signal.aborted) return;
      const record: WireRecord = { id: entry.id, version: entry.version, data: await entry.load() };
      const bytes = JSON.stringify(record).length;
      if (batch.length > 0 && (batch.length >= BATCH_MAX_RECORDS || size + bytes > BATCH_TARGET_BYTES)) {
        await sink.frame({ type: 'records', kind: request.kind, records: batch });
        batch = [];
        size = 0;
      }
      batch.push(record);
      size += bytes;
      if (cursor === null || entry.cursor > cursor) cursor = entry.cursor;
    }
    if (batch.length) await sink.frame({ type: 'records', kind: request.kind, records: batch });
    await sink.frame({ type: 'cursor', kind: request.kind, cursor });
  }

  private async transcript(from: string, request: Extract<WireRequest, { type: 'transcript' }>, sink: ReplySink): Promise<void> {
    const place = await this.place(from, request.shareKey);
    this.shares(place, 'chats');
    // Only the transcript of a chat the project shares, never a session id found elsewhere
    if (!(await this.deps.readers.chats.get(place, request.session))) throw new Refused('not-found');
    const slice = await this.deps.readers.transcripts.read(request.session, request.agent, request.offset, MAX_TRANSCRIPT_BYTES);
    if (!slice) throw new Refused('not-found');
    await sink.frame({ type: 'transcript', session: request.session, agent: request.agent, offset: slice.offset, next: slice.next, size: slice.size, bytes: slice.bytes.length });
    for (const piece of pieces(slice.bytes)) {
      if (sink.signal.aborted) return;
      await sink.bytes(piece);
    }
  }

  private async blob(from: string, request: Extract<WireRequest, { type: 'blob' }>, sink: ReplySink): Promise<void> {
    const place = await this.place(from, request.shareKey);
    // Check 4: the bytes are found through a shared record that names the hash, or not at all
    let bytes: Uint8Array | null = null;
    if (place.kinds.includes('documents')) bytes = await this.deps.readers.documents.read(place, request.sha256);
    if (!bytes && place.kinds.includes('artifacts') && place.kinds.includes('chats')) {
      bytes = await this.deps.readers.uploads.read(place, await this.chatIds(place), request.sha256);
    }
    if (!bytes) throw new Refused('not-found');
    await sink.frame({ type: 'blob', sha256: request.sha256, bytes: bytes.length });
    for (const piece of pieces(bytes)) {
      if (sink.signal.aborted) return;
      await sink.bytes(piece);
    }
  }

  private async watch(from: string, shareKeys: readonly string[], sink: ReplySink): Promise<void> {
    const watched: SharedPlace[] = [];
    for (const key of shareKeys) watched.push(await this.place(from, key));
    const { readers } = this.deps;
    const debounceMs = this.deps.debounceMs ?? 250;
    const timers = new Map<string, NodeJS.Timeout>();
    const stops: Array<() => void> = [];
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (ended = resolve));

    const notify = (kind: CollaboratorsKind): ChangeListener => (projectId) => {
      for (const place of watched) {
        if (projectId !== null && projectId !== place.projectId) continue;
        if (!place.kinds.includes(kind)) continue;
        const key = `${place.shareKey}\u0000${kind}`;
        if (timers.has(key)) continue;
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            // A member removed while watching stops hearing anything at the next notice
            if (!this.memberGroups(from).some((g) => place.groups.includes(g.groupId))) {
              ended();
              return;
            }
            sink.frame({ type: 'changed', shareKey: place.shareKey, kind }).catch(() => ended());
          }, debounceMs),
        );
      }
    };

    stops.push(readers.chats.watch(notify('chats')));
    stops.push(readers.transcripts.watch(notify('chats')));
    stops.push(readers.memory.watch(notify('memory')));
    stops.push(readers.journal.watch(notify('journal')));
    stops.push(readers.documents.watch(notify('documents')));
    stops.push(readers.workItems.watch(notify('board')));
    stops.push(readers.uploads.watch(notify('artifacts')));
    const onAbort = (): void => ended();
    sink.signal.addEventListener('abort', onAbort, { once: true });
    if (sink.signal.aborted) ended();
    try {
      await done;
    } finally {
      sink.signal.removeEventListener('abort', onAbort);
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    }
  }
}
