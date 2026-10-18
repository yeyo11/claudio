import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { limitedTail } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// A graph task whose account hits its limit while the limited process lingers (the real CLI does),
// moved to another account by the rotation: the task must go on in its chat, and the execution that
// died at the limit must keep saying so.

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'claudio-limit-switch-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ENV = ['CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_LIMITED_DIRS', 'FAKE_CLAUDE_LINGER_MS'] as const;

test('a task moved to another account at its limit goes on in one attempt, and the execution that hit the limit keeps its cause', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const saved = ENV.map((name) => [name, process.env[name]] as const);
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  // The default login is out; the process lingers after its limited result, so the replay finds it alive
  process.env.FAKE_CLAUDE_LIMITED_DIRS = config.configDir;
  process.env.FAKE_CLAUDE_LINGER_MS = '3000';
  let core = new Core(config);
  let chat = '';
  let alpha = '';
  try {
    await core.accounts.setSettings({ strategy: 'order' });
    alpha = (await core.accounts.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' })).id;
    const started = core.orchestrator.create({
      name: 'switch',
      cwd: repoWithCommit(),
      worktree: false,
      synthesize: false,
      tasks: [{ id: 'a', name: 'a', prompt: 'FAKE-WRITE a.txt done' }],
    });
    const orch = await until(() => core.orchestrator.get(started.id), (o) => !!o && o.status !== 'running', 'the graph to end');
    const task = orch?.tasks[0];
    assert.equal(task?.status, 'completed', task?.error ?? '');
    assert.equal(task?.attempts, 1, 'a switch is not a failed attempt');
    assert.equal(task?.error, null);
    assert.equal(core.db.rotationEvents().filter((e) => e.event === 'switch').length, 1);

    chat = task?.runId as string;
    const executions = core.runtime.get(chat)?.executions ?? [];
    assert.equal(executions.at(-2)?.cause, 'rate-limit', 'the execution that died at the limit says so');
    assert.equal(executions.at(-1)?.cause, undefined, 'and the replayed turn started clean');
    assert.deepEqual(limitedTail(executions.slice(0, -1)), ['default']);
  } finally {
    core.shutdown();
  }

  // A fresh start on the same data dir still knows the account hit its limit
  core = new Core(config);
  try {
    await until(() => core.runtime.get(chat), (c) => !!c, 'the chat to be restored');
    const executions = core.runtime.get(chat)?.executions ?? [];
    assert.equal(executions.at(-2)?.cause, 'rate-limit');
    assert.deepEqual(limitedTail(executions.slice(0, -1)), ['default']);
    assert.notEqual(alpha, '');
  } finally {
    core.shutdown();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
