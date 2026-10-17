import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LimitWait } from '@claudio/shared';
import { ChatRefusal, type RunResult } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import {
  awaitReviewRun,
  estimateRoundUsd,
  runReviewRound,
  VERIFIER_BATCH,
  VERIFIER_RUNS_MAX,
  type ReviewHost,
  type ReviewLaunch,
  type ReviewProgress,
  type ReviewRoundContext,
} from '../src/review-gate.ts';
import { ReviewStore } from '../src/review-store.ts';
import { tempConfig } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** A repository with a base commit and a head that adds `files` source files */
function repo(files = 1): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'review-gate-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.txt'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, 'src'));
  for (let i = 0; i < files; i += 1) writeFileSync(join(dir, 'src', `f${String(i)}.ts`), `export const value${String(i)} = ${String(i)};\nexport const other${String(i)} = value${String(i)} + 1;\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'work');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

const ok = (structuredOutput: unknown, costUsd = 0.01): RunResult => ({ isError: false, result: '', structuredOutput, costUsd });
const noFindings = { findings: [], coverage: { complete: true } };
const finding = (i: number, severity: 'critical' | 'high' | 'medium' | 'low' = 'high', file = `src/f${String(i)}.ts`) => ({
  title: `Problem number ${String(i)} in the module`,
  severity,
  file,
  line: 1,
  // Distinct words per finding, so deduplication never merges two of them
  evidence: `word${String(i)}alpha word${String(i)}beta word${String(i)}gamma`,
  failureScenario: `scenario${String(i)} breaks`,
  confidence: 0.9,
});
const review = (...findings: unknown[]) => ({ findings, coverage: { complete: true } });

interface Script {
  /** What a reviewer of this dimension answers; default zero findings */
  reviewer?: (req: ReviewLaunch, dimension: string) => RunResult | Promise<RunResult>;
  verifier?: (req: ReviewLaunch, ids: string[]) => RunResult | Promise<RunResult>;
  start?: (req: ReviewLaunch, n: number) => void;
}

function fakeHost(script: Script): { host: ReviewHost; launched: ReviewLaunch[]; stopped: string[]; peak: () => number } {
  const launched: ReviewLaunch[] = [];
  const stopped: string[] = [];
  const results = new Map<string, Promise<RunResult>>();
  let live = 0;
  let peak = 0;
  const host: ReviewHost = {
    start: (req) => {
      script.start?.(req, launched.length);
      launched.push(req);
      const id = `chat-${String(launched.length)}`;
      const dimension = /Your dimension is `(\w+)`/.exec(req.prompt)?.[1];
      live += 1;
      peak = Math.max(peak, live);
      const run = dimension
        ? Promise.resolve(script.reviewer?.(req, dimension) ?? ok(noFindings))
        : Promise.resolve(script.verifier?.(req, [...req.prompt.matchAll(/^Claim (f\d+)\./gm)].map((m) => m[1] as string)) ?? ok({ verdicts: [] }));
      results.set(id, run.finally(() => (live -= 1)));
      return id;
    },
    waitForResult: (id) => results.get(id) as Promise<RunResult>,
    nextResult: (id) => results.get(id) as Promise<RunResult>,
    stop: (id) => void stopped.push(id),
    limitHeld: () => false,
  };
  return { host, launched, stopped, peak: () => peak };
}

function setup(files = 1) {
  const r = repo(files);
  const config = tempConfig();
  const db = new Db(config);
  db.connection.prepare('INSERT INTO orchestrations (id, created_at, json) VALUES (?, ?, ?)').run('o1', new Date().toISOString(), '{}');
  const store = new ReviewStore(db.connection);
  const roundId = 'round-1';
  store.claimRound({ id: roundId, orchestrationId: 'o1', round: 1, pass: 1, base: r.base, head: r.head, depth: 'full', claimedBy: 'p', startedAt: new Date().toISOString() });
  const context = (host: ReviewHost, over: Partial<ReviewRoundContext> = {}): ReviewRoundContext => ({
    roundId,
    round: 1,
    dir: r.dir,
    worktree: r.dir,
    base: r.base,
    head: r.head,
    projectHome: mkdtempSync(join(tmpdir(), 'review-home-')),
    dataDir: config.dataDir,
    spec: {},
    depth: 'full',
    objective: 'Add the modules',
    tasks: [],
    host,
    store,
    signal: new AbortController().signal,
    budgetUsd: 5,
    retryMs: 5,
    ...over,
  });
  return { ...r, db, store, roundId, context };
}

test('zero findings pass the round, and the runs are recorded', async () => {
  const { db, store, context } = setup();
  const { host, launched } = fakeHost({});
  const out = await runReviewRound(context(host));
  assert.equal(out.status, 'passed');
  assert.equal(out.blocking.length, 0);
  // correctness and tests, one chunk each; nothing to verify
  assert.equal(launched.length, 2);
  assert.ok(launched.every((l) => l.maxTurns === 40 && l.maxBudgetUsd <= 1));
  assert.deepEqual(out.runs, { total: 2, done: 2, running: 0, failed: 0 });
  assert.equal(store.rounds('o1')[0]?.runs.length, 2);
  db.close();
});

test('medium findings alone pass with advisories and are never verified', async () => {
  const { db, store, roundId, context } = setup();
  const { host, launched } = fakeHost({ reviewer: (_r, d) => ok(d === 'correctness' ? review(finding(0, 'medium')) : noFindings) });
  const out = await runReviewRound(context(host));
  assert.equal(out.status, 'passed');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]?.blocking, false);
  assert.equal(launched.every((l) => /Your dimension/.test(l.prompt)), true, 'no verifier ran');
  assert.equal(store.findings(roundId, { limit: 10, offset: 0 }).total, 1);
  db.close();
});

test('a high finding the verifier confirms blocks; refuted passes; uncertain blocks', async () => {
  for (const [status, expected] of [['confirmed', 'blocked'], ['refuted', 'passed'], ['uncertain', 'blocked']] as const) {
    const { db, context } = setup();
    const { host } = fakeHost({
      reviewer: (_r, d) => ok(d === 'correctness' ? review(finding(0)) : noFindings),
      verifier: (_r, ids) => ok({ verdicts: ids.map((id) => ({ id, status, reason: `verifier says ${status}` })) }),
    });
    const out = await runReviewRound(context(host));
    assert.equal(out.status, expected, status);
    assert.equal(out.findings[0]?.verdict, status);
    assert.equal(out.findings[0]?.blocking, expected === 'blocked');
    db.close();
  }
});

test('a verifier that crashes leaves the findings unverified, which blocks, and the round lists why', async () => {
  const { db, context } = setup();
  const { host } = fakeHost({
    reviewer: (_r, d) => ok(d === 'correctness' ? review(finding(0)) : noFindings),
    verifier: () => ({ isError: true, result: 'boom', structuredOutput: null, costUsd: 0.01 }),
  });
  const out = await runReviewRound(context(host));
  assert.equal(out.status, 'blocked');
  assert.equal(out.findings[0]?.verdict, 'unverified');
  assert.ok(out.incompleteReasons.some((r) => /verifier/.test(r)));
  db.close();
});

test('a reviewer that crashes, answers nothing usable, times out or hits its budget makes the round incomplete', async () => {
  const cases: Array<[string, Script['reviewer'], Partial<ReviewRoundContext>]> = [
    ['crash', () => ({ isError: true, result: 'segfault', structuredOutput: null, costUsd: 0 }), {}],
    ['invalid', () => ok(undefined), {}],
    ['schema', () => ok({ nope: true }), {}],
    ['budget', () => ({ isError: true, result: 'over', structuredOutput: null, costUsd: 1, cause: 'budget' }), {}],
    ['timeout', () => new Promise<RunResult>(() => undefined), { timeoutMs: 40 }],
  ];
  for (const [name, reviewer, over] of cases) {
    const { db, store, context } = setup();
    const { host, stopped } = fakeHost({ reviewer });
    const out = await runReviewRound(context(host, over));
    assert.equal(out.status, 'incomplete', name);
    const states = store.rounds('o1')[0]?.runs.map((r) => r.state) ?? [];
    assert.ok(states.every((s) => s !== 'done'), `${name}: ${states.join(',')}`);
    if (name === 'timeout') assert.ok(stopped.length >= 1, 'the chat was stopped');
    db.close();
  }
});

test('coverage that is not complete makes the round incomplete but keeps the findings', async () => {
  const { db, store, context } = setup();
  const { host } = fakeHost({ reviewer: (_r, d) => ok(d === 'correctness' ? { findings: [finding(0, 'low')], coverage: { complete: false, notReviewed: 'src/f0.ts' } } : noFindings) });
  const out = await runReviewRound(context(host));
  assert.equal(out.status, 'incomplete');
  assert.equal(out.findings.length, 1);
  assert.ok(store.rounds('o1')[0]?.runs.some((r) => r.state === 'incomplete-coverage'));
  db.close();
});

test('runs start at most `concurrency` at a time', async () => {
  const { db, context } = setup();
  const { host, peak } = fakeHost({ reviewer: async () => (await new Promise((r) => setTimeout(r, 30)), ok(noFindings)) });
  // security always + tests + correctness: three reviewers
  await runReviewRound(context(host, { spec: { concurrency: 2, dimensions: { security: 'always' } } }));
  assert.equal(peak(), 2);
  db.close();
});

test('a refusal for the concurrent-run limit is retried until a slot frees', async () => {
  const { db, context } = setup();
  let refused = 0;
  const { host, launched } = fakeHost({
    start: () => {
      if (refused < 2) {
        refused += 1;
        throw new ChatRefusal('Concurrent run limit reached (8)', 409);
      }
    },
  });
  const out = await runReviewRound(context(host, { spec: { dimensions: { tests: false } } }));
  assert.equal(out.status, 'passed');
  assert.equal(refused, 2);
  assert.equal(launched.length, 1);
  db.close();
});

test('a model that no account offers fails the run with the reason', async () => {
  const { db, context } = setup();
  const { host } = fakeHost({ start: () => { throw new ChatRefusal('no account can run sonnet', 409); } });
  const out = await runReviewRound(context(host));
  assert.equal(out.status, 'incomplete');
  assert.ok(out.incompleteReasons.some((r) => /no account can run sonnet/.test(r)));
  db.close();
});

test('a usage limit the rotation holds pauses the clock until the replayed turn answers', async () => {
  const wait: LimitWait = { provider: 'claude-code', resetsAt: null, moveId: 'm1' };
  const seen: Array<LimitWait | null> = [];
  const replay = new Promise<RunResult>((resolve) => setTimeout(() => resolve(ok(noFindings)), 120));
  const host: ReviewHost = {
    start: () => 'c1',
    waitForResult: () => Promise.resolve({ isError: true, result: 'limit', structuredOutput: null, costUsd: 0, cause: 'rate-limit' }),
    nextResult: () => replay,
    stop: () => undefined,
    limitHeld: () => true,
    waitOf: () => wait,
  };
  // The clock is 60 ms; the wait is longer, and does not count
  const out = await awaitReviewRun(host, 'c1', 60, new AbortController().signal, (w) => seen.push(w));
  assert.ok('result' in out && !out.result.isError);
  assert.deepEqual(seen, [wait, null]);
});

test('a gate whose budget is spent starts no more runs and marks them failed', async () => {
  const { db, store, context } = setup();
  const { host, launched } = fakeHost({ reviewer: () => ok(noFindings, 3.2) });
  // concurrency 1: the first reviewer spends the three dollars that are left
  const out = await runReviewRound(context(host, { budgetUsd: 3.2, spec: { concurrency: 1 } }));
  assert.equal(out.status, 'incomplete');
  assert.equal(launched.length, 1);
  assert.ok(store.rounds('o1')[0]?.runs.some((r) => r.failure === 'gate budget spent'));
  db.close();
});

test('an estimate over the cap launches nothing and says so', async () => {
  const { db, context } = setup();
  const { host, launched } = fakeHost({});
  const out = await runReviewRound(context(host, { budgetUsd: 0.05 }));
  assert.equal(out.status, 'incomplete');
  assert.match(out.reason, /would need about \$\d+\.\d\d \(estimate\); its limit is \$0\.05/);
  assert.equal(launched.length, 0);
  assert.ok(out.estimateUsd && out.estimateUsd > 0.05);
  db.close();
});

test('the estimate is nothing for an empty diff and grows with the chunks', () => {
  assert.equal(estimateRoundUsd([], 3), 0);
  const chunk = { index: 0, items: [], bytes: 40_000 };
  assert.ok(estimateRoundUsd([chunk, chunk], 2) > estimateRoundUsd([chunk], 2));
});

test('an empty diff passes without starting a run', async () => {
  const { db, base, context } = setup();
  const { host, launched } = fakeHost({});
  const out = await runReviewRound(context(host, { head: base }));
  assert.equal(out.status, 'passed');
  assert.equal(launched.length, 0);
  db.close();
});

test('an abort stops the running chats and ends the round incomplete as stopped', async () => {
  const { db, context } = setup();
  const abort = new AbortController();
  // The abort has to land while a reviewer runs: before the round launched one (its diff is read
  // first, slow on a loaded machine) there is no chat to stop, and the check below would see none
  let started!: () => void;
  const reviewerRunning = new Promise<void>((resolve) => (started = resolve));
  const { host, stopped } = fakeHost({ reviewer: () => new Promise<RunResult>(() => undefined), start: () => started() });
  const progress: ReviewProgress[] = [];
  const running = runReviewRound(context(host, { signal: abort.signal, onProgress: (p) => progress.push(p) }));
  await reviewerRunning;
  abort.abort();
  const out = await running;
  assert.equal(out.status, 'incomplete');
  assert.equal(out.reason, 'stopped');
  assert.ok(stopped.length >= 1);
  db.close();
});

test('verifiers take at most four claims a run and six runs a round; the excess is unverified', async () => {
  const total = (VERIFIER_BATCH * VERIFIER_RUNS_MAX) + 6;
  const { db, context } = setup(total);
  const batches: number[] = [];
  const { host } = fakeHost({
    reviewer: (_r, d) => ok(d === 'correctness' ? review(...Array.from({ length: total }, (_, i) => finding(i))) : noFindings),
    verifier: (_r, ids) => {
      batches.push(ids.length);
      return ok({ verdicts: ids.map((id) => ({ id, status: 'refuted', reason: 'cannot happen' })) });
    },
  });
  // The schema allows 25 findings a run; the parser keeps the first 25
  const out = await runReviewRound(context(host, { spec: { dimensions: { tests: false } } }));
  assert.ok(batches.length <= VERIFIER_RUNS_MAX);
  assert.ok(batches.every((n) => n <= VERIFIER_BATCH));
  const unverified = out.findings.filter((f) => f.verdict === 'unverified');
  assert.equal(unverified.length, out.findings.length - batches.reduce((a, b) => a + b, 0));
  assert.ok(unverified.length > 0, 'more highs than the verifiers take');
  assert.equal(out.status, 'blocked');
  assert.ok(out.incompleteReasons.includes('too many high findings to verify'));
  db.close();
});

test('a blocking finding of the last round that no reviewer repeats is asked about again, and refuted ones are resolved', async () => {
  const first = setup();
  const { host: h1 } = fakeHost({
    reviewer: (_r, d) => ok(d === 'correctness' ? review(finding(0)) : noFindings),
    verifier: (_r, ids) => ok({ verdicts: ids.map((id) => ({ id, status: 'confirmed', reason: 'real' })) }),
  });
  const one = await runReviewRound(first.context(h1));
  assert.equal(one.blocking.length, 1);

  const { host: h2, launched } = fakeHost({ verifier: (_r, ids) => ok({ verdicts: ids.map((id) => ({ id, status: 'refuted', reason: 'fixed now' })) }) });
  const two = await runReviewRound(first.context(h2, { carry: one.blocking, fixerNote: 'I fixed it' }));
  const verifier = launched.find((l) => !/Your dimension/.test(l.prompt));
  assert.ok(verifier, 'the verifier was asked');
  assert.match(verifier.prompt, /still present at the current head/);
  assert.match(verifier.prompt, /I fixed it/);
  assert.equal(two.status, 'passed');
  assert.deepEqual(two.resolved, [one.blocking[0]?.id]);
  first.db.close();
});
