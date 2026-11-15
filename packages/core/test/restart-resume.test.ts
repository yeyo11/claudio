import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RESTART_CONTINUE_TEXT, type ChatOrigin, type Orchestration, type SpendPurpose } from '@claudio/shared';
import { ChatManager, type CutTurn } from '../src/chats.ts';
import type { WorkflowRun } from '../src/cli-facts.ts';
import type { CoreConfig } from '../src/paths.ts';
import { Db } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { resumeEnv } from '../src/providers/claude-code/args.ts';
import { AUTO_CONTINUE_MAX_AGE_MS, continueCutTurns, MAX_RESTART_CHAIN, planCutTurn, type RestartResumeReport } from '../src/restart-resume.ts';
import { SessionStore } from '../src/sessions.ts';
import { readJournalTasks } from '../src/workflow-journal.ts';
import { tempConfig } from './helpers.ts';

// Layer 3 of docs/plans/survive-restarts.md (t1): what a start does with the turns the server before
// it left cut. Over the fake Claude, which continues a turn it was killed in when it is resumed with
// CLAUDE_CODE_RESUME_INTERRUPTED_TURN, as the CLI documents, and starts idle when the cut is older
// than the bound it was given. Every clock a decision reads is the test's.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CONTROL = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const MINUTE = 60_000;

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The fake's mark of a session killed mid-turn, as FAKE-HANG leaves it */
const cutMark = (sessionId: string): string => join(tmpdir(), `fake-claude-cut-${String(process.pid)}-${sessionId}`);

interface StoredCut {
  origin?: ChatOrigin;
  purpose?: SpendPurpose | null;
  /** When the previous server last wrote the chat, which is when its turn was cut */
  cutAt?: string;
  /** Executions before the cut one that a restart cut too */
  earlierCuts?: number;
  /** Its process sat idle, waiting for the person, when the server went away */
  idle?: true;
}

/** A data dir a server went away from with one chat per entry mid-turn; answers their ids. */
function previousServer(config: CoreConfig, chats: StoredCut[]): string[] {
  mkdirSync(config.workspaceDir, { recursive: true });
  const db = new Db(config);
  const ids = chats.map(() => randomUUID());
  db.saveChats(
    chats.map((c, i) => {
      const id = ids[i] as string;
      const cutAt = c.cutAt ?? new Date().toISOString();
      const execution = (endedAt: string | null, turnOpen = true) => ({
        id: randomUUID(),
        startedAt: new Date(Date.parse(cutAt) - MINUTE).toISOString(),
        endedAt,
        outcome: endedAt ? ('interrupted' as const) : null,
        error: endedAt ? 'interrupted by a wrapper restart' : null,
        permissionMode: 'acceptEdits' as const,
        model: null,
        maxBudgetUsd: null,
        costUsd: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
        turns: 1,
        ...(c.purpose === null ? {} : { purpose: c.purpose ?? ('person' as const) }),
        turnOpen,
      });
      writeFileSync(cutMark(id), cutAt);
      return {
        record: {
          id,
          name: `cut-${String(i)}`,
          cwd: config.workspaceDir,
          workingDir: config.workspaceDir,
          origin: c.origin ?? 'claudio',
          orchestrationId: null,
          orchestrationTaskId: null,
          derivedFrom: null,
          prompt: 'work on it',
          lastText: null,
          model: null,
          permissionMode: 'acceptEdits' as const,
          permissionPrompts: 'none' as const,
          createdAt: new Date(Date.parse(cutAt) - 2 * MINUTE).toISOString(),
          updatedAt: cutAt,
        },
        executions: [...Array.from({ length: c.earlierCuts ?? 0 }, () => execution(cutAt)), execution(null, !c.idle)],
      };
    }),
    200,
  );
  db.close();
  return ids;
}

/** One server on the data dir: its store and its chats, restored as a start restores them */
async function start(config: CoreConfig) {
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  await runs.restore(new SessionStore(config));
  return { db, runs };
}

function spawnsOf(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

function promptsOf(log: string): Array<{ resume: string | null; prompt: string; continued?: boolean }> {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { resume: string | null; prompt: string; continued?: boolean }) : [];
}

