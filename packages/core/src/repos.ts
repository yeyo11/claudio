import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { gitAsyncText, watchWorktrees } from './git.ts';

/**
 * Which git repository a directory is in, read from git's own files (gitrepository-layout(5)) with
 * git as the authority when they do not decide. A project is a repository and a subdirectory of it
 * (docs/plans/projects-as-repositories.md, D1-D3); everything that places a chat or a worktree asks
 * here, so no list spawns one git process per directory.
 */
export interface RepoFacts {
  /** git's common directory, real path: the repository's identity on this machine */
  commonDir: string;
  /** The git dir of the checkout `dir` is in; null when the facts come from a record, not the disk */
  gitDir: string | null;
  /** The main checkout's top level; null for a bare repository, or when nothing on disk names it */
  mainCheckout: string | null;
  /** The linked worktree's top level; null in the main checkout */
  worktree: string | null;
  /** The checkout's top level; null in a bare repository or inside a git dir */
  topLevel: string | null;
  /** `dir` relative to `topLevel`, '' at the top level */
  subdir: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/** One of a repository's checkouts, as `git worktree list --porcelain` would list it. */
export interface WorktreeInfo {
  path: string;
  /** The name git gave it under `<commonDir>/worktrees/`; null for the main checkout */
  id: string | null;
  main: boolean;
  bare: boolean;
  branch: string | null;
  detached: boolean;
  /** The lock's reason, '' when locked with none; null when not locked */
  locked: string | null;
  exists: boolean;
  /** git would prune it: its directory or its `gitdir` file is gone, and it is not locked */
  prunable: boolean;
}

/**
 * The only door this module spawns git through, so a test can count the spawns (D9: a warm list
 * spawns none). Never synchronous: a list that waits on a process holds every other request with it.
 */
export const repoGit = { run: (cwd: string, args: string[]): Promise<string> => gitAsyncText(cwd, args, 10_000) };

/** A layout the parser cannot read: git is asked instead. */
const UNDECIDED = Symbol('undecided');
type Parsed = RepoFacts | null | typeof UNDECIDED;

function statOf(path: string) {
  return statSync(path, { throwIfNoEntry: false });
}

/** A file's text, null when it does not exist; any other failure (permissions) throws. */
function textOf(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A directory git would open as a repository: `HEAD` and either `objects` or a `commondir`. */
function isGitDir(dir: string): boolean {
  if (!statOf(join(dir, 'HEAD'))?.isFile()) return false;
  return !!statOf(join(dir, 'objects'))?.isDirectory() || !!statOf(join(dir, 'commondir'))?.isFile();
}

interface CoreConfigFacts {
  bare: boolean;
  /** `core.worktree`: set in a submodule's git dir, where the checkout is not the git dir's parent */
  worktree: string | null;
}

/** The two `[core]` keys that say where a repository's checkout is. Includes are not followed: a repository does not move its checkout through one. */
export function coreConfigOf(commonDir: string): CoreConfigFacts {
  const text = textOf(join(commonDir, 'config')) ?? '';
  const facts: CoreConfigFacts = { bare: false, worktree: null };
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const header = /^\[\s*([^\]\s"]+)[^\]]*\]$/.exec(line);
    if (header) {
      section = header[1]?.toLowerCase() ?? '';
      continue;
    }
    if (section !== 'core') continue;
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!pair) continue;
    const key = pair[1]?.toLowerCase();
    const value = (pair[2] ?? 'true').trim().replace(/^"(.*)"$/, '$1');
    if (key === 'bare') facts.bare = /^(true|yes|on|1)$/i.test(value);
    else if (key === 'worktree') facts.worktree = value || null;
  }
  return facts;
}

/** What a git dir has checked out, from its `HEAD`. */
function headOf(gitDir: string): { branch: string | null; detached: boolean } {
  let head: string | null = null;
  try {
    head = textOf(join(gitDir, 'HEAD'))?.trim() ?? null;
  } catch {
    /* unreadable: nothing to say */
  }
  if (!head) return { branch: null, detached: false };
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length).trim();
    return { branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null, detached: false };
  }
  return { branch: null, detached: /^[0-9a-f]{40,64}$/.test(head) };
}

