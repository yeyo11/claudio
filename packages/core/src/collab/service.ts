import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  COLLABORATORS_KINDS,
  type AgentReadEntry,
  type AgentReadScope,
  type CollaboratorsConnection,
  type CollaboratorsKind,
  type CollaboratorsPath,
  type CollaboratorsSettings,
  type CollaboratorsStatus,
  type CollaboratorsChangeScope,
  type Group,
  type GroupInvite,
  type GroupList,
  type GroupMember,
  type JoinGroupResult,
  type JoinAnswer,
  type JoinRequest,
  type JournalEntry,
  type Localized,
  type Milestone,
  type PeerPresence,
  type PendingJoin,
  type PendingJoinState,
  type ProjectSettings,
  type ProjectSharing,
  type ProjectSharingSettings,
  type SharedArtifact,
  type SharedBoard,
  type SharedChat,
  type SharedDocument,
  type SharedMemoryFile,
  type SharedProject,
  type SharingRemote,
  type UpdateCollaboratorsRequest,
  type UpdateProjectSharingRequest,
  type WorkItemDetail,
} from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import type { CollabStore } from '../db.ts';
import type { ClaudioEventInput } from '../events.ts';
import { git } from '../git.ts';
import type { CoreConfig } from '../paths.ts';
import type { ProjectSettingsStore } from '../project-settings.ts';
import type { ProjectRecord } from '../projects.ts';
import { agentFile, agentKey, PeerError, relayEntry, SyncClient, type KnownShare } from './client.ts';
import { GroupsStore } from './groups-store.ts';
import { CollabHost, type CollabHostOptions, type HostPeer, type HostStatus, type HostUnavailable } from './host-client.ts';
import type { HostPreset } from './host/protocol.ts';
import { checkJoin, createInvite, decodeInvite, denialTag, encodeInvite, InviteFormatError, isInviteExpired, joinPayloadFor, openJoin, sealJoin, secretHash, type Invite } from './invite.ts';
import { agentReadScope, copyInScope, type AgentReadChat, type AgentReadDecision } from './agent-access.ts';
import { createReaders, type ReaderSources, type SharedPlace } from './readers.ts';
import {
  addMember,
  compareHeads,
  createGenesis,
  endpointIdFromSeed,
  extendChain,
  findMember,
  headOf,
  isMember,
  membershipChanges,
  removeMember,
  RosterError,
  transferOwnership,
  type RosterVersion,
} from './roster.ts';
import { describeMember, nameOf, rosterChangeTitle } from './names.ts';
import { CollabServer, type HeldGroup, type JoinPort, type ReplySink } from './serve.ts';
import { CollaboratorsSettingsStore, parseCollaboratorsUpdate } from './settings.ts';
import { isValidShareKey, listRemotes, preferredRemote, shareIdOf, shareKeyFor } from './share-key.ts';
import { isAgentFile, parseRequest, type WireReply, type WireRequest } from './wire.ts';

/*
 * Collaborators on this install (docs/plans/collaborators.md): the switch, the identity, the groups
 * and their signed chains, invites and joins (direct, and relayed while the owner is away), removal,
 * transfer and leave, what this install shares, the copies it holds of what others share, the manual
 * links, and the `collaborators.*` events. The endpoint lives in the host process (`host-client.ts`);
 * answering peers is `serve.ts`; asking them is `client.ts`. This file ties them to the stores.
 */

/** The vault entry of the install's iroh secret key: the one secret in the vault no CLI reads (§3.1) */
const VAULT_TOOL = 'collaborators';
const VAULT_KEY = 'secretKey';
const SEED = /^[0-9a-f]{64}$/;
const PENDING_MS = 30 * 1000;
/** Members an invite names to relay a join through when the owner is offline (§3.3) */
const MAX_RELAYS = 3;

export type CollaboratorsErrorCode = 'off' | 'unavailable' | 'not-ready' | 'not-found' | 'not-owner' | 'invalid' | 'expired' | 'refused' | 'conflict' | 'unreachable';

/** What a route answers when Collaborators refuses a request; `status` is the HTTP status it maps to */
export class CollaboratorsError extends Error {
  constructor(
    readonly code: CollaboratorsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CollaboratorsError';
  }

  get status(): number {
    switch (this.code) {
      case 'not-found':
        return 404;
      case 'not-owner':
        return 403;
      case 'invalid':
      case 'expired':
        return 400;
      case 'unreachable':
        return 502;
      case 'unavailable':
        return 503;
      default:
        return 409;
    }
  }
}

/** What the service is handed to bind the endpoint: `CollabHost`, or a stand-in in a test */
export type HostHandle = Pick<CollabHost, 'start' | 'stop' | 'dispose' | 'request' | 'disconnect' | 'unavailable' | 'status'>;

export interface CollaboratorsDeps {
  config: CoreConfig;
  store: CollabStore;
  vault: { get(tool: string): Record<string, string>; set(tool: string, values: Record<string, string>): Promise<void> };
  emit(event: ClaudioEventInput): void;
  /** The projects imported now */
  projects(): readonly ProjectRecord[];
  projectSettings: Pick<ProjectSettingsStore, 'stored' | 'update' | 'shareKeyHolder'>;
  /** What the serving side reads from: the install's stores, through read-only ports */
  sources: ReaderSources;
  host?: (options: CollabHostOptions) => HostHandle;
  /** `minimal` for tests and the e2e harness: no relay, no discovery, loopback tickets */
  preset?: HostPreset;
  bindAddr?: string | null;
  reconcileMs?: number;
  retryMs?: number;
  debounceMs?: number;
  /** How often a join waiting for its owner is tried again */
  pendingMs?: number;
  /** How long a peer may stay silent in the middle of an answer before its connection is dropped */
  idleMs?: number;
  log?(message: string): void;
}

/**
 * A join this install sent, kept until the chain that lists it arrives, or, once the owner denied it
 * or its invite expired, until the person dismisses it: `collaborators/pending-joins.json`
 */
interface OwnPendingJoin {
  invite: Invite;
  sentAt: string;
  relayedBy: string | null;
  /**
   * The version of the group's chain this install held when it asked, 0 for none. A member the owner
   * removed is never sent the version that removes it, so its chain may still list it: only a newer
   * head that lists it means the join was signed. Absent in a file written before it: 0.
   */
  heldVersion?: number;
  /** Absent in a file written before joins could end: those were all waiting */
  state?: PendingJoinState;
  endedAt?: string | null;
}

const PENDING_STATES: readonly PendingJoinState[] = ['waiting', 'denied', 'expired'];

const now = (): string => new Date().toISOString();
const short = (id: string): string => id.slice(0, 8);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function defaultName(): string {
  try {
    return userInfo().username || 'Claudio';
  } catch {
    return 'Claudio';
  }
}

/** `github.com/acme/mono#apps/web` is the remote `github.com/acme/mono` and the subpath `apps/web` */
function keyParts(shareKey: string): { remote: string | null; subpath: string | null } {
  const hash = shareKey.indexOf('#');
  const base = hash < 0 ? shareKey : shareKey.slice(0, hash);
  return { remote: base.startsWith('local/') ? null : base, subpath: hash < 0 ? null : shareKey.slice(hash + 1) || null };
}

/** A remote's URL without the credentials an https URL may carry */
const withoutCredentials = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');

