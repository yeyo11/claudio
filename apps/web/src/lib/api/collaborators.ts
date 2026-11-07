/**
 * The Collaborators routes (docs/plans/collaborators.md §6): this install's identity and connection,
 * the groups and their invites and joins, a project's sharing, and the read-only copies of what
 * teammates share. Every query is keyed under `'collaborators'`, so each `collaborators.*` event
 * marks all of them stale at once (lib/events.ts); only the agent-reads audit polls, because no
 * event announces it. This is the web's one client for them: the Collaborators page, a project's
 * Sharing section and Shared tab, and the chat's teammate names read the same queries, so a key or a
 * freshness rule never differs between two screens showing the same thing.
 *
 * A share key holds `/` and `#`, so it never travels in a path: the routes take its `shareId`.
 * A teammate's records are only ever read from here: none of them goes into the person's own chat,
 * task or document queries, so they never mix into their lists, counts or badges.
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
  SharedAgentTranscriptPage,
  SharedSubagent,
  SharedTranscriptPage,
  UpdateCollaboratorsRequest,
  UpdateProjectSharingRequest,
} from '@claudio/shared';
import { enc, request, requestResponse, type ReadOptions } from '../../api';

/** What a shared project is addressed by in the routes: the sharing install and the key's id. */
export interface SharedRef {
  owner: string;
  shareId: string;
}

/** Which agent of a teammate's chat: a subagent, or a workflow agent of `workflowRunId`. */
export type SharedAgentRef = Pick<SharedSubagent, 'agentId' | 'workflowRunId'>;

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
  /** Leaves the group: deletes every copy synced through it at once; the members are told in the background, and again until they take it */
  leaveGroup: (groupId: string) => request<unknown>(`/collaborators/groups/${enc(groupId)}`, { method: 'DELETE' }),
  invite: (groupId: string) => request<GroupInvite>(`/collaborators/groups/${enc(groupId)}/invites`, { method: 'POST' }),
  /**
   * The server answers within seconds: `joined` when the owner or a member answered, else `pending`
   * (202) while it goes on trying, the outcome arriving as events. The longer timeout covers a busy machine
   */
  join: (invite: string) => request<JoinGroupResult>('/collaborators/join', { method: 'POST', body: { invite }, timeoutMs: 30_000 }),
  cancelJoin: (groupId: string) => request<unknown>(`/collaborators/join/${enc(groupId)}`, { method: 'DELETE' }),
  joinRequests: (groupId: string, o: ReadOptions = {}) => request<JoinRequest[]>(`/collaborators/groups/${enc(groupId)}/join-requests`, o),
  acceptJoin: (groupId: string, from: string) => request<Group>(`/collaborators/groups/${enc(groupId)}/join-requests/${enc(from)}/accept`, { method: 'POST' }),
  denyJoin: (groupId: string, from: string) => request<unknown>(`/collaborators/groups/${enc(groupId)}/join-requests/${enc(from)}/deny`, { method: 'POST' }),
  removeMember: (groupId: string, endpointId: string) => request<Group>(`/collaborators/groups/${enc(groupId)}/members/${enc(endpointId)}`, { method: 'DELETE' }),
  transferOwnership: (groupId: string, endpointId: string) => request<Group>(`/collaborators/groups/${enc(groupId)}/owner`, { method: 'PUT', body: { endpointId } }),

  sharing: (projectId: string, o: ReadOptions = {}) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, o),
  /** Answers 409 with a `ShareKeyInUseError` when another project of this install shares the key */
  putSharing: (projectId: string, body: UpdateProjectSharingRequest) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, { method: 'PUT', body }),

  /** Every teammate's project shared with this install */
  catalog: (o: ReadOptions = {}) => request<SharedProject[]>('/collaborators/shared', o),
  /** One shared project, as the catalog lists it; 404 once it is no longer shared with this install */
  project: (ref: SharedRef, o: ReadOptions = {}) => request<SharedProject>(shared(ref), o),
  link: (ref: SharedRef, projectId: string) => request<SharedProject>(`${shared(ref)}/link`, { method: 'PUT', body: { projectId } }),
  unlink: (ref: SharedRef) => request<SharedProject>(`${shared(ref)}/link`, { method: 'DELETE' }),
  chats: (ref: SharedRef, o: ReadOptions = {}) => request<SharedChat[]>(`${shared(ref)}/chats`, o),
  /** The latest window, or the one that ends where `before` starts */
  transcript: (ref: SharedRef, chatId: string, before: number | null, o: ReadOptions = {}) =>
    request<SharedTranscriptPage>(`${shared(ref)}/chats/${enc(chatId)}/transcript${before === null ? '' : `?before=${before}`}`, o),
  /** A subagent's transcript, copied with its chat's: the latest window, or the one that ends where `before` starts */
  agentTranscript: (ref: SharedRef, chatId: string, agent: SharedAgentRef, before: number | null, o: ReadOptions = {}) => {
    const query = new URLSearchParams();
    if (agent.workflowRunId) query.set('workflow', agent.workflowRunId);
    if (before !== null) query.set('before', String(before));
    const qs = query.toString();
    return request<SharedAgentTranscriptPage>(`${shared(ref)}/chats/${enc(chatId)}/subagents/${enc(agent.agentId)}${qs ? `?${qs}` : ''}`, o);
  },
  memory: (ref: SharedRef, o: ReadOptions = {}) => request<SharedMemoryFile[]>(`${shared(ref)}/memory`, o),
  journal: (ref: SharedRef, o: ReadOptions = {}) => request<JournalEntry[]>(`${shared(ref)}/journal`, o),
  documents: (ref: SharedRef, o: ReadOptions = {}) => request<SharedDocument[]>(`${shared(ref)}/documents`, o),
  board: (ref: SharedRef, o: ReadOptions = {}) => request<SharedBoard>(`${shared(ref)}/work-items`, o),
  artifacts: (ref: SharedRef, o: ReadOptions = {}) => request<SharedArtifact[]>(`${shared(ref)}/artifacts`, o),
  /** A document's text: the blob is fetched from the owner the first time it is opened, so it is not JSON */
  async blob(ref: SharedRef, sha256: string, o: ReadOptions = {}): Promise<string> {
    return (await blobResponse(ref, sha256, o)).text();
  },
  /** An upload's bytes, with the credential a bare link cannot carry, to be saved by the browser */
  async blobFile(ref: SharedRef, sha256: string, o: ReadOptions = {}): Promise<Blob> {
    return (await blobResponse(ref, sha256, o)).blob();
  },
  /** What agents read of the copies, newest first (docs/plans/collaborators-agent-access.md) */
  agentReads: (q: AgentReadQuery, o: ReadOptions = {}) => request<AgentReadList>(agentReadsPath(q), o),
};

