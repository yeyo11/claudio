import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectSuggestions, projectCandidates, suggestionExclusions, type SuggestionExclusions } from '../src/project-suggestions.ts';
import type { ProjectRecord, RepoLookup } from '../src/projects.ts';
import type { Place, RepoFacts } from '../src/repos.ts';

/** A world of real directories (so "gone" is decidable) under the OS temp dir, which the exclusions are told to ignore. */
const world = realpathSync(mkdtempSync(join(tmpdir(), 'claudio-suggest-')));
const dir = (...parts: string[]): string => {
  const path = join(world, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};

const home = dir('home', 'yeyo');
const workspace = dir('home', 'yeyo', 'Claudio-here', 'workspace');
const config = { configDir: dir('home', 'yeyo', '.claude'), dataDir: dir('data'), workspaceDir: workspace };
const lanes = join(config.dataDir, 'eval-lanes');
const exclusions = (): SuggestionExclusions => ({
  ...suggestionExclusions(config, lanes, home, { XDG_DATA_HOME: join(home, '.local', 'share') }),
  temp: [join(world, 'scratch')],
});

const remotes = new Map<string, string | null>();
const places = new Map<string, Place>();
const lookup: RepoLookup = {
  place: (d) => places.get(d) ?? { repo: null, exists: true, source: 'disk' },
  remoteOf: (commonDir) => remotes.get(commonDir) ?? null,
};

function facts(commonDir: string, mainCheckout: string, worktree: string | null = null): RepoFacts {
  return { commonDir, gitDir: null, mainCheckout, worktree, topLevel: worktree ?? mainCheckout, subdir: '', branch: null, detached: false, bare: false };
}
function inRepo(cwd: string, repo: RepoFacts): string {
  places.set(cwd, { repo, exists: true, source: 'disk' });
  return cwd;
}
const chat = (cwd: string, updatedAt = '2026-01-01T00:00:00Z') => ({ cwd, updatedAt });
const record = (id: string, path: string, repo: ProjectRecord['repo']): ProjectRecord => ({ id, name: id, path, repo });
const offered = (projects: ProjectRecord[], chats: ReturnType<typeof chat>[], hidden = new Set<string>()) =>
  projectCandidates(projects, chats, lookup, exclusions(), hidden);

test('the five noise directories of the owner are never suggested', () => {
  // $HOME, a folder holding repositories, this install's workspace, another install's, and a preview's
  const folder = dir('home', 'yeyo', 'Escritorio');
  const repo = dir('home', 'yeyo', 'Escritorio', 'claudio');
  const other = dir('home', 'yeyo', 'Agentry', 'workspace');
  const preview = dir('home', 'yeyo', '.local', 'share', 'claudio-preview', 'workspace');
  inRepo(repo, facts(join(repo, '.git'), repo));
  const noise = [home, folder, workspace, other, preview, dir('home', 'yeyo', 'Claudio', 'workspace')];

  const got = offered([], [...noise.map((d) => chat(d)), chat(repo)]);
  assert.deepEqual(
    got.map((c) => [c.kind, c.path]),
    [['repository', repo]],
  );
});

test('Claudio\'s own directories, scratch and a directory that is gone are never suggested; a child of the workspace is', () => {
  const inData = dir('data', 'eval-lanes', 'run', 'lane1');
  const inConfig = dir('home', 'yeyo', '.claude', 'projects');
  const scratch = dir('scratch', 'x');
  const child = dir('home', 'yeyo', 'Claudio-here', 'workspace', 'notes');
  const gone = join(world, 'gone', 'dir');
  const got = offered([], [chat(inData), chat(inConfig), chat(scratch), chat(gone), chat(child), chat(config.dataDir), chat('/')]);
  assert.deepEqual(got.map((c) => c.path), [child]);
});

test('a repository with chats in fourteen worktrees is one suggestion that counts them', () => {
  const main = dir('code', 'claudio');
  const common = join(main, '.git');
  remotes.set(common, 'https://user:secret@github.com/yeyo11/claudio.git');
  const chats = [chat(inRepo(main, facts(common, main)), '2026-02-01T00:00:00Z')];
  for (let i = 0; i < 14; i++) {
    const wt = dir('code', 'claudio', '.claude', 'worktrees', `w${i}`);
    chats.push(chat(inRepo(wt, facts(common, main, wt)), `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  }
  const [only, ...rest] = offered([], chats);
  assert.equal(rest.length, 0);
  assert.equal(only?.kind, 'repository');
  assert.equal(only?.path, main);
  assert.equal(only?.key, common);
  assert.equal(only?.chatCount, 15);
  assert.equal(only?.worktreeCount, 14);
  assert.equal(only?.lastActivity, '2026-02-01T00:00:00Z');
  assert.equal(only?.remote, 'https://github.com/yeyo11/claudio.git', 'credentials never leave');
  assert.ok(!JSON.stringify(only).includes('secret'));
});

test('a repository that already has a project is not suggested, even for chats outside its subdir', () => {
  const main = dir('code', 'mono');
  const common = join(main, '.git');
  const inside = dir('code', 'mono', 'packages', 'core');
  const outside = dir('code', 'mono', 'packages', 'web');
  inRepo(inside, { ...facts(common, main), subdir: 'packages/core' });
  inRepo(outside, { ...facts(common, main), subdir: 'packages/web' });
  const project = record('core', inside, { commonDir: common, subdir: 'packages/core', remote: null });
  assert.deepEqual(offered([project], [chat(inside), chat(outside)]), []);
});

test('another clone of a project\'s remote is suggested and names that project, credentials aside', () => {
  const mainA = dir('code', 'claudio');
  const mainB = dir('code', 'claudio-two');
  const commonA = join(mainA, '.git');
  const commonB = join(mainB, '.git');
  remotes.set(commonB, 'git@github.com:yeyo11/claudio.git');
  inRepo(mainB, facts(commonB, mainB));
  const project = record('p1', mainA, { commonDir: commonA, subdir: '', remote: 'https://tok:x@github.com/yeyo11/claudio' });
  const [got] = offered([project], [chat(mainB)]);
  assert.deepEqual(got?.sameRemoteAs, { id: 'p1', name: 'p1' });
  assert.ok(!JSON.stringify(got).includes('tok'));
});

test('plain directories are a second, short group after the repositories, at most 5, and a folder holding a repository is left out', () => {
  const holder = dir('stuff');
  const main = dir('stuff', 'app');
  inRepo(main, facts(join(main, '.git'), main));
  const plain = Array.from({ length: 7 }, (_, i) => dir('plain', `d${i}`));
  const got = offered([], [chat(holder), chat(main), ...plain.map((p) => chat(p))]);
  assert.equal(got[0]?.kind, 'repository');
  const dirs = got.filter((c) => c.kind === 'directory');
  assert.equal(dirs.length, 5);
  assert.ok(dirs.every((c) => c.remote === null && c.worktreeCount === 0 && c.sameRemoteAs === null));
  assert.ok(!got.some((c) => c.path === holder));
});

test('at most 8 repositories, the busiest first', () => {
  const chats: ReturnType<typeof chat>[] = [];
  for (let i = 0; i < 10; i++) {
    const main = dir('many', `r${i}`);
    inRepo(main, facts(join(main, '.git'), main));
    for (let n = 0; n <= i; n++) chats.push(chat(main));
  }
  const got = offered([], chats);
  assert.equal(got.length, 8);
  assert.deepEqual(got.map((c) => c.chatCount), [10, 9, 8, 7, 6, 5, 4, 3]);
});

test('$XDG_DATA_HOME/<app>/workspace is another install\'s unless it is a repository', () => {
  const noise = dir('home', 'yeyo', '.local', 'share', 'someapp', 'workspace');
  const repo = dir('home', 'yeyo', '.local', 'share', 'repoapp', 'workspace');
  inRepo(repo, facts(join(repo, '.git'), repo));
  assert.deepEqual(offered([], [chat(noise), chat(repo)]).map((c) => c.path), [repo]);
});

test('a hidden key stays hidden across a restart, and shows again once undone', async () => {
  const main = dir('hide', 'repo');
  const common = join(main, '.git');
  inRepo(main, facts(common, main));
  const plain = dir('hide', 'plain');
  const data = dir('hide-data');

  const first = new ProjectSuggestions({ dataDir: data });
  await first.hide(common);
  await first.hide(common);
  await first.hide(plain);
  const restarted = new ProjectSuggestions({ dataDir: data });
  assert.deepEqual(offered([], [chat(main), chat(plain)], restarted.hidden()), []);
  const doc = JSON.parse(readFileSync(join(data, 'project-suggestions.json'), 'utf8')) as { hidden: { key: string; at: string }[] };
  assert.deepEqual(doc.hidden.map((h) => h.key), [common, plain], 'idempotent, with the time it was hidden');

  await restarted.unhide(common);
  assert.deepEqual(offered([], [chat(main), chat(plain)], restarted.hidden()).map((c) => c.key), [common]);
});
