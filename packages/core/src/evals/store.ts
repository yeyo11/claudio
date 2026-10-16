import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  EVAL_LIMITS,
  EVAL_PRESSURES,
  type EvalCall,
  type EvalCheck,
  type EvalDefinition,
  type EvalGate,
  type EvalJudgement,
  type EvalPressure,
  type EvalRunOutcome,
  type EvalRunState,
  type EvalRunSummary,
  type EvalSample,
  type EvalSampleOutcome,
  type EvalVariant,
  type EvalVariantInfo,
} from '@claudio/shared';

/** Why a write was refused; `eval-running` is the API's 409 when a project already has a live run. */
export class EvalStoreError extends Error {
  constructor(
    readonly code: 'eval-running',
    message: string,
  ) {
    super(message);
    this.name = 'EvalStoreError';
  }
}

export interface NewEvalRun {
  id: string;
  projectId: string;
  evalName: string;
  definitionSha: string;
  definition: EvalDefinition;
  /** In queue order */
  variants: EvalVariant[];
  samplesPerCase: number;
  account: string | null;
  maxCostUsd: number;
  startedBy: 'person' | 'desktop';
  createdAt: string;
}

export interface NewEvalSample {
  id: string;
  caseId: string;
  variant: EvalVariant;
  /** Phase 2; a Phase 1 sample is `neutral` */
  pressure?: EvalPressure;
  attempt: number;
  seq: number;
  pin: string;
}

export interface SampleEnd {
  outcome: EvalSampleOutcome;
  reason?: string | null;
  chatId?: string | null;
  account?: string | null;
  model?: string | null;
  cliVersion?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  turns?: number | null;
  callsTruncated?: boolean;
  resultText?: string | null;
  endedAt: string;
}

export interface RunEnd {
  outcome: EvalRunOutcome;
  reason?: string | null;
  endedAt: string;
}

/** A stored row of a run, before the counts the summary adds. */
interface RunRow {
  id: string;
  project_id: string;
  eval_name: string;
  definition_sha: string;
  definition: string;
  variants: string;
  samples_per_case: number;
  account: string | null;
  state: EvalRunState;
  outcome: EvalRunOutcome | null;
  reason: string | null;
  resets_at: string | null;
  max_cost_usd: number;
  cost_usd: number;
  started_by: string;
  owner_pid: number | null;
  owner_started_at: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface SampleRow {
  id: string;
  run_id: string;
  case_id: string;
  variant: EvalVariant;
  pressure: EvalPressure;
  attempt: number;
  try: number;
  seq: number;
  state: EvalSample['state'];
  outcome: EvalSampleOutcome | null;
  reason: string | null;
  chat_id: string | null;
  account: string | null;
  model: string | null;
  cli_version: string | null;
  pin: string;
  cost_usd: number | null;
  duration_ms: number | null;
  turns: number | null;
  calls_truncated: number;
  result_text: string | null;
  owner_pid: number | null;
  started_at: string | null;
  ended_at: string | null;
}

interface CheckRow {
  sample_id: string;
  idx: number;
  kind: EvalCheck['kind'];
  passed: number;
  detail: string;
  evidence_seq: number | null;
  output: string | null;
}

interface JudgementRow {
  sample_id: string;
  idx: number;
  pass: number | null;
  reason: string;
  evidence: string;
  cost_usd: number | null;
  model: string | null;
  status: EvalJudgement['status'];
}

interface CallRow {
  seq: number;
  message: number;
  tool_use_id: string | null;
  name: string;
  scope: EvalCall['scope'];
  outcome: EvalCall['outcome'];
  input: string;
  result: string | null;
  at: string | null;
}

interface VariantRow {
  variant: EvalVariant;
  target_path: string;
  present: number;
  content_sha: string | null;
  content: string | null;
}

export interface EvalHistoryPage {
  runs: EvalRunSummary[];
  /** Pass it back as `before` for the next page; null on the last one */
  next: string | null;
}

/** The run a recovery found still marked live, and who owned it. */
export interface OrphanedRun {
  id: string;
  projectId: string;
  state: EvalRunState;
  ownerPid: number | null;
  ownerStartedAt: string | null;
}

const LIVE_STATES = "('queued','running','waiting')";

function sampleOf(row: SampleRow, checks: EvalCheck[]): EvalSample {
  return {
    id: row.id,
    runId: row.run_id,
    caseId: row.case_id,
    variant: row.variant,
    pressure: row.pressure,
    attempt: row.attempt,
    try: row.try,
    seq: row.seq,
    state: row.state,
    outcome: row.outcome,
    reason: row.reason,
    chatId: row.chat_id,
    account: row.account,
    model: row.model,
    cliVersion: row.cli_version,
    pin: row.pin,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    turns: row.turns,
    callsTruncated: row.calls_truncated === 1,
    resultText: row.result_text,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    checks,
  };
}

function judgementOf(row: JudgementRow): EvalJudgement {
  return {
    idx: row.idx,
    pass: row.pass === null ? null : row.pass === 1,
    reason: row.reason,
    evidence: JSON.parse(row.evidence) as number[],
    costUsd: row.cost_usd,
    model: row.model,
    status: row.status,
  };
}

function checkOf(row: CheckRow, judgements: Map<string, EvalJudgement> = new Map()): EvalCheck {
  const check: EvalCheck = { idx: row.idx, kind: row.kind, passed: row.passed === 1, detail: row.detail, evidenceSeq: row.evidence_seq, output: row.output };
  if (row.kind === 'judged') check.judgement = judgements.get(`${row.sample_id}\u0000${row.idx}`) ?? null;
  return check;
}

/** The SQL of the instruction evals (docs/plans/instruction-evals.md): rows in, rows out, no policy. */
export class EvalStore {
  constructor(private readonly db: DatabaseSync) {}