/**
 * Where a repository's main checkout is, from its common dir alone. git's own list gets two layouts
 * wrong (the spike, `test/fixtures/repos/make.sh`): it names the git dir as the main worktree of a
 * `--separate-git-dir` checkout and of a submodule. A submodule's `core.worktree` names it; for a
 * separate git dir nothing on disk does, and null says so.
 */
function mainCheckoutOf(commonDir: string, config: CoreConfigFacts): string | null {
  if (config.bare) return null;
  if (config.worktree) return realOrSelf(resolve(commonDir, config.worktree));
  return basename(commonDir) === '.git' ? dirname(commonDir) : null;
}

/** The facts once the git dir is known. `top` is the directory whose `.git` led there, null inside a git dir. */
function factsOf(gitDirPath: string, top: string | null, dir: string): Parsed {
  if (!statOf(gitDirPath)?.isDirectory()) return UNDECIDED;
  const gitDir = realpathSync(gitDirPath);
  const pointer = textOf(join(gitDir, 'commondir'))?.trim();
  const commonDir = pointer ? realOrSelf(resolve(gitDir, pointer)) : gitDir;
  if (!statOf(commonDir)?.isDirectory()) return UNDECIDED;
  const config = coreConfigOf(commonDir);
  const linked = gitDir !== commonDir;
  const bare = !linked && config.bare;
  const topLevel = bare || top === null ? null : realOrSelf(top);
  const subdir = topLevel !== null && top !== null && dir !== top ? dir.slice(top.length + 1) : '';
  const { branch, detached } = headOf(gitDir);
  const main = linked ? mainCheckoutOf(commonDir, config) : bare ? null : (topLevel ?? mainCheckoutOf(commonDir, config));
  return { commonDir, gitDir, mainCheckout: main, worktree: linked ? topLevel : null, topLevel, subdir, branch, detached, bare };
}

/**
 * What a walk found for each directory it went through: the checkout's facts and the directory
 * whose `.git` led there (null for none). Shared by the directories of one list, so a thousand
 * directories in fifty repositories read fifty repositories, not a thousand.
 */
export type ParseMemo = Map<string, { facts: Parsed; top: string } | null>;

/** The parser alone: walks up from `dir` to the first `.git` (or git dir), to the filesystem root. */
export function parseRepo(dir: string, memo?: ParseMemo): Parsed {
  const start = resolve(dir);
  const visited: string[] = [];
  const answer = (found: { facts: Parsed; top: string } | null): Parsed => {
    if (memo) for (const v of visited) memo.set(v, found);
    if (!found || found.facts === null || found.facts === UNDECIDED) return found ? found.facts : null;
    const { top } = found;
    // The subdir is the only fact that differs between two directories of one checkout
    const subdir = found.facts.topLevel !== null && start !== top ? start.slice(top.length + 1) : '';
    return { ...found.facts, subdir };
  };
  try {
    for (let current = start; ; ) {
      if (memo?.has(current)) return answer(memo.get(current) ?? null);
      visited.push(current);
      const dotGit = join(current, '.git');
      const info = statOf(dotGit);
      if (info?.isDirectory()) return answer({ facts: factsOf(dotGit, current, current), top: current });
      if (info?.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(textOf(dotGit) ?? '')?.[1]?.trim();
        return answer({ facts: pointer ? factsOf(resolve(current, pointer), current, current) : UNDECIDED, top: current });
      }
      if (!info && isGitDir(current)) return answer({ facts: factsOf(current, null, current), top: current });
      const up = dirname(current);
      if (up === current) return answer(null);
      current = up;
    }
  } catch {
    // An unreadable `.git` or git dir: git decides, with its own rules on what it may open
    return UNDECIDED;
  }
}

/**
 * git's answer, for what the parser cannot decide. A repository git refuses to open
 * (`safe.directory`) is an unknown, undefined, not "no repository".
 */
