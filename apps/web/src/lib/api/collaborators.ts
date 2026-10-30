/**
 * The Collaborators routes (docs/plans/collaborators.md §6): this install's identity and connection,
 * the groups and their invites and joins, a project's sharing, and the read-only copies of what
 * teammates share. Every query is keyed under `'collaborators'`, so each `collaborators.*` event
 * marks all of them stale at once (lib/events.ts); nothing here polls.
 *
 * A share key holds `/` and `#`, so it never travels in a path: the routes take its `shareId`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentReadEntry,
  AgentReadList,
  CollaboratorsStatus,
  CreateGroupRequest,
  Group,
  GroupInvite,
  GroupList,
  JoinGroupResult,
  JoinRequest,
  JournalEntry,
  ProjectSharing,
  SharedArtifact,
  SharedBoard,
  SharedChat,
  SharedDocument,
  SharedMemoryFile,
  SharedProject,
  SharedTranscriptPage,
  UpdateCollaboratorsRequest,
  UpdateProjectSharingRequest,
} from '@claudio/shared';
import { enc, request, type ReadOptions } from '../../api';

/** What a shared project is addressed by in the routes: the sharing install and the key's id. */
export interface SharedRef {
  owner: string;
  shareId: string;
}

const shared = ({ owner, shareId }: SharedRef) => `/collaborators/shared/${enc(owner)}/${enc(shareId)}`;

/** What `GET /collaborators/agent-reads` filters on: one copy, one chat, a moment, how many */
export interface AgentReadQuery {
  owner?: string;
  shareId?: string;
  chatId?: string;
  since?: string;
  limit?: number;
}

const agentReadsPath = (q: AgentReadQuery) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) if (value !== undefined && value !== '') query.set(key, String(value));
  const qs = query.toString();
  return `/collaborators/agent-reads${qs ? `?${qs}` : ''}`;
};

export const collaboratorsApi = {
  status: (o: ReadOptions = {}) => request<CollaboratorsStatus>('/collaborators', o),
  update: (body: UpdateCollaboratorsRequest) => request<CollaboratorsStatus>('/collaborators', { method: 'PUT', body }),

  groups: (o: ReadOptions = {}) => request<GroupList>('/collaborators/groups', o),
  createGroup: (body: CreateGroupRequest) => request<Group>('/collaborators/groups', { method: 'POST', body }),
  /** Leaves the group: deletes every copy synced through it and tells the peers it can reach */
  leaveGroup: (groupId: string) => request<unknown>(`/collaborators/groups/${enc(groupId)}`, { method: 'DELETE' }),
  invite: (groupId: string) => request<GroupInvite>(`/collaborators/groups/${enc(groupId)}/invites`, { method: 'POST' }),
  /** A relayed join can take a member's round trip as well as the owner's, so it waits longer than a read */
  join: (invite: string) => request<JoinGroupResult>('/collaborators/join', { method: 'POST', body: { invite }, timeoutMs: 60_000 }),
  cancelJoin: (groupId: string) => request<unknown>(`/collaborators/join/${enc(groupId)}`, { method: 'DELETE' }),
  joinRequests: (groupId: string, o: ReadOptions = {}) => request<JoinRequest[]>(`/collaborators/groups/${enc(groupId)}/join-requests`, o),
  acceptJoin: (groupId: string, from: string) => request<Group>(`/collaborators/groups/${enc(groupId)}/join-requests/${enc(from)}/accept`, { method: 'POST' }),
  denyJoin: (groupId: string, from: string) => request<unknown>(`/collaborators/groups/${enc(groupId)}/join-requests/${enc(from)}/deny`, { method: 'POST' }),
  removeMember: (groupId: string, endpointId: string) => request<Group>(`/collaborators/groups/${enc(groupId)}/members/${enc(endpointId)}`, { method: 'DELETE' }),
  transferOwnership: (groupId: string, endpointId: string) => request<Group>(`/collaborators/groups/${enc(groupId)}/owner`, { method: 'PUT', body: { endpointId } }),

  projectSharing: (projectId: string, o: ReadOptions = {}) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, o),
  /** Answers 409 with a `ShareKeyInUseError` when another project of this install shares the key */
  updateProjectSharing: (projectId: string, body: UpdateProjectSharingRequest) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, { method: 'PUT', body }),

  sharedProjects: (o: ReadOptions = {}) => request<SharedProject[]>('/collaborators/shared', o),
  link: (ref: SharedRef, projectId: string) => request<SharedProject>(`${shared(ref)}/link`, { method: 'PUT', body: { projectId } }),
  unlink: (ref: SharedRef) => request<SharedProject>(`${shared(ref)}/link`, { method: 'DELETE' }),
  sharedChats: (ref: SharedRef, o: ReadOptions = {}) => request<SharedChat[]>(`${shared(ref)}/chats`, o),
  sharedMemory: (ref: SharedRef, o: ReadOptions = {}) => request<SharedMemoryFile[]>(`${shared(ref)}/memory`, o),
  sharedJournal: (ref: SharedRef, o: ReadOptions = {}) => request<JournalEntry[]>(`${shared(ref)}/journal`, o),
  sharedDocuments: (ref: SharedRef, o: ReadOptions = {}) => request<SharedDocument[]>(`${shared(ref)}/documents`, o),
  sharedBoard: (ref: SharedRef, o: ReadOptions = {}) => request<SharedBoard>(`${shared(ref)}/work-items`, o),
  sharedArtifacts: (ref: SharedRef, o: ReadOptions = {}) => request<SharedArtifact[]>(`${shared(ref)}/artifacts`, o),
  sharedTranscript: (ref: SharedRef, chatId: string, o: ReadOptions = {}) => request<SharedTranscriptPage>(`${shared(ref)}/chats/${enc(chatId)}/transcript`, o),
  /** What agents read of the copies, newest first (docs/plans/collaborators-agent-access.md) */
  agentReads: (q: AgentReadQuery, o: ReadOptions = {}) => request<AgentReadList>(agentReadsPath(q), o),
};

