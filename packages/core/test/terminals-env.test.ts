import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTerminalEnv } from '../src/terminals/env.ts';

const SERVER_ENV: NodeJS.ProcessEnv = {
  HOME: '/home/person',
  USER: 'person',
  PATH: '/opt/claudio/mount/usr/bin:/usr/local/bin:/usr/bin',
  LD_LIBRARY_PATH: '/opt/claudio/mount/usr/lib',
  SHELL: '/bin/bash',
  LANG: 'es_ES.UTF-8',
  SSH_AUTH_SOCK: '/run/user/1000/ssh',
  CLAUDE_CONFIG_DIR: '/home/person/.claude',
  GH_CONFIG_DIR: '/home/person/.config/gh',
  CLAUDIO_API_URL: 'http://127.0.0.1:8797/api',
  CLAUDIO_API_TOKEN: 'chat-token',
  CLAUDIO_AUTH_TOKEN: 'owner-token',
  CLAUDIO_AUTH_MODE: 'token',
  CLAUDIO_DESKTOP_TOKEN: 'desktop',
  CLAUDIO_SECRET_KEY: 'key',
  CLAUDIO_DATA_DIR: '/data',
  CLAUDIO_CHAT_ID: 'chat-1',
  CLAUDIO_AGENT_RUN: 'orch-1',
  ELECTRON_RUN_AS_NODE: '1',
  NODE_ENV: 'production',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  ANTHROPIC_API_KEY: 'sk-ant',
  ANTHROPIC_AUTH_TOKEN: 'auth',
  npm_config_user_agent: 'pnpm',
  PNPM_HOME: '/pnpm',
  INIT_CWD: '/repo',
  APPIMAGE: '/apps/Claudio.AppImage',
  APPDIR: '/opt/claudio/mount',
  ARGV0: 'Claudio',
  OWD: '/home/person',
};

const vault = {
  get: (tool: string): Record<string, string> =>
    ({
      gh: { GH_TOKEN: 'gh-secret' },
      glab: { GITLAB_TOKEN: 'gl-secret' },
      youtrack: { YOUTRACK_TOKEN: 'yt-secret', YOUTRACK_URL: 'https://yt.example' },
      'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'vault-oauth', ANTHROPIC_API_KEY: 'vault-key' },
      tailscale: { TS_AUTHKEY: 'ts' },
    })[tool] ?? {},
};

test('no CLAUDIO_ variable survives into a shell, and CLAUDIO_CHAT_ID is never set', () => {
  const env = buildTerminalEnv({ base: SERVER_ENV, vault, cwd: '/work' });
  assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('CLAUDIO_')), []);
  assert.equal('CLAUDIO_CHAT_ID' in env, false);
  // The marker of a process started for an agent must not turn the person's shell into one the peer check refuses
  assert.equal('CLAUDIO_AGENT_RUN' in env, false);
});

test("Claude's credentials are gone, from the server's environment and from the vault", () => {
  const env = buildTerminalEnv({ base: SERVER_ENV, vault, cwd: '/work' });
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(name in env, false, name);
  assert.equal(Object.values(env).includes('vault-oauth'), false);
  assert.equal(Object.values(env).includes('vault-key'), false);
});

test("the vault's tool credentials are present so gh, glab and the tracker CLIs work; Tailscale's is not", () => {
  const env = buildTerminalEnv({ base: SERVER_ENV, vault, cwd: '/work' });
  assert.equal(env.GH_TOKEN, 'gh-secret');
  assert.equal(env.GITLAB_TOKEN, 'gl-secret');
  assert.equal(env.YOUTRACK_TOKEN, 'yt-secret');
  assert.equal(env.YOUTRACK_URL, 'https://yt.example');
  assert.equal('TS_AUTHKEY' in env, false);
});

test('the server and the runtime leave nothing behind, and the person keeps what is theirs', () => {
  const env = buildTerminalEnv({ base: SERVER_ENV, vault, cwd: '/work' });
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'INIT_CWD', 'npm_config_user_agent', 'PNPM_HOME', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) {
    assert.equal(name in env, false, name);
  }
  // The AppImage's own mount comes out of the path lists
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
  assert.equal('LD_LIBRARY_PATH' in env, false);
  for (const name of ['HOME', 'USER', 'SHELL', 'LANG', 'SSH_AUTH_SOCK', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR']) assert.equal(env[name], SERVER_ENV[name], name);
});

test("TERM, COLORTERM and TERM_PROGRAM are set, PWD is the directory, and a locale is made up only when there is none", () => {
  const env = buildTerminalEnv({ base: SERVER_ENV, vault: null, cwd: '/work', version: '1.2.3' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.TERM_PROGRAM, 'Claudio');
  assert.equal(env.TERM_PROGRAM_VERSION, '1.2.3');
  assert.equal(env.PWD, '/work');
  assert.equal(env.LANG, 'es_ES.UTF-8');
  assert.equal(buildTerminalEnv({ base: { PATH: '/usr/bin' }, cwd: '/work' }).LANG, 'C.UTF-8');
  assert.equal(buildTerminalEnv({ base: { LC_ALL: 'de_DE.UTF-8' }, cwd: '/work' }).LANG, undefined);
});
