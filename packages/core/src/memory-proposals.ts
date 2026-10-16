import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MEMORY_PROPOSAL_STATUSES,
  MEMORY_PROPOSAL_TARGET_KINDS,
  rulePathsProblem,
  type ApproveMemoryProposalRequest,
  type FlowMemoryProposal,
  type Lesson,
  type MemoryProposal,
  type MemoryProposalAction,
  type MemoryProposalPreview,
  type MemoryProposalStatus,
  type MemoryProposalTarget,
  type PreviewMemoryProposalRequest,
  type RejectMemoryProposalRequest,
  type WorkItemActor,
  type WorkItemRef,
  type WorkItemSource,
} from '@claudio/shared';
import { writeAtomic } from './config/files.ts';
import { ConfigResources } from './config/resources.ts';
import { projectScope } from './config/scope.ts';
import type { Db } from './db.ts';
import type { DecisionEngine } from './decisions/engine.ts';
import type { ClaudioEventInput } from './events.ts';
import type { JournalService } from './journal.ts';
import { JOURNAL_ENTRY_MAX } from './journal.ts';
import { MemoryStore } from './memory.ts';
import { readFrontmatterList } from './team.ts';
import { actorOf, sourceOf } from './work-item-rows.ts';
import { PERSON, WorkItemError } from './work-item-validation.ts';

/**
 * What a team member proposes the team should remember, waiting for the person (decision 33 of
 * docs/plans/project-ecosystem.md). A proposal is a row until a person approves it: nothing reaches
 * `CLAUDE.md`, the CLI's memory directory or the journal before. Approving writes the target, with the
 * person's edited text when they changed it; rejecting writes nothing but the decision.
 *
 * Two processes may decide the same proposal at once, so the decision is claimed on the row first
 * (`WHERE status = 'pending'`) and only the one that claimed it writes the target. A target that
 * cannot be written hands the proposal back to `pending`, so the person can try again.
 */

export const PROPOSAL_REASON_MAX = 2_000;
const SECTION_MAX = 200;

/** Where a project's memory lives on disk. */
export interface ProposalProject {
  /** The project's directory, where its `CLAUDE.md` is */
  path: string;
  /** The key of its CLI memory directory (`MemoryStore`), derived from the directory */
  memoryKey: string;
}

/**
 * What approving a `lesson` proposal does to the lessons store, which `LessonService` implements and
 * attaches (`attachLessons`): the service needs this one to create proposals, so neither takes the
 * other at construction.
 */
export interface LessonApprovals {
  /** The lesson as the card shows it, with its evidence; null when it is gone */
  view(lessonId: string): Lesson | null;
  /** Checks the person's choices before anything is claimed: 400, 404 or 409. Answers their edit, as it will be stored */
  checkApproval(lessonId: string, input: ApproveMemoryProposalRequest): { edit: { trigger: string; action: string } | null };
  /** Applies them in one transaction; answers the id of the lesson that holds the result */
  approveProposed(lessonId: string, input: ApproveMemoryProposalRequest, edit: { trigger: string; action: string } | null, by: WorkItemActor): string;
  /** A rejected proposal rejects the lesson behind it too, unless the lesson is one that already existed */
  rejectProposed(lessonId: string, by: WorkItemActor): void;
  /** The lesson an approved `instructions` proposal now holds: retired, reason `instructions`. False when it is no longer active */
  retireForInstructions(lessonId: string, by: WorkItemActor): boolean;
  /** Takes that retirement back, when `CLAUDE.md` could not be written */
  reinstate(lessonId: string): void;
}

/** The one line a lesson is shown and approved as: "When …: …" */
export function lessonLine(trigger: string, action: string): string {
  return `${trigger}: ${action}`;
}

export interface MemoryProposalServiceDeps {
  db: Db;
  journal: JournalService;
  memory: MemoryStore;
  /** Null for an id that names no imported project */
  project: (projectId: string) => ProposalProject | null;
  emit?: (event: ClaudioEventInput) => void;
  item?: (itemId: string) => WorkItemRef | null;
  /** The decision engine, for `memory.triage`; without it the list stays in arrival order */
  decisions?: Pick<DecisionEngine, 'ask' | 'effective'>;
  /** The resources a `rule` target is written through; without it a plain one writes the file */
  resources?: () => ConfigResources;
}

