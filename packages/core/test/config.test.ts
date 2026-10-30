import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SettingsFiles } from '../src/config/files.ts';
import { McpConfig } from '../src/config/mcp.ts';
import { parseVariant, projectScope, userScope } from '../src/config/scope.ts';
import { ConfigResources } from '../src/config/resources.ts';
import { childEnv, useVaultForChildren } from '../src/child-env.ts';
import { CredentialStore } from '../src/credentials.ts';
import { SecretVault } from '../src/secret-vault.ts';
import { ensureProviderHomes, loadConfig } from '../src/paths.ts';
import { encodeProjectId, Workspace } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// loadConfig creates the directories it is pointed at
const scratch = mkdtempSync(join(tmpdir(), 'claudio-config-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('settings and instructions round-trip per scope', async () => {
  const config = tempConfig();
  const files = new SettingsFiles();
  const user = userScope(config);
  const project = projectScope(join(config.workspaceDir, 'app'));

  assert.deepEqual(await files.getSettings(user), { path: join(config.configDir, 'settings.json'), exists: false, settings: {} });
  assert.deepEqual((await files.setSettings(user, 'shared', { model: 'sonnet' })).settings, { model: 'sonnet' });
  await assert.rejects(files.setSettings(user, 'shared', [1]), /JSON object/);
  await assert.rejects(files.getSettings(user, 'local'), /only exists in project scope/);

  const local = await files.setSettings(project, 'local', { env: { A: '1' } });
  assert.equal(local.path, join(config.workspaceDir, 'app', '.claude', 'settings.local.json'));
  assert.equal((await files.getSettings(project, 'shared')).exists, false); // variants are independent files

  assert.equal((await files.setInstructions(user, 'shared', '# Rules\n')).path, join(config.configDir, 'CLAUDE.md'));
  assert.equal((await files.setInstructions(project, 'shared', 'p')).path, join(config.workspaceDir, 'app', 'CLAUDE.md'));
  assert.equal((await files.setInstructions(project, 'local', 'l')).path, join(config.workspaceDir, 'app', 'CLAUDE.local.md'));
  await assert.rejects(files.setInstructions(user, 'shared', 42), /string/);
  assert.throws(() => parseVariant('nope'), /variant must be/);
});

test('markdown resources CRUD with per-kind layout and scope', async () => {
  const config = tempConfig();
  const resources = new ConfigResources();
  const user = userScope(config);
  const project = projectScope(join(config.workspaceDir, 'app'));
  const body = '---\nname: x\ndescription: "Reviews code"\n---\nBody\n';

  const agent = await resources.save(user, 'agents', 'reviewer', body);
  assert.equal(agent.path, join(config.configDir, 'agents', 'reviewer.md'));
  assert.equal(agent.description, 'Reviews code');

  const skill = await resources.save(project, 'skills', 'deploy', body);
  assert.equal(skill.path, join(config.workspaceDir, 'app', '.claude', 'skills', 'deploy', 'SKILL.md'));
  assert.deepEqual((await resources.list(project, 'skills')).map((r) => r.name), ['deploy']);
  assert.deepEqual(await resources.list(user, 'skills'), []); // scopes do not leak into each other

  const style = await resources.save(user, 'output-styles', 'terse', body);
  assert.equal(style.path, join(config.configDir, 'output-styles', 'terse.md'));

  await resources.remove(project, 'skills', 'deploy');
  assert.equal(existsSync(join(config.workspaceDir, 'app', '.claude', 'skills', 'deploy')), false);
  await assert.rejects(resources.remove(user, 'agents', 'ghost'), /not found/);
  await assert.rejects(resources.save(user, 'agents', '../evil', 'x'), /invalid resource name/);
});