export const collaboratorsKeys = {
  all: ['collaborators'] as const,
  status: ['collaborators', 'status'] as const,
  groups: ['collaborators', 'groups'] as const,
  joinRequests: (groupId: string) => ['collaborators', 'join-requests', groupId] as const,
  shared: ['collaborators', 'shared'] as const,
  sharing: (projectId: string) => ['collaborators', 'sharing', projectId] as const,
  copy: (ref: SharedRef, kind: string, ...rest: string[]) => ['collaborators', 'copy', ref.owner, ref.shareId, kind, ...rest] as const,
  agentReads: (q: AgentReadQuery) => ['collaborators', 'agent-reads', q] as const,
};

/** The local midnight a "today" starts at, as the route's `since` */
export function startOfToday(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** How many different chats the reads came from: "read by 3 chats today" counts chats, not calls */
export const chatsThatRead = (reads: readonly Pick<AgentReadEntry, 'chatId'>[]): number => new Set(reads.map((r) => r.chatId)).size;

/**
 * Today's agent reads of one copy. The audit is written by agents' tools, which send no event, so
 * it is read again every minute while it is on screen.
 */
export const useCopyReadsToday = (ref: SharedRef, enabled = true) => {
  const since = startOfToday();
  const q: AgentReadQuery = { owner: ref.owner, shareId: ref.shareId, since, limit: 1000 };
  return useQuery({ queryKey: collaboratorsKeys.agentReads(q), queryFn: ({ signal }) => collaboratorsApi.agentReads(q, { signal }), enabled, refetchInterval: 60_000 });
};

export const useCollaboratorsStatus = () => useQuery({ queryKey: collaboratorsKeys.status, queryFn: ({ signal }) => collaboratorsApi.status({ signal }) });

export const useCollaboratorGroups = (enabled = true) =>
  useQuery({ queryKey: collaboratorsKeys.groups, queryFn: ({ signal }) => collaboratorsApi.groups({ signal }), enabled });

export const useJoinRequests = (groupId: string, enabled = true) =>
  useQuery({ queryKey: collaboratorsKeys.joinRequests(groupId), queryFn: ({ signal }) => collaboratorsApi.joinRequests(groupId, { signal }), enabled });

export const useSharedProjects = (enabled = true) =>
  useQuery({ queryKey: collaboratorsKeys.shared, queryFn: ({ signal }) => collaboratorsApi.sharedProjects({ signal }), enabled });

/**
 * A change to Collaborators: on success every read under `'collaborators'` is read again, since a
 * roster change moves groups, join requests and shared projects together. The event that follows
 * then only confirms it.
 */
export function useCollaboratorsMutation<A, R>(fn: (args: A) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      // `PUT /collaborators` answers the new status: shown at once, before the refetch lands
      if (isStatus(data)) queryClient.setQueryData(collaboratorsKeys.status, data);
      void queryClient.invalidateQueries({ queryKey: collaboratorsKeys.all });
    },
  });
}

function isStatus(value: unknown): value is CollaboratorsStatus {
  return typeof value === 'object' && value !== null && 'settings' in value && 'connection' in value && 'unavailable' in value;
}
