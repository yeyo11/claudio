/**
 * What the Collaborators page says about a connection, a member and a copy, in words and one tone
 * (docs/plans/collaborators.md §5.1). Plain data, no React: tested without a browser
 * (test/collaborators-page.test.tsx). `--live` never appears here: syncing is not an agent working.
 */
import type { CollaboratorsKind, CollaboratorsStatus, Group, GroupMember, PeerPresence, SharedProject, SyncState } from '@claudio/shared';
import { COLLABORATORS_KINDS } from '@claudio/shared';

/** A status tone, always shown beside its word; `muted` is the neutral one (no status colour). */
export type CollabTone = 'ok' | 'warn' | 'bad' | 'idle' | 'muted';

/** The keys of `collaborators.json` the words below come from. */
export type ConnectionKey = `connection.${'online' | 'relay' | 'starting' | 'noRelay' | 'offline' | 'off'}`;
export type PresenceKey = `presence.${'direct' | 'relay' | 'lastSeen' | 'never'}`;
export type SyncKey = `sync.${'live' | 'synced' | 'offline' | 'offlineNever' | 'pending' | 'paused'}`;

/** What the page shows: off, unavailable (with the module's reason), or on. */
export type PageState = 'unavailable' | 'off' | 'on';

export function pageState(status: CollaboratorsStatus): PageState {
  if (status.unavailable) return 'unavailable';
  return status.settings.enabled ? 'on' : 'off';
}

/**
 * The You card's connection. A relayed path is slower, not wrong, so it has no status colour; it is
 * said when every teammate this install reaches now is reached through a relay, which is what a
 * carrier's NAT leaves (§7.2).
 */
export function connectionWord(status: CollaboratorsStatus, groups: readonly Group[]): { key: ConnectionKey; tone: CollabTone } {
  switch (status.connection) {
    case 'online': {
      const online = groups.flatMap((g) => g.members).filter((m) => !m.self && m.presence?.online);
      if (online.length > 0 && online.every((m) => m.presence?.path === 'relay')) return { key: 'connection.relay', tone: 'muted' };
      return { key: 'connection.online', tone: 'ok' };
    }
    case 'starting':
      return { key: 'connection.starting', tone: 'muted' };
    case 'no-relay':
      return { key: 'connection.noRelay', tone: 'warn' };
    case 'offline':
      return { key: 'connection.offline', tone: 'bad' };
    case 'off':
      return { key: 'connection.off', tone: 'muted' };
  }
}

/** A member's presence: ok while online (with the path), idle while waiting to be seen again. */
export function presenceWord(presence: PeerPresence | null): { key: PresenceKey; tone: CollabTone; ago: string | null } | null {
  if (!presence) return null;
  if (presence.online) return { key: presence.path === 'relay' ? 'presence.relay' : 'presence.direct', tone: 'ok', ago: null };
  return presence.lastSeenAt ? { key: 'presence.lastSeen', tone: 'idle', ago: presence.lastSeenAt } : { key: 'presence.never', tone: 'idle', ago: null };
}

/** A copy's sync state: ok while live, neutral between pulls, idle while the owner is away. */
export function syncWord(sync: SyncState): { key: SyncKey; tone: CollabTone; ago: string | null } {
  switch (sync.state) {
    case 'live':
      return { key: 'sync.live', tone: 'ok', ago: null };
    case 'synced':
      return { key: 'sync.synced', tone: 'muted', ago: sync.lastSyncedAt };
    case 'offline':
      return sync.lastSyncedAt ? { key: 'sync.offline', tone: 'idle', ago: sync.lastSyncedAt } : { key: 'sync.offlineNever', tone: 'idle', ago: null };
    case 'pending':
      return { key: 'sync.pending', tone: 'muted', ago: null };
    case 'paused':
      return { key: 'sync.paused', tone: 'warn', ago: null };
  }
}

/** What the Shared tab's icon says: the worst state among a project's copies (error first). */
export type SyncSummaryKind = 'error' | 'paused' | 'offline' | 'pending' | 'synced';

