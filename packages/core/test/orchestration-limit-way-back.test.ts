import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration, OrchestrationTaskState } from '@claudio/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

// A graph task held at a usage limit, from the orchestrator's side, with the rotation's hooks in the
// test's hands: a turn replayed while the limited process is still exiting, and the way back of a
// task a person stopped waiting for (R11). Kept apart from orchestrator.test.ts, which is long
// enough to brush its file timeout on a loaded machine.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'claudio-limited-graph-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

async function settle(orchestrator: Orchestrator, id: string): Promise<Orchestration> {
  for (let i = 0; i < 300; i++) {
    const orch = orchestrator.get(id);
    if (orch && orch.status !== 'running') return orch;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the orchestration never finished');
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const graphOf = (repo: string, tasks: Array<{ id: string; prompt: string; dependsOn?: string[] }>, extra = {}) => ({
  name: 'limited',
  cwd: repo,
  worktree: true,
  synthesize: true,
  tasks: tasks.map((t) => ({ name: t.id, ...t })),
  ...extra,
});

/** A graph over the fake Claude, with the rotation's side of the hooks in the test's hands. */
function providerGraph(hooks: { held?: boolean } = {}) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const repo = repoWithCommit();
  const runs = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_CLAUDE)]);
  const orchestrator = new Orchestrator(config, runs, db);
  const state = { held: hooks.held ?? false };
  orchestrator.limitHeld = () => state.held;
  orchestrator.waitOf = () => null;
  orchestrator.releaseWait = () => undefined;
  const taskOf = (id: string, task: string) => orchestrator.get(id)?.tasks.find((t) => t.id === task) as OrchestrationTaskState;
  return { db, repo, runs, orchestrator, state, taskOf, config };
}

test('a turn replayed while the limited process is still on its way out is followed to its result, not taken for a stop', async () => {
  // The flake of the test above: under load the limited worker's process had not exited yet when
  // the turn was replayed. The replay stops it to respawn clean, and the task's follower took that
  // stop for the chat's end, so the task ended stopped and the replayed turn's result was nobody's.
  // A process that lingers after its result makes the same order happen every time.
  const saved = process.env.FAKE_CLAUDE_LINGER_MS;
  process.env.FAKE_CLAUDE_LINGER_MS = '3000';
  const { db, repo, runs, orchestrator, state, taskOf } = providerGraph({ held: true });
  try {
    const started = orchestrator.create(graphOf(repo, [{ id: 'a', prompt: 'FAKE-LIMIT-ONCE' }], { worktree: false, synthesize: false }));
    const chat = (await until(() => taskOf(started.id, 'a').runId, (id) => !!id, 'the task to start')) as string;
    await until(() => runs.atLimit(chat), (limited) => limited, 'the chat to reach its limit');
    // The orchestrator heard the limited result: it follows the chat's next one
    await until(() => taskOf(started.id, 'a').costUsd, (cost) => (cost ?? 0) > 0, 'the limited result to be charged');
    assert.ok(runs.get(chat)?.pid, 'the limited process is still up');
    delete process.env.FAKE_CLAUDE_LINGER_MS;
    state.held = false;
    assert.equal(await runs.replayLastTurn(chat), true);
    orchestrator.waitEnded({ fromChat: chat, at: new Date().toISOString() }, 'resumed', null);
    const orch = await settle(orchestrator, started.id);
    assert.equal(taskOf(orch.id, 'a').status, 'completed', taskOf(orch.id, 'a').error ?? '');
  } finally {
    if (saved === undefined) delete process.env.FAKE_CLAUDE_LINGER_MS;
    else process.env.FAKE_CLAUDE_LINGER_MS = saved;
    db.close();
  }
});

