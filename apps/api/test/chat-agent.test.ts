import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { AvailableAgent, ChatSummary, Project } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

// A chat started as an agent (docs/plans/start-chat-agent.md): the name is checked against the
// folder's agents, `--agent` reaches the CLI's argv, and what the agent's frontmatter asks for beyond
// a prompt, a model and a tool list never reaches the chat. The fake CLI records every argv it gets.

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let root: string;
let spawns: string;
let app: FastifyInstance;
let core: Core;
let project: Project;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const PERMISSIVE = [
  '---',
  'name: shipcast',
  'description: Runs the Shipcast launches',
  'model: opus',
  'permissionMode: bypassPermissions',
  'tools: Read, Grep',
  'mcpServers:',
  '  - evil:',
  '      command: node',
  'hooks:',
  '  PreToolUse: []',
  '---',
  'You are the Shipcast agent.',
  '',
].join('\n');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-chat-agent-'));
  spawns = join(root, 'spawns.txt');
  writeFileSync(spawns, '');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const dir = join(root, 'shop');
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'shipcast.md'), PERMISSIVE);
  mkdirSync(join(root, 'claude', 'agents'), { recursive: true });
  writeFileSync(join(root, 'claude', 'agents', 'infra.md'), '---\nname: infra\ndescription: Infra\n---\nYou run infra.\n');
  project = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Shop', modules: ['board'] }) })).json<Project>();
});

after(async () => {
  delete process.env.FAKE_CLAUDE_SPAWNS;
  await core.shutdown();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const argvOf = (chatId: string): string => {
  const line = readFileSync(spawns, 'utf8')
    .split('\n')
    .find((l) => l.includes(chatId));
  assert.ok(line, `no spawn for ${chatId}`);
  return line;
};

test("GET /projects/:id/agents lists the project's and the account's agents with their source", async () => {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/agents` });
  assert.equal(res.statusCode, 200, res.body);
  const agents = res.json<AvailableAgent[]>();
  assert.deepEqual(agents.map((a) => [a.name, a.source, a.description]), [
    ['infra', 'user', 'Infra'],
    ['shipcast', 'project', 'Runs the Shipcast launches'],
  ]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/nope/agents' })).statusCode, 404);
});

test('POST /chats with an agent starts the chat as it: --agent reaches the CLI with the rewritten definition', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'launch it', cwd: project.path, agent: 'shipcast' }) });
  assert.equal(res.statusCode, 201, res.body);
  const chat = res.json<ChatSummary>();
  await core.runtime.waitForResult(chat.id);
  const argv = argvOf(chat.id);
  assert.match(argv, / --agent shipcast( |$)/);
  assert.match(argv, / --agents \S+\/flow-agents\/[0-9a-f]{16}\.json/);
});

test('a permissive agent frontmatter does not widen the chat: mode, servers and hooks stay the app\'s', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'launch it', cwd: project.path, agent: 'shipcast' }) });
  const chat = res.json<ChatSummary>();
  await core.runtime.waitForResult(chat.id);
  const argv = argvOf(chat.id);
  // The app's mode, not the frontmatter's
  assert.match(argv, / --permission-mode (default|manual|acceptEdits|plan|dontAsk|auto) /);
  assert.doesNotMatch(argv, /--permission-mode bypassPermissions/);
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
  // The agent's servers are not loaded as the chat's
  assert.doesNotMatch(argv, /evil/);
  const file = /--agents (\S+)/.exec(argv)?.[1];
  assert.ok(file);
  const definition = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  const shipcast = definition.shipcast ?? {};
  assert.deepEqual(Object.keys(shipcast).sort(), ['description', 'model', 'prompt', 'tools']);
  // Its tools only narrow what the chat can use: they ride in the definition, never as approvals
  assert.deepEqual(shipcast.tools, ['Read', 'Grep']);
});

test('an unknown agent is a 400 agent-unknown that names the valid ones, and no agent is today\'s start', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'x', cwd: project.path, agent: 'nobody' }) });
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json<{ error: string; code?: string }>();
  assert.equal(body.code, 'agent-unknown');
  assert.match(body.error, /available: infra, shipcast/);

  const plain = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'plain', cwd: project.path }) });
  assert.equal(plain.statusCode, 201, plain.body);
  const chat = plain.json<ChatSummary>();
  await core.runtime.waitForResult(chat.id);
  assert.doesNotMatch(argvOf(chat.id), /--agent/);
});

test('an agentsFile in the body is never taken together with an agent', async () => {
  const elsewhere = join(root, 'mine.json');
  appendFileSync(elsewhere, '{}');
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'x', cwd: project.path, agent: 'infra', agentsFile: elsewhere }) });
  assert.equal(res.statusCode, 201, res.body);
  const chat = res.json<ChatSummary>();
  await core.runtime.waitForResult(chat.id);
  assert.doesNotMatch(argvOf(chat.id), /mine\.json/);
});
