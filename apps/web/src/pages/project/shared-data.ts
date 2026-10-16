/**
 * What the Sharing section and the Shared tab read and write (docs/plans/collaborators.md §6). Every
 * query is keyed under `collaborators`, so the `collaborators.*` events mark all of them stale at once
 * (lib/events.ts). A teammate's records are only ever read from here: none of them goes into the
 * person's own chat, task or document queries, so they never mix into their lists, counts or badges.
 */
import type {
  CollaboratorsStatus,
  GroupList,
  ProjectSharing,
  SharedBoard,
  SharedChat,
  SharedDocument,
  SharedMemoryFile,
  SharedProject,
  SharedTranscriptPage,
  UpdateProjectSharingRequest,
} from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import i18n from '../../i18n';
import { ApiRequestError, BASE, enc, request, type ReadOptions } from '../../api';
import { authHeaders } from '../../lib/auth';
import { sharedWith } from '../dashboard/views';

/** A teammate's project, as the routes name it: a share key holds `/` and `#`, so they use its id. */
export type SharedRef = Pick<SharedProject, 'owner' | 'shareId'>;

const sharedPath = (ref: SharedRef) => `/collaborators/shared/${enc(ref.owner)}/${enc(ref.shareId)}`;

export const collaboratorsApi = {
  status: (o: ReadOptions = {}) => request<CollaboratorsStatus>('/collaborators', o),
  groups: (o: ReadOptions = {}) => request<GroupList>('/collaborators/groups', o),
  catalog: (o: ReadOptions = {}) => request<SharedProject[]>('/collaborators/shared', o),
  sharing: (projectId: string, o: ReadOptions = {}) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, o),
  putSharing: (projectId: string, body: UpdateProjectSharingRequest) => request<ProjectSharing>(`/projects/${enc(projectId)}/sharing`, { method: 'PUT', body }),
  chats: (ref: SharedRef, o: ReadOptions = {}) => request<SharedChat[]>(`${sharedPath(ref)}/chats`, o),
  /** The latest window, or the one that ends where `before` starts */
  transcript: (ref: SharedRef, chatId: string, before: number | null, o: ReadOptions = {}) =>
    request<SharedTranscriptPage>(`${sharedPath(ref)}/chats/${enc(chatId)}/transcript${before === null ? '' : `?before=${before}`}`, o),
  memory: (ref: SharedRef, o: ReadOptions = {}) => request<SharedMemoryFile[]>(`${sharedPath(ref)}/memory`, o),
  documents: (ref: SharedRef, o: ReadOptions = {}) => request<SharedDocument[]>(`${sharedPath(ref)}/documents`, o),
  board: (ref: SharedRef, o: ReadOptions = {}) => request<SharedBoard>(`${sharedPath(ref)}/work-items`, o),
  /** A document's text: the blob is fetched from the owner the first time it is opened, so it is not JSON */
  async blob(ref: SharedRef, sha256: string, o: ReadOptions = {}): Promise<string> {
    const res = await fetch(`${BASE}${sharedPath(ref)}/blobs/${enc(sha256)}`, { headers: authHeaders(), signal: o.signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new ApiRequestError(typeof body?.error === 'string' ? body.error : i18n.t('common:httpError', { status: res.status }), res.status);
    }
    return res.text();
  },
};

export const collaboratorsKeys = {
  status: ['collaborators', 'status'] as const,
  groups: ['collaborators', 'groups'] as const,
  catalog: ['collaborators', 'shared'] as const,
  sharing: (projectId: string) => ['collaborators', 'sharing', projectId] as const,
  records: (ref: SharedRef, kind: 'chats' | 'memory' | 'documents' | 'board') => ['collaborators', 'shared', ref.owner, ref.shareId, kind] as const,
  transcript: (ref: SharedRef, chatId: string) => ['collaborators', 'shared', ref.owner, ref.shareId, 'transcript', chatId] as const,
  blob: (ref: SharedRef, sha256: string) => ['collaborators', 'blob', ref.owner, ref.shareId, sha256] as const,
};

export const useCollaboratorsStatus = () => useQuery({ queryKey: collaboratorsKeys.status, queryFn: ({ signal }) => collaboratorsApi.status({ signal }), staleTime: 30_000 });

/**
 * The teammates' projects this project's Shared tab shows, and whether that is known yet (an
 * address that opens the tab waits for it instead of being sent back to Resumen). The catalog is
 * read only while Collaborators is on, so a person who never turned it on costs one small request.
 */
export function useSharedWith(projectId: string): { projects: SharedProject[]; settled: boolean } {
  const status = useCollaboratorsStatus();
  const on = Boolean(status.data?.settings.enabled && !status.data.unavailable);
  const catalog = useQuery({ queryKey: collaboratorsKeys.catalog, queryFn: ({ signal }) => collaboratorsApi.catalog({ signal }), enabled: on, staleTime: 30_000 });
  const projects = useMemo(() => sharedWith(projectId, status.data, catalog.data), [projectId, status.data, catalog.data]);
  const settled = status.isError || (status.data !== undefined && (!on || catalog.data !== undefined || catalog.isError));
  return { projects, settled };
}
