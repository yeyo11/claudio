import { randomUUID } from 'node:crypto';
import type { LimitWait, ReviewDimension, ReviewFinding, ReviewGateSpec, ReviewRound, ReviewRunState, ReviewSide } from '@claudio/shared';
import type { RunResult } from './chats.ts';
import { collectReviewDiff, type ReviewChunk, type ReviewDiff, type ReviewDiffFile } from './review-diff.ts';
import { anchor, dedupe, fingerprint, isBlocking, roundStatus, type AnchorIndex, type LineRange } from './review-findings.ts';
import { conventionsContext, reviewerPrompt, verifierPrompt, type ReviewTaskResult, type VerifierClaim } from './review-prompts.ts';
import { deliverRole, readRole, type ReviewRole } from './review-roles.ts';
import { scanDiff, securityTriggered, type ScanFile, type ScanFinding } from './review-scan.ts';
import { REVIEW_FINDINGS_SCHEMA, REVIEW_VERDICTS_SCHEMA, parseFindings, parseVerdicts, type ParsedFinding } from './review-schemas.ts';
import type { ReviewStore } from './review-store.ts';

/*
 * One round of the review gate: preparing, reviewing and verifying (docs/plans/review-gate.md,
 * "Where it runs"). It knows nothing of `Orchestration`: the caller hands it a directory, two
 * commits and a way to start chats, which is what lets the flow call it later (D4).
 */

/** Turns a reviewer may take: a second stop besides money, for a reviewer that reads without end */
export const REVIEWER_MAX_TURNS = 40;
/** The verifier reads less (up to four claims), so it gets fewer turns */
export const VERIFIER_MAX_TURNS = 24;
/** Claims per verifier run: more and the verifier skims */
export const VERIFIER_BATCH = 4;
/** Verifier runs per round, which bounds what a flood of high findings can cost */
export const VERIFIER_RUNS_MAX = 6;
/** The CLI answers "Concurrent run limit reached" until a slot frees; the tasks poll every 3 s too */
export const SLOT_RETRY_MS = 3000;
/** Cost of a reviewer's fixed prompt (role, rules, tools) before it reads any chunk, in USD */
export const FIXED_PROMPT_USD = 0.05;
/** USD per million input tokens of a Sonnet-class reviewer; set from the v0 recordings, never fetched */
export const INPUT_USD_PER_MTOK = 3;
/** Bytes per token for code, a rough constant: the estimate gates spending, it does not bill */
export const BYTES_PER_TOKEN = 4;
/** A reviewer reads about this many times its chunk once it opens the files around it */
export const CONTEXT_FACTOR = 1.5;
/** What a reviewer writes back and thinks, per run */
export const OUTPUT_ALLOWANCE_USD = 0.1;
/** One verifier run, on a bigger model reading a few files; added once to the estimate */
export const VERIFIER_ALLOWANCE_USD = 0.5;
/** Characters of the fixer's report shown to the verifier next round */
const FIXER_NOTE_CHARS = 1500;

/** The host the gate starts chats on; the orchestrator fills in the fixed, confined options */
export interface ReviewHost {
  start(req: ReviewLaunch): string;
  waitForResult(chatId: string): Promise<RunResult>;
  nextResult(chatId: string): Promise<RunResult>;
  stop(chatId: string): void;
  /** The rotation holds this chat's usage limit: it will replay the turn or wait for a reset */
  limitHeld(chatId: string): boolean;
  waitOf?(chatId: string): LimitWait | null;
}

export interface ReviewLaunch {
  prompt: string;
  cwd: string;
  model: string;
  jsonSchema: unknown;
  agent?: string;
  agentsFile?: string;
  appendSystemPrompt?: string;
  maxBudgetUsd: number;
  maxTurns: number;
  name: string;
}

export interface ReviewProgress {
  phase?: 'preparing' | 'reviewing' | 'verifying';
  costUsd?: number;
  waiting?: LimitWait | null;
  runs?: { total: number; done: number; running: number; failed: number };
}

