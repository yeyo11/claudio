/**
 * What the Sharing section and the Shared tab read and write (docs/plans/collaborators.md §6). Every
 * query is keyed under `collaborators`, so the `collaborators.*` events mark all of them stale at once
 * (lib/events.ts). A teammate's records are only ever read from here: none of them goes into the
 * person's own chat, task or document queries, so they never mix into their lists, counts or badges.
 */
import type {
  CollaboratorsStatus,
  GroupList,
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
  UpdateProjectSharingRequest,
} from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { enc, request, requestResponse, type ReadOptions } from '../../api';
import { sharedWith } from '../dashboard/views';

/** A teammate's project, as the routes name it: a share key holds `/` and `#`, so they use its id. */
export type SharedRef = Pick<SharedProject, 'owner' | 'shareId'>;

/** Which agent of a teammate's chat: a subagent, or a workflow agent of `workflowRunId`. */
export type SharedAgentRef = Pick<SharedSubagent, 'agentId' | 'workflowRunId'>;

const sharedPath = (ref: SharedRef) => `/collaborators/shared/${enc(ref.owner)}/${enc(ref.shareId)}`;

export const collaboratorsApi = {
  status: (o: ReadOptions = {}) => request<CollaboratorsStatus>('/collaborators', o),
  groups: (o: ReadOptions = {}) => request<GroupList>('/collaborators/groups', o),
  catalog: (o: ReadOptions = {}) => request<SharedProject[]>('/collaborators/shared', o),
  /** One shared project, as the catalog lists it; 404 once it is no longer shared with this install */
  project: (ref: SharedRef, o: ReadOptions = {}) => request<SharedProject>(sharedPath(ref), o),
  sharing: (projectId: string, o: ReadOptions = {}) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, o),
  putSharing: (projectId: string, body: UpdateProjectSharingRequest) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, { method: 'PUT', body }),
  chats: (ref: SharedRef, o: ReadOptions = {}) => request<SharedChat[]>(`${sharedPath(ref)}/chats`, o),
  /** The latest window, or the one that ends where `before` starts */
  transcript: (ref: SharedRef, chatId: string, before: number | null, o: ReadOptions = {}) =>
    request<SharedTranscriptPage>(`${sharedPath(ref)}/chats/${enc(chatId)}/transcript${before === null ? '' : `?before=${before}`}`, o),
  /** A subagent's transcript, copied with its chat's: the latest window, or the one that ends where `before` starts */
  agentTranscript: (ref: SharedRef, chatId: string, agent: SharedAgentRef, before: number | null, o: ReadOptions = {}) => {
    const query = new URLSearchParams();
    if (agent.workflowRunId) query.set('workflow', agent.workflowRunId);
    if (before !== null) query.set('before', String(before));
    const qs = query.toString();
    return request<SharedAgentTranscriptPage>(`${sharedPath(ref)}/chats/${enc(chatId)}/subagents/${enc(agent.agentId)}${qs ? `?${qs}` : ''}`, o);
  },
  memory: (ref: SharedRef, o: ReadOptions = {}) => request<SharedMemoryFile[]>(`${sharedPath(ref)}/memory`, o),
  documents: (ref: SharedRef, o: ReadOptions = {}) => request<SharedDocument[]>(`${sharedPath(ref)}/documents`, o),
  board: (ref: SharedRef, o: ReadOptions = {}) => request<SharedBoard>(`${sharedPath(ref)}/work-items`, o),
  journal: (ref: SharedRef, o: ReadOptions = {}) => request<JournalEntry[]>(`${sharedPath(ref)}/journal`, o),
  artifacts: (ref: SharedRef, o: ReadOptions = {}) => request<SharedArtifact[]>(`${sharedPath(ref)}/artifacts`, o),
  /** A document's text: the blob is fetched from the owner the first time it is opened, so it is not JSON */
  async blob(ref: SharedRef, sha256: string, o: ReadOptions = {}): Promise<string> {
    return (await blobResponse(ref, sha256, o)).text();
  },
  /** An upload's bytes, with the credential a bare link cannot carry, to be saved by the browser */
  async blobFile(ref: SharedRef, sha256: string, o: ReadOptions = {}): Promise<Blob> {
    return (await blobResponse(ref, sha256, o)).blob();
  },
};

// Through `requestResponse`, so a refused credential or host brings its screen as every other call does
const blobResponse = (ref: SharedRef, sha256: string, o: ReadOptions): Promise<Response> =>
  requestResponse(`${sharedPath(ref)}/blobs/${enc(sha256)}`, { signal: o.signal });

export const collaboratorsKeys = {
  status: ['collaborators', 'status'] as const,
  groups: ['collaborators', 'groups'] as const,
  catalog: ['collaborators', 'shared'] as const,
  sharing: (projectId: string) => ['collaborators', 'sharing', projectId] as const,
  /** One shared project; a prefix of its records' keys, so the same events refresh both */
  project: (ref: SharedRef) => ['collaborators', 'shared', ref.owner, ref.shareId] as const,
  records: (ref: SharedRef, kind: 'chats' | 'memory' | 'journal' | 'documents' | 'artifacts' | 'board') => ['collaborators', 'shared', ref.owner, ref.shareId, kind] as const,
  transcript: (ref: SharedRef, chatId: string) => ['collaborators', 'shared', ref.owner, ref.shareId, 'transcript', chatId] as const,
  agentTranscript: (ref: SharedRef, chatId: string, agent: SharedAgentRef) =>
    ['collaborators', 'shared', ref.owner, ref.shareId, 'transcript', chatId, agent.workflowRunId ?? '', agent.agentId] as const,
  blob: (ref: SharedRef, sha256: string) => ['collaborators', 'blob', ref.owner, ref.shareId, sha256] as const,
};

export const useCollaboratorsStatus = () => useQuery({ queryKey: collaboratorsKeys.status, queryFn: ({ signal }) => collaboratorsApi.status({ signal }), staleTime: 30_000 });

/**
 * The teammates' projects this project's Shared tab shows, and whether that is known yet (an
 * address that opens the tab waits for it instead of being sent back to Resumen). The catalog is
 * a small local read, so it is made whether or not Collaborators is on: the copies outlive the switch.
 */
export function useSharedWith(projectId: string): { projects: SharedProject[]; settled: boolean } {
  const status = useCollaboratorsStatus();
  const available = Boolean(status.data && !status.data.unavailable);
  const catalog = useQuery({ queryKey: collaboratorsKeys.catalog, queryFn: ({ signal }) => collaboratorsApi.catalog({ signal }), enabled: available, staleTime: 30_000 });
  const projects = useMemo(() => sharedWith(projectId, status.data, catalog.data), [projectId, status.data, catalog.data]);
  const settled = status.isError || (status.data !== undefined && (!available || catalog.data !== undefined || catalog.isError));
  return { projects, settled };
}