export async function repoFromGit(dir: string): Promise<RepoFacts | null | undefined> {
  const base = ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir', '--is-bare-repository'];
  let lines: string[];
  try {
    // A bare repository has no top level, and asking for one fails the whole call
    try {
      lines = (await repoGit.run(dir, [...base, '--show-toplevel', '--show-prefix'])).split('\n');
    } catch (err) {
      if (/not a git repository/i.test(String((err as Error).message))) return null;
      lines = (await repoGit.run(dir, base)).split('\n');
    }
  } catch (err) {
    return /not a git repository/i.test(String((err as Error).message)) ? null : undefined;
  }
  const [common = '', gitDirLine = '', bareLine = '', top = '', prefix = ''] = lines;
  if (!common || !gitDirLine) return undefined;
  const commonDir = realOrSelf(common);
  const gitDir = realOrSelf(gitDirLine);
  const config = coreConfigOf(commonDir);
  const bare = bareLine === 'true';
  const linked = gitDir !== commonDir;
  const topLevel = bare || !top ? null : realOrSelf(top);
  const { branch, detached } = headOf(gitDir);
  return {
    commonDir,
    gitDir,
    mainCheckout: linked ? mainCheckoutOf(commonDir, config) : bare ? null : (topLevel ?? mainCheckoutOf(commonDir, config)),
    worktree: linked ? topLevel : null,
    topLevel,
    subdir: prefix.replace(/\/$/, ''),
    branch,
    detached,
    bare,
  };
}

/** The repository `dir` is in: null when it is in none, undefined when git would not say. */
export async function repoOf(dir: string): Promise<RepoFacts | null | undefined> {
  const parsed = parseRepo(dir);
  return parsed === UNDECIDED ? repoFromGit(dir) : parsed;
}

/** Bytes, not locale: git sorts its list by path the same way. */
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Every checkout of a repository, the main one first, from `<commonDir>/worktrees/*`. `mainHint` is
 * the main checkout when the caller knows it and the files do not (a `--separate-git-dir` checkout);
 * without either, the main entry is left out rather than guessed.
 */
export function worktreesOf(commonDir: string, mainHint: string | null = null): WorktreeInfo[] {
  const config = coreConfigOf(commonDir);
  const out: WorktreeInfo[] = [];
  if (config.bare) {
    out.push({ path: commonDir, id: null, main: true, bare: true, branch: null, detached: false, locked: null, exists: true, prunable: false });
  } else {
    const main = mainCheckoutOf(commonDir, config) ?? mainHint;
    if (main) out.push({ path: main, id: null, main: true, bare: false, ...headOf(commonDir), locked: null, exists: !!statOf(main)?.isDirectory(), prunable: false });
  }
  const admin = join(commonDir, 'worktrees');
  let ids: string[] = [];
  try {
    ids = readdirSync(admin);
  } catch {
    /* no linked worktrees */
  }
  const linked: WorktreeInfo[] = [];
  for (const id of ids) {
    const meta = join(admin, id);
    if (!statOf(meta)?.isDirectory()) continue;
    let pointer: string | null = null;
    let lock: string | null = null;
    try {
      pointer = textOf(join(meta, 'gitdir'))?.trim() || null;
      lock = textOf(join(meta, 'locked'));
    } catch {
      continue;
    }
    // The `gitdir` file names the worktree's `.git`, absolute or relative to this directory
    const dotGit = pointer ? resolve(meta, pointer) : null;
    const path = dotGit ? dirname(dotGit) : meta;
    const exists = !!statOf(path)?.isDirectory();
    const locked = lock === null ? null : lock.trim();
    linked.push({
      path: exists ? realOrSelf(path) : path,
      id,
      main: false,
      bare: false,
      ...headOf(meta),
      locked,
      exists,
      prunable: locked === null && (!dotGit || !statOf(dotGit)),
    });
  }
  return [...out, ...linked.sort(byPath)];
}

/** Where a bare repository is imported from: the folder that holds `.bare` or `.git`, else the git dir itself (D11). */
export function bareImportPath(commonDir: string): string {
  const name = basename(commonDir);
  return name === '.bare' || name === '.git' ? dirname(commonDir) : commonDir;
}