/** How a triaged proposal is ordered: the higher its usefulness, the earlier the person sees it */
const TRIAGE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, duplicate: 0 };
const TRIAGE_TITLES_MAX = 40;
const TRIAGE_TEXT_MAX = 300;

/** Where a proposal came from: the member, its chat, its flow run and the item it worked on. */
export interface ProposalOrigin {
  proposedBy: WorkItemActor;
  source?: WorkItemSource | null;
  flowRunId?: string | null;
  itemId?: string | null;
  /** The lesson an `instructions` proposal is made from, retired when the proposal is approved */
  lessonId?: string | null;
}

interface ProposalRow {
  seq: number;
  id: string;
  project_id: string;
  target_kind: string;
  target_file: string | null;
  target_section: string | null;
  /** A JSON array of globs, for a `rule`; null for the other kinds */
  target_paths: string | null;
  text: string;
  reason: string;
  status: string;
  proposed_by_kind: string;
  proposed_by_role: string | null;
  source_kind: string | null;
  source_chat_id: string | null;
  source_orchestration_id: string | null;
  source_task_id: string | null;
  flow_run_id: string | null;
  item_id: string | null;
  approved_text: string | null;
  decided_by_kind: string | null;
  decided_by_role: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  journal_entry_id: string | null;
  lesson_id: string | null;
  created_at: string;
}

export class MemoryProposalService {
  private readonly sql: DatabaseSync;
  private lessons: LessonApprovals | null = null;

  constructor(private readonly deps: MemoryProposalServiceDeps) {
    this.sql = deps.db.connection;
  }

  /** Called once by whoever builds the `LessonService`; without it a `lesson` proposal cannot be decided */
  attachLessons(lessons: LessonApprovals): void {
    this.lessons = lessons;
  }

  private lessonsOrThrow(): LessonApprovals {
    if (!this.lessons) throw new WorkItemError('lessons are not available', 409);
    return this.lessons;
  }

  /**
   * A `lesson` proposal, written by the lesson miner and nobody else: `propose` refuses the kind, because
   * a lesson rests on a person's correction. The lesson row exists already; this is the person's
   * decision about it, which is why it is not a proposal of the usual kind.
   */
  proposeLesson(projectId: string, lessonId: string, text: string, reason: string, source: WorkItemSource | null): MemoryProposal {
    const id = randomUUID();
    this.sql
      .prepare(
        `INSERT INTO memory_proposals (id, project_id, target_kind, target_file, target_section, target_paths, text, reason, status,
           proposed_by_kind, proposed_by_role, source_kind, source_chat_id, lesson_id, created_at)
         VALUES (?, ?, 'lesson', NULL, NULL, NULL, ?, ?, 'pending', 'system', NULL, ?, ?, ?, ?)`,
      )
      .run(id, projectId, text, reason.slice(0, PROPOSAL_REASON_MAX), source?.kind ?? null, source?.chatId ?? null, lessonId, new Date().toISOString());
    // Lesson proposals raise no notification: they wait in the Memory tab with the others
    return this.mustFind(id);
  }

  /** Points a proposal at the lesson that holds its result (a merge moves it) */
  retarget(proposalId: string, lessonId: string): void {
    this.sql.prepare('UPDATE memory_proposals SET lesson_id = ? WHERE id = ?').run(lessonId, proposalId);
  }

