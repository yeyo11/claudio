import type { Project, ProjectModule, ProjectTemplate, ProjectTemplateId } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, keys, useProjectCandidates } from '../../api';
import { deriveKeyPrefix, folderNameFor, prefixProblem } from './model';

export type Source = 'local' | 'git';
export const STEPS = ['origin', 'template', 'modules', 'summary'] as const;
export type Step = (typeof STEPS)[number];

/** The last part of a path or a repository URL, which is what the project is called unless renamed. */
function baseName(value: string): string {
  const parts = value.trim().replace(/[/\\]+$/, '').replace(/\.git$/, '').split(/[/\\:]/);
  return parts[parts.length - 1] ?? '';
}

export interface Draft {
  source: Source;
  name: string;
  path: string;
  gitUrl: string;
  /** The prefix the person typed; null while it follows the name */
  prefix: string | null;
  template: ProjectTemplateId;
  modules: ProjectModule[];
  /** Hand the new project to the assistant, which proposes its team, resources and first tasks */
  propose: boolean;
}

/** A value that follows `value` after it has held still for `ms`: typing a path asks the server once, not per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setHeld(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return held;
}

const INSPECT_DEBOUNCE_MS = 300;

/** Everything the wizard's screens read from one draft, worked out once. */
export function useWizard(draft: Draft, templates: ProjectTemplate[] | undefined, projects: Project[] | undefined) {
  const candidates = useProjectCandidates().data;
  // What the typed path is, before Import: a repository, a worktree of one, or already a project
  const typed = draft.source === 'local' ? draft.path.trim() : '';
  const asked = useDebounced(typed, INSPECT_DEBOUNCE_MS);
  const inspected = useQuery({ queryKey: keys.projectInspect(asked), queryFn: ({ signal }) => api.inspectProject(asked, { signal }), enabled: asked !== '' && asked === typed, retry: false });
  // A stale answer for a path since edited says nothing about the one on screen. Compared with what
  // was asked, not the answer's `path`: the server resolves it, so a trailing slash would never match
  const inspection = typed !== '' && asked === typed ? (inspected.data ?? null) : null;
  const taken = useMemo(() => new Set((projects ?? []).map((p) => p.key)), [projects]);
  const name = draft.name.trim() || baseName(draft.source === 'git' ? draft.gitUrl : draft.path);
  const prefix = draft.prefix ?? deriveKeyPrefix(name, taken);
  const problem = draft.prefix === null ? null : prefixProblem(prefix, taken);
  const template = templates?.find((tpl) => tpl.id === draft.template);
  const candidate = draft.source === 'local' ? candidates?.find((c) => c.path === draft.path.trim()) : undefined;
  const where = draft.source === 'git' ? draft.gitUrl.trim() : draft.path.trim();
  // A new directory (created or cloned) is named after the project, as far as a folder name allows;
  // the project keeps the name as typed. Importing takes the directory as it is.
  const makesFolder = draft.source === 'git' || !draft.path.trim();
  const folder = makesFolder ? folderNameFor(name) : null;
  const folderProblem = makesFolder && name && !folder ? 'empty' : null;
  // Creating needs a name; importing takes the directory's; cloning needs its URL
  const originReady = draft.source === 'git' ? !!draft.gitUrl.trim() && !!name : !!name;
  return {
    candidates: candidates ?? [],
    name,
    prefix,
    problem,
    template,
    candidate,
    where,
    folder,
    folderProblem,
    inspection,
    ready: originReady && problem === null && folderProblem === null && !inspection?.conflict,
  };
}

export type Wizard = ReturnType<typeof useWizard>;
