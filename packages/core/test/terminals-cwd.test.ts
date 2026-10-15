import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveTerminalCwd, type CwdLookup } from '../src/terminals/cwd.ts';
import { TerminalError } from '../src/terminals/errors.ts';

const scratch = mkdtempSync(join(tmpdir(), 'claudio-terminal-cwd-'));
const project = join(scratch, 'project');
const worktree = join(project, '.claude', 'worktrees', 'feature');
const sibling = join(scratch, 'sibling-worktree');
const outside = join(scratch, 'outside');
for (const dir of [worktree, sibling, outside]) mkdirSync(dir, { recursive: true });
const linked = join(project, '.claude', 'worktrees', 'linked');
symlinkSync(outside, linked);

const lookup: CwdLookup = {
  project: async (id) => (id === 'p1' ? { path: project, worktrees: [worktree, sibling, linked, join(project, 'gone')] } : null),
  chat: async (id) => {
    if (id === 'c-plain') return { cwd: project, worktree: null, projectId: 'p1' };
    if (id === 'c-tree') return { cwd: project, worktree: worktree, projectId: 'p1' };
    if (id === 'c-loose') return { cwd: outside, worktree: null, projectId: null };
    if (id === 'c-escaped') return { cwd: outside, worktree: null, projectId: 'p1' };
    return null;
  },
};

const refused = (code: string) => (error: unknown) => error instanceof TerminalError && error.code === code;

test('a project id gives its path, and a listed worktree is accepted', async () => {
  assert.deepEqual(await resolveTerminalCwd({ projectId: 'p1' }, lookup), { scope: { kind: 'project', projectId: 'p1', worktree: null }, cwd: project });
  const inside = await resolveTerminalCwd({ projectId: 'p1', worktree }, lookup);
  assert.equal(inside.cwd, worktree);
  assert.deepEqual(inside.scope, { kind: 'project', projectId: 'p1', worktree });
  // A worktree beside the project, as `git worktree add ../x` makes
  assert.equal((await resolveTerminalCwd({ projectId: 'p1', worktree: sibling }, lookup)).cwd, sibling);
});

test('a chat gets its worktree, else its own directory', async () => {
  assert.equal((await resolveTerminalCwd({ chatId: 'c-tree' }, lookup)).cwd, worktree);
  const plain = await resolveTerminalCwd({ chatId: 'c-plain' }, lookup);
  assert.equal(plain.cwd, project);
  assert.deepEqual(plain.scope, { kind: 'chat', chatId: 'c-plain' });
});

test('a path that is not a listed worktree, and `..`, are refused', async () => {
  await assert.rejects(resolveTerminalCwd({ projectId: 'p1', worktree: outside }, lookup), refused('terminal.bad-cwd'));
  await assert.rejects(resolveTerminalCwd({ projectId: 'p1', worktree: join(project, '..') }, lookup), refused('terminal.bad-cwd'));
  await assert.rejects(resolveTerminalCwd({ projectId: 'p1', worktree: `${worktree}/../../..` }, lookup), refused('terminal.bad-cwd'));
});

test('a symlinked worktree that points outside the project is refused', async () => {
  await assert.rejects(resolveTerminalCwd({ projectId: 'p1', worktree: linked }, lookup), refused('terminal.bad-cwd'));
  await assert.rejects(resolveTerminalCwd({ chatId: 'c-escaped' }, lookup), refused('terminal.bad-cwd'));
});

test('a deleted directory is refused', async () => {
  await assert.rejects(resolveTerminalCwd({ projectId: 'p1', worktree: join(project, 'gone') }, lookup), refused('terminal.bad-cwd'));
  rmSync(sibling, { recursive: true });
  await assert.rejects(resolveTerminalCwd({ projectId: 'p1', worktree: sibling }, lookup), refused('terminal.bad-cwd'));
});

test('a chat outside any project gets no terminal, and an unknown id is not found', async () => {
  await assert.rejects(resolveTerminalCwd({ chatId: 'c-loose' }, lookup), refused('terminal.no-project'));
  await assert.rejects(resolveTerminalCwd({ chatId: 'nope' }, lookup), refused('terminal.not-found'));
  await assert.rejects(resolveTerminalCwd({ projectId: 'nope' }, lookup), refused('terminal.not-found'));
});