/**
 * A remote URL without what would sign in with it: the `user:password@` of a URL, and the user of
 * an http one, where it is a token more often than a name. `git@host:path` keeps its user, which is
 * the SSH login every host documents.
 */
export function stripCredentials(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*@)?(.*)$/i.exec(url);
  if (!scheme) return url;
  const [, protocol = '', userinfo = '', rest = ''] = scheme;
  if (!userinfo) return url;
  const keep = !/^https?$/i.test(protocol) && !userinfo.includes(':');
  return `${protocol}://${keep ? userinfo : ''}${rest}`;
}

/**
 * A remote as `host/path`, so two clones of one repository compare equal however each was cloned:
 * scheme, credentials, the SSH user, a trailing `.git` or `/` and the host's case dropped.
 */
export function normalizeRemote(url: string): string {
  let rest = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(.*)$/i.exec(rest);
  if (scheme) rest = scheme[1] ?? '';
  else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(rest);
    if (scp) rest = `${scp[1] ?? ''}/${scp[2] ?? ''}`;
  }
  rest = rest.replace(/\/+$/, '').replace(/\.git$/, '');
  const slash = rest.indexOf('/');
  const host = (slash < 0 ? rest : rest.slice(0, slash)).replace(/:\d+$/, '').toLowerCase();
  return slash < 0 ? host : `${host}${rest.slice(slash)}`;
}

/**
 * `remote.origin.url` from `<commonDir>/config` itself, so a list starts no process for it; undefined
 * when the file has includes or quoting git would read differently, and git has to answer.
 */