export interface ReviewRoundContext {
  roundId: string;
  /** 1-based number of the round, for `resolved_in_round` */
  round: number;
  /** The directory the reviewers read: the graph's subdirectory of the integration worktree */
  dir: string;
  worktree: string;
  base: string;
  head: string;
  /** The project checkout the role files are read from, never the integration branch (D12) */
  projectHome: string;
  dataDir: string;
  spec: ReviewGateSpec;
  depth: 'light' | 'full';
  objective: string;
  tasks: readonly ReviewTaskResult[];
  host: ReviewHost;
  store: ReviewStore;
  signal: AbortSignal;
  /** USD the gate may still spend, over every round */
  budgetUsd: number;
  /** The previous round's blocking findings, to be asked about again when no reviewer repeats them */
  carry?: readonly ReviewFinding[];
  /** What the review fixer said, attached to the claims the verifier judges next */
  fixerNote?: string | null;
  onProgress?: (patch: ReviewProgress) => void;
  /** Tests shorten these */
  timeoutMs?: number;
  retryMs?: number;
  maxChunks?: number;
  chunkBytes?: number;
}

export interface RoundOutcome {
  status: 'passed' | 'blocked' | 'incomplete';
  reason: string;
  findings: ReviewFinding[];
  blocking: ReviewFinding[];
  /** Findings of the previous round the verifier found gone */
  resolved: string[];
  costUsd: number;
  estimateUsd: number | null;
  files: number;
  added: number;
  deleted: number;
  chunks: number;
  skippedFiles: ReviewRound['skippedFiles'];
  incompleteReasons: string[];
  runs: { total: number; done: number; running: number; failed: number };
}

// ---------- waiting for a run ----------

type Raced<T> = { kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'abort' };

