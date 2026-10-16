import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration } from '@claudio/shared';
import type { WorkflowRun } from '../src/cli-facts.ts';
import { Core } from '../src/index.ts';
import { readJournalTasks } from '../src/workflow-journal.ts';
import { tempConfig } from './helpers.ts';

// A running workflow graph always has a live lead, an open wait or a launch on its way (R15,
// docs/plans/workflow-engine-limits.md §3): a lead that outlives its workflow is stopped, one that
// goes away settles the graph with the reason, a run in which nothing grows for too long is stopped
// and can be resumed, and a graph that waits for a limit to reset stays running through a restart.
// The fake CLI runs the generated script; a task whose prompt says HOLD waits for a file, LINGER keeps
// the lead up after the workflow, QUIET-END keeps its end off the stream and LIMIT is refused at a limit.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const ENV = ['CLAUDE_CONFIG_DIR', 'FAKE_WORKFLOW_DIR', 'FAKE_WORKFLOW_RESETS_AT', 'FAKE_WORKFLOW_LIMIT'] as const;

function rig() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const records = mkdtempSync(join(tmpdir(), 'claudio-wf-watchdog-'));
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.FAKE_WORKFLOW_DIR = records;
  process.env.FAKE_WORKFLOW_RESETS_AT = String(Math.floor(Date.now() / 1000) + 3600);
  delete process.env.FAKE_WORKFLOW_LIMIT;
  mkdirSync(config.workspaceDir, { recursive: true });
  const cores: Core[] = [];
  const open = (): Core => {
    const core = new Core(config);
    // Where the fake CLI leaves each session's record and journal, standing in for the files beside a transcript
    core.orchestrator.workflowRecords = async (sessionId) => {
      const file = join(records, `${sessionId}.json`);
      if (!existsSync(file)) {
        const runsDir = join(records, sessionId, 'subagents', 'workflows');
        return existsSync(runsDir) ? readdirSync(runsDir).map((id) => ({ id, taskId: null, status: 'running', endedAt: null }) as WorkflowRun) : [];
      }
      const r = JSON.parse(readFileSync(file, 'utf8')) as { runId: string; taskId: string; result: unknown };
      // The record's own timestamp is when the workflow ended
      return [{ id: r.runId, taskId: r.taskId, status: 'completed', endedAt: statSync(file).mtime.toISOString(), result: r.result } as WorkflowRun];
    };
    core.orchestrator.workflowJournal = (sessionId, runId, from) => readJournalTasks(join(records, `${sessionId}.jsonl`), runId, from);
    cores.push(core);
    return core;
  };
  const graph = (core: Core, prompts: Record<string, string>) =>
    core.orchestrator.create({
      name: 'Watched',
      engine: 'workflow',
      cwd: config.workspaceDir,
      tasks: Object.entries(prompts).map(([id, prompt]) => ({ id, name: id, prompt })),
    });
  return {
    open,
    graph,
    release: () => writeFileSync(join(records, 'release'), ''),
    close: () => {
      for (const core of cores) {
        try {
          core.shutdown();
        } catch {
          // shut down already, by the test that restarts it
        }
      }
      for (const name of ENV) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    },
  };
}

async function until<T>(read: () => T | null | undefined | false, what: string, ms = 20_000): Promise<T> {
  for (let waited = 0; waited < ms; waited += 50) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const states = (orch: Orchestration) => orch.tasks.map((t) => [t.id, t.status]);
const leadOf = (orch: Orchestration) => orch.workflow?.runId as string;
const ended = (core: Core, id: string, ms = 30_000) => until(() => (core.orchestrator.get(id)?.status !== 'running' ? core.orchestrator.get(id) : null), 'the graph to end', ms);
const notices = (core: Core, chatId: string): string[] => core.runtime.events(chatId).flatMap((e) => (e.kind === 'notice' && e.text ? [e.text] : []));

test('a lead still up after its workflow ended is stopped once the grace is over', async () => {
  const r = rig();
  try {
    const core = r.open();
    core.orchestrator.workflowGraceMs = 300;
    const started = r.graph(core, { one: 'fine LINGER' });
    const done = await ended(core, started.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((t) => [t.id, t.status, t.error])));
    const lead = leadOf(done);
    await until(() => core.runtime.get(lead)?.pid === null, 'the leftover lead to be stopped');
    assert.ok(
      notices(core, lead).some((n) => /its workflow had ended 0 s before/.test(n)),
      notices(core, lead).join('\n'),
    );
    assert.equal(core.orchestrator.get(started.id)?.status, 'completed', 'stopping the leftover does not touch the graph');
  } finally {
    r.close();
  }
});