export function originUrlOf(commonDir: string): string | null | undefined {
  let text: string | null;
  try {
    text = textOf(join(commonDir, 'config'));
  } catch {
    return undefined;
  }
  if (text === null) return null;
  let inOrigin = false;
  let url: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (/^\[\s*include(If)?\b/i.test(line)) return undefined;
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const pair = /^url\s*=\s*(.*)$/i.exec(line);
    if (!pair) continue;
    const value = (pair[1] ?? '').trim();
    // A comment, a quote or an escape is git's syntax to read, not ours
    if (/["\\#;]/.test(value)) return undefined;
    // A key set more than once is git's to settle
    if (url !== null) return undefined;
    url = value || null;
  }
  return url;
}

/** `remote.origin.url`, credentials stripped; null without an origin. Read from the file, else one git process. */
export async function remoteOf(commonDir: string): Promise<string | null> {
  const read = originUrlOf(commonDir);
  if (read !== undefined) return read ? stripCredentials(read) : null;
  return remoteFromGit(commonDir);
}

/** What git reads as `remote.origin.url` from a config the reader leaves to it (includes, quoting). */
async function remoteFromGit(commonDir: string): Promise<string | null> {
  try {
    const url = await repoGit.run(commonDir, ['config', '--file', join(commonDir, 'config'), '--get', 'remote.origin.url']);
    return url ? stripCredentials(url) : null;
  } catch {
    return null;
  }
}

// ---------- placements remembered ----------

/** Where a placement came from, strongest first: what git's files said, git itself, the CLI's record, the CLI's layout. */
export type PlaceSource = 'disk' | 'git' | 'cli-record' | 'layout';

export interface PlaceRow {
  dir: string;
  commonDir: string | null;
  mainCheckout: string | null;
  worktree: string | null;
  subdir: string;
  branch: string | null;
  source: PlaceSource;
  seenAt: string;
  goneAt: string | null;
}

const SOURCES: readonly PlaceSource[] = ['disk', 'git', 'cli-record', 'layout'];
const SOURCE_RANK: Record<PlaceSource, number> = { disk: 2, git: 2, 'cli-record': 1, layout: 0 };
const rank = (column: string) => `CASE ${column} WHEN 'disk' THEN 2 WHEN 'git' THEN 2 WHEN 'cli-record' THEN 1 ELSE 0 END`;

/**
 * `repo_places`: one row per directory a chat or a run has used (D4). Rows accumulate and two
 * processes share them, so they are rows, upserted as idempotent facts; none is ever deleted, which
 * is how a chat in a removed worktree keeps its project.
 */
export class RepoPlaces {
  private readonly db: DatabaseSync;
  private readonly getStmt: StatementSync;
  private readonly upsertStmt: StatementSync;
  private readonly goneStmt: StatementSync;
  private readonly mainStmt: StatementSync;
  /**
   * Writes waiting for the next tick: a cold list places a thousand directories, and a commit each
   * is a disk sync each (seconds). They go in one transaction, and reads see them before it.
   */
  private readonly pending = new Map<string, PlaceRow>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.getStmt = db.prepare('SELECT * FROM repo_places WHERE dir = ?');
    // A weaker source never overwrites a stronger one: once a worktree is gone, a guess from the
    // path must not replace what its own files said while it was there
    this.upsertStmt = db.prepare(
      `INSERT INTO repo_places (dir, common_dir, main_checkout, worktree, subdir, branch, source, seen_at, gone_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dir) DO UPDATE SET
         common_dir = excluded.common_dir, main_checkout = excluded.main_checkout, worktree = excluded.worktree,
         subdir = excluded.subdir, branch = excluded.branch, source = excluded.source, seen_at = excluded.seen_at,
         gone_at = excluded.gone_at
       WHERE ${rank('excluded.source')} >= ${rank('repo_places.source')}`,
    );
    this.goneStmt = db.prepare('UPDATE repo_places SET gone_at = ? WHERE dir = ? AND gone_at IS NULL');
    this.mainStmt = db.prepare(
      'SELECT main_checkout FROM repo_places WHERE common_dir = ? AND worktree IS NULL AND main_checkout IS NOT NULL ORDER BY seen_at DESC LIMIT 1',
    );
  }

  get(dir: string): PlaceRow | null {
    const waiting = this.pending.get(dir);
    if (waiting) return waiting;
    const row = this.getStmt.get(dir) as Record<string, string | null> | undefined;
    if (!row) return null;
    const source = SOURCES.find((s) => s === row.source) ?? 'layout';
    return {
      dir: row.dir ?? dir,
      commonDir: row.common_dir ?? null,
      mainCheckout: row.main_checkout ?? null,
      worktree: row.worktree ?? null,
      subdir: row.subdir ?? '',
      branch: row.branch ?? null,
      source,
      seenAt: row.seen_at ?? '',
      goneAt: row.gone_at ?? null,
    };
  }

  /** Upserts on the next tick, with every other write of this one, in one transaction. */
  upsert(row: PlaceRow): void {
    // The same rule the SQL applies, so what `get` answers before the flush is what it will hold after
    const current = this.get(row.dir);
    if (current && SOURCE_RANK[row.source] < SOURCE_RANK[current.source]) return;
    this.pending.set(row.dir, row);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 0);
      this.flushTimer.unref();
    }
  }

  /** Writes what is waiting now; a failure is logged, never thrown at a list. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.size) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    try {
      this.db.exec('BEGIN');
      try {
        for (const row of rows) this.upsertStmt.run(row.dir, row.commonDir, row.mainCheckout, row.worktree, row.subdir, row.branch, row.source, row.seenAt, row.goneAt);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      // A placement is a cache of git's answer: the next list places these directories again
      console.warn(`repo_places: ${rows.length} placements were not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Records the first time a directory was found missing; a later look leaves that instant alone. */
  markGone(dir: string, at: string): void {
    const waiting = this.pending.get(dir);
    if (waiting) {
      waiting.goneAt ??= at;
      return;
    }
    try {
      this.goneStmt.run(at, dir);
    } catch {
      /* the next look marks it */
    }
  }

  /** The main checkout a repository was last seen with, for a layout whose files do not name it. */
  mainCheckoutOf(commonDir: string): string | null {
    for (const row of this.pending.values()) if (row.commonDir === commonDir && !row.worktree && row.mainCheckout) return row.mainCheckout;
    return ((this.mainStmt.get(commonDir) as { main_checkout?: string } | undefined)?.main_checkout ?? null) || null;
  }
}

