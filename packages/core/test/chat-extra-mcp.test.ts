import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// The servers core's callers add to a chat's `--mcp-config` (`extraMcpServers`, the OpenAI surface's
// stub): one file per chat that goes with the chat and does not outlive a restart, and a chat's own
// config that cannot be read never makes the spawn throw.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const EXTRA = { client: { type: 'http', url: 'http://127.0.0.1:1/api/openai/client-tools/x/mcp' } };

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup(config = { ...tempConfig(), claudeBin: FAKE_CLAUDE }) {
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  mkdirSync(dirname(config.globalConfigFile), { recursive: true });
  writeFileSync(config.globalConfigFile, JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }));
  const core = new Core(config);
  const spawns = (): string[][] =>
    (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [])
      .filter((line) => line.includes('--session-id') || line.includes('--resume'))
      .map((line) => line.split(' ').slice(1));
  const mcpConfigOf = (argv: string[] | undefined): string => argv?.find((a) => a.startsWith('--mcp-config='))?.slice('--mcp-config='.length) ?? '';
  return { config, core, spawns, mcpConfigOf };
}

async function stopped(core: Core, id: string): Promise<void> {
  core.runtime.stop(id);
  await until(() => core.runtime.get(id)?.pid === null, 'the process to exit');
}

test("a chat's added servers go in one file named for the chat, joined to its own servers, and it goes with the chat", async () => {
  const { config, core, spawns, mcpConfigOf } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'x', mcp: { servers: ['docs'] } }, undefined, undefined, undefined, 'api', EXTRA);
    await until(() => spawns().length === 1, 'the first process');
    const file = mcpConfigOf(spawns()[0]);
    assert.match(file, new RegExp(`/mcp/extra-${chat.id}-[0-9a-f]{16}\\.json$`));
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: object }).mcpServers).sort(), ['client', 'docs']);
    await stopped(core, chat.id);
    assert.ok(core.runtime.remove(chat.id));
    assert.equal(existsSync(file), false);
    // The chat's own config, written for its choice of servers, is shared by name and stays
    assert.ok(readdirSync(join(config.dataDir, 'mcp')).some((f) => /^[0-9a-f]{16}\.json$/.test(f)));
  } finally {
    core.shutdown();
  }
});

test("a chat's own config that is gone or broken starts the process with the added servers only, and says so in the chat", async () => {
  const { core, spawns, mcpConfigOf } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'x', mcp: { servers: ['docs'] } }, undefined, undefined, undefined, 'api', EXTRA);
    await until(() => spawns().length === 1, 'the first process');
    const base = (await core.chats.get(chat.id))?.tools?.mcp?.config;
    assert.ok(base);
    await stopped(core, chat.id);
    for (const [n, damage] of [
      [2, () => writeFileSync(base, '{ not json')],
      [3, () => rmSync(base)],
    ] as const) {
      damage();
      // A message to a chat without a process starts one from what the chat has, without choosing again
      core.runtime.send(chat.id, `again ${String(n)}`);
      await until(() => spawns().length === n, `process ${String(n)}`);
      assert.deepEqual(Object.keys((JSON.parse(readFileSync(mcpConfigOf(spawns()[n - 1]), 'utf8')) as { mcpServers: object }).mcpServers), ['client']);
      await stopped(core, chat.id);
    }
    const notices = core.runtime.events(chat.id).filter((e) => e.kind === 'notice' && /MCP server config could not be read/.test(e.text ?? ''));
    assert.deepEqual(notices.map((e) => /not valid JSON|file is gone/.exec(e.text ?? '')?.[0]), ['not valid JSON', 'file is gone']);
  } finally {
    core.shutdown();
  }
});

test('without added servers the chat is given its own config path as it was, read or not', async () => {
  const { core, spawns, mcpConfigOf } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'x', mcp: { servers: ['docs'] } });
    await until(() => spawns().length === 1, 'the first process');
    const base = (await core.chats.get(chat.id))?.tools?.mcp?.config;
    assert.equal(mcpConfigOf(spawns()[0]), base);
    assert.ok(spawns()[0]?.includes('--strict-mcp-config'));
  } finally {
    core.shutdown();
  }
});

test("a restart deletes the added-servers files of chats with no process, and nothing else in the folder", async () => {
  const { config, core } = setup();
  const dir = join(config.dataDir, 'mcp');
  mkdirSync(dir, { recursive: true });
  const orphan = join(dir, 'extra-0b6f6b2e-5a35-4c47-9b1e-2f3c4d5e6f70-0123456789abcdef.json');
  const shared = join(dir, '0123456789abcdef.json');
  const foreign = join(dir, 'extra-notes.json');
  for (const f of [orphan, shared, foreign]) writeFileSync(f, '{}');
  try {
    await core.runtime.restore(core.sessions);
    assert.equal(existsSync(orphan), false);
    assert.ok(existsSync(shared));
    assert.ok(existsSync(foreign));
  } finally {
    core.shutdown();
  }
});
