import type { CollaboratorsStatus, ProjectModule, SharedProject } from '@claudio/shared';

/**
 * A project's own tabs, each at `/?view=<id>`, in the order the strip draws them after Resumen (the
 * dashboard, which has no `view`).
 */
export const PROJECT_VIEWS = ['board', 'team', 'documents', 'memory', 'shared', 'resources', 'worktrees', 'settings'] as const;

export type ProjectViewId = (typeof PROJECT_VIEWS)[number];

/**
 * The module a tab belongs to: it exists only while that module is on. Shared has a gate of its own
 * (`sharedWith`), and the others are always there.
 */
export const VIEW_MODULE: Partial<Record<ProjectViewId, ProjectModule>> = { board: 'board', team: 'team', documents: 'documents', memory: 'memory' };

export const asProjectView = (value: string | null): ProjectViewId | null => PROJECT_VIEWS.find((id) => id === value) ?? null;

/**
 * The teammates' projects shown in this project's Shared tab, while Collaborators is on. A project
 * linked by hand shows in the project it was linked to and nowhere else; one that is not linked
 * shows in every local project whose default key is its share key (two clones show it twice).
 */
export function sharedWith(projectId: string, status: Pick<CollaboratorsStatus, 'settings' | 'unavailable'> | undefined, catalog: readonly SharedProject[] | undefined): SharedProject[] {
  if (!status?.settings.enabled || status.unavailable || !catalog) return [];
  return catalog.filter((shared) => (shared.linkedProjectId === null ? shared.matches.includes(projectId) : shared.linkedProjectId === projectId));
}

/**
 * The tabs a project with these modules shows. `shared` is whether a teammate shares this project
 * with the person now (`sharedWith` found any): the Shared tab exists only then.
 */
export function projectViews(modules: readonly ProjectModule[], shared = false): ProjectViewId[] {
  return PROJECT_VIEWS.filter((id) => {
    if (id === 'shared') return shared;
    const module = VIEW_MODULE[id];
    return module === undefined || modules.includes(module);
  });
}

/**
 * `?tab=` is what the page used before it was a dashboard, and links to it live in bookmarks and in
 * other pages: its values that are still screens become `?view=`, `activity` (now the dashboard
 * itself) is dropped. The rest of the query, the section and the project, is kept. `null` when
 * there is nothing to redirect.
 */
export function legacyTabRedirect(params: URLSearchParams): string | null {
  const tab = params.get('tab');
  if (tab === null) return null;
  const next = new URLSearchParams(params);
  next.delete('tab');
  const view = asProjectView(tab);
  if (view && !next.has('view')) next.set('view', view);
  const query = next.toString();
  return query ? `?${query}` : '';
}