test("a workflow whose end only its record tells is settled from the record, and its lingering lead stopped", async () => {
  const r = rig();
  try {
    const core = r.open();
    core.orchestrator.workflowGraceMs = 300;
    const started = r.graph(core, { one: 'fine LINGER QUIET-END' });
    // The stream never says the workflow ended and the lead stays up: before the watchdog, running for
    // ever. The record is read every ten ticks, which a loaded machine stretches
    const done = await ended(core, started.id, 90_000);
    assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((t) => [t.id, t.status, t.error])));
    assert.deepEqual(states(done), [['one', 'completed']]);
    await until(() => core.runtime.get(leadOf(done))?.pid === null, 'the leftover lead to be stopped');
  } finally {
    r.close();
  }
});

test('a lead that goes away before its workflow ends settles the graph with the reason', async () => {
  const r = rig();
  try {
    const core = r.open();
    const started = r.graph(core, { one: 'fine', held: 'HOLD' });
    const running = await until(() => {
      const orch = core.orchestrator.get(started.id);
      return orch?.tasks.find((t) => t.id === 'held')?.status === 'running' ? orch : null;
    }, 'the held task to run');
    const pid = core.runtime.get(leadOf(running))?.pid;
    assert.ok(pid);
    process.kill(pid, 'SIGKILL');
    const done = await ended(core, started.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /^the workflow did not finish/);
    const held = done.tasks.find((t) => t.id === 'held');
    assert.equal(held?.status, 'failed');
    assert.equal(held?.error, done.error);
  } finally {
    r.close();
  }
});

test('a workflow in which nothing grows for too long is stopped, failed with the reason, and resumes from its cache', async () => {
  const r = rig();
  try {
    const core = r.open();
    core.orchestrator.workflowIdleMs = 1500;
    const started = r.graph(core, { one: 'fine', held: 'HOLD' });
    const stalled = await ended(core, started.id);
    assert.equal(stalled.status, 'failed');
    assert.match(stalled.error ?? '', /^nothing in the workflow moved for 2 s/);
    assert.deepEqual(states(stalled), [
      ['one', 'completed'],
      ['held', 'failed'],
    ]);
    const lead = leadOf(stalled);
    await until(() => core.runtime.get(lead)?.pid === null, 'the lead to be stopped');
    assert.ok(notices(core, lead).some((n) => n.startsWith('Claudio stopped this workflow: nothing in the workflow moved')));
    assert.equal(stalled.workflow?.workflowRunId, 'wf_fake-001', 'resumable');

    // Whatever held it is gone: a resume goes back into the same session and run
    core.orchestrator.workflowIdleMs = 60_000;
    r.release();
    core.orchestrator.resume(started.id);
    const done = await ended(core, started.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((t) => [t.id, t.status, t.error])));
    assert.equal(leadOf(done), lead);
    assert.equal(done.error, null);
  } finally {
    r.close();
  }
});

test('a workflow held at a limit stays running through a restart, still waiting, and stopping the wait stops it', async () => {
  const r = rig();
  try {
    const first = r.open();
    const started = r.graph(first, { one: 'fine', limited: 'LIMIT here' });
    const held = await until(() => {
      const orch = first.orchestrator.get(started.id);
      return orch && first.rotation.waitOf(leadOf(orch)) ? orch : null;
    }, 'the wait');
    const lead = leadOf(held);
    first.shutdown();

    const second = r.open();
    const back = second.orchestrator.get(started.id);
    assert.equal(back?.status, 'running', 'the wait outlives the restart');
    assert.deepEqual(back && states(back), [
      ['one', 'completed'],
      ['limited', 'running'],
    ]);
    const wait = await until(() => second.rotation.waitOf(lead), 'the wait to be armed again');
    // Watched again: a graph waiting for its reset is not mistaken for one whose lead went away
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(second.orchestrator.get(started.id)?.status, 'running');

    assert.equal(second.rotation.cancel(wait), true);
    const stopped = await ended(second, started.id);
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.error ?? '', /stopped waiting for the usage limit/);
  } finally {
    r.close();
  }
});

test('a workflow cut off by a restart with no wait is stopped, as before', async () => {
  const r = rig();
  try {
    const first = r.open();
    const started = r.graph(first, { held: 'HOLD' });
    await until(() => first.orchestrator.get(started.id)?.tasks[0]?.status === 'running', 'the task to run');
    first.shutdown();
    const second = r.open();
    assert.equal(second.orchestrator.get(started.id)?.status, 'stopped');
  } finally {
    r.close();
  }
});