test('a saved workflow is a script resource: found by its meta name, kept in its own file, and never mistaken for markdown', async () => {
  const config = tempConfig();
  const resources = new ConfigResources();
  const user = userScope(config);
  const project = projectScope(join(config.workspaceDir, 'app'));
  const dir = join(config.workspaceDir, 'app', '.claude', 'workflows');
  mkdirSync(dir, { recursive: true });
  // The file is not called what the script says: the Workflow tool goes by `meta.name`
  writeFileSync(join(dir, 'audit-v2.mjs'), "export const meta = { name: 'audit', description: 'Audit the API' }\nreturn 1\n");
  writeFileSync(join(dir, 'notes.md'), '# not a workflow');

  const listed = await resources.list(project, 'workflows');
  assert.deepEqual(listed.map((r) => [r.name, r.format, r.description]), [['audit', 'javascript', 'Audit the API']]);
  assert.deepEqual(await resources.list(user, 'workflows'), []); // scopes do not leak into each other
  assert.equal((await resources.list(project, 'agents')).every((r) => r.format === 'markdown'), true);

  // Saving by name edits the file that holds it instead of creating a second `audit.js`
  const edited = await resources.save(project, 'workflows', 'audit', "export const meta = { name: 'audit', description: 'Changed' }\n");
  assert.equal(edited.path, join(dir, 'audit-v2.mjs'));
  assert.equal(edited.description, 'Changed');
  assert.equal(existsSync(join(dir, 'audit.js')), false);

  const created = await resources.save(project, 'workflows', 'fresh', "export const meta = { name: 'fresh' }\n");
  assert.equal(created.path, join(dir, 'fresh.js'));
  assert.equal(readFileSync(created.path, 'utf8'), "export const meta = { name: 'fresh' }\n");

  // A script that renames itself is the workflow of its new name
  const renamed = await resources.save(project, 'workflows', 'fresh', "export const meta = { name: 'fresher' }\n");
  assert.equal(renamed.name, 'fresher');
  assert.equal(renamed.path, created.path);

  await resources.remove(project, 'workflows', 'audit');
  assert.equal(existsSync(join(dir, 'audit-v2.mjs')), false);
  await assert.rejects(resources.remove(project, 'workflows', 'audit'), /not found/);
});

test('the Claude credential reaches claude processes only, wins over the container\'s, and clearing it lets that one through again', async () => {
  const config = tempConfig();
  const vault = new SecretVault(config);
  const release = useVaultForChildren(vault);
  const boot = { CLAUDE_CODE_OAUTH_TOKEN: 'boot-token', PATH: '/usr/bin' };
  try {
    const store = new CredentialStore(config, vault);
    assert.equal(store.active, false);

    await store.set({ apiKey: ' sk-test ' });
    const claude = childEnv('claude-code', boot);
    assert.equal(claude.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, undefined); // only one credential type at a time
    // Nothing else inherits it, and the server's own environment is untouched
    assert.equal(childEnv('gemini', boot).ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY === 'sk-test', false);
    assert.equal(statSync(join(config.dataDir, 'secrets.json')).mode & 0o777, 0o600);

    // A fresh instance (wrapper restart) picks the stored credential up again
    assert.equal(new CredentialStore(config, new SecretVault(config)).active, true);

    await assert.rejects(store.set({}), /provide oauthToken or apiKey/);
    await assert.rejects(store.set({ oauthToken: 'a', apiKey: 'b' }), /only one/);

    await store.clear();
    assert.equal(store.active, false);
    assert.deepEqual([childEnv('claude-code', boot).CLAUDE_CODE_OAUTH_TOKEN, childEnv('claude-code', boot).ANTHROPIC_API_KEY], ['boot-token', undefined]);
  } finally {
    release();
  }
});

test('an allowed-hosts pattern that guards nothing stops the wrapper instead of opening it', () => {
  const base = { CLAUDE_CONFIG_DIR: join(scratch, 'hosts', 'claude'), CLAUDIO_DATA_DIR: join(scratch, 'hosts', 'data'), CLAUDIO_WORKSPACE_DIR: join(scratch, 'hosts', 'workspace') };

  assert.deepEqual(loadConfig({ ...base, CLAUDIO_ALLOWED_HOSTS: ' *.Example.com , claudio.internal ' }).allowedHosts, ['*.example.com', 'claudio.internal']);
  assert.deepEqual(loadConfig({ ...base }).allowedHosts, []);

  // A wildcard over a public suffix, or anywhere but the front, is a typo worth failing on
  for (const value of ['*.com', '*', '*.', 'a.*.example.com', 'ex*mple.com']) {
    assert.throws(() => loadConfig({ ...base, CLAUDIO_ALLOWED_HOSTS: value }), /CLAUDIO_ALLOWED_HOSTS/, value);
  }
});

