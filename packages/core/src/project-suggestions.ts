import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ChatProject, ProjectCandidate } from '@claudio/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';
import { attachProject, type ChatPlace, type ProjectRecord, type RepoLookup } from './projects.ts';
import { bareImportPath, normalizeRemote, stripCredentials } from './repos.ts';

/** How many repositories, and how many plain directories, are offered. */
const REPOSITORIES = 8;
const DIRECTORIES = 5;

/**
 * Where Claudio keeps what is not a project, so no directory there is ever offered (D8): every
 * input is injected, so a test can place them anywhere.
 */
export interface SuggestionExclusions {
  home: string;
  /** This install's workspace: never offered itself, its children are fine */
  workspaceDir: string;
  /** Claudio's own directories: nothing at or under them is offered */
  inside: string[];
  /** The OS scratch directories */
  temp: string[];
  /** The workspace roots of the other installs of Claudio, which are not repositories */
  otherWorkspaces: string[];
  /** `$XDG_DATA_HOME`: the `workspace` folder of any app directly under it is another install's */
  dataHome: string;
}

export function suggestionExclusions(
  config: Pick<CoreConfig, 'workspaceDir' | 'configDir' | 'dataDir'>,
  lanesDir: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): SuggestionExclusions {
  return {
    home,
    workspaceDir: resolve(config.workspaceDir),
    inside: [config.configDir, config.dataDir, lanesDir].map((d) => resolve(d)),
    temp: [tmpdir(), '/tmp', '/var/tmp'],
    otherWorkspaces: [join(home, 'Claudio', 'workspace'), join(home, 'Agentry', 'workspace'), '/workspace'],
    dataHome: resolve(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')),
  };
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Never offered, repository or not: scratch, `$HOME` and everything above it (`/` included), this workspace itself, Claudio's own directories. */
function never(x: SuggestionExclusions, path: string): boolean {
  if (x.temp.some((t) => within(t, path))) return true;
  if (within(path, x.home) || path === x.workspaceDir) return true;
  return x.inside.some((d) => within(d, path));
}

/** A plain directory that is another Claudio's workspace: `~/Claudio/workspace`, `$XDG_DATA_HOME/<app>/workspace`. */
function otherWorkspace(x: SuggestionExclusions, path: string): boolean {
  if (x.otherWorkspaces.includes(path)) return true;
  return basename(path) === 'workspace' && dirname(dirname(path)) === x.dataHome;
}

interface Group {
  /** What a hide records: the common dir, or the path of a plain directory */
  key: string;
  path: string;
  commonDir: string | null;
  chats: number;
  last: string | null;
  worktrees: Set<string>;
}

const candidate = (g: Group, kind: ProjectCandidate['kind'], remote: string | null, sameRemoteAs: ChatProject | null): ProjectCandidate => ({
  key: g.key,
  kind,
  path: g.path,
  name: basename(g.path) || g.path,
  remote,
  chatCount: g.chats,
  worktreeCount: g.worktrees.size,
  lastActivity: g.last,
  sameRemoteAs,
});

/**
 * What a first start offers to import, from the chats that belong to no project (D8). Chats are
 * grouped by the repository they are placed in, so a repository with chats in fourteen worktrees is
 * one suggestion; a repository that already has a project is never offered, even for the chats
 * outside that project's subdir. Directories in no repository form a second, short group. Noise is
 * left out (`$HOME`, workspace roots, Claudio's own directories, scratch, a directory that is gone
 * or that holds a known repository), and so is any key the person hid.
 */
export function projectCandidates(
  projects: readonly ProjectRecord[],
  chats: readonly ChatPlace[],
  lookup: RepoLookup,
  x: SuggestionExclusions,
  hidden: ReadonlySet<string> = new Set(),
): ProjectCandidate[] {
  const owned = new Set(projects.flatMap((p) => (p.repo ? [p.repo.commonDir] : [])));
  const repos = new Map<string, Group>();
  const dirs = new Map<string, Group>();
  /** Every checkout seen: a folder that holds one is where repositories live, not a project */
  const checkouts = new Set<string>(projects.flatMap((p) => (p.repo ? [p.path] : [])));

  for (const chat of chats) {
    if (!chat.cwd) continue;
    const place = lookup.place(chat.cwd);
    const repo = place.repo;
    if (repo?.mainCheckout) checkouts.add(repo.mainCheckout);
    if (attachProject(projects, chat.cwd, place)) continue;
    // Git would not say (`safe.directory`): an unknown is neither a repository nor "not a git repository"
    if (!repo && place.exists && place.source === null) continue;
    if (repo && owned.has(repo.commonDir)) continue;

    let group: Group | undefined;
    if (repo) {
      group = repos.get(repo.commonDir);
      if (!group) {
        const path = repo.bare ? bareImportPath(repo.commonDir) : (repo.mainCheckout ?? (repo.worktree ? '' : (repo.topLevel ?? '')));
        group = { key: repo.commonDir, path, commonDir: repo.commonDir, chats: 0, last: null, worktrees: new Set() };
        repos.set(repo.commonDir, group);
      }
      if (repo.worktree) group.worktrees.add(repo.worktree);
    } else {
      group = dirs.get(chat.cwd) ?? { key: chat.cwd, path: chat.cwd, commonDir: null, chats: 0, last: null, worktrees: new Set() };
      dirs.set(chat.cwd, group);
    }
    group.chats += 1;
    if (chat.updatedAt && (!group.last || chat.updatedAt > group.last)) group.last = chat.updatedAt;
  }

  const order = (a: Group, b: Group) => b.chats - a.chats || (b.last ?? '').localeCompare(a.last ?? '') || a.path.localeCompare(b.path);
  const projectOfRemote = new Map<string, ChatProject>();
  for (const p of projects) if (p.repo?.remote) projectOfRemote.set(normalizeRemote(p.repo.remote), { id: p.id, name: p.name });

  const offered: ProjectCandidate[] = [];
  const repositories = [...repos.values()]
    .filter((g) => g.path && !hidden.has(g.key) && !never(x, g.path) && isDirectory(g.path))
    .sort(order)
    .slice(0, REPOSITORIES);
  for (const g of repositories) {
    // Core strips credentials where it reads the remote; once more costs nothing and keeps the promise here
    const raw = g.commonDir ? lookup.remoteOf(g.commonDir) : null;
    const remote = raw ? stripCredentials(raw) : null;
    offered.push(candidate(g, 'repository', remote, (remote && projectOfRemote.get(normalizeRemote(remote))) || null));
  }

  const holdsRepository = (path: string) => [...checkouts].some((c) => c !== path && within(path, c));
  const directories = [...dirs.values()]
    .filter((g) => !hidden.has(g.key) && !never(x, g.path) && !otherWorkspace(x, g.path) && isDirectory(g.path) && !holdsRepository(g.path))
    .sort(order)
    .slice(0, DIRECTORIES);
  for (const g of directories) offered.push(candidate(g, 'directory', null, null));
  return offered;
}

interface SuggestionsDocument {
  hidden: { key: string; at: string }[];
}

/**
 * The suggestions a person hid, in `data/project-suggestions.json`: a settings-shaped document, read
 * from the file each time so a second process sees a hide at once. A key is a repository's common
 * directory, or the path of a directory in none.
 */
export class ProjectSuggestions {
  private readonly file: string;
  /** Serialises this process's writes: the file is replaced whole */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(config: Pick<CoreConfig, 'dataDir'>) {
    this.file = join(config.dataDir, 'project-suggestions.json');
  }

  private read(): SuggestionsDocument {
    if (!existsSync(this.file)) return { hidden: [] };
    try {
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { hidden?: unknown };
      const list: unknown[] = Array.isArray(doc.hidden) ? doc.hidden : [];
      return {
        hidden: list.flatMap((h) => {
          const entry = h as { key?: unknown; at?: unknown } | null;
          return entry && typeof entry.key === 'string' ? [{ key: entry.key, at: typeof entry.at === 'string' ? entry.at : '' }] : [];
        }),
      };
    } catch {
      // A list nobody can read must not stop the suggestions; the next hide replaces it
      return { hidden: [] };
    }
  }

  hidden(): Set<string> {
    return new Set(this.read().hidden.map((h) => h.key));
  }

  hide(key: string): Promise<void> {
    return this.change((doc) => (doc.hidden.some((h) => h.key === key) ? doc : { hidden: [...doc.hidden, { key, at: new Date().toISOString() }] }));
  }

  unhide(key: string): Promise<void> {
    return this.change((doc) => (doc.hidden.some((h) => h.key === key) ? { hidden: doc.hidden.filter((h) => h.key !== key) } : doc));
  }

  private change(apply: (doc: SuggestionsDocument) => SuggestionsDocument): Promise<void> {
    const next = this.writing.then(async () => {
      const before = this.read();
      const after = apply(before);
      if (after !== before) await writeAtomic(this.file, `${JSON.stringify(after, null, 2)}\n`);
    });
    this.writing = next.catch(() => undefined);
    return next;
  }
}

/** A suggestion's key from a request body: a non-empty string, else a 400. */
export function candidateKey(key: unknown): string {
  if (typeof key !== 'string' || !key.trim()) throw Object.assign(new Error('key is required'), { statusCode: 400 });
  return key;
}
