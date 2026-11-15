import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore, DEFAULT_ID } from '@claudio/accounts';
import { AccountOverlay } from '../src/account-overlay.ts';
import { removeChatExtrasConfigs } from '../src/chat-tools.ts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { buildArgs } from '../src/providers/claude-code/args.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import type { SessionLaunch } from '../src/providers/driver.ts';
import { tempConfig } from './helpers.ts';

// T3 of docs/plans/account-configuration-and-project-rules.md: a shared account's process gets the
// default's user servers, the project's local and trusted servers, and the `.mcp.json` approvals,
// through one non-strict `--mcp-config` and the one `--settings` (S3f, S4). Fixture state files only.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CHAT = '11111111-2222-4333-8444-555555555555';

const flagValues = (args: readonly string[], name: string): string[] =>
  args.flatMap((arg, at) => (arg === name ? [args[at + 1] ?? ''] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []));

const servers = (file: string): Record<string, unknown> => (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;

/** The default's state file and a trusted project whose remote server needs its `headersHelper` (B3) */
function fixture(stateFile: string, root: string, entry: Record<string, unknown> = { hasTrustDialogAccepted: true }): string {
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { analytics: { type: 'http', url: 'https://mcp.example.test/mcp', headersHelper: './helper.sh' }, linter: { command: 'lint-mcp' } } }));
  mkdirSync(join(stateFile, '..'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({
    mcpServers: { umami: { type: 'http', url: 'https://umami.example.test/mcp', headers: { Authorization: 'Bearer secret-token' } } },
    projects: { [proj]: { mcpServers: { mine: { command: 'local-mcp' } }, disabledMcpjsonServers: ['linter'], ...entry } },
  }));
  return proj;
}

function spec(cwd: string, more: Partial<SessionLaunch> = {}): SessionLaunch {
  return { id: CHAT, nativeId: null, created: false, forkFrom: null, name: 'n', cwd, permissionMode: 'manual', permissionPrompts: 'none', policy: null, account: { id: 'acc-1', kind: 'token', dir: '/accounts/acc-1', sharedConfig: true }, ...more };
}

test('the guard settings and an overlay file make one --settings flag, and hook events stay asked for', () => {
  const guarded = buildArgs({ ...spec('/p'), guard: { settingsPath: '/g.settings.json' }, settingsFile: '/o.settings.json' });
  assert.deepEqual(flagValues(guarded, '--settings'), ['/o.settings.json']);
  assert.ok(guarded.includes('--include-hook-events'));
  const plain = buildArgs({ ...spec('/p'), settingsFile: '/o.settings.json' });
  assert.deepEqual(flagValues(plain, '--settings'), ['/o.settings.json']);
  assert.equal(plain.includes('--include-hook-events'), false);
  assert.deepEqual(flagValues(buildArgs({ ...spec('/p'), guard: { settingsPath: '/g.settings.json' } }), '--settings'), ['/g.settings.json']);
});

test('a shared account gets one 0600 MCP file with the default servers and trusted project servers, never strict', () => {
  const config = tempConfig();
  const proj = fixture(config.globalConfigFile, config.workspaceDir);
  const overlay = new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile });
  const out = overlay.launch(spec(proj));
  assert.ok(out?.mcpConfig);
  assert.equal(out.mcpConfigAdds, true);
  assert.deepEqual(Object.keys(servers(out.mcpConfig)).sort(), ['analytics', 'mine', 'umami']);
  assert.equal(statSync(out.mcpConfig).mode & 0o777, 0o600);
  const args = buildArgs({ ...spec(proj), ...out });
  assert.equal(args.includes('--strict-mcp-config'), false, 'strict would drop the account\'s claude.ai connectors (S4)');
  assert.deepEqual(flagValues(args, '--mcp-config'), [out.mcpConfig]);
  assert.ok(out.settingsFile);
  assert.deepEqual(JSON.parse(readFileSync(out.settingsFile, 'utf8')), { disabledMcpjsonServers: ['linter'] });
  assert.equal(statSync(out.settingsFile).mode & 0o777, 0o600);
});

test('an untrusted project gives no .mcp.json server to the overlay', () => {
  const config = tempConfig();
  const proj = fixture(config.globalConfigFile, config.workspaceDir, {});
  const out = new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile }).launch(spec(proj));
  assert.deepEqual(Object.keys(servers(out?.mcpConfig ?? '')).sort(), ['mine', 'umami']);
});

