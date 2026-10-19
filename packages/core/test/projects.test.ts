import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../src/index.ts';
import { attachProject, projectCandidates, ProjectPathError, ProjectStore, type ProjectRecord, type RepoLookup } from '../src/projects.ts';
import { RepoIndex, type Place, type RepoFacts } from '../src/repos.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);
const project = (id: string, path: string, repo: ProjectRecord['repo'] = null): ProjectRecord => ({ id, name: id, path, repo });
const loose: Place = { repo: null, exists: true, source: 'disk' };
/** A placement in a repository, for the pure tests: only what attaching reads matters */
const inRepo = (commonDir: string, subdir: string, worktree: string | null = null): Place => ({
  repo: { commonDir, gitDir: null, mainCheckout: '/main', worktree, topLevel: worktree ?? '/main', subdir, branch: null, detached: false, bare: false } satisfies RepoFacts,
  exists: true,
  source: 'disk',
});
/** A lookup that knows no repository at all: every directory is plain */
const plain: RepoLookup = { place: (dir) => ({ repo: null, exists: existsSync(dir), source: 'disk' }), remoteOf: () => null };
const index = (): RepoLookup => new RepoIndex();

test('a directory belongs to the deepest project that holds it, and to none when no project does', () => {
  const projects = [project('app', '/work/app'), project('api', '/work/app/apps/api'), project('two', '/work/app-two')];
  const idOf = (dir: string) => attachProject(projects, dir, loose)?.id ?? null;

  assert.equal(idOf('/work/app'), 'app');
  assert.equal(idOf('/work/app/packages/core'), 'app');
  assert.equal(idOf('/work/app/apps/api/src'), 'api');
  // A shared prefix is not a shared directory
  assert.equal(idOf('/work/app-two/src'), 'two');
  assert.equal(idOf('/work/app-three'), null);
  assert.equal(idOf('/elsewhere'), null);
  assert.equal(idOf(''), null);
});

test("a directory in a repository belongs to that repository's project, wherever the checkout is", () => {
  const app = project('app', '/work/app', { commonDir: '/work/app/.git', subdir: '', remote: null });
  const other = project('other', '/work/other', { commonDir: '/work/other/.git', subdir: '', remote: null });
  // A linked worktree far away, and one that happens to sit inside another project's directory
  assert.equal(attachProject([app, other], '/tmp/wt/src', inRepo('/work/app/.git', 'src', '/tmp/wt'))?.id, 'app');
  assert.equal(attachProject([app, other], '/work/other/wt', inRepo('/work/app/.git', '', '/work/other/wt'))?.id, 'app');
  // A repository nobody imported: where it lives decides, as for any directory
  assert.equal(attachProject([app, other], '/work/other/vendor/lib', inRepo('/work/other/vendor/lib/.git', ''))?.id, 'other');
  assert.equal(attachProject([app], '/tmp/solo', inRepo('/work/solo/.git', '', '/tmp/solo')), null);
});

test('in a monorepo the project whose subdir holds the directory wins, and the rest of the repository stays loose', () => {
  const common = '/work/mono/.git';
  const core = project('core', '/work/mono/packages/core', { commonDir: common, subdir: 'packages/core', remote: null });
  const lib = project('lib', '/work/mono/packages/core/lib', { commonDir: common, subdir: 'packages/core/lib', remote: null });
  const holder = project('holder', '/work');
  const all = [core, lib, holder];
  assert.equal(attachProject(all, '/tmp/wt/packages/core/src', inRepo(common, 'packages/core/src', '/tmp/wt'))?.id, 'core');
  assert.equal(attachProject(all, '/work/mono/packages/core/lib/x', inRepo(common, 'packages/core/lib/x'))?.id, 'lib');
  // `packages/corex` is not under `packages/core`; and a repository with a project never falls to a holder by path
  assert.equal(attachProject(all, '/work/mono/packages/corex', inRepo(common, 'packages/corex')), null);
  assert.equal(attachProject(all, '/work/mono/packages/web', inRepo(common, 'packages/web')), null);
});