  /** Newest first; every status unless one is asked for. */
  list(projectId: string, status?: unknown): MemoryProposal[] {
    const params: SQLInputValue[] = [projectId];
    if (status !== undefined && status !== '') {
      if (typeof status !== 'string' || !(MEMORY_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        throw new WorkItemError(`status must be one of ${MEMORY_PROPOSAL_STATUSES.join(', ')}`, 400);
      }
      params.push(status);
    }
    const rows = this.sql
      .prepare(`SELECT * FROM memory_proposals WHERE project_id = ?${params.length > 1 ? ' AND status = ?' : ''} ORDER BY seq DESC`)
      .all(...params) as unknown as ProposalRow[];
    return this.triaged(projectId, rows).map((r) => this.proposalOf(r));
  }

  /**
   * `memory.triage`, active: the pending proposals ordered by the usefulness the engine scored them,
   * each in a place a pending proposal already had, so decided ones do not move. Only a suggestion:
   * nothing is hidden, merged or decided by it.
   */
  private triaged(projectId: string, rows: ProposalRow[]): ProposalRow[] {
    const engine = this.deps.decisions;
    if (!engine) return rows;
    const now = engine.effective('memory.triage', projectId);
    if (now.mode !== 'active' || now.limited) return rows;
    const scored = this.sql
      .prepare("SELECT subject_id, answers FROM decisions WHERE point = 'memory.triage' AND project_id = ? AND acted = 1 ORDER BY seq")
      .all(projectId) as unknown as Array<{ subject_id: string | null; answers: string | null }>;
    const rank = new Map<string, number>();
    for (const r of scored) {
      try {
        const level = (JSON.parse(r.answers ?? '{}') as Record<string, { value?: unknown }>).usefulness?.value;
        if (r.subject_id && typeof level === 'string' && level in TRIAGE_RANK) rank.set(r.subject_id, TRIAGE_RANK[level] ?? 0);
      } catch {
        // An unreadable answer is an unscored proposal
      }
    }
    const pending = rows.filter((r) => r.status === 'pending' && rank.has(r.id));
    if (pending.length < 2) return rows;
    // Stable: equal scores keep arrival order (newest first)
    const ordered = [...pending].sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
    const queue = [...ordered];
    return rows.map((r) => (r.status === 'pending' && rank.has(r.id) ? (queue.shift() ?? r) : r));
  }

  /**
   * Asks `memory.triage` about a proposal that was just recorded. Never awaited by the proposer, and
   * never a reason for it to fail: the row is written and the person decides it either way.
   */
  private triage(proposal: MemoryProposal): void {
    const engine = this.deps.decisions;
    if (!engine || engine.effective('memory.triage', proposal.projectId).mode === 'off') return;
    void (async () => {
      const project = this.deps.project(proposal.projectId);
      const memory = project ? await this.deps.memory.list(project.memoryKey).catch(() => []) : [];
      const journal = this.deps.journal.page(proposal.projectId, { limit: 20 }).entries;
      await engine.ask(
        'memory.triage',
        {
          kind: 'memory_proposal',
          id: proposal.id,
          data: {
            proposal: proposal.text.slice(0, TRIAGE_TEXT_MAX * 2),
            target: proposal.target.file ?? proposal.target.section ?? proposal.target.kind,
            memoryTitles: memory.filter((f) => !f.isIndex).map((f) => f.description ?? f.name).slice(0, TRIAGE_TITLES_MAX),
            journalTitles: journal.map((e) => e.text.split('\n')[0]?.slice(0, TRIAGE_TEXT_MAX) ?? ''),
          },
        },
        { projectId: proposal.projectId },
      );
    })().catch(() => undefined);
  }

  find(proposalId: string): MemoryProposal | null {
    const row = this.row(proposalId);
    return row ? this.proposalOf(row) : null;
  }

  /**
   * Records what a flow run's result proposes, checked as the person would need it to be written:
   * a target that could never be written is refused now, not at approval.
   */
  propose(projectId: string, proposal: FlowMemoryProposal, origin: ProposalOrigin): MemoryProposal {
    const target = targetOf(proposal.target);
    // A flow run never proposes a lesson (A4): only the miner does, through `proposeLesson`
    if (target.kind === 'lesson') throw new WorkItemError("a lesson cannot be proposed here: lessons come from a person's corrections", 400);
    const text = proposalText(proposal.text);
    const reason = typeof proposal.reason === 'string' ? proposal.reason.trim().slice(0, PROPOSAL_REASON_MAX) : '';
    const source = origin.source ?? null;
    const id = randomUUID();
    // Checked and written under one lock, or two runs proposing the same entry at once would both pass
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const same = this.sameProposal(projectId, target, text);
      if (same) {
        this.sql.exec('COMMIT');
        return same;
      }
      this.insert(id, projectId, target, text, reason, source, origin);
      this.sql.exec('COMMIT');
    } catch (err) {
      try {
        this.sql.exec('ROLLBACK');
      } catch {
        // SQLite ended the transaction itself; the error that got here is the one to report
      }
      throw err;
    }
    const created = this.mustFind(id);
    this.announce(created, 'created');
    this.triage(created);
    return created;
  }

