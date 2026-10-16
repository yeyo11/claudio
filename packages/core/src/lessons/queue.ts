import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  ChatOrigin,
  ClaudioEvent,
  DecisionMode,
  Lesson,
  LessonJob,
  LessonJobOutcome,
  LessonJobStatus,
  LessonJobTrigger,
  LessonSettings,
  TranscriptEntry,
} from '@claudio/shared';
import type { DecisionOutcome } from '../decisions/engine.ts';
import type { ClaudioEventInput } from '../events.ts';
import type { Db } from '../db.ts';
import { cutToBytes } from '../decisions/redact.ts';
import { assembleMinerInput, windowOf, type MinerInput, type SignalInput } from './input.ts';
import { matchCandidate, type Match } from './match.ts';
import type { MinerRun } from './miner.ts';
import { signalsOf, type CorrectionState, type RecordedSignal } from './signals.ts';
import type { EvidenceInput, LessonStore } from './store.ts';
import { validateCandidates, type Candidate } from './validate.ts';
import { WorkItemError } from '../work-item-validation.ts';

/*
 * The mining queue (docs/plans/lessons.md, "Mining"). A trigger turns a chat's corrections into a
 * `lesson_jobs` row; a tick claims one job at a time, under `BEGIN IMMEDIATE` together with the caps,
 * because the desktop app and a dev server share one data directory. The job asks the `lesson.mine`
 * gate, runs the miner when the gate says yes, and hands each checked candidate to the proposer.
 */

export const TICK_MS = 30_000;
export const LEASE_MS = 5 * 60_000;
export const GATE_RETRY_MS = 15 * 60_000;
export const RATE_LIMIT_FALLBACK_MS = 60 * 60_000;
export const MAX_ATTEMPTS = 2;
/** A person may mine a chat by hand once in this long */
const MANUAL_GAP_MS = 10 * 60_000;
/** The gate sees at most this many signals, each cut to this many bytes */
const GATE_SIGNALS = 20;
const GATE_QUOTE_BYTES = 500;

/** What the queue needs to know about a chat; the wiring reads it from the chat service */
export interface LessonChatInfo {
  id: string;
  /** Null for a loose chat, which is never mined */
  projectId: string | null;
  origin: ChatOrigin;
  /** A one-shot or housekeeping chat */
  internal: boolean;
  /** Started with a confinement (a decision chat, the miner): never mined */
  confined: boolean;
  /** A Claudio assistant chat */
  assistant: boolean;
  /** A process holds the chat now */
  live: boolean;
  /** A flow run or an orchestration worker: its prompts are Claudio's until the person continues it */
  driven: boolean;
  handedBackAt?: string | null;
}

/** What happened to a checked candidate; dropped with the reason the proposer gave */
export type ProposalResult = 'proposed' | 'merged' | { dropped: string };

export interface ProposalRequest {
  projectId: string;
  jobId: string;
  candidate: Candidate;
  match: Match;
  evidence: EvidenceInput[];
}

/** The lesson service's side (task l6): turns a candidate and its match into a proposal, a confirmation or nothing */
export interface LessonProposer {
  propose(request: ProposalRequest): ProposalResult;
}

/**
 * A candidate becomes a `proposed` row with no memory proposal, a repeat confirms the lesson it
 * repeats. Only for tests of the queue alone: the app uses `LessonService.proposer()`, without which
 * nobody is ever asked to approve what the miner found.
 */
export function storeProposer(store: LessonStore): LessonProposer {
  return {
    propose: ({ projectId, candidate, match, evidence }) => {
      if (match.kind === 'merge' && match.lesson) {
        store.seen(match.lesson.id, evidence);
        return 'merged';
      }
      if (match.kind === 'append') return 'merged';
      store.insert({
        projectId,
        trigger: candidate.trigger,
        action: candidate.action,
        confidence: candidate.confidence,
        mechanical: candidate.mechanical,
        conflictsWithInstructions: candidate.instructions === 'contradicts',
        contradicts: match.kind === 'contradicts' ? (match.lesson?.id ?? null) : null,
        proposedBy: { kind: 'agent', role: 'lesson-miner' },
        evidence,
      });
      return 'proposed';
    },
  };
}

