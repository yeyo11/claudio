import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvailableAgent, InstalledPlugin } from '@claudio/shared';
import { agentsDefinitionFile } from './agents-file.ts';
import { projectScope, userScope } from './config/scope.ts';
import type { ConfigResources } from './config/resources.ts';
import { ChatStartRefusal } from './confined-chat.ts';
import type { CoreConfig } from './paths.ts';
import { readFrontmatter, readFrontmatterList } from './team.ts';

const FILE_RE = /^[\w.-]{1,128}\.md$/;
const PLUGINS_TTL_MS = 60_000;
const PLUGINS_WAIT_MS = 5_000;

/** What a chat starts with when it is given an agent: the CLI flag's value, and the definition that replaces the file's */
export interface AgentLaunch {
  agent: string;
  /** `--agents`: set for a user or project agent, whose file may say more than a chat may do; a plugin agent needs none */
  agentsFile?: string;
}

export interface AgentCatalogDeps {
  config: CoreConfig;
  resources: () => ConfigResources;
  /** The plugins the CLI lists; an error reads as none, since a missing CLI is not the agents' fault */
  plugins: () => Promise<InstalledPlugin[]>;
}

interface Found {
  agent: AvailableAgent;
  content: string;
  model: string | null;
}

function describe(content: string, name: string, source: AvailableAgent['source'], plugin: string | null): Found {
  const fields = readFrontmatter(content);
  const model = fields.model && fields.model !== 'inherit' ? fields.model : null;
  return {
    agent: { name, description: fields.description || null, source, plugin, tools: readFrontmatterList(content, 'tools') },
    content,
    model,
  };
}

/**
 * The agents a chat started in a folder can run as: the ones `claude --agent` resolves there (the
 * folder's `.claude/agents`, the account's, and the enabled plugins'), read from the files the CLI
 * itself reads. A project's agent wins over a user's of the same name, as in the CLI.
 *
 * Starting a chat as an agent never widens it (docs/plans/start-chat-agent.md): a user or project
 * agent runs from a definition Claudio rewrites with the prompt, model and tool lists only, so what
 * its frontmatter says of `permissionMode`, `mcpServers` and `hooks` is never applied; the CLI
 * itself ignores those three for a plugin agent.
 */
export class AgentCatalog {
  private pluginCache: { at: number; plugins: InstalledPlugin[] } | null = null;

  constructor(private readonly deps: AgentCatalogDeps) {}

  /**
   * The CLI's plugin list, which starts a process: kept for a moment, and given a few seconds, so a
   * CLI that is slow or missing delays a chat's start once and not at every start. A plugin
   * installed since is seen from the next minute.
   */
  private async plugins(): Promise<InstalledPlugin[]> {
    if (this.pluginCache && Date.now() - this.pluginCache.at < PLUGINS_TTL_MS) return this.pluginCache.plugins;
    let timer: NodeJS.Timeout | undefined;
    const plugins = await Promise.race([
      this.deps.plugins().catch(() => []),
      new Promise<InstalledPlugin[]>((done) => {
        timer = setTimeout(() => done([]), PLUGINS_WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    this.pluginCache = { at: Date.now(), plugins };
    return plugins;
  }

  private async filesOf(dir: string): Promise<Array<{ file: string; content: string }>> {
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((e) => e.isFile() && FILE_RE.test(e.name));
    const read = await Promise.all(files.map(async (e) => ({ file: e.name.slice(0, -3), content: await readFile(join(dir, e.name), 'utf8').catch(() => null) })));
    return read.flatMap((r) => (r.content === null ? [] : [{ file: r.file, content: r.content }]));
  }

  private async found(folder: string): Promise<Found[]> {
    const resources = this.deps.resources();
    const [project, user, plugins] = await Promise.all([
      resources.list(projectScope(folder), 'agents'),
      resources.list(userScope(this.deps.config), 'agents'),
      this.plugins(),
    ]);
    const own = (items: typeof project, source: 'project' | 'user'): Found[] =>
      items.map((r) => describe(r.content, readFrontmatter(r.content).name || r.name, source, null));
    const fromPlugins = await Promise.all(
      plugins
        .filter((p) => p.enabled && p.installPath)
        .map(async (p) =>
          (await this.filesOf(join(p.installPath ?? '', 'agents'))).map(({ file, content }) => describe(content, `${p.name}:${readFrontmatter(content).name || file}`, 'plugin', p.name)),
        ),
    );
    const byName = new Map<string, Found>();
    // Project first: the first of a name is the one the CLI runs
    for (const f of [...own(project, 'project'), ...own(user, 'user'), ...fromPlugins.flat()]) if (!byName.has(f.agent.name)) byName.set(f.agent.name, f);
    return [...byName.values()].sort((a, b) => a.agent.name.localeCompare(b.agent.name));
  }

  /** The agents of a folder, as `GET /projects/:id/agents` lists them */
  async list(folder: string): Promise<AvailableAgent[]> {
    return (await this.found(folder)).map((f) => f.agent);
  }

  /**
   * What starts a chat in `folder` as the agent `name`. An unknown name is `400 agent-unknown` with
   * the valid ones in its message, so a caller does not guess.
   */
  async launch(folder: string, name: string): Promise<AgentLaunch> {
    const found = await this.found(folder);
    const hit = found.find((f) => f.agent.name === name);
    if (!hit) {
      const names = found.map((f) => f.agent.name);
      throw new ChatStartRefusal(`no agent named '${name}' is available in this folder${names.length ? ` (available: ${names.join(', ')})` : ': none is defined'}`, 400, 'agent-unknown');
    }
    if (hit.agent.source === 'plugin') return { agent: name };
    // The same directory the flow's definitions go to: the one place `ChatService.create` accepts an `--agents` file from
    const agentsFile = await agentsDefinitionFile(hit.content, name, hit.model, join(this.deps.config.dataDir, 'flow-agents'));
    return { agent: name, agentsFile };
  }
}
