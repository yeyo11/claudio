import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  LESSON_EVIDENCE_MAX,
  type Lesson,
  type LessonEvidence,
  type LessonRetiredReason,
  type LessonSettings,
  type LessonSignalKind,
  type LessonStatus,
  type WorkItemActor,
} from '@claudio/shared';
import type { Db } from '../db.ts';
import { actorOf } from '../work-item-rows.ts';
import { PERSON, WorkItemError } from '../work-item-validation.ts';
import { delivered, effective, shouldRetire } from './decay.ts';
import { DEFAULT_LESSON_SETTINGS } from './settings.ts';

/*
 * The lessons' rows (docs/plans/lessons.md, "Migration" and "Lifecycle"). Every transition is one
 * guarded `UPDATE … WHERE id = ? AND status = ?`: zero changed rows is a lost race and answers 409,
 * as `MemoryProposalService.claim` does. A transition that touches two rows runs under
 * `BEGIN IMMEDIATE`, because two processes share the data directory.
 */

interface LessonRow {
  seq: number;
  id: string;
  project_id: string | null;
  status: string;
  trigger: string;
  action: string;
  confidence: number;
  seen_count: number;
  pinned: number;
  mechanical: number;
  conflicts_instructions: number;
  contradicts_id: string | null;
  overrides_id: string | null;
  promoted_from: string | null;
  retired_reason: string | null;
  proposal_id: string | null;
  instructions_proposal_id: string | null;
  proposed_by_kind: string;
  proposed_by_role: string | null;
  decided_by_kind: string | null;
  decided_by_role: string | null;
  decided_at: string | null;
  edited_at: string | null;
  last_seen_at: string;
  last_confirmed_at: string;
  created_at: string;
  updated_at: string;
}

interface EvidenceRow {
  id: string;
  signal: string;
  quote: string;
  context: string;
  chat_id: string | null;
  entry_uuid: string | null;
  at: string;
}

/** What an evidence row is written from */
export interface EvidenceInput {
  signal: LessonSignalKind;
  quote: string;
  context: string;
  chatId: string | null;
  entryUuid: string | null;
  jobId?: string | null;
  at: string;
}

export interface NewLesson {
  projectId: string | null;
  trigger: string;
  action: string;
  confidence: number;
  mechanical?: boolean;
  conflictsWithInstructions?: boolean;
  contradicts?: string | null;
  overrides?: string | null;
  proposalId?: string | null;
  proposedBy: WorkItemActor;
  evidence?: EvidenceInput[];
}

export interface LessonFilter {
  /** A project's own lessons; `null` for the global ones; left out for every lesson */
  projectId?: string | null;
  status?: LessonStatus;
}

export interface LessonStoreDeps {
  db: Db;
  /** The settings now in force; the defaults when left out */
  settings?: () => LessonSettings;
  clock?: () => Date;
}

const lost = (): WorkItemError => new WorkItemError('the lesson changed meanwhile', 409);
const missing = (): WorkItemError => new WorkItemError('lesson not found', 404);

const flag = (value: boolean | undefined): number => (value ? 1 : 0);

export class LessonStore {
  private readonly sql: DatabaseSync;
  private readonly settings: () => LessonSettings;
  private readonly clock: () => Date;

