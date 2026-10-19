import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { envFor } from '@claudio/accounts';
import { isServerVariable, withoutServerEnv } from '@claudio/shared';
import { childEnv } from '../src/child-env.ts';
import { buildHostEnv } from '../src/hosts/env.ts';
import { Core } from '../src/index.ts';
import { buildTerminalEnv } from '../src/terminals/env.ts';
import { runCommand } from '../src/verification.ts';
import { tempConfig } from './helpers.ts';

// On 2026-10-18 a worker ran `pnpm dev` in its worktree and the dev server found the desktop's
// CLAUDIO_DATA_DIR and PORT in its environment. Whatever Claudio starts for an agent or a person
// must not hold the server's own variables: each launch path is checked here.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

/** What the desktop app hands its server, as it was on the day */
const SERVER = {
  PORT: '41985',
  HOST: '127.0.0.1',
  CLAUDIO_DATA_DIR: '/home/person/.config/Claudio/data',
  CLAUDIO_WORKSPACE_DIR: '/home/person/.config/Claudio/workspace',
  CLAUDIO_WEB_DIST: '/opt/Claudio/resources/web',
  CLAUDIO_VERSION: '0.6.0',
  CLAUDIO_DISTRIBUTION: 'deb',
  CLAUDIO_MCP_ENTRY: '/opt/Claudio/resources/server/mcp.mjs',
  CLAUDIO_GUARD_ENTRY: '/opt/Claudio/resources/server/guard.mjs',
  CLAUDIO_LAUNCHER: 'desktop',
  CLAUDIO_A_VARIABLE_ADDED_LATER: 'x',
};
const API = { CLAUDIO_API_URL: 'http://127.0.0.1:41985/api', CLAUDIO_API_TOKEN: 'agc_chat', CLAUDIO_CHAT_ID: 'chat-1' };
const SERVER_NAMES = Object.keys(SERVER);

const leaked = (env: Readonly<Record<string, string | undefined>>): string[] => SERVER_NAMES.filter((name) => env[name] !== undefined);

/** Sets `vars` on `process.env` for the length of `fn`, and puts back what was there */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('CLAUDIO_* is an allow-list: only the API address, the chat token and the chat id pass, with PORT and HOST dropped', () => {
  for (const name of SERVER_NAMES) assert.ok(isServerVariable(name), name);
  for (const name of Object.keys(API)) assert.ok(!isServerVariable(name), name);
  assert.ok(!isServerVariable('CLAUDIO_FAKE_CLI_SCRIPTS'), "the browser suite's fake CLI reads its switches");
  assert.ok(!isServerVariable('HOME'));
  assert.ok(!isServerVariable('PATH'));
  const env = withoutServerEnv({ ...SERVER, ...API, HOME: '/home/person' });
  assert.deepEqual(env, { ...API, HOME: '/home/person' });
});

test('a Claude Code process, of the default account or of another one, holds none of the server variables', () => {
  const base = { ...SERVER, ...API, HOME: '/home/person', PATH: '/usr/bin' };
  const plain = childEnv('claude-code', base);
  assert.deepEqual(leaked(plain), []);
  assert.equal(plain.CLAUDIO_API_URL, API.CLAUDIO_API_URL);
  assert.equal(plain.CLAUDIO_CHAT_ID, API.CLAUDIO_CHAT_ID);
  assert.equal(plain.PATH, '/usr/bin');
  const other = childEnv('claude-code', base, { id: 'work', kind: 'login', dir: '/home/person/.claudio-accounts/work' });
  assert.deepEqual(leaked(other), []);
  assert.equal(other.CLAUDIO_API_TOKEN, API.CLAUDIO_API_TOKEN);
  // The accounts package's own launches (sign-in, identity, usage) build theirs with envFor
  assert.deepEqual(leaked(envFor({ id: 'default', kind: 'login', dir: '/home/person/.claude' }, base)), []);
});

test('a setup or host CLI (gh, glab, youtrack-app) holds none of the server variables', () => {
  const base = { ...SERVER, ...API, HOME: '/home/person' };
  for (const cli of ['gh', 'glab', 'youtrack-app'] as const) assert.deepEqual(leaked(buildHostEnv(cli, base)), [], cli);
});

test("the terminal's shell holds no CLAUDIO_* at all, nor PORT or HOST", () => {
  const env = buildTerminalEnv({ base: { ...SERVER, ...API, HOME: '/home/person', PATH: '/usr/bin' }, cwd: '/home/person' });
  assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('CLAUDIO_') || name === 'PORT' || name === 'HOST'), []);
});

test("a verification command, which may start a Claudio of its own, gets neither the server's port nor its data directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-child-env-'));
  try {
    const outcome = await runCommand('env', dir, 10_000, undefined, 'orch-1', { ...SERVER, ...API, PATH: process.env.PATH ?? '/usr/bin' });
    const names = outcome.output.split('\n').map((line) => line.split('=')[0]);
    assert.deepEqual(SERVER_NAMES.filter((name) => names.includes(name)), []);
    assert.ok(names.includes('CLAUDIO_AGENT_RUN'), 'the run marker the terminal refuses it by');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chat's Claude Code process gets the API address, its own token and its id, and none of the server's variables", async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const envs = join(config.dataDir, 'envs.log');
  await withEnv({ ...SERVER, FAKE_CLAUDE_LOGGED_IN: '1', FAKE_CLAUDE_ENVS: envs }, async () => {
    const core = new Core(config);
    try {
      core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
      const chat = core.runtime.start({ prompt: 'hello', keepAlive: false });
      let line: { url: string | null; token: string | null; chat: string | null; claudio: string[] } | undefined;
      for (let i = 0; i < 400 && !line; i++) {
        if (existsSync(envs)) {
          line = readFileSync(envs, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as NonNullable<typeof line>)
            .find((e) => e.chat === chat.id);
        }
        if (!line) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(line, 'the chat spawned');
      assert.equal(line.url, 'http://127.0.0.1:34331/api');
      assert.match(line.token ?? '', /^agc_/);
      assert.deepEqual(line.claudio, ['CLAUDIO_API_TOKEN', 'CLAUDIO_API_URL', 'CLAUDIO_CHAT_ID']);
    } finally {
      await core.shutdown();
    }
  });
});