  private immediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Inserts a run with its variants and samples in one transaction, and drops the ended runs beyond
   * the newest 100 of the same eval. The partial unique index is the guard against a second live run
   * in a project: its violation becomes `eval-running`.
   */
  insertRun(run: NewEvalRun, variants: EvalVariantInfo[], samples: NewEvalSample[], owner?: { pid: number; startedAt: string }): void {
    try {
      this.immediate(() => {
        this.db
          .prepare(
            `INSERT INTO eval_runs (id, project_id, eval_name, definition_sha, definition, variants, samples_per_case, account, state,
               max_cost_usd, started_by, owner_pid, owner_started_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          )
          .run(
            run.id, run.projectId, run.evalName, run.definitionSha, JSON.stringify(run.definition), run.variants.join(','),
            run.samplesPerCase, run.account, run.maxCostUsd, run.startedBy, owner?.pid ?? null, owner?.startedAt ?? null, run.createdAt,
          );
        const addVariant = this.db.prepare(
          'INSERT INTO eval_variants (run_id, variant, target_path, present, content_sha, content) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const v of variants) addVariant.run(run.id, v.variant, v.targetPath, v.present ? 1 : 0, v.contentSha, v.content);
        const addSample = this.db.prepare(
          `INSERT INTO eval_samples (id, run_id, case_id, variant, pressure, attempt, seq, state, pin) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        );
        for (const s of samples) addSample.run(s.id, run.id, s.caseId, s.variant, s.pressure ?? 'neutral', s.attempt, s.seq, s.pin);
        this.pruneEval(run.projectId, run.evalName);
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: eval_runs\.project_id/.test(err.message)) {
        throw new EvalStoreError('eval-running', 'A run of this project is already queued, running or waiting');
      }
      throw err;
    }
  }

  /** Keeps the newest ended runs of one eval; the cascade takes their samples, calls and checks. */
  private pruneEval(projectId: string, evalName: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM eval_runs WHERE project_id = ? AND eval_name = ? AND state = 'ended' AND id NOT IN (
           SELECT id FROM eval_runs WHERE project_id = ? AND eval_name = ? AND state = 'ended'
           ORDER BY created_at DESC, id DESC LIMIT ?)`,
      )
      .run(projectId, evalName, projectId, evalName, EVAL_LIMITS.retainedRuns);
    return Number(result.changes);
  }

  /**
   * Takes a queued sample for `pid`, unless the run already has `maxRunning` samples running. Of two
   * claims of one sample exactly one returns true: the update is guarded by `state = 'queued'`.
   */
  claimSample(sampleId: string, pid: number, maxRunning: number, now: string): boolean {
    return this.immediate(() => {
      const row = this.db.prepare('SELECT run_id FROM eval_samples WHERE id = ?').get(sampleId) as { run_id: string } | undefined;
      if (!row) return false;
      const running = this.db.prepare("SELECT COUNT(*) AS n FROM eval_samples WHERE run_id = ? AND state = 'running'").get(row.run_id) as { n: number };
      if (running.n >= maxRunning) return false;
      const result = this.db
        .prepare("UPDATE eval_samples SET state = 'running', owner_pid = ?, started_at = ? WHERE id = ? AND state = 'queued'")
        .run(pid, now, sampleId);
      return Number(result.changes) > 0;
    });
  }

  /** Records the chat a running sample drives, so a recovery and the UI can find it. */
  bindChat(sampleId: string, chatId: string, fields: { account?: string | null; model?: string | null; cliVersion?: string | null } = {}): boolean {
    const result = this.db
      .prepare("UPDATE eval_samples SET chat_id = ?, account = ?, model = ?, cli_version = ? WHERE id = ? AND state = 'running'")
      .run(chatId, fields.account ?? null, fields.model ?? null, fields.cliVersion ?? null, sampleId);
    return Number(result.changes) > 0;
  }

  /** Ends a running sample and adds its cost to the run. False when it had already ended (or never ran). */
  endSample(sampleId: string, end: SampleEnd): boolean {
    return this.immediate(() => {
      const result = this.db
        .prepare(
          `UPDATE eval_samples SET state = 'ended', outcome = ?, reason = ?, chat_id = COALESCE(?, chat_id), account = COALESCE(?, account),
             model = COALESCE(?, model), cli_version = COALESCE(?, cli_version), cost_usd = ?, duration_ms = ?, turns = ?,
             calls_truncated = ?, result_text = ?, owner_pid = NULL, ended_at = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(
          end.outcome, end.reason ?? null, end.chatId ?? null, end.account ?? null, end.model ?? null, end.cliVersion ?? null,
          end.costUsd ?? null, end.durationMs ?? null, end.turns ?? null, end.callsTruncated ? 1 : 0, end.resultText ?? null,
          end.endedAt, sampleId,
        );
      if (Number(result.changes) === 0) return false;
      if (end.costUsd) {
        this.db
          .prepare('UPDATE eval_runs SET cost_usd = cost_usd + ? WHERE id = (SELECT run_id FROM eval_samples WHERE id = ?)')
          .run(end.costUsd, sampleId);
      }
      return true;
    });
  }

