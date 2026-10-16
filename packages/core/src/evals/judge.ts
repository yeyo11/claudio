import type { EvalJudgeExample, EvalJudgedExpectation, EvalJudgement, ProviderId, ToolPolicy } from '@claudio/shared';
import { EVAL_LIMITS } from '@claudio/shared';
import type { ChatRuntime, NewChat, RunResult } from '../chats.ts';
import { PASTED_NOTE, pasted, thinkThrough } from '../prompt-rules.ts';
import type { SeenCall } from '../tool-calls.ts';

/*
 * The judge of a judged expectation (docs/plans/instruction-evals.md, "Judged expectations"): one
 * housekeeping chat per expectation and sample, in the shape of the decision engine's cli provider.
 * It has no tool and loads no settings file; the transcript reaches it as pasted data and the
 * verdict comes back as `structured_output`. A judge that fails gives `unjudged`, never a pass.
 */

/** The part of the chat runtime the judge drives; the tests hand it a recording stub */
export interface JudgeRuntime {
  start(opts: NewChat): ChatRuntime;
  waitForResult(id: string): Promise<RunResult>;
  stop(id: string): unknown;
  exited(id: string): Promise<void>;
  remove(id: string): boolean;
}

/** A judge chat may do nothing, so the policy says so outright */
export const JUDGE_POLICY: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'deny', gitPush: 'deny' };

/** Judged by `sonnet` unless the eval says otherwise: a judge must be at least as capable as what it grades */
export const DEFAULT_JUDGE_MODEL = 'sonnet';
const JUDGE_EFFORT = 'low';
const DEFAULT_DEADLINE_MS = 120_000;
const EXIT_GRACE_MS = 5_000;

/** One call as the judge reads it: its seq, and a one-line summary that is already masked */
export interface JudgeCall {
  seq: number;
  summary: string;
}

export interface JudgeInput {
  statement: string;
  calls: JudgeCall[];
  /** The sample's final text, or null when there was none */
  final: string | null;
}

export interface JudgeDeps {
  runtime: JudgeRuntime;
  /** `limits.maxJudgeCostUsd` */
  maxCostUsd?: number;
  /** The daily spend cap lets a judge run; without it every one may */
  spendOpen?: () => boolean;
  provider?: ProviderId;
  deadlineMs?: number;
}

const SUMMARY_CHARS = 300;
const FINAL_CHARS = 4000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A call folded to one line: its scope, name, input and outcome */
export function summariseCall(call: Pick<SeenCall, 'name' | 'scope' | 'outcome' | 'input'>): string {
  return clip(`${call.scope === 'sub' ? '[subagent] ' : ''}${call.name} ${JSON.stringify(call.input)} -> ${call.outcome}`, SUMMARY_CHARS);
}

export const foldCalls = (calls: ReadonlyArray<Pick<SeenCall, 'seq' | 'name' | 'scope' | 'outcome' | 'input'>>): JudgeCall[] =>
  calls.map((c) => ({ seq: c.seq, summary: summariseCall(c) }));

/** The schema the CLI holds the verdict to */
export function judgeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      reason: { type: 'string', maxLength: EVAL_LIMITS.judgeReasonChars },
      evidence: { type: 'array', items: { type: 'integer' } },
    },
    required: ['pass', 'reason', 'evidence'],
    additionalProperties: false,
  };
}

/**
 * The prompt: the statement, the numbered calls and the final text inside one `pasted()` block with
 * the note that marks them as data. The statement is the person's, the transcript is the agent's,
 * and neither steers the judge.
 */
export function judgePrompt(input: JudgeInput, model: string): string {
  const calls = input.calls.length ? input.calls.map((c) => `#${String(c.seq)} ${c.summary}`).join('\n') : '(no tool calls)';
  const material = [
    'Statement:',
    input.statement,
    '',
    'Tool calls, in order:',
    calls,
    '',
    'Final text:',
    input.final === null ? '(none)' : clip(input.final, FINAL_CHARS),
  ].join('\n');
  return [
    'You judge one statement against the record of an agent run. Say whether the statement holds for the run, using only the record below.',
    'Answer in the structured result: pass (true only when the record shows the statement holds), reason (English, one or two sentences, at most 400 characters) and evidence (the numbers of the calls your reason rests on, possibly none). When the record does not show it, the statement does not hold.',
    PASTED_NOTE,
    pasted(material),
    ...thinkThrough(model),
  ].join('\n\n');
}

/** Reads the structured result; null unless it is exactly a verdict. Evidence is cut to the seqs that exist. */
export function parseVerdict(raw: unknown, seqs: ReadonlySet<number>): { pass: boolean; reason: string; evidence: number[] } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { pass, reason, evidence } = raw as Record<string, unknown>;
  if (typeof pass !== 'boolean' || typeof reason !== 'string' || !Array.isArray(evidence)) return null;
  const seen = new Set<number>();
  for (const e of evidence) if (typeof e === 'number' && Number.isInteger(e) && seqs.has(e)) seen.add(e);
  return { pass, reason: clip(reason, EVAL_LIMITS.judgeReasonChars), evidence: [...seen].sort((a, b) => a - b) };
}