  constructor(deps: LessonStoreDeps) {
    this.sql = deps.db.connection;
    this.settings = deps.settings ?? (() => DEFAULT_LESSON_SETTINGS);
    this.clock = deps.clock ?? (() => new Date());
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Runs `fn` under `BEGIN IMMEDIATE`; anything it throws rolls the whole transition back */
  private immediate<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // SQLite ended the transaction itself; the error that got here is the one to report
      }
      throw err;
    }
  }

  private row(id: string): LessonRow | undefined {
    return this.sql.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow | undefined;
  }

  private mustRow(id: string): LessonRow {
    const row = this.row(id);
    if (!row) throw missing();
    return row;
  }

  /** One guarded update; zero changed rows is a lost race */
  private guarded(sql: string, params: SQLInputValue[]): void {
    const result = this.sql.prepare(sql).run(...params);
    if (Number(result.changes) === 0) throw lost();
  }

  private lessonOf(row: LessonRow): Lesson {
    const settings = this.settings();
    const status = row.status as LessonStatus;
    const pinned = row.pinned === 1;
    const now = effective(row.confidence, pinned, row.last_confirmed_at, this.clock(), settings);
    const evidence = this.sql.prepare('SELECT id, signal, quote, context, chat_id, entry_uuid, at FROM lesson_evidence WHERE lesson_id = ? ORDER BY seq').all(row.id) as unknown as EvidenceRow[];
    return {
      id: row.id,
      key: `L-${row.seq}`,
      projectId: row.project_id,
      status,
      trigger: row.trigger,
      action: row.action,
      confidence: row.confidence,
      effectiveConfidence: now,
      delivered: delivered(status, now, settings),
      seenCount: row.seen_count,
      pinned,
      mechanical: row.mechanical === 1,
      conflictsWithInstructions: row.conflicts_instructions === 1,
      contradicts: row.contradicts_id,
      overrides: row.overrides_id,
      promotedFrom: row.promoted_from,
      // The service counts the other projects when it reads
      alsoInProjects: 0,
      retiredReason: row.retired_reason as LessonRetiredReason | null,
      proposalId: row.proposal_id,
      instructionsProposalId: row.instructions_proposal_id,
      evidence: evidence.map((e) => ({
        id: e.id,
        signal: e.signal as LessonSignalKind,
        quote: e.quote,
        context: e.context,
        chatId: e.chat_id,
        // The service names the chat, or says it is gone
        chatTitle: null,
        entryUuid: e.entry_uuid,
        at: e.at,
      })) satisfies LessonEvidence[],
      proposedBy: actorOf(row.proposed_by_kind, row.proposed_by_role),
      decidedBy: row.decided_by_kind ? actorOf(row.decided_by_kind, row.decided_by_role) : null,
      decidedAt: row.decided_at,
      editedAt: row.edited_at,
      lastSeenAt: row.last_seen_at,
      lastConfirmedAt: row.last_confirmed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  find(id: string): Lesson | null {
    const row = this.row(id);
    return row ? this.lessonOf(row) : null;
  }

  mustFind(id: string): Lesson {
    return this.lessonOf(this.mustRow(id));
  }

  /** Oldest first, which is the order of their keys */
  list(filter: LessonFilter = {}): Lesson[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.projectId === null) where.push('project_id IS NULL');
    else if (filter.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const rows = this.sql
      .prepare(`SELECT * FROM lessons ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`)
      .all(...params) as unknown as LessonRow[];
    return rows.map((row) => this.lessonOf(row));
  }

  /** A new lesson, `proposed` and waiting for the person */
  insert(input: NewLesson): Lesson {
    const id = randomUUID();
    const at = this.now();
    this.immediate(() => {
      this.insertRow(id, input, 'proposed', at, at);
      for (const evidence of input.evidence ?? []) this.addEvidenceRow(id, evidence);
      this.capEvidence(id);
    });
    return this.mustFind(id);
  }

  private insertRow(id: string, input: NewLesson, status: LessonStatus, at: string, confirmedAt: string, promotedFrom: string | null = null): void {
    this.sql
      .prepare(
        `INSERT INTO lessons (id, project_id, status, trigger, action, confidence, mechanical, conflicts_instructions,
           contradicts_id, overrides_id, promoted_from, proposal_id, proposed_by_kind, proposed_by_role,
           last_seen_at, last_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        status,
        input.trigger,
        input.action,
        input.confidence,
        flag(input.mechanical),
        flag(input.conflictsWithInstructions),
        input.contradicts ?? null,
        input.overrides ?? null,
        promotedFrom,
        input.proposalId ?? null,
        input.proposedBy.kind,
        input.proposedBy.role ?? null,
        at,
        confirmedAt,
        at,
        at,
      );
  }

  private addEvidenceRow(lessonId: string, evidence: EvidenceInput): void {
    this.sql
      .prepare('INSERT INTO lesson_evidence (id, lesson_id, signal, quote, context, chat_id, entry_uuid, job_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), lessonId, evidence.signal, evidence.quote, evidence.context, evidence.chatId, evidence.entryUuid, evidence.jobId ?? null, evidence.at);
  }

  /** Ten at most; the oldest go first */
  private capEvidence(lessonId: string): void {
    this.sql
      .prepare('DELETE FROM lesson_evidence WHERE lesson_id = ? AND seq NOT IN (SELECT seq FROM lesson_evidence WHERE lesson_id = ? ORDER BY seq DESC LIMIT ?)')
      .run(lessonId, lessonId, LESSON_EVIDENCE_MAX);
  }

  /** Adds evidence to a lesson of any status, ten at most; the oldest go first */
  appendEvidence(id: string, evidence: EvidenceInput[]): Lesson {
    this.immediate(() => {
      this.mustRow(id);
      for (const item of evidence) this.addEvidenceRow(id, item);
      this.capEvidence(id);
    });
    return this.mustFind(id);
  }

  /** The two links a kept contradiction leaves: the lesson it contradicts, and the global one it overrides here */
  setLinks(id: string, links: { contradicts?: string | null; overrides?: string | null }): void {
    const row = this.mustRow(id);
    this.sql
      .prepare('UPDATE lessons SET contradicts_id = ?, overrides_id = ?, updated_at = ? WHERE id = ?')
      .run(links.contradicts === undefined ? row.contradicts_id : links.contradicts, links.overrides === undefined ? row.overrides_id : links.overrides, this.now(), id);
  }

  /** Takes back a retirement made for `CLAUDE.md` when that write failed; the lesson is as it was, active */
  reactivate(id: string): void {
    this.sql
      .prepare("UPDATE lessons SET status = 'active', retired_reason = NULL, updated_at = ? WHERE id = ? AND status = 'retired' AND retired_reason = 'instructions'")
      .run(this.now(), id);
  }

  /** Removes a lesson that was never offered, when the proposal that should carry it could not be written */
  discard(id: string): void {
    this.sql.prepare("DELETE FROM lessons WHERE id = ? AND status = 'proposed'").run(id);
  }

  /** Links the memory proposal that carries the person's decision about a lesson */
  setProposal(id: string, proposalId: string): void {
    this.mustRow(id);
    this.sql.prepare('UPDATE lessons SET proposal_id = ?, updated_at = ? WHERE id = ?').run(proposalId, this.now(), id);
  }

  /** Links the `instructions` proposal made from a lesson, or clears it */
  setInstructionsProposal(id: string, proposalId: string | null): void {
    this.mustRow(id);
    this.sql.prepare('UPDATE lessons SET instructions_proposal_id = ?, updated_at = ? WHERE id = ?').run(proposalId, this.now(), id);
  }

  /**
   * proposed → active. The confidence rises to the approval floor; `retire` lists the active lessons
   * this one contradicts, retired in the same transaction.
   */
  approve(id: string, opts: { by?: WorkItemActor; edit?: { trigger: string; action: string }; retire?: string[] } = {}): Lesson {
    const by = opts.by ?? PERSON;
    const at = this.now();
    this.immediate(() => {
      const row = this.mustRow(id);
      const confidence = Math.max(row.confidence, this.settings().confidence.approveFloor);
      const edited = opts.edit;
      this.guarded(
        `UPDATE lessons SET status = 'active', confidence = ?, trigger = ?, action = ?, edited_at = ?, decided_by_kind = ?, decided_by_role = ?,
           decided_at = ?, last_confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'`,
        [confidence, edited?.trigger ?? row.trigger, edited?.action ?? row.action, edited ? at : null, by.kind, by.role ?? null, at, at, at, id],
      );
      for (const other of opts.retire ?? []) this.retireRow(other, 'contradicted', at);
    });
    return this.mustFind(id);
  }

  /**
   * proposed → gone: its evidence moves to `targetId`, an active lesson that is seen once more, and
   * the proposed row is deleted. Answers the target.
   */
  merge(id: string, targetId: string): Lesson {
    const at = this.now();
    const { confidence } = this.settings();
    this.immediate(() => {
      this.mustRow(id);
      this.mustRow(targetId);
      this.guarded(
        `UPDATE lessons SET confidence = ROUND(MIN(?, confidence + ?), 2), seen_count = seen_count + 1, last_seen_at = ?, last_confirmed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        [confidence.max, confidence.seenStep, at, at, at, targetId],
      );
      this.sql.prepare('UPDATE lesson_evidence SET lesson_id = ? WHERE lesson_id = ?').run(targetId, id);
      this.capEvidence(targetId);
      // A proposed row that is gone or decided rolls the whole merge back
      this.guarded("DELETE FROM lessons WHERE id = ? AND status = 'proposed'", [id]);
    });
    return this.mustFind(targetId);
  }

  /** proposed → rejected */
  reject(id: string, by: WorkItemActor = PERSON): Lesson {
    const at = this.now();
    this.mustRow(id);
    this.guarded(
      `UPDATE lessons SET status = 'rejected', decided_by_kind = ?, decided_by_role = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'`,
      [by.kind, by.role ?? null, at, at, id],
    );
    return this.mustFind(id);
  }

  /** The person's words for an active lesson; the confidence stays */
  edit(id: string, edit: { trigger?: string; action?: string }): Lesson {
    const at = this.now();
    const row = this.mustRow(id);
    this.guarded("UPDATE lessons SET trigger = ?, action = ?, edited_at = ?, updated_at = ? WHERE id = ? AND status = 'active'", [
      edit.trigger ?? row.trigger,
      edit.action ?? row.action,
      at,
      at,
      id,
    ]);
    return this.mustFind(id);
  }

  /** A pinned lesson does not decay */
  pin(id: string, pinned: boolean): Lesson {
    this.mustRow(id);
    this.guarded("UPDATE lessons SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'", [flag(pinned), this.now(), id]);
    return this.mustFind(id);
  }

  /** "Still right": a step up, and the decay starts over */
  confirm(id: string): Lesson {
    const at = this.now();
    const { confirmStep, max } = this.settings().confidence;
    this.mustRow(id);
    this.guarded("UPDATE lessons SET confidence = ROUND(MIN(?, confidence + ?), 2), last_confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'", [
      max,
      confirmStep,
      at,
      at,
      id,
    ]);
    return this.mustFind(id);
  }

  /** The miner saw it again: a step up, one more sighting, the decay starts over, the evidence grows */
  seen(id: string, evidence: EvidenceInput[] = []): Lesson {
    const at = this.now();
    const { seenStep, max } = this.settings().confidence;
    this.immediate(() => {
      this.mustRow(id);
      this.guarded(
        `UPDATE lessons SET confidence = ROUND(MIN(?, confidence + ?), 2), seen_count = seen_count + 1, last_seen_at = ?, last_confirmed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        [max, seenStep, at, at, at, id],
      );
      for (const item of evidence) this.addEvidenceRow(id, item);
      this.capEvidence(id);
    });
    return this.mustFind(id);
  }

  /** active → retired */
  retire(id: string, reason: LessonRetiredReason = 'person', by: WorkItemActor = PERSON): Lesson {
    const at = this.now();
    this.mustRow(id);
    this.retireRow(id, reason, at, by);
    return this.mustFind(id);
  }

  private retireRow(id: string, reason: LessonRetiredReason, at: string, by: WorkItemActor = PERSON): void {
    this.guarded(
      `UPDATE lessons SET status = 'retired', retired_reason = ?, decided_by_kind = ?, decided_by_role = ?, decided_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
      [reason, by.kind, by.role ?? null, at, at, id],
    );
  }

  /** retired → active, delivered again at once */
  restore(id: string): Lesson {
    const at = this.now();
    const { approveFloor } = this.settings().confidence;
    this.mustRow(id);
    this.guarded(
      `UPDATE lessons SET status = 'active', retired_reason = NULL, confidence = MAX(confidence, ?), last_confirmed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'retired'`,
      [approveFloor, at, at, id],
    );
    return this.mustFind(id);
  }

  /**
   * The decay sweep's guarded update: it retires only while the lesson is still active, unpinned and
   * last confirmed at `lastConfirmedAt`, so a confirmation that lands in between wins. False when it lost.
   */
  retireDecayed(id: string, lastConfirmedAt: string): boolean {
    const at = this.now();
    const result = this.sql
      .prepare(
        `UPDATE lessons SET status = 'retired', retired_reason = 'decayed', decided_by_kind = 'system', decided_by_role = NULL, decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND pinned = 0 AND last_confirmed_at = ?`,
      )
      .run(at, at, id, lastConfirmedAt);
    return Number(result.changes) > 0;
  }

  /** Retires every active lesson that decayed below `retireBelow`; answers the ones it retired */
  sweep(): Lesson[] {
    const settings = this.settings();
    const now = this.clock();
    const retired: Lesson[] = [];
    const rows = this.sql.prepare("SELECT * FROM lessons WHERE status = 'active' AND pinned = 0").all() as unknown as LessonRow[];
    for (const row of rows) {
      const level = effective(row.confidence, false, row.last_confirmed_at, now, settings);
      if (!shouldRetire('active', false, level, settings)) continue;
      if (this.retireDecayed(row.id, row.last_confirmed_at)) retired.push(this.mustFind(row.id));
    }
    return retired;
  }

  /** active project lesson → superseded, with an active global copy that remembers where it came from */
  promote(id: string, by: WorkItemActor = PERSON): { global: Lesson; origin: Lesson } {
    const at = this.now();
    const globalId = randomUUID();
    this.immediate(() => {
      const row = this.mustRow(id);
      if (row.project_id === null) throw new WorkItemError('a global lesson cannot be promoted', 409);
      this.guarded("UPDATE lessons SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active'", [at, id]);
      this.copy(row, globalId, null, 'active', at, by, id);
    });
    return { global: this.mustFind(globalId), origin: this.mustFind(id) };
  }

  /**
   * A global lesson goes away: its origin comes back to `active`, or, with no origin left to return
   * to, a project row is created in `projectId`. Answers the lesson that now holds it.
   */
  demote(id: string, projectId?: string, by: WorkItemActor = PERSON): Lesson {
    const at = this.now();
    const target = this.immediate(() => {
      const row = this.mustRow(id);
      if (row.project_id !== null || row.status !== 'active') throw lost();
      const origin = row.promoted_from ? this.row(row.promoted_from) : undefined;
      let heldBy: string;
      if (origin && origin.status === 'superseded') {
        this.guarded("UPDATE lessons SET status = 'active', updated_at = ? WHERE id = ? AND status = 'superseded'", [at, origin.id]);
        heldBy = origin.id;
      } else {
        if (!projectId) throw new WorkItemError('projectId is required to demote a lesson with no origin', 400);
        heldBy = randomUUID();
        this.copy(row, heldBy, projectId, 'active', at, by, null);
      }
      this.sql.prepare('DELETE FROM lessons WHERE id = ?').run(id);
      return heldBy;
    });
    return this.mustFind(target);
  }

  /** A copy of `from` with its evidence, under a new id */
  private copy(from: LessonRow, id: string, projectId: string | null, status: LessonStatus, at: string, by: WorkItemActor, promotedFrom: string | null): void {
    this.insertRow(
      id,
      {
        projectId,
        trigger: from.trigger,
        action: from.action,
        confidence: from.confidence,
        mechanical: from.mechanical === 1,
        conflictsWithInstructions: from.conflicts_instructions === 1,
        proposedBy: actorOf(from.proposed_by_kind, from.proposed_by_role),
      },
      status,
      at,
      at,
      promotedFrom,
    );
    this.sql
      .prepare('UPDATE lessons SET seen_count = ?, pinned = ?, decided_by_kind = ?, decided_by_role = ?, decided_at = ?, last_seen_at = ? WHERE id = ?')
      .run(from.seen_count, from.pinned, by.kind, by.role ?? null, at, from.last_seen_at, id);
    this.sql
      .prepare(
        `INSERT INTO lesson_evidence (id, lesson_id, signal, quote, context, chat_id, entry_uuid, job_id, at)
         SELECT lower(hex(randomblob(16))), ?, signal, quote, context, chat_id, entry_uuid, job_id, at FROM lesson_evidence WHERE lesson_id = ? ORDER BY seq`,
      )
      .run(id, from.id);
  }

  /** Hard delete with its evidence; a proposed lesson is rejected instead, so it is not mined again */
  delete(id: string): void {
    const row = this.mustRow(id);
    if (row.status === 'proposed') throw new WorkItemError('reject a proposed lesson instead, so it is not mined again', 409);
    const result = this.sql.prepare("DELETE FROM lessons WHERE id = ? AND status <> 'proposed'").run(id);
    if (Number(result.changes) === 0) throw lost();
  }
}