// ---------- the index ----------

/** Where a directory belongs (D3). `source` is null when nothing placed it. */
export interface Place {
  repo: RepoFacts | null;
  exists: boolean;
  source: PlaceSource | null;
}

/** The CLI's `worktree-state` record of a session it ran in a worktree it created. */
export interface WorktreeRecord {
  path: string;
  /** `originalCwd`: where the person started; often a worktree itself, so never trusted as the repository */
  parentPath: string;
  name: string | null;
  branch: string | null;
}

/** `<X>/.claude/worktrees/<name>`, where `claude --worktree` puts them; lazy, so X is the leftmost. */
const CLI_LAYOUT = /^(.+?)\/\.claude\/worktrees\/[^/]+/;
/** The deepest `.claude/worktrees/<name>` of a path: the worktree itself when one is nested in another */
const CLI_LAYOUT_DEEPEST = /^(.+\/\.claude\/worktrees\/[^/]+)/;
const PLACE_TTL_MS = 60_000;
const WORKTREES_TTL_MS = 30_000;
const REMOTE_TTL_MS = 5 * 60_000;
/** How many placements a gone directory may lean on before it is given up as unknown */
const MAX_HOPS = 4;

const NOWHERE: Place = { repo: null, exists: false, source: null };

/**
 * Placements, cached per directory and remembered in `repo_places` (D3, D4, D9): a list resolves
 * each distinct directory once, and a directory removed since keeps the repository it was in.
 */
