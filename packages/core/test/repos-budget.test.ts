import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../src/index.ts';
import { RepoIndex } from '../src/repos.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

const REPOS = 50;
const DIRS_PER_REPO = 20;

/** Counts every git process this process starts, whichever module starts it. */
function countGit(): { count: () => number; restore: () => void } {
  let spawns = 0;
  const original = childProcess.execFileSync;
  const spy = ((file: string, ...rest: unknown[]) => {
    if (file === 'git') spawns += 1;
    return (original as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof childProcess.execFileSync;
  childProcess.execFileSync = spy;
  syncBuiltinESMExports();
  return {
    count: () => spawns,
    restore: () => {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
    },
  };
}

// D9 (docs/plans/projects-as-repositories.md): a list places each distinct directory from git's
// files, so listing spawns no git process once warm, and one per repository (its remote) when cold
test('projects and suggestions over 1,000 directories in 50 repositories spawn no git when warm, and place them in under 300 ms', async () => {
  const config = tempConfig();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'claudio-budget-')));
  const repos: string[] = [];
  let n = 0;
  for (let r = 0; r < REPOS; r++) {
    const repo = join(base, `repo-${r}`);
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    repos.push(repo);
    for (let d = 0; d < DIRS_PER_REPO; d++) {
      const cwd = join(repo, 'pkg', `d${d}`);
      mkdirSync(cwd, { recursive: true });
      const dir = join(config.projectsDir, encodeProjectId(cwd));
      mkdirSync(dir, { recursive: true });
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
      writeFileSync(join(dir, `s-${r}-${d}.jsonl`), JSON.stringify({ type: 'user', uuid: '1', timestamp: at, cwd, message: { role: 'user', content: 'go' } }));
    }
  }

  // Half the repositories are projects (a v1 document, migrated on start); the others are what
  // suggestions are made of
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'projects.json'), JSON.stringify({ projects: repos.slice(0, REPOS / 2).map((path, i) => ({ id: `p-${i}`, name: `repo-${i}`, path })) }));

  const core = new Core(config);
  const git = countGit();
  try {
    await core.projects();
    await core.projectCandidates();
    assert.ok(git.count() <= REPOS, `cold: ${git.count()} git processes, at most one per repository`);

    const before = git.count();
    const projects = await core.projects();
    await core.projectCandidates();
    assert.equal(git.count() - before, 0, 'warm: no git process at all');
    assert.equal(projects.length, REPOS / 2);
    assert.ok(projects.every((p) => p.chatCount === DIRS_PER_REPO && p.worktrees.length === 1));

    // The placement path itself: every distinct directory and every repository's checkouts. The rest of
    // a list (reading and assembling the transcripts) is the session store's, and is not measured here
    const started = performance.now();
    for (const repo of repos) {
      for (let d = 0; d < DIRS_PER_REPO; d++) core.repos.place(join(repo, 'pkg', `d${d}`));
      core.repos.worktreesOf(join(repo, '.git'));
    }
    const took = performance.now() - started;
    assert.ok(took < 300, `warm placement of ${REPOS * DIRS_PER_REPO} directories: ${Math.round(took)} ms`);

    // Cold, from git's files alone: a fresh index over the same rows spawns nothing either
    const cold = new RepoIndex();
    const coldStart = performance.now();
    for (const repo of repos) for (let d = 0; d < DIRS_PER_REPO; d++) cold.place(join(repo, 'pkg', `d${d}`));
    assert.ok(performance.now() - coldStart < 1_000, `cold placement: ${Math.round(performance.now() - coldStart)} ms`);
    assert.equal(git.count() - before, 0, 'the parser decides every directory without git');
  } finally {
    git.restore();
    core.shutdown();
    await core.restored;
  }
});
