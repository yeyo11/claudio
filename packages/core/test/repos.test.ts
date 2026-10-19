import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { worktrees } from '../src/git.ts';
import { bareImportPath, parseRepo, repoGit, repoOf, stripCredentials, worktreesOf } from '../src/repos.ts';

/** git's answers for one fixture directory, as `fixtures/repos/make.sh` records them. */
interface Expected {
  dir: string;
  commonDir: string | null;
  gitDir: string | null;
  topLevel: string | null;
  prefix: string | null;
  bare: boolean | null;
  worktrees: Array<{ path: string; branch: string | null; detached: boolean; bare: boolean; locked: string | null; prunable: boolean }>;
}

// Built once for the file: every layout git documents, and git's own answers in the same git
const root = mkdtempSync(join(tmpdir(), 'claudio-repos-'));
execFileSync('bash', [join(import.meta.dirname, 'fixtures', 'repos', 'make.sh'), root], { stdio: 'pipe' });
const expected = (JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) as { dirs: Expected[] }).dirs;
const at = (p: string | null) => (p === null ? null : p.replace('<root>', root));
after(() => rmSync(root, { recursive: true, force: true }));

test('the parser reads every layout the way git does, without asking git', () => {
  let spawns = 0;
  const run = repoGit.run;
  repoGit.run = (cwd, args) => {
    spawns += 1;
    return run(cwd, args);
  };
  try {
    for (const e of expected) {
      const facts = parseRepo(join(root, e.dir));
      assert.notEqual(typeof facts, 'symbol', `${e.dir}: the parser could not decide`);
      if (typeof facts === 'symbol') continue;
      if (e.commonDir === null) {
        assert.equal(facts, null, `${e.dir} is in no repository`);
        continue;
      }
      assert.ok(facts, `${e.dir} is in a repository`);
      assert.equal(facts.commonDir, at(e.commonDir), `${e.dir}: common dir`);
      assert.equal(facts.gitDir, at(e.gitDir), `${e.dir}: git dir`);
      assert.equal(facts.topLevel, at(e.topLevel), `${e.dir}: top level`);
      if (e.prefix !== null) assert.equal(facts.subdir, e.prefix, `${e.dir}: subdir`);
      assert.equal(facts.bare, e.bare, `${e.dir}: bare`);
      // A linked worktree is the checkout whose git dir is not the common one
      assert.equal(facts.worktree, e.gitDir !== e.commonDir ? at(e.topLevel) : null, `${e.dir}: linked worktree`);
    }
    assert.equal(spawns, 0, 'the parser decided every layout on its own');
  } finally {
    repoGit.run = run;
  }
});

test("a repository's checkouts are git's list, with the main checkout git misnames for a separate git dir and a submodule", () => {
  for (const e of expected) {
    if (!e.commonDir || !e.worktrees.length) continue;
    const facts = repoOf(join(root, e.dir));
    assert.ok(facts);
    const ours = worktreesOf(facts.commonDir, facts.mainCheckout);
    const theirs = e.worktrees.map((w) => ({ ...w, path: at(w.path) ?? '' }));
    // git names the git dir as the main worktree in these two layouts; the checkout is what a person opens
    const [main, ...linked] = theirs;
    if (e.dir.startsWith('sep') || e.dir === 'super/mod' || e.dir.startsWith('super/mod/') || e.dir.startsWith('mod-wt')) {
      if (main) main.path = facts.mainCheckout ?? main.path;
    }
    const expectedList = facts.mainCheckout === null && !main?.bare ? linked : theirs;
    assert.deepEqual(
      ours.map((w) => ({ path: w.path, branch: w.branch, detached: w.detached, bare: w.bare, locked: w.locked, prunable: w.prunable })),
      expectedList,
      `${e.dir}: worktree list`,
    );
  }
});

test("git's own list, parsed, says what the oracle recorded: bare, detached and prunable included", () => {
  const theirs = expected.find((e) => e.dir === 'plain')?.worktrees ?? [];
  assert.deepEqual(
    worktrees(join(root, 'plain')).map((w) => ({ ...w, path: w.path.replace(root, '<root>') })),
    theirs,
  );
  assert.deepEqual(worktrees(join(root, 'named.git')).map((w) => w.bare), [true, false]);
});

test('the main checkout is named for every layout that has one', () => {
  const main = (dir: string) => repoOf(join(root, dir))?.mainCheckout;
  assert.equal(main('plain-beside/sub'), join(root, 'plain'));
  assert.equal(main('plain/.claude/worktrees/cli-wt'), join(root, 'plain'));
  assert.equal(main('plain-from-beside'), join(root, 'plain'), 'added from another linked worktree, still a child of the main one');
  assert.equal(main('sep-work/sub'), join(root, 'sep-work'));
  assert.equal(main('sep-wt'), null, 'nothing on disk names the checkout of a separate git dir from its worktree');
  assert.equal(main('mod-wt'), join(root, 'super', 'mod'), "a submodule's core.worktree names its checkout");
  assert.equal(main('bare-layout/main-wt'), null);
  assert.equal(main('rel-wt/sub/dir'), join(root, 'rel'));
});

test('a bare repository is imported from the folder that holds it in the .bare layout, else from itself', () => {
  const layout = repoOf(join(root, 'bare-layout'));
  assert.equal(layout?.bare, true);
  assert.equal(bareImportPath(layout?.commonDir ?? ''), join(root, 'bare-layout'));
  const named = repoOf(join(root, 'named.git'));
  assert.equal(bareImportPath(named?.commonDir ?? ''), join(root, 'named.git'));
  assert.equal(repoOf(join(root, 'named-wt'))?.commonDir, named?.commonDir, "a bare repository's worktrees group under it");
});

test('what the parser cannot read is asked of git', () => {
  let spawns = 0;
  const run = repoGit.run;
  repoGit.run = (cwd, args) => {
    spawns += 1;
    return run(cwd, args);
  };
  try {
    // A `.git` file that says nothing git-shaped: git has the last word, and a refusal is an unknown,
    // never "no repository", or a list would call a broken checkout a loose directory
    const odd = mkdtempSync(join(tmpdir(), 'claudio-odd-'));
    writeFileSync(join(odd, '.git'), 'not a pointer\n');
    assert.equal(typeof parseRepo(odd), 'symbol');
    assert.equal(repoOf(odd), undefined);
    assert.ok(spawns >= 1);
  } finally {
    repoGit.run = run;
  }
});

test('a remote never carries what signs in with it', () => {
  assert.equal(stripCredentials('https://user:secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(stripCredentials('https://ghp_token@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(stripCredentials('ssh://git@github.com/a/b.git'), 'ssh://git@github.com/a/b.git');
  assert.equal(stripCredentials('ssh://git:pw@github.com/a/b.git'), 'ssh://github.com/a/b.git');
  assert.equal(stripCredentials('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});
