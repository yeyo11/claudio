import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { InstalledPlugin } from '@claudio/shared';
import { AgentCatalog } from '../src/agent-catalog.ts';
import { ConfigResources } from '../src/config/resources.ts';
import { ChatStartRefusal } from '../src/confined-chat.ts';
import { tempConfig } from './helpers.ts';

// The agents a chat can start as, and what starting as one is allowed to carry. Everything is a file
// in a temporary config dir, project and plugin: no CLI runs.

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function setup(plugins: InstalledPlugin[] = []) {
  const config = tempConfig();
  const folder = join(config.dataDir, '..', 'shop');
  const catalog = new AgentCatalog({ config, resources: () => new ConfigResources(), plugins: async () => plugins });
  return { config, folder, catalog };
}

const plugin = (installPath: string, over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'brand@market',
  name: 'brand',
  marketplace: 'market',
  version: '1.0.0',
  scope: 'user',
  enabled: true,
  installPath,
  installedAt: null,
  lastUpdated: null,
  ...over,
});

test('lists project, user and enabled plugin agents, and a project agent wins over a user one of its name', async () => {
  const s = setup();
  write(join(s.folder, '.claude', 'agents', 'shipcast.md'), '---\nname: shipcast\ndescription: Project copy\ntools: Read, Grep\n---\nbody\n');
  write(join(s.config.configDir, 'agents', 'shipcast.md'), '---\nname: shipcast\ndescription: User copy\n---\nbody\n');
  write(join(s.config.configDir, 'agents', 'infra.md'), '---\nname: infra\ndescription: Infra\n---\nbody\n');
  const lead = join(s.config.dataDir, 'plugins', 'brand');
  write(join(lead, 'agents', 'lead.md'), '---\nname: lead\ndescription: Brand lead\n---\nbody\n');
  const off = join(s.config.dataDir, 'plugins', 'off');
  write(join(off, 'agents', 'ghost.md'), '---\nname: ghost\ndescription: Disabled\n---\nbody\n');
  const catalog = new AgentCatalog({
    config: s.config,
    resources: () => new ConfigResources(),
    plugins: async () => [plugin(lead), plugin(off, { id: 'off@market', name: 'off', enabled: false })],
  });

  const agents = await catalog.list(s.folder);
  assert.deepEqual(
    agents.map((a) => [a.name, a.source, a.plugin, a.description]),
    [
      ['brand:lead', 'plugin', 'brand', 'Brand lead'],
      ['infra', 'user', null, 'Infra'],
      ['shipcast', 'project', null, 'Project copy'],
    ],
  );
  assert.deepEqual(agents.find((a) => a.name === 'shipcast')?.tools, ['Read', 'Grep']);
});

test('an unknown agent is a 400 agent-unknown that lists the valid names', async () => {
  const s = setup();
  write(join(s.folder, '.claude', 'agents', 'shipcast.md'), '---\nname: shipcast\ndescription: Ship\n---\nbody\n');
  await assert.rejects(
    () => s.catalog.launch(s.folder, 'nope'),
    (err: unknown) => err instanceof ChatStartRefusal && err.statusCode === 400 && err.reason === 'agent-unknown' && /available: shipcast/.test(err.message),
  );
});

test('a user or project agent runs from a definition that drops permissionMode, mcpServers and hooks', async () => {
  const s = setup();
  write(
    join(s.folder, '.claude', 'agents', 'wide.md'),
    [
      '---',
      'name: wide',
      'description: Asks for everything',
      'model: opus',
      'permissionMode: bypassPermissions',
      'tools: Read, Bash',
      'disallowedTools: Write',
      'mcpServers:',
      '  - evil:',
      '      command: node',
      'hooks:',
      '  PreToolUse: []',
      '---',
      'You are wide.',
      '',
    ].join('\n'),
  );
  const launch = await s.catalog.launch(s.folder, 'wide');
  assert.equal(launch.agent, 'wide');
  assert.ok(launch.agentsFile);
  assert.equal(dirname(launch.agentsFile), join(s.config.dataDir, 'flow-agents'));
  const definition = JSON.parse(readFileSync(launch.agentsFile, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(definition.wide ?? {}).sort(), ['description', 'disallowedTools', 'model', 'prompt', 'tools']);
  assert.equal(definition.wide?.prompt, 'You are wide.');
  assert.deepEqual(definition.wide?.tools, ['Read', 'Bash']);
});

test('a plugin agent starts by name alone, since the CLI ignores its permissionMode, mcpServers and hooks', async () => {
  const s = setup();
  const lead = join(s.config.dataDir, 'plugins', 'brand');
  write(join(lead, 'agents', 'lead.md'), '---\nname: lead\ndescription: Brand lead\n---\nbody\n');
  const catalog = new AgentCatalog({ config: s.config, resources: () => new ConfigResources(), plugins: async () => [plugin(lead)] });
  assert.deepEqual(await catalog.launch(s.folder, 'brand:lead'), { agent: 'brand:lead' });
});

test('a plugin list that fails leaves the files agents usable', async () => {
  const s = setup();
  write(join(s.folder, '.claude', 'agents', 'a.md'), '---\nname: a\ndescription: A\n---\nbody\n');
  const catalog = new AgentCatalog({
    config: s.config,
    resources: () => new ConfigResources(),
    plugins: async () => {
      throw new Error('no CLI');
    },
  });
  assert.deepEqual((await catalog.list(s.folder)).map((a) => a.name), ['a']);
});
