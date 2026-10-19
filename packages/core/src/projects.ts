import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ChatProject, ProjectCandidate, ProjectPathConflict } from '@claudio/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';
import { bareImportPath, coreConfigOf, type Place } from './repos.ts';

/** The repository a project lives in, as `projects.json` keeps it: what identifies it, and its remote. */
export interface ProjectRepoRecord {
  /** git's common directory, real path */
  commonDir: string;
  /** The project's directory relative to its checkout's top level, '' at the root */
  subdir: string;
  remote: string | null;
}

/** What Claudio keeps about a project: an id of its own, a name, where it lives and its repository. */
export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  /** null for a directory in no repository (or one missing when it was last resolved) */
  repo: ProjectRepoRecord | null;
}

/** A chat reduced to what deciding its project needs: the directory it works in and when it last moved. */
export interface ChatPlace {
  cwd: string;
  updatedAt: string | null;
}

/** What placing a path and naming its remote takes: `RepoIndex` in core, a stub in a test. */
export interface RepoLookup {
  place(dir: string): Place;
  remoteOf(commonDir: string): string | null;
}

/** How many directories are offered on the first start. */
const CANDIDATES = 8;
const DOCUMENT_VERSION = 2;

const inside = (root: string, dir: string): boolean => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);

/** `''` holds everything; otherwise the subdir itself and what is under it. */
const subdirHolds = (root: string, subdir: string): boolean => root === '' || subdir === root || subdir.startsWith(`${root}/`);

/** The deepest project whose directory holds `dir`, so a project nested in another wins for what is under it. */
function deepest(projects: readonly ProjectRecord[], dir: string): ProjectRecord | undefined {
  let best: ProjectRecord | undefined;
  for (const p of projects) {
    if (inside(p.path, dir) && p.path.length > (best?.path.length ?? -1)) best = p;
  }
  return best;
}

/**
 * Decides which project a directory belongs to, or none: a chat whose directory is under no
 * imported project is loose.
 *
 * In a repository a project of that repository owns it, wherever the checkout is on disk: the one
 * whose subdir holds the directory's, the longest when two do (a monorepo). A repository that has a
 * project but none whose subdir holds it leaves the directory loose, never to another project that
 * happens to contain the path. Outside any imported repository, and for a directory in none, the
 * directory counts by where it is, as it always has.
 */
export function attachProject(projects: readonly ProjectRecord[], dir: string, place: Place): ProjectRecord | null {
  const repo = place.repo;
  if (repo) {
    const same = projects.filter((p) => p.repo?.commonDir === repo.commonDir);
    if (same.length) {
      let best: ProjectRecord | null = null;
      for (const p of same) {
        const sub = p.repo?.subdir ?? '';
        if (subdirHolds(sub, repo.subdir) && sub.length > (best?.repo?.subdir.length ?? -1)) best = p;
      }
      return best;
    }
  }
  return deepest(projects, dir) ?? null;
}

/**
 * Directories chats have run in that are not imported, the busiest first. A worktree counts for its
 * repository's main checkout, and scratch directories under the OS temp dir or that no longer exist
 * are left out.
 */
