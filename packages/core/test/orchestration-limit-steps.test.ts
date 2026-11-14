import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_ID, readingFromEvent } from '@claudio/accounts';
import type { LimitWait, Orchestration, OrchestrationChatRole, OrchestrationSpec, ProviderMove, VerificationSpec } from '@claudio/shared';
import type { RunResult } from '../src/chats.ts';
import { Core } from '../src/index.ts';
import { awaitReviewRun, type ReviewHost } from '../src/review-gate.ts';
import { signInDefault, tempConfig } from './helpers.ts';

// The steps of a graph that are not tasks (the integrator, the synthesis, the verification's fixer,
// the review gate's reviewers, verifier and fixer) at a usage limit, through a whole Core over the
// fake Claude: the rotation takes their limit as the graph's work, as it does a task's
// (docs/plans/limit-resume-and-credits.md, cause 4 and D7). `FAKE_CLAUDE_LIMIT_ONCE_IF` makes the
// first turn of the step whose prompt it matches die at the limit; the replayed turn goes through.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const INTEGRATOR = '^You are integrating the work';
const SYNTHESIS = '^Synthesize the results';
const FIXER = '^You are the fixer of the verification';
const REVIEW_FIXER = '^You are the review fixer';
const REVIEWER = 'Your dimension is `correctness`';
const VERIFIER = '^Other reviewers made claims';

const BLOCKER = JSON.stringify({
  findings: [{ title: 'The handler drops the input', severity: 'high', file: 'api.txt', line: 1, evidence: 'api.txt line one is the handler', failureScenario: 'an empty input is lost', confidence: 0.9 }],
  coverage: { complete: true },
});

const ENV = ['CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_LIMIT_ONCE_IF', 'FAKE_CLAUDE_LIMITED_DIRS', 'FAKE_CLAUDE_LIMIT_RESETS_IN'] as const;

function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'claudio-limit-steps-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Someone');
  git('config', 'user.email', 'someone@example.com');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