test('the tunnel is offered by default, and in the Docker image only once its entrypoint started a tailscaled of its own', () => {
  const base = { CLAUDE_CONFIG_DIR: join(scratch, 'switch', 'claude'), CLAUDIO_DATA_DIR: join(scratch, 'switch', 'data'), CLAUDIO_WORKSPACE_DIR: join(scratch, 'switch', 'workspace') };
  const docker = { ...base, CLAUDIO_DISTRIBUTION: 'docker' };

  assert.equal(loadConfig(base).tunnelEnabled, true);
  assert.equal(loadConfig(docker).tunnelEnabled, false);
  // Compose passes `CLAUDIO_TUNNEL=${CLAUDIO_TUNNEL:-}` through: empty is the default, not "off"
  assert.equal(loadConfig({ ...docker, CLAUDIO_TUNNEL: '' }).tunnelEnabled, false);
  assert.equal(loadConfig({ ...base, CLAUDIO_TUNNEL: ' ' }).tunnelEnabled, true);
  for (const on of ['on', 'ON', '1', 'true']) assert.equal(loadConfig({ ...docker, CLAUDIO_TUNNEL: on }).tunnelEnabled, true, on);
  for (const off of ['off', '0', 'false']) assert.equal(loadConfig({ ...base, CLAUDIO_TUNNEL: off }).tunnelEnabled, false, off);

  // The switch that opens a way in is not guessed at
  for (const value of ['yes', 'enabled', 'of']) {
    assert.throws(() => loadConfig({ ...base, CLAUDIO_TUNNEL: value }), /CLAUDIO_TUNNEL/, value);
  }
});

test('only the tailscaled the image started is Claudio\'s to sign in, and its node name is a host name', () => {
  const base = { CLAUDE_CONFIG_DIR: join(scratch, 'managed', 'claude'), CLAUDIO_DATA_DIR: join(scratch, 'managed', 'data'), CLAUDIO_WORKSPACE_DIR: join(scratch, 'managed', 'workspace') };
  const docker = { ...base, CLAUDIO_DISTRIBUTION: 'docker' };
  const managed = { ...docker, CLAUDIO_TAILSCALE_MANAGED: '1' };

  assert.equal(loadConfig(base).tailscaleManaged, false);
  assert.equal(loadConfig(docker).tailscaleManaged, false);
  assert.equal(loadConfig(managed).tailscaleManaged, true);
  // The entrypoint started a daemon, so the tunnel is offered; CLAUDIO_TUNNEL=off still wins
  assert.equal(loadConfig(managed).tunnelEnabled, true);
  assert.equal(loadConfig({ ...managed, CLAUDIO_TUNNEL: 'off' }).tunnelEnabled, false);
  assert.equal(loadConfig({ ...docker, CLAUDIO_TAILSCALE_MANAGED: '0' }).tailscaleManaged, false);

  assert.equal(loadConfig(base).tailscaleHostname, 'claudio');
  assert.equal(loadConfig({ ...base, CLAUDIO_TAILSCALE_HOSTNAME: ' Claudio-Lab ' }).tailscaleHostname, 'claudio-lab');
  // It goes to the CLI's argv: nothing that could read as a flag or leave the label
  for (const value of ['-x', 'a b', 'a.b', 'x-', 'a'.repeat(64)]) {
    assert.throws(() => loadConfig({ ...base, CLAUDIO_TAILSCALE_HOSTNAME: value }), /CLAUDIO_TAILSCALE_HOSTNAME/, value);
  }
});