test('candidates are the busiest directories not imported, worktrees counted for their main checkout, scratch and missing ones left out', () => {
  // Real directories outside the OS temp dir, which is what marks a directory as scratch
  const here = import.meta.dirname;
  const parent = dirname(here);
  const grand = dirname(parent);
  const chat = (cwd: string, updatedAt: string) => ({ cwd, updatedAt });
  const placeOf = (dir: string): Place =>
    dir.startsWith('/tmp/parent-wt') ? { ...inRepo('/x/.git', '', '/tmp/parent-wt'), repo: { ...(inRepo('/x/.git', '').repo as RepoFacts), mainCheckout: parent, worktree: '/tmp/parent-wt' } } : loose;

  const offered = projectCandidates(
    [],
    [chat(here, '2026-01-01'), chat(here, '2026-01-02'), chat(parent, '2026-01-03'), chat('/tmp/parent-wt/src', '2026-01-04'), chat('/does/not/exist', '2026-01-06')],
    placeOf,
  );
  assert.deepEqual(
    offered.map((c) => [c.path, c.chatCount, c.lastActivity]),
    [
      [parent, 2, '2026-01-04'],
      [here, 2, '2026-01-02'],
    ],
  );
  assert.deepEqual(projectCandidates([project('grand', grand)], [chat(here, 'a'), chat(parent, 'b')], () => loose), []);
  assert.equal(projectCandidates([], [chat(here, 'a'), chat(parent, 'b')], () => loose, 1).length, 1);
});

test('the store keeps imported projects in a versioned JSON document, across restarts', async () => {
  const config = tempConfig();
  const dir = mkdtempSync(join(tmpdir(), 'claudio-proj-'));
  const store = new ProjectStore(config);
  assert.deepEqual(store.list(), []);

  const added = await store.add({ path: dir }, plain);
  assert.equal(added.path, dir);
  assert.equal(added.repo, null, 'a directory in no repository is a project by its path alone');
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  await assert.rejects(store.add({ path: dir }, plain), (err: unknown) => err instanceof ProjectPathError && err.statusCode === 409 && err.reason === 'already-a-project');
  await assert.rejects(store.add({ path: join(dir, 'missing') }, plain), /not a directory/);
  await assert.rejects(store.add({ path: '' }, plain), /path is required/);

  const renamed = await store.rename(added.id, '  Shop  ');
  assert.equal(renamed.name, 'Shop');
  await assert.rejects(store.rename(added.id, '   '), /name is required/);
  await assert.rejects(store.rename('nope', 'x'), /project not found/);

  assert.equal((JSON.parse(readFileSync(join(config.dataDir, 'projects.json'), 'utf8')) as { version: number }).version, 2);
  const reloaded = new ProjectStore(config);
  assert.deepEqual(reloaded.list(), [{ id: added.id, name: 'Shop', path: dir, repo: null }]);
  await reloaded.remove(added.id);
  await assert.rejects(reloaded.remove(added.id), /project not found/);
  assert.deepEqual(new ProjectStore(config).list(), []);
});

test('a directory that is or holds the Claude config dir cannot be imported', async () => {
  const config = tempConfig();
  const store = new ProjectStore(config);
  mkdirSync(config.configDir, { recursive: true });
  const holder = dirname(config.configDir);

  await assert.rejects(store.add({ path: holder }, plain), /Claude configuration directory/);
  await assert.rejects(store.add({ path: config.configDir }, plain), /Claude configuration directory/);
  assert.deepEqual(store.list(), []);
});

const gitIn = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=a', '-c', 'user.email=a@b', ...a], { stdio: 'pipe' });