// A whole graph spawns the fake CLI a dozen times; the full test gate runs every suite at once and
// slows it many times over. Each check waits for something to happen, so the budget only bounds how
// long a real failure takes to report, and `seen` names the state it gave up on.
async function until<T>(read: () => T, done: (value: T) => boolean, what: string, ms = 60_000, seen?: () => unknown): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}${seen ? `; saw ${JSON.stringify(seen())}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sec = (ms: number) => Math.floor(ms / 1000);
/** A reading that says the account has room again: what a reset looks like to Claudio */
const roomy = (at: number) => readingFromEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0, resetsAt: sec(at) + 5 * 3600 } } }, at);

interface Rig {
  core: Core;
  repo: string;
  /** Account ids by alias; `default` is the CLI's own login */
  accounts: Record<string, string>;
  close: () => Promise<void>;
}

/** A Core over the fake Claude whose step matching `limitIf` meets the limit once; `second` adds an account with room. */
async function rig(limitIf: string, opts: { second?: boolean } = {}): Promise<Rig> {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const saved = ENV.map((name) => [name, process.env[name]] as const);
  process.env.CLAUDE_CONFIG_DIR = config.configDir;
  process.env.FAKE_CLAUDE_LIMIT_ONCE_IF = limitIf;
  delete process.env.FAKE_CLAUDE_LIMITED_DIRS;
  delete process.env.FAKE_CLAUDE_LIMIT_RESETS_IN;
  signInDefault(config);
  const core = new Core(config);
  const accounts: Record<string, string> = { default: DEFAULT_ID };
  await core.accounts.setSettings({ strategy: 'order' });
  if (opts.second) accounts.alpha = (await core.accounts.add({ kind: 'token', alias: 'alpha', secret: 'tok-alpha' })).id;
  return {
    core,
    repo: repoWithCommit(),
    accounts,
    close: async () => {
      await core.shutdown();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const settled = async (r: Rig, id: string, ms?: number): Promise<Orchestration> =>
  (await until(
    () => r.core.orchestrator.get(id),
    (o) => !!o && o.status !== 'running' && (!o.verification || (o.verification.status !== 'running' && o.verification.status !== 'pending')),
    'the graph to end',
    ms,
    () => {
      const o = r.core.orchestrator.get(id);
      return { status: o?.status, integration: o?.integration?.status, verification: o?.verification?.status, review: o?.verification?.review?.status, waits: r.core.db.providerMoves({ limit: 20 }).map((m) => [m.subjectId, m.state]) };
    },
  )) as Orchestration;

function graph(r: Rig, extra: Partial<OrchestrationSpec> = {}, objective: string[] = []): Orchestration {
  return r.core.orchestrator.create({
    name: 'steps',
    cwd: r.repo,
    worktree: true,
    synthesize: false,
    objective: ['Add the api', ...objective].join('\n'),
    tasks: [{ id: 'api', name: 'api', prompt: 'FAKE-WRITE api.txt server' }],
    ...extra,
  });
}

const reviewed = (review: Record<string, unknown> = {}, commands: string[] = ['true']): Partial<OrchestrationSpec> => ({
  verification: { commands, e2eSpecs: false, review: { maxFixRounds: 1, ...review } } as VerificationSpec,
});

/** The open waits of the graph's steps, by the subject the rotation recorded them under */
const openWaits = (r: Rig, id: string): ProviderMove[] =>
  r.core.db.providerMoves({ limit: 50 }).filter((m) => m.subjectId.startsWith(`${id}:`) && (m.state === 'waiting' || m.state === 'resuming'));

// ---------- each kind of step ----------

/** A step of a graph that is no task: the graph that runs it, the role it waits under, and what its graph ends with when it went through */
interface Kind {
  name: string;
  pattern: string;
  role: OrchestrationChatRole;
  subject: string;
  launch: (r: Rig) => Orchestration;
  wentThrough: (orch: Orchestration) => void;
}

const FIX_COMMAND = "echo 'FAKE-WRITE marker.txt repaired'; test -f marker.txt";

const KINDS: Kind[] = [
  {
    name: 'the integrator',
    pattern: INTEGRATOR,
    role: 'integration',
    subject: '__integration__',
    launch: (r) =>
      graph(r, {
        tasks: [
          { id: 'left', name: 'left', prompt: 'FAKE-WRITE same.txt from left' },
          { id: 'right', name: 'right', prompt: 'FAKE-WRITE same.txt from right' },
        ],
      }),
    wentThrough: (orch) => {
      assert.equal(orch.integration?.status, 'merged', orch.integration?.error ?? '');
      assert.equal(orch.integration?.conflicts.length, 1, 'the integrator had a conflict to resolve');
      assert.equal(orch.integration?.error, null, "the integrator's limited turn is not its answer");
    },
  },
  {
    name: 'the synthesis',
    pattern: SYNTHESIS,
    role: 'synthesis',
    subject: '__synthesis__',
    launch: (r) => graph(r, { synthesize: true }),
    wentThrough: (orch) => assert.doesNotMatch(orch.finalResult ?? '', /Synthesis failed/),
  },
  {
    name: "the verification's fixer",
    pattern: FIXER,
    role: 'verification',
    subject: '__verification__',
    launch: (r) => graph(r, { verification: { commands: [FIX_COMMAND], fixer: true, maxAttempts: 1, e2eSpecs: false } as VerificationSpec }),
    wentThrough: (orch) => {
      assert.equal(orch.verification?.status, 'fixed', orch.verification?.report ?? '');
      assert.equal(orch.verification?.fixes?.length, 1, 'one attempt, however the limit was carried through');
    },
  },
  {
    name: 'a reviewer',
    pattern: REVIEWER,
    role: 'review',
    subject: '__review__',
    launch: (r) => graph(r, reviewed()),
    wentThrough: (orch) => assert.equal(orch.verification?.review?.status, 'passed', orch.verification?.review?.reason ?? ''),
  },
  {
    name: 'the verifier',
    pattern: VERIFIER,
    role: 'review',
    subject: '__review__',
    launch: (r) => graph(r, reviewed({ fixer: false }), [`FAKE-RESULT-REVIEW-CORRECTNESS ${BLOCKER}`]),
    wentThrough: (orch) => {
      assert.equal(orch.verification?.review?.status, 'blocked', orch.verification?.review?.reason ?? '');
      assert.equal(orch.verification?.review?.counts.blocking, 1, 'the verifier answered and confirmed the claim');
    },
  },
  {
    name: 'the review fixer',
    pattern: REVIEW_FIXER,
    role: 'review',
    subject: '__review__',
    launch: (r) => graph(r, reviewed(), [`FAKE-RESULT-REVIEW-CORRECTNESS ${BLOCKER}`, 'FAKE-REVIEW-CLEAN-IF fixed.txt', 'FAKE-REVIEW-FIX fixed.txt yes']),
    wentThrough: (orch) => assert.equal(orch.verification?.review?.status, 'passed', orch.verification?.review?.reason ?? ''),
  },
];

for (const kind of KINDS) {
  test(`${kind.name} at a limit with another account free is moved to it, and the graph ends as if no limit had come`, async () => {
    const r = await rig(kind.pattern, { second: true });
    try {
      const started = kind.launch(r);
      const orch = await settled(r, started.id);
      kind.wentThrough(orch);
      const switches = r.core.db.rotationEvents().filter((e) => e.event === 'switch');
      assert.deepEqual(switches.map((e) => [e.from, e.to]), [[DEFAULT_ID, r.accounts.alpha]], 'one move, to the account with room');
      const chat = switches[0]?.data?.chatId as string;
      assert.equal(r.core.runtime.get(chat)?.orchestrationId, started.id, "the chat moved is the graph's");
      assert.equal(r.core.runtime.accountOf(chat), r.accounts.alpha);
      assert.equal(r.core.db.providerMoves({ limit: 50 }).length, 0, 'nothing waited');
    } finally {
      await r.close();
    }
  });
}

for (const kind of KINDS.filter((k) => k.name !== 'the verifier' && k.name !== 'the review fixer')) {
  test(`${kind.name} at a limit with no account free waits, the graph says so, and the step goes on when the account has room again`, async () => {
    const r = await rig(kind.pattern);
    try {
      const started = kind.launch(r);
      const [wait] = await until(() => openWaits(r, started.id), (w) => w.length > 0, `${kind.name}'s limit to be waited for`, 60_000, () => r.core.db.providerMoves({ limit: 20 }).map((m) => [m.subjectId, m.state]));
      assert.ok(wait);
      assert.equal(wait.subjectKind, 'task');
      assert.equal(wait.subjectId, `${started.id}:${kind.subject}`);
      const shown = r.core.orchestrator.view(r.core.orchestrator.get(started.id) as Orchestration);
      assert.deepEqual(
        shown.stepWaits?.map((w) => [w.role, w.chatId, w.moveId]),
        [[kind.role, wait.fromChat, wait.id]],
        'the graph says which step waits, in which chat',
      );

      // The account resets: a reading newer than the wait says it has room
      const reading = roomy(Math.max(Date.now(), Date.parse(wait.at) + 1));
      assert.ok(reading);
      await r.core.runtime.noteAccountReading(DEFAULT_ID, reading);
      const orch = await settled(r, started.id);
      kind.wentThrough(orch);
      assert.equal(r.core.db.providerMove(wait.id)?.state, 'resumed');
      assert.equal(r.core.runtime.get(wait.fromChat)?.executions.length, 2, 'the turn was replayed in the same chat, once');
      assert.equal(r.core.orchestrator.view(orch).stepWaits, undefined, 'and nothing is shown waiting');
    } finally {
      await r.close();
    }
  });
}