test("the tunnel's Serve port is the setting's unless set, and a value that is not a port stops the start", () => {
  const base = { CLAUDE_CONFIG_DIR: join(scratch, 'switch', 'claude'), CLAUDIO_DATA_DIR: join(scratch, 'switch', 'data'), CLAUDIO_WORKSPACE_DIR: join(scratch, 'switch', 'workspace') };
  assert.equal(loadConfig(base).tunnelPort, null);
  assert.equal(loadConfig({ ...base, CLAUDIO_TUNNEL_PORT: '' }).tunnelPort, null);
  assert.equal(loadConfig({ ...base, CLAUDIO_TUNNEL_PORT: '10443' }).tunnelPort, 10443);
  for (const value of ['0', '65536', '84.43', 'https']) {
    assert.throws(() => loadConfig({ ...base, CLAUDIO_TUNNEL_PORT: value }), /CLAUDIO_TUNNEL_PORT/, value);
  }
  assert.equal(loadConfig(base).tailscaleBin, 'tailscale');
  assert.equal(loadConfig({ ...base, TAILSCALE_BIN: '/opt/tailscale/bin/tailscale' }).tailscaleBin, '/opt/tailscale/bin/tailscale');
});

test('two panels asking for MCP health at once share one connection check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-mcp-'));
  const log = join(root, 'invocations');
  const bin = join(root, 'claude');
  // Slow enough that the second caller arrives while the first check is still dialling
  const script = ['#!/bin/sh', `echo "$@" >> '${log}'`, 'sleep 0.3', "echo 'docs: https://example.com - ✔ Connected'", ''];
  writeFileSync(bin, script.join('\n'), { mode: 0o755 });
  const config = loadConfig({
    CLAUDE_BIN: bin,
    CSWAP_BIN: '/nonexistent/cswap',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
  });
  const mcp = new McpConfig(config);
  const scope = userScope(config);
  const runs = () => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('mcp list')).length;

  const [first, second] = await Promise.all([mcp.health(scope), mcp.health(scope)]);
  assert.deepEqual(first, [{ name: 'docs', status: 'connected', detail: 'Connected' }]);
  assert.deepEqual(second, first);
  assert.equal(runs(), 1);

  // Sharing lasts only while one is running: the panel that reopens later checks again
  await mcp.health(scope);
  assert.equal(runs(), 2);
});

test('workspace projects', async () => {
  const config = tempConfig();
  const workspace = new Workspace(config);
  const path = await workspace.create('my-app');
  assert.equal(path, join(config.workspaceDir, 'my-app'));
  assert.equal(statSync(path).isDirectory(), true);
  await assert.rejects(workspace.create('my-app'), /already exists/);
  await assert.rejects(workspace.create('../escape'), /invalid project name/);
  await assert.rejects(workspace.create('repo', 'file:///etc'), /invalid git url/);
  assert.equal(encodeProjectId('/home/me/My App (1)'), '-home-me-My-App--1-');
});

test('the provider homes inside the data directory are created, and no other', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-homes-'));
  const data = join(root, 'data');
  const elsewhere = join(root, 'elsewhere', 'glab');
  const homes = ensureProviderHomes({ GH_CONFIG_DIR: join(data, 'provider-homes', 'gh'), GLAB_CONFIG_DIR: join(data, 'provider-homes', 'glab') }, data);
  assert.deepEqual(homes, [join(data, 'provider-homes', 'gh'), join(data, 'provider-homes', 'glab')]);
  // gh and glab keep their host sign-ins there, so a fresh volume must have both folders too
  assert.ok(statSync(join(data, 'provider-homes', 'glab')).isDirectory());
  // The operator's own, a relative one and an empty one are left alone
  assert.deepEqual(ensureProviderHomes({ GLAB_CONFIG_DIR: elsewhere, GH_CONFIG_DIR: 'relative/path' }, data), []);
  assert.equal(existsSync(elsewhere), false);
  assert.deepEqual(ensureProviderHomes({ GH_CONFIG_DIR: '  ' }, data), []);
  // The data directory itself is not a provider home to make
  assert.deepEqual(ensureProviderHomes({ GH_CONFIG_DIR: data }, data), []);
});

test('loadConfig makes the provider homes the image points under the data directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-homes-'));
  const data = join(root, 'data');
  loadConfig({ CLAUDIO_DATA_DIR: data, CLAUDIO_WORKSPACE_DIR: join(root, 'ws'), GH_CONFIG_DIR: join(data, 'provider-homes', 'gh') });
  assert.ok(statSync(join(data, 'provider-homes', 'gh')).isDirectory());
});