  /**
   * A proposal of the same text for the same target, already waiting or already decided. Members
   * that meet the same fact on every run propose it every time: the person decides it once, and a
   * rejected one stays rejected rather than coming back. Compared without case or spacing, and
   * against the text the person approved as well as the one proposed.
   */
  private sameProposal(projectId: string, target: MemoryProposalTarget, text: string): MemoryProposal | null {
    const wanted = sameText(text);
    const rows = this.sql
      .prepare(
        `SELECT * FROM memory_proposals WHERE project_id = ? AND target_kind = ? AND target_file IS ? AND target_section IS ? AND target_paths IS ?
         ORDER BY seq DESC`,
      )
      .all(projectId, target.kind, target.file, target.section, target.paths ? JSON.stringify(target.paths) : null) as unknown as ProposalRow[];
    const row = rows.find((r) => sameText(r.text) === wanted || (r.approved_text !== null && sameText(r.approved_text) === wanted));
    return row ? this.proposalOf(row) : null;
  }

  private insert(
    id: string,
    projectId: string,
    target: MemoryProposalTarget,
    text: string,
    reason: string,
    source: WorkItemSource | null,
    origin: ProposalOrigin,
  ): void {
    this.sql
      .prepare(
        `INSERT INTO memory_proposals (id, project_id, target_kind, target_file, target_section, target_paths, text, reason, status,
           proposed_by_kind, proposed_by_role, source_kind, source_chat_id, source_orchestration_id, source_task_id,
           flow_run_id, item_id, lesson_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        target.kind,
        target.file,
        target.section,
        target.paths ? JSON.stringify(target.paths) : null,
        text,
        reason,
        origin.proposedBy.kind,
        origin.proposedBy.role ?? null,
        source?.kind ?? null,
        source?.chatId ?? null,
        source?.orchestrationId ?? null,
        source?.taskId ?? null,
        origin.flowRunId ?? null,
        origin.itemId ?? null,
        origin.lessonId ?? null,
        new Date().toISOString(),
      );
  }

  /** What approving an `instructions` proposal would do to `CLAUDE.md`, as a diff: the person reads it before Approve is enabled */
  async preview(proposalId: string, input: PreviewMemoryProposalRequest = {}): Promise<MemoryProposalPreview> {
    const proposal = this.pending(proposalId);
    if (proposal.target.kind !== 'instructions') throw new WorkItemError('only an instructions proposal has a preview', 400);
    const edited = (input as Partial<PreviewMemoryProposalRequest> | undefined)?.text;
    const text = edited === undefined || edited === null ? proposal.text : proposalText(edited);
    const project = this.deps.project(proposal.projectId);
    if (!project) throw new WorkItemError('its project is not imported: import the directory again to write its memory', 409);
    const path = join(project.path, 'CLAUDE.md');
    const exists = existsSync(path);
    const current = exists ? await readFile(path, 'utf8') : '';
    const section = input?.section === undefined ? proposal.target.section : sectionOf(input.section, 'section');
    const after = withText(current, text, section);
    return { path: 'CLAUDE.md', exists, sha256: sha256(current), diff: lineDiff(current, after, 3), bytesAfter: Buffer.byteLength(after) };
  }

  /** The proposal waiting to move a lesson into `CLAUDE.md`, if any */
  pendingInstructionsFor(lessonId: string): MemoryProposal | null {
    const row = this.sql
      .prepare("SELECT * FROM memory_proposals WHERE lesson_id = ? AND target_kind = 'instructions' AND status = 'pending' ORDER BY seq DESC LIMIT 1")
      .get(lessonId) as ProposalRow | undefined;
    return row ? this.proposalOf(row) : null;
  }

  /** Writes the target, with `text` instead of the proposed text when the person edited it. */
  async approve(proposalId: string, input: ApproveMemoryProposalRequest = {}, decidedBy: WorkItemActor = PERSON): Promise<MemoryProposal> {
    const before = this.pending(proposalId);
    if (before.target.kind === 'lesson') return this.approveLesson(before, input ?? {}, decidedBy);
    const edited = (input as Partial<ApproveMemoryProposalRequest> | undefined)?.text;
    const text = edited === undefined || edited === null ? before.text : proposalText(edited);
    const project = this.deps.project(before.projectId);
    if (!project) throw new WorkItemError('its project is not imported: import the directory again to write its memory', 409);
    const previewOf = (input as Partial<ApproveMemoryProposalRequest> | undefined)?.previewOf;
    if (previewOf !== undefined && previewOf !== null && typeof previewOf !== 'string') throw new WorkItemError('previewOf must be the sha256 of the preview', 400);
    // A lesson goes into CLAUDE.md only after the person saw the diff; a flow run's proposal may skip it, for older clients
    if (before.target.kind === 'instructions' && !previewOf && this.row(proposalId)?.lesson_id) {
      throw new WorkItemError('previewOf is required to approve a lesson into CLAUDE.md: preview it first', 400);
    }
    // The person may move it to another heading while reading the diff; the target keeps what was written
    const section = before.target.kind === 'instructions' && input?.section !== undefined ? sectionOf(input.section, 'section') : before.target.section;
    this.claim(proposalId, 'approved', decidedBy, { approvedText: text === before.text ? null : text });
    if (section !== before.target.section) this.sql.prepare('UPDATE memory_proposals SET target_section = ? WHERE id = ?').run(section, proposalId);
    // An `instructions` proposal made from a lesson retires it with the claim: CLAUDE.md holds it now
    const fromLesson = before.target.kind === 'instructions' ? this.row(proposalId)?.lesson_id : null;
    const retired = fromLesson ? (this.lessons?.retireForInstructions(fromLesson, decidedBy) ?? false) : false;
    try {
      if (before.target.kind === 'journal') {
        const entry = this.deps.journal.add(before.projectId, {
          kind: 'memory',
          text,
          itemId: before.itemId,
          author: before.proposedBy,
          approvedBy: decidedBy,
          proposalId,
          ...(before.source ? { sources: [before.source] } : {}),
        });
        this.sql.prepare('UPDATE memory_proposals SET journal_entry_id = ? WHERE id = ?').run(entry.id, proposalId);
      } else if (before.target.kind === 'rule') {
        const file = (input as Partial<ApproveMemoryProposalRequest> | undefined)?.file;
        const written = await this.writeRule(project.path, ruleFile(file === undefined || file === null ? before.target.file : file), before.target.paths ?? [], text);
        if (written !== before.target.file) this.sql.prepare('UPDATE memory_proposals SET target_file = ? WHERE id = ?').run(written, proposalId);
      } else if (before.target.kind === 'memory') {
        await this.deps.memory.append(project.memoryKey, before.target.file ?? '', text, before.reason);
      } else {
        const path = join(project.path, 'CLAUDE.md');
        const current = existsSync(path) ? await readFile(path, 'utf8') : '';
        if (previewOf && previewOf !== sha256(current)) throw new WorkItemError('CLAUDE.md changed since you saw the diff', 409);
        await writeAtomic(path, withText(current, text, section));
      }
    } catch (err) {
      // Both rows go back: the proposal waits again and the lesson is handed again
      if (retired && fromLesson) this.lessons?.reinstate(fromLesson);
      this.release(proposalId);
      throw err;
    }
    const approved = this.mustFind(proposalId);
    this.announce(approved, 'approved');
    return approved;
  }

  /** A `lesson` proposal writes no file: approving it makes the lesson active, or folds it into another */
  private approveLesson(before: MemoryProposal, input: ApproveMemoryProposalRequest, decidedBy: WorkItemActor): MemoryProposal {
    const lessons = this.lessonsOrThrow();
    const lessonId = this.row(before.id)?.lesson_id;
    if (!lessonId) throw new WorkItemError('the lesson behind this proposal is gone', 409);
    const { edit } = lessons.checkApproval(lessonId, input);
    const text = edit ? lessonLine(edit.trigger, edit.action) : before.text;
    this.claim(before.id, 'approved', decidedBy, { approvedText: text === before.text ? null : text });
    try {
      const held = lessons.approveProposed(lessonId, input, edit, decidedBy);
      if (held !== lessonId) this.retarget(before.id, held);
    } catch (err) {
      this.release(before.id);
      throw err;
    }
    const approved = this.mustFind(before.id);
    this.announce(approved, 'approved');
    return approved;
  }

  /**
   * `.claude/rules/<file>` through the project's resources: a new file with the paths as front
   * matter, or the text appended to a rule that already scopes the same set of paths. A rule with
   * other paths (or none) is not touched: the person approves under another name.
   */
  private async writeRule(projectPath: string, file: string, paths: string[], text: string): Promise<string> {
    const resources = this.deps.resources?.() ?? new ConfigResources();
    const scope = projectScope(projectPath);
    const name = file.slice(0, -'.md'.length);
    const existing = await resources.get(scope, 'rules', name);
    if (!existing) {
      const front = ['---', 'paths:', ...paths.map((g) => `  - "${g}"`), '---', '', text.trim(), ''].join('\n');
      await resources.save(scope, 'rules', name, front);
      return file;
    }
    const own = readFrontmatterList(existing.content, 'paths') ?? [];
    const same = own.length === paths.length && new Set(own).size === new Set(paths).size && paths.every((g) => own.includes(g));
    if (!same) throw new WorkItemError(`.claude/rules/${file} exists with other paths; approve it under another name`, 409);
    await resources.save(scope, 'rules', name, `${existing.content.trimEnd()}\n\n${text.trim()}\n`);
    return file;
  }

  reject(proposalId: string, input: RejectMemoryProposalRequest = {}, decidedBy: WorkItemActor = PERSON): MemoryProposal {
    const waiting = this.pending(proposalId);
    const raw = (input as Partial<RejectMemoryProposalRequest> | undefined)?.reason;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new WorkItemError('reason must be text', 400);
    const reason = raw?.trim().slice(0, PROPOSAL_REASON_MAX) || null;
    const lessonId = waiting.target.kind === 'lesson' ? this.row(proposalId)?.lesson_id : null;
    if (lessonId) {
      // The proposal and its lesson are decided together or not at all
      this.sql.exec('BEGIN IMMEDIATE');
      try {
        this.claim(proposalId, 'rejected', decidedBy, { rejectReason: reason });
        this.lessonsOrThrow().rejectProposed(lessonId, decidedBy);
        this.sql.exec('COMMIT');
      } catch (err) {
        try {
          this.sql.exec('ROLLBACK');
        } catch {
          // SQLite ended the transaction itself; the error that got here is the one to report
        }
        throw err;
      }
    } else {
      this.claim(proposalId, 'rejected', decidedBy, { rejectReason: reason });
    }
    const rejected = this.mustFind(proposalId);
    this.announce(rejected, 'rejected');
    return rejected;
  }

  // ---------- rows ----------

  private pending(proposalId: string): MemoryProposal {
    const proposal = this.find(proposalId);
    if (!proposal) throw new WorkItemError('memory proposal not found', 404);
    if (proposal.status !== 'pending') throw new WorkItemError(`the proposal was already ${proposal.status}`, 409);
    return proposal;
  }

  /** Takes the decision on the row, or refuses when another request took it first. */
  private claim(proposalId: string, status: Exclude<MemoryProposalStatus, 'pending'>, by: WorkItemActor, extra: { approvedText?: string | null; rejectReason?: string | null }): void {
    const result = this.sql
      .prepare(
        `UPDATE memory_proposals SET status = ?, decided_by_kind = ?, decided_by_role = ?, decided_at = ?, approved_text = ?, reject_reason = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, by.kind, by.role ?? null, new Date().toISOString(), extra.approvedText ?? null, extra.rejectReason ?? null, proposalId);
    if (Number(result.changes) === 0) throw new WorkItemError('the proposal was decided meanwhile', 409);
  }

