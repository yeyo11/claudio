/*
 * The spawn-time overlay of a shared account (D5 of docs/plans/account-configuration-and-project-rules.md,
 * section 6.4): what the default account's state file holds as configuration, and links cannot
 * carry, handed to another account's process through documented flags. `--mcp-config` (never
 * strict, S4) carries the default's user servers, the project's local servers and, when the default
 * trusts the project, its `.mcp.json` servers, less the ones turned off; the `.mcp.json` approvals
 * the CLI also reads from settings go into the one `--settings` file (S3f).
 *
 * The state file is a file the CLI writes, read here and never written. Its key names are not a
 * contract: a shape this reader does not know yields no overlay and one log line, and the test pins
 * the shapes read. Nothing here logs a server's definition: they carry headers and tokens.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ServerMap = Record<string, Record<string, unknown>>;

/** What one `projects[<path>]` entry of the state file says, as the overlay reads it */
export interface ProjectState {
  trusted: boolean;
  localServers: ServerMap;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  /** Turned off with `/mcp` for this project, whatever the server's scope */
  disabledMcpServers: string[];
  enableAllProjectMcpServers: boolean;
  /** S7: per state file, and no documented setting or flag supplies it */
  externalIncludesApproved: boolean;
}

/** The configuration part of a state file */
export interface StateConfig {
  userServers: ServerMap;
  projects: Map<string, ProjectState>;
}

/** The settings keys of the overlay: documented user settings the `--settings` layer accepts */
export interface OverlaySettings {
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
}

export interface Overlay {
  /** For `--mcp-config`: local over project over user, as the CLI ranks a repeated name */
  mcpServers: ServerMap;
  settings: OverlaySettings;
  /** The state-file key the project relies on that no flag can carry, for a log line */
  unsupplied: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function serverMap(value: unknown, where: string): ServerMap {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ShapeError(`${where} is not an object`);
  const out: ServerMap = {};
  for (const [name, server] of Object.entries(value)) {
    if (!isRecord(server)) throw new ShapeError(`${where}.${name} is not an object`);
    out[name] = server;
  }
  return out;
}

function names(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new ShapeError(`${where} is not a list of names`);
  return value as string[];
}

function flag(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ShapeError(`${where} is not a boolean`);
  return value;
}

export class ShapeError extends Error {}

/**
 * The configuration keys of a parsed state file. Throws `ShapeError` on a key whose shape changed:
 * a guess at a renamed or restructured key could hand a process servers its owner turned off.
 */
export function readStateConfig(doc: unknown): StateConfig {
  if (!isRecord(doc)) throw new ShapeError('the state file is not an object');
  const userServers = serverMap(doc.mcpServers, 'mcpServers');
  const projects = new Map<string, ProjectState>();
  if (doc.projects !== undefined) {
    if (!isRecord(doc.projects)) throw new ShapeError('projects is not an object');
    for (const [path, entry] of Object.entries(doc.projects)) {
      if (!isRecord(entry)) throw new ShapeError(`projects entry is not an object`);
      projects.set(path, {
        trusted: flag(entry.hasTrustDialogAccepted, 'hasTrustDialogAccepted'),
        localServers: serverMap(entry.mcpServers, 'project mcpServers'),
        enabledMcpjsonServers: names(entry.enabledMcpjsonServers, 'enabledMcpjsonServers'),
        disabledMcpjsonServers: names(entry.disabledMcpjsonServers, 'disabledMcpjsonServers'),
        disabledMcpServers: names(entry.disabledMcpServers, 'disabledMcpServers'),
        enableAllProjectMcpServers: flag(entry.enableAllProjectMcpServers, 'enableAllProjectMcpServers'),
        externalIncludesApproved: flag(entry.hasClaudeMdExternalIncludesApproved, 'hasClaudeMdExternalIncludesApproved'),
      });
    }
  }
  return { userServers, projects };
}

/** Where `.git` sits above `dir`, and what it is; null outside a repository */
function gitOf(dir: string): { root: string; dotGit: string } | null {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const dotGit = join(at, '.git');
    try {
      statSync(dotGit);
      return { root: at, dotGit };
    } catch {
      // not here
    }
    if (dirname(at) === at) return null;
  }
}

/**
 * The key of `projects` the CLI uses for a working directory: the repository's main checkout, a
 * linked worktree included (S3d: a worktree of a trusted checkout is trusted, its parent dir is
 * not), else the directory itself.
 */
export function projectKeyOf(cwd: string): string {
  const git = gitOf(cwd);
  if (!git) return resolve(cwd);
  let text: string;
  try {
    text = readFileSync(git.dotGit, 'utf8');
  } catch {
    // A directory: this is the main checkout
    return git.root;
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!gitdir) return git.root;
  const target = resolve(git.root, gitdir);
  // `<main>/.git/worktrees/<name>`; a submodule's `.git/modules/…` is its own project
  const worktree = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(target);
  return worktree?.[1] ?? git.root;
}

/**
 * The `.mcp.json` servers a process started in `cwd` reads, from `cwd` up to the top of its
 * checkout, the nearer file winning a repeated name. A file that does not parse adds nothing, as
 * the CLI's own reader would not load it either.
 */
