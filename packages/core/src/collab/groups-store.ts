import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLABORATORS_KINDS, type CollaboratorsKind, type EndpointId, type RosterVersion } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';

/*
 * `<dataDir>/collaborators/groups/<groupId>.json` (docs/plans/collaborators.md §4.3): per group the
 * signed roster chain, the manual links and the sync cursors. A document, not rows: it is read and
 * rewritten whole, and it is small. The chain is stored as received; verifying it is `roster.ts`'s
 * job before anything is put here.
 */

/** Where the copy of one owner's share stands, per kind and per transcript file. */
export interface ShareCursors {
  /** The cursor the owner's last `pull` of each kind ended with, opaque to this side */
  kinds: Partial<Record<CollaboratorsKind, string>>;
  /** Byte offset reached in each transcript, by session (transcripts are append-only, §4.1) */
  transcripts: Record<string, number>;
}

export interface GroupDoc {
  groupId: string;
  /** Every roster version held, oldest first: version 1 is the genesis */
  chain: RosterVersion[];
  /** Manual pairings of a share key with a local project id (§3.4) */
  links: Record<string, string>;
  /** By the sharing install's endpoint id, then by share key */
  cursors: Record<EndpointId, Record<string, ShareCursors>>;
}

/** A group id is the hex sha256 of its genesis, so it is safe as a file name once it matches this. */
const GROUP_ID = /^[0-9a-f]{64}$/;

export const isGroupId = (value: unknown): value is string => typeof value === 'string' && GROUP_ID.test(value);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isKind = (value: string): value is CollaboratorsKind => (COLLABORATORS_KINDS as readonly string[]).includes(value);

/** Own-property maps only: share keys and ids come from peers, and `__proto__` must stay a key. */
const map = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const emptyCursors = (): ShareCursors => ({ kinds: {}, transcripts: map() });

function sanitizeCursors(value: unknown): ShareCursors {
  const out = emptyCursors();
  if (!isObject(value)) return out;
  if (isObject(value.kinds)) {
    for (const [kind, cursor] of Object.entries(value.kinds)) if (isKind(kind) && typeof cursor === 'string') out.kinds[kind] = cursor;
  }
  if (isObject(value.transcripts)) {
    for (const [session, offset] of Object.entries(value.transcripts)) {
      if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) out.transcripts[session] = offset;
    }
  }
  return out;
}

/** What a stored file is worth: a part that does not have its shape is dropped, the rest kept. */
function sanitize(groupId: string, value: unknown): GroupDoc {
  const raw = isObject(value) ? value : {};
  const links = map<string>();
  if (isObject(raw.links)) for (const [key, projectId] of Object.entries(raw.links)) if (typeof projectId === 'string') links[key] = projectId;
  const cursors = map<Record<string, ShareCursors>>();
  if (isObject(raw.cursors)) {
    for (const [owner, byKey] of Object.entries(raw.cursors)) {
      if (!isObject(byKey)) continue;
      const shares = map<ShareCursors>();
      for (const [key, c] of Object.entries(byKey)) shares[key] = sanitizeCursors(c);
      cursors[owner] = shares;
    }
  }
  const chain = Array.isArray(raw.chain) ? (raw.chain.filter(isObject) as unknown as RosterVersion[]) : [];
  return { groupId, chain, links, cursors };
}

export class GroupsStore {
  readonly dir: string;
  /**
   * Changes run one at a time, so two made together (a link while a pull moves a cursor) both land
   * and never share `writeAtomic`'s temp file.
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(config: CoreConfig) {
    this.dir = join(config.dataDir, 'collaborators', 'groups');
  }

  private file(groupId: string): string {
    // Ids reach this from peers and from routes, and end up in a path
    if (!isGroupId(groupId)) throw new Error('invalid group id');
    return join(this.dir, `${groupId}.json`);
  }

  /** The ids of every group with a document. */
  ids(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter(isGroupId)
      .sort();
  }