  private release(proposalId: string): void {
    this.sql
      .prepare(
        `UPDATE memory_proposals SET status = 'pending', decided_by_kind = NULL, decided_by_role = NULL, decided_at = NULL, approved_text = NULL, journal_entry_id = NULL
         WHERE id = ?`,
      )
      .run(proposalId);
  }

  private row(proposalId: string): ProposalRow | null {
    return (this.sql.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined) ?? null;
  }

  private mustFind(proposalId: string): MemoryProposal {
    const found = this.find(proposalId);
    if (!found) throw new Error('the memory proposal was not persisted');
    return found;
  }

  private proposalOf(r: ProposalRow): MemoryProposal {
    const kind = (MEMORY_PROPOSAL_TARGET_KINDS as readonly string[]).includes(r.target_kind) ? (r.target_kind as MemoryProposalTarget['kind']) : 'journal';
    const status = (MEMORY_PROPOSAL_STATUSES as readonly string[]).includes(r.status) ? (r.status as MemoryProposalStatus) : 'pending';
    return {
      id: r.id,
      projectId: r.project_id,
      target: { kind, file: r.target_file, section: r.target_section, ...(kind === 'rule' ? { paths: pathsOf(r.target_paths) } : {}) },
      text: r.text,
      reason: r.reason,
      status,
      proposedBy: actorOf(r.proposed_by_kind, r.proposed_by_role),
      source: sourceOf(r.source_kind, r.source_chat_id, r.source_orchestration_id, r.source_task_id),
      flowRunId: r.flow_run_id,
      itemId: r.item_id,
      item: r.item_id ? (this.deps.item?.(r.item_id) ?? null) : null,
      approvedText: r.approved_text,
      decidedBy: r.decided_by_kind ? actorOf(r.decided_by_kind, r.decided_by_role) : null,
      decidedAt: r.decided_at,
      rejectReason: r.reject_reason,
      journalEntryId: r.journal_entry_id,
      lesson: kind === 'lesson' && r.lesson_id ? (this.lessons?.view(r.lesson_id) ?? null) : null,
      lessonId: kind === 'instructions' ? r.lesson_id : null,
      createdAt: r.created_at,
    };
  }

