import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Orchestration } from '@claudio/shared';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// A task retried in the same chat chooses its account again (R4), and a limit hit by the retried
// turn moves it to another account instead of ending the task failed (R5). The fake Claude fails
// the first turn (`FAKE-FAIL-ONCE`) and records the account each process runs on.

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'claudio-retry-account-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 50) {
    const value = read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function rig() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const spawns = join(config.dataDir, 'spawns.log');
  const saved = { dir: process.env.CLAUDE_CONFIG_DIR, spawns: process.env.FAKE_CLAUDE_ACCOUNTS, limited: process.env.FAKE_CLAUDE_LIMITED_DIRS };
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.FAKE_CLAUDE_ACCOUNTS = spawns;
  delete process.env.FAKE_CLAUDE_LIMITED_DIRS;
  const core = new Core(config);
  await core.accounts.setSettings({ strategy: 'order' });
  const alpha = await core.accounts.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' });
  return {
    core,
    alpha: alpha.id,
    alphaDir: core.accounts.ref(alpha.id).dir,
    defaultDir: config.configDir,
    dirs: (): (string | null)[] => (existsSync(spawns) ? readFileSync(spawns, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { dir: string | null }).dir) : []),
    close: () => {
      core.shutdown();
      for (const [name, value] of [['CLAUDE_CONFIG_DIR', saved.dir], ['FAKE_CLAUDE_ACCOUNTS', saved.spawns], ['FAKE_CLAUDE_LIMITED_DIRS', saved.limited]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** A graph of one task whose first turn fails, left failed on the CLI's own login. */
async function failedTask(r: Rig): Promise<Orchestration> {
  const started = r.core.orchestrator.create({
    name: 'retry',
    cwd: repoWithCommit(),
    worktree: true,
    maxAttempts: 1,
    tasks: [{ id: 'flaky', name: 'Flaky', prompt: 'FAKE-FAIL-ONCE the disk was full' }],
  });
  const failed = await until(() => r.core.orchestrator.get(started.id), (o) => o?.tasks[0]?.status === 'failed', 'the task to fail');
  assert.ok(failed);
  assert.equal(r.core.runtime.accountOf(failed.tasks[0]?.runId as string), 'default');
  return failed;
}

const settled = (r: Rig, id: string) =>
  until(() => r.core.orchestrator.get(id) as Orchestration, (o) => o.status === 'completed' || o.status === 'failed', 'the graph to end');

test("a retry runs on the account the rotation picks now, not the chat's exhausted one", async () => {
  const r = await rig();
  try {
    const failed = await failedTask(r);
    const chat = failed.tasks[0]?.runId as string;
    // The CLI said the default login is out until later
    await r.core.accounts.observe('default', { source: 'stream', status: 'rejected', windows: {}, at: Date.now(), rejected: { window: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    r.core.orchestrator.retryTask(failed.id, 'flaky');
    const done = await settled(r, failed.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.tasks[0]?.runId, chat, 'the same chat');
    assert.equal(r.core.runtime.accountOf(chat), r.alpha);
    assert.equal(r.dirs().at(-1), r.alphaDir);
  } finally {
    r.close();
  }
});

test('a limit hit by the retried turn moves it to another account, and the task is not failed', async () => {
  const r = await rig();
  try {
    const failed = await failedTask(r);
    const chat = failed.tasks[0]?.runId as string;
    // The login is out now, but no reading says so: the retry only finds out when its turn dies
    process.env.FAKE_CLAUDE_LIMITED_DIRS = r.defaultDir;
    r.core.orchestrator.retryTask(failed.id, 'flaky');
    const done = await settled(r, failed.id);
    assert.equal(done.tasks[0]?.status, 'completed', done.tasks[0]?.error ?? '');
    assert.equal(done.tasks[0]?.runId, chat);
    assert.equal(r.core.runtime.accountOf(chat), r.alpha);
    assert.deepEqual(r.dirs().slice(-2), [r.defaultDir, r.alphaDir], 'it tried the exhausted account once and went on with the next');
  } finally {
    r.close();
  }
});