export interface LessonQueueDeps {
  db: Db;
  settings: () => LessonSettings;
  store: LessonStore;
  proposer: LessonProposer;
  decisions: {
    effective(point: 'lesson.mine', projectId: string | null): { mode: DecisionMode };
    ask(point: 'lesson.mine', subject: { kind: 'chat'; id: string; data: Record<string, unknown> }, scope: { projectId: string | null }): Promise<DecisionOutcome>;
  };
  chat(chatId: string): Promise<LessonChatInfo | null>;
  /** The Memory module of the project is on */
  memoryOn(projectId: string): boolean;
  entries(chatId: string): Promise<readonly TranscriptEntry[]>;
  corrections(chatId: string): Promise<CorrectionState | null>;
  /** The `lesson_signals` rows of the chat, oldest first */
  rows(chatId: string): RecordedSignal[];
  /** `CLAUDE.md` of the project directory (never a worktree), or null */
  instructions(projectId: string): Promise<string | null>;
  projectKey(projectId: string): string;
  /** The miner, already bound to its runtime and settings */
  mine(input: Pick<MinerInput, 'signalsBlock' | 'lessonsBlock' | 'instructionsBlock'>, opts: { projectKey: string; signal: AbortSignal }): Promise<MinerRun>;
  /** When the provider's usage limit resets, if it is known */
  limitResetsAt(): string | null;
  emit(event: ClaudioEventInput): void;
  clock?: () => Date;
  /** Names this process in `claimed_by` */
  instance?: string;
}

interface JobRow {
  id: string;
  project_id: string;
  chat_id: string | null;
  trigger: string;
  status: string;
  outcome: string | null;
  from_uuid: string | null;
  until_uuid: string | null;
  decision_id: string | null;
  reserved_usd: number;
  cost_usd: number | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
}

interface FullJobRow extends JobRow {
  signals: number;
  candidates: number;
  proposed: number;
  merged: number;
  dropped: string;
  next_at: string | null;
  ended_at: string | null;
}