function race<T>(promise: Promise<T>, timeoutMs: number | null, signal: AbortSignal): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve({ kind: 'abort' });
    let timer: NodeJS.Timeout | null = null;
    const done = (v: Raced<T>) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => done({ kind: 'abort' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== null) timer = setTimeout(() => done({ kind: 'timeout' }), Math.max(timeoutMs, 0));
    promise.then(
      (value) => done({ kind: 'value', value }),
      (err: unknown) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export type RunWait = { result: RunResult } | { timedOut: true } | { cancelled: true };

/**
 * Waits for a run under Claudio's own clock. A usage limit the rotation holds pauses the clock: the
 * wait is not the run's time, so it is waited on through `nextResult` with no timer, and the clock
 * resumes when the replayed turn answers.
 */
export async function awaitReviewRun(
  host: ReviewHost,
  chatId: string,
  timeoutMs: number,
  signal: AbortSignal,
  setWaiting: (wait: LimitWait | null) => void = () => undefined,
): Promise<RunWait> {
  let left = timeoutMs;
  let pending = host.waitForResult(chatId);
  for (;;) {
    const startedAt = Date.now();
    const out = await race(pending, left, signal);
    if (out.kind === 'timeout') {
      host.stop(chatId);
      return { timedOut: true };
    }
    if (out.kind === 'abort') {
      host.stop(chatId);
      return { cancelled: true };
    }
    left -= Date.now() - startedAt;
    const result = out.value;
    if (!(result.isError && result.cause === 'rate-limit' && host.limitHeld(chatId))) return { result };
    setWaiting(host.waitOf?.(chatId) ?? null);
    pending = host.nextResult(chatId);
    const held = await race(pending, null, signal);
    setWaiting(null);
    if (held.kind !== 'value') {
      host.stop(chatId);
      return { cancelled: true };
    }
    // The replayed turn may itself be limited again: the loop asks the same question of it
    pending = Promise.resolve(held.value);
  }
}

// ---------- helpers ----------

/** Runs `jobs` with at most `limit` at a time, in order of start */
async function pool<T>(jobs: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (!job) return;
      out[i] = await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

const sleep = (ms: number, signal: AbortSignal) => race(new Promise<void>((r) => setTimeout(r, ms)), null, signal);

const usd = (n: number) => `$${n.toFixed(2)}`;

function anchorIndex(diff: ReviewDiff): AnchorIndex {
  const span = (h: { start: number; count: number }): LineRange => [h.start, h.start + Math.max(h.count, 1) - 1];
  return new Map(Object.entries(diff.anchors).map(([path, r]) => [path, { right: r.new.map(span), left: r.old.map(span) }]));
}

function skippedOf(diff: ReviewDiff): ReviewRound['skippedFiles'] {
  const out: ReviewRound['skippedFiles'] = [];
  for (const f of diff.files) {
    if (f.notReviewable) out.push({ path: f.path, why: 'not-reviewable', detail: f.notReviewable });
    else if (f.class === 'excluded') out.push({ path: f.path, why: 'excluded', ...(f.excludedBy ? { detail: f.excludedBy } : {}) });
    else if (f.class === 'binary') out.push({ path: f.path, why: 'binary' });
    else if (f.class === 'submodule') out.push({ path: f.path, why: 'submodule' });
    else if (f.class === 'renamed-pure') out.push({ path: f.path, why: 'renamed', ...(f.previousPath ? { detail: f.previousPath } : {}) });
  }
  return out;
}

const isDoc = (path: string) => /\.md$/i.test(path) || path.startsWith('docs/');

/** What a round of these chunks would cost, before anything starts: gates the spending, never billed */
export function estimateRoundUsd(chunks: readonly ReviewChunk[], dimensions: number): number {
  let total = 0;
  for (const chunk of chunks) {
    const perRun = FIXED_PROMPT_USD + ((chunk.bytes / BYTES_PER_TOKEN) * INPUT_USD_PER_MTOK * CONTEXT_FACTOR) / 1_000_000 + OUTPUT_ALLOWANCE_USD;
    total += perRun * dimensions;
  }
  return total > 0 ? total + VERIFIER_ALLOWANCE_USD : 0;
}

/** Findings as they are while a round builds them, before the store gives them an id */
type Draft = Omit<ReviewFinding, 'id' | 'roundId' | 'fingerprint' | 'anchor' | 'blocking' | 'resolvedInRound' | 'verifierChatId' | 'reportedBy'> & {
  blockingByRule: boolean;
};

const toDraft = (f: ParsedFinding, dimension: ReviewDimension): Draft => ({
  source: 'model',
  rule: null,
  dimensions: [dimension],
  severity: f.severity,
  confidence: f.confidence,
  title: f.title,
  path: f.path,
  line: f.line,
  side: f.side as ReviewSide | null,
  evidence: f.evidence,
  failureScenario: f.failureScenario,
  suggestion: f.suggestion,
  verdict: 'not-asked',
  verdictReason: null,
  blockingByRule: false,
});

const fromScan = (f: ScanFinding): Draft => ({
  source: 'claudio',
  rule: f.rule,
  dimensions: f.dimensions,
  severity: f.severity,
  confidence: f.confidence,
  title: f.title,
  path: f.path,
  line: f.line,
  side: f.side,
  evidence: f.evidence,
  failureScenario: f.failureScenario,
  suggestion: f.suggestion,
  verdict: f.verdict,
  verdictReason: null,
  blockingByRule: f.blocking,
});

// ---------- the round ----------

export async function runReviewRound(ctx: ReviewRoundContext): Promise<RoundOutcome> {
  const { spec, store, host, signal } = ctx;
  const progress = ctx.onProgress ?? (() => undefined);
  const timeoutMs = ctx.timeoutMs ?? (spec.timeoutMinutes ?? 15) * 60_000;
  const retryMs = ctx.retryMs ?? SLOT_RETRY_MS;
  const runCap = spec.maxRunCostUsd ?? 1;
  let spent = 0;
  const tally = { total: 0, done: 0, running: 0, failed: 0 };
  const reasons: string[] = [];
  let overBudget = false;
  const charge = (usdSpent: number) => {
    spent += usdSpent;
    progress({ costUsd: spent });
  };
  const announce = () => progress({ runs: { ...tally } });
  const empty = (partial: Partial<RoundOutcome> & Pick<RoundOutcome, 'status' | 'reason'>): RoundOutcome => ({
    findings: [],
    blocking: [],
    resolved: [],
    costUsd: spent,
    estimateUsd: null,
    files: 0,
    added: 0,
    deleted: 0,
    chunks: 0,
    skippedFiles: [],
    incompleteReasons: [],
    runs: { ...tally },
    ...partial,
  });

  progress({ phase: 'preparing' });
  let hits: ScanFinding[] = [];
  let diff: ReviewDiff<ScanFinding>;
  try {
    diff = collectReviewDiff<ScanFinding>({
      worktree: ctx.worktree,
      base: ctx.base,
      head: ctx.head,
      ...(spec.exclude ? { exclude: spec.exclude } : {}),
      depth: ctx.depth,
      ...(ctx.maxChunks !== undefined ? { maxChunks: ctx.maxChunks } : {}),
      ...(ctx.chunkBytes !== undefined ? { chunkBytes: ctx.chunkBytes } : {}),
      scan: (files) => scanDiff(files.map((f): ScanFile => ({ path: f.path, excluded: f.class === 'excluded', added: f.added }))),
    });
  } catch (err) {
    return empty({ status: 'incomplete', reason: `The diff could not be collected: ${(err as Error).message}` });
  }
  hits = diff.hits;
  const base = {
    files: diff.stats.files,
    added: diff.stats.additions,
    deleted: diff.stats.deletions,
    chunks: diff.chunks.length,
    skippedFiles: skippedOf(diff),
  };
  const notReviewable = diff.files.filter((f) => f.notReviewable);
  const hasBlockingHit = hits.some((h) => h.blocking);
  if (diff.empty && !hasBlockingHit && notReviewable.length === 0) return empty({ status: 'passed', reason: diff.empty.reason, ...base });

  // Which dimensions run (docs/plans/review-gate.md, "Dimensions and when each runs")
  const full = ctx.depth === 'full';
  const dims: ReviewDimension[] = [];
  let conventionsText: string | null = null;
  if (diff.chunks.length > 0) {
    dims.push('correctness');
    const scanFiles = diff.files.filter((f) => f.class !== 'excluded').map((f): ScanFile => ({ path: f.path, added: f.added }));
    const dimensions = spec.dimensions ?? {};
    if (dimensions.tests !== false && full && diff.files.some((f) => f.class === 'reviewable' && !f.notReviewable && !isDoc(f.path))) dims.push('tests');
    const sec = dimensions.security ?? 'auto';
    if (sec === 'always' || (sec === 'auto' && securityTriggered(scanFiles))) dims.push('security');
    const conventions = dimensions.conventions !== false && full ? conventionsContext(ctx.worktree, ctx.base) : null;
    if (conventions) dims.push('conventions');
    conventionsText = conventions;
  }

  const estimateUsd = estimateRoundUsd(diff.chunks, dims.length);
  if (estimateUsd > ctx.budgetUsd) {
    return empty({
      status: 'incomplete',
      reason: `The review would need about ${usd(estimateUsd)} (estimate); its limit is ${usd(ctx.budgetUsd)} left.`,
      estimateUsd,
      incompleteReasons: ['over budget'],
      ...base,
    });
  }
  for (const f of notReviewable) reasons.push(`${f.path} could not be reviewed: ${f.notReviewable}`);

  // ---- reviewing ----
  progress({ phase: 'reviewing' });
  const reviewerModel = spec.models?.reviewer ?? 'sonnet';
  const verifierModel = spec.models?.verifier ?? 'opus';
  const roles = new Map<ReviewRole, Awaited<ReturnType<typeof readRole>>>();
  const roleOf = async (role: ReviewRole) => {
    let r = roles.get(role);
    if (!r) roles.set(role, (r = await readRole(ctx.projectHome, role)));
    return r;
  };
  const byPath = new Map<string, ReviewDiffFile>(diff.files.map((f) => [f.path, f]));
  const fileTexts = new Map<string, string>();
  for (const chunk of diff.chunks) for (const item of chunk.items) fileTexts.set(item.path, `${fileTexts.get(item.path) ?? ''}${item.text}\n`);
  const drafts: Draft[] = hits.map(fromScan);

  /** Starts one run and waits for it; every way it can end is a state of the run, never a throw */
  const execute = async (
    kind: 'reviewer' | 'verifier',
    meta: { dimension: ReviewDimension | null; chunk: number | null; chunks: number | null; model: string; role: ReviewRole; name: string; prompt: (roleBody: string, via: 'system') => string; schema: unknown },
  ): Promise<{ state: ReviewRunState; result: RunResult | null; chatId: string | null; failure: string | null; runId: string }> => {
    const runId = randomUUID();
    const role = await roleOf(meta.role);
    store.addRun({ id: runId, roundId: ctx.roundId, kind, dimension: meta.dimension, chunk: meta.chunk, chunks: meta.chunks, model: meta.model, roleSource: role.source, roleSha: role.sha, state: 'pending' });
    tally.total += 1;
    announce();
    const fail = (state: ReviewRunState, failure: string, chatId: string | null = null, cost = 0) => {
      store.updateRun(runId, { state, failure, costUsd: cost, endedAt: new Date().toISOString() });
      tally.failed += 1;
      announce();
      reasons.push(`${kind}${meta.dimension ? ` ${meta.dimension}` : ''}${meta.chunk ? ` ${String(meta.chunk)}/${String(meta.chunks)}` : ''}: ${failure}`);
      return { state, result: null, chatId, failure, runId };
    };
    if (signal.aborted) return fail('cancelled', 'stopped');
    const left = ctx.budgetUsd - spent;
    if (left <= 0) {
      overBudget = true;
      return fail('failed', 'gate budget spent');
    }
    let launch: Awaited<ReturnType<typeof deliverRole>>;
    try {
      launch = await deliverRole('agents', { dataDir: ctx.dataDir, role: meta.role, body: role.body, model: meta.model });
    } catch (err) {
      return fail('failed', `the role could not be prepared: ${(err as Error).message}`);
    }
    const deadline = Date.now() + timeoutMs;
    let chatId: string | null = null;
    for (;;) {
      try {
        chatId = host.start({
          prompt: meta.prompt(role.body, 'system'),
          cwd: ctx.dir,
          model: meta.model,
          jsonSchema: meta.schema,
          ...launch,
          maxBudgetUsd: Math.min(runCap, left),
          maxTurns: kind === 'reviewer' ? REVIEWER_MAX_TURNS : VERIFIER_MAX_TURNS,
          name: meta.name.slice(0, 60),
        });
        break;
      } catch (err) {
        const message = (err as Error).message;
        // The global run limit: a slot frees soon, and the wait counts against the run's own time
        if (message.includes('Concurrent run limit') && Date.now() < deadline) {
          const slept = await sleep(retryMs, signal);
          if (slept.kind === 'abort') return fail('cancelled', 'stopped');
          continue;
        }
        return fail('failed', message.includes('Concurrent run limit') ? 'no run slot came free in time' : message);
      }
    }
    store.updateRun(runId, { state: 'running', chatId, startedAt: new Date().toISOString() });
    tally.running += 1;
    announce();
    const waited = await awaitReviewRun(host, chatId, Math.max(deadline - Date.now(), 1), signal, (waiting) => progress({ waiting }));
    tally.running -= 1;
    if ('timedOut' in waited) return fail('timed-out', `the run took longer than ${String(Math.round(timeoutMs / 60_000))} min and was stopped`, chatId);
    if ('cancelled' in waited) return fail('cancelled', 'stopped', chatId);
    const { result } = waited;
    charge(result.costUsd);
    if (result.cause === 'budget') {
      overBudget = true;
      return fail('budget', 'the run hit its cost limit', chatId, result.costUsd);
    }
    if (result.cause === 'stopped') return fail('cancelled', 'stopped', chatId, result.costUsd);
    if (result.isError) return fail('failed', `the run ended with an error: ${result.result.slice(0, 300)}`, chatId, result.costUsd);
    // A success with no structured output is a failed review, never "no findings" (F2)
    if (result.structuredOutput === undefined || result.structuredOutput === null) return fail('invalid', 'the run ended without structured output', chatId, result.costUsd);
    return { state: 'done', result, chatId, failure: null, runId };
  };

  const finishRun = (runId: string, state: ReviewRunState, cost: number, extra: { dropped?: number; failure?: string | null } = {}) => {
    store.updateRun(runId, { state, costUsd: cost, endedAt: new Date().toISOString(), ...extra });
    if (state === 'done') tally.done += 1;
    else {
      tally.failed += 1;
      if (extra.failure) reasons.push(extra.failure);
    }
    announce();
  };

  const jobs: Array<() => Promise<void>> = [];
  for (const dimension of dims) {
    for (const chunk of diff.chunks) {
      jobs.push(async () => {
        const files = chunk.items.map((i) => byPath.get(i.path)).filter((f): f is ReviewDiffFile => !!f);
        const label = `reviewer ${dimension} ${String(chunk.index + 1)}/${String(diff.chunks.length)}`;
        const run = await execute('reviewer', {
          dimension,
          chunk: chunk.index + 1,
          chunks: diff.chunks.length,
          model: reviewerModel,
          role: dimension,
          name: `review:${dimension}:${String(chunk.index + 1)}`,
          schema: REVIEW_FINDINGS_SCHEMA,
          prompt: (body, via) =>
            reviewerPrompt({
              dimension,
              chunk: chunk.index + 1,
              chunks: diff.chunks.length,
              dir: ctx.dir,
              roleBody: body,
              roleVia: via,
              objective: ctx.objective,
              tasks: ctx.tasks,
              conventions: dimension === 'conventions' ? conventionsText : null,
              files: files.map((f) => ({ path: f.path, status: f.status, added: f.additions, deleted: f.deletions })),
              diff: chunk.items.map((i) => i.text).join('\n'),
              notReviewable: diff.skipped.map((s) => s.path).slice(0, 40),
              model: reviewerModel,
            }),
        });
        if (!run.result) return;
        const parsed = parseFindings(run.result.structuredOutput);
        if (!parsed.ok) {
          finishRun(run.runId, 'invalid', run.result.costUsd, { failure: `${label}: the output did not match the schema`, dropped: parsed.dropped });
          return;
        }
        for (const f of parsed.findings) drafts.push(toDraft(f, dimension));
        if (!parsed.coverage.complete) {
          finishRun(run.runId, 'incomplete-coverage', run.result.costUsd, { dropped: parsed.dropped, failure: `${label}: coverage incomplete${parsed.coverage.notReviewed ? ` (${parsed.coverage.notReviewed})` : ''}` });
        } else finishRun(run.runId, 'done', run.result.costUsd, { dropped: parsed.dropped });
      });
    }
  }
  await pool(jobs, spec.concurrency ?? 3);

  // ---- dedupe, anchor, fingerprint ----
  const index = anchorIndex(diff);
  type Merged = ReturnType<typeof dedupe<Draft & { dimensions: ReviewDimension[] }>>[number];
  const merged: Merged[] = dedupe(drafts);
  const finding = (m: Merged): ReviewFinding => ({
    id: randomUUID(),
    roundId: ctx.roundId,
    fingerprint: fingerprint(m),
    source: m.source,
    rule: m.rule,
    dimensions: m.dimensions,
    reportedBy: m.reportedBy,
    severity: m.severity,
    confidence: m.confidence,
    title: m.title,
    path: m.path,
    line: m.line,
    side: m.side,
    anchor: anchor(m, index),
    evidence: m.evidence,
    failureScenario: m.failureScenario,
    suggestion: m.suggestion,
    verdict: m.verdict,
    verdictReason: null,
    verifierChatId: null,
    blocking: false,
    resolvedInRound: null,
  });
  const blockingByRule = new Map<string, boolean>();
  const findings: ReviewFinding[] = [];
  for (const m of merged) {
    const f = finding(m);
    // The fingerprint is unique per round: a rare collision keeps the first
    if (findings.some((x) => x.fingerprint === f.fingerprint)) continue;
    blockingByRule.set(f.id, m.blockingByRule);
    findings.push(f);
  }

  // ---- verifying ----
  const needs = findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && f.verdict === 'not-asked');
  const repeated = new Set(findings.map((f) => f.fingerprint));
  const rechecks = (ctx.carry ?? []).filter((c) => !repeated.has(c.fingerprint));
  const claims: Array<{ finding: ReviewFinding | ReviewFinding; carried: boolean }> = [...needs.map((f) => ({ finding: f, carried: false })), ...rechecks.map((f) => ({ finding: f, carried: true }))];
  const resolved: string[] = [];
  const keptCarried: ReviewFinding[] = [];
  if (claims.length > 0 && !signal.aborted) {
    progress({ phase: 'verifying' });
    // Grouped by file so one verifier reads one file's diff once
    claims.sort((a, b) => (a.finding.path ?? '').localeCompare(b.finding.path ?? ''));
    const batches: (typeof claims)[] = [];
    for (let i = 0; i < claims.length; i += VERIFIER_BATCH) batches.push(claims.slice(i, i + VERIFIER_BATCH));
    const asked = batches.slice(0, VERIFIER_RUNS_MAX);
    const dropped = batches.slice(VERIFIER_RUNS_MAX).flat();
    if (dropped.length) {
      reasons.push('too many high findings to verify');
      for (const c of dropped) {
        if (c.carried) keptCarried.push({ ...c.finding, id: randomUUID(), roundId: ctx.roundId, verdict: 'unverified', verdictReason: 'too many high findings to verify', resolvedInRound: null });
        else {
          c.finding.verdict = 'unverified';
          c.finding.verdictReason = 'too many high findings to verify';
        }
      }
    }
    const note = ctx.fixerNote ? ctx.fixerNote.slice(0, FIXER_NOTE_CHARS) : null;
    await pool(
      asked.map((batch) => async () => {
        const ids = batch.map((_, i) => `f${String(i + 1)}`);
        const unverify = (why: string) => {
          for (const c of batch) {
            if (c.carried) keptCarried.push({ ...c.finding, id: randomUUID(), roundId: ctx.roundId, verdict: 'unverified', verdictReason: why, resolvedInRound: null });
            else {
              c.finding.verdict = 'unverified';
              c.finding.verdictReason = why;
            }
          }
        };
        const run = await execute('verifier', {
          dimension: null,
          chunk: null,
          chunks: null,
          model: verifierModel,
          role: 'verifier',
          name: `review:verify:${batch[0]?.finding.path ?? 'all'}`,
          schema: REVIEW_VERDICTS_SCHEMA,
          prompt: (body, via) =>
            verifierPrompt({
              dir: ctx.dir,
              roleBody: body,
              roleVia: via,
              objective: ctx.objective,
              model: verifierModel,
              claims: batch.map((c, i): VerifierClaim => ({
                id: ids[i] as string,
                title: c.finding.title,
                path: c.finding.path,
                line: c.finding.line,
                evidence: note ? `${c.finding.evidence}\nThe review fixer's report from the last round: ${note}` : c.finding.evidence,
                failureScenario: c.finding.failureScenario,
                diff: c.finding.path ? (fileTexts.get(c.finding.path) ?? '') : '',
                ...(c.carried ? { recheck: true } : {}),
              })),
            }),
        });
        if (!run.result) return unverify(run.failure ?? 'the verifier did not run');
        const parsed = parseVerdicts(run.result.structuredOutput, ids);
        if (!parsed.ok) {
          finishRun(run.runId, 'invalid', run.result.costUsd, { failure: 'verifier: the output did not match the schema' });
          return unverify('the verifier gave no usable answer');
        }
        finishRun(run.runId, 'done', run.result.costUsd);
        parsed.verdicts.forEach((v, i) => {
          const c = batch[i];
          if (!c) return;
          if (c.carried) {
            if (v.status === 'refuted') resolved.push(c.finding.id);
            else keptCarried.push({ ...c.finding, id: randomUUID(), roundId: ctx.roundId, verdict: v.status, verdictReason: v.reason, verifierChatId: run.chatId, resolvedInRound: null });
          } else {
            c.finding.verdict = v.status;
            c.finding.verdictReason = v.reason;
            c.finding.verifierChatId = run.chatId;
          }
        });
        if (parsed.verdicts.some((v) => v.status === 'unverified')) reasons.push('verifier: some findings were not answered');
      }),
      spec.concurrency ?? 3,
    );
  }
  // A claim carried from the last round that is still standing joins this one; it keeps its fingerprint
  for (const k of keptCarried) {
    if (findings.some((f) => f.fingerprint === k.fingerprint)) continue;
    blockingByRule.set(k.id, false);
    findings.push(k);
  }
  for (const f of findings) f.blocking = isBlocking({ source: f.source, blockingByRule: blockingByRule.get(f.id) ?? false, severity: f.severity, verdict: f.verdict });

  store.putFindings(ctx.roundId, findings.map((f) => ({ ...f, createdAt: new Date().toISOString() })));
  const blocking = findings.filter((f) => f.blocking);
  const stopped = signal.aborted;
  const status = stopped ? 'incomplete' : roundStatus({ blocking: blocking.length, runsNotOk: tally.failed, filesNotReviewable: notReviewable.length, overBudget });
  // The incomplete reasons stay listed next to a blocked round
  const why =
    status === 'passed'
      ? findings.length
        ? `No blocking findings (${String(findings.length)} advisory).`
        : 'The reviewers found nothing to block.'
      : status === 'blocked'
        ? `${String(blocking.length)} blocking finding${blocking.length === 1 ? '' : 's'}.`
        : stopped
          ? 'stopped'
          : 'The review did not finish.';
  const reason = [why, ...(status === 'passed' ? [] : [...new Set(reasons)].slice(0, 6))].join(' ');
  return {
    status,
    reason: stopped ? 'stopped' : reason,
    findings,
    blocking,
    resolved,
    costUsd: spent,
    estimateUsd,
    incompleteReasons: [...new Set(reasons)],
    runs: { ...tally },
    ...base,
  };
}