export const SYNC_SUMMARY_ORDER: readonly SyncSummaryKind[] = ['error', 'paused', 'offline', 'pending', 'synced'];

const summaryOf = (sync: SyncState): SyncSummaryKind => {
  if (sync.error) return 'error';
  switch (sync.state) {
    case 'paused':
      return 'paused';
    case 'offline':
      return 'offline';
    case 'pending':
      return 'pending';
    case 'live':
    case 'synced':
      return 'synced';
  }
};

/** The worst state among `syncs`, with when the freshest copy was pulled (for the synced words); null for none. */
export function worstSync(syncs: readonly SyncState[]): { kind: SyncSummaryKind; ago: string | null } | null {
  let kind: SyncSummaryKind | null = null;
  for (const sync of syncs) {
    const next = summaryOf(sync);
    if (kind === null || SYNC_SUMMARY_ORDER.indexOf(next) < SYNC_SUMMARY_ORDER.indexOf(kind)) kind = next;
  }
  if (kind === null) return null;
  const pulled = syncs.map((s) => s.lastSyncedAt).filter((at): at is string => at !== null).sort();
  return { kind, ago: pulled.length > 0 ? (pulled[pulled.length - 1] ?? null) : null };
}

/** The groups this install owns: where Invite can make an invite. A frozen group signs nothing. */
export const ownedGroups = (groups: readonly Group[]): Group[] => groups.filter((g) => g.isOwner && !g.frozen);

/** The owner first, then by name; this install's own entry stays where its role puts it. */
export function sortMembers(members: readonly GroupMember[]): GroupMember[] {
  return [...members].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'owner' ? -1 : 1));
}

/** The letter of a member's avatar. */
export const initialOf = (name: string): string => (name.trim().charAt(0) || '?').toUpperCase();

/** An endpoint id, shortened for a line: its start and its end, which is what people compare. */
export const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

/** One install of a person, with what it shares. */
export interface SharedInstall {
  owner: string;
  label: string | null;
  projects: SharedProject[];
}

/** One person, by display name, with their installs (§3.1: two installs of one person are two members). */
export interface SharedPerson {
  name: string;
  installs: SharedInstall[];
}

/** What is shared with this install, by person and then by install label, each sorted by name. */
export function byPerson(projects: readonly SharedProject[]): SharedPerson[] {
  const people = new Map<string, Map<string, SharedInstall>>();
  for (const project of projects) {
    const installs = people.get(project.ownerName) ?? new Map<string, SharedInstall>();
    people.set(project.ownerName, installs);
    const install = installs.get(project.owner) ?? { owner: project.owner, label: project.ownerLabel, projects: [] };
    installs.set(project.owner, install);
    install.projects.push(project);
  }
  return [...people.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, installs]) => ({
      name,
      installs: [...installs.values()]
        .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
        .map((install) => ({ ...install, projects: [...install.projects].sort((a, b) => a.name.localeCompare(b.name)) })),
    }));
}

/** The counts a shared project carries, in the order of the Shared tab, without the empty ones. */
export function kindCounts(project: SharedProject): { kind: CollaboratorsKind; count: number }[] {
  return COLLABORATORS_KINDS.filter((kind) => project.kinds.includes(kind)).flatMap((kind) => {
    const count = project.counts[kind] ?? 0;
    return count > 0 ? [{ kind, count }] : [];
  });
}

/**
 * The local project a shared one opens in: the one linked by hand, else the first whose default
 * key matches. Null when it is not cloned here.
 */
export const localProjectOf = (project: SharedProject): string | null => project.linkedProjectId ?? project.matches[0] ?? null;

/** Where a shared project is read: its local project's Shared tab (§5.3). */
export const sharedTabPath = (projectId: string): string => `/?project=${encodeURIComponent(projectId)}&view=shared`;

/** Where a shared project not cloned here is read: its own read-only view, by owner and share id (§5.1). */
export const sharedProjectPath = (project: Pick<SharedProject, 'owner' | 'shareId'>): string =>
  `/collaborators/shared/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.shareId)}`;