  private announce(proposal: MemoryProposal, action: MemoryProposalAction): void {
    const role = proposal.proposedBy.role ?? null;
    const titles: Record<MemoryProposalAction, string> = {
      created: `${role ?? 'An agent'} proposed a memory entry`,
      approved: 'Memory proposal approved',
      rejected: 'Memory proposal rejected',
    };
    this.deps.emit?.({
      type: 'memory.proposal',
      title: titles[action],
      projectId: proposal.projectId,
      proposalId: proposal.id,
      action,
      target: proposal.target,
      role,
      itemId: proposal.itemId,
    });
  }
}

// ---------- checks ----------

/** A heading name as `CLAUDE.md` keeps it: no `#`, one line; null for none */
function sectionOf(value: unknown, field: string): string | null {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new WorkItemError(`${field} must be text`, 400);
  const section = typeof value === 'string' ? value.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim() : '';
  if (section.length > SECTION_MAX) throw new WorkItemError(`${field} is longer than ${String(SECTION_MAX)} characters`, 400);
  return section || null;
}

function targetOf(value: unknown): MemoryProposalTarget {
  if (typeof value !== 'object' || value === null) throw new WorkItemError('a proposal needs its target', 400);
  const v = value as { kind?: unknown; file?: unknown; section?: unknown };
  if (typeof v.kind !== 'string' || !(MEMORY_PROPOSAL_TARGET_KINDS as readonly string[]).includes(v.kind)) {
    throw new WorkItemError(`target.kind must be one of ${MEMORY_PROPOSAL_TARGET_KINDS.join(', ')}`, 400);
  }
  const kind = v.kind as MemoryProposalTarget['kind'];
  if (kind === 'memory') {
    const file = typeof v.file === 'string' ? v.file.trim() : '';
    if (!MemoryStore.isFileName(file) || file === 'MEMORY.md') {
      throw new WorkItemError("target.file must name a memory file other than the index: letters, digits, _ . - and a '.md' extension", 400);
    }
    return { kind, file, section: null };
  }
  if (kind === 'rule') {
    const paths = (value as { paths?: unknown }).paths;
    const problem = rulePathsProblem(paths);
    if (problem) throw new WorkItemError(`target.${problem}`, 400);
    return { kind, file: ruleFile(v.file), section: null, paths: [...new Set((paths as string[]).map((g) => g.trim()))] };
  }
  if (kind === 'instructions') {
    return { kind, file: null, section: sectionOf(v.section, 'target.section') };
  }
  return { kind, file: null, section: null };
}