export function readProjectServers(cwd: string): { servers: ServerMap; files: string[] } {
  const top = gitOf(cwd)?.root ?? resolve(cwd);
  const dirs: string[] = [];
  for (let at = resolve(cwd); ; at = dirname(at)) {
    dirs.push(at);
    if (at === top || dirname(at) === at) break;
  }
  const servers: ServerMap = {};
  const files: string[] = [];
  for (const dir of dirs.reverse()) {
    const file = join(dir, '.mcp.json');
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    files.push(file);
    if (!isRecord(doc)) continue;
    try {
      Object.assign(servers, serverMap(doc.mcpServers, '.mcp.json mcpServers'));
    } catch {
      // a hand-written file with a broken entry: the CLI reports it, the overlay carries none of it
    }
  }
  return { servers, files };
}

const without = (servers: ServerMap, off: ReadonlySet<string>): ServerMap =>
  Object.fromEntries(Object.entries(servers).filter(([name]) => !off.has(name)));

/**
 * The overlay for a process in `cwd`, from the default's state configuration and the project's
 * `.mcp.json` servers. Project servers ride along only when the default trusts the project: the
 * person decided so there, and a flag-given server skips the trust check (S3e).
 */
export function buildOverlay(state: StateConfig, cwd: string, projectServers: ServerMap): Overlay {
  const project = state.projects.get(projectKeyOf(cwd));
  const off = new Set([...(project?.disabledMcpServers ?? []), ...(project?.disabledMcpjsonServers ?? [])]);
  const mcpServers = {
    ...without(state.userServers, off),
    ...(project?.trusted ? without(projectServers, off) : {}),
    ...without(project?.localServers ?? {}, off),
  };
  const settings: OverlaySettings = {};
  if (project) {
    if (project.enabledMcpjsonServers.length) settings.enabledMcpjsonServers = [...project.enabledMcpjsonServers];
    // The project's own file is still read by the account's CLI: what the person turned off there stays off
    const disabled = [...new Set([...project.disabledMcpjsonServers, ...project.disabledMcpServers.filter((name) => name in projectServers)])];
    if (disabled.length) settings.disabledMcpjsonServers = disabled;
    if (project.enableAllProjectMcpServers) settings.enableAllProjectMcpServers = true;
  }
  return { mcpServers, settings, unsupplied: project?.externalIncludesApproved ? ['hasClaudeMdExternalIncludesApproved'] : [] };
}

export const isEmptyOverlay = (overlay: Overlay): boolean => Object.keys(overlay.mcpServers).length === 0 && Object.keys(overlay.settings).length === 0;

export interface McpOverlayOptions {
  /** The default account's state file (`~/.claude.json` for `~/.claude`) */
  stateFile: string;
  log?: (message: string) => void;
}

const stampOf = (file: string): string => {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
};

/** Derived overlays kept per working directory; a person has a handful of projects */
const MAX_CACHED = 64;

/**
 * The overlays of one default state file, derived once per change of that file and of the
 * project's `.mcp.json` files (mtime and size, as `cliLogin` does): a spawn with nothing changed
 * reads no file but a `stat` per input.
 */
export class McpOverlay {
  private state: { stamp: string; config: StateConfig | null } | null = null;
  private readonly derived = new Map<string, { stamp: string; overlay: Overlay | null }>();
  private readonly said = new Set<string>();

  constructor(private readonly opts: McpOverlayOptions) {}

  private say(message: string): void {
    if (this.said.has(message)) return;
    this.said.add(message);
    this.opts.log?.(message);
  }

  private stateConfig(stamp: string): StateConfig | null {
    if (this.state?.stamp === stamp) return this.state.config;
    let config: StateConfig | null = null;
    if (stamp !== 'absent') {
      try {
        config = readStateConfig(JSON.parse(readFileSync(this.opts.stateFile, 'utf8')));
      } catch (error) {
        // Mid-write by the CLI, or a shape this reader does not know: no overlay rather than a wrong one
        this.say(`accounts: the default state file gives no overlay for shared accounts: ${error instanceof ShapeError ? `its shape changed (${error.message})` : 'it does not parse'}`);
      }
    }
    this.state = { stamp, config };
    return config;
  }

  /** The overlay for a process of a shared account in `cwd`; null when there is nothing to add */
  for(cwd: string): Overlay | null {
    const stateStamp = stampOf(this.opts.stateFile);
    const config = this.stateConfig(stateStamp);
    if (!config) return null;
    const key = resolve(cwd);
    const project = readProjectServersStamped(key);
    const stamp = `${stateStamp}|${project.stamp}`;
    const hit = this.derived.get(key);
    if (hit?.stamp === stamp) return hit.overlay;
    const built = buildOverlay(config, key, readProjectServers(key).servers);
    for (const item of built.unsupplied) this.say(`accounts: ${projectKeyOf(key)} relies on ${item} in the default's state file, which no flag can give a shared account`);
    const overlay = isEmptyOverlay(built) ? null : built;
    if (this.derived.size >= MAX_CACHED) this.derived.delete(this.derived.keys().next().value ?? '');
    this.derived.set(key, { stamp, overlay });
    return overlay;
  }
}

/** The stamps of every `.mcp.json` a process in `cwd` would read, without reading them */
function readProjectServersStamped(cwd: string): { stamp: string } {
  const top = gitOf(cwd)?.root ?? cwd;
  const parts: string[] = [];
  for (let at = cwd; ; at = dirname(at)) {
    parts.push(stampOf(join(at, '.mcp.json')));
    if (at === top || dirname(at) === at) break;
  }
  return { stamp: parts.join(',') };
}