// ---------- a wait that ends for good ----------

test('a reviewer at a limit with no account to move to waits, and a wait that ends for good leaves the gate incomplete instead of holding it', async () => {
  const r = await rig(REVIEWER);
  try {
    const started = graph(r, reviewed());
    // Before, the rotation answered "this turn is not replayed" for a reviewer's chat and the round
    // failed it; now the reviewer's limit is the graph's work, so it waits like a task's
    const [wait] = await until(
      () => openWaits(r, started.id),
      (w) => w.length > 0,
      "the reviewer's limit to be waited for",
      60_000,
      () => ({ review: r.core.orchestrator.get(started.id)?.verification?.review?.status, moves: r.core.db.providerMoves({ limit: 20 }).map((m) => [m.subjectId, m.state]) }),
    );
    assert.ok(wait);
    assert.equal(wait.subjectId, `${started.id}:__review__`);
    // The gate says it waits, as its runs' hold reports it
    await until(() => r.core.orchestrator.get(started.id)?.verification?.review?.waiting?.moveId, (id) => id === wait.id, 'the gate to show the wait');
    assert.equal(r.core.orchestrator.get(started.id)?.verification?.review?.status, 'running', 'the gate holds while the reviewer waits');

    // A person stops waiting: the reviewer will never answer, and the gate must not wait for it
    assert.equal(r.core.rotation.cancel(wait.id), true);
    const orch = await settled(r, started.id);
    assert.equal(orch.verification?.review?.status, 'incomplete', orch.verification?.review?.reason ?? '');
    assert.match(orch.verification?.review?.reason ?? '', /a person stopped waiting for the usage limit to reset/);
    assert.equal(orch.verification?.status, 'failed');
    assert.equal(orch.verification?.gate, 'review');
    assert.equal(r.core.orchestrator.view(orch).stepWaits, undefined, 'nothing is shown waiting any more');
    // What a person can do now: run the review again
    assert.doesNotThrow(() => r.core.orchestrator.retryReview(started.id));
    const again = await settled(r, started.id);
    assert.equal(again.verification?.review?.status, 'passed', again.verification?.review?.reason ?? '');
  } finally {
    await r.close();
  }
});