  /** Puts a sample back in the queue (a retry after a usage limit, or after its owner died). */
  requeueSample(sampleId: string): boolean {
    const result = this.db
      .prepare("UPDATE eval_samples SET state = 'queued', owner_pid = NULL, started_at = NULL, chat_id = NULL WHERE id = ? AND state = 'running'")
      .run(sampleId);
    return Number(result.changes) > 0;
  }

  /**
   * Adds the next try of a sample that a usage limit stopped: a new row, run again from scratch and
   * never replayed. The queue order of the original is kept.
   */
  addTry(sampleId: string, newId: string): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO eval_samples (id, run_id, case_id, variant, pressure, attempt, try, seq, state, pin)
         SELECT ?, run_id, case_id, variant, pressure, attempt, try + 1, seq, 'queued', pin FROM eval_samples WHERE id = ?`,
      )
      .run(newId, sampleId);
    return Number(result.changes) > 0;
  }

  /** Adds to a run's cost outside a sample's end (a judge's call, a command check). */
  addRunCost(runId: string, usd: number): void {
    this.db.prepare('UPDATE eval_runs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, runId);
  }

  addCalls(sampleId: string, calls: EvalCall[]): void {
    this.immediate(() => {
      const add = this.db.prepare(
        `INSERT INTO eval_calls (sample_id, seq, message, tool_use_id, name, scope, outcome, input, result, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of calls) add.run(sampleId, c.seq, c.message, c.toolUseId, c.name, c.scope, c.outcome, c.input, c.result, c.at);
    });
  }

  addChecks(sampleId: string, checks: EvalCheck[]): void {
    this.immediate(() => {
      const add = this.db.prepare(
        'INSERT INTO eval_checks (sample_id, idx, kind, passed, detail, evidence_seq, output) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of checks) add.run(sampleId, c.idx, c.kind, c.passed ? 1 : 0, c.detail, c.evidenceSeq, c.output);
    });
  }

  calls(sampleId: string): EvalCall[] {
    const rows = this.db.prepare('SELECT * FROM eval_calls WHERE sample_id = ? ORDER BY seq').all(sampleId) as unknown as CallRow[];
    return rows.map((r) => ({
      seq: r.seq, message: r.message, toolUseId: r.tool_use_id, name: r.name, scope: r.scope, outcome: r.outcome,
      input: r.input, result: r.result, at: r.at,
    }));
  }

  /** Replaces a sample's judgements: a re-judge after a usage limit overwrites the `unjudged` ones. */
  putJudgements(sampleId: string, judgements: EvalJudgement[]): void {
    this.immediate(() => {
      const put = this.db.prepare(
        `INSERT OR REPLACE INTO eval_judgements (sample_id, idx, pass, reason, evidence, cost_usd, model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const j of judgements) {
        put.run(sampleId, j.idx, j.pass === null ? null : j.pass ? 1 : 0, j.reason, JSON.stringify(j.evidence), j.costUsd, j.model, j.status);
      }
    });
  }

  judgements(sampleId: string): EvalJudgement[] {
    const rows = this.db.prepare('SELECT * FROM eval_judgements WHERE sample_id = ? ORDER BY idx').all(sampleId) as unknown as JudgementRow[];
    return rows.map(judgementOf);
  }

  private judgementsOfRun(runId: string): Map<string, EvalJudgement> {
    const rows = this.db
      .prepare('SELECT j.* FROM eval_judgements j JOIN eval_samples s ON s.id = j.sample_id WHERE s.run_id = ?')
      .all(runId) as unknown as JudgementRow[];
    return new Map(rows.map((r) => [`${r.sample_id}\u0000${r.idx}`, judgementOf(r)] as const));
  }

  /**
   * Settles a sample that ended `unjudged` (or whose checks are being redone) with its scored outcome,
   * without running it again: its calls are stored. False unless it was ended.
   */
  rescoreSample(sampleId: string, outcome: Extract<EvalSampleOutcome, 'passed' | 'failed' | 'unjudged'>, checks?: EvalCheck[]): boolean {
    return this.immediate(() => {
      const result = this.db.prepare("UPDATE eval_samples SET outcome = ? WHERE id = ? AND state = 'ended'").run(outcome, sampleId);
      if (Number(result.changes) === 0) return false;
      if (checks) {
        this.db.prepare('DELETE FROM eval_checks WHERE sample_id = ?').run(sampleId);
        const add = this.db.prepare('INSERT INTO eval_checks (sample_id, idx, kind, passed, detail, evidence_seq, output) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const c of checks) add.run(sampleId, c.idx, c.kind, c.passed ? 1 : 0, c.detail, c.evidenceSeq, c.output);
      }
      return true;
    });
  }

  /** Ids of a run's samples waiting for a judge, to re-judge after a reset. */
  unjudgedSamples(runId: string): string[] {
    const rows = this.db.prepare("SELECT id FROM eval_samples WHERE run_id = ? AND outcome = 'unjudged' ORDER BY seq, try").all(runId) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Stores the promotion gate's verdict and the detail it was computed from (JSON); null clears it. */
  setGate(runId: string, gate: EvalGate | null): void {
    this.db
      .prepare('UPDATE eval_runs SET gate = ?, gate_detail = ? WHERE id = ?')
      .run(gate?.verdict ?? null, gate ? JSON.stringify(gate) : null, runId);
  }

  /** The stored gate, or null when none was computed. */
  gate(runId: string): EvalGate | null {
    const row = this.db.prepare('SELECT gate_detail FROM eval_runs WHERE id = ?').get(runId) as { gate_detail: string | null } | undefined;
    return row?.gate_detail ? (JSON.parse(row.gate_detail) as EvalGate) : null;
  }

  /** Moves a live run on; false when it had already ended. */
  setRunState(runId: string, state: Exclude<EvalRunState, 'ended'>, fields: { resetsAt?: string | null; startedAt?: string } = {}): boolean {
    const result = this.db
      .prepare(
        `UPDATE eval_runs SET state = ?, resets_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND state != 'ended'`,
      )
      .run(state, fields.resetsAt ?? null, fields.startedAt ?? null, runId);
    return Number(result.changes) > 0;
  }

  /** Ends a live run, frees the project for the next one, and ends every sample that never ran. */
  endRun(runId: string, end: RunEnd): boolean {
    return this.immediate(() => {
      const result = this.db
        .prepare(
          `UPDATE eval_runs SET state = 'ended', outcome = ?, reason = ?, resets_at = NULL, owner_pid = NULL, owner_started_at = NULL, ended_at = ?
           WHERE id = ? AND state != 'ended'`,
        )
        .run(end.outcome, end.reason ?? null, end.endedAt, runId);
      if (Number(result.changes) === 0) return false;
      const outcome: EvalSampleOutcome = end.outcome === 'cancelled' ? 'cancelled' : end.outcome === 'interrupted' ? 'interrupted' : 'skipped';
      this.db
        .prepare(
          "UPDATE eval_samples SET state = 'ended', outcome = ?, reason = ?, owner_pid = NULL, ended_at = ? WHERE run_id = ? AND state != 'ended'",
        )
        .run(outcome, end.reason ?? null, end.endedAt, runId);
      this.pruneRunEval(runId);
      return true;
    });
  }

  private pruneRunEval(runId: string): void {
    const row = this.db.prepare('SELECT project_id, eval_name FROM eval_runs WHERE id = ?').get(runId) as
      | { project_id: string; eval_name: string }
      | undefined;
    if (row) this.pruneEval(row.project_id, row.eval_name);
  }

  /**
   * Opens an `interrupted` or `capped` run again: the samples that never scored (`skipped`,
   * `interrupted`) go back in the queue clean, and the ceiling is the one the person confirmed.
   * False when the run is not in such a state. The partial unique index makes a second live run of
   * the project an `eval-running` error, as for an insert.
   */
  reopenRun(runId: string, maxCostUsd: number, owner: { pid: number; startedAt: string }): boolean {
    try {
      return this.immediate(() => {
        const result = this.db
          .prepare(
            `UPDATE eval_runs SET state = 'queued', outcome = NULL, reason = NULL, resets_at = NULL, ended_at = NULL, max_cost_usd = ?,
               owner_pid = ?, owner_started_at = ?
             WHERE id = ? AND state = 'ended' AND outcome IN ('interrupted', 'capped')`,
          )
          .run(maxCostUsd, owner.pid, owner.startedAt, runId);
        if (Number(result.changes) === 0) return false;
        const pending = "run_id = ? AND state = 'ended' AND outcome IN ('skipped', 'interrupted')";
        this.db.prepare(`DELETE FROM eval_calls WHERE sample_id IN (SELECT id FROM eval_samples WHERE ${pending})`).run(runId);
        this.db.prepare(`DELETE FROM eval_checks WHERE sample_id IN (SELECT id FROM eval_samples WHERE ${pending})`).run(runId);
        this.db
          .prepare(
            `UPDATE eval_samples SET state = 'queued', outcome = NULL, reason = NULL, owner_pid = NULL, chat_id = NULL, started_at = NULL, ended_at = NULL,
               cost_usd = NULL, duration_ms = NULL, turns = NULL, result_text = NULL, calls_truncated = 0
             WHERE ${pending}`,
          )
          .run(runId);
        return true;
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: eval_runs\.project_id/.test(err.message)) {
        throw new EvalStoreError('eval-running', 'A run of this project is already queued, running or waiting');
      }
      throw err;
    }
  }

  /** Deletes a run and, by cascade, everything under it. Refuses a live run. */
  deleteRun(runId: string): boolean {
    const result = this.db.prepare("DELETE FROM eval_runs WHERE id = ? AND state = 'ended'").run(runId);
    return Number(result.changes) > 0;
  }

  /** Deletes every ended run of one eval (the file was removed, or the person cleared its history). */
  deleteHistory(projectId: string, evalName: string): number {
    const result = this.db.prepare("DELETE FROM eval_runs WHERE project_id = ? AND eval_name = ? AND state = 'ended'").run(projectId, evalName);
    return Number(result.changes);
  }

  // ---------- reads ----------

  /** The project's live run, if any. */
  liveRun(projectId: string): EvalRunSummary | null {
    const row = this.db.prepare(`SELECT * FROM eval_runs WHERE project_id = ? AND state IN ${LIVE_STATES}`).get(projectId) as RunRow | undefined;
    return row ? this.summaryOf(row) : null;
  }

  summary(runId: string): EvalRunSummary | null {
    const row = this.db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? this.summaryOf(row) : null;
  }

  /** The run's `definition` as it was run, parsed. */
  definition(runId: string): EvalDefinition | null {
    const row = this.db.prepare('SELECT definition FROM eval_runs WHERE id = ?').get(runId) as { definition: string } | undefined;
    return row ? (JSON.parse(row.definition) as EvalDefinition) : null;
  }

  variants(runId: string): EvalVariantInfo[] {
    const rows = this.db.prepare('SELECT * FROM eval_variants WHERE run_id = ?').all(runId) as unknown as VariantRow[];
    return rows.map((r) => ({
      variant: r.variant, targetPath: r.target_path, present: r.present === 1, contentSha: r.content_sha, content: r.content,
    }));
  }

  /** The run's samples in queue order, each with its checks (calls come with one sample). */
  samples(runId: string): EvalSample[] {
    const rows = this.db.prepare('SELECT * FROM eval_samples WHERE run_id = ? ORDER BY seq, try').all(runId) as unknown as SampleRow[];
    const checks = this.db
      .prepare('SELECT c.* FROM eval_checks c JOIN eval_samples s ON s.id = c.sample_id WHERE s.run_id = ? ORDER BY c.sample_id, c.idx')
      .all(runId) as unknown as CheckRow[];
    const judged = this.judgementsOfRun(runId);
    const bySample = new Map<string, EvalCheck[]>();
    for (const c of checks) {
      const list = bySample.get(c.sample_id) ?? [];
      list.push(checkOf(c, judged));
      bySample.set(c.sample_id, list);
    }
    return rows.map((r) => sampleOf(r, bySample.get(r.id) ?? []));
  }

  sample(sampleId: string): EvalSample | null {
    const row = this.db.prepare('SELECT * FROM eval_samples WHERE id = ?').get(sampleId) as SampleRow | undefined;
    if (!row) return null;
    const checks = this.db.prepare('SELECT * FROM eval_checks WHERE sample_id = ? ORDER BY idx').all(sampleId) as unknown as CheckRow[];
    const judged = new Map(this.judgements(sampleId).map((j) => [`${sampleId}\u0000${j.idx}`, j] as const));
    return sampleOf(row, checks.map((c) => checkOf(c, judged)));
  }

  /** The next queued sample in queue order, or null. */
  nextQueued(runId: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM eval_samples WHERE run_id = ? AND state = 'queued' ORDER BY seq, try LIMIT 1")
      .get(runId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Newest first, one page at a time. `before` is the `next` of the previous page, a
   * `<createdAt>|<id>` cursor, so runs created in the same millisecond are neither repeated nor skipped.
   */
  history(projectId: string, evalName: string | null, opts: { before?: string; limit?: number } = {}): EvalHistoryPage {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? EVAL_LIMITS.historyPage), 1), 200);
    const args: SQLInputValue[] = [projectId];
    let where = 'project_id = ?';
    if (evalName !== null) {
      where += ' AND eval_name = ?';
      args.push(evalName);
    }
    if (opts.before) {
      const cut = opts.before.indexOf('|');
      const at = cut < 0 ? opts.before : opts.before.slice(0, cut);
      const id = cut < 0 ? '￿' : opts.before.slice(cut + 1);
      where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      args.push(at, at, id);
    }
    args.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM eval_runs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args) as unknown as RunRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { runs: page.map((r) => this.summaryOf(r)), next: rows.length > limit && last ? `${last.created_at}|${last.id}` : null };
  }

  // ---------- recovery ----------

  /**
   * Runs still marked live, with the process that owned them. The caller decides which owners are
   * gone (pid and start time against the process table) and then ends or resumes them.
   */
  liveRuns(): OrphanedRun[] {
    const rows = this.db.prepare(`SELECT id, project_id, state, owner_pid, owner_started_at FROM eval_runs WHERE state IN ${LIVE_STATES}`).all() as unknown as Array<
      Pick<RunRow, 'id' | 'project_id' | 'state' | 'owner_pid' | 'owner_started_at'>
    >;
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, state: r.state, ownerPid: r.owner_pid, ownerStartedAt: r.owner_started_at }));
  }

  /** Takes a live run over for a new process (after the previous owner died). */
  adoptRun(runId: string, pid: number, startedAt: string): boolean {
    const result = this.db
      .prepare(`UPDATE eval_runs SET owner_pid = ?, owner_started_at = ? WHERE id = ? AND state IN ${LIVE_STATES}`)
      .run(pid, startedAt, runId);
    return Number(result.changes) > 0;
  }

  /** Samples marked running, with the pid that claimed them: the ones to requeue or end after a crash. */
  runningSamples(runId?: string): Array<{ id: string; runId: string; ownerPid: number | null; chatId: string | null }> {
    const rows = (
      runId === undefined
        ? this.db.prepare("SELECT id, run_id, owner_pid, chat_id FROM eval_samples WHERE state = 'running'").all()
        : this.db.prepare("SELECT id, run_id, owner_pid, chat_id FROM eval_samples WHERE state = 'running' AND run_id = ?").all(runId)
    ) as unknown as Array<{ id: string; run_id: string; owner_pid: number | null; chat_id: string | null }>;
    return rows.map((r) => ({ id: r.id, runId: r.run_id, ownerPid: r.owner_pid, chatId: r.chat_id }));
  }

  private summaryOf(row: RunRow): EvalRunSummary {
    const counts: EvalRunSummary['counts'] = {};
    const perCase = new Map<string, { variant: EvalVariant; passed: number; scored: number }>();
    const rows = this.db
      .prepare('SELECT case_id, variant, pressure, state, outcome FROM eval_samples WHERE run_id = ?')
      .all(row.id) as unknown as Array<{ case_id: string; variant: EvalVariant; pressure: EvalPressure; state: string; outcome: EvalSampleOutcome | null }>;
    const levels = new Set<EvalPressure>();
    for (const s of rows) {
      levels.add(s.pressure);
      const key = s.state === 'ended' && s.outcome ? s.outcome : s.state === 'ended' ? 'skipped' : (s.state as 'queued' | 'running');
      counts[key] = (counts[key] ?? 0) + 1;
      if (s.outcome === 'passed' || s.outcome === 'failed') {
        const id = `${s.case_id}\u0000${s.variant}\u0000${s.pressure}`;
        const entry = perCase.get(id) ?? { variant: s.variant, passed: 0, scored: 0 };
        entry.scored += 1;
        if (s.outcome === 'passed') entry.passed += 1;
        perCase.set(id, entry);
      }
    }
    const scored: EvalRunSummary['scored'] = {};
    for (const entry of perCase.values()) {
      const tally = scored[entry.variant] ?? { passed: 0, of: 0 };
      tally.of += 1;
      if (entry.passed === entry.scored) tally.passed += 1;
      scored[entry.variant] = tally;
    }
    return {
      id: row.id,
      projectId: row.project_id,
      evalName: row.eval_name,
      definitionSha: row.definition_sha,
      variants: row.variants.split(',').filter(Boolean) as EvalVariant[],
      samplesPerCase: row.samples_per_case,
      pressures: levels.size ? EVAL_PRESSURES.filter((p) => levels.has(p)) : ['neutral'],
      account: row.account,
      state: row.state,
      outcome: row.outcome,
      reason: row.reason,
      resetsAt: row.resets_at,
      maxCostUsd: row.max_cost_usd,
      costUsd: row.cost_usd,
      counts,
      scored,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}