// Through `requestResponse`, so a refused credential or host brings its screen as every other call does
const blobResponse = (ref: SharedRef, sha256: string, o: ReadOptions): Promise<Response> => requestResponse(`${shared(ref)}/blobs/${enc(sha256)}`, { signal: o.signal });

export const collaboratorsKeys = {
  all: ['collaborators'] as const,
  status: ['collaborators', 'status'] as const,
  groups: ['collaborators', 'groups'] as const,
  joinRequests: (groupId: string) => ['collaborators', 'join-requests', groupId] as const,
  catalog: ['collaborators', 'shared'] as const,
  sharing: (projectId: string) => ['collaborators', 'sharing', projectId] as const,
  /** One shared project; a prefix of its records' keys, so the same events refresh both */
  project: (ref: SharedRef) => ['collaborators', 'shared', ref.owner, ref.shareId] as const,
  records: (ref: SharedRef, kind: 'chats' | 'memory' | 'journal' | 'documents' | 'artifacts' | 'board') => ['collaborators', 'shared', ref.owner, ref.shareId, kind] as const,
  transcript: (ref: SharedRef, chatId: string) => ['collaborators', 'shared', ref.owner, ref.shareId, 'transcript', chatId] as const,
  agentTranscript: (ref: SharedRef, chatId: string, agent: SharedAgentRef) =>
    ['collaborators', 'shared', ref.owner, ref.shareId, 'transcript', chatId, agent.workflowRunId ?? '', agent.agentId] as const,
  blob: (ref: SharedRef, sha256: string) => ['collaborators', 'blob', ref.owner, ref.shareId, sha256] as const,
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

/**
 * Events mark these stale the moment anything changes, so a screen that mounts within half a minute
 * of another reading them (Home, then a project) takes what is cached instead of asking again.
 */
const SETTLED_MS = 30_000;

export const useCollaboratorsStatus = () => useQuery({ queryKey: collaboratorsKeys.status, queryFn: ({ signal }) => collaboratorsApi.status({ signal }), staleTime: SETTLED_MS });

export const useCollaboratorGroups = (enabled = true) =>
  useQuery({ queryKey: collaboratorsKeys.groups, queryFn: ({ signal }) => collaboratorsApi.groups({ signal }), enabled });

export const useJoinRequests = (groupId: string, enabled = true) =>
  useQuery({ queryKey: collaboratorsKeys.joinRequests(groupId), queryFn: ({ signal }) => collaboratorsApi.joinRequests(groupId, { signal }), enabled });

/** The catalog of what teammates share with this install */
export const useSharedProjects = (enabled = true) =>
  useQuery({ queryKey: collaboratorsKeys.catalog, queryFn: ({ signal }) => collaboratorsApi.catalog({ signal }), enabled, staleTime: SETTLED_MS });

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