export class RepoIndex {
  private readonly places: RepoPlaces | null;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; place: Place }>();
  private readonly records = new Map<string, WorktreeRecord>();
  private readonly lists = new Map<string, { at: number; list: WorktreeInfo[] }>();
  private readonly remotes = new Map<string, { at: number; remote: string | null }>();
  private readonly configs = new Map<string, { at: number; config: CoreConfigFacts }>();
  private readonly reals = new Map<string, { at: number; real: string }>();
  /** What git is being asked, per directory or common dir: a list never waits for it, the next one reads its answer */
  private readonly asking = new Map<string, Promise<void>>();
  /** What the walks of the last minute found, shared by the directories of one list */
  private memo: { at: number; walks: ParseMemo } | null = null;

  constructor(opts: { places?: RepoPlaces | null; now?: () => number } = {}) {
    this.places = opts.places ?? null;
    this.now = opts.now ?? Date.now;
    // Every place Claudio adds or removes a worktree says so (`worktreesChanged`), and the next read sees it
    watchWorktrees(this);
  }

  /** Remembers a worktree the CLI recorded in a transcript. */
  learn(record: WorktreeRecord): void {
    const known = this.records.get(record.path);
    if (known && known.parentPath === record.parentPath && known.branch === record.branch) return;
    this.records.set(record.path, record);
    // A gone directory placed before the record arrived would otherwise keep its weaker answer
    for (const [dir, hit] of this.cache) if (!hit.place.exists && (dir === record.path || dir.startsWith(`${record.path}/`))) this.cache.delete(dir);
  }

  /** The record of the worktree that holds `dir`, the deepest when several do. */
  recordOf(dir: string): WorktreeRecord | null {
    let best: WorktreeRecord | null = null;
    for (const r of this.records.values()) {
      if ((dir === r.path || dir.startsWith(`${r.path}/`)) && r.path.length > (best?.path.length ?? 0)) best = r;
    }
    return best;
  }

  private walks(): ParseMemo {
    if (!this.memo || this.now() - this.memo.at >= PLACE_TTL_MS) this.memo = { at: this.now(), walks: new Map() };
    return this.memo.walks;
  }

  invalidate(): void {
    this.cache.clear();
    this.memo = null;
    this.lists.clear();
    this.configs.clear();
    this.reals.clear();
  }

  /** Resolves once git has answered every question asked in the background: what a test waits on instead of a clock. */
  async settled(): Promise<void> {
    while (this.asking.size) await Promise.allSettled([...this.asking.values()]);
  }

  /** Asks git once per key at a time, off the request that needed it. */
  private ask(key: string, work: () => Promise<void>): void {
    if (this.asking.has(key)) return;
    const asked = work()
      .catch(() => undefined)
      .finally(() => this.asking.delete(key));
    this.asking.set(key, asked);
  }

  /** `bare` and `core.worktree` of a repository, read from its config at most every half minute. */
  configOf(commonDir: string): CoreConfigFacts {
    const hit = this.configs.get(commonDir);
    if (hit && this.now() - hit.at < WORKTREES_TTL_MS) return hit.config;
    const config = coreConfigOf(commonDir);
    this.configs.set(commonDir, { at: this.now(), config });
    return config;
  }

  /** A path with its links resolved, as it was a minute ago at most: a list compares hundreds of them. */
  real(path: string): string {
    const hit = this.reals.get(path);
    if (hit && this.now() - hit.at < PLACE_TTL_MS) return hit.real;
    const real = realOrSelf(path);
    this.reals.set(path, { at: this.now(), real });
    return real;
  }

  /** Writes the placements still waiting, before the database closes. */
  flush(): void {
    this.places?.flush();
  }

  place(dir: string, record?: WorktreeRecord | null): Place {
    if (record) this.learn(record);
    return this.resolve(resolve(dir), 0);
  }

  private resolve(dir: string, hops: number): Place {
    const hit = this.cache.get(dir);
    if (hit && (!hit.place.exists || this.now() - hit.at < PLACE_TTL_MS)) return hit.place;
    if (hops > MAX_HOPS) return NOWHERE;
    const place = statOf(dir)?.isDirectory() ? this.onDisk(dir) : this.gone(dir, hops);
    this.cache.set(dir, { at: this.now(), place });
    return place;
  }

  private onDisk(dir: string): Place {
    const parsed = parseRepo(dir, this.walks());
    if (parsed !== UNDECIDED) return this.settle(dir, parsed, 'disk');
    // Only git can say, and a list never waits for a process: what git said last time is served
    // meanwhile, and its answer replaces it for the next list
    this.ask(dir, async () => {
      const facts = await repoFromGit(dir);
      // git would not say: an unknown is not written down as "no repository"
      if (facts === undefined) return;
      this.cache.set(dir, { at: this.now(), place: this.settle(dir, facts, 'git') });
    });
    const row = this.places?.get(dir) ?? null;
    if (row && row.source !== 'layout') return { repo: row.commonDir ? fromRow(row) : null, exists: true, source: row.source };
    return { repo: null, exists: true, source: null };
  }

  private settle(dir: string, facts: RepoFacts | null, source: PlaceSource): Place {
    const repo = facts && !facts.mainCheckout && !facts.bare ? { ...facts, mainCheckout: this.places?.mainCheckoutOf(facts.commonDir) ?? null } : facts;
    this.remember(dir, repo, source, null);
    return { repo, exists: true, source };
  }

  private gone(dir: string, hops: number): Place {
    const at = new Date(this.now()).toISOString();
    const row = this.places?.get(dir) ?? null;
    if (row) this.places?.markGone(dir, at);
    if (row && row.source !== 'layout') return { repo: row.commonDir ? fromRow(row) : null, exists: false, source: row.source };

    const record = this.recordOf(dir);
    if (record && record.path !== record.parentPath) {
      const parent = this.resolve(resolve(record.parentPath), hops + 1).repo;
      if (parent) {
        const top = record.path;
        const repo: RepoFacts = {
          commonDir: parent.commonDir,
          gitDir: null,
          mainCheckout: parent.mainCheckout,
          worktree: parent.mainCheckout === top ? null : top,
          topLevel: top,
          subdir: dir === top ? '' : dir.slice(top.length + 1),
          branch: record.branch,
          detached: false,
          bare: false,
        };
        this.remember(dir, repo, 'cli-record', at);
        return { repo, exists: false, source: 'cli-record' };
      }
    }

    const layout = CLI_LAYOUT.exec(dir);
    const top = CLI_LAYOUT_DEEPEST.exec(dir)?.[1];
    if (layout?.[1] && top) {
      const parent = this.resolve(layout[1], hops + 1).repo;
      if (parent) {
        const repo: RepoFacts = {
          commonDir: parent.commonDir,
          gitDir: null,
          mainCheckout: parent.mainCheckout,
          worktree: top,
          topLevel: top,
          subdir: dir === top ? '' : dir.slice(top.length + 1),
          // Removed without `git worktree remove`, git still lists it (prunable), branch and all
          branch: this.worktreesOf(parent.commonDir, parent.mainCheckout).find((w) => w.path === top)?.branch ?? null,
          detached: false,
          bare: false,
        };
        this.remember(dir, repo, 'layout', at);
        return { repo, exists: false, source: 'layout' };
      }
    }
    if (row) return { repo: row.commonDir ? fromRow(row) : null, exists: false, source: row.source };
    return NOWHERE;
  }

  private remember(dir: string, repo: RepoFacts | null, source: PlaceSource, goneAt: string | null): void {
    if (!this.places) return;
    const row: PlaceRow = {
      dir,
      commonDir: repo?.commonDir ?? null,
      mainCheckout: repo?.mainCheckout ?? null,
      worktree: repo?.worktree ?? null,
      subdir: repo?.subdir ?? '',
      branch: repo?.branch ?? null,
      source,
      seenAt: new Date(this.now()).toISOString(),
      goneAt,
    };
    const stored = this.places.get(dir);
    // Written only when a fact changed: a list re-reads hundreds of directories a minute
    if (
      stored &&
      stored.commonDir === row.commonDir &&
      stored.mainCheckout === row.mainCheckout &&
      stored.worktree === row.worktree &&
      stored.subdir === row.subdir &&
      stored.branch === row.branch &&
      stored.source === row.source &&
      (stored.goneAt === null) === (goneAt === null)
    ) {
      return;
    }
    try {
      this.places.upsert(row);
    } catch (err) {
      // A placement is a cache of git's answer: failing to write it down must not fail a list
      console.warn(`repo_places: ${dir} was not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The repository's checkouts (cached 30 s, and forgotten whenever Claudio adds or removes one). */
  worktreesOf(commonDir: string, mainHint: string | null = null): WorktreeInfo[] {
    const hit = this.lists.get(commonDir);
    if (hit && this.now() - hit.at < WORKTREES_TTL_MS) return hit.list;
    const list = worktreesOf(commonDir, mainHint ?? this.places?.mainCheckoutOf(commonDir) ?? null);
    this.lists.set(commonDir, { at: this.now(), list });
    return list;
  }

  /**
   * origin's URL, credentials stripped: read from the config file. What the file leaves to git (an
   * include, quoting) is asked in the background, and the last answer, or none, is served meanwhile.
   */
  remoteOf(commonDir: string): string | null {
    const hit = this.remotes.get(commonDir);
    if (hit && this.now() - hit.at < REMOTE_TTL_MS) return hit.remote;
    const read = originUrlOf(commonDir);
    if (read === undefined) {
      this.ask(`remote:${commonDir}`, async () => {
        const remote = await remoteFromGit(commonDir);
        this.remotes.set(commonDir, { at: this.now(), remote });
      });
      return hit?.remote ?? null;
    }
    const remote = read ? stripCredentials(read) : null;
    this.remotes.set(commonDir, { at: this.now(), remote });
    return remote;
  }
}

function fromRow(row: PlaceRow): RepoFacts {
  const top = row.worktree ?? (row.mainCheckout && row.subdir ? row.dir.slice(0, row.dir.length - row.subdir.length - 1) : row.mainCheckout);
  return {
    commonDir: row.commonDir ?? '',
    gitDir: null,
    mainCheckout: row.mainCheckout,
    worktree: row.worktree,
    topLevel: top,
    subdir: row.subdir,
    branch: row.branch,
    detached: false,
    bare: false,
  };
}
