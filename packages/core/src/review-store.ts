import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  Effort,
  ReviewAnchor,
  ReviewDimension,
  ReviewFinding,
  ReviewGateStatus,
  ReviewRound,
  ReviewRun,
  ReviewRunKind,
  ReviewRunState,
  ReviewSeverity,
  ReviewSide,
  ReviewVerdict,
} from '@claudio/shared';

/** A refusal the API shows as is: the round cannot be claimed or changed in this state. */
export class ReviewStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
    readonly reason: 'review-running' | 'review-not-found' | 'review-not-acceptable' | 'checks-not-passed' | 'head-moved' | 'bad-reason',
  ) {
    super(message);
    this.name = 'ReviewStoreError';
  }
}

type RoundState = ReviewRound['state'];

interface RoundRow {
  id: string;
  orchestration_id: string;
  round: number;
  pass: number;
  base: string;
  head: string;
  depth: string;
  state: string;
  reason: string | null;
  files: number;
  added: number;
  deleted: number;
  chunks: number;
  skipped_files: string;
  estimate_usd: number | null;
  cost_usd: number;
  claimed_by: string | null;
  accepted_by: string | null;
  accepted_reason: string | null;
  accepted_at: string | null;
  started_at: string;
  ended_at: string | null;
}

interface RunRow {
  id: string;
  round_id: string;
  kind: string;
  dimension: string | null;
  chunk: number | null;
  chunks: number | null;
  chat_id: string | null;
  model: string | null;
  effort: string | null;
  account: string | null;
  role_source: string | null;
  state: string;
  failure: string | null;
  dropped: number;
  cost_usd: number;
  started_at: string | null;
  ended_at: string | null;
}

interface FindingRow {
  id: string;
  round_id: string;
  fingerprint: string;
  source: string;
  rule: string | null;
  dimensions: string;
  reported_by: number;
  severity: string;
  confidence: number;
  title: string;
  path: string | null;
  line: number | null;
  side: string | null;
  anchor: string;
  evidence: string;
  failure_scenario: string;
  suggestion: string | null;
  verdict: string;
  verdict_reason: string | null;
  verifier_run_id: string | null;
  blocking: number;
  resolved_in_round: number | null;
}

/** What a round is claimed with: the store sets the state, the zero counts and the claim. */
export interface NewReviewRound {
  id: string;
  orchestrationId: string;
  round: number;
  pass: number;
  base: string;
  head: string;
  depth: 'light' | 'full';
  /** The process taking the claim, so a restart can free what it left running */
  claimedBy: string;
  startedAt: string;
}

/** What a round ends with: the state, the reason and whatever the diff and the spend came to. */
export interface ReviewRoundEnd {
  state: Exclude<RoundState, 'running'>;
  reason?: string | null;
  files?: number;
  added?: number;
  deleted?: number;
  chunks?: number;
  skippedFiles?: ReviewRound['skippedFiles'];
  estimateUsd?: number | null;
  costUsd?: number;
  endedAt: string;
}

export interface NewReviewRun {
  id: string;
  roundId: string;
  kind: ReviewRunKind;
  dimension?: ReviewDimension | null;
  chunk?: number | null;
  chunks?: number | null;
  chatId?: string | null;
  model?: string | null;
  effort?: Effort | null;
  account?: string | null;
  roleSource?: 'builtin' | 'project' | null;
  roleSha?: string | null;
  state: ReviewRunState;
  startedAt?: string | null;
}