export function projectCandidates(
  projects: readonly ProjectRecord[],
  chats: readonly ChatPlace[],
  placeOf: (dir: string) => Place,
  limit = CANDIDATES,
): ProjectCandidate[] {
  const byPath = new Map<string, { count: number; last: string | null }>();
  for (const chat of chats) {
    if (!chat.cwd) continue;
    const place = placeOf(chat.cwd);
    if (attachProject(projects, chat.cwd, place)) continue;
    const path = place.repo?.mainCheckout ?? chat.cwd;
    if (!path || isTemporaryPath(path)) continue;
    const seen = byPath.get(path) ?? { count: 0, last: null };
    seen.count += 1;
    if (chat.updatedAt && (!seen.last || chat.updatedAt > seen.last)) seen.last = chat.updatedAt;
    byPath.set(path, seen);
  }
  return [...byPath]
    .filter(([path]) => isDirectory(path))
    .map(([path, { count, last }]) => ({ path, name: basename(path) || path, chatCount: count, lastActivity: last }))
    .sort((a, b) => b.chatCount - a.chatCount || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function isTemporaryPath(path: string): boolean {
  const tmp = tmpdir();
  return path === tmp || path.startsWith(`${tmp}/`) || path.startsWith('/tmp/') || path.startsWith('/var/tmp/');
}

/** A path as the filesystem sees it, falling back to the literal path when it does not exist. */
const realOrSelf = (path: string): Promise<string> => realpath(path).catch(() => path);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Why a path cannot be imported, or a project cannot be re-pointed at it (D7, D12). */
export type ProjectPathCode = 'not-a-directory' | 'not-a-repository' | 'linked-worktree' | 'other-repository' | 'already-a-project';

/**
 * A refusal the API answers as it is: `statusCode` and `reason` (the `code` a client words) are
 * what its error handler reads, and `detail` names what the refusal points at (the path to import
 * instead, or the project that already is one).
 */
export class ProjectPathError extends Error {
  readonly statusCode: 400 | 409;
  readonly reason: ProjectPathCode;
  readonly detail: string | undefined;

  constructor(code: ProjectPathCode, message: string, detail?: string) {
    super(message);
    this.reason = code;
    this.statusCode = code === 'already-a-project' ? 409 : 400;
    this.detail = detail;
  }
}

/** The repository's own name for a person: its main checkout's, else the folder it is imported from. */
const repoNameOf = (path: string): string => basename(path) || path;

/** What a path would be imported as: the path to record, its repository, and why not, if it cannot. */
export interface ImportTarget {
  path: string;
  exists: boolean;
  place: Place;
  importPath: string;
  repo: ProjectRepoRecord | null;
  /** The main checkout, null for a bare repository or when nothing names it */
  mainCheckout: string | null;
  bare: boolean;
  conflict: ProjectPathConflict | null;
}

const recordsKey = (r: { commonDir: string; subdir: string }) => `${r.commonDir}\0${r.subdir}`;

/**
 * The directories the person imported, in `projects.json`. A settings-shaped document: small, edited
 * whole and read in full on every start. It is held in memory because everything that places a
 * chat or a run asks it, and it changes only through this class.
 */
export class ProjectStore {
  private readonly file: string;
  private readonly configDir: string;
  private records: ProjectRecord[];

  /** `lookup` resolves the records an older document has no repository for; without it they keep none. */
  constructor(config: CoreConfig, lookup: RepoLookup | null = null) {
    this.file = join(config.dataDir, 'projects.json');
    this.configDir = resolve(config.configDir);
    mkdirSync(dirname(this.file), { recursive: true });
    this.records = this.read(lookup);
  }

  /**
   * The document, migrated on the way in (D5): a record with no repository is resolved from its path,
   * and the document is written once, atomically, when that changed anything. A path that is missing
   * now keeps `repo: null` and is tried again on the next start; nothing is dropped or moved, and an
   * older Claudio still reads the file, ignoring the keys it does not know.
   */
  private read(lookup: RepoLookup | null): ProjectRecord[] {
    if (!existsSync(this.file)) return [];
    let doc: { version?: unknown; projects?: unknown };
    try {
      doc = JSON.parse(readFileSync(this.file, 'utf8')) as typeof doc;
    } catch {
      // A document that does not parse would otherwise be overwritten by the next import
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
    if (!Array.isArray(doc.projects)) return [];
    let changed = doc.version !== DOCUMENT_VERSION;
    const records: ProjectRecord[] = [];
    for (const raw of doc.projects as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.path !== 'string') continue;
      let repo = parseRepoRecord(p.repo);
      if (!repo && lookup) {
        repo = resolveRepo(p.path, lookup);
        if (repo || !('repo' in p)) changed = true;
      }
      records.push({ id: p.id, name: p.name, path: p.path, repo });
    }
    if (changed && lookup) {
      try {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, serialize(records));
        renameSync(tmp, this.file);
      } catch (err) {
        // In memory the records are migrated all the same; the next start tries the write again
        console.warn(`projects: ${this.file} was not migrated: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return records;
  }

  private save(): Promise<void> {
    return writeAtomic(this.file, serialize(this.records));
  }

  list(): readonly ProjectRecord[] {
    return this.records;
  }

  get(id: string): ProjectRecord | undefined {
    return this.records.find((p) => p.id === id);
  }

  /** The project a repository and subdir already are, or a path is, other than `exceptId`. */
  private holder(path: string, repo: ProjectRepoRecord | null, exceptId?: string): ProjectRecord | undefined {
    return this.records.find((p) => p.id !== exceptId && (p.path === path || (!!repo && !!p.repo && recordsKey(p.repo) === recordsKey(repo))));
  }

  /**
   * What importing `path` would record, and the conflict that stops it (D7): a path anywhere inside
   * a linked worktree names its main checkout instead, and a repository and subdir already imported
   * names that project. Nothing is written.
   */
  target(input: string, lookup: RepoLookup): ImportTarget {
    const path = resolve(input);
    const place = lookup.place(path);
    const exists = isDirectory(path);
    const facts = place.repo;
    if (!facts) {
      const held = this.holder(path, null);
      return { path, exists, place, importPath: path, repo: null, mainCheckout: null, bare: false, conflict: held ? alreadyProject(held) : null };
    }
    const bare = facts.bare || (facts.worktree !== null && facts.mainCheckout === null && coreConfigOf(facts.commonDir).bare);
    const mainCheckout = facts.mainCheckout;
    if (facts.worktree) {
      const importPath = mainCheckout ? join(mainCheckout, facts.subdir) : bareImportPath(facts.commonDir);
      return {
        path,
        exists,
        place,
        importPath,
        repo: null,
        mainCheckout,
        bare,
        conflict: { kind: 'linked-worktree', importPath, repoName: repoNameOf(mainCheckout ?? bareImportPath(facts.commonDir)) },
      };
    }
    const importPath = facts.bare ? bareImportPath(facts.commonDir) : path;
    const repo = { commonDir: facts.commonDir, subdir: facts.bare ? '' : facts.subdir, remote: null };
    const held = this.holder(importPath, repo);
    return { path, exists, place, importPath, repo, mainCheckout, bare, conflict: held ? alreadyProject(held) : null };
  }

  /**
   * Imports a directory. A path inside a linked worktree is refused (it belongs to its repository,
   * and importing it would make the same work appear twice), and so is a repository and subdir that
   * already is a project. A directory that is, or holds, the Claude configuration directory is
   * refused too: its project root would be the real `~/.claude`, whose credentials and transcripts
   * the config explorer hides for exactly that reason.
   *
   * `idFor` hands back the id the directory, or its repository and subdir, had when it was last a
   * project, so what Claudio keeps under that id (its settings, its work items) comes back with it.
   */
  async add(
    input: { path: string; name?: string },
    lookup: RepoLookup,
    idFor: (path: string, repo: ProjectRepoRecord | null) => string | null = () => null,
  ): Promise<ProjectRecord> {
    if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('path is required');
    const target = this.target(input.path.trim(), lookup);
    if (!target.exists) throw new ProjectPathError('not-a-directory', `${target.path} is not a directory`);
    throwConflict(target);
    const path = target.importPath;
    await this.refuseConfigDir(path);
    const repo = target.repo ? { ...target.repo, remote: lookup.remoteOf(target.repo.commonDir) } : null;
    const previous = idFor(path, repo);
    const id = previous && !this.get(previous) ? previous : randomUUID();
    const record: ProjectRecord = { id, name: this.cleanName(input.name) ?? (basename(path) || path), path, repo };
    this.records = [...this.records, record];
    await this.save();
    return record;
  }

  private async refuseConfigDir(path: string): Promise<void> {
    const [real, realConfigDir] = await Promise.all([realOrSelf(path), realOrSelf(this.configDir)]);
    if (inside(real, realConfigDir)) {
      throw new Error(`${path} is or contains the Claude configuration directory ${this.configDir}; importing it would expose the account credentials`);
    }
  }

  /**
   * What re-pointing a project at `input` would make of its record (D12), every check made and
   * nothing written: the project must be in a repository (its own, or for a path gone since, where
   * its placement says), and the new path must be a directory of that same repository's main
   * checkout that no other project is. The id stays, so its chats, settings and work items do too.
   */
  async planRepoint(id: string, input: unknown, lookup: RepoLookup): Promise<ProjectRecord> {
    const project = this.get(id);
    if (!project) throw new Error('project not found');
    if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a directory');
    const commonDir = project.repo?.commonDir ?? lookup.place(project.path).repo?.commonDir ?? null;
    if (!commonDir) throw new ProjectPathError('not-a-repository', `${project.name} is not in a git repository; only a repository's project can be re-pointed`);
    const path = resolve(input.trim());
    if (!isDirectory(path)) throw new ProjectPathError('not-a-directory', `${path} is not a directory`);
    const facts = lookup.place(path).repo;
    if (!facts || facts.commonDir !== commonDir) throw new ProjectPathError('other-repository', `${path} is not in the repository of ${project.name}`);
    if (facts.worktree) {
      const main = facts.mainCheckout ? join(facts.mainCheckout, facts.subdir) : bareImportPath(commonDir);
      throw new ProjectPathError('linked-worktree', `${path} is inside a linked worktree; point the project at ${main} instead`, main);
    }
    const target = facts.bare ? bareImportPath(commonDir) : path;
    const repo: ProjectRepoRecord = { commonDir, subdir: facts.bare ? '' : facts.subdir, remote: project.repo?.remote ?? lookup.remoteOf(commonDir) };
    const held = this.holder(target, repo, id);
    if (held) throw new ProjectPathError('already-a-project', `${target} is already the project ${held.name}`, held.id);
    await this.refuseConfigDir(target);
    return { ...project, path: target, repo };
  }

  /** Writes a record `planRepoint` made. */
  async replace(record: ProjectRecord): Promise<void> {
    if (!this.get(record.id)) throw new Error('project not found');
    this.records = this.records.map((p) => (p.id === record.id ? record : p));
    await this.save();
  }

  async rename(id: string, name: string): Promise<ProjectRecord> {
    const project = this.get(id);
    if (!project) throw new Error('project not found');
    const clean = this.cleanName(name);
    if (!clean) throw new Error('name is required');
    const renamed = { ...project, name: clean };
    this.records = this.records.map((p) => (p.id === id ? renamed : p));
    await this.save();
    return renamed;
  }

  /** Forgets the project. Nothing on disk changes, and importing it again adopts its chats again. */
  async remove(id: string): Promise<void> {
    if (!this.get(id)) throw new Error('project not found');
    this.records = this.records.filter((p) => p.id !== id);
    await this.save();
  }

  private cleanName(name: string | undefined): string | null {
    const clean = name?.trim();
    return clean ? clean.slice(0, 100) : null;
  }
}

const alreadyProject = (p: ProjectRecord): ProjectPathConflict => ({ kind: 'already-a-project', project: { id: p.id, name: p.name } satisfies ChatProject });

function throwConflict(target: ImportTarget): void {
  const conflict = target.conflict;
  if (conflict?.kind === 'linked-worktree') {
    throw new ProjectPathError('linked-worktree', `${target.path} is inside a git worktree of ${conflict.repoName}; import ${conflict.importPath} instead`, conflict.importPath);
  }
  if (conflict?.kind === 'already-a-project') {
    throw new ProjectPathError('already-a-project', `${target.importPath} is already a project: ${conflict.project.name}`, conflict.project.id);
  }
}

function parseRepoRecord(value: unknown): ProjectRepoRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.commonDir !== 'string' || !r.commonDir || typeof r.subdir !== 'string') return null;
  return { commonDir: r.commonDir, subdir: r.subdir, remote: typeof r.remote === 'string' ? r.remote : null };
}

/** The repository of a path that exists, for the migration; a missing one is tried again later. */
function resolveRepo(path: string, lookup: RepoLookup): ProjectRepoRecord | null {
  const place = lookup.place(path);
  if (!place.exists || !place.repo) return null;
  return { commonDir: place.repo.commonDir, subdir: place.repo.bare ? '' : place.repo.subdir, remote: lookup.remoteOf(place.repo.commonDir) };
}

const serialize = (records: readonly ProjectRecord[]): string => `${JSON.stringify({ version: DOCUMENT_VERSION, projects: records }, null, 2)}\n`;