/** A repository with one commit and a `sub/` directory, real path, under the run's temp dir. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claudio-repo-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'f'), 'x');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('a path anywhere inside a linked worktree is refused, naming the main checkout and the same subdirectory', async () => {
  const store = new ProjectStore(tempConfig());
  const root = repo();
  const wt = `${root}-feature`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'feature', wt);
  for (const [path, instead] of [
    [wt, root],
    [join(wt, 'sub'), join(root, 'sub')],
  ] as const) {
    await assert.rejects(
      store.add({ path }, index()),
      (err: unknown) => err instanceof ProjectPathError && err.statusCode === 400 && err.reason === 'linked-worktree' && err.detail === instead && err.message.includes(`import ${instead} instead`),
    );
  }
  assert.deepEqual(store.list(), []);

  // A repository and subdir already imported are refused by what they are, not by the path typed
  const imported = await store.add({ path: join(root, 'sub') }, index());
  assert.deepEqual(imported.repo, { commonDir: join(root, '.git'), subdir: 'sub', remote: null });
  await assert.rejects(store.add({ path: join(root, 'sub', '.') }, index()), (err: unknown) => err instanceof ProjectPathError && err.reason === 'already-a-project' && err.detail === imported.id);
  // Another subdir of the same repository is another project (a monorepo)
  assert.equal((await store.add({ path: root }, index())).repo?.subdir, '');
});

test('a v1 document gains the repository of each record once, keeping ids and paths, and missing paths stay unresolved', async () => {
  const config = tempConfig();
  const root = repo();
  const wt = `${root}-wt`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  const loosePath = mkdtempSync(join(tmpdir(), 'claudio-plain-'));
  const missing = join(tmpdir(), 'claudio-gone-drive', 'proj');
  const file = join(config.dataDir, 'projects.json');
  mkdirSync(config.dataDir, { recursive: true });
  const v1 = {
    projects: [
      { id: 'a', name: 'Root', path: root },
      { id: 'b', name: 'In a worktree', path: join(wt, 'sub') },
      { id: 'c', name: 'Plain', path: loosePath },
      { id: 'd', name: 'Unmounted', path: missing },
    ],
  };
  writeFileSync(file, JSON.stringify(v1));

  const store = new ProjectStore(config, new RepoIndex());
  const written = JSON.parse(readFileSync(file, 'utf8')) as { version: number; projects: ProjectRecord[] };
  assert.equal(written.version, 2);
  assert.deepEqual(
    written.projects.map((p) => [p.id, p.name, p.path]),
    v1.projects.map((p) => [p.id, p.name, p.path]),
    'nothing dropped, renamed or moved: a project inside a worktree keeps its path until the person re-points it',
  );
  assert.deepEqual(store.get('a')?.repo, { commonDir: join(root, '.git'), subdir: '', remote: null });
  assert.deepEqual(store.get('b')?.repo, { commonDir: join(root, '.git'), subdir: 'sub', remote: null });
  assert.equal(store.get('c')?.repo, null);
  assert.equal(store.get('d')?.repo, null);

  // An older Claudio reads what it knows of each record
  for (const p of written.projects) assert.ok(typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string');

  // Once migrated, a start writes nothing; the drive that comes back is resolved on the next one
  const before = readFileSync(file, 'utf8');
  new ProjectStore(config, new RepoIndex());
  assert.equal(readFileSync(file, 'utf8'), before);
  mkdirSync(missing, { recursive: true });
  gitIn(missing, 'init', '-q');
  assert.equal(new ProjectStore(config, new RepoIndex()).get('d')?.repo?.commonDir, join(realpathSync(missing), '.git'));
  rmSync(join(tmpdir(), 'claudio-gone-drive'), { recursive: true, force: true });
});

const writeTranscript = (projectsDir: string, cwd: string, id: string, at: string, extra: object[] = []) => {
  const dir = join(projectsDir, encodeProjectId(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), [line({ type: 'user', uuid: '1', timestamp: at, cwd, message: { role: 'user', content: `go ${id}` } }), ...extra.map(line)].join('\n'));
};

test('importing adopts the chats already there, worktrees included; removing lets them go loose again', async () => {
  const config = tempConfig();
  const root = repo();
  const wt = `${root}-feature`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const stray = mkdtempSync(join(tmpdir(), 'claudio-stray-'));

  writeTranscript(config.projectsDir, root, 'in-root', '2026-01-01T10:00:00Z');
  writeTranscript(config.projectsDir, join(root, 'sub'), 'in-sub', '2026-01-02T10:00:00Z');
  writeTranscript(config.projectsDir, wt, 'in-worktree', '2026-01-03T10:00:00Z');
  writeTranscript(config.projectsDir, stray, 'stray', '2026-01-04T10:00:00Z');

  const core = new Core(config);
  const chatsIn = (id: string | null) => core.chats.list({ project: id, origins: ['claudio', 'external'] });
  try {
    assert.deepEqual(await core.projects(), [], 'nothing is a project until it is imported');
    assert.equal((await chatsIn(null)).length, 4);

    await assert.rejects(core.importProject({ path: wt }), /git worktree of .*; import .* instead/);
    const imported = await core.importProject({ path: root, name: 'Shop' });
    assert.equal(imported.name, 'Shop');
    assert.equal(imported.exists, true);
    assert.equal(imported.chatCount, 3);
    assert.equal(imported.lastActivity, '2026-01-03T10:00:00Z');
    assert.deepEqual(imported.repo, { commonDir: join(root, '.git'), mainCheckout: root, subdir: '', remote: null, bare: false });
    assert.equal(imported.insideWorktreeOf, null);
    assert.deepEqual(
      imported.worktrees.map((w) => [w.path, w.main, w.branch, w.chatCount, w.createdBy]),
      [
        [root, true, 'main', 2, null],
        [wt, false, 'feature', 1, null],
      ],
    );

    // The worktree is not a project of its own
    assert.deepEqual((await core.projects()).map((p) => p.path), [root]);
    assert.deepEqual((await chatsIn(imported.id)).map((c) => c.id).sort(), ['in-root', 'in-sub', 'in-worktree']);
    assert.deepEqual((await chatsIn(null)).map((c) => c.id), ['stray']);
    assert.deepEqual(await chatsIn('nope'), [], 'a project that does not exist holds nothing');

    // What a chat resolves to
    assert.deepEqual(core.projectOf(join(root, 'sub')), { project: { id: imported.id, name: 'Shop' }, worktree: null });
    assert.deepEqual(core.projectOf(join(wt, 'sub')), { project: { id: imported.id, name: 'Shop' }, worktree: { path: wt, name: wt.split('/').pop(), branch: 'feature', exists: true } });
    assert.equal(core.projectOf(stray).project, null);

    // Only the imported project is offered to Config and Memory, under its own id
    assert.deepEqual((await core.memoryOverview()).map((m) => [m.projectId, m.projectName]), [[imported.id, 'Shop']]);

    // Removing is harmless: the chats are still there, loose again
    await core.removeProject(imported.id);
    assert.deepEqual(await core.projects(), []);
    assert.equal((await chatsIn(null)).length, 4);
  } finally {
    // The whole Core: with only its database closed, its timers go on querying it while the file runs
    core.shutdown();
    await core.restored;
  }
});

test('worktrees list who made them, hide removed ones and count the chats that ran there', async () => {
  const config = tempConfig();
  const root = repo();
  const byItem = join(root, '.claude', 'worktrees', 'task-shop-1');
  const byChat = join(root, '.claude', 'worktrees', 'chatty');
  const byHand = `${root}-hand`;
  const removed = join(root, '.claude', 'worktrees', 'gone');
  gitIn(root, 'worktree', 'add', '-q', '-b', 'claudio-task/SHOP-1', byItem);
  gitIn(root, 'worktree', 'add', '-q', '-b', 'worktree-chatty', byChat);
  gitIn(root, 'worktree', 'add', '-q', '--detach', byHand);
  gitIn(root, 'worktree', 'lock', '--reason', 'busy', byHand);
  gitIn(root, 'worktree', 'add', '-q', '-b', 'worktree-gone', removed);
  writeTranscript(config.projectsDir, byChat, 'made-it', '2026-01-01T10:00:00Z', [
    { type: 'worktree-state', worktreeSession: { originalCwd: root, worktreePath: byChat, worktreeName: 'chatty', worktreeBranch: 'worktree-chatty' } },
  ]);
  writeTranscript(config.projectsDir, removed, 'in-gone', '2026-01-02T10:00:00Z');
  writeTranscript(config.projectsDir, join(removed, 'sub'), 'in-gone-sub', '2026-01-03T10:00:00Z');
  rmSync(removed, { recursive: true, force: true });

  const core = new Core(config);
  try {
    const project = await core.importProject({ path: root, name: 'Shop' });
    const item = core.workItems.create(project.id, { title: 'Cart', status: 'todo', type: 'task' });
    core.workItems.setWorktree(item.id, { worktree: byItem, branch: 'claudio-task/SHOP-1' });
    const listed = (await core.projects())[0];
    assert.ok(listed);
    const rows = Object.fromEntries(listed.worktrees.map((w) => [w.path, w]));
    assert.deepEqual(Object.keys(rows).sort(), [root, byItem, byChat, byHand].sort(), 'a removed worktree is never offered as a place to work');
    assert.equal(listed.worktrees[0]?.path, root, 'the main checkout comes first');
    assert.deepEqual(rows[byItem]?.createdBy, { kind: 'work-item', key: item.key, title: 'Cart' });
    assert.deepEqual(rows[byChat]?.createdBy, { kind: 'chat', chatId: 'made-it', title: 'go made-it' });
    assert.equal(rows[byChat]?.chatCount, 1);
    assert.equal(rows[byHand]?.createdBy, null);
    assert.equal(rows[byHand]?.detached, true);
    assert.equal(rows[byHand]?.locked, 'busy');
    assert.equal(listed.removedWorktrees, 1, 'two chats, one removed worktree');
    assert.equal(listed.chatCount, 3);
    const gone = (await core.chats.list({ project: project.id, origins: ['claudio', 'external'] })).find((c) => c.id === 'in-gone');
    assert.deepEqual(gone?.worktree, { path: removed, name: 'gone', branch: 'worktree-gone', exists: false });
  } finally {
    core.shutdown();
    await core.restored;
  }
});

test('a project renamed or removed is remembered by the next start', async () => {
  const config = tempConfig();
  const dir = mkdtempSync(join(tmpdir(), 'claudio-proj-'));
  const first = new Core(config);
  const { id } = await first.importProject({ path: dir });
  await first.updateProject(id, { name: 'Renamed' });
  first.db.close();

  const second = new Core(config);
  assert.deepEqual((await second.projects()).map((p) => [p.id, p.name, p.chatCount]), [[id, 'Renamed', 0]]);
  second.db.close();
});

/** A v1 `projects.json` holding one project whose path lies inside a linked worktree, as the leak left them. */
function seedInsideWorktree(config: ReturnType<typeof tempConfig>, root: string, wt: string, id = 'in-wt'): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'projects.json'), JSON.stringify({ projects: [{ id, name: 'Shop', path: join(wt, 'sub') }] }));
}

