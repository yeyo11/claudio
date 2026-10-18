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
const workspace = join(scratch, 'workspace');
const looseDir = join(workspace, 'notes');
for (const dir of [worktree, sibling, outside, looseDir]) mkdirSync(dir, { recursive: true });
const linked = join(project, '.claude', 'worktrees', 'linked');
symlinkSync(outside, linked);
// A directory of the workspace that is a symlink to somewhere else
const escape = join(workspace, 'escape');
symlinkSync(outside, escape);
let workspaceDir = workspace;

const lookup: CwdLookup = {
  project: async (id) => (id === 'p1' ? { path: project, worktrees: [worktree, sibling, linked, join(project, 'gone')] } : null),
  chat: async (id) => {
    if (id === 'c-plain') return { cwd: project, worktree: null, projectId: 'p1' };
    if (id === 'c-tree') return { cwd: project, worktree: worktree, projectId: 'p1' };
    if (id === 'c-loose') return { cwd: looseDir, worktree: null, projectId: null };
    if (id === 'c-loose-root') return { cwd: workspace, worktree: null, projectId: null };
    if (id === 'c-loose-outside') return { cwd: outside, worktree: null, projectId: null };
    if (id === 'c-loose-linked') return { cwd: escape, worktree: null, projectId: null };
    if (id === 'c-orphan') return { cwd: project, worktree: null, projectId: 'gone' };
    if (id === 'c-escaped') return { cwd: outside, worktree: null, projectId: 'p1' };
    return null;
  },
  workspace: () => workspaceDir,
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

test('an unknown id is not found, and a chat whose project is gone gets no terminal', async () => {
  await assert.rejects(resolveTerminalCwd({ chatId: 'nope' }, lookup), refused('terminal.not-found'));
  await assert.rejects(resolveTerminalCwd({ projectId: 'nope' }, lookup), refused('terminal.not-found'));
  await assert.rejects(resolveTerminalCwd({ chatId: 'c-orphan' }, lookup), refused('terminal.no-project'));
});

test('the workspace scope opens in the configured workspace, with no project at all', async () => {
  assert.deepEqual(await resolveTerminalCwd({ workspace: true }, lookup), { scope: { kind: 'workspace' }, cwd: workspace });
});

test('a workspace that is a symlink to elsewhere is still the workspace, resolved', async () => {
  // The owner may point CLAUDIO_WORKSPACE_DIR at a link; the root itself is what was configured
  const link = join(scratch, 'workspace-link');
  symlinkSync(workspace, link);
  workspaceDir = link;
  try {
    assert.equal((await resolveTerminalCwd({ workspace: true }, lookup)).cwd, workspace);
    assert.equal((await resolveTerminalCwd({ chatId: 'c-loose' }, lookup)).cwd, looseDir);
  } finally {
    workspaceDir = workspace;
  }
});

test('the workspace scope takes no path and no other value than true', async () => {
  await assert.rejects(resolveTerminalCwd({ workspace: false } as unknown as { workspace: true }, lookup), refused('terminal.bad-cwd'));
  await assert.rejects(resolveTerminalCwd({ workspace: outside } as unknown as { workspace: true }, lookup), refused('terminal.bad-cwd'));
});

test('a chat outside any project gets its own directory inside the workspace', async () => {
  const loose = await resolveTerminalCwd({ chatId: 'c-loose' }, lookup);
  assert.deepEqual(loose, { scope: { kind: 'chat', chatId: 'c-loose' }, cwd: looseDir });
  assert.equal((await resolveTerminalCwd({ chatId: 'c-loose-root' }, lookup)).cwd, workspace);
});

test('a chat outside any project whose directory is outside the workspace is refused', async () => {
  await assert.rejects(resolveTerminalCwd({ chatId: 'c-loose-outside' }, lookup), refused('terminal.bad-cwd'));
});

test('a symlink inside the workspace that escapes it is refused for a loose chat', async () => {
  await assert.rejects(resolveTerminalCwd({ chatId: 'c-loose-linked' }, lookup), refused('terminal.bad-cwd'));
});

test('a workspace that no longer exists is refused', async () => {
  workspaceDir = join(scratch, 'no-workspace');
  try {
    await assert.rejects(resolveTerminalCwd({ workspace: true }, lookup), refused('terminal.bad-cwd'));
  } finally {
    workspaceDir = workspace;
  }
});
