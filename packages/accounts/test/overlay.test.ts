import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountStore, DEFAULT_ID } from '../src/index.ts';
import { buildOverlay, McpOverlay, projectKeyOf, readProjectServers, readStateConfig, ShapeError } from '../src/overlay.ts';

// The spawn-time overlay of a shared account (T3 of docs/plans/account-configuration-and-project-rules.md):
// what the default's state file says, turned into servers and settings. Fixture state files only.

const fresh = () => mkdtempSync(join(tmpdir(), 'claudio-overlay-'));

/** A repository with a `.mcp.json` holding a remote server with a `headersHelper` (B3) and a stdio one */
function repo(root: string, name = 'proj'): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      analytics: { type: 'http', url: 'https://mcp.example.test/mcp', headersHelper: './helper.sh' },
      linter: { command: 'lint-mcp' },
      shared: { command: 'from-project' },
    },
  }));
  return dir;
}

/** The keys the overlay reads, in the shapes CLI 2.1.322 writes them */
function stateDoc(project: string, entry: Record<string, unknown>): Record<string, unknown> {
  return {
    oauthAccount: { emailAddress: 'never-read@example.test' },
    numStartups: 3,
    mcpServers: {
      umami: { type: 'http', url: 'https://umami.example.test/mcp', headers: { Authorization: 'Bearer secret-token' } },
      shared: { command: 'from-user' },
      quiet: { command: 'quiet-mcp' },
    },
    projects: {
      [project]: { allowedTools: [], lastCost: 0.5, ...entry },
      '/somewhere/else': { hasTrustDialogAccepted: true, mcpServers: { elsewhere: { command: 'x' } } },
    },
  };
}

test('the state file is read for the configuration keys the overlay names, and nothing about identity', () => {
  const config = readStateConfig(stateDoc('/p', {
    hasTrustDialogAccepted: true,
    mcpServers: { mine: { command: 'local-mcp' } },
    enabledMcpjsonServers: ['linter'],
    disabledMcpjsonServers: ['shared'],
    disabledMcpServers: ['quiet'],
    enableAllProjectMcpServers: false,
    hasClaudeMdExternalIncludesApproved: true,
  }));
  assert.deepEqual(Object.keys(config.userServers), ['umami', 'shared', 'quiet']);
  assert.deepEqual(config.projects.get('/p'), {
    trusted: true,
    localServers: { mine: { command: 'local-mcp' } },
    enabledMcpjsonServers: ['linter'],
    disabledMcpjsonServers: ['shared'],
    disabledMcpServers: ['quiet'],
    enableAllProjectMcpServers: false,
    externalIncludesApproved: true,
  });
  assert.equal(JSON.stringify([...config.projects.values()]).includes('never-read'), false);
});

test('a state file whose configuration keys changed shape gives no configuration at all', () => {
  for (const doc of [
    null,
    [],
    { mcpServers: [] },
    { mcpServers: { umami: 'https://umami' } },
    { projects: [] },
    { projects: { '/p': true } },
    { projects: { '/p': { hasTrustDialogAccepted: 'yes' } } },
    { projects: { '/p': { disabledMcpServers: 'quiet' } } },
    { projects: { '/p': { mcpServers: { a: 1 } } } },
  ]) {
    assert.throws(() => readStateConfig(doc), ShapeError, JSON.stringify(doc));
  }
  // Absent keys are a fresh install, not a changed shape
  assert.deepEqual(readStateConfig({}).userServers, {});
});

test('a shared account gets the default user servers and, in a trusted project, its servers and local ones, less those turned off (B3, B4, B5)', () => {
  const root = fresh();
  const proj = repo(root);
  const state = readStateConfig(stateDoc(proj, {
    hasTrustDialogAccepted: true,
    mcpServers: { mine: { command: 'local-mcp' }, shared: { command: 'from-local' } },
    enabledMcpjsonServers: ['analytics'],
    disabledMcpjsonServers: ['linter'],
    disabledMcpServers: ['quiet'],
  }));
  const overlay = buildOverlay(state, proj, readProjectServers(proj).servers);
  assert.deepEqual(Object.keys(overlay.mcpServers).sort(), ['analytics', 'mine', 'shared', 'umami']);
  assert.equal(overlay.mcpServers.analytics?.headersHelper, './helper.sh', 'the project server travels whole, its helper included');
  assert.deepEqual(overlay.mcpServers.shared, { command: 'from-local' }, 'local over project over user, as the CLI ranks a repeated name');
  assert.equal('quiet' in overlay.mcpServers, false, 'a user server turned off for the project stays off');
  assert.equal('linter' in overlay.mcpServers, false, 'a project server turned off stays off');
  assert.deepEqual(overlay.settings, { enabledMcpjsonServers: ['analytics'], disabledMcpjsonServers: ['linter'] });
  assert.deepEqual(overlay.unsupplied, []);
});

test('an untrusted project gives its local servers but never its .mcp.json ones', () => {
  const root = fresh();
  const proj = repo(root);
  const state = readStateConfig(stateDoc(proj, { mcpServers: { mine: { command: 'local-mcp' } } }));
  const overlay = buildOverlay(state, proj, readProjectServers(proj).servers);
  assert.deepEqual(Object.keys(overlay.mcpServers).sort(), ['mine', 'quiet', 'shared', 'umami']);
  assert.deepEqual(overlay.mcpServers.shared, { command: 'from-user' });
});