test("a verification fixer whose wait ends for good fails the checks with the reason, and is not tried again on the same limit", async () => {
  const r = await rig(FIXER);
  try {
    const started = graph(r, { verification: { commands: [FIX_COMMAND], fixer: true, maxAttempts: 3, e2eSpecs: false } as VerificationSpec });
    const [wait] = await until(() => openWaits(r, started.id), (w) => w.length > 0, "the fixer's limit to be waited for");
    assert.ok(wait);
    assert.equal(r.core.rotation.cancel(wait.id), true);
    const orch = await settled(r, started.id);
    assert.equal(orch.verification?.status, 'failed');
    assert.match(orch.verification?.report ?? '', /the fixer stopped at a usage limit/);
    assert.equal(orch.verification?.fixes?.length, 1, 'no second attempt into the same limit');
    // What a person can do now: run the checks again once an account has room
    assert.doesNotThrow(() => r.core.orchestrator.verify(started.id));
  } finally {
    await r.close();
  }
});

test('stopping a graph ends the wait of a step held at a limit, so no turn is replayed for nobody', async () => {
  const r = await rig(SYNTHESIS);
  try {
    const started = graph(r, { synthesize: true });
    const [wait] = await until(() => openWaits(r, started.id), (w) => w.length > 0, "the synthesis's limit to be waited for");
    assert.ok(wait);
    r.core.orchestrator.stop(started.id);
    assert.equal(r.core.db.providerMove(wait.id)?.state, 'cancelled');
    const orch = await until(() => r.core.orchestrator.get(started.id), (o) => !!o?.synthesisEndedAt, 'the synthesis to let go');
    assert.equal(orch?.status, 'stopped');
    assert.match(orch?.finalResult ?? '', /Synthesis failed/);
  } finally {
    await r.close();
  }
});

// ---------- no limit ----------

test('a graph that never meets a limit integrates, verifies, reviews and synthesises as before, and nothing waits or moves', async () => {
  const r = await rig('^$');
  try {
    const started = graph(
      r,
      {
        synthesize: true,
        tasks: [
          { id: 'left', name: 'left', prompt: 'FAKE-WRITE same.txt from left' },
          { id: 'right', name: 'right', prompt: 'FAKE-WRITE same.txt from right' },
        ],
        verification: { commands: [FIX_COMMAND], fixer: true, maxAttempts: 1, e2eSpecs: false, review: { maxFixRounds: 1 } } as VerificationSpec,
      },
      [`FAKE-RESULT-REVIEW-CORRECTNESS ${BLOCKER}`, 'FAKE-REVIEW-CLEAN-IF fixed.txt', 'FAKE-REVIEW-FIX fixed.txt yes'],
    );
    const orch = await settled(r, started.id);
    assert.equal(orch.status, 'completed');
    assert.equal(orch.integration?.status, 'merged');
    assert.equal(orch.verification?.status, 'fixed', orch.verification?.report ?? '');
    assert.equal(orch.verification?.review?.status, 'passed', orch.verification?.review?.reason ?? '');
    assert.doesNotMatch(orch.finalResult ?? '', /Synthesis failed/);
    assert.deepEqual(r.core.db.rotationEvents(), []);
    assert.deepEqual(r.core.db.providerMoves({ limit: 50 }), []);
    assert.equal(r.core.orchestrator.view(orch).stepWaits, undefined);
    assert.equal(r.core.orchestrator.workOf(orch.synthesisRunId ?? ''), null, 'a step that is over is no work of the graph any more');
  } finally {
    await r.close();
  }
});