const unjudged = (idx: number, reason: string, model: string, costUsd: number | null): EvalJudgement => ({
  idx,
  pass: null,
  reason,
  evidence: [],
  costUsd,
  model,
  status: 'unjudged',
});

export interface JudgeCalibration {
  examples: number;
  /** Indexes of the examples the judge did not answer as marked */
  disagreements: number[];
  /** True with no example too: there is nothing to disagree with */
  reliable: boolean;
  costUsd: number;
}

export class EvalJudge {
  constructor(private readonly deps: JudgeDeps) {}

  /**
   * One judge chat for one judged expectation of one sample. `idx` is the expectation's index in its
   * case. Never throws: every failure is an `unjudged` judgement with its reason.
   */
  async judge(expectation: Pick<EvalJudgedExpectation, 'statement' | 'model'>, input: Omit<JudgeInput, 'statement'>, idx: number, signal?: AbortSignal): Promise<EvalJudgement> {
    const model = expectation.model ?? DEFAULT_JUDGE_MODEL;
    if (this.deps.spendOpen?.() === false) return unjudged(idx, 'The daily spend cap is reached.', model, null);
    if (signal?.aborted) return unjudged(idx, 'The judge was stopped.', model, null);
    const { runtime } = this.deps;
    let chat: ChatRuntime;
    try {
      chat = runtime.start({
        prompt: judgePrompt({ ...input, statement: expectation.statement }, model),
        name: 'eval judge',
        purpose: 'other',
        ...(this.deps.provider ? { provider: this.deps.provider } : {}),
        model,
        effort: JUDGE_EFFORT,
        maxBudgetUsd: this.deps.maxCostUsd ?? EVAL_LIMITS.maxJudgeCostUsd.default,
        jsonSchema: judgeSchema(),
        internal: true,
        keepAlive: false,
        uploads: false,
        api: false,
        confine: { tools: [], settingSources: [] },
        toolConfig: { preset: null, allowedTools: [], disallowedTools: [], mcp: null, policy: JUDGE_POLICY },
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
      });
    } catch {
      return unjudged(idx, 'The judge could not start.', model, null);
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const cut = new Promise<'cut'>((resolve) => {
        timer = setTimeout(() => resolve('cut'), this.deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
        onAbort = () => resolve('cut');
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([runtime.waitForResult(chat.id), cut]);
      if (result === 'cut') return unjudged(idx, signal?.aborted ? 'The judge was stopped.' : 'The judge timed out.', model, null);
      // A failed run still prints `subtype: "success"` (f0): only `is_error` and the structured output count
      if (result.cause === 'rate-limit') return unjudged(idx, 'The judge hit a usage limit.', model, result.costUsd);
      if (result.isError) return unjudged(idx, result.cause === 'budget' ? 'The judge ran over its cost cap.' : 'The judge failed.', model, result.costUsd);
      const verdict = parseVerdict(result.structuredOutput, new Set(input.calls.map((c) => c.seq)));
      if (!verdict) return unjudged(idx, 'The judge did not return a valid verdict.', model, result.costUsd);
      return { idx, pass: verdict.pass, reason: verdict.reason, evidence: verdict.evidence, costUsd: result.costUsd, model, status: 'judged' };
    } catch {
      return unjudged(idx, 'The judge failed.', model, null);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      await this.dispose(chat.id);
    }
  }

  /**
   * Runs the judge once on each calibration example. Reliable when every example is judged as the
   * person marked it; an example that could not be judged counts as a disagreement, since the
   * judge was not shown to agree.
   */
  async calibrate(expectation: Pick<EvalJudgedExpectation, 'statement' | 'model' | 'examples'>, signal?: AbortSignal): Promise<JudgeCalibration> {
    const examples: EvalJudgeExample[] = expectation.examples ?? [];
    const disagreements: number[] = [];
    let costUsd = 0;
    for (const [i, ex] of examples.entries()) {
      const calls = ex.calls.map((summary, n) => ({ seq: n + 1, summary }));
      const out = await this.judge(expectation, { calls, final: ex.final }, i, signal);
      costUsd += out.costUsd ?? 0;
      if (out.status !== 'judged' || out.pass !== ex.pass) disagreements.push(i);
    }
    return { examples: examples.length, disagreements, reliable: disagreements.length === 0, costUsd };
  }

  private async dispose(id: string): Promise<void> {
    try {
      this.deps.runtime.stop(id);
    } catch {
      // already over
    }
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([this.deps.runtime.exited(id), new Promise((r) => (grace = setTimeout(r, EXIT_GRACE_MS)))]).catch(() => undefined);
    if (grace) clearTimeout(grace);
    this.deps.runtime.remove(id);
  }
}
