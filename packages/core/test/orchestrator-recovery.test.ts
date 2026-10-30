import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Orchestration } from '@claudio/shared';
import { RunSlotRefusal } from '../src/chat-errors.ts';
import { ChatManager, type NewChat, type RunMeta } from '../src/chats.ts';
import type { WorkflowRun } from '../src/cli-facts.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { readJournalTasks } from '../src/workflow-journal.ts';
import { tempConfig } from './helpers.ts';

// What the orchestrator does when something gets in its way (regression audit 2026-10-29, 9.2-9.5
// and 9.9): a place refused for a moment is waited for, a stop and a resume do not trip over each
// other, a conflict a refused start left behind is still handed over, and a reason is not lost.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CONTROL = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'claudio-graph-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

function rig(claudeBin = FAKE_CLAUDE) {
  const config = { ...tempConfig(), claudeBin };
  mkdirSync(config.workspaceDir, { recursive: true });
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  return { config, db, runs, orchestrator };
}

/** Makes `runs.start` refuse the first start of the graph's run named `taskId` the way a full runtime does */
function refuseOnce(runs: ChatManager, taskId: string, refusal: () => Error = () => new RunSlotRefusal(1)): { refused: () => boolean } {
  const start = runs.start.bind(runs);
  let refused = false;
  runs.start = (opts: NewChat, meta?: RunMeta) => {
    if (!refused && meta?.orchestrationTaskId === taskId) {
      refused = true;
      throw refusal();
    }
    return start(opts, meta);
  };
  return { refused: () => refused };
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const settled = (orchestrator: Orchestrator, id: string): Promise<Orchestration> =>
  until(() => orchestrator.get(id) as Orchestration, (o) => o.status !== 'running', 'the graph to settle');

test('a stop then a resume within moments goes on with the task, not with the stopped process’s last word', async () => {
  const { config, db, runs, orchestrator } = rig();
  try {
    const started = orchestrator.create({ name: 'quick', cwd: config.workspaceDir, tasks: [{ id: 'work', name: 'work', prompt: 'FAKE-HANG' }] });
    const chatId = (await until(() => orchestrator.get(started.id)?.tasks[0], (t) => !!t?.runId && !!runs.get(t.runId)?.pid, 'the worker to run'))?.runId as string;
    orchestrator.stop(started.id);
    // The stopped process is still on its way out: its result comes after the resume set the task running again
    orchestrator.resume(started.id);
    const done = await settled(orchestrator, started.id);
    assert.equal(done.tasks[0]?.status, 'completed', done.tasks[0]?.error ?? '');
    assert.equal(done.status, 'completed');
    assert.equal(done.tasks[0]?.runId, chatId, 'the task went on in its own chat');
  } finally {
    await runs.stopAll();
    orchestrator.close();
    db.close();
  }
});

test('a worker refused a place still gets the merge conflict its worktree was left with', async () => {
  const { db, runs, orchestrator } = rig();
  const repo = repoWithCommit();
  const slot = refuseOnce(runs, 'join');
  try {
    const started = orchestrator.create({
      name: 'conflicting',
      cwd: repo,
      worktree: true,
      synthesize: false,
      tasks: [
        { id: 'left', name: 'left', prompt: 'FAKE-WRITE shared.txt alpha' },
        { id: 'right', name: 'right', prompt: 'FAKE-WRITE shared.txt beta' },
        { id: 'join', name: 'join', prompt: 'FAKE-WRITE joined.txt both', dependsOn: ['left', 'right'] },
      ],
    });
    const join_ = await until(() => orchestrator.get(started.id)?.tasks.find((t) => t.id === 'join'), (t) => !!t?.runId, 'the dependent task to start');
    assert.ok(slot.refused(), 'its first start was refused');
    const prompt = runs.get(join_?.runId ?? '')?.prompt ?? '';
    assert.match(prompt, /left a merge of worktree-[\w-]+ unfinished/, 'the worker is told of the conflict before it works');
    assert.match(prompt, /- shared\.txt/);
    await settled(orchestrator, started.id);
  } finally {
    await runs.stopAll();
    orchestrator.close();
    db.close();
  }
});

test('a task stopped at its time limit keeps that reason after its process ends', async () => {
  const { config, db, runs, orchestrator } = rig();
  try {
    const started = orchestrator.create({ name: 'slow', cwd: config.workspaceDir, tasks: [{ id: 'work', name: 'work', prompt: 'FAKE-HANG', limits: { maxMinutes: 1 } }] });
    const task = await until(() => orchestrator.get(started.id)?.tasks[0], (t) => !!t?.runId && !!runs.get(t.runId)?.pid, 'the worker to run');
    orchestrator.enforceLimits(Date.now() + 5 * 60_000);
    await until(() => runs.get(task?.runId ?? ''), (c) => !!c && c.pid === null && c.status === 'stopped', 'the worker’s process to end');
    // The stop's own result came in after the limit: it says only that the process ended
    await new Promise((r) => setTimeout(r, 200));
    const after = orchestrator.get(started.id)?.tasks[0];
    assert.equal(after?.status, 'failed');
    assert.equal(after?.error, 'stopped at its time limit of 1 min');
  } finally {
    await runs.stopAll();
    orchestrator.close();
    db.close();
  }
});

test('a synthesis refused a place waits for one instead of failing the graph’s report', async () => {
  const { config, db, runs, orchestrator } = rig();
  const slot = refuseOnce(runs, '__synthesis__');
  try {
    const started = orchestrator.create({ name: 'reported', cwd: config.workspaceDir, synthesize: true, tasks: [{ id: 'work', name: 'work', prompt: 'do it' }] });
    const done = await settled(orchestrator, started.id);
    assert.ok(slot.refused());
    assert.equal(done.status, 'completed');
    assert.ok(done.synthesisRunId, 'the synthesis ran once a place came free');
    assert.doesNotMatch(done.finalResult ?? '', /^Synthesis failed/);
  } finally {
    await runs.stopAll();
    orchestrator.close();
    db.close();
  }
});

test('a closed orchestrator takes its listener off the chat manager', () => {
  const { db, runs, orchestrator } = rig();
  const listening = runs.listenerCount('chat-result');
  const second = new Orchestrator({ ...tempConfig(), claudeBin: FAKE_CLAUDE }, runs, db);
  assert.equal(runs.listenerCount('chat-result'), listening + 1);
  second.close();
  orchestrator.close();
  assert.equal(runs.listenerCount('chat-result'), listening - 1);
  db.close();
});

// ---------- a workflow's resume ----------

function workflowRig() {
  const { config, db, runs, orchestrator } = rig(FAKE_CONTROL);
  const records = mkdtempSync(join(tmpdir(), 'claudio-wf-records-'));
  process.env.FAKE_WORKFLOW_DIR = records;
  orchestrator.workflowRecords = async (sessionId) => {
    const file = join(records, `${sessionId}.json`);
    if (!existsSync(file)) {
      const runsDir = join(records, sessionId, 'subagents', 'workflows');
      return existsSync(runsDir) ? readdirSync(runsDir).map((id) => ({ id, taskId: null, status: 'running' }) as WorkflowRun) : [];
    }
    const r = JSON.parse(readFileSync(file, 'utf8')) as { runId: string; taskId: string; result: unknown };
    return [{ id: r.runId, taskId: r.taskId, status: 'completed', result: r.result } as WorkflowRun];
  };
  orchestrator.workflowJournal = (sessionId, runId, from) => readJournalTasks(join(records, `${sessionId}.jsonl`), runId, from);
  return { config, db, runs, orchestrator };
}

async function failedWorkflow(orchestrator: Orchestrator): Promise<Orchestration> {
  const started = orchestrator.create({
    name: 'Flaky',
    engine: 'workflow',
    tasks: [
      { id: 'ok', name: 'OK', prompt: 'fine' },
      { id: 'flaky', name: 'Flaky', prompt: 'FAIL-ONCE please' },
    ],
  });
  const failed = await settled(orchestrator, started.id);
  assert.equal(failed.status, 'failed');
  return failed;
}

test('a workflow resume refused a place is tried again once one frees, and the server stays up', async () => {
  const { db, runs, orchestrator } = workflowRig();
  try {
    const failed = await failedWorkflow(orchestrator);
    const send = runs.send.bind(runs);
    let refused = 0;
    runs.send = (id: string, text: string, attachmentIds?: string[], messageId?: string) => {
      if (refused++ === 0) throw new RunSlotRefusal(1);
      return send(id, text, attachmentIds, messageId);
    };
    orchestrator.resume(failed.id);
    const resumed = await settled(orchestrator, failed.id);
    assert.ok(refused >= 2, 'tried again after the refusal');
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.tasks.map((t) => [t.id, t.status, t.error])));
  } finally {
    await runs.stopAll();
    orchestrator.close();
    db.close();
    delete process.env.FAKE_WORKFLOW_DIR;
  }
});

test('a workflow resume refused for good fails the graph with the reason, instead of an unhandled rejection', async () => {
  const { db, runs, orchestrator } = workflowRig();
  try {
    const failed = await failedWorkflow(orchestrator);
    runs.send = () => {
      throw new Error('session is still running in process 4242');
    };
    orchestrator.resume(failed.id);
    const ended = await settled(orchestrator, failed.id);
    assert.equal(ended.status, 'failed');
    assert.ok(ended.tasks.some((t) => /could not start the workflow: session is still running in process 4242/.test(t.error ?? '')));
  } finally {
    await runs.stopAll();
    orchestrator.close();
    db.close();
    delete process.env.FAKE_WORKFLOW_DIR;
  }
});