/** A rule file name: a resource name and `.md`, as `.claude/rules/` holds it */
function ruleFile(value: unknown): string {
  const file = typeof value === 'string' ? value.trim() : '';
  if (!/^[\w.-]{1,61}\.md$/.test(file) || file.startsWith('.')) {
    throw new WorkItemError("target.file must name a rule file: letters, digits, _ . - and a '.md' extension", 400);
  }
  return file;
}

function pathsOf(stored: string | null): string[] | null {
  try {
    const paths: unknown = stored ? JSON.parse(stored) : null;
    return Array.isArray(paths) ? paths.filter((g): g is string => typeof g === 'string') : null;
  } catch {
    return null;
  }
}

/** The text as two proposals are compared: the same words, whatever their case and spacing */
function sameText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function proposalText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkItemError('text is required', 400);
  const text = value.trim();
  if (text.length > JOURNAL_ENTRY_MAX) throw new WorkItemError(`a memory entry is longer than ${String(JOURNAL_ENTRY_MAX)} characters`, 400);
  return text;
}

/**
 * `CLAUDE.md` with `text` added: at the end of the heading `section` names (before the next heading
 * of its level or above), in a new `##` section at the end when there is no such heading, or at the
 * end of the file without a section. Headings inside code fences are text, not headings.
 */