export class CollaboratorsService {
  private readonly settings: CollaboratorsSettingsStore;
  private readonly groups: GroupsStore;
  private readonly host: HostHandle;
  private readonly client: SyncClient;
  private readonly server: CollabServer;
  private readonly dir: string;
  private readonly pendingFile: string;
  /** Every chain held, by group id: the serving side asks on every request */
  private readonly chains = new Map<string, RosterVersion[]>();
  private readonly tickets = new Map<string, string>();
  private readonly presence = new Map<string, { online: boolean; path: CollaboratorsPath | null }>();
  private readonly conflicts = new Map<string, { version: number; hashes: string[] }>();
  /** The endpoint id this install was a member of each group as (`GroupDoc.heldAs`) */
  private readonly heldAs = new Map<string, string>();
  private readonly defaultKeys = new Map<string, Promise<string | null>>();
  private seedCache: Buffer | null = null;
  private hostStatus: HostStatus | null = null;
  private failure: HostUnavailable | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  /** Roster changes, one at a time: a chain is read, extended and written whole */
  private rosterLock: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: CollaboratorsDeps) {
    this.settings = new CollaboratorsSettingsStore(deps.config);
    this.groups = new GroupsStore(deps.config);
    this.dir = join(deps.config.dataDir, 'collaborators');
    this.pendingFile = join(this.dir, 'pending-joins.json');
    for (const doc of this.groups.all()) {
      if (!doc.chain.length) continue;
      this.chains.set(doc.groupId, doc.chain);
      if (doc.heldAs) this.heldAs.set(doc.groupId, doc.heldAs);
    }
    this.host = (deps.host ?? ((options) => new CollabHost(options)))({
      serve: (from, frame, sink) => this.incoming(from, frame, sink),
      listener: {
        status: (status) => this.onStatus(status),
        peer: (peer) => this.onPeer(peer),
        unavailable: (reason) => {
          this.failure = reason;
          this.hostStatus = null;
          this.client.stop();
          this.changed('settings');
        },
        restarted: () => {
          this.hostStatus = null;
          this.presence.clear();
          this.changed('settings');
        },
        startError: (message) => this.log(`collab: the endpoint did not start: ${message}`),
        log: (message) => this.log(message),
      },
    });
    this.client = new SyncClient({
      transport: this.host,
      store: deps.store,
      groups: this.groups,
      dir: this.dir,
      ticket: () => this.hostStatus?.ticket ?? null,
      target: (id) => ({ endpointId: id, ticket: this.tickets.get(id) ?? null }),
      sawTicket: (id, ticket) => this.tickets.set(id, ticket),
      stalled: (id) => this.host.disconnect(id),
      reachable: (id) => (this.deps.preset ?? 'n0') !== 'minimal' || this.tickets.has(id) || !!this.presence.get(id)?.online,
      groupsWith: (peer) => this.groupsWith(peer),
      applyRoster: (groupId, versions, from) => this.applyRoster(groupId, versions, from),
      conflict: (groupId, version, hashes) => this.conflicts.set(groupId, { version, hashes }),
      synced: (owner, shareKey, kind) => this.emitSynced(owner, shareKey, kind),
      sharesChanged: () => this.changed('links'),
      log: (message) => this.log(message),
      who: (id) => this.who(id),
      ...(deps.reconcileMs !== undefined ? { reconcileMs: deps.reconcileMs } : {}),
      ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}),
      ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
      ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
    });
    this.server = new CollabServer({
      groups: () => this.heldGroups(),
      places: () => this.places(),
      readers: createReaders(deps.sources),
      joins: this.joinPort(),
      ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
      log: (message) => this.log(message),
    });
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  // ---------- On and off ----------

  /** Binds the endpoint when Collaborators is on; with it off, nothing of iroh is loaded */
  async start(): Promise<void> {
    await this.recordHeldAs();
    if (this.settings.read().enabled) await this.bind();
  }

  /**
   * A chain stored before `heldAs` was kept learns it now, from the key held, when that key is a
   * member of its head. A key that is not a member records nothing: it may be a new one made after
   * the old was lost, and recording it would hide that the group is frozen.
   */
  private async recordHeldAs(): Promise<void> {
    const me = this.endpointId();
    for (const [groupId, chain] of this.chains) {
      const head = chain.at(-1);
      const held = this.heldAs.get(groupId);
      if (held && held !== me && head?.owner === held) this.log(`collab: group ${short(groupId)} is frozen: it was owned by ${short(held)}, a key this install no longer holds`);
      if (held || !me || !head || !isMember(head, me)) continue;
      await this.groups.setHeldAs(groupId, me);
      this.heldAs.set(groupId, me);
    }
  }

  /**
   * The group can no longer change (§3.3): this install held it as its owner, and the key it holds
   * now is another, so nobody has the key that signs the next version. Only the install that lost
   * the key can tell; to its members the owner just looks offline.
   */
  private isFrozen(groupId: string, head: RosterVersion): boolean {
    const me = this.endpointId();
    const held = this.heldAs.get(groupId);
    return !!me && !!held && held !== me && head.owner === held;
  }

  private async bind(): Promise<void> {
    if (this.disposed || this.failure) return;
    const seed = await this.ensureSeed();
    const settings = this.settings.read();
    this.host.start({
      secretKey: [...seed],
      preset: this.deps.preset ?? 'n0',
      relayUrls: settings.relayUrl ? [settings.relayUrl] : [],
      bindAddr: this.deps.bindAddr ?? null,
    });
    this.schedulePending();
  }

  private async unbind(): Promise<void> {
    this.client.stop();
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    this.pendingTimer = null;
    this.hostStatus = null;
    this.presence.clear();
    await this.host.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.client.stop();
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    this.pendingTimer = null;
    this.host.dispose();
  }

  status(): CollaboratorsStatus {
    const settings = this.settings.read();
    const failure = this.failure ?? this.host.unavailable;
    return {
      unavailable: failure ? { code: failure.code, reason: unavailableReason(failure) } : null,
      settings,
      endpointId: this.endpointId(),
      connection: this.connection(settings),
      homeRelay: this.hostStatus?.homeRelay ?? null,
    };
  }

  private connection(settings: CollaboratorsSettings): CollaboratorsConnection {
    if (!settings.enabled || this.failure || this.host.unavailable) return 'off';
    const status = this.hostStatus;
    if (!status) return 'starting';
    if (status.connection === 'no-relay' && status.directAddresses.length === 0) return 'offline';
    return status.connection;
  }

  /** `PUT /collaborators`: turning on generates the key once and binds; off lets the host go */
  async update(input: UpdateCollaboratorsRequest): Promise<CollaboratorsStatus> {
    // What the person sent is validated here, so a value that is not one is refused rather than stored
    let patch: UpdateCollaboratorsRequest;
    try {
      patch = parseCollaboratorsUpdate(input);
    } catch (error) {
      throw new CollaboratorsError('invalid', error instanceof Error ? error.message : String(error));
    }
    const { before, after } = await this.settings.update(patch);
    return this.settingsChanged(before, after);
  }

  /** The settings as the person stored them, before the defaults fill them in (`GET /settings/state`) */
  storedSettings(): Record<string, unknown> | null {
    return this.settings.stored();
  }

  /** What the settings read now, defaults included */
  currentSettings(): CollaboratorsSettings {
    return this.settings.read();
  }

  /** Removes the stored value of each key, then binds again where `update` would (`DELETE /settings/state/:setting`) */
  async resetSettings(paths: readonly (readonly string[])[]): Promise<CollaboratorsStatus> {
    const { before, after } = await this.settings.resetKeys(paths);
    return this.settingsChanged(before, after);
  }

  private async settingsChanged(before: CollaboratorsSettings, after: CollaboratorsSettings): Promise<CollaboratorsStatus> {
    if (after.enabled && !before.enabled) await this.bind();
    else if (!after.enabled && before.enabled) await this.unbind();
    else if (after.enabled && after.relayUrl !== before.relayUrl) await this.bind();
    if (JSON.stringify(before) !== JSON.stringify(after)) this.changed('settings');
    return this.status();
  }

  private requireOn(): Buffer {
    if (this.failure ?? this.host.unavailable) throw new CollaboratorsError('unavailable', 'Collaborators is not available on this install');
    if (!this.settings.read().enabled) throw new CollaboratorsError('off', 'Collaborators is off');
    const seed = this.seed();
    if (!seed) throw new CollaboratorsError('off', 'Collaborators is off');
    return seed;
  }

  // ---------- Identity ----------

  private seed(): Buffer | null {
    if (this.seedCache) return this.seedCache;
    const hex = this.deps.vault.get(VAULT_TOOL)[VAULT_KEY];
    this.seedCache = hex && SEED.test(hex) ? Buffer.from(hex, 'hex') : null;
    return this.seedCache;
  }

  private async ensureSeed(): Promise<Buffer> {
    const held = this.seed();
    if (held) return held;
    const seed = randomBytes(32);
    await this.deps.vault.set(VAULT_TOOL, { [VAULT_KEY]: seed.toString('hex') });
    this.seedCache = seed;
    return seed;
  }

  endpointId(): string | null {
    const seed = this.seed();
    return seed ? endpointIdFromSeed(seed) : null;
  }

  private me(): { name: string; label?: string } {
    const settings = this.settings.read();
    return { name: settings.displayName || defaultName(), ...(settings.label ? { label: settings.label } : {}) };
  }

  // ---------- The host ----------

  private onStatus(status: HostStatus): void {
    const first = !this.hostStatus;
    const before = this.hostStatus?.connection;
    this.hostStatus = status;
    if (first) {
      this.refreshPeers();
      this.client.pokeAll();
      void this.retryPending();
    }
    if (first || before !== status.connection) this.changed('settings');
  }

  private onPeer(peer: HostPeer): void {
    const was = this.presence.get(peer.endpointId);
    const next = { online: peer.connected, path: peer.connected ? peer.path : null };
    this.presence.set(peer.endpointId, next);
    // Only members are remembered: a stranger dialling in to join leaves no row
    if (!this.peerIds().has(peer.endpointId)) return;
    this.deps.store.seePeer(peer.endpointId, now(), next.path);
    if (was?.online !== next.online || was?.path !== next.path) {
      this.deps.emit({
        type: 'collaborators.peer',
        title: `${this.memberName(peer.endpointId)} is ${next.online ? 'online' : 'offline'}`,
        endpointId: peer.endpointId,
        name: this.memberName(peer.endpointId),
        presence: this.presenceOf(peer.endpointId),
      });
    }
    // A peer that comes back is synced with now, rather than at the next retry
    if (peer.connected && !this.client.isOnline(peer.endpointId)) this.client.poke(peer.endpointId);
  }

  private presenceOf(id: string): PeerPresence {
    const live = this.presence.get(id);
    return { online: !!live?.online, path: live?.online ? live.path : null, lastSeenAt: this.deps.store.peer(id)?.lastSeenAt ?? null };
  }

  /** Every request a peer sends: the serving side answers it; a `hello` also tells this side to sync */
  private async incoming(from: string, frame: unknown, sink: ReplySink): Promise<void> {
    const request = parseRequest(frame);
    if (request?.type === 'hello') this.heard(from, request);
    const ticket = this.hostStatus?.ticket;
    const wrapped: ReplySink = {
      signal: sink.signal,
      bytes: (data) => sink.bytes(data),
      frame: (reply: WireReply) => sink.frame(reply.type === 'hello' && ticket ? { ...reply, ticket } : reply),
    };
    await this.server.handle(from, frame, wrapped);
  }

  /** A member's `hello`: pull when it holds a newer roster or says what it shares changed */
  private heard(from: string, hello: Extract<WireRequest, { type: 'hello' }>): void {
    if (!this.peerIds().has(from)) return;
    if (hello.ticket) this.tickets.set(from, hello.ticket);
    // A peer that refused this install says hello only once it lists it again
    let pull = !!hello.changed || !this.client.isOnline(from) || this.client.isRefused(from);
    for (const [groupId, theirs] of Object.entries(hello.heads)) {
      const chain = this.chains.get(groupId);
      const head = chain?.at(-1);
      if (!chain || !head || !isMember(head, from)) continue;
      const comparison = compareHeads(headOf(chain), theirs);
      if (comparison === 'behind') pull = true;
      else if (comparison === 'equivocation') this.conflicts.set(groupId, { version: theirs.version, hashes: [headOf(chain).hash, theirs.hash].sort() });
    }
    if (pull) this.client.poke(from);
  }

  // ---------- Groups ----------

  private heldGroups(): HeldGroup[] {
    return [...this.chains].map(([groupId, chain]) => ({ groupId, chain }));
  }

  /** The groups whose head lists both this install and `peer` */
  private groupsWith(peer: string): Array<{ groupId: string; chain: readonly RosterVersion[] }> {
    const me = this.endpointId();
    if (!me || peer === me) return [];
    return this.heldGroups().filter(({ chain }) => {
      const head = chain.at(-1);
      return !!head && isMember(head, me) && isMember(head, peer);
    });
  }

  /** Everyone this install shares a group with */
  private peerIds(): Set<string> {
    const me = this.endpointId();
    const out = new Set<string>();
    if (!me) return out;
    for (const chain of this.chains.values()) {
      const head = chain.at(-1);
      if (!head || !isMember(head, me)) continue;
      for (const m of head.members) if (m.endpointId !== me) out.add(m.endpointId);
    }
    return out;
  }

  private refreshPeers(): void {
    if (this.hostStatus) this.client.setPeers(this.peerIds());
  }

  private memberEntry(id: string): { name: string; label: string | null } | null {
    for (const chain of this.chains.values()) {
      const m = chain.at(-1) && findMember(chain.at(-1) as RosterVersion, id);
      if (m) return { name: m.name, label: m.label ?? null };
    }
    return null;
  }

  /** A member by the name its newest roster version gives it; `hints` name who no roster held here lists yet */
  private memberName(id: string, hints?: Readonly<Record<string, string>>): string {
    return nameOf(this.chains.values(), id, hints) ?? short(id);
  }

  /** A member in a log line: its name and the start of its endpoint id */
  private who(id: string): string {
    return describeMember(nameOf(this.chains.values(), id), id);
  }

  private requireChain(groupId: string): RosterVersion[] {
    const chain = this.chains.get(groupId);
    if (!chain?.length) throw new CollaboratorsError('not-found', 'No such group');
    return chain;
  }

  private group(groupId: string, chain: readonly RosterVersion[]): Group {
    const me = this.endpointId();
    const head = chain.at(-1) as RosterVersion;
    const members: GroupMember[] = [...head.members]
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1))
      .map((m) => ({ ...m, self: m.endpointId === me, presence: m.endpointId === me ? null : this.presenceOf(m.endpointId) }));
    const isOwner = head.owner === me;
    return {
      id: groupId,
      name: head.name,
      head: headOf(chain),
      owner: head.owner,
      isOwner,
      members,
      frozen: this.isFrozen(groupId, head),
      conflict: this.conflicts.get(groupId) ?? null,
      joinRequestCount: isOwner ? this.deps.store.joinRequests({ groupId }).length : 0,
    };
  }

  groupList(): GroupList {
    const groups = [...this.chains].map(([id, chain]) => this.group(id, chain)).sort((a, b) => a.name.localeCompare(b.name));
    const me = this.endpointId();
    // A join whose chain arrived is done, even before its entry is cleared
    const waiting = this.readPending().filter((p) => {
      const head = this.chains.get(p.invite.groupId)?.at(-1);
      return !(head && me && isMember(head, me) && head.version > (p.heldVersion ?? 0));
    });
    return { groups, pendingJoins: waiting.map((p) => this.pendingView(p)) };
  }

  getGroup(groupId: string): Group {
    return this.group(groupId, this.requireChain(groupId));
  }

  /** `POST /collaborators/groups`: this install becomes the owner, at version 1 */
  async createGroup(name: string): Promise<Group> {
    const seed = this.requireOn();
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 100) throw new CollaboratorsError('invalid', 'A group needs a name of at most 100 characters');
    const genesis = createGenesis({ seed, name: trimmed, owner: this.me() });
    const me = endpointIdFromSeed(seed);
    await this.groups.setChain(genesis.groupId, [genesis], me);
    this.chains.set(genesis.groupId, [genesis]);
    this.heldAs.set(genesis.groupId, me);
    this.changed('roster', genesis.groupId);
    return this.getGroup(genesis.groupId);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.rosterLock.then(fn, fn);
    this.rosterLock = run.catch(() => undefined);
    return run;
  }

  /** Writes a chain that grew, and acts on what changed in its membership */
  private async commit(groupId: string, chain: RosterVersion[]): Promise<void> {
    const prev = this.chains.get(groupId)?.at(-1) ?? null;
    const head = chain.at(-1) as RosterVersion;
    const me = this.endpointId();
    // Only a key the head lists is recorded: a chain that drops this install keeps the id it held
    const heldAs = me && isMember(head, me) ? me : undefined;
    await this.groups.setChain(groupId, chain, heldAs);
    this.chains.set(groupId, chain);
    if (heldAs) this.heldAs.set(groupId, heldAs);
    const conflict = this.conflicts.get(groupId);
    if (conflict && head.version > conflict.version) this.conflicts.delete(groupId);
    if (prev) {
      for (const removed of membershipChanges(prev, head).removed) {
        if (removed.endpointId === me || this.peerIds().has(removed.endpointId)) continue;
        // No group left in common: its connections close and its shares stop being listed (§3.3)
        this.host.disconnect(removed.endpointId);
        await this.client.dropOwner(removed.endpointId);
      }
    }
    this.refreshPeers();
    this.changed('roster', groupId, null, rosterChangeTitle(prev, head));
    // Joins this install held as a member are its own to answer now that it signs the roster
    if (prev && me && prev.owner !== me && head.owner === me) {
      for (const row of this.deps.store.joinRequests({ groupId })) this.announceJoinRequest(groupId, row.fromEndpointId);
    }
  }

  /** The owner signs the next version, stores it and tells every member it can reach */
  private sign(groupId: string, make: (head: RosterVersion, seed: Buffer) => RosterVersion): Promise<Group> {
    return this.serialized(async () => {
      const seed = this.requireOn();
      const chain = this.requireChain(groupId);
      const head = chain.at(-1) as RosterVersion;
      if (head.owner !== this.endpointId()) throw new CollaboratorsError('not-owner', 'Only the group owner can change the group');
      let next: RosterVersion;
      try {
        next = make(head, seed);
      } catch (error) {
        if (error instanceof RosterError) throw new CollaboratorsError(error.reason === 'not-listed' ? 'not-found' : 'invalid', error.message);
        throw error;
      }
      await this.commit(groupId, [...chain, next]);
      this.announce(groupId);
      return this.getGroup(groupId);
    });
  }

  /** A `hello` to every other member of the group: those behind pull the new version */
  private announce(groupId: string, changed = false): void {
    const head = this.chains.get(groupId)?.at(-1);
    const me = this.endpointId();
    if (!head || !this.hostStatus) return;
    for (const m of head.members) if (m.endpointId !== me) void this.client.announce(m.endpointId, changed);
  }

  /** Versions a peer sent past the head held: verified link by link, then stored */
  private applyRoster(groupId: string, versions: readonly RosterVersion[], from: string): Promise<void> {
    return this.serialized(async () => {
      const chain = this.chains.get(groupId);
      if (!chain) return;
      let next: RosterVersion[];
      try {
        next = extendChain(chain, versions);
      } catch (error) {
        if (error instanceof RosterError && error.reason === 'equivocation') {
          const held = chain[(error.version ?? 1) - 1];
          const theirs = versions.find((v) => v.version === error.version);
          if (held && theirs) this.conflicts.set(groupId, { version: held.version, hashes: [headOf([held]).hash, headOf([theirs]).hash].sort() });
          this.changed('roster', groupId);
        }
        this.log(`collab: a roster from ${this.who(from)} was refused: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (next.length > chain.length) await this.commit(groupId, next);
    });
  }

  /** `DELETE /collaborators/groups/:id/members/:endpointId` */
  removeMember(groupId: string, endpointId: string): Promise<Group> {
    return this.sign(groupId, (head, seed) => removeMember(head, seed, endpointId));
  }

  /** `PUT /collaborators/groups/:id/owner`: the new owner signs every version after this one */
  transferOwnership(groupId: string, endpointId: string): Promise<Group> {
    return this.sign(groupId, (head, seed) => transferOwnership(head, seed, endpointId));
  }

  /**
   * `DELETE /collaborators/groups/:id`: leaves the group, tells the members it can reach, and deletes
   * every copy synced through it. An owner with members transfers the group first, or it would freeze.
   */
  async leaveGroup(groupId: string): Promise<void> {
    this.requireOn();
    const chain = this.requireChain(groupId);
    const head = chain.at(-1) as RosterVersion;
    const me = this.endpointId();
    if (head.owner === me && head.members.some((m) => m.endpointId !== me)) {
      throw new CollaboratorsError('conflict', 'Transfer the group to another member before leaving it');
    }
    const others = head.members.filter((m) => m.endpointId !== me).sort((a, b) => (a.endpointId === head.owner ? -1 : b.endpointId === head.owner ? 1 : 0));
    if (this.hostStatus) await Promise.all(others.map((m) => this.client.sendLeave(m.endpointId, groupId)));
    const before = this.peerIds();
    await this.serialized(async () => {
      this.chains.delete(groupId);
      this.conflicts.delete(groupId);
      this.heldAs.delete(groupId);
      await this.groups.delete(groupId);
      this.deps.store.dropGroup(groupId);
    });
    const after = this.peerIds();
    for (const id of before) {
      if (after.has(id)) continue;
      this.host.disconnect(id);
      await this.client.dropOwner(id);
    }
    // What a peer still in another group shared only through this one goes at its next reconcile
    for (const id of after) this.client.poke(id);
    this.refreshPeers();
    this.changed('roster', groupId);
  }

  // ---------- Invites and joins ----------

  /** `POST /collaborators/groups/:id/invites`: one-time, valid 7 days */
  createInvite(groupId: string): GroupInvite {
    const seed = this.requireOn();
    const chain = this.requireChain(groupId);
    const head = chain.at(-1) as RosterVersion;
    if (head.owner !== this.endpointId()) throw new CollaboratorsError('not-owner', 'Only the group owner can invite');
    const ticket = this.hostStatus?.ticket;
    if (!ticket) throw new CollaboratorsError('not-ready', 'The endpoint is not bound yet');
    const relays = head.members
      .filter((m) => m.endpointId !== head.owner && this.presence.get(m.endpointId)?.online)
      .slice(0, MAX_RELAYS)
      .map((m) => relayEntry(m.endpointId, this.tickets.get(m.endpointId) ?? null));
    const invite = createInvite({ seed, head, ticket, relays });
    return { groupId, groupName: head.name, text: encodeInvite(invite), expiresAt: invite.expiresAt };
  }

  /** `POST /collaborators/join`: to the owner, else left with a member until the owner is back */
  async join(text: string): Promise<JoinGroupResult> {
    this.requireOn();
    let invite: Invite;
    try {
      invite = decodeInvite(typeof text === 'string' ? text : '');
    } catch (error) {
      throw new CollaboratorsError('invalid', error instanceof InviteFormatError ? error.message : 'The invite is damaged');
    }
    if (isInviteExpired(invite)) throw new CollaboratorsError('expired', 'The invite has expired');
    const me = this.endpointId() as string;
    if (invite.owner === me) throw new CollaboratorsError('invalid', 'This install made the invite');
    // The chain held here may be stale: a removed member is never sent the version that removes it.
    // So the owner or a member is asked first, and the held chain answers only when nobody does
    const held = this.chains.get(invite.groupId)?.at(-1);
    const heldAsMember = !!held && isMember(held, me);
    if (!this.hostStatus) {
      if (heldAsMember) return { state: 'joined', group: this.getGroup(invite.groupId) };
      throw new CollaboratorsError('not-ready', 'The endpoint is not bound yet');
    }
    const sealed = sealJoin(invite.owner, joinPayloadFor(invite, { endpointId: me, ...this.me() }));
    let relayedBy: string | null = null;
    try {
      const outcome = await this.client.sendJoin(invite, sealed, me);
      if (outcome.state === 'joined') {
        await this.joined(invite.groupId, outcome.chain);
        return { state: 'joined', group: this.getGroup(invite.groupId) };
      }
      if (outcome.state === 'denied') throw new CollaboratorsError('refused', `${invite.ownerName || 'The owner'} denied the request to join ${invite.groupName} with this invite`);
      relayedBy = outcome.relayedBy;
    } catch (error) {
      if (error instanceof CollaboratorsError) throw error;
      if (error instanceof PeerError && (error.code === 'refused' || error.code === 'bad-request' || error.code === 'protocol')) {
        throw new CollaboratorsError('refused', `The owner refused the invite${error.message && error.message !== error.code ? `: ${error.message}` : ''}`);
      }
      if (heldAsMember) return { state: 'joined', group: this.getGroup(invite.groupId) };
      // Nobody answered: kept, and sent again until someone does
    }
    const pending: OwnPendingJoin = { invite, sentAt: now(), relayedBy, heldVersion: held?.version ?? 0 };
    await this.writePending([...this.readPending().filter((p) => p.invite.groupId !== invite.groupId), pending]);
    this.changed('roster', invite.groupId);
    return { state: 'pending', pending: this.pendingView(pending) };
  }

  /** `DELETE /collaborators/join/:groupId`: stops waiting, or dismisses a join that ended; a member may still hold the request */
  async cancelJoin(groupId: string): Promise<void> {
    const pending = this.readPending();
    if (!pending.some((p) => p.invite.groupId === groupId)) throw new CollaboratorsError('not-found', 'No request to join that group');
    await this.writePending(pending.filter((p) => p.invite.groupId !== groupId));
    this.changed('roster', groupId);
  }

  private async joined(groupId: string, chain: RosterVersion[]): Promise<void> {
    await this.serialized(async () => {
      const held = this.chains.get(groupId);
      // A chain held already (a member who rejoins) is extended rather than replaced
      const next = held ? extendChain(held, chain) : chain;
      await this.commit(groupId, next);
    });
    const pending = this.readPending();
    if (pending.some((p) => p.invite.groupId === groupId)) await this.writePending(pending.filter((p) => p.invite.groupId !== groupId));
  }

  private readPending(): OwnPendingJoin[] {
    if (!existsSync(this.pendingFile)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.pendingFile, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((p: unknown): OwnPendingJoin[] => {
        if (!isObject(p) || !isObject(p.invite) || typeof p.sentAt !== 'string') return [];
        try {
          const invite = decodeInvite(encodeInvite(p.invite as unknown as Invite));
          const state = PENDING_STATES.find((s) => s === p.state) ?? 'waiting';
          const endedAt = state !== 'waiting' && typeof p.endedAt === 'string' ? p.endedAt : null;
          const heldVersion = typeof p.heldVersion === 'number' && Number.isInteger(p.heldVersion) && p.heldVersion > 0 ? p.heldVersion : 0;
          return [{ invite, sentAt: p.sentAt, relayedBy: typeof p.relayedBy === 'string' ? p.relayedBy : null, heldVersion, state, endedAt }];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private writePending(pending: OwnPendingJoin[]): Promise<void> {
    return writeAtomic(this.pendingFile, `${JSON.stringify(pending, null, 2)}\n`);
  }

  private pendingView(p: OwnPendingJoin): PendingJoin {
    return {
      groupId: p.invite.groupId,
      groupName: p.invite.groupName,
      owner: { endpointId: p.invite.owner, name: p.invite.ownerName },
      relayedBy: p.relayedBy ? { endpointId: p.relayedBy, name: this.memberName(p.relayedBy, { ...p.invite.relayNames, [p.invite.owner]: p.invite.ownerName }) } : null,
      sentAt: p.sentAt,
      expiresAt: p.invite.expiresAt,
      state: p.state ?? 'waiting',
      endedAt: p.endedAt ?? null,
    };
  }

  /**
   * A join that will not be signed: the owner denied it, or its invite expired first. It stays on the
   * page, saying which, until the person dismisses it, and nothing asks after it again.
   */
  private async endJoin(groupId: string, state: Exclude<PendingJoinState, 'waiting'>): Promise<void> {
    const all = this.readPending();
    const found = all.find((q) => q.invite.groupId === groupId);
    if (!found || (found.state ?? 'waiting') !== 'waiting') return;
    const ended: OwnPendingJoin = { ...found, state, endedAt: now() };
    await this.writePending(all.map((q) => (q.invite.groupId === groupId ? ended : q)));
    const { ownerName, groupName } = found.invite;
    const owner = ownerName || short(found.invite.owner);
    this.deps.emit({
      type: 'collaborators.join-ended',
      title: state === 'denied' ? `${owner} denied the request to join ${groupName}` : `The invite to ${groupName} expired before ${owner} answered`,
      pending: this.pendingView(ended),
    });
    this.log(`collab: the join of ${short(groupId)} ${state === 'denied' ? 'was denied' : 'expired unanswered'}`);
  }

  private schedulePending(): void {
    if (this.pendingTimer) return;
    this.pendingTimer = setInterval(() => void this.retryPending(), this.deps.pendingMs ?? PENDING_MS);
    this.pendingTimer.unref?.();
  }

  /** Each join still waiting: the chain is asked for, and a join nobody took is sent again */
  private async retryPending(): Promise<void> {
    if (!this.hostStatus) return;
    const me = this.endpointId();
    if (!me) return;
    for (const p of this.readPending()) {
      if ((p.state ?? 'waiting') !== 'waiting') continue;
      try {
        const answer = await this.client.fetchJoinAnswer(p.invite, me);
        if (answer?.state === 'joined') {
          await this.joined(p.invite.groupId, answer.chain);
          continue;
        }
        if (answer?.state === 'denied') {
          await this.endJoin(p.invite.groupId, 'denied');
          continue;
        }
        // Past its expiry the owner refuses the request, so nobody will ever answer it
        if (isInviteExpired(p.invite)) {
          await this.endJoin(p.invite.groupId, 'expired');
          continue;
        }
        if (p.relayedBy === null) {
          const sealed = sealJoin(p.invite.owner, joinPayloadFor(p.invite, { endpointId: me, ...this.me() }));
          const outcome = await this.client.sendJoin(p.invite, sealed, me);
          if (outcome.state === 'joined') await this.joined(p.invite.groupId, outcome.chain);
          else if (outcome.state === 'denied') await this.endJoin(p.invite.groupId, 'denied');
          else {
            await this.writePending(this.readPending().map((q) => (q.invite.groupId === p.invite.groupId ? { ...q, relayedBy: outcome.relayedBy } : q)));
            this.changed('roster', p.invite.groupId);
          }
        }
      } catch (error) {
        this.log(`collab: the join of ${short(p.invite.groupId)} is still waiting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** What the serving side does with `join`, `joinRelay` and `leave` */
  private joinPort(): JoinPort {
    return {
      join: async (from, group, sealed) => {
        const head = group.chain.at(-1) as RosterVersion;
        const me = this.endpointId();
        if (head.owner === me) return this.signJoin(group.groupId, sealed, from);
        if (!me || !isMember(head, me)) return { type: 'error', code: 'not-found' };
        // A member pasting an invite again is answered with the chain that lists it, as the owner would
        if (isMember(head, from)) return { type: 'roster', groupId: group.groupId, versions: [...group.chain] };
        // Held for the owner, and handed over on the next connection to it (§3.3)
        this.deps.store.putJoinRequest({ groupId: group.groupId, fromEndpointId: from, sealed, relayedBy: null, expiresAt: null, receivedAt: now() });
        this.client.poke(head.owner);
        return { type: 'pending', groupId: group.groupId, owner: head.owner };
      },
      joinRelay: async (relayedBy, group, request) => {
        const seed = this.seed();
        const head = this.chains.get(group.groupId)?.at(-1);
        if (!seed || !head || head.owner !== this.endpointId()) return { type: 'error', code: 'refused' };
        const check = checkJoin({ seed, head, sealed: request.sealed, isUsed: (hash) => this.deps.store.isInviteUsed(group.groupId, hash) });
        if (!check.ok) return check.reason === 'already-member' ? { type: 'ack' } : { type: 'error', code: 'refused', reason: check.reason };
        if (check.request.endpointId !== request.from) return { type: 'error', code: 'refused', reason: 'wrong-endpoint' };
        // Denied already: taken and not asked again; the member learns the answer from `joinAnswers`
        if (this.deps.store.joinDenial(group.groupId, request.from, denialTag(check.secretHash), now())) return { type: 'ack' };
        this.deps.store.putJoinRequest({ groupId: group.groupId, fromEndpointId: request.from, sealed: request.sealed, relayedBy, expiresAt: check.request.expiresAt, receivedAt: request.receivedAt });
        this.announceJoinRequest(group.groupId, request.from);
        return { type: 'ack' };
      },
      denied: (from, group, tag) => !!this.deps.store.joinDenial(group.groupId, from, tag, now()),
      joinAnswers: async (_from, group) => {
        const head = this.chains.get(group.groupId)?.at(-1);
        if (!head || head.owner !== this.endpointId()) return { type: 'error', code: 'refused' };
        // Every member hears every denial of the group: a joiner may ask any of them, not only the one that held its request
        const denied = this.deps.store.joinDenials(group.groupId, now()).map((d) => ({ from: d.endpointId, tag: d.tag, deniedAt: d.deniedAt, expiresAt: d.expiresAt }));
        return { type: 'joinAnswers', groupId: group.groupId, denied };
      },
      leave: async (from, group) => {
        const head = this.chains.get(group.groupId)?.at(-1);
        if (head && head.owner === this.endpointId() && from !== head.owner && isMember(head, from)) {
          await this.removeMember(group.groupId, from).catch((error: unknown) => this.log(`collab: removing ${this.who(from)} who left failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return { type: 'ack' };
      },
    };
  }

  /** The owner's answer to a direct `join`: checked, signed in and the whole chain sent back */
  private signJoin(groupId: string, sealed: string, from: string): Promise<WireReply> {
    return this.serialized(async (): Promise<WireReply> => {
      const seed = this.seed();
      const chain = this.chains.get(groupId);
      const head = chain?.at(-1);
      if (!seed || !chain || !head) return { type: 'error', code: 'not-found' };
      const check = checkJoin({ seed, head, sealed, isUsed: (hash) => this.deps.store.isInviteUsed(groupId, hash), from });
      // A joiner asking again after a lost answer gets the chain that lists it
      if (!check.ok && check.reason === 'already-member') return { type: 'roster', groupId, versions: chain };
      if (!check.ok) return { type: 'error', code: 'refused', reason: check.reason };
      if (this.deps.store.joinDenial(groupId, from, denialTag(check.secretHash), now())) return { type: 'denied', groupId };
      if (!this.deps.store.useInvite(groupId, check.secretHash, now())) return { type: 'error', code: 'refused', reason: 'used' };
      const { endpointId, name, label } = check.request;
      const next = [...chain, addMember(head, seed, endpointId, { name, ...(label !== undefined ? { label } : {}) })];
      await this.commit(groupId, next);
      this.settleJoinRequest(groupId, endpointId, 'accepted');
      this.announce(groupId);
      return { type: 'roster', groupId, versions: next };
    });
  }

  private joinRequestView(groupId: string, from: string): JoinRequest | null {
    const seed = this.seed();
    const row = this.deps.store.joinRequest(groupId, from);
    if (!seed || !row) return null;
    const payload = openJoin(seed, groupId, row.sealed);
    if (!payload) return null;
    return {
      groupId,
      from,
      name: payload.name,
      ...(payload.label !== undefined ? { label: payload.label } : {}),
      relayedBy: row.relayedBy ? { endpointId: row.relayedBy, name: this.memberName(row.relayedBy) } : null,
      receivedAt: row.receivedAt,
      expiresAt: payload.expiresAt,
    };
  }

  /** `GET /collaborators/groups/:id/join-requests`: owner only */
  joinRequests(groupId: string): JoinRequest[] {
    this.requireOwner(groupId);
    return this.deps.store
      .joinRequests({ groupId })
      .map((row) => this.joinRequestView(groupId, row.fromEndpointId))
      .filter((r): r is JoinRequest => r !== null);
  }

  private requireOwner(groupId: string): RosterVersion {
    this.requireOn();
    const head = this.requireChain(groupId).at(-1) as RosterVersion;
    if (head.owner !== this.endpointId()) throw new CollaboratorsError('not-owner', 'Only the group owner can do this');
    return head;
  }

  /** `POST …/join-requests/:from/accept`: the secret is checked again, spent, and the joiner signed in */
  async acceptJoin(groupId: string, from: string): Promise<Group> {
    this.requireOwner(groupId);
    const row = this.deps.store.joinRequest(groupId, from);
    if (!row) throw new CollaboratorsError('not-found', 'No such join request');
    return this.serialized(async () => {
      const seed = this.requireOn();
      const chain = this.requireChain(groupId);
      const head = chain.at(-1) as RosterVersion;
      const check = checkJoin({ seed, head, sealed: row.sealed, isUsed: (hash) => this.deps.store.isInviteUsed(groupId, hash) });
      if (!check.ok || check.request.endpointId !== from) {
        this.settleJoinRequest(groupId, from, !check.ok && check.reason === 'already-member' ? 'accepted' : 'dropped');
        if (check.ok || check.reason !== 'already-member') throw new CollaboratorsError(!check.ok && check.reason === 'expired' ? 'expired' : 'refused', `The request cannot be accepted${check.ok ? '' : `: ${check.reason}`}`);
        return this.getGroup(groupId);
      }
      if (!this.deps.store.useInvite(groupId, check.secretHash, now())) {
        this.settleJoinRequest(groupId, from, 'dropped');
        throw new CollaboratorsError('refused', 'The invite was used already');
      }
      const { endpointId, name, label } = check.request;
      await this.commit(groupId, [...chain, addMember(head, seed, endpointId, { name, ...(label !== undefined ? { label } : {}) })]);
      this.settleJoinRequest(groupId, from, 'accepted');
      this.announce(groupId);
      return this.getGroup(groupId);
    });
  }

  /**
   * `POST …/join-requests/:from/deny`. The denial is remembered until the invite would have expired,
   * so the joiner learns it when it next asks, and the members learn it to answer the joiner while
   * this install is away; the member that held the request is told at once.
   */
  denyJoin(groupId: string, from: string): void {
    const seed = this.requireOn();
    this.requireOwner(groupId);
    const row = this.deps.store.joinRequest(groupId, from);
    if (!row) throw new CollaboratorsError('not-found', 'No such join request');
    this.deps.store.pruneJoinDenials(now());
    const payload = openJoin(seed, groupId, row.sealed);
    if (payload && payload.endpointId === from) {
      const hash = secretHash(payload.secret);
      this.deps.store.putJoinDenial({ groupId, endpointId: from, tag: denialTag(hash), secretHash: hash, deniedAt: now(), expiresAt: payload.expiresAt });
    }
    this.settleJoinRequest(groupId, from, 'denied');
    this.changed('roster', groupId);
    // A `changed` hello makes the member sync now, and its sync asks for the denials
    if (row.relayedBy && row.relayedBy !== this.endpointId() && this.hostStatus) void this.client.announce(row.relayedBy, true);
  }

  /** Tells the owner a join waits for them: the event the bell and the push sender turn into a notification */
  private announceJoinRequest(groupId: string, from: string): void {
    const view = this.joinRequestView(groupId, from);
    const head = this.chains.get(groupId)?.at(-1);
    if (!view || !head) return;
    this.deps.emit({ type: 'collaborators.join-request', title: `${view.name} asks to join ${head.name}`, request: view, groupName: head.name });
  }

  /** Deletes a join request the owner held, and says so, which clears its notification */
  private settleJoinRequest(groupId: string, from: string, answer: JoinAnswer): void {
    // A direct join with nothing held here was never announced, so it has nothing to clear
    if (!this.deps.store.joinRequest(groupId, from)) return;
    const name = this.joinRequestView(groupId, from)?.name ?? short(from);
    this.deps.store.deleteJoinRequest(groupId, from);
    this.deps.emit({ type: 'collaborators.join-answered', title: `The join of ${name} was ${answer}`, groupId, from, answer });
  }

  // ---------- What this install shares ----------

  private stored(project: ProjectRecord): ProjectSettings | null {
    return this.deps.projectSettings.stored(project.id, project.name);
  }

  /** The projects this install shares now, with a group it is a member of: what the serving side reads */
  places(): SharedPlace[] {
    const me = this.endpointId();
    if (!me) return [];
    const mine = new Set([...this.chains].filter(([, chain]) => isMember(chain.at(-1) as RosterVersion, me)).map(([id]) => id));
    const out: SharedPlace[] = [];
    for (const project of this.deps.projects()) {
      const sharing = this.stored(project)?.sharing;
      if (!sharing) continue;
      const groups = sharing.groups.filter((g) => mine.has(g));
      if (!groups.length) continue;
      out.push({ projectId: project.id, name: project.name, path: project.path, shareKey: sharing.shareKey, groups, ...keyParts(sharing.shareKey), kinds: [...COLLABORATORS_KINDS], agentsMayRead: sharing.agentsMayRead !== false });
    }
    return out;
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.deps.projects().find((p) => p.id === projectId);
    if (!project) throw new CollaboratorsError('not-found', 'No such project');
    return project;
  }

  private async remotes(project: ProjectRecord): Promise<SharingRemote[]> {
    const out: SharingRemote[] = [];
    for (const name of listRemotes(project.path)) {
      let url: string;
      try {
        url = withoutCredentials(git(project.path, ['remote', 'get-url', name], 10_000));
      } catch {
        continue;
      }
      const shareKey = await shareKeyFor(project.path, { remote: name });
      if (shareKey.startsWith('local/')) continue;
      out.push({ name, url, shareKey });
    }
    return out;
  }

  /** `GET /projects/:id/sharing`. The default key is stored the first time, so a `local/` one stays the same */
  async projectSharing(projectId: string): Promise<ProjectSharing> {
    const project = this.requireProject(projectId);
    let sharing = this.stored(project)?.sharing ?? null;
    const remotes = await this.remotes(project);
    const remoteName = sharing?.remote && remotes.some((r) => r.name === sharing?.remote) ? sharing.remote : preferredRemote(remotes.map((r) => r.name));
    const fromRemote = remotes.find((r) => r.name === remoteName)?.shareKey ?? null;
    if (!sharing) {
      const shareKey = fromRemote ?? (await shareKeyFor(project.path));
      const holder = this.deps.projectSettings.shareKeyHolder(project.id, shareKey, this.deps.projects());
      if (!holder) {
        const stored: ProjectSharingSettings = { groups: [], shareKey };
        await this.deps.projectSettings.update(project, (current) => ({ ...current, sharing: stored }), this.deps.projects());
        sharing = stored;
      } else sharing = { groups: [], shareKey };
    }
    const defaultShareKey = fromRemote ?? (sharing.shareKey.startsWith('local/') ? sharing.shareKey : await shareKeyFor(project.path));
    const holder = this.deps.projectSettings.shareKeyHolder(project.id, sharing.shareKey, this.deps.projects());
    const parts = keyParts(sharing.shareKey);
    return {
      projectId: project.id,
      groups: [...sharing.groups],
      shareKey: sharing.shareKey,
      shareId: shareIdOf(sharing.shareKey),
      defaultShareKey,
      edited: sharing.shareKey !== defaultShareKey,
      remote: fromRemote ? remoteName : null,
      remotes,
      subpath: parts.subpath,
      keyInUse: holder ? { projectId: holder.id, projectName: holder.name } : null,
      kinds: [...COLLABORATORS_KINDS],
      seenAs: { name: project.name, remote: parts.remote },
      agentsMayRead: sharing.agentsMayRead !== false,
      agentReads: sharing.agentReads === true,
    };
  }

  /**
   * `PUT /projects/:id/sharing`. A key another project holds throws `ShareKeyInUse` from the
   * settings store, which the route answers with 409. Peers of every group concerned are told.
   */
  async updateProjectSharing(projectId: string, patch: UpdateProjectSharingRequest): Promise<ProjectSharing> {
    const project = this.requireProject(projectId);
    const current = (await this.projectSharing(projectId)) satisfies ProjectSharing;
    const me = this.endpointId();
    const stored = this.stored(project)?.sharing;
    const next: ProjectSharingSettings = {
      groups: current.groups,
      shareKey: current.shareKey,
      ...(stored?.remote ? { remote: stored.remote } : {}),
      ...(stored?.agentsMayRead !== undefined ? { agentsMayRead: stored.agentsMayRead } : {}),
      ...(stored?.agentReads !== undefined ? { agentReads: stored.agentReads } : {}),
    };
    if (patch.groups !== undefined) {
      if (!Array.isArray(patch.groups)) throw new CollaboratorsError('invalid', 'groups must be a list of group ids');
      const groups = [...new Set(patch.groups)];
      for (const g of groups) {
        const head = typeof g === 'string' ? this.chains.get(g)?.at(-1) : undefined;
        if (!head || !me || !isMember(head, me)) throw new CollaboratorsError('invalid', `Not a group of this install: ${String(g)}`);
      }
      if (groups.length && !this.settings.read().enabled) throw new CollaboratorsError('off', 'Collaborators is off');
      next.groups = groups;
    }
    if (patch.remote !== undefined) {
      if (patch.remote === null) delete next.remote;
      else {
        const remote = current.remotes.find((r) => r.name === patch.remote);
        if (!remote) throw new CollaboratorsError('invalid', `No such remote: ${String(patch.remote)}`);
        next.remote = remote.name;
        next.shareKey = remote.shareKey;
      }
      if (patch.remote === null) {
        const preferred = preferredRemote(current.remotes.map((r) => r.name));
        next.shareKey = current.remotes.find((r) => r.name === preferred)?.shareKey ?? current.shareKey;
      }
    }
    if (patch.shareKey !== undefined) {
      if (typeof patch.shareKey !== 'string' || !isValidShareKey(patch.shareKey)) throw new CollaboratorsError('invalid', 'A share key is 3 to 200 of a-z, 0-9, ".", "_", "/", "#" and "-"');
      next.shareKey = patch.shareKey;
    }
    for (const flag of ['agentsMayRead', 'agentReads'] as const) {
      if (patch[flag] === undefined) continue;
      if (typeof patch[flag] !== 'boolean') throw new CollaboratorsError('invalid', `${flag} must be true or false`);
      next[flag] = patch[flag];
    }
    await this.deps.projectSettings.update(project, (settings) => ({ ...settings, sharing: next }), this.deps.projects());
    this.changed('sharing', null, project.id);
    for (const groupId of new Set([...current.groups, ...next.groups])) this.announce(groupId, true);
    return this.projectSharing(projectId);
  }

  // ---------- What others share with this install ----------

  private async localKey(project: ProjectRecord): Promise<string | null> {
    const stored = this.stored(project)?.sharing?.shareKey;
    if (stored) return stored;
    let key = this.defaultKeys.get(project.path);
    if (!key) {
      // A project with no remote has no default anyone else could match
      key = shareKeyFor(project.path).then((computed) => (computed.startsWith('local/') ? null : computed), () => null);
      this.defaultKeys.set(project.path, key);
    }
    return key;
  }

  private linkOf(shareKey: string): string | null {
    for (const id of this.chains.keys()) {
      const projectId = this.groups.read(id)?.links[shareKey];
      if (projectId) return projectId;
    }
    return null;
  }

  /** Whether a share is still listed for this install: its owner is in a group with it */
  private visible(owner: string): boolean {
    return this.peerIds().has(owner);
  }

  /** `GET /collaborators/shared` */
  async shared(): Promise<SharedProject[]> {
    const projects = this.deps.projects();
    const keys = new Map<string, string[]>();
    for (const project of projects) {
      const key = await this.localKey(project);
      if (!key) continue;
      keys.set(key, [...(keys.get(key) ?? []), project.id]);
    }
    const out: SharedProject[] = [];
    for (const { owner, share } of this.client.known()) {
      if (!this.visible(owner)) continue;
      const member = this.memberEntry(owner);
      const linked = this.linkOf(share.shareKey);
      out.push({
        owner,
        ownerName: this.memberName(owner),
        ownerLabel: member?.label ?? null,
        groupIds: share.groupIds.filter((g) => this.chains.has(g)),
        shareKey: share.shareKey,
        shareId: shareIdOf(share.shareKey),
        name: share.name,
        remote: share.remote,
        subpath: share.subpath,
        kinds: share.kinds,
        counts: share.counts,
        sync: this.syncState(owner, share.shareKey),
        matches: keys.get(share.shareKey) ?? [],
        linkedProjectId: linked && projects.some((p) => p.id === linked) ? linked : null,
        // Only a catalog that said so: a share cached before the flag reads as off until the next one
        agentsMayRead: share.agentsMayRead === true,
      });
    }
    return out.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.name.localeCompare(b.name));
  }

  private syncState(owner: string, shareKey: string): ReturnType<SyncClient['state']> {
    const live = this.presence.get(owner);
    return this.client.state(owner, shareKey, { path: live?.online ? live.path : null, lastSeenAt: this.deps.store.peer(owner)?.lastSeenAt ?? null });
  }

  private resolveShare(owner: string, shareId: string): KnownShare {
    if (this.visible(owner)) {
      for (const known of this.client.known()) if (known.owner === owner && shareIdOf(known.share.shareKey) === shareId) return known.share;
    }
    throw new CollaboratorsError('not-found', 'No such shared project');
  }

  /** `PUT /collaborators/shared/:owner/:shareId/link`: the shared project shows inside a local one */
  async link(owner: string, shareId: string, projectId: string): Promise<SharedProject> {
    const share = this.resolveShare(owner, shareId);
    this.requireProject(projectId);
    const groupId = share.groupIds.find((g) => this.chains.has(g));
    if (!groupId) throw new CollaboratorsError('not-found', 'No such shared project');
    for (const id of this.chains.keys()) if (id !== groupId && this.groups.read(id)?.links[share.shareKey]) await this.groups.setLink(id, share.shareKey, null);
    await this.groups.setLink(groupId, share.shareKey, projectId);
    this.changed('links');
    return this.sharedOne(owner, shareId);
  }

  /** `DELETE /collaborators/shared/:owner/:shareId/link` */
  async unlink(owner: string, shareId: string): Promise<SharedProject> {
    const share = this.resolveShare(owner, shareId);
    for (const id of this.chains.keys()) if (this.groups.read(id)?.links[share.shareKey]) await this.groups.setLink(id, share.shareKey, null);
    this.changed('links');
    return this.sharedOne(owner, shareId);
  }

  /**
   * `GET /collaborators/shared/:owner/:shareId`: one shared project, as the catalog lists it. What
   * the read-only view of a project not cloned here heads itself with; not-found once the owner no
   * longer shares it with this install.
   */
  sharedProject(owner: string, shareId: string): Promise<SharedProject> {
    return this.sharedOne(owner, shareId);
  }

  private async sharedOne(owner: string, shareId: string): Promise<SharedProject> {
    const found = (await this.shared()).find((p) => p.owner === owner && p.shareId === shareId);
    if (!found) throw new CollaboratorsError('not-found', 'No such shared project');
    return found;
  }

  private copy<T>(owner: string, shareId: string, kind: CollaboratorsKind): Array<{ id: string; data: T }> {
    const share = this.resolveShare(owner, shareId);
    return this.deps.store.records({ ownerId: owner, shareKey: share.shareKey }, kind).flatMap((r) => {
      try {
        return [{ id: r.recordId, data: JSON.parse(r.json) as T }];
      } catch {
        return [];
      }
    });
  }

  sharedChats(owner: string, shareId: string): SharedChat[] {
    return this.copy<SharedChat>(owner, shareId, 'chats')
      .map((r) => r.data)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  sharedMemory(owner: string, shareId: string): SharedMemoryFile[] {
    return this.copy<SharedMemoryFile>(owner, shareId, 'memory')
      .map((r) => r.data)
      .sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.name.localeCompare(b.name));
  }

  sharedJournal(owner: string, shareId: string): JournalEntry[] {
    return this.copy<JournalEntry>(owner, shareId, 'journal')
      .map((r) => r.data)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  sharedDocuments(owner: string, shareId: string): SharedDocument[] {
    return this.copy<SharedDocument>(owner, shareId, 'documents')
      .map((r) => r.data)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  sharedBoard(owner: string, shareId: string): SharedBoard {
    const records = this.copy<WorkItemDetail | Milestone>(owner, shareId, 'board');
    return {
      items: records.filter((r) => r.id.startsWith('item:')).map((r) => r.data as WorkItemDetail),
      milestones: records.filter((r) => r.id.startsWith('milestone:')).map((r) => r.data as Milestone),
    };
  }

  sharedArtifacts(owner: string, shareId: string): SharedArtifact[] {
    return this.copy<SharedArtifact>(owner, shareId, 'artifacts').map((r) => r.data);
  }

  /**
   * A window of a copied transcript, as the JSONL lines the CLI wrote, oldest first after `after` (a
   * line seq); `total` is how many lines the copy holds. Turning lines into entries is the reader's.
   */
  sharedTranscript(
    owner: string,
    shareId: string,
    chatId: string,
    opts: { after?: number; limit?: number; agent?: { agentId: string; workflowRunId: string | null } } = {},
  ): { lines: Array<{ seq: number; line: string }>; total: number; live: boolean } {
    const share = this.resolveShare(owner, shareId);
    const ref = { ownerId: owner, shareKey: share.shareKey };
    const chat = this.deps.store.record(ref, 'chats', chatId);
    if (!chat) throw new CollaboratorsError('not-found', 'No such shared chat');
    let data: Partial<SharedChat> = {};
    try {
      data = JSON.parse(chat.json) as Partial<SharedChat>;
    } catch {
      // A record that does not parse is shown as not live, with no agents
    }
    const live = !!data.live;
    let key = chatId;
    if (opts.agent) {
      const { agentId, workflowRunId } = opts.agent;
      // Only an agent the copied chat lists, and so one whose transcript was pulled with it
      const listed = Array.isArray(data.subagents) && data.subagents.some((a) => a?.agentId === agentId && (a.workflowRunId ?? null) === workflowRunId);
      const file = agentFile(agentId, workflowRunId);
      if (!listed || !isAgentFile(file)) throw new CollaboratorsError('not-found', 'No such subagent in the shared chat');
      key = agentKey(chatId, file);
    }
    return { lines: this.deps.store.transcriptLines(ref, key, opts), total: this.deps.store.transcriptLineCount(ref, key), live };
  }

  /**
   * `GET …/blobs/:sha256`: the file of a document or an upload the copy names, fetched from its
   * owner on first open and kept. A hash no copied record names is refused here too.
   */
  async blob(owner: string, shareId: string, sha256: string): Promise<string> {
    const share = this.resolveShare(owner, shareId);
    const named =
      this.copy<SharedDocument>(owner, shareId, 'documents').some((r) => r.data.sha256 === sha256) ||
      this.copy<SharedArtifact>(owner, shareId, 'artifacts').some((r) => r.data.kind === 'upload' && r.data.sha256 === sha256);
    if (!named) throw new CollaboratorsError('not-found', 'No such blob');
    try {
      return await this.client.blob(owner, share.shareKey, sha256);
    } catch (error) {
      if (error instanceof PeerError && error.code === 'not-found') throw new CollaboratorsError('not-found', 'The owner no longer has it');
      throw new CollaboratorsError('unreachable', `The owner could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Pulls one kind of a copy now, as a reader that wants it fresh asks; quiet when the owner is away */
  async refresh(owner: string, shareId: string, kind: CollaboratorsKind): Promise<void> {
    const share = this.resolveShare(owner, shareId);
    try {
      await this.client.pull(owner, share.shareKey, kind);
    } catch {
      // The copy held is what is shown
    }
  }

  // ---------- What agents read (docs/plans/collaborators-agent-access.md) ----------

  /** Which copies the chat whose token asks may read, or why none; the guard and the routes ask */
  agentReadScope(chat: AgentReadChat | null): AgentReadDecision {
    return agentReadScope(chat, this.settings.read(), (projectId) => {
      const project = this.deps.projects().find((p) => p.id === projectId);
      return !!project && this.stored(project)?.sharing?.agentReads === true;
    });
  }

  /** The shared projects a scope reaches: `GET /collaborators/shared` as a chat's token sees it */
  async sharedForAgent(scope: AgentReadScope): Promise<SharedProject[]> {
    return (await this.shared()).filter((share) => copyInScope(scope, share));
  }

  /** Whether one copy is in a scope; a copy not listed for this install is in none */
  async agentMayRead(scope: AgentReadScope, owner: string, shareId: string): Promise<boolean> {
    const found = (await this.shared()).find((p) => p.owner === owner && p.shareId === shareId);
    return !!found && copyInScope(scope, found);
  }

  /** The share key of a copy this install lists, for the audit; null once it no longer does */
  sharedKey(owner: string, shareId: string): string | null {
    try {
      return this.resolveShare(owner, shareId).shareKey;
    } catch {
      return null;
    }
  }

  /** One read by an agent, as a row: what Settings → Access & safety and the shared copy count */
  recordAgentRead(read: Omit<AgentReadEntry, 'id' | 'shareId' | 'at'> & { at?: string }): AgentReadEntry {
    return this.deps.store.appendAgentRead({ ...read, shareId: shareIdOf(read.shareKey), at: read.at ?? new Date().toISOString() });
  }

  /** `GET /collaborators/agent-reads`: newest first, of one copy when `owner` and `shareId` are given */
  agentReads(filter: { owner?: string; shareId?: string; chatId?: string; since?: string; limit?: number } = {}): AgentReadEntry[] {
    return this.deps.store.agentReads(filter);
  }

  // ---------- Events ----------

  private changed(scope: CollaboratorsChangeScope, groupId: string | null = null, projectId: string | null = null, title: string | null = null): void {
    this.deps.emit({ type: 'collaborators.changed', title: title ?? 'Collaborators changed', scope, groupId, projectId });
  }

  private emitSynced(owner: string, shareKey: string, kind: CollaboratorsKind): void {
    this.deps.emit({
      type: 'collaborators.synced',
      title: `Synced ${kind} from ${this.memberName(owner)}`,
      owner,
      shareKey,
      shareId: shareIdOf(shareKey),
      kind,
      sync: this.syncState(owner, shareKey),
    });
  }
}

function unavailableReason(failure: HostUnavailable): Localized {
  switch (failure.code) {
    case 'platform':
      return { code: 'collaborators.unavailable.platform', text: 'Not available on this platform' };
    case 'load':
      return { code: 'collaborators.unavailable.load', text: 'The native module did not load' };
    default:
      return { code: 'collaborators.unavailable.host', text: 'The Collaborators process keeps stopping' };
  }
}
