import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ClaudioEventInput } from '../src/events.ts';
import type { EvalDefinition, EvalJudgement, EvalRunRequest, EvalRunSummary, RunEvent, TranscriptEntry } from '@claudio/shared';
import type { NewChat, RunResult } from '../src/chats.ts';
import { migrate } from '../src/db.ts';
import { RunSlotRefusal } from '../src/chat-errors.ts';
import { EvalConsents, sha256 } from '../src/evals/definition.ts';
import { createLane, runDirName } from '../src/evals/lanes.ts';
import {
  ceilingUsd,
  EvalRunner,
  EvalStartError,
  fitsCeiling,
  type EvalRunnerDeps,
  type EvalRuntime,
  type EvalStartInput,
} from '../src/evals/runner.ts';
import { EvalStore } from '../src/evals/store.ts';
import { loadConfig } from '../src/paths.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

interface Behavior {
  result?: Partial<RunResult>;
  calls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Never ends on its own: only `stop` ends it */
  hang?: boolean;
  delayMs?: number;
  account?: string;
}

/** The part of the chat runtime the runner drives, with a script for what each chat does. */
class FakeRuntime implements EvalRuntime {
  started: NewChat[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  seen: string[] = [];
  active = 0;
  maxActive = 0;
  refuse = 0;
  behave: (n: number, opts: NewChat) => Behavior = () => ({});
  onStart: (opts: NewChat) => void = () => {};
  private readonly chats = new Map<string, { settle: (r: RunResult) => void; promise: Promise<RunResult>; messages: TranscriptEntry[]; events: RunEvent[]; account: string | null; open: boolean }>();

  start(opts: NewChat): { id: string } {
    if (this.refuse > 0) {
      this.refuse--;
      throw new RunSlotRefusal(2);
    }
    const n = this.started.length;
    this.started.push(opts);
    this.onStart(opts);
    const b = this.behave(n, opts);
    const id = `chat-${n}`;
    let settle!: (r: RunResult) => void;
    const promise = new Promise<RunResult>((r) => (settle = r));
    const result: RunResult = { isError: false, result: 'done', structuredOutput: null, costUsd: 0.1, ...b.result };
    const messages: TranscriptEntry[] = [];
    (b.calls ?? []).forEach((c, i) => {
      messages.push({ uuid: `a${i}`, role: 'assistant', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_use', id: `tu${i}`, name: c.name, input: c.input }] } as TranscriptEntry);
      messages.push({ uuid: `u${i}`, role: 'user', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: [{ type: 'tool_result', toolUseId: `tu${i}`, content: 'ok', isError: false }] } as TranscriptEntry);
    });
    const events: RunEvent[] = [
      { seq: 1, ts: '', kind: 'init', init: { sessionId: id, model: 'claude-test', cwd: opts.cwd ?? '', permissionMode: 'dontAsk', tools: [], mcpServers: [] } },
      { seq: 2, ts: '', kind: 'result', outcome: { isError: result.isError, turns: 3, durationMs: 1234, costUsd: result.costUsd, permissionDenials: [] } },
    ];
    this.chats.set(id, { settle, promise, messages, events, account: b.account ?? null, open: true });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const finish = (r: RunResult) => {
      const chat = this.chats.get(id);
      if (!chat?.open) return;
      chat.open = false;
      this.active--;
      settle(r);
    };
    this.chats.get(id)!.settle = finish;
    if (!b.hang) setTimeout(() => finish(result), b.delayMs ?? 5);
    return { id };
  }
  waitForResult(id: string): Promise<RunResult> {
    this.seen.push(id);
    return this.chats.get(id)?.promise ?? Promise.reject(new Error('no chat'));
  }
  messages(id: string): TranscriptEntry[] | null {
    return this.chats.get(id)?.messages ?? null;
  }
  events(id: string): RunEvent[] {
    return this.chats.get(id)?.events ?? [];
  }
  stop(id: string): void {
    this.stopped.push(id);
    this.chats.get(id)?.settle({ isError: true, result: 'stopped', structuredOutput: null, costUsd: 0.02, cause: 'stopped' });
  }
  exited(): Promise<void> {
    return Promise.resolve();
  }
  remove(id: string): boolean {
    this.removed.push(id);
    return true;
  }
  accountOf(id: string): string | null {
    return this.chats.get(id)?.account ?? null;
  }
}

const waitFor = async (check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('instruction eval runner', () => {
  let tmp: string;
  let repo: string;
  let pin: string;
  let db: DatabaseSync;
  let store: EvalStore;
  let rt: FakeRuntime;
  let events: ClaudioEventInput[];
  let runner: EvalRunner;
  let config: ReturnType<typeof loadConfig>;
  let consents: EvalConsents;
  let extra: Partial<EvalRunnerDeps>;
  let maxRuns: number;

  const build = (over: Partial<EvalRunnerDeps> = {}): EvalRunner =>
    new EvalRunner({
      store, runtime: rt, config, consents, emit: (e) => events.push(e), projectPath: (id) => (id === 'p1' ? repo : null),
      maxConcurrentRuns: () => maxRuns, env: { CLAUDIO_EVALS_DIR: join(tmp, 'lanes') }, retryMs: 20, slackMs: 0, pollMs: 30, graceMs: 20,
      ...extra, ...over,
    });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claudio-runner-'));
    repo = join(tmp, 'repo');
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'CLAUDE.md'), 'committed rules\n');
    writeFileSync(join(repo, '.claude', 'agents', 'developer.md'), '---\ndescription: Dev\n---\ncommitted developer prompt\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
    pin = sh(repo, 'rev-parse', 'HEAD');
    config = loadConfig({ CLAUDE_CONFIG_DIR: join(tmp, 'claude'), CLAUDIO_WORKSPACE_DIR: join(tmp, 'ws'), CLAUDIO_DATA_DIR: join(tmp, 'data') });
    mkdirSync(config.dataDir, { recursive: true });
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    store = new EvalStore(db);
    rt = new FakeRuntime();
    events = [];
    extra = {};
    maxRuns = 5;
    consents = new EvalConsents(config);
    runner = build();
  });

  afterEach(async () => {
    await runner.close();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const def = (over: Partial<EvalDefinition> = {}): EvalDefinition => ({
    version: 1,
    title: 'Runs the tests',
    target: { kind: 'instructions', scope: 'project', name: 'CLAUDE.md' },
    pin,
    samples: 1,
    limits: { maxCostUsdPerSample: 0.5, timeoutMinutes: 1 },
    cases: [
      { id: 'c1', prompt: 'do one', expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm test' } }] },
      { id: 'c2', prompt: 'do two', expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm test' } }] },
    ],
    ...over,
  });
  const input = (d: EvalDefinition, request: Partial<EvalRunRequest> = {}): EvalStartInput => {
    const variants = request.variants ?? ['current'];
    const merged = { variants, confirmMaxCostUsd: 0, ...request } as EvalRunRequest;
    merged.confirmMaxCostUsd = request.confirmMaxCostUsd ?? ceilingUsd(d, merged, d.cases.length, variants.length, merged.samples ?? d.samples ?? 2);
    return { projectId: 'p1', evalName: 'tests-first', definition: d, sha: sha256(JSON.stringify(d)), request: merged };
  };
  const passes = (): Behavior => ({ calls: [{ name: 'Bash', input: { command: 'pnpm test' } }] });
  const ended = async (id: string): Promise<EvalRunSummary> => {
    await waitFor(() => store.summary(id)?.state === 'ended');
    return store.summary(id) as EvalRunSummary;
  };
  const labelOfRunning = (): string => {
    const s = store.runningSamples().find((x) => x.chatId === null);
    const sample = s ? store.sample(s.id) : null;
    return sample ? `${sample.caseId}·a${sample.attempt}·${sample.variant}` : '?';
  };
  const lanes = (): string[] => sh(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ') && l.includes('lanes'));

  it('queues case by case, attempt by attempt, variant by variant, and starts samples as housekeeping chats', async () => {
    maxRuns = 1;
    rt.behave = passes;
    const order: string[] = [];
    rt.onStart = () => order.push(labelOfRunning());
    const d = def({ samples: 2 });
    const run = await runner.start(input(d, { variants: ['current', 'proposed'], proposed: 'proposed rules\n', cases: ['c1', 'c2'] }));
    const done = await ended(run.id);
    assert.equal(done.outcome, 'completed');
    assert.deepEqual(order, [
      'c1·a1·current', 'c1·a1·proposed', 'c1·a2·current', 'c1·a2·proposed',
      'c2·a1·current', 'c2·a1·proposed', 'c2·a2·current', 'c2·a2·proposed',
    ]);
    assert.deepEqual(done.counts, { passed: 8 });
    const first = rt.started[0];
    assert.ok(first);
    assert.equal(first.internal, true);
    assert.equal(first.keepAlive, false);
    assert.equal(first.api, false);
    assert.equal(first.uploads, false);
    assert.equal(first.permissionMode, 'dontAsk');
    assert.equal(first.permissionPrompts, 'none');
    assert.equal(first.systemPromptSnapshot, 'off');
    assert.equal(first.maxBudgetUsd, 0.5);
    assert.equal(first.name, 'eval tests-first/c1');
    assert.ok(rt.removed.length === 8 && rt.stopped.length === 8, 'every chat is stopped and removed');
    assert.deepEqual(lanes(), [], 'no lane is left after the run');
    assert.ok(events.some((e) => e.type === 'eval.run') && events.filter((e) => e.type === 'eval.sample').length >= 16);
  });

  it('runs each variant on its own text: pinned as committed, current as in the checkout, proposed as sent', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), 'dirty current rules\n');
    const seen: Record<string, string> = {};
    rt.onStart = (opts) => {
      seen[labelOfRunning().split('·')[2] ?? '?'] = readFileSync(join(opts.cwd ?? '', 'CLAUDE.md'), 'utf8');
    };
    rt.behave = passes;
    maxRuns = 1;
    const run = await runner.start(input(def({ cases: [def().cases[0]!] }), { variants: ['pinned', 'current', 'proposed'], proposed: 'proposed rules\n' }));
    assert.equal((await ended(run.id)).outcome, 'completed');
    assert.deepEqual(seen, { pinned: 'committed rules\n', current: 'dirty current rules\n', proposed: 'proposed rules\n' });
    assert.equal(sh(repo, 'status', '--porcelain').includes('CLAUDE.md'), true, 'the checkout itself was not touched by the run');
    assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), 'dirty current rules\n');
  });

  it('an agent target runs as that agent from a definition file made of the variant text', async () => {
    rt.behave = passes;
    // One chat at a time, so rt.started is in queue order (pinned, then proposed): with two, each
    // start first writes its agents file, and the two writes may finish in either order
    maxRuns = 1;
    const d = def({ target: { kind: 'agent', scope: 'project', name: 'developer' }, runAs: { agent: 'developer', model: 'claude-sonnet-5-5' }, cases: [def().cases[0]!] });
    const agentText = '---\ndescription: Dev\ntools: Read, Edit\n---\nproposed developer prompt\n';
    const run = await runner.start(input(d, { variants: ['pinned', 'proposed'], proposed: agentText }));
    await ended(run.id);
    const [pinned, proposed] = rt.started;
    assert.equal(pinned?.agent, 'developer');
    assert.equal(proposed?.model, 'claude-sonnet-5-5');
    const body = (o?: NewChat) => JSON.parse(readFileSync(o?.agentsFile ?? '', 'utf8')).developer;
    assert.equal(body(pinned).prompt, 'committed developer prompt');
    assert.equal(body(proposed).prompt, 'proposed developer prompt');
    assert.equal(body(proposed).model, 'claude-sonnet-5-5');
    assert.ok(proposed?.agentsFile?.startsWith(join(config.dataDir, 'eval-agents')));
  });

  it('a team member runs under the policy the flow gives its stage', async () => {
    rt.behave = passes;
    let asked = '';
    extra = { memberRun: (_p, agent, stage) => ((asked = `${agent}/${stage}`), { permissionMode: 'acceptEdits', policy: { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'none' }, network: 'omit', gitPush: 'deny' }, model: 'claude-member' }) };
    runner = build();
    const d = def({ target: { kind: 'agent', scope: 'project', name: 'developer' }, runAs: { agent: 'developer', stage: 'verify' }, cases: [def().cases[0]!] });
    await ended((await runner.start(input(d, { variants: ['current'] }))).id);
    assert.equal(asked, 'developer/verify');
    assert.equal(rt.started[0]?.permissionMode, 'acceptEdits');
    assert.equal(rt.started[0]?.model, 'claude-member');
  });

  it('respects the concurrency cap, min(2, the global limit)', async () => {
    rt.behave = () => ({ ...passes(), delayMs: 40 });
    const d = def({ samples: 3 });
    await ended((await runner.start(input(d, { variants: ['current', 'proposed'], proposed: 'x\n' }))).id);
    assert.equal(rt.maxActive, 2);
    rt = new FakeRuntime();
    rt.behave = () => ({ ...passes(), delayMs: 20 });
    maxRuns = 1;
    runner = build();
    await ended((await runner.start(input(d, { variants: ['current', 'proposed'], proposed: 'x\n' }))).id);
    assert.equal(rt.maxActive, 1, 'the global limit wins when lower');
  });

  it('a refused start of a chat (the global run limit) is retried, not scored', async () => {
    rt.behave = passes;
    rt.refuse = 2;
    const run = await runner.start(input(def({ cases: [def().cases[0]!] })));
    const done = await ended(run.id);
    assert.equal(done.outcome, 'completed');
    assert.deepEqual(done.counts, { passed: 1 });
  });

  it('a usage limit gives a sample that is not scored and a new try from scratch', async () => {
    let first = true;
    rt.behave = () => {
      if (first) {
        first = false;
        return { result: { isError: true, cause: 'rate-limit', result: 'limit', costUsd: 0.05 } };
      }
      return passes();
    };
    maxRuns = 1;
    const run = await runner.start(input(def({ samples: 2, cases: [def().cases[0]!] })));
    const done = await ended(run.id);
    assert.equal(done.outcome, 'completed');
    assert.deepEqual(done.counts, { limit: 1, passed: 2 });
    const samples = store.samples(run.id);
    assert.deepEqual(samples.map((s) => [s.attempt, s.try, s.outcome]).sort(), [[1, 1, 'limit'], [1, 2, 'passed'], [2, 1, 'passed']]);
    assert.equal(rt.started.length, 3, 'a new chat for the new try, not a replay');
    assert.equal(done.scored.current?.of, 1);
  });

  it('gives up after three tries at a limit', async () => {
    rt.behave = () => ({ result: { isError: true, cause: 'rate-limit', result: 'limit', costUsd: 0 } });
    const run = await runner.start(input(def({ cases: [def().cases[0]!] })));
    const done = await ended(run.id);
    assert.deepEqual(done.counts, { limit: 3 });
    assert.equal(rt.started.length, 3);
  });

  it('with no account free the run waits for the reset and then goes on', async () => {
    let resetAt = 0;
    rt.behave = (n) => {
      if (n > 0) return passes();
      resetAt = Date.now() + 300;
      return { result: { isError: true, cause: 'rate-limit', result: 'limit', costUsd: 0 } };
    };
    extra = { availability: () => (Date.now() < resetAt ? { waitUntil: resetAt } : null) };
    runner = build();
    maxRuns = 1;
    const run = await runner.start(input(def({ cases: [def().cases[0]!] })));
    await waitFor(() => store.summary(run.id)?.state === 'waiting');
    assert.equal(store.summary(run.id)?.resetsAt, new Date(resetAt).toISOString());
    assert.equal(rt.started.length, 1, 'nothing spends while it waits');
    const done = await ended(run.id);
    assert.equal(done.outcome, 'completed');
    assert.deepEqual(done.counts, { limit: 1, passed: 1 });
    assert.ok(Date.now() >= resetAt);
    assert.ok(events.some((e) => e.type === 'eval.run' && e.state === 'waiting'));
  });

  it('a run pinned to an account passes it on and waits rather than switching', async () => {
    rt.behave = passes;
    const run = await runner.start(input(def({ cases: [def().cases[0]!] }), { account: 'acc-1' }));
    await ended(run.id);
    assert.equal(rt.started[0]?.account, 'acc-1');
  });

  it('a budget stop and a timeout are failures of the sample, with their reasons', async () => {
    rt.behave = (n) => (n === 0 ? { ...passes(), result: { isError: true, cause: 'budget', result: 'budget', costUsd: 0.5 } } : { hang: true });
    extra = { timeoutMs: 60 };
    runner = build();
    maxRuns = 1;
    const run = await runner.start(input(def()));
    const done = await ended(run.id);
    assert.deepEqual(done.counts, { failed: 2 });
    const [budget, timeout] = store.samples(run.id);
    assert.equal(budget?.reason, 'budget');
    assert.equal(timeout?.reason, 'timeout');
    assert.match(timeout?.checks[0]?.detail ?? '', /time limit/);
    assert.ok(rt.stopped.includes('chat-1'));
  });

  it('a CLI error is infra, and three in a row end the run failed', async () => {
    rt.behave = () => ({ result: { isError: true, result: 'login expired', costUsd: 0 } });
    const d = def({ samples: 3 });
    const run = await runner.start(input(d));
    const done = await ended(run.id);
    assert.equal(done.outcome, 'failed');
    assert.match(done.reason ?? '', /3 samples in a row/);
    assert.equal(done.counts.infra, 3);
    assert.equal(done.counts.passed ?? 0, 0);
  });

  it('stops at the ceiling: remaining samples are skipped and the run is capped', async () => {
    rt.behave = () => ({ ...passes(), result: { costUsd: 1 } });
    maxRuns = 1;
    // 4 samples at a 1 USD cap would be 5 USD with the margin; the run is held to 2.5
    const d = def({ samples: 2, limits: { maxCostUsdPerSample: 1, timeoutMinutes: 1, maxCostUsd: 2.5 } });
    const request = input(d, { variants: ['current'] });
    assert.equal(request.request.confirmMaxCostUsd, 2.5);
    const run = await runner.start(request);
    const done = await ended(run.id);
    assert.equal(done.outcome, 'capped');
    assert.deepEqual(done.counts, { passed: 2, skipped: 2 });
    assert.equal(done.costUsd, 2);
  });

  it('cost reservation arithmetic', () => {
    assert.equal(fitsCeiling(2.5, 1, 0, 1), true);
    assert.equal(fitsCeiling(2.5, 2, 0, 1), false);
    assert.equal(fitsCeiling(2.5, 0, 1.25, 1), true);
    assert.equal(fitsCeiling(2.5, 0, 2.5, 1), false);
    assert.equal(ceilingUsd(def(), {}, 2, 2, 2), 5);
    assert.equal(ceilingUsd(def(), { maxCostUsd: 3 }, 2, 2, 2), 3);
  });

  it('cancel aborts, stops the running chats and removes the lanes; a second cancel is a no-op', async () => {
    rt.behave = () => ({ hang: true });
    const run = await runner.start(input(def(), { variants: ['current', 'proposed'], proposed: 'x\n' }));
    await waitFor(() => rt.started.length === 2);
    assert.equal(lanes().length, 2);
    const cancelled = await runner.cancel(run.id);
    assert.equal(cancelled?.outcome, 'cancelled');
    assert.equal(new Set(rt.stopped).size, 2);
    assert.deepEqual(lanes(), []);
    assert.equal(existsSync(join(tmp, 'lanes', runDirName(run.id))), false);
    const counts = store.summary(run.id)?.counts ?? {};
    assert.equal(counts.queued ?? 0, 0);
    assert.equal(counts.running ?? 0, 0);
    const stops = rt.stopped.length;
    assert.equal((await runner.cancel(run.id))?.outcome, 'cancelled');
    assert.equal(rt.stopped.length, stops, 'nothing more is stopped');
    // The project is free for the next run
    rt.behave = passes;
    assert.equal((await ended((await runner.start(input(def()))).id)).outcome, 'completed');
  });

  it('refuses what the plan refuses, with a reason code', async () => {
    const code = async (i: EvalStartInput): Promise<string> => {
      try {
        await runner.start(i);
        return 'started';
      } catch (err) {
        return err instanceof EvalStartError ? err.code : String(err);
      }
    };
    const d = def();
    assert.equal(await code({ ...input(d), projectId: 'nope' }), 'not-git');
    assert.equal(await code(input(d, { confirmMaxCostUsd: 1 })), 'cost-not-confirmed');
    assert.equal(await code(input(def({ pin: 'b'.repeat(40) }))), 'pin-missing');
    assert.equal(await code(input(d, { variants: ['proposed'] })), 'proposed-required');
    assert.equal(await code(input(d, { variants: ['current'], cases: ['zzz'] })), 'unknown-case');
    assert.equal(await code(input(def({ target: { kind: 'instructions', scope: 'user', name: 'CLAUDE.md' } }), { variants: ['pinned'] })), 'user-scope-variant');
    assert.equal(await code(input(def({ target: { kind: 'agent', scope: 'project', name: 'ghost' }, runAs: { agent: 'ghost' } }), { variants: ['current'] })), 'target-missing');
    assert.equal(await code(input(def({ setup: 'echo hi' }))), 'consent-required');
    rt.behave = () => ({ hang: true });
    const live = await runner.start(input(d));
    assert.equal(await code(input(d)), 'eval-running');
    await runner.cancel(live.id);
  });

  it('runs a setup and a command check only for content the person accepted', async () => {
    rt.behave = (_n, opts) => ({ ...passes(), calls: [...(passes().calls ?? [])], result: { result: opts.cwd ?? '' } });
    const d = def({
      setup: 'echo ready > setup-marker',
      cases: [{ id: 'c1', prompt: 'p', expect: [{ kind: 'command', run: 'test -f setup-marker' }] }],
    });
    const i = input(d);
    await assert.rejects(runner.start(i), (e: unknown) => e instanceof EvalStartError && e.code === 'consent-required');
    await consents.grant(repo, i.evalName, i.sha);
    const done = await ended((await runner.start(i)).id);
    assert.deepEqual(done.counts, { passed: 1 });
    const sample = store.samples(done.id)[0];
    assert.equal(sample?.checks.find((c) => c.kind === 'command')?.passed, true);
  });

  it('a failing setup makes the sample infra with the output', async () => {
    rt.behave = passes;
    const d = def({ setup: 'echo broken >&2; exit 3', cases: [def().cases[0]!] });
    const i = input(d);
    await consents.grant(repo, i.evalName, i.sha);
    const done = await ended((await runner.start(i)).id);
    assert.equal(done.counts.infra, 1);
    assert.match(store.samples(done.id)[0]?.reason ?? '', /setup failed \(exit 3\).*broken/);
    assert.equal(rt.started.length, 0, 'no chat ran on a lane whose setup failed');
  });

  it('masks secrets in what it stores', async () => {
    rt.behave = () => ({ calls: [{ name: 'Bash', input: { command: 'pnpm test', env: 'API_KEY=supersecretvalue1234' } }], result: { result: 'token: abcdefghijkl1234' } });
    const done = await ended((await runner.start(input(def({ cases: [def().cases[0]!] })))).id);
    const sample = store.samples(done.id)[0];
    const calls = store.calls(sample?.id ?? '');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]?.input.includes('supersecretvalue1234'));
    assert.ok(!sample?.resultText?.includes('abcdefghijkl1234'));
    assert.equal(sample?.model, 'claude-test');
    assert.equal(sample?.turns, 3);
  });

  describe('restart', () => {
    const seed = (id: string, pid: number | null, startedAt: string) => {
      const d = def();
      store.insertRun(
        { id, projectId: 'p1', evalName: 'tests-first', definitionSha: 's', definition: d, variants: ['current'], samplesPerCase: 1, account: null, maxCostUsd: 5, startedBy: 'person', createdAt: new Date().toISOString() },
        [{ variant: 'current', targetPath: 'CLAUDE.md', present: true, contentSha: null, content: null }],
        [
          { id: `${id}-s1`, caseId: 'c1', variant: 'current', attempt: 1, seq: 1, pin },
          { id: `${id}-s2`, caseId: 'c2', variant: 'current', attempt: 1, seq: 2, pin },
        ],
        pid === null ? undefined : { pid, startedAt },
      );
      store.setRunState(id, 'running');
      store.claimSample(`${id}-s1`, pid ?? 1, 2, new Date().toISOString());
    };

    it('ends the runs of a dead owner interrupted, unscored, and sweeps their lanes', async () => {
      seed('dead0000-0000-0000-0000-000000000000', 4_000_001, 'older');
      await createLane(repo, join(tmp, 'lanes'), 'dead0000-0000-0000-0000-000000000000', 1, pin);
      assert.equal(lanes().length, 1);
      runner = build({ isAlive: () => false });
      await runner.load();
      const run = store.summary('dead0000-0000-0000-0000-000000000000');
      assert.equal(run?.state, 'ended');
      assert.equal(run?.outcome, 'interrupted');
      assert.deepEqual(run?.counts, { interrupted: 2 });
      assert.deepEqual(run?.scored, {});
      assert.deepEqual(lanes(), []);
      // The project is free again
      rt.behave = passes;
      assert.equal((await ended((await runner.start(input(def()))).id)).outcome, 'completed');
    });

    it('leaves the rows of a live other process alone, and recovers our own earlier life', async () => {
      seed('live0000-0000-0000-0000-000000000000', 4_000_002, 'whenever');
      runner = build({ isAlive: (pid) => pid === 4_000_002 });
      await runner.load();
      assert.equal(store.summary('live0000-0000-0000-0000-000000000000')?.state, 'running');
      store.endRun('live0000-0000-0000-0000-000000000000', { outcome: 'cancelled', endedAt: new Date().toISOString() });

      seed('self0000-0000-0000-0000-000000000000', process.pid, 'an earlier start');
      runner = build({ pid: process.pid, startedAt: 'this start', isAlive: () => true });
      await runner.load();
      assert.equal(store.summary('self0000-0000-0000-0000-000000000000')?.outcome, 'interrupted');
    });

    it('a row with the same pid and the same start belongs to this life', async () => {
      seed('mine0000-0000-0000-0000-000000000000', process.pid, 'this start');
      runner = build({ pid: process.pid, startedAt: 'this start' });
      await runner.load();
      assert.equal(store.summary('mine0000-0000-0000-0000-000000000000')?.state, 'running');
      store.endRun('mine0000-0000-0000-0000-000000000000', { outcome: 'cancelled', endedAt: new Date().toISOString() });
    });
  });

  it('marks its own chats as samples while they run, for the rotation', async () => {
    rt.behave = () => ({ hang: true });
    const run = await runner.start(input(def({ cases: [def().cases[0]!] })));
    await waitFor(() => rt.started.length === 1);
    await waitFor(() => runner.isSample('chat-0'));
    await runner.cancel(run.id);
    assert.equal(runner.isSample('chat-0'), false);
  });

  describe('phase 2: pressure, judge and gate', () => {
    type Expect = EvalDefinition['cases'][number]['expect'][number];
    const judged = (statement = 'it explains first'): Expect => ({ kind: 'judged', statement });
    const verdict = (idx: number, pass: boolean | null): EvalJudgement => ({
      idx, pass, reason: pass === null ? 'The judge failed.' : 'because', evidence: [], costUsd: 0.01, model: 'sonnet', status: pass === null ? 'unjudged' : 'judged',
    });
    class ScriptJudge {
      answers: Array<boolean | null> = [];
      reliable = true;
      judge(_e: unknown, _input: unknown, idx: number) {
        return Promise.resolve(verdict(idx, this.answers.length ? (this.answers.shift() ?? null) : true));
      }
      calibrate() {
        return Promise.resolve({ examples: 1, disagreements: this.reliable ? [] : [0], reliable: this.reliable, costUsd: 0.01 });
      }
    }
    const v2 = (cases: EvalDefinition['cases'], over: Partial<EvalDefinition> = {}): EvalDefinition => def({ version: 2, cases, ...over });
    const request = (d: EvalDefinition, cells: number, variants: EvalRunRequest['variants'], samples: number, extra = 0, more: Partial<EvalRunRequest> = {}): Partial<EvalRunRequest> => ({
      variants, samples, confirmMaxCostUsd: ceilingUsd(d, {}, cells, variants.length, samples, extra), ...more,
    });
    const calledTests = { kind: 'called', call: { tool: 'Bash', command: 'pnpm test' } } as Expect;

    it('queues a sample per level the case has a prompt for, and sends that level\'s prompt', async () => {
      rt.behave = passes;
      const d = v2([
        { id: 'c1', prompt: 'neutral one', prompts: { supportive: 'remember: tests', neutral: 'neutral one', competing: 'hurry, skip tests' }, expect: [calledTests] },
        { id: 'c2', prompt: 'neutral two', expect: [calledTests] },
      ]);
      const run = await runner.start(input(d, request(d, 4, ['current'], 1, 0, { pressures: ['supportive', 'neutral', 'competing'] })));
      const done = await ended(run.id);
      assert.equal(done.outcome, 'completed');
      assert.deepEqual(done.pressures, ['supportive', 'neutral', 'competing']);
      assert.deepEqual(rt.started.map((o) => o.prompt), ['remember: tests', 'neutral one', 'hurry, skip tests', 'neutral two']);
      assert.deepEqual(store.samples(run.id).map((s) => `${s.caseId}:${s.pressure}`), ['c1:supportive', 'c1:neutral', 'c1:competing', 'c2:neutral']);
    });

    it('the ceiling counts every level and every judge, and a start must repeat it', async () => {
      const d = v2([{ id: 'c1', prompt: 'p', prompts: { neutral: 'p', competing: 'q' }, expect: [judged()] }]);
      assert.equal(ceilingUsd(d, {}, 2, 1, 2, 0.05), Math.round(2 * 2 * 0.55 * 1.25 * 100) / 100);
      await assert.rejects(
        runner.start(input(d, { variants: ['current'], samples: 1, pressures: ['neutral', 'competing'], confirmMaxCostUsd: 0.7 })),
        (e: unknown) => e instanceof EvalStartError && e.code === 'cost-not-confirmed',
      );
    });

    it('a judged expectation is decided by the judge, with its verdict stored', async () => {
      rt.behave = () => ({});
      const judge = new ScriptJudge();
      judge.answers = [true, false];
      runner = build({ judgeFor: () => judge });
      const d = v2([{ id: 'c1', prompt: 'p', expect: [judged()] }]);
      const run = await runner.start(input(d, request(d, 1, ['current'], 2, 0.05)));
      const done = await ended(run.id);
      assert.deepEqual(done.counts, { passed: 1, failed: 1 });
      const [first, second] = store.samples(run.id);
      assert.equal(first?.checks.find((c) => c.kind === 'judged')?.judgement?.pass, true);
      assert.equal(second?.checks.find((c) => c.kind === 'judged')?.passed, false);
      assert.ok(done.costUsd > 0.2, 'the judge spend is part of the run cost');
    });

    it('a judge that fails leaves the sample unjudged; re-judging settles it without running it again', async () => {
      rt.behave = () => ({});
      const judge = new ScriptJudge();
      judge.answers = [null];
      runner = build({ judgeFor: () => judge });
      const d = v2([{ id: 'c1', prompt: 'p', expect: [{ kind: 'text', match: { contains: 'done' } }, judged()] }]);
      const run = await runner.start(input(d, request(d, 1, ['current'], 1, 0.05)));
      const done = await ended(run.id);
      assert.deepEqual(done.counts, { unjudged: 1 });
      assert.equal(done.scored.current, undefined, 'an unjudged sample is not scored');
      const startedBefore = rt.started.length;
      assert.deepEqual(await runner.rejudge(run.id), { rejudged: 1, unjudged: 0 });
      assert.equal(rt.started.length, startedBefore, 'no sample ran again');
      assert.deepEqual(store.summary(run.id)?.counts, { passed: 1 });
      const check = store.samples(run.id)[0]?.checks.find((c) => c.kind === 'judged');
      assert.equal(check?.judgement?.status, 'judged');
      assert.equal(check?.passed, true);
    });

    it('a failed deterministic check fails the sample even when the judge could not decide', async () => {
      rt.behave = () => ({});
      const judge = new ScriptJudge();
      judge.answers = [null];
      runner = build({ judgeFor: () => judge });
      const d = v2([{ id: 'c1', prompt: 'p', expect: [{ kind: 'text', match: { contains: 'never said' } }, judged()] }]);
      const run = await runner.start(input(d, request(d, 1, ['current'], 1, 0.05)));
      assert.deepEqual((await ended(run.id)).counts, { failed: 1 });
    });

    it('without a judge, a judged expectation is unjudged, never passed', async () => {
      rt.behave = () => ({});
      const d = v2([{ id: 'c1', prompt: 'p', expect: [judged()] }]);
      const run = await runner.start(input(d, request(d, 1, ['current'], 1, 0.05)));
      assert.deepEqual((await ended(run.id)).counts, { unjudged: 1 });
      assert.deepEqual(await runner.rejudge(run.id), { rejudged: 0, unjudged: 1 });
    });

    const gated = async (judge: ScriptJudge | null, expect: Expect[], examples = false): Promise<string> => {
      // The proposed text decides whether the fake agent runs the tests
      rt.behave = (_n, opts) => (readFileSync(join(opts.cwd ?? '', 'CLAUDE.md'), 'utf8').includes('lax') ? {} : passes());
      if (judge) runner = build({ judgeFor: () => judge });
      const withExamples = examples ? expect.map((e) => (e.kind === 'judged' ? { ...e, examples: [{ calls: [], final: 'x', pass: true }] } : e)) : expect;
      const d = v2([{ id: 'c1', prompt: 'p', mustHold: true, expect: withExamples }], { samples: 3 });
      const extra = expect.some((e) => e.kind === 'judged') ? 0.05 : 0;
      const run = await runner.start(input(d, request(d, 1, ['current', 'proposed'], 3, extra, { proposed: 'lax rules\n' })));
      await ended(run.id);
      return run.id;
    };

    it('the gate: regressed when a mustHold case stops passing, stored with the run', async () => {
      const id = await gated(null, [calledTests]);
      const gate = runner.gate(id);
      assert.equal(gate?.verdict, 'regressed');
      assert.deepEqual(gate?.regressed.map((r) => [r.caseId, r.pressure, r.from, r.to]), [['c1', 'neutral', 1, 0]]);
      assert.equal(store.gate(id)?.verdict, 'regressed');
    });

    it('the gate: incomplete while a mustHold sample is unjudged, promotable after re-judging', async () => {
      const judge = new ScriptJudge();
      judge.answers = [true, true, null, true, true, true];
      const id = await gated(judge, [judged()]);
      assert.equal(runner.gate(id)?.verdict, 'incomplete');
      assert.deepEqual(runner.gate(id)?.incomplete.map((i) => i.reason), ['unjudged', 'small-n']);
      await runner.rejudge(id);
      assert.equal(runner.gate(id)?.verdict, 'promotable');
    });

    it('the gate: an unreliable judge holds it until accepted', async () => {
      const judge = new ScriptJudge();
      judge.reliable = false;
      const id = await gated(judge, [judged()], true);
      assert.equal(runner.gate(id)?.verdict, 'incomplete');
      assert.deepEqual(runner.gate(id)?.unreliableJudges, [{ caseId: 'c1', idx: 0 }]);
      assert.equal(runner.acceptJudge(id, 'c1', 0)?.verdict, 'promotable');
      assert.equal(store.gate(id)?.verdict, 'promotable');
    });

    it('a run without both current and proposed has no gate', async () => {
      rt.behave = passes;
      const run = await runner.start(input(def({ cases: [def().cases[0]!] })));
      await ended(run.id);
      assert.equal(runner.gate(run.id), null);
    });
  });
});