export function withText(current: string, text: string, section: string | null): string {
  const block = text.trim();
  if (!current.trim()) return section ? `## ${section}\n\n${block}\n` : `${block}\n`;
  if (!section) return `${current.trimEnd()}\n\n${block}\n`;
  const lines = current.split('\n');
  const wanted = section.toLowerCase();
  let fenced = false;
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const depth = heading[1]?.length ?? 0;
    if (start === -1) {
      if ((heading[2] ?? '').toLowerCase() === wanted) {
        start = i;
        level = depth;
      }
    } else if (depth <= level) {
      end = i;
      break;
    }
  }
  if (start === -1) return `${current.trimEnd()}\n\n## ${section}\n\n${block}\n`;
  // The section's own trailing blank lines go after the new text, so the spacing before the next heading stays
  let last = end;
  while (last > start + 1 && !(lines[last - 1] ?? '').trim()) last--;
  const head = lines.slice(0, last);
  const tail = lines.slice(end);
  const out = [...head, '', block];
  if (tail.length) out.push('', ...tail);
  const joined = out.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A last line without its newline differs from the same line with one, as it does for git */
const NO_EOL = '\u0000';

function diffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

/**
 * A unified diff of `before` and `after` as one hunk: the lines between their common prefix and
 * suffix, with `context` lines around. Exact for what `withText` does, which only inserts one block;
 * for any other pair it is still a correct patch, only not a minimal one. Empty when they are equal.
 */
export function lineDiff(before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = diffLines(before);
  const b = diffLines(after);
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - context);
  const tail = Math.min(context, suffix);
  const oldEnd = a.length - suffix + tail;
  const newEnd = b.length - suffix + tail;
  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const out = ['--- a/CLAUDE.md', '+++ b/CLAUDE.md', `@@ -${String(oldCount === 0 ? start : start + 1)},${String(oldCount)} +${String(newCount === 0 ? start : start + 1)},${String(newCount)} @@`];
  const emit = (mark: string, line: string) => {
    out.push(`${mark}${line.endsWith(NO_EOL) ? line.slice(0, -NO_EOL.length) : line}`);
    if (line.endsWith(NO_EOL)) out.push('\\ No newline at end of file');
  };
  for (let i = start; i < prefix; i++) emit(' ', a[i] ?? '');
  for (let i = prefix; i < a.length - suffix; i++) emit('-', a[i] ?? '');
  for (let i = prefix; i < b.length - suffix; i++) emit('+', b[i] ?? '');
  for (let i = a.length - suffix; i < oldEnd; i++) emit(' ', a[i] ?? '');
  return `${out.join('\n')}\n`;
}