test('a project server turned off with /mcp stays off when the account reads .mcp.json on its own', () => {
  const root = fresh();
  const proj = repo(root);
  const state = readStateConfig(stateDoc(proj, { hasTrustDialogAccepted: true, disabledMcpServers: ['analytics', 'quiet'] }));
  const overlay = buildOverlay(state, proj, readProjectServers(proj).servers);
  assert.equal('analytics' in overlay.mcpServers, false);
  assert.deepEqual(overlay.settings, { disabledMcpjsonServers: ['analytics'] }, 'only the project server goes to the settings key that governs .mcp.json');
});

test('an approval of external imports is named as the one thing no flag carries (S7)', () => {
  const root = fresh();
  const proj = repo(root);
  const state = readStateConfig(stateDoc(proj, { hasClaudeMdExternalIncludesApproved: true }));
  assert.deepEqual(buildOverlay(state, proj, {}).unsupplied, ['hasClaudeMdExternalIncludesApproved']);
});

test('a worktree and a subfolder of a trusted checkout find the checkout entry, its parent does not (S3d)', () => {
  const root = fresh();
  const proj = repo(root);
  const wt = join(root, 'wt');
  mkdirSync(join(proj, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(wt);
  writeFileSync(join(wt, '.git'), `gitdir: ${join(proj, '.git', 'worktrees', 'wt')}\n`);
  mkdirSync(join(proj, 'src'));
  assert.equal(projectKeyOf(proj), proj);
  assert.equal(projectKeyOf(join(proj, 'src')), proj);
  assert.equal(projectKeyOf(wt), proj);
  assert.equal(projectKeyOf(root), root);
});

test('the .mcp.json files are read from the working folder up to the checkout, the nearer winning', () => {
  const root = fresh();
  const proj = repo(root);
  mkdirSync(join(proj, 'pkg'));
  writeFileSync(join(proj, 'pkg', '.mcp.json'), JSON.stringify({ mcpServers: { linter: { command: 'nearer' } } }));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { outside: { command: 'outside-the-repo' } } }));
  const { servers } = readProjectServers(join(proj, 'pkg'));
  assert.deepEqual(servers.linter, { command: 'nearer' });
  assert.equal('outside' in servers, false);
});

test('the overlay is derived once per change of the state file, and a shape it does not know gives none, said once', () => {
  const root = fresh();
  const proj = repo(root);
  const stateFile = join(root, '.claude.json');
  const body = JSON.stringify(stateDoc(proj, { hasTrustDialogAccepted: true }));
  writeFileSync(stateFile, body);
  const stamp = new Date('2026-11-15T10:00:00Z');
  utimesSync(stateFile, stamp, stamp);
  const logs: string[] = [];
  const overlay = new McpOverlay({ stateFile, log: (m) => logs.push(m) });
  const first = overlay.for(proj);
  assert.ok(first?.mcpServers.analytics);

  // Same size and mtime, other bytes: a re-read would see `analytics` gone
  writeFileSync(stateFile, body.replace('"hasTrustDialogAccepted":true', '"hasTrustDialogAccepted":!!!!'));
  utimesSync(stateFile, stamp, stamp);
  assert.equal(statSync(stateFile).size, Buffer.byteLength(body));
  assert.equal(overlay.for(proj), first, 'unchanged stamp: the cached overlay, with no read');

  writeFileSync(stateFile, JSON.stringify({ ...stateDoc(proj, {}), mcpServers: ['renamed'] }));
  assert.equal(overlay.for(proj), null);
  assert.equal(overlay.for(join(proj, '.')), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /shape changed/);
  assert.equal(logs.join('').includes('secret-token'), false, 'no server definition reaches a log line');

  writeFileSync(stateFile, JSON.stringify(stateDoc(proj, {})));
  assert.deepEqual(Object.keys(overlay.for(proj)?.mcpServers ?? {}).sort(), ['quiet', 'shared', 'umami']);
  assert.ok(readFileSync(stateFile, 'utf8').includes('never-read'), 'the state file is only read');
});

test('a default with no state file and no project gives no overlay', () => {
  const root = fresh();
  assert.equal(new McpOverlay({ stateFile: join(root, 'missing.json') }).for(root), null);
  const stateFile = join(root, '.claude.json');
  writeFileSync(stateFile, JSON.stringify({ numStartups: 1 }));
  assert.equal(new McpOverlay({ stateFile }).for(root), null);
});

test('a shared account is marked for the overlay, and neither the default nor an independent account is', async () => {
  const root = fresh();
  const defaultDir = join(root, 'default');
  mkdirSync(defaultDir);
  writeFileSync(join(defaultDir, 'settings.json'), '{}');
  const store = new AccountStore({ dataDir: join(root, 'data'), defaultDir, claude: 'claude-not-run' });
  const a = await store.add({ kind: 'token', alias: 'alpha', secret: 'tok' });
  assert.equal(store.ref(a.id).sharedConfig, true);
  assert.equal(store.ref(DEFAULT_ID).sharedConfig, undefined);
  await store.setConfigMode(a.id, 'independent', 'empty');
  assert.equal(store.ref(a.id).sharedConfig, undefined);
});