function sandbox(t: { after: (fn: () => void | Promise<void>) => void }) {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const spawns = join(config.dataDir, 'spawns.log');
  const prompts = join(config.dataDir, 'prompts.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  process.env.FAKE_CLAUDE_PROMPTS = prompts;
  t.after(() => {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    delete process.env.FAKE_CLAUDE_PROMPTS;
    delete process.env.FAKE_CLAUDE_CUT_AGE_MS;
    delete process.env.CLAUDIO_CONTINUE_START_MS;
    for (const f of readdirSync(tmpdir())) if (f.startsWith(`fake-claude-cut-${String(process.pid)}-`)) rmSync(join(tmpdir(), f), { force: true });
  });
  return { config, spawns, prompts };
}

const pass = (s: { runs: ChatManager; db: Db }, now: number, held: (id: string) => boolean = () => false): RestartResumeReport =>
  continueCutTurns({ runtime: s.runs, db: s.db, now: () => now, held });

const cut = (over: Partial<CutTurn> = {}): CutTurn => ({
  chatId: 'c',
  executionId: 'e',
  origin: 'claudio',
  purpose: 'person',
  cutAt: new Date(0).toISOString(),
  chain: 1,
  continuable: true,
  ...over,
});

// ---------- who continues what (D7) ----------

test("a person's turn cut less than an hour ago continues by itself, and one cut longer ago waits for Continue", () => {
  assert.deepEqual(planCutTurn(cut(), 30 * MINUTE), { action: 'continue' });
  assert.deepEqual(planCutTurn(cut(), AUTO_CONTINUE_MAX_AGE_MS), { action: 'continue' }, 'an hour to the millisecond is still within it');
  assert.equal(planCutTurn(cut(), AUTO_CONTINUE_MAX_AGE_MS + 1).action, 'offer');
  assert.equal(planCutTurn(cut({ origin: 'external' }), 5 * MINUTE).action, 'continue', 'a terminal chat Claudio drove is the person’s too');
});

test('automated work is left to its owner, an API chat is never replayed, and housekeeping ends', () => {
  for (const origin of ['api', 'internal', 'orchestration'] as const) assert.equal(planCutTurn(cut({ origin }), MINUTE).action, 'leave', origin);
  for (const purpose of ['flow', 'assistant', 'orchestration'] as const) assert.equal(planCutTurn(cut({ purpose }), MINUTE).action, 'leave', purpose);
});

test('a cut that cannot be continued safely by itself is offered to the person instead', () => {
  assert.equal(planCutTurn(cut({ purpose: null }), MINUTE).action, 'offer', 'an execution that did not record who started it');
  assert.equal(planCutTurn(cut({ continuable: false }), MINUTE).action, 'offer', 'a provider without the feature, or a process of the old server on the session');
  assert.equal(planCutTurn(cut({ chain: MAX_RESTART_CHAIN }), MINUTE).action, 'continue');
  assert.equal(planCutTurn(cut({ chain: MAX_RESTART_CHAIN + 1 }), MINUTE).action, 'offer', 'cut again and again: the restart may be what kills it');
});

test('the continuation variables reach only the process that continues a cut turn, never one inherited from the server', () => {
  const inherited = { PATH: '/bin', CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1', CLAUDE_CODE_RESUME_PROMPT: 'theirs' };
  assert.deepEqual(resumeEnv({ created: true }, { ...inherited }), { PATH: '/bin' });
  assert.deepEqual(resumeEnv({ created: true, continueCut: { maxAgeMs: 3_900_000, prompt: RESTART_CONTINUE_TEXT } }, { ...inherited }), {
    PATH: '/bin',
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: '3900000',
    CLAUDE_CODE_RESUME_PROMPT: RESTART_CONTINUE_TEXT,
  });
  assert.deepEqual(resumeEnv({ created: false, continueCut: { maxAgeMs: 1, prompt: 'x' } }, {}), {}, 'a session that never started has no turn to continue');
});

// ---------- over the fake CLI ----------

test("after a restart, a person's cut turn goes on in the same session by itself, with nothing written to it", async (t) => {
  const { config, spawns, prompts } = sandbox(t);
  const [id] = previousServer(config, [{ cutAt: new Date(Date.now() - 10 * MINUTE).toISOString() }]) as [string];
  const s = await start(config);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  assert.equal(s.runs.get(id)?.executions.at(-1)?.outcome, 'interrupted', 'the restore closed the cut execution as before');

  const report = pass(s, Date.now());
  assert.deepEqual(report.continued, [id]);
  const result = await s.runs.waitForResult(id);
  assert.equal(result.isError, false);
  assert.equal(result.result, `continued: ${RESTART_CONTINUE_TEXT}`, 'the agent continued its own turn, reading Claudio’s words');
  const done = await until(() => s.runs.get(id), (c) => c?.status === 'idle', 'the chat to wait for the person');
  assert.equal(done?.executions.length, 2, 'the cut execution, then the one that continued it');
  assert.equal(done?.executions[1]?.purpose, 'person');

  const started = spawnsOf(spawns);
  assert.equal(started.length, 1);
  assert.match(started[0] ?? '', new RegExp(`--resume ${id}`));
  assert.deepEqual(promptsOf(prompts).map((p) => [p.resume, Boolean(p.continued)]), [[id, true]], 'no prompt was sent beside the continuation');
});

test('a cut turn older than an hour waits for the person: no process starts by itself', async (t) => {
  const { config, spawns } = sandbox(t);
  const cutAt = new Date().toISOString();
  const [id] = previousServer(config, [{ cutAt }]) as [string];
  const s = await start(config);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  // The start comes back two hours after the cut, by the decision's own clock
  const report = pass(s, Date.parse(cutAt) + 2 * 60 * MINUTE);
  assert.deepEqual(report.offered, [id]);
  assert.deepEqual(report.continued, []);
  assert.equal(s.runs.get(id)?.pid, null);
  assert.equal(s.runs.get(id)?.executions.at(-1)?.outcome, 'interrupted', 'the chat still reads as cut, which the page offers Continue on');
  assert.deepEqual(spawnsOf(spawns), []);
});

test('API, housekeeping, orchestration and owned chats, and one at its limit, are not continued here', async (t) => {
  const { config, spawns } = sandbox(t);
  const ids = previousServer(config, [{ origin: 'api' }, { origin: 'internal' }, { origin: 'orchestration' }, { purpose: 'flow' }, {}]);
  const atLimit = ids[4] as string;
  const s = await start(config);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  const report = pass(s, Date.now(), (chatId) => chatId === atLimit);
  assert.deepEqual(report.continued, []);
  assert.deepEqual([...report.left].sort(), [...ids].sort());
  assert.deepEqual(spawnsOf(spawns), []);
});

test('a chat whose process sat idle when the server went away is not continued: no turn was cut', async (t) => {
  const { config, spawns } = sandbox(t);
  const [id] = previousServer(config, [{ idle: true }]) as [string];
  const s = await start(config);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  assert.equal(s.runs.get(id)?.executions.at(-1)?.outcome, 'interrupted', 'its process was lost all the same');
  const report = pass(s, Date.now());
  assert.deepEqual([report.continued, report.offered, report.left], [[], [], []], 'it is no cut turn at all');
  assert.deepEqual(spawnsOf(spawns), []);
});

test('a turn is written down as open when it starts and as closed at its result, which is what a restart reads', async (t) => {
  const { config } = sandbox(t);
  mkdirSync(config.workspaceDir, { recursive: true });
  const s = { db: new Db(config), runs: null as unknown as ChatManager };
  s.runs = new ChatManager(config, s.db);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  const hung = s.runs.start({ prompt: 'FAKE-HANG', name: 'hung', purpose: 'person' });
  await until(() => s.db.loadChat(hung.id)?.executions.at(-1), (e) => e?.turnOpen === true, 'the open turn to be written down');
  const done = s.runs.start({ prompt: 'hello', name: 'done', purpose: 'person' });
  await s.runs.waitForResult(done.id);
  await until(() => s.db.loadChat(done.id)?.executions.at(-1), (e) => e?.turnOpen === false, 'the ended turn to be written down');
  assert.equal(s.db.loadChat(done.id)?.executions.at(-1)?.purpose, 'person');
});

test('two servers on one data dir continue a cut turn once between them', async (t) => {
  const { config, spawns, prompts } = sandbox(t);
  const [id] = previousServer(config, [{}]) as [string];
  // Both read the store before either writes the cut down, so both see the same cut turn: what the claim is for
  const one = { db: new Db(config), runs: null as unknown as ChatManager };
  const two = { db: new Db(config), runs: null as unknown as ChatManager };
  one.runs = new ChatManager(config, one.db);
  two.runs = new ChatManager(config, two.db);
  await Promise.all([one.runs.restore(new SessionStore(config)), two.runs.restore(new SessionStore(config))]);
  assert.equal(one.runs.cutTurns().length + two.runs.cutTurns().length, 2, 'each found the turn cut');
  t.after(async () => {
    await one.runs.stopAll();
    await two.runs.stopAll();
    one.db.close();
    two.db.close();
  });
  const first = pass(one, Date.now());
  const second = pass(two, Date.now());
  assert.deepEqual(first.continued, [id]);
  assert.deepEqual(second.taken, [id], 'the claim the first one took is what the second finds');
  assert.equal((await one.runs.waitForResult(id)).isError, false);
  assert.equal(spawnsOf(spawns).length, 1);
  assert.equal(promptsOf(prompts).length, 1);
  // A later pass of the same server finds nothing cut any more
  assert.deepEqual(pass(one, Date.now()).continued, []);
});

test('a turn cut again and again stops continuing by itself', async (t) => {
  const { config, spawns } = sandbox(t);
  const [id] = previousServer(config, [{ earlierCuts: MAX_RESTART_CHAIN }]) as [string];
  const s = await start(config);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  assert.deepEqual(pass(s, Date.now()).offered, [id]);
  assert.deepEqual(spawnsOf(spawns), []);
});

test('a CLI that declines to continue starts idle, and the chat waits for the person instead of reading busy for ever', async (t) => {
  const { config } = sandbox(t);
  // The CLI's own clock finds the cut older than the bound it was given
  process.env.FAKE_CLAUDE_CUT_AGE_MS = String(10 * 60 * MINUTE);
  process.env.CLAUDIO_CONTINUE_START_MS = '300';
  const [id] = previousServer(config, [{}]) as [string];
  const s = await start(config);
  t.after(async () => {
    await s.runs.stopAll();
    s.db.close();
  });
  assert.deepEqual(pass(s, Date.now()).continued, [id]);
  assert.equal(s.runs.get(id)?.status, 'busy', 'the turn is taken as running while the CLI starts');
  const idle = await until(() => s.runs.get(id), (c) => c?.status === 'idle', 'the chat to go idle');
  assert.ok(idle?.pid, 'the process stays for the person’s next message');
  assert.equal(idle?.executions.at(-1)?.turns, 0, 'no turn ran');
});

// ---------- a workflow ----------

function workflowServer(config: CoreConfig, records: string) {
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const orchestrator = new Orchestrator(config, runs, db);
  orchestrator.workflowRecords = async (sessionId) => {
    const file = join(records, `${sessionId}.json`);
    if (!existsSync(file)) {
      const runsDir = join(records, sessionId, 'subagents', 'workflows');
      return existsSync(runsDir) ? readdirSync(runsDir).map((wf) => ({ id: wf, taskId: null, status: 'running' }) as WorkflowRun) : [];
    }
    const r = JSON.parse(readFileSync(file, 'utf8')) as { runId: string; taskId: string; result: unknown };
    return [{ id: r.runId, taskId: r.taskId, status: 'completed', result: r.result } as WorkflowRun];
  };
  orchestrator.workflowJournal = (sessionId, runId, from) => readJournalTasks(join(records, `${sessionId}.jsonl`), runId, from);
  return { db, runs, orchestrator };
}

test('a workflow a restart cut resumes from its cache in its own session, instead of stopping', async (t) => {
  const config = { ...tempConfig(), claudeBin: FAKE_CONTROL };
  mkdirSync(config.workspaceDir, { recursive: true });
  const records = mkdtempSync(join(tmpdir(), 'claudio-wf-records-'));
  process.env.FAKE_WORKFLOW_DIR = records;
  t.after(() => void delete process.env.FAKE_WORKFLOW_DIR);

  // The server before: the workflow runs, one agent held, when the server goes away
  const before = workflowServer(config, records);
  const started = before.orchestrator.create({
    name: 'Cut',
    engine: 'workflow',
    tasks: [
      { id: 'ok', name: 'OK', prompt: 'fine' },
      { id: 'held', name: 'Held', prompt: 'HOLD please' },
    ],
  });
  const running = await until(() => before.orchestrator.get(started.id), (o) => !!o?.workflow?.workflowRunId && !!before.runs.get(o.workflow.runId ?? '')?.pid, 'the workflow to run');
  const lead = running?.workflow?.runId as string;
  const workflowRunId = running?.workflow?.workflowRunId as string;
  const attempts = running?.tasks.map((x) => x.attempts);
  // What a crash leaves: the rows as they were last written, the lead's execution still open
  before.orchestrator.close();
  const leadRow = before.db.loadChat(lead);
  await before.runs.stopAll();
  assert.ok(leadRow);
  before.db.saveChats([leadRow], 200);
  before.db.close();

  const after = workflowServer(config, records);
  t.after(async () => {
    await after.runs.stopAll();
    after.orchestrator.close();
    after.db.close();
  });
  await after.runs.restore(new SessionStore(config));
  after.orchestrator.recover();
  const resumed = after.orchestrator.get(started.id) as Orchestration;
  assert.equal(resumed.status, 'running', 'resumed, not stopped');
  assert.equal(resumed.workflow?.runId, lead, 'in the session that holds its cache');
  assert.equal(resumed.workflow?.workflowRunId, workflowRunId);
  assert.deepEqual(resumed.tasks.map((x) => x.attempts), attempts, 'no task spent an attempt on the restart');
  await until(() => after.runs.get(lead), (c) => !!c?.pid, 'the lead to run again');
  writeFileSync(join(records, 'release'), '');
  const done = await until(() => after.orchestrator.get(started.id) as Orchestration, (o) => o.status !== 'running', 'the workflow to end');
  assert.equal(done.status, 'completed', JSON.stringify(done.tasks.map((x) => [x.id, x.status, x.error])));
  assert.equal(after.db.restartContinuations(started.id, ''), 1);
});