test('re-pointing a project from a linked worktree keeps its id, chats and work items, and a later re-import finds it by the new path', async () => {
  const config = tempConfig();
  const root = repo();
  const wt = `${root}-stage`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'stage', wt);
  seedInsideWorktree(config, root, wt);
  writeTranscript(config.projectsDir, join(wt, 'sub'), 'old-chat', '2026-01-01T10:00:00Z');
  writeTranscript(config.projectsDir, join(root, 'sub'), 'main-chat', '2026-01-02T10:00:00Z');

  const core = new Core(config);
  try {
    const [before] = await core.projects();
    assert.equal(before?.insideWorktreeOf, join(root, 'sub'));
    const item = core.workItems.create('in-wt', { title: 'Stay', status: 'todo', type: 'task' });

    const events: Array<{ type: string; changes?: string[] }> = [];
    core.events.subscribe((e) => events.push(e as { type: string; changes?: string[] }));
    const after = await core.updateProject('in-wt', { path: join(root, 'sub') });
    assert.equal(after.id, 'in-wt');
    assert.equal(after.path, join(root, 'sub'));
    assert.equal(after.insideWorktreeOf, null);
    assert.equal(after.repo?.subdir, 'sub');
    assert.ok(events.some((e) => e.type === 'project.updated' && e.changes?.includes('path')));
    assert.deepEqual((await core.chats.list({ project: 'in-wt', origins: ['claudio', 'external'] })).map((c) => c.id).sort(), ['main-chat', 'old-chat']);
    assert.equal(core.workItems.get(item.id)?.projectId, 'in-wt');
    assert.ok(existsSync(wt), 'the worktree it pointed at is not touched');

    // Removed and imported again from the new path, it takes its id back
    await core.removeProject('in-wt');
    assert.equal((await core.importProject({ path: join(root, 'sub') })).id, 'in-wt');
  } finally {
    core.shutdown();
    await core.restored;
  }
});