// ---------- the hold itself ----------

const limited: RunResult = { isError: true, result: "You've hit your usage limit", structuredOutput: undefined, costUsd: 0.01, cause: 'rate-limit' };

test('a held limit whose wait ends with no replay answers the limited result with why, and lets go of the chat', async () => {
  const wait: LimitWait = { provider: 'claude-code', resetsAt: null, moveId: 'm1' };
  const seen: Array<LimitWait | null> = [];
  let listening: AbortSignal | null = null;
  let release: (why: string) => void = () => undefined;
  const host: Omit<ReviewHost, 'start'> = {
    waitForResult: () => Promise.resolve(limited),
    // The replay never comes: only the end of the hold can answer
    nextResult: (_id, signal) => {
      listening = signal ?? null;
      return new Promise<RunResult>(() => undefined);
    },
    stop: () => undefined,
    limitHeld: () => true,
    waitOf: () => wait,
    released: (_id, _signal, onWait) =>
      new Promise((resolve) => {
        onWait(wait);
        release = resolve;
      }),
  };
  const out = awaitReviewRun(host, 'c1', 60, new AbortController().signal, (w) => seen.push(w));
  await new Promise((r) => setImmediate(r));
  release('a person stopped waiting for the usage limit to reset');
  const done = await out;
  assert.ok('result' in done);
  assert.equal(done.result.cause, 'rate-limit');
  assert.match(done.result.result, /usage limit \(a person stopped waiting/);
  assert.equal((listening as AbortSignal | null)?.aborted, true, "the chat's next result is not listened for any more");
  assert.equal(seen.at(-1), null, 'and the wait is no longer shown');
});

// ---------- the planner, which is no step of a graph ----------

test("a planner at its limit ends with the CLI's words, and a plan started after it runs on an account with room", async () => {
  const r = await rig('^$', { second: true });
  // The CLI's own login is out for an hour; the real CLI sends the rejected reading before its 429
  process.env.FAKE_CLAUDE_LIMITED_DIRS = r.core.accounts.ref(DEFAULT_ID).dir;
  process.env.FAKE_CLAUDE_LIMIT_RESETS_IN = '3600';
  const PLAN = JSON.stringify({ name: 'plan', engine: 'graph', engineReason: 'changes files', tasks: [{ id: 'a', name: 'A', prompt: 'do a' }] });
  try {
    const first = r.core.orchestrator.startPlan({ objective: `Ship it\nFAKE-RESULT-WORK ${PLAN}`, cwd: r.repo });
    // The planner's error is the CLI's own text, which says when the limit resets
    await assert.rejects(r.core.orchestrator.draft(first.id), /planner failed: You've hit your usage limit/);
    await r.core.runtime.exited(first.id);
    // Housekeeping with no session to resume: never replayed or waited for (D6), so nothing is left open for it
    assert.equal(r.core.db.providerMoves({ chatId: first.id }).length, 0);
    assert.equal(r.core.runtime.get(first.id)?.executions.length, 1, 'the planner was not replayed');
    // The person plans again once the page says why: by then the account's reading says it is out
    await until(() => r.core.accounts.get(DEFAULT_ID).limits?.state, (state) => state === 'exhausted', 'the reading of the account at its limit');

    const second = r.core.orchestrator.startPlan({ objective: `Ship it\nFAKE-RESULT-WORK ${PLAN}`, cwd: r.repo });
    const draft = await r.core.orchestrator.draft(second.id);
    assert.deepEqual(draft.tasks.map((t) => t.id), ['a']);
    assert.equal(r.core.runtime.accountOf(second.id), r.accounts.alpha, 'the account at its limit was passed over');
  } finally {
    await r.close();
  }
});