function toJob(row: FullJobRow): LessonJob {
  let dropped: Record<string, number> = {};
  try {
    dropped = JSON.parse(row.dropped) as Record<string, number>;
  } catch {
    // A row written by hand reads as nothing dropped
  }
  return {
    id: row.id,
    projectId: row.project_id,
    chatId: row.chat_id,
    trigger: row.trigger as LessonJobTrigger,
    status: row.status as LessonJobStatus,
    outcome: row.outcome as LessonJobOutcome | null,
    signals: row.signals,
    candidates: row.candidates,
    proposed: row.proposed,
    merged: row.merged,
    dropped,
    costUsd: row.cost_usd,
    decisionId: row.decision_id,
    attempts: row.attempts,
    nextAt: row.next_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

interface Patch {
  outcome?: LessonJobOutcome | null;
  untilUuid?: string | null;
  signals?: number;
  candidates?: number;
  proposed?: number;
  merged?: number;
  dropped?: Record<string, number>;
  decisionId?: string | null;
  costUsd?: number | null;
  reservedUsd?: number;
  nextAt?: string | null;
  error?: string | null;
}

const COLUMNS: Record<keyof Patch, string> = {
  outcome: 'outcome',
  untilUuid: 'until_uuid',
  signals: 'signals',
  candidates: 'candidates',
  proposed: 'proposed',
  merged: 'merged',
  dropped: 'dropped',
  decisionId: 'decision_id',
  costUsd: 'cost_usd',
  reservedUsd: 'reserved_usd',
  nextAt: 'next_at',
  error: 'error',
};

const OPEN = "('queued', 'deferred', 'running')";
const EPSILON = 1e-9;

/** The first person message after an entry: what a rewind's signal quotes */
function nextPersonText(entries: readonly TranscriptEntry[], uuid: string | null): string {
  const at = uuid ? entries.findIndex((e) => e.uuid === uuid) : -1;
  for (const entry of entries.slice(at + 1)) {
    if (entry.role !== 'user' || entry.isSidechain || entry.compaction) continue;
    const text = entry.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    if (text) return text;
  }
  return '';
}

export class LessonMiningQueue {
  private readonly sql: DatabaseSync;
  private readonly instance: string;
  private timer: NodeJS.Timeout | null = null;
  /** The pass in flight: a tick asked for meanwhile joins it, so awaiting any tick means the queue drained */
  private pass: Promise<void> | null = null;
  private pending = false;
  private current: { jobId: string; chatId: string | null; projectId: string; abort: AbortController } | null = null;

  constructor(private readonly deps: LessonQueueDeps) {
    this.sql = deps.db.connection;
    this.instance = deps.instance ?? `${String(process.pid)}-${randomUUID().slice(0, 8)}`;
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  start(): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current?.abort.abort();
  }

  observe(event: ClaudioEvent): void {
    if (event.type === 'run.ended') {
      if (event.internal) return;
      void this.enqueue('run-ended', event.runId).catch(() => undefined);
    } else if (event.type === 'run.removed') this.cancel('chat_id = ?', event.runId, 'chat-removed');
    else if (event.type === 'project.removed') this.cancel('project_id = ?', event.projectId, null);
  }

  /** A rejected proposal with a reason was recorded for the chat it came from */
  rejectedProposal(chatId: string): Promise<string | null> {
    return this.enqueue('rejected-proposal', chatId).catch(() => null);
  }

  /** A person asked to look for lessons in a chat; it skips the gate and the point may be off */
  manual(chatId: string): Promise<string | null> {
    return this.enqueue('manual', chatId);
  }

  /**
   * A person's click on "Look for lessons": the refusals the route answers with, then the job.
   * One run per chat per 10 minutes, and none past the day's caps (429).
   */
  async mineByHand(chatId: string): Promise<LessonJob> {
    const chat = await this.deps.chat(chatId);
    if (!chat) throw new WorkItemError('chat not found', 404);
    if (!chat.projectId) throw new WorkItemError('only a chat in a project can be mined for lessons', 409);
    if (!this.deps.memoryOn(chat.projectId)) throw new WorkItemError("the Memory module is off in this project: switch it on in the project's settings to look for lessons", 409);
    const settings = this.deps.settings();
    if (!settings.manualMining) throw new WorkItemError('looking for lessons by hand is switched off in the lessons settings', 409);
    const open = this.sql.prepare(`SELECT 1 FROM lesson_jobs WHERE chat_id = ? AND status IN ${OPEN}`).get(chatId);
    if (open) throw new WorkItemError('a lesson job is already open for this chat', 409);
    const recent = this.sql
      .prepare("SELECT 1 FROM lesson_jobs WHERE chat_id = ? AND trigger = 'manual' AND created_at >= ?")
      .get(chatId, new Date(this.now().getTime() - MANUAL_GAP_MS).toISOString());
    if (recent) throw new WorkItemError('this chat was mined by hand less than 10 minutes ago', 429);
    const cost = 'COALESCE(cost_usd, reserved_usd)';
    const since = this.dayStart();
    const project = this.sql.prepare(`SELECT COALESCE(SUM(${cost}), 0) AS usd, COUNT(*) AS jobs FROM lesson_jobs WHERE project_id = ? AND started_at >= ?`).get(chat.projectId, since) as { usd: number; jobs: number };
    const global = this.sql.prepare(`SELECT COALESCE(SUM(${cost}), 0) AS usd FROM lesson_jobs WHERE started_at >= ?`).get(since) as { usd: number };
    const reserve = settings.miner.maxCostUsd;
    if (project.usd + reserve > settings.caps.perProjectDailyUsd + EPSILON || global.usd + reserve > settings.caps.globalDailyUsd + EPSILON || project.jobs >= settings.caps.perProjectDailyJobs) {
      throw new WorkItemError("today's lesson mining cap is reached", 429);
    }
    const id = await this.enqueue('manual', chatId);
    const job = id ? this.job(id) : null;
    if (!job) throw new WorkItemError('a lesson job is already open for this chat', 409);
    return job;
  }

  job(id: string): LessonJob | null {
    const row = this.sql.prepare('SELECT * FROM lesson_jobs WHERE id = ?').get(id) as unknown as FullJobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** A project's jobs, newest first */
  jobs(projectId: string, limit: number): LessonJob[] {
    const rows = this.sql.prepare('SELECT * FROM lesson_jobs WHERE project_id = ? ORDER BY seq DESC LIMIT ?').all(projectId, limit) as unknown as FullJobRow[];
    return rows.map(toJob);
  }

  // ---------- Triggers ----------

  private lastDone(chatId: string): { until_uuid: string | null; ended_at: string | null } | null {
    return (
      (this.sql
        .prepare("SELECT until_uuid, ended_at FROM lesson_jobs WHERE chat_id = ? AND status = 'done' ORDER BY seq DESC LIMIT 1")
        .get(chatId) as { until_uuid: string | null; ended_at: string | null } | undefined) ?? null
    );
  }

  private eligible(chat: LessonChatInfo, trigger: LessonJobTrigger): boolean {
    if (!chat.projectId) return false;
    if (trigger === 'manual') return this.deps.settings().manualMining;
    if (chat.internal || chat.confined || chat.assistant || chat.origin === 'internal') return false;
    if (chat.origin !== 'claudio' && chat.origin !== 'orchestration') return false;
    if (trigger === 'rejected-proposal' && chat.live) return false;
    if (!this.deps.memoryOn(chat.projectId)) return false;
    // A14: nothing is stored while the point is off
    return this.deps.decisions.effective('lesson.mine', chat.projectId).mode !== 'off';
  }

  /** The signals of the chat's window, as the miner reads them; `triggers` says whether any asks the gate on its own */
  private async collect(chat: LessonChatInfo, sinceUuid: string | null): Promise<{ entries: readonly TranscriptEntry[]; signals: SignalInput[]; triggers: boolean }> {
    const entries = await this.deps.entries(chat.id);
    const inWindow = new Set(windowOf(entries, sinceUuid).entries.map((e) => e.uuid));
    const settings = this.deps.settings();
    const state = await this.deps.corrections(chat.id);
    const folded = state
      ? signalsOf(state, { driven: chat.driven, handedBackAt: chat.handedBackAt ?? null, repeatedErrorsTrigger: settings.signals.repeatedErrorsTrigger }).filter((s) => inWindow.has(s.uuid))
      : [];
    const rows = this.deps.rows(chat.id).filter((r) => r.jobId === null);
    const signals: SignalInput[] = [
      ...folded.map((s): SignalInput => ({ kind: s.kind, entryUuid: s.uuid, quote: s.quote, context: s.context })),
      // A row's entry id is a tool call or a rewind point, which the window cannot place: it stays as the newest
      ...rows.map((r): SignalInput => ({ kind: r.kind, entryUuid: null, quote: r.quote || (r.kind === 'rewound' ? nextPersonText(entries, r.entryUuid) : ''), context: r.context })),
    ];
    return { entries, signals, triggers: folded.some((s) => s.triggers) || rows.length > 0 };
  }

  private async enqueue(trigger: LessonJobTrigger, chatId: string): Promise<string | null> {
    const chat = await this.deps.chat(chatId);
    if (!chat?.projectId || !this.eligible(chat, trigger)) return null;
    const done = this.lastDone(chatId);
    let signals = 0;
    if (trigger !== 'manual') {
      const found = await this.collect(chat, done?.until_uuid ?? null);
      // With no signal that triggers alone, nothing is written
      if (!found.triggers) return null;
      signals = found.signals.length;
    }
    const id = randomUUID();
    const result = this.sql
      .prepare(
        `INSERT OR IGNORE INTO lesson_jobs (id, project_id, chat_id, trigger, status, from_uuid, signals, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, chat.projectId, chatId, trigger, done?.until_uuid ?? null, signals, this.nowIso());
    // The unique index keeps one open job per chat: a second trigger is the same work
    if (Number(result.changes) === 0) return null;
    this.announce(id, chat.projectId, 'queued', null);
    this.kick();
    return id;
  }

  // ---------- Events and cancellation ----------

  private announce(jobId: string, projectId: string, status: LessonJobStatus, outcome: LessonJobOutcome | null): void {
    try {
      this.deps.emit({ type: 'lesson.job', title: `Lesson job ${status}`, projectId, jobId, status, outcome });
    } catch {
      // An event nobody hears is not a reason to fail a job
    }
  }

  private cancel(where: string, value: string, outcome: LessonJobOutcome | null): void {
    const open = this.sql.prepare(`SELECT id, project_id FROM lesson_jobs WHERE ${where} AND status IN ${OPEN}`).all(value) as unknown as Array<{ id: string; project_id: string }>;
    if (open.length === 0) return;
    this.sql.prepare(`UPDATE lesson_jobs SET status = 'cancelled', outcome = ?, ended_at = ? WHERE ${where} AND status IN ${OPEN}`).run(outcome, this.nowIso(), value);
    for (const job of open) this.announce(job.id, job.project_id, 'cancelled', outcome);
    if (this.current && open.some((job) => job.id === this.current?.jobId)) this.current.abort.abort();
  }

  // ---------- Claims ----------

  private immediate<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // SQLite ended it already
      }
      throw err;
    }
  }

  /** A `running` job whose lease expired goes back to the queue, or fails after its second attempt */
  recover(): void {
    const now = this.nowIso();
    const expired = (): JobRow[] => this.sql.prepare("SELECT * FROM lesson_jobs WHERE status = 'running' AND claimed_until < ?").all(now) as unknown as JobRow[];
    const changed = this.immediate(() => {
      const rows = expired();
      for (const row of rows) {
        // A restart killed the miner's process: nothing is resumed, the job starts again from its window
        if (row.attempts < MAX_ATTEMPTS) {
          this.sql.prepare("UPDATE lesson_jobs SET status = 'queued', claimed_by = NULL, claimed_until = NULL, reserved_usd = 0 WHERE id = ? AND status = 'running'").run(row.id);
        } else {
          this.sql.prepare("UPDATE lesson_jobs SET status = 'failed', outcome = 'interrupted', claimed_by = NULL, claimed_until = NULL, ended_at = ? WHERE id = ? AND status = 'running'").run(now, row.id);
        }
      }
      return rows;
    });
    for (const row of changed) this.announce(row.id, row.project_id, row.attempts < MAX_ATTEMPTS ? 'queued' : 'failed', row.attempts < MAX_ATTEMPTS ? null : 'interrupted');
  }

  private dayStart(): string {
    const d = this.now();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  /**
   * Takes the next job that fits under the caps. A job over a cap is skipped (`daily-cap`) or
   * deferred (the chat's minimum gap) and the next one is looked at; a job the project no longer
   * allows is skipped. The claim, the caps and the reservation are one transaction.
   */
  claim(): { job: JobRow; spent: number } | null {
    const settings = this.deps.settings();
    const now = this.nowIso();
    const ended: Array<[string, string, LessonJobStatus, LessonJobOutcome | null]> = [];
    const claimed = this.immediate(() => {
      const waiting = this.sql
        .prepare("SELECT * FROM lesson_jobs WHERE status IN ('queued', 'deferred') AND (next_at IS NULL OR next_at <= ?) ORDER BY seq LIMIT 25")
        .all(now) as unknown as JobRow[];
      const since = this.dayStart();
      const cost = 'COALESCE(cost_usd, reserved_usd)';
      for (const job of waiting) {
        if (job.trigger !== 'manual' && this.deps.decisions.effective('lesson.mine', job.project_id).mode === 'off') {
          this.sql.prepare("UPDATE lesson_jobs SET status = 'skipped', outcome = 'gate-unavailable', ended_at = ? WHERE id = ? AND status IN ('queued', 'deferred')").run(now, job.id);
          ended.push([job.id, job.project_id, 'skipped', 'gate-unavailable']);
          continue;
        }
        const project = this.sql.prepare(`SELECT COALESCE(SUM(${cost}), 0) AS usd, COUNT(*) AS jobs FROM lesson_jobs WHERE project_id = ? AND started_at >= ?`).get(job.project_id, since) as { usd: number; jobs: number };
        const global = this.sql.prepare(`SELECT COALESCE(SUM(${cost}), 0) AS usd FROM lesson_jobs WHERE started_at >= ?`).get(since) as { usd: number };
        const reserve = settings.miner.maxCostUsd;
        if (project.usd + reserve > settings.caps.perProjectDailyUsd + EPSILON || global.usd + reserve > settings.caps.globalDailyUsd + EPSILON || project.jobs >= settings.caps.perProjectDailyJobs) {
          this.sql.prepare("UPDATE lesson_jobs SET status = 'skipped', outcome = 'daily-cap', ended_at = ? WHERE id = ? AND status IN ('queued', 'deferred')").run(now, job.id);
          ended.push([job.id, job.project_id, 'skipped', 'daily-cap']);
          continue;
        }
        if (job.trigger !== 'manual' && job.chat_id && settings.caps.perChatMinMinutes > 0) {
          const last = this.sql.prepare('SELECT started_at FROM lesson_jobs WHERE chat_id = ? AND id != ? AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(job.chat_id, job.id) as { started_at: string } | undefined;
          const ready = last ? new Date(Date.parse(last.started_at) + settings.caps.perChatMinMinutes * 60_000).toISOString() : null;
          if (ready && ready > now) {
            this.sql.prepare("UPDATE lesson_jobs SET status = 'deferred', next_at = ? WHERE id = ? AND status IN ('queued', 'deferred')").run(ready, job.id);
            ended.push([job.id, job.project_id, 'deferred', null]);
            continue;
          }
        }
        // The guarded claim: two processes on one data directory cannot both take it
        const taken = this.sql
          .prepare(
            `UPDATE lesson_jobs SET status = 'running', claimed_by = ?, claimed_until = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?),
               next_at = NULL, reserved_usd = reserved_usd + ?, cost_usd = NULL
             WHERE id = ? AND status IN ('queued', 'deferred') AND (next_at IS NULL OR next_at <= ?)`,
          )
          .run(this.instance, new Date(this.now().getTime() + LEASE_MS).toISOString(), now, reserve, job.id, now);
        if (Number(taken.changes) === 0) continue;
        return { job: this.sql.prepare('SELECT * FROM lesson_jobs WHERE id = ?').get(job.id) as unknown as JobRow, spent: job.reserved_usd };
      }
      return null;
    });
    for (const [id, projectId, status, outcome] of ended) this.announce(id, projectId, status, outcome);
    if (claimed) this.announce(claimed.job.id, claimed.job.project_id, 'running', null);
    return claimed;
  }

  private kick(): void {
    void this.tick().catch(() => undefined);
  }

  /** Recovers expired leases and runs jobs, one at a time per process, until none is due */
  tick(): Promise<void> {
    if (this.pass) {
      this.pending = true;
      return this.pass;
    }
    this.pass = this.drain().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async drain(): Promise<void> {
    do {
      this.pending = false;
      this.recover();
      for (let claimed = this.claim(); claimed; claimed = this.claim()) {
        await this.run(claimed.job, claimed.spent).catch((err: unknown) => this.settle(claimed.job, 'failed', { outcome: 'invalid-output', error: cutToBytes(String(err), 300) }));
      }
    } while (this.pending);
  }

  // ---------- Running a job ----------

  /** Writes the end (or the pause) of a running job; a job cancelled meanwhile is left as it is */
  private settle(job: JobRow, status: LessonJobStatus, patch: Patch = {}): boolean {
    const sets = ['status = ?', 'claimed_by = NULL', 'claimed_until = NULL'];
    const values: SQLInputValue[] = [status];
    for (const [key, value] of Object.entries(patch) as Array<[keyof Patch, unknown]>) {
      if (value === undefined) continue;
      sets.push(`${COLUMNS[key]} = ?`);
      values.push((key === 'dropped' ? JSON.stringify(value) : value) as SQLInputValue);
    }
    if (status === 'done' || status === 'failed' || status === 'skipped') {
      sets.push('ended_at = ?');
      values.push(this.nowIso());
    }
    values.push(job.id);
    const changed = this.sql.prepare(`UPDATE lesson_jobs SET ${sets.join(', ')} WHERE id = ? AND status = 'running'`).run(...values);
    if (Number(changed.changes) === 0) return false;
    this.announce(job.id, job.project_id, status, patch.outcome ?? null);
    return true;
  }

  private async run(job: JobRow, spent: number): Promise<void> {
    const abort = new AbortController();
    this.current = { jobId: job.id, chatId: job.chat_id, projectId: job.project_id, abort };
    try {
      await this.work(job, spent, abort.signal);
    } finally {
      this.current = null;
    }
  }

  private async work(job: JobRow, spent: number, signal: AbortSignal): Promise<void> {
    const chat = job.chat_id ? await this.deps.chat(job.chat_id) : null;
    if (!chat) {
      this.settle(job, 'cancelled', { outcome: 'chat-removed', reservedUsd: spent });
      return;
    }
    const manual = job.trigger === 'manual';
    const since = this.lastDone(chat.id)?.until_uuid ?? null;
    const found = await this.collect(chat, since);
    const lessons = this.visibleLessons(job.project_id);
    const input = assembleMinerInput({
      entries: found.entries,
      sinceUuid: since,
      signals: found.signals,
      lessons: lessons.filter((l) => l.status === 'active'),
      instructions: await this.deps.instructions(job.project_id),
    });
    const until = input.untilUuid;
    const base: Patch = { untilUuid: until, signals: input.signals.length, reservedUsd: spent };
    if (input.signals.length === 0) {
      this.settle(job, 'done', { ...base, outcome: 'nothing' });
      return;
    }

    if (!manual && !job.decision_id) {
      const gate = await this.gate(job, chat, input);
      if (gate.settled) return;
      base.decisionId = gate.decisionId;
    }
    if (signal.aborted) return;

    const run = await this.deps.mine(input, { projectKey: this.deps.projectKey(job.project_id), signal });
    if (signal.aborted) return;
    // The reservation is replaced by the real cost when the run reports one; otherwise it stays
    const cost = (usd: number | null): Pick<Patch, 'costUsd' | 'reservedUsd'> => (usd === null ? { reservedUsd: spent + this.deps.settings().miner.maxCostUsd } : { costUsd: spent + usd, reservedUsd: spent + usd });
    switch (run.status) {
      case 'rate-limited':
        this.settle(job, 'deferred', { ...base, outcome: 'rate-limited', nextAt: this.deps.limitResetsAt() ?? new Date(this.now().getTime() + RATE_LIMIT_FALLBACK_MS).toISOString(), reservedUsd: spent });
        return;
      case 'over-budget':
        this.settle(job, 'failed', { ...base, outcome: 'over-budget', ...cost(run.costUsd) });
        return;
      case 'invalid-output':
        if (job.attempts < MAX_ATTEMPTS) this.settle(job, 'queued', { ...base, outcome: null, nextAt: null, reservedUsd: run.costUsd === null ? spent : spent + run.costUsd });
        else this.settle(job, 'failed', { ...base, outcome: 'invalid-output', ...cost(run.costUsd) });
        return;
      case 'answered':
        break;
    }

    const validated = validateCandidates(run.candidates, {
      signals: input.kinds,
      rejected: lessons.filter((l) => l.status === 'rejected'),
    });
    const dropped: Record<string, number> = { ...validated.dropped };
    const at = this.nowIso();
    let proposed = 0;
    let merged = 0;
    for (const candidate of validated.accepted) {
      const match = matchCandidate(candidate, lessons);
      if (match.kind === 'duplicate-rejected') {
        dropped['duplicate-rejected'] = (dropped['duplicate-rejected'] ?? 0) + 1;
        continue;
      }
      const evidence: EvidenceInput[] = candidate.signals.flatMap((id) => {
        const s = input.signals.find((x) => x.id === id);
        if (!s) return [];
        const context = [s.before, ...s.tools, s.context].filter(Boolean).join('\n');
        return [{ signal: s.kind, quote: candidate.quote || s.quote, context: cutToBytes(context, 1024), chatId: chat.id, entryUuid: s.entryUuid ?? null, jobId: job.id, at }];
      });
      const result = this.deps.proposer.propose({ projectId: job.project_id, jobId: job.id, candidate, match, evidence });
      if (result === 'proposed') proposed += 1;
      else if (result === 'merged') merged += 1;
      else dropped[result.dropped] = (dropped[result.dropped] ?? 0) + 1;
    }
    const rawCount = Math.min(run.candidates.length, 5);
    // The signals this job read are its own now; the next window starts after them
    for (const row of this.deps.rows(chat.id)) if (row.jobId === null) this.sql.prepare('UPDATE lesson_signals SET job_id = ? WHERE id = ?').run(job.id, row.id);
    this.settle(job, 'done', { ...base, ...cost(run.costUsd), outcome: proposed > 0 ? 'proposed' : 'nothing', candidates: rawCount, proposed, merged, dropped });
  }

  /** The project's own lessons and the global ones, with their keys */
  private visibleLessons(projectId: string): Lesson[] {
    return [...this.deps.store.list({ projectId }), ...this.deps.store.list({ projectId: null })];
  }

  /** Asks `lesson.mine`; says whether the job ended here, else the decision to remember */
  private async gate(job: JobRow, chat: LessonChatInfo, input: MinerInput): Promise<{ settled: true } | { settled: false; decisionId: string | null }> {
    const signals = input.signals.slice(0, GATE_SIGNALS).map((s) => ({
      id: s.id,
      kind: s.kind,
      quote: cutToBytes(s.quote, GATE_QUOTE_BYTES),
      context: cutToBytes([s.before, ...s.tools, s.context].filter(Boolean).join('\n'), GATE_QUOTE_BYTES),
    }));
    const outcome = await this.deps.decisions.ask('lesson.mine', { kind: 'chat', id: chat.id, data: { signals } }, { projectId: job.project_id });
    const base: Patch = { untilUuid: input.untilUuid, signals: input.signals.length, decisionId: outcome.decisionId };
    if (outcome.mode === 'off') {
      this.settle(job, 'skipped', { outcome: 'gate-unavailable' });
      return { settled: true };
    }
    if (outcome.mode === 'shadow') {
      // A shadow answer never starts a miner, and nothing was spent
      this.settle(job, 'done', { ...base, outcome: 'shadow', reservedUsd: 0 });
      return { settled: true };
    }
    if (!outcome.act) {
      // The point is active but nothing answered: wait and ask again, then give up
      if (job.attempts < MAX_ATTEMPTS) this.settle(job, 'deferred', { nextAt: new Date(this.now().getTime() + GATE_RETRY_MS).toISOString(), reservedUsd: 0 });
      else this.settle(job, 'failed', { outcome: 'gate-unavailable', decisionId: outcome.decisionId, reservedUsd: 0 });
      return { settled: true };
    }
    const mine = outcome.answers?.mine;
    if (mine?.kind === 'noul' && mine.value) return { settled: false, decisionId: outcome.decisionId };
    this.settle(job, 'done', { ...base, outcome: 'gate-no', reservedUsd: 0 });
    return { settled: true };
  }
}
