import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Orchestration } from '@claudio/shared';
import type { WorkflowRun } from '../src/cli-facts.ts';
import { Core } from '../src/index.ts';
import { readJournalTasks } from '../src/workflow-journal.ts';
import { tempConfig } from './helpers.ts';

// A usage limit in a workflow's subagent is held or rotated like a graph task's (R15,
// docs/plans/workflow-engine-limits.md §2): the lead is handed to the rotation, which moves the
// session to an account with room or waits for the reset, and the run resumes from its cache. The
// fake CLI refuses an agent whose prompt says LIMIT on a first run (on every run with
// $FAKE_WORKFLOW_LIMIT=always), as the CLI records it: a 429 at the end of the agent's transcript and
// a `failed` journal line, never on the stream.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const ENV = ['CLAUDE_CONFIG_DIR', 'FAKE_WORKFLOW_DIR', 'FAKE_WORKFLOW_RESETS_AT', 'FAKE_WORKFLOW_LIMIT'] as const;

async function rig(o: { accounts?: number; resetsInS: number; always?: boolean }) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const records = mkdtempSync(join(tmpdir(), 'claudio-wf-limits-'));
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.FAKE_WORKFLOW_DIR = records;
  process.env.FAKE_WORKFLOW_RESETS_AT = String(Math.floor(Date.now() / 1000) + o.resetsInS);
  if (o.always) process.env.FAKE_WORKFLOW_LIMIT = 'always';
  else delete process.env.FAKE_WORKFLOW_LIMIT;
  mkdirSync(config.workspaceDir, { recursive: true });
  const core = new Core(config);
  await core.accounts.setSettings({ strategy: 'order' });
  const accounts: string[] = [];
  for (let i = 0; i < (o.accounts ?? 0); i++) accounts.push((await core.accounts.add({ kind: 'token', alias: `alpha${i}`, secret: `tok-${i}` })).id);
  // Where the fake CLI leaves each session's record and journal, standing in for the files beside a transcript
  core.orchestrator.workflowRecords = async (sessionId) => {
    const file = join(records, `${sessionId}.json`);
    if (!existsSync(file)) {
      const runsDir = join(records, sessionId, 'subagents', 'workflows');
      return existsSync(runsDir) ? readdirSync(runsDir).map((id) => ({ id, taskId: null, status: 'running' }) as WorkflowRun) : [];
    }
    const r = JSON.parse(readFileSync(file, 'utf8')) as { runId: string; taskId: string; result: unknown };
    return [{ id: r.runId, taskId: r.taskId, status: 'completed', result: r.result } as WorkflowRun];
  };
  core.orchestrator.workflowJournal = (sessionId, runId, from) => readJournalTasks(join(records, `${sessionId}.jsonl`), runId, from);
  const graph = () =>
    core.orchestrator.create({
      name: 'Limited',
      engine: 'workflow',
      cwd: config.workspaceDir,
      tasks: [
        { id: 'ok', name: 'OK', prompt: 'fine' },
        { id: 'limited', name: 'Limited', prompt: 'LIMIT here' },
      ],
    });
  return {
    core,
    accounts,
    graph,
    close: () => {
      core.shutdown();
      for (const name of ENV) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    },
  };
}

