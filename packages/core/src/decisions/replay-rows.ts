import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  DecisionLabel,
  DecisionLabelSource,
  DecisionPointId,
  DecisionQuestion,
  DecisionReplay,
  DecisionReplayConfusion,
  DecisionReplayConsent,
  DecisionReplayScore,
  DecisionProviderId,
} from '@claudio/shared';

/*
 * The SQL of the golden set and the stored replays, over a bare connection. They live apart from
 * `Db` because `scripts/decisions-replay.mjs` reads a live install's database read-only and writes
 * one row only when told to: `Db` migrates, prunes and switches the journal mode on open, which a
 * script beside a running server must never do. `Db` calls these with its own connection.
 */

interface LabelRow {
  id: string;
  point: string;
  decision_id: string | null;
  state: string;
  questions: string;
  positive: number;
  answers: string | null;
  source: string;
  note: string | null;
  at: string;
}

/** The labels of a point, or of every point, oldest first */
export function readDecisionLabels(conn: DatabaseSync, point?: DecisionPointId): DecisionLabel[] {
  const rows = (
    point === undefined
      ? conn.prepare('SELECT * FROM decision_labels ORDER BY at, id').all()
      : conn.prepare('SELECT * FROM decision_labels WHERE point = ? ORDER BY at, id').all(point)
  ) as unknown as LabelRow[];
  return rows.map((r) => ({
    id: r.id,
    point: r.point as DecisionPointId,
    decisionId: r.decision_id,
    state: JSON.parse(r.state) as Record<string, unknown>,
    questions: JSON.parse(r.questions) as DecisionQuestion[],
    positive: r.positive === 1,
    answers: r.answers === null ? null : (JSON.parse(r.answers) as Record<string, string | boolean>),
    source: r.source as DecisionLabelSource,
    note: r.note,
    at: r.at,
  }));
}

interface ReplayRow {
  id: string;
  point: string;
  at: string;
  provider: string;
  model: string;
  questions: string;
  questions_hash: string;
  cases: number;
  fallback_cases: number | undefined;
  unavailable: number;
  score: string;
  confusion: string;
  cost_usd: number;
  consent: string;
  note: string | null;
}

const replayOf = (r: ReplayRow): DecisionReplay => ({
  id: r.id,
  point: r.point as DecisionPointId,
  at: r.at,
  provider: r.provider as DecisionProviderId,
  model: r.model,
  questions: JSON.parse(r.questions) as DecisionQuestion[],
  questionsHash: r.questions_hash,
  cases: r.cases,
  // Absent on a database the script reads before the server migrated it
  fallbackCases: r.fallback_cases ?? 0,
  unavailable: r.unavailable,
  score: JSON.parse(r.score) as DecisionReplayScore,
  confusion: JSON.parse(r.confusion) as DecisionReplayConfusion,
  costUsd: r.cost_usd,
  consent: r.consent as DecisionReplayConsent,
  note: r.note,
});

/** True when the install's database has the replays table, i.e. it has run the version that added it */
export function hasReplayTable(conn: DatabaseSync): boolean {
  return conn.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'decision_replays'").get() !== undefined;
}

/** True when the replays table records fallback cases: a script may write to an install that has not migrated yet */
function hasFallbackColumn(conn: DatabaseSync): boolean {
  const columns = conn.prepare('PRAGMA table_info(decision_replays)').all() as unknown as Array<{ name: string }>;
  return columns.some((c) => c.name === 'fallback_cases');
}

/**
 * Stores a run. On a database from before `fallback_cases` a clean run is stored without it; a run
 * with fallback cases is refused there, since nothing would keep the gate from reading it.
 */
export function insertDecisionReplay(conn: DatabaseSync, replay: DecisionReplay): void {
  const withFallback = hasFallbackColumn(conn);
  if (!withFallback && replay.fallbackCases > 0) throw new Error('this database predates fallback cases: start the server once to migrate it, then store the replay');
  const columns = ['id', 'point', 'at', 'provider', 'model', 'questions', 'questions_hash', 'cases', ...(withFallback ? ['fallback_cases'] : []), 'unavailable', 'score', 'confusion', 'cost_usd', 'consent', 'note'];
  const values: SQLInputValue[] = [
    replay.id,
    replay.point,
    replay.at,
    replay.provider,
    replay.model,
    JSON.stringify(replay.questions),
    replay.questionsHash,
    replay.cases,
    ...(withFallback ? [replay.fallbackCases] : []),
    replay.unavailable,
    JSON.stringify(replay.score),
    JSON.stringify(replay.confusion),
    replay.costUsd,
    replay.consent,
    replay.note,
  ];
  conn.prepare(`INSERT INTO decision_replays (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
}

/** Newest first; `point` absent reads every point */
export function readDecisionReplays(conn: DatabaseSync, point?: DecisionPointId): DecisionReplay[] {
  const params: SQLInputValue[] = point === undefined ? [] : [point];
  const rows = conn
    .prepare(`SELECT * FROM decision_replays ${point === undefined ? '' : 'WHERE point = ?'} ORDER BY at DESC, rowid DESC`)
    .all(...params) as unknown as ReplayRow[];
  return rows.map(replayOf);
}

/**
 * The newest replay of a point under exactly these questions that the gate may read, or null: none
 * whose cases were asked other questions, and with `runsOn` only one on that provider (and, for Jev,
 * that model)
 */
export function readLatestDecisionReplay(
  conn: DatabaseSync,
  point: DecisionPointId,
  questionsHash: string,
  runsOn?: { provider: DecisionProviderId; model: string | null },
): DecisionReplay | null {
  const where = ['point = ?', 'questions_hash = ?', 'fallback_cases = 0'];
  const params: SQLInputValue[] = [point, questionsHash];
  if (runsOn) {
    where.push('provider = ?');
    params.push(runsOn.provider);
    if (runsOn.provider === 'jev' && runsOn.model !== null) {
      where.push('model = ?');
      params.push(runsOn.model);
    }
  }
  const row = conn.prepare(`SELECT * FROM decision_replays WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT 1`).get(...params) as unknown as ReplayRow | undefined;
  return row ? replayOf(row) : null;
}
