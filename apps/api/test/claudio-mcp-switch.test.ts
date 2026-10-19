import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import type { ChatMcpServers, ChatSummary, Project } from '@claudio/shared';
import { buildApp } from '../src/app.ts';

/*
 * Claudio's own MCP server switched on from the "+" of a live chat (docs/plans/owner-report-fixes.md, D6),
 * through the e2e suite's fake CLI, which answers `mcp_set_servers` as CLI 2.1.302 does: the switch
 * pushes the server with the chat's id and token written out, the server answers a call with them,
 * switching it off takes it away, and the choice outlives the process.
 */

const FAKE_CLI = fileURLToPath(new URL('../../../e2e/fake-cli/claude', import.meta.url));
// The server runs from this source, the one under test, not from a bundle an installed Claudio hands down
delete process.env.CLAUDIO_MCP_ENTRY;

let root: string;
let log: string;
let app: FastifyInstance;
let core: Core;
let project: Project;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const logged = (): Array<Record<string, unknown>> =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the fake CLI logged ${logged().map((l) => String(l.event)).join(', ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'claudio-mcp-switch-'));
  log = join(root, 'fake-cli.log');
  process.env.CLAUDIO_FAKE_CLI_LOG = log;
  core = new Core(loadConfig({ CLAUDE_BIN: FAKE_CLI, CLAUDE_CONFIG_DIR: join(root, 'claude'), CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'), CLAUDIO_DATA_DIR: join(root, 'data') }));
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  // A real socket, so the server the fake CLI starts can reach the API
  await app.listen({ port: 0, host: '127.0.0.1' });
  core.runtime.apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  const dir = join(root, 'shop');
  mkdirSync(dir, { recursive: true });
  project = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Shop', modules: ['board'] }) })).json<Project>();
});

after(async () => {
  delete process.env.CLAUDIO_FAKE_CLI_LOG;
  delete process.env.CLAUDIO_FAKE_CLI_MCP;
  core.runtime.stopAll();
  core.shutdown();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

async function liveChat(body: Record<string, unknown> = {}): Promise<string> {
  const started = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hello', cwd: project.path, toolPreset: null, ...body }) });
  assert.equal(started.statusCode, 201, started.body);
  const { id } = started.json<ChatSummary>();
  await core.runtime.waitForResult(id);
  await until('the live process', async () => (await alive(id)) === true);
  return id;
}

const alive = async (id: string) => (await app.inject({ method: 'GET', url: `/api/chats/${id}` })).json<{ chat: { alive: boolean } }>().chat.alive;
const servers = async (id: string) => (await app.inject({ method: 'GET', url: `/api/chats/${id}/mcp` })).json<ChatMcpServers>();
const turn = (id: string, on: boolean) => app.inject({ method: 'PUT', url: `/api/chats/${id}/claudio-mcp`, ...json({ enabled: on }) });

test("the switch hands the live process Claudio's server with the chat's id and token, and takes it away", async () => {
  // Allowed ahead of time only so the fake makes the call without a person to ask
  const id = await liveChat({ allowedTools: ['mcp__claudio__list_projects'] });
  assert.deepEqual((await servers(id)).claudio, { on: false, unavailable: null, error: null });

  const on = await turn(id, true);
  assert.equal(on.statusCode, 200, on.body);
  const after = on.json<ChatMcpServers>();
  assert.deepEqual(after.claudio, { on: true, unavailable: null, error: null });
  assert.deepEqual(
    after.servers.filter((s) => s.name === 'claudio').map((s) => [s.status, s.scope]),
    [['connected', 'dynamic']],
  );
  const pushed = logged().find((l) => l.event === 'mcp-set-servers');
  assert.deepEqual(pushed?.names, ['claudio']);
  assert.ok((pushed?.env as Record<string, string[]>).claudio?.includes('CLAUDIO_CHAT_ID'), 'the chat id goes in the request');
  assert.ok((pushed?.env as Record<string, string[]>).claudio?.includes('CLAUDIO_API_TOKEN'), "the process's token goes in the request");

  // The pushed server is the real one, and it reaches the wrapper that runs the chat
  const sent = await app.inject({ method: 'POST', url: `/api/chats/${id}/messages`, ...json({ text: 'mcp: claudio list_projects {}' }) });
  assert.equal(sent.statusCode, 200, sent.body);
  await until('the call to end', () => logged().some((l) => l.event === 'mcp-ended' && l.tool === 'list_projects'));
  const ended = logged().find((l) => l.event === 'mcp-ended' && l.tool === 'list_projects');
  assert.equal(ended?.isError, false, 'the server answered the call');

  const off = await turn(id, false);
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json<ChatMcpServers>().claudio?.on, false);
  assert.equal(off.json<ChatMcpServers>().servers.some((s) => s.name === 'claudio'), false);
  assert.equal(core.runtime.get(id)?.tools?.claudioMcp, undefined, 'off is stored as no switch at all');
});

test('a resume of a chat with the switch on starts with the server in its --mcp-config', async () => {
  const id = await liveChat();
  assert.equal((await turn(id, true)).statusCode, 200);
  assert.equal(core.runtime.get(id)?.tools?.claudioMcp, true);
  await app.inject({ method: 'POST', url: `/api/chats/${id}/stop` });
  await until('the process to end', async () => (await alive(id)) === false);

  const before = logged().filter((l) => l.event === 'started').length;
  const resumed = await app.inject({ method: 'POST', url: `/api/chats/${id}/resume`, ...json({ prompt: 'again' }) });
  assert.equal(resumed.statusCode, 200, resumed.body);
  await until('the resumed process', () => logged().filter((l) => l.event === 'started').length > before);
  const argv = (logged().filter((l) => l.event === 'started').at(-1)?.argv ?? []) as string[];
  const file = argv.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length);
  assert.ok(file, `the resume has an --mcp-config (${argv.join(' ')})`);
  const config = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
  assert.equal(config.mcpServers.claudio?.env.CLAUDIO_CHAT_ID, '${CLAUDIO_CHAT_ID}', 'the file refers to the id and token, never holds them');
  assert.equal(argv.includes('--strict-mcp-config'), false, "the chat chose no servers, so the CLI's own still load");
  await core.runtime.waitForResult(id);
  assert.deepEqual((await servers(id)).claudio?.on, true);
});

test('a server of the person already named claudio is reported, never replaced', async () => {
  process.env.CLAUDIO_FAKE_CLI_MCP = JSON.stringify([{ name: 'claudio', status: 'connected', scope: 'user', tools: [] }]);
  try {
    const id = await liveChat();
    assert.equal((await servers(id)).claudio?.unavailable, 'clash');
    const clash = await turn(id, true);
    assert.equal(clash.statusCode, 409, clash.body);
    assert.match(clash.json<{ error: string }>().error, /already a server named claudio/);
  } finally {
    delete process.env.CLAUDIO_FAKE_CLI_MCP;
  }
});

test('the switch needs a live process, and a chat Claudio does not know is a 404', async () => {
  const id = await liveChat();
  await app.inject({ method: 'POST', url: `/api/chats/${id}/stop` });
  await until('the process to end', async () => (await alive(id)) === false);
  assert.equal((await turn(id, true)).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/chats/nope/claudio-mcp', ...json({ enabled: true }) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/chats/${id}/claudio-mcp`, ...json({ enabled: 'yes' }) })).statusCode, 400);
});

test('the assistant chat is not offered the switch: it already has the server, confined', async () => {
  const chat = await core.startClaudioAssistantChat({ prompt: 'hello' });
  await core.runtime.waitForResult(chat.id);
  assert.equal((await servers(chat.id)).claudio?.unavailable, 'assistant');
});