test('the default account, an independent one, a chat that chose its servers and a confined chat get no overlay', () => {
  const config = tempConfig();
  const proj = fixture(config.globalConfigFile, config.workspaceDir);
  const overlay = new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile });
  assert.equal(overlay.launch(spec(proj, { account: { id: DEFAULT_ID, kind: 'login', dir: config.configDir } })), null);
  assert.equal(overlay.launch(spec(proj, { account: { id: 'acc-2', kind: 'token', dir: '/a' } })), null);
  assert.equal(overlay.launch(spec(proj, { mcpConfig: '/chosen.json' })), null);
  assert.equal(overlay.launch(spec(proj, { strictMcpConfig: true })), null);
  assert.equal(overlay.launch(spec(proj, { confine: { tools: [], settingSources: [] } })), null);
  assert.equal(new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile, enabled: false }).launch(spec(proj)), null);
});

test('what Claudio adds wins a shared name, and the guard keys win in the merged settings', () => {
  const config = tempConfig();
  const proj = fixture(config.globalConfigFile, config.workspaceDir);
  const base = join(config.dataDir, 'base.json');
  writeFileSync(base, JSON.stringify({ mcpServers: { claudio: { command: 'claudio-mcp' }, umami: { command: 'claudio-own' } } }));
  const guard = join(config.dataDir, 'guard.settings.json');
  writeFileSync(guard, JSON.stringify({ disableAllHooks: false, hooks: { PreToolUse: [] }, disabledMcpjsonServers: ['guard-wins'] }));
  const out = new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile }).launch(spec(proj, { mcpConfig: base, mcpConfigAdds: true, guard: { settingsPath: guard } }));
  const merged = servers(out?.mcpConfig ?? '');
  assert.deepEqual(merged.umami, { command: 'claudio-own' });
  assert.ok(merged.claudio && merged.analytics);
  assert.deepEqual(JSON.parse(readFileSync(out?.settingsFile ?? '', 'utf8')), { disabledMcpjsonServers: ['guard-wins'], disableAllHooks: false, hooks: { PreToolUse: [] } });
});

test('a guarded process whose guard file cannot be read keeps the guard file rather than a settings file without hooks', () => {
  const config = tempConfig();
  const proj = fixture(config.globalConfigFile, config.workspaceDir);
  const logs: string[] = [];
  const out = new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile, log: (m) => logs.push(m) }).launch(spec(proj, { guard: { settingsPath: join(config.dataDir, 'gone.json') } }));
  assert.equal(out?.settingsFile, undefined);
  assert.ok(out?.mcpConfig);
  assert.equal(logs.length, 1);
});

test('the overlay files of a chat are replaced at each spawn and removed with the chat', () => {
  const config = tempConfig();
  const proj = fixture(config.globalConfigFile, config.workspaceDir);
  const overlay = new AccountOverlay({ dataDir: config.dataDir, stateFile: config.globalConfigFile });
  overlay.launch(spec(proj));
  const listed = () => readdirSync(join(config.dataDir, 'mcp')).filter((name) => name.startsWith('overlay-'));
  const before = listed();
  assert.equal(before.length, 2);
  writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  overlay.launch(spec(proj));
  const after = listed();
  assert.equal(after.length, 2, 'the new MCP file replaced the old one');
  assert.equal(after.filter((name) => before.includes(name)).length, 1, 'the unchanged settings file is kept');
  assert.equal(removeChatExtrasConfigs(config.dataDir, (id) => id === CHAT), 2);
  assert.deepEqual(listed(), []);
});

test('a chat on a shared account spawns with the overlay, and the same chat on the default account without it', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const proj = fixture(config.globalConfigFile, config.workspaceDir);
  const db = new Db(config);
  const store = new AccountStore({ dataDir: config.dataDir, defaultDir: config.configDir, claude: FAKE_CLAUDE });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  chats.accounts = store;
  try {
    const argv = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((line) => line.split(' ').slice(1)) : []);
    // Alone, the default account takes the chat
    const onDefault = chats.start({ prompt: 'hello', name: 'default', cwd: proj });
    await chats.waitForResult(onDefault.id);
    const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
    const onShared = chats.start({ prompt: 'hello', name: 'shared', cwd: proj, account: a.id });
    await chats.waitForResult(onShared.id);
    assert.deepEqual([chats.get(onDefault.id)?.account, chats.get(onShared.id)?.account], [DEFAULT_ID, a.id]);
    const [plain, shared] = argv();
    assert.ok(shared && plain);
    const [file] = flagValues(shared, '--mcp-config');
    assert.deepEqual(Object.keys(servers(file ?? '')).sort(), ['analytics', 'mine', 'umami']);
    assert.equal(shared.includes('--strict-mcp-config'), false);
    assert.equal(flagValues(shared, '--settings').length, 1);
    assert.deepEqual(flagValues(plain, '--mcp-config'), []);
    assert.deepEqual(flagValues(plain, '--settings'), []);
    assert.equal(shared.join(' ').includes('secret-token'), false, 'a server\'s secret never goes in argv');
  } finally {
    chats.stopAll();
    db.close();
    delete process.env.FAKE_CLAUDE_SPAWNS;
  }
});