async function until(core: Core, id: string, done: (o: Orchestration) => boolean, what: string, ms = 20_000): Promise<Orchestration> {
  for (let waited = 0; waited < ms; waited += 50) {
    const orch = core.orchestrator.get(id);
    if (orch && done(orch)) return orch;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(core.orchestrator.get(id)?.tasks.map((t) => [t.id, t.status, t.error]))}`);
}

const states = (orch: Orchestration) => orch.tasks.map((t) => [t.id, t.status]);
const leadOf = (orch: Orchestration) => orch.workflow?.runId as string;
/** What the lead was asked, turn by turn */
const prompts = (core: Core, chatId: string): string[] =>
  core.runtime
    .events(chatId)
    .flatMap((e) => (e.kind === 'message' && e.entry?.role === 'user' ? [e.entry.blocks.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')] : []))
    .filter((text) => text.startsWith('Run the workflow'));

test('with no account left, a refused agent holds the graph on the reset, then the run resumes from its cache in the same session', async () => {
  const r = await rig({ resetsInS: 1 });
  try {
    const started = r.graph();
    const held = await until(r.core, started.id, (o) => r.core.rotation.waitOf(leadOf(o)) !== null, 'the wait');
    const lead = leadOf(held);
    const [wait] = r.core.db.providerMoves({ chatId: lead });
    assert.equal(wait?.action, 'wait');
    assert.equal(wait?.state, 'waiting');
    assert.equal(wait?.subjectKind, 'task');
    assert.equal(wait?.subjectId, `${started.id}:__workflow__`);
    assert.ok(wait?.resetsAt, 'the wait knows the reset the refusal gave');
    // Still running, not failed: the refused task waits with the graph, and shows the wait
    assert.equal(held.status, 'running');
    assert.deepEqual(states(held), [
      ['ok', 'completed'],
      ['limited', 'running'],
    ]);
    const view = r.core.orchestrator.view(held);
    assert.equal(view.tasks[1]?.waiting?.moveId, wait?.id);

    // The reset passes (plus the rotation's slack): the run goes on from its cache
    const done = await until(r.core, started.id, (o) => o.status !== 'running', 'the graph to finish', 30_000);
    assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((t) => [t.id, t.status, t.error])));
    assert.deepEqual(states(done), [
      ['ok', 'completed'],
      ['limited', 'completed'],
    ]);
    assert.equal(leadOf(done), lead, 'the same session, which holds the cache');
    assert.equal(r.core.db.providerMove(wait?.id as string)?.state, 'resumed');
    const sent = prompts(r.core, lead);
    assert.match(sent.at(-1) ?? '', /resumeFromRunId "wf_fake-001"/, 'resumed from the run, not launched again');
  } finally {
    r.close();
  }
});

test('a refused agent moves the session to an account with room, and the run resumes from its cache there', async () => {
  const r = await rig({ accounts: 1, resetsInS: 3600 });
  try {
    const started = r.graph();
    const done = await until(r.core, started.id, (o) => o.status !== 'running', 'the graph to finish');
    assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((t) => [t.id, t.status, t.error])));
    assert.deepEqual(states(done), [
      ['ok', 'completed'],
      ['limited', 'completed'],
    ]);
    const lead = leadOf(done);
    assert.equal(r.core.runtime.accountOf(lead), r.accounts[0], 'moved off the account the agent was refused on');
    assert.deepEqual(r.core.db.providerMoves({ chatId: lead }), [], 'nothing waited');
    const switches = r.core.db.rotationEvents({ limit: 10 }).filter((e) => e.event === 'switch');
    assert.equal(switches.length, 1);
    assert.equal(switches[0]?.to, r.accounts[0]);
    const sent = prompts(r.core, lead);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[0] ?? '', /resumeFromRunId/);
    assert.match(sent[1] ?? '', /resumeFromRunId "wf_fake-001"/);
  } finally {
    r.close();
  }
});

test('when every account is at its limit the graph waits for the earliest reset, and stopping the wait stops the graph', async () => {
  const r = await rig({ accounts: 1, resetsInS: 3600, always: true });
  try {
    const started = r.graph();
    // Refused on the CLI's own login, moved to the other account, refused there too: nothing is left
    const held = await until(r.core, started.id, (o) => r.core.rotation.waitOf(leadOf(o)) !== null, 'the wait');
    const lead = leadOf(held);
    assert.equal(held.status, 'running');
    assert.deepEqual(states(held), [
      ['ok', 'completed'],
      ['limited', 'running'],
    ]);
    const events = r.core.db.rotationEvents({ limit: 10 }).map((e) => e.event);
    assert.ok(events.includes('switch') && events.includes('wait'), events.join(','));
    const [wait] = r.core.db.providerMoves({ chatId: lead });
    assert.equal(wait?.state, 'waiting');
    assert.ok(wait?.resetsAt && Date.parse(wait.resetsAt) > Date.now() + 30 * 60_000, `waits for the reset: ${String(wait?.resetsAt)}`);

    assert.equal(r.core.rotation.cancel(wait?.id as string), true);
    const stopped = await until(r.core, started.id, (o) => o.status !== 'running', 'the graph to stop');
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.error ?? '', /stopped waiting for the usage limit/);
    assert.deepEqual(states(stopped), [
      ['ok', 'completed'],
      ['limited', 'stopped'],
    ]);
    // Resumable by hand once an account has room
    assert.equal(stopped.workflow?.workflowRunId, 'wf_fake-001');
  } finally {
    r.close();
  }
});

test('stopping a graph held at a limit ends its wait', async () => {
  const r = await rig({ resetsInS: 3600 });
  try {
    const started = r.graph();
    const held = await until(r.core, started.id, (o) => r.core.rotation.waitOf(leadOf(o)) !== null, 'the wait');
    const [wait] = r.core.db.providerMoves({ chatId: leadOf(held) });
    r.core.orchestrator.stop(started.id);
    assert.equal(r.core.db.providerMove(wait?.id as string)?.state, 'cancelled');
    assert.equal(r.core.rotation.waitOf(leadOf(held)), null);
    assert.equal(r.core.orchestrator.get(started.id)?.status, 'stopped');
  } finally {
    r.close();
  }
});
