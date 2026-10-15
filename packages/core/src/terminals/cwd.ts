import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { CreateTerminalRequest, TerminalScope } from '@claudio/shared';
import { TerminalError } from './errors.ts';

/** What the service needs to know of the project and chat stores: ids in, paths out */
export interface CwdLookup {
  /** The project's directory and the paths of the worktrees Claudio lists for it; null when there is no such project */
  project(projectId: string): Promise<{ path: string; worktrees: string[] } | null>;
  /** The chat's directory, its worktree if it has one, and the project it belongs to; null when there is no such chat */
  chat(chatId: string): Promise<{ cwd: string; worktree: string | null; projectId: string | null } | null>;
}

export interface ResolvedTerminalCwd {
  scope: TerminalScope;
  cwd: string;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Where a terminal opens. The client never sends a path: a project id (and one of that project's
 * listed worktrees) or a chat id comes in, and the directory comes out. The result is resolved
 * through symlinks and must be the project's directory or one of its worktrees (or inside one), so
 * a symlinked worktree cannot point the shell elsewhere. This confines where Claudio opens a shell,
 * not what the person does with `cd` afterwards.
 */
export async function resolveTerminalCwd(request: CreateTerminalRequest, lookup: CwdLookup): Promise<ResolvedTerminalCwd> {
  let scope: TerminalScope;
  let wanted: string;
  let allowed: { path: string; worktrees: string[] };

  if ('chatId' in request) {
    const chat = request.chatId ? await lookup.chat(request.chatId) : null;
    if (!chat) throw new TerminalError('terminal.not-found', 'No such chat', 404);
    const project = chat.projectId ? await lookup.project(chat.projectId) : null;
    if (!project) throw new TerminalError('terminal.no-project', 'This chat is not in a project, so there is no directory to open a terminal in', 400);
    scope = { kind: 'chat', chatId: request.chatId };
    wanted = chat.worktree ?? chat.cwd;
    allowed = project;
  } else {
    const project = request.projectId ? await lookup.project(request.projectId) : null;
    if (!project) throw new TerminalError('terminal.not-found', 'No such project', 404);
    allowed = project;
    if (request.worktree === undefined) {
      wanted = project.path;
      scope = { kind: 'project', projectId: request.projectId, worktree: null };
    } else {
      // The value must be one of the paths Claudio lists, compared as written, before it is resolved
      if (!project.worktrees.includes(request.worktree)) throw new TerminalError('terminal.bad-cwd', 'That is not a worktree of this project', 400);
      wanted = request.worktree;
      scope = { kind: 'project', projectId: request.projectId, worktree: request.worktree };
    }
  }

  const cwd = real(wanted);
  if (cwd === null || !isDirectory(cwd)) throw new TerminalError('terminal.bad-cwd', 'The directory is gone', 400);
  const projectRoot = real(allowed.path);
  const insideProject = projectRoot !== null && within(cwd, projectRoot);
  // A worktree may live beside the project, but then it must be what its name says: a path that
  // resolves elsewhere through a symlink is not a worktree of this project, whatever it is listed as
  const plainWorktree = cwd === resolve(wanted) && allowed.worktrees.some((path) => resolve(path) === cwd && real(path) === cwd);
  if (!insideProject && !plainWorktree) throw new TerminalError('terminal.bad-cwd', 'The directory is outside the project', 400);
  return { scope, cwd };
}