  /** The group's document, or null when there is none. One that does not parse answers null and stays on disk. */
  read(groupId: string): GroupDoc | null {
    const file = this.file(groupId);
    if (!existsSync(file)) return null;
    try {
      return sanitize(groupId, JSON.parse(readFileSync(file, 'utf8')) as unknown);
    } catch {
      return null;
    }
  }

  all(): GroupDoc[] {
    return this.ids().flatMap((id) => this.read(id) ?? []);
  }

  /**
   * Changes a group's document: `change` is handed what is stored now, read under the lock, or an
   * empty document for a group seen for the first time, and the result is written whole.
   */
  update(groupId: string, change: (doc: GroupDoc) => GroupDoc | void): Promise<GroupDoc> {
    const file = this.file(groupId);
    return this.serialized(async () => {
      const held = this.read(groupId);
      // A file that does not parse still holds the chain someone may recover: never written over
      if (!held && existsSync(file)) throw new Error(`the document of group ${groupId} does not parse`);
      const current = held ?? sanitize(groupId, null);
      const next = change(current) ?? current;
      const doc: GroupDoc = { groupId, chain: next.chain, links: next.links, cursors: next.cursors };
      await writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
      return doc;
    });
  }

  /** Replaces the chain: a verified suffix appended to it, or a joiner's first chain. */
  setChain(groupId: string, chain: readonly RosterVersion[]): Promise<GroupDoc> {
    return this.update(groupId, (doc) => ({ ...doc, chain: [...chain] }));
  }

  /** Pairs a share key with a local project, or undoes the pairing with null. */
  setLink(groupId: string, shareKey: string, projectId: string | null): Promise<GroupDoc> {
    return this.update(groupId, (doc) => {
      if (projectId === null) delete doc.links[shareKey];
      else doc.links[shareKey] = projectId;
    });
  }

  /** The cursors of one owner's share, empty before its first pull. */
  cursors(groupId: string, ownerId: EndpointId, shareKey: string): ShareCursors {
    const held = this.read(groupId)?.cursors[ownerId]?.[shareKey];
    // A copy, so a caller cannot change what the next update writes
    return held ? { kinds: { ...held.kinds }, transcripts: { ...held.transcripts } } : { kinds: {}, transcripts: {} };
  }

  /** Moves the cursor of one kind; the other kinds keep theirs. */
  setKindCursor(groupId: string, ownerId: EndpointId, shareKey: string, kind: CollaboratorsKind, cursor: string): Promise<GroupDoc> {
    return this.update(groupId, (doc) => {
      shareOf(doc, ownerId, shareKey).kinds[kind] = cursor;
    });
  }

  /** Moves the byte offset reached in one transcript. */
  setTranscriptOffset(groupId: string, ownerId: EndpointId, shareKey: string, sessionId: string, offset: number): Promise<GroupDoc> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('a transcript offset is a byte count');
    return this.update(groupId, (doc) => {
      shareOf(doc, ownerId, shareKey).transcripts[sessionId] = offset;
    });
  }

  /** Forgets where a copy stood: one share of an owner, or all of the owner's with no key. */
  dropCursors(groupId: string, ownerId: EndpointId, shareKey?: string): Promise<GroupDoc> {
    return this.update(groupId, (doc) => {
      const byKey = doc.cursors[ownerId];
      if (!byKey) return;
      if (shareKey === undefined) delete doc.cursors[ownerId];
      else delete byKey[shareKey];
    });
  }

  /** Deletes the group's document: the install left the group. */
  delete(groupId: string): Promise<void> {
    const file = this.file(groupId);
    return this.serialized(() => rm(file, { force: true }));
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}

function shareOf(doc: GroupDoc, ownerId: EndpointId, shareKey: string): ShareCursors {
  const byKey = (doc.cursors[ownerId] ??= map<ShareCursors>());
  return (byKey[shareKey] ??= emptyCursors());
}