test('re-pointing refuses another repository, a linked worktree, a project in no repository, a path another project is, and a missing directory', async () => {
  const config = tempConfig();
  const root = repo();
  const other = repo();
  const wt = `${root}-stage`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'stage', wt);
  const loosePath = mkdtempSync(join(tmpdir(), 'claudio-plain-'));
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    join(config.dataDir, 'projects.json'),
    JSON.stringify({ projects: [{ id: 'in-wt', name: 'Shop', path: wt }, { id: 'main', name: 'Main', path: join(root, 'sub') }, { id: 'plain', name: 'Plain', path: loosePath }] }),
  );
  const core = new Core(config);
  const refused = (id: string, path: string, code: string, status: number) =>
    assert.rejects(core.updateProject(id, { path }), (err: unknown) => err instanceof ProjectPathError && err.reason === code && err.statusCode === status);
  try {
    await refused('in-wt', other, 'other-repository', 400);
    await refused('in-wt', join(wt, 'sub'), 'linked-worktree', 400);
    await refused('plain', root, 'not-a-repository', 400);
    await refused('in-wt', join(root, 'sub'), 'already-a-project', 409);
    await refused('in-wt', join(root, 'nope'), 'not-a-directory', 400);
    assert.equal((await core.projects()).find((p) => p.id === 'in-wt')?.path, wt, 'nothing was written');
    assert.equal((await core.updateProject('in-wt', { path: root })).path, root);
  } finally {
    core.shutdown();
    await core.restored;
  }
});