/** A graph whose task `a` stopped waiting for a reset, with `b` blocked behind it: the graph waits for a person (R11). */
async function stoppedWait() {
  const g = providerGraph({ held: true });
  const started = g.orchestrator.create(
    graphOf(
      g.repo,
      [
        { id: 'a', prompt: 'FAKE-LIMIT-ONCE' },
        { id: 'b', prompt: 'FAKE-WRITE b.txt done', dependsOn: ['a'] },
      ],
      { worktree: false, synthesize: false },
    ),
  );
  const chat = (await until(() => g.taskOf(started.id, 'a').runId, (id) => !!id, 'the task to start')) as string;
  await until(() => g.runs.atLimit(chat), (limited) => limited, 'the chat to reach its limit');
  await g.runs.exited(chat);
  await until(() => g.taskOf(started.id, 'a').costUsd, (cost) => (cost ?? 0) > 0, 'the limited result to be heard');
  g.orchestrator.waitEnded({ fromChat: chat, at: new Date().toISOString() }, 'cancelled', 'stopped waiting');
  g.state.held = false;
  assert.equal(g.taskOf(started.id, 'a').status, 'stopped');
  assert.equal(g.taskOf(started.id, 'b').status, 'blocked');
  assert.equal(g.orchestrator.get(started.id)?.status, 'waiting');
  return { ...g, id: started.id, chat };
}

test('a task stopped while it waited for a reset can be retried in its chat, and what waited behind it goes on (R11)', async () => {
  const { db, orchestrator, taskOf, id, chat } = await stoppedWait();
  orchestrator.retryTask(id, 'a');
  const orch = await settle(orchestrator, id);
  assert.equal(orch.status, 'completed', JSON.stringify(orch.tasks.map((t) => [t.id, t.status, t.error])));
  assert.equal(taskOf(id, 'a').runId, chat, 'the same chat goes on');
  assert.equal(taskOf(id, 'b').status, 'completed');
  db.close();
});

test('a task stopped while it waited for a reset can be started clean, and skipped (R11)', async () => {
  const clean = await stoppedWait();
  clean.orchestrator.retryTaskClean(clean.id, 'a');
  assert.equal(clean.orchestrator.get(clean.id)?.status, 'running');
  // A new session: its first turn is the fake's limited one again, which shows it started over
  const fresh = (await until(() => clean.taskOf(clean.id, 'a').runId, (runId) => !!runId && runId !== clean.chat, 'a new chat')) as string;
  await until(() => clean.runs.atLimit(fresh), (limited) => limited, 'the new chat to run its first turn');
  assert.equal(clean.taskOf(clean.id, 'a').status, 'running');
  assert.equal(clean.taskOf(clean.id, 'a').attempts, 1, 'the new chat starts counting again');
  clean.orchestrator.stop(clean.id);
  clean.db.close();

  const skip = await stoppedWait();
  skip.orchestrator.skipTask(skip.id, 'a');
  const skipped = await settle(skip.orchestrator, skip.id);
  assert.equal(skip.taskOf(skip.id, 'a').status, 'skipped');
  assert.equal(skip.taskOf(skip.id, 'b').status, 'skipped');
  // Nothing is left to decide: the graph ends (failed, since no task of it completed)
  assert.ok(!['running', 'waiting'].includes(skipped.status), skipped.status);
  skip.db.close();
});

test('a graph that waits for a decision can be resumed: what did not finish goes on, in its chats (R11)', async () => {
  const { db, orchestrator, taskOf, id, chat } = await stoppedWait();
  const resumed = orchestrator.resume(id);
  assert.equal(resumed.status, 'running');
  const orch = await settle(orchestrator, id);
  assert.equal(orch.status, 'completed', JSON.stringify(orch.tasks.map((t) => [t.id, t.status, t.error])));
  assert.equal(taskOf(id, 'a').runId, chat);
  assert.equal(taskOf(id, 'b').status, 'completed');
  db.close();
});

test('a waiting graph is not resumed while one of its unfinished tasks still works in its chat (R11)', async () => {
  const { db, runs, orchestrator, id, chat } = await stoppedWait();
  // A person goes on in the stopped task's chat by hand
  runs.send(chat, 'FAKE-HANG');
  await until(() => runs.get(chat)?.status, (status) => status === 'busy', 'the chat to work');
  assert.throws(() => orchestrator.resume(id), /still working in its chat/);
  assert.equal(orchestrator.get(id)?.status, 'waiting');
  runs.stop(chat);
  db.close();
});