/** The fields of a run that change after it exists; absent ones stay as they are. */
export interface ReviewRunPatch {
  chatId?: string | null;
  model?: string | null;
  effort?: Effort | null;
  account?: string | null;
  state?: ReviewRunState;
  failure?: string | null;
  dropped?: number;
  costUsd?: number;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** A finding as a round stores it: the same shape the API serves, plus when it was written. */
export type NewReviewFinding = ReviewFinding & { createdAt: string };

export interface ReviewFindingQuery {
  blocking?: boolean;
  limit: number;
  offset: number;
}

const RUN_COLUMNS: Record<keyof ReviewRunPatch, string> = {
  chatId: 'chat_id',
  model: 'model',
  effort: 'effort',
  account: 'account',
  state: 'state',
  failure: 'failure',
  dropped: 'dropped',
  costUsd: 'cost_usd',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

function runOf(row: RunRow): ReviewRun {
  return {
    id: row.id,
    kind: row.kind as ReviewRunKind,
    dimension: row.dimension as ReviewDimension | null,
    chunk: row.chunk,
    chunks: row.chunks,
    chatId: row.chat_id,
    model: row.model,
    effort: row.effort as Effort | null,
    account: row.account,
    roleSource: row.role_source as ReviewRun['roleSource'],
    state: row.state as ReviewRunState,
    failure: row.failure,
    dropped: row.dropped,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function roundOf(row: RoundRow, runs: ReviewRun[]): ReviewRound {
  return {
    id: row.id,
    round: row.round,
    pass: row.pass,
    base: row.base,
    head: row.head,
    depth: row.depth as ReviewRound['depth'],
    state: row.state as ReviewRound['state'],
    reason: row.reason,
    files: row.files,
    added: row.added,
    deleted: row.deleted,
    chunks: row.chunks,
    skippedFiles: JSON.parse(row.skipped_files) as ReviewRound['skippedFiles'],
    estimateUsd: row.estimate_usd,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    accepted: row.accepted_by !== null && row.accepted_at !== null ? { by: row.accepted_by, reason: row.accepted_reason ?? '', at: row.accepted_at } : null,
    runs,
  };
}

function findingOf(row: FindingRow): ReviewFinding {
  return {
    id: row.id,
    roundId: row.round_id,
    fingerprint: row.fingerprint,
    source: row.source as ReviewFinding['source'],
    rule: row.rule,
    dimensions: JSON.parse(row.dimensions) as ReviewDimension[],
    reportedBy: row.reported_by,
    severity: row.severity as ReviewSeverity,
    confidence: row.confidence,
    title: row.title,
    path: row.path,
    line: row.line,
    side: row.side as ReviewSide | null,
    anchor: row.anchor as ReviewAnchor,
    evidence: row.evidence,
    failureScenario: row.failure_scenario,
    suggestion: row.suggestion,
    verdict: row.verdict as ReviewVerdict,
    verdictReason: row.verdict_reason,
    // The column is named for the verifier's run; the contract carries the chat that run drove.
    verifierChatId: row.verifier_run_id,
    blocking: row.blocking === 1,
    resolvedInRound: row.resolved_in_round,
  };
}

const isUniqueViolation = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

/**
 * The review gate's rounds, runs and findings (docs/plans/review-gate.md). Rows, not JSON, because
 * they accumulate across rounds and two processes share the data directory: the partial unique
 * index on a running round is what lets one process claim a graph's review.
 */
export class ReviewStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Runs `fn` in a write transaction taken up front, so a second writer waits instead of failing half way. */
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
   * Opens a round as `running` and claims the graph's review. Another running round (this process
   * or another) is a refusal, 409 `review-running`.
   */
  claimRound(input: NewReviewRound): ReviewRound {
    const running = (): boolean => this.db.prepare("SELECT 1 FROM review_rounds WHERE orchestration_id = ? AND state = 'running'").get(input.orchestrationId) !== undefined;
    const refusal = () => new ReviewStoreError('The review is already running for this orchestration', 409, 'review-running');
    try {
      this.immediate(() => {
        if (running()) throw refusal();
        this.db
          .prepare(
            `INSERT INTO review_rounds (id, orchestration_id, round, pass, base, head, depth, state, claimed_by, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
          )
          .run(input.id, input.orchestrationId, input.round, input.pass, input.base, input.head, input.depth, input.claimedBy, input.startedAt);
      });
    } catch (err) {
      // The index is the guarantee; the check above only names it. A violation of the (round, pass) key is a caller bug.
      if (isUniqueViolation(err) && running()) throw refusal();
      throw err;
    }
    const row = this.db.prepare('SELECT * FROM review_rounds WHERE id = ?').get(input.id) as unknown as RoundRow;
    return roundOf(row, []);
  }

  endRound(id: string, end: ReviewRoundEnd): void {
    const sets = ['state = ?', 'reason = ?', 'ended_at = ?'];
    const args: SQLInputValue[] = [end.state, end.reason ?? null, end.endedAt];
    const optional: [string, SQLInputValue | undefined][] = [
      ['files', end.files],
      ['added', end.added],
      ['deleted', end.deleted],
      ['chunks', end.chunks],
      ['skipped_files', end.skippedFiles === undefined ? undefined : JSON.stringify(end.skippedFiles)],
      ['estimate_usd', end.estimateUsd],
      ['cost_usd', end.costUsd],
    ];
    for (const [column, value] of optional) {
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      args.push(value);
    }
    const result = this.db.prepare(`UPDATE review_rounds SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    if (result.changes === 0) throw new ReviewStoreError('That review round does not exist', 404, 'review-not-found');
  }

  addRun(input: NewReviewRun): void {
    this.db
      .prepare(
        `INSERT INTO review_runs (id, round_id, kind, dimension, chunk, chunks, chat_id, model, effort, account, role_source, role_sha, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.roundId,
        input.kind,
        input.dimension ?? null,
        input.chunk ?? null,
        input.chunks ?? null,
        input.chatId ?? null,
        input.model ?? null,
        input.effort ?? null,
        input.account ?? null,
        input.roleSource ?? null,
        input.roleSha ?? null,
        input.state,
        input.startedAt ?? null,
      );
  }

  updateRun(id: string, patch: ReviewRunPatch): void {
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    for (const key of Object.keys(RUN_COLUMNS) as (keyof ReviewRunPatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${RUN_COLUMNS[key]} = ?`);
      args.push(value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE review_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  /** Stores a round's findings in one transaction; a fingerprint the round already has is replaced. */
  putFindings(roundId: string, findings: readonly NewReviewFinding[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO review_findings
         (id, round_id, fingerprint, source, rule, dimensions, reported_by, severity, confidence, title, path, line, side, anchor,
          evidence, failure_scenario, suggestion, verdict, verdict_reason, verifier_run_id, blocking, resolved_in_round, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.immediate(() => {
      for (const f of findings) {
        insert.run(
          f.id,
          roundId,
          f.fingerprint,
          f.source,
          f.rule,
          JSON.stringify(f.dimensions),
          f.reportedBy,
          f.severity,
          f.confidence,
          f.title,
          f.path,
          f.line,
          f.side,
          f.anchor,
          f.evidence,
          f.failureScenario,
          f.suggestion,
          f.verdict,
          f.verdictReason,
          f.verifierChatId,
          f.blocking ? 1 : 0,
          f.resolvedInRound,
          f.createdAt,
        );
      }
    });
  }

  /** Marks the findings a fix round resolved, by the round that saw them gone. */
  resolveFindings(ids: readonly string[], round: number): void {
    const update = this.db.prepare('UPDATE review_findings SET resolved_in_round = ? WHERE id = ?');
    this.immediate(() => {
      for (const id of ids) update.run(round, id);
    });
  }

  /** An orchestration's rounds, oldest first, each with its runs. */
  rounds(orchestrationId: string): ReviewRound[] {
    const rows = this.db.prepare('SELECT * FROM review_rounds WHERE orchestration_id = ? ORDER BY started_at, round, pass').all(orchestrationId) as unknown as RoundRow[];
    if (rows.length === 0) return [];
    const runs = this.db
      .prepare(
        `SELECT r.* FROM review_runs r JOIN review_rounds q ON q.id = r.round_id
         WHERE q.orchestration_id = ? ORDER BY r.started_at IS NULL, r.started_at, r.id`,
      )
      .all(orchestrationId) as unknown as RunRow[];
    const byRound = new Map<string, ReviewRun[]>();
    for (const row of runs) byRound.set(row.round_id, [...(byRound.get(row.round_id) ?? []), runOf(row)]);
    return rows.map((row) => roundOf(row, byRound.get(row.id) ?? []));
  }

  /** A page of a round's findings, the blocking and the most severe first, with the total the filter matches. */
  findings(roundId: string, query: ReviewFindingQuery): { findings: ReviewFinding[]; total: number } {
    const where = query.blocking === undefined ? 'round_id = ?' : 'round_id = ? AND blocking = ?';
    const args: SQLInputValue[] = query.blocking === undefined ? [roundId] : [roundId, query.blocking ? 1 : 0];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM review_findings WHERE ${where}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM review_findings WHERE ${where}
         ORDER BY blocking DESC, CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, path, line, id
         LIMIT ? OFFSET ?`,
      )
      .all(...args, query.limit, query.offset) as unknown as FindingRow[];
    return { findings: rows.map(findingOf), total };
  }

  /** A person accepts a round that did not pass; only a `blocked` or `incomplete` round can be accepted. */
  accept(roundId: string, by: string, reason: string, at: string): void {
    const result = this.db
      .prepare("UPDATE review_rounds SET state = 'accepted', accepted_by = ?, accepted_reason = ?, accepted_at = ? WHERE id = ? AND state IN ('blocked', 'incomplete')")
      .run(by, reason, at, roundId);
    if (result.changes > 0) return;
    const exists = this.db.prepare('SELECT state FROM review_rounds WHERE id = ?').get(roundId) as { state: ReviewGateStatus } | undefined;
    if (!exists) throw new ReviewStoreError('That review round does not exist', 404, 'review-not-found');
    throw new ReviewStoreError(`A round that is ${exists.state} cannot be accepted`, 409, 'review-not-acceptable');
  }

  /**
   * After a restart: running rounds become `incomplete` and their live runs `interrupted`, which
   * frees the claim index. With a process id, only what that process claimed. Returns the rounds freed.
   */
  interruptRunning(endedAt: string, processId?: string): number {
    const where = processId === undefined ? "state = 'running'" : "state = 'running' AND claimed_by = ?";
    const args: SQLInputValue[] = processId === undefined ? [] : [processId];
    return this.immediate(() => {
      this.db
        .prepare(
          `UPDATE review_runs SET state = 'interrupted', ended_at = ?
           WHERE state IN ('pending', 'running', 'waiting') AND round_id IN (SELECT id FROM review_rounds WHERE ${where})`,
        )
        .run(endedAt, ...args);
      const result = this.db
        .prepare(`UPDATE review_rounds SET state = 'incomplete', reason = COALESCE(reason, 'Interrupted by a wrapper restart before the review finished'), ended_at = ? WHERE ${where}`)
        .run(endedAt, ...args);
      return Number(result.changes);
    });
  }
}