test('a project whose worktree was removed is re-pointed through where that worktree was placed', async () => {
  const config = tempConfig();
  const root = repo();
  const wt = `${root}-stage`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'stage', wt);
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'projects.json'), JSON.stringify({ projects: [{ id: 'in-wt', name: 'Shop', path: wt }] }));
  const first = new Core(config);
  // Seen once while it was there, so its placement is on record
  assert.ok((await first.projects())[0]?.repo);
  first.shutdown();
  await first.restored;
  gitIn(root, 'worktree', 'remove', '--force', wt);

  const core = new Core(config);
  try {
    assert.equal((await core.updateProject('in-wt', { path: root })).path, root);
  } finally {
    core.shutdown();
    await core.restored;
  }
});

test('a removed project comes back with its id when its repository is imported from the main checkout, though its old path was a worktree', async () => {
  const config = tempConfig();
  const root = repo();
  const wt = `${root}-stage`;
  gitIn(root, 'worktree', 'add', '-q', '-b', 'stage', wt);
  seedInsideWorktree(config, root, wt);
  const core = new Core(config);
  try {
    await core.projectSettings('in-wt');
    await core.removeProject('in-wt');
    assert.equal((await core.importProject({ path: join(root, 'sub') })).id, 'in-wt');
  } finally {
    core.shutdown();
    await core.restored;
  }
});
