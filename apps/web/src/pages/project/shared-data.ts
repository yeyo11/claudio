/**
 * Which teammates' projects a project shows in its Shared tab (docs/plans/collaborators.md §6). The
 * reads themselves go through the web's one Collaborators client, `lib/api/collaborators.ts`.
 */
import type { SharedProject } from '@claudio/shared';
import { useMemo } from 'react';
import { useCollaboratorsStatus, useSharedProjects } from '../../lib/api/collaborators';
import { sharedWith } from '../dashboard/views';

/**
 * The teammates' projects this project's Shared tab shows, and whether that is known yet (an
 * address that opens the tab waits for it instead of being sent back to Resumen). The catalog is
 * a small local read, so it is made whether or not Collaborators is on: the copies outlive the switch.
 */
export function useSharedWith(projectId: string): { projects: SharedProject[]; settled: boolean } {
  const status = useCollaboratorsStatus();
  const available = Boolean(status.data && !status.data.unavailable);
  const catalog = useSharedProjects(available);
  const projects = useMemo(() => sharedWith(projectId, status.data, catalog.data), [projectId, status.data, catalog.data]);
  const settled = status.isError || (status.data !== undefined && (!available || catalog.data !== undefined || catalog.isError));
  return { projects, settled };
}
