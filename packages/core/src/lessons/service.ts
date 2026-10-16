import {
  type ApproveMemoryProposalRequest,
  type Lesson,
  type LessonSettings,
  type LessonChangeAction,
  type LessonStatus,
  type MemoryProposal,
  type UpdateLessonRequest,
  type WorkItemActor,
  type WorkItemSource,
} from '@claudio/shared';
import type { ClaudioEventInput } from '../events.ts';
import { lessonLine, type LessonApprovals, type MemoryProposalService } from '../memory-proposals.ts';
import { PERSON, WorkItemError } from '../work-item-validation.ts';
import { alsoInProjects, matchCandidate } from './match.ts';
import { renderSection, type LessonSection } from './render.ts';
import { DEFAULT_LESSON_SETTINGS } from './settings.ts';
import type { EvidenceInput, LessonStore } from './store.ts';
import { checkLessonText, type Candidate } from './validate.ts';

/*
 * The public operations behind the lesson routes (docs/plans/lessons.md, "Approval", "Lifecycle" and
 * "Promotion"). `LessonStore` holds the guarded transitions; this adds what needs the other
 * services: the memory proposal that carries a person's decision, the chat titles evidence shows,
 * the events, and the hourly decay sweep.
 */

const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** A section is read once per spawn; a change announces itself and drops the cache, this bounds a change made elsewhere */
const SECTION_CACHE_MS = 30_000;

const TITLES: Record<LessonChangeAction, string> = {
  proposed: 'A lesson was proposed',
  approved: 'Lesson approved',
  rejected: 'Lesson rejected',
  edited: 'Lesson edited',
  confirmed: 'Lesson confirmed',
  pinned: 'Lesson pin changed',
  retired: 'Lesson retired',
  restored: 'Lesson restored',
  deleted: 'Lesson deleted',
  promoted: 'Lesson made global',
  demoted: 'Lesson moved back to its project',
  merged: 'Lesson merged',
};

export interface LessonServiceDeps {
  store: LessonStore;
  proposals: MemoryProposalService;
  emit?: (event: ClaudioEventInput) => void;
  /** The title of a chat, or null when it is gone; evidence says so */
  chatTitle?: (chatId: string) => string | null;
  /** The settings now in force (`lessons.json`); the defaults when left out */
  settings?: () => LessonSettings;
  clock?: () => number;
}

/** What one mining run knows about the chat its candidates came from */
export interface MiningContext {
  projectId: string;
  chatId: string | null;
  chatTitle: string | null;
  /** The evidence of each signal the miner was shown, by the id it saw */
  evidence: ReadonlyMap<string, EvidenceInput>;
}

export interface MiningResult {
  /** New proposals written, including the ones that bring a retired lesson back */
  proposed: number;
  /** Candidates folded into an active lesson, which is seen once more */
  merged: number;
  /** Candidates that added their evidence to a proposal already waiting, or to a lesson being brought back */
  appended: number;
  /** Candidates dropped, by reason */
  dropped: Record<string, number>;
}

const ids = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new WorkItemError(`${field} must be a list of lesson ids`, 400);
  return [...new Set(value as string[])];
};

export class LessonService implements LessonApprovals {
  private timer: NodeJS.Timeout | null = null;
  private readonly sections = new Map<string, { at: number; section: LessonSection }>();

  constructor(private readonly deps: LessonServiceDeps) {
    deps.proposals.attachLessons(this);
  }

  // ---------- reads ----------

  /** A lesson as the person sees it: the chats named, and the same rule elsewhere counted */
  private read(lesson: Lesson, others?: readonly Lesson[]): Lesson {
    const title = this.deps.chatTitle;
    const evidence = lesson.evidence.map((e) => ({ ...e, chatTitle: e.chatId && title ? title(e.chatId) : null }));
    let also = 0;
    if (lesson.projectId !== null && lesson.status === 'active') {
      const elsewhere = others ?? this.deps.store.list({ status: 'active' });
      also = alsoInProjects(lesson, elsewhere.filter((o) => o.projectId !== null && o.projectId !== lesson.projectId));
    }
    return { ...lesson, evidence, alsoInProjects: also };
  }

  view(lessonId: string): Lesson | null {
    const lesson = this.deps.store.find(lessonId);
    return lesson ? this.read(lesson) : null;
  }

  get(lessonId: string): Lesson {
    const lesson = this.view(lessonId);
    if (!lesson) throw new WorkItemError('lesson not found', 404);
    return lesson;
  }

  /** A project's own lessons, or the global ones with `null`; one status or every status */
  list(projectId: string | null, status?: LessonStatus): Lesson[] {
    const lessons = this.deps.store.list({ projectId, ...(status ? { status } : {}) });
    const active = this.deps.store.list({ status: 'active' });
    return lessons.map((l) => this.read(l, active));
  }

  /** Every lesson of the project, of every status, for the download. Nothing reads it back (A15). */
  export(projectId: string): Lesson[] {
    return this.list(projectId);
  }

  /**
   * What a run in the project is handed (`null`: a chat outside any project, global lessons only).
   * Cached for 30 s per project and dropped on every change, so a spawn costs no query.
   */
  section(projectId: string | null, opts: { useGlobal?: boolean } = {}): LessonSection {
    const useGlobal = opts.useGlobal !== false;
    const key = `${projectId ?? ''}|${useGlobal ? 'g' : 'p'}`;
    const now = this.deps.clock?.() ?? Date.now();
    const hit = this.sections.get(key);
    if (hit && now - hit.at < SECTION_CACHE_MS) return hit.section;
    const { store } = this.deps;
    const lessons = [
      ...(projectId === null ? [] : store.list({ projectId, status: 'active' })),
      ...(projectId === null || useGlobal ? store.list({ projectId: null, status: 'active' }) : []),
    ];
    const section = renderSection(lessons, (this.deps.settings?.() ?? DEFAULT_LESSON_SETTINGS).delivery.handoffBytes);
    this.sections.set(key, { at: now, section });
    return section;
  }

  /** Who gets lessons beyond the project's own switches: the budget and chats outside any project */
  delivery(): LessonSettings['delivery'] {
    return (this.deps.settings?.() ?? DEFAULT_LESSON_SETTINGS).delivery;
  }

  /** Drops the cached sections: any lesson change, or a project setting that decides what is handed */
  invalidate(): void {
    this.sections.clear();
  }

  private emit(action: LessonChangeAction, lesson: Pick<Lesson, 'id' | 'projectId'>): void {
    this.invalidate();
    this.deps.emit?.({ type: 'lesson.changed', title: TITLES[action], projectId: lesson.projectId, lessonId: lesson.id, action });
  }

  // ---------- from the miner ----------

  /**
   * What the checked candidates of one run become against the lessons the project has (the table in
   * "Matching, duplicates and contradictions"). A candidate that opens a decision becomes a lesson
   * row `proposed` and a `lesson` memory proposal; the rest touch rows that exist.
   */
  createFromCandidates(candidates: readonly Candidate[], ctx: MiningContext): MiningResult {
    const result: MiningResult = { proposed: 0, merged: 0, appended: 0, dropped: {} };
    const drop = (reason: string): void => void (result.dropped[reason] = (result.dropped[reason] ?? 0) + 1);
    const { store, proposals } = this.deps;
    const source: WorkItemSource | null = ctx.chatId ? { kind: 'chat', chatId: ctx.chatId, orchestrationId: null, taskId: null } : null;
    for (const candidate of candidates) {
      const evidence = candidate.signals.flatMap((id) => {
        const found = ctx.evidence.get(id);
        return found ? [found] : [];
      });
      if (evidence.length === 0) {
        drop('no-signal');
        continue;
      }
      // Listed again each time: an earlier candidate of this run may have changed what is there
      const known = [...store.list({ projectId: ctx.projectId }), ...store.list({ projectId: null })];
      const match = matchCandidate(candidate, known);
      const found = match.lesson;
      const why = `From corrections in chat «${ctx.chatTitle ?? ctx.chatId ?? 'unknown'}»: ${[...new Set(evidence.map((e) => e.signal))].join(', ')}`;
      switch (match.kind) {
        case 'merge':
          if (!found) break;
          store.seen(found.id, evidence);
          this.emit('merged', found);
          result.merged += 1;
          break;
        case 'append':
          if (!found) break;
          store.appendEvidence(found.id, evidence);
          result.appended += 1;
          break;
        case 'duplicate-rejected':
          drop('duplicate-rejected');
          break;
        case 'revive': {
          // A lesson that went to its global copy has nothing to bring back
          if (!found || found.status === 'superseded') break;
          store.appendEvidence(found.id, evidence);
          const waiting = found.proposalId ? proposals.find(found.proposalId) : null;
          if (waiting?.status === 'pending') {
            result.appended += 1;
            break;
          }
          const proposal = proposals.proposeLesson(ctx.projectId, found.id, lessonLine(found.trigger, found.action), `${why}. Brings back ${found.key}.`, source);
          store.setProposal(found.id, proposal.id);
          this.emit('proposed', found);
          result.proposed += 1;
          break;
        }
        default: {
          const lesson = store.insert({
            projectId: ctx.projectId,
            trigger: candidate.trigger,
            action: candidate.action,
            confidence: candidate.confidence,
            mechanical: candidate.mechanical,
            conflictsWithInstructions: candidate.instructions === 'contradicts',
            contradicts: match.kind === 'contradicts' && found ? found.id : null,
            proposedBy: { kind: 'system', role: null },
            evidence,
          });
          const note = match.kind === 'similar' && found ? ` Similar to ${found.key}.` : match.kind === 'contradicts' && found ? ` Contradicts ${found.key}.` : '';
          try {
            const proposal = proposals.proposeLesson(ctx.projectId, lesson.id, lessonLine(lesson.trigger, lesson.action), `${why}.${note}`, source);
            store.setProposal(lesson.id, proposal.id);
          } catch (err) {
            // A lesson nobody can decide would wait for ever
            store.discard(lesson.id);
            throw err;
          }
          this.emit('proposed', lesson);
          result.proposed += 1;
        }
      }
    }
    return result;
  }

  // ---------- approval (called by MemoryProposalService) ----------

  checkApproval(lessonId: string, input: ApproveMemoryProposalRequest): { edit: { trigger: string; action: string } | null } {
    const { store } = this.deps;
    const lesson = store.find(lessonId);
    if (!lesson) throw new WorkItemError('the lesson behind this proposal is gone', 409);
    const choices = input.lesson !== undefined || input.mergeInto !== undefined || input.retire !== undefined || input.keepBoth !== undefined;
    // A proposal that brings a retired lesson back has nothing to choose
    if (lesson.status === 'retired') {
      if (choices) throw new WorkItemError('a lesson that comes back takes no edit, merge or retirement', 400);
      return { edit: null };
    }
    if (lesson.status !== 'proposed') throw new WorkItemError(`the lesson is ${lesson.status}`, 409);
    const edit = input.lesson === undefined ? null : checkLessonText(input.lesson.trigger, input.lesson.action);
    const retire = ids(input.retire, 'retire');
    if (input.mergeInto !== undefined) {
      if (typeof input.mergeInto !== 'string') throw new WorkItemError('mergeInto must be a lesson id', 400);
      if (retire.length > 0 || input.keepBoth) throw new WorkItemError('a lesson folded into another cannot also retire or keep lessons', 400);
      const target = store.find(input.mergeInto);
      if (!target || target.status !== 'active' || target.id === lessonId || (target.projectId !== null && target.projectId !== lesson.projectId)) {
        throw new WorkItemError('the lesson to merge into was not found or is not active', 404);
      }
      return { edit };
    }
    for (const id of retire) {
      const other = store.find(id);
      if (!other || other.status !== 'active' || (other.projectId !== null && other.projectId !== lesson.projectId)) {
        throw new WorkItemError(`lesson ${id} was not found or is not active`, 404);
      }
    }
    if (lesson.contradicts && !retire.includes(lesson.contradicts) && !input.keepBoth) {
      throw new WorkItemError('this lesson contradicts another: retire it or keep both', 409);
    }
    return { edit };
  }

  approveProposed(lessonId: string, input: ApproveMemoryProposalRequest, edit: { trigger: string; action: string } | null, by: WorkItemActor): string {
    const { store } = this.deps;
    const lesson = store.mustFind(lessonId);
    if (lesson.status === 'retired') {
      const back = store.restore(lessonId);
      this.emit('restored', back);
      return back.id;
    }
    if (input.mergeInto) {
      const target = store.merge(lessonId, input.mergeInto);
      this.emit('merged', target);
      return target.id;
    }
    const retire = ids(input.retire, 'retire');
    const approved = store.approve(lessonId, { by, ...(edit ? { edit } : {}), retire });
    const contradicted = lesson.contradicts ? store.find(lesson.contradicts) : null;
    if (contradicted) {
      if (retire.includes(contradicted.id)) store.setLinks(lessonId, { contradicts: null });
      // Kept next to a global lesson, the project's own wins here
      else if (input.keepBoth && contradicted.projectId === null) store.setLinks(lessonId, { overrides: contradicted.id });
    }
    this.emit('approved', approved);
    for (const id of retire) this.emit('retired', { id, projectId: store.find(id)?.projectId ?? null });
    return approved.id;
  }

  rejectProposed(lessonId: string, by: WorkItemActor): void {
    const lesson = this.deps.store.find(lessonId);
    // A lesson that existed before (one a proposal brings back) is not the thing refused
    if (!lesson || lesson.status !== 'proposed') return;
    this.deps.store.reject(lessonId, by);
    this.emit('rejected', lesson);
  }

  retireForInstructions(lessonId: string, by: WorkItemActor): boolean {
    try {
      const lesson = this.deps.store.retire(lessonId, 'instructions', by);
      this.emit('retired', lesson);
      return true;
    } catch (err) {
      if (err instanceof WorkItemError) return false;
      throw err;
    }
  }

  reinstate(lessonId: string): void {
    this.deps.store.reactivate(lessonId);
    const lesson = this.deps.store.find(lessonId);
    if (lesson) this.emit('restored', lesson);
  }

  // ---------- the person's own operations ----------

  /** Edit the words, pin, or both; active lessons only */
  update(lessonId: string, request: UpdateLessonRequest): Lesson {
    const { store } = this.deps;
    const body = request as Partial<UpdateLessonRequest> | undefined;
    const wording = body?.trigger !== undefined || body?.action !== undefined;
    if (!wording && body?.pinned === undefined) throw new WorkItemError('nothing to change', 400);
    if (body?.pinned !== undefined && typeof body.pinned !== 'boolean') throw new WorkItemError('pinned must be true or false', 400);
    const current = store.mustFind(lessonId);
    if (current.status !== 'active') throw new WorkItemError(`the lesson is ${current.status}`, 409);
    const words = wording ? checkLessonText(body?.trigger ?? current.trigger, body?.action ?? current.action) : null;
    if (words) {
      store.edit(lessonId, words);
      this.emit('edited', current);
    }
    if (typeof body?.pinned === 'boolean') {
      store.pin(lessonId, body.pinned);
      this.emit('pinned', current);
    }
    return this.get(lessonId);
  }

  confirm(lessonId: string): Lesson {
    const lesson = this.deps.store.confirm(lessonId);
    this.emit('confirmed', lesson);
    return this.read(lesson);
  }

  retire(lessonId: string, by: WorkItemActor = PERSON): Lesson {
    const lesson = this.deps.store.retire(lessonId, 'person', by);
    this.emit('retired', lesson);
    return this.read(lesson);
  }

  restore(lessonId: string): Lesson {
    const lesson = this.deps.store.restore(lessonId);
    this.emit('restored', lesson);
    return this.read(lesson);
  }

  delete(lessonId: string): void {
    const lesson = this.deps.store.mustFind(lessonId);
    this.deps.store.delete(lessonId);
    this.emit('deleted', lesson);
  }

  /** An active project lesson becomes a global one; answers the global lesson */
  promote(lessonId: string, by: WorkItemActor = PERSON): Lesson {
    const { global, origin } = this.deps.store.promote(lessonId, by);
    this.invalidate();
    this.deps.emit?.({ type: 'lesson.changed', title: TITLES.promoted, projectId: origin.projectId, lessonId: global.id, action: 'promoted' });
    return this.read(global);
  }

  /** A global lesson goes back to the project it came from, or to `projectId` when it has no origin */
  /**
   * Proposes the lesson for `CLAUDE.md`: an `instructions` proposal the person approves in the
   * Proposals card, after its diff. One at a time per lesson; approving it retires the lesson.
   */
  toInstructions(lessonId: string, section?: string): MemoryProposal {
    const lesson = this.deps.store.find(lessonId);
    if (!lesson) throw new WorkItemError('lesson not found', 404);
    if (lesson.status !== 'active') throw new WorkItemError('only an active lesson can be moved into CLAUDE.md', 409);
    if (lesson.projectId === null) throw new WorkItemError('a global lesson has no project CLAUDE.md: demote it to a project first', 400);
    if (section !== undefined && typeof section !== 'string') throw new WorkItemError('section must be text', 400);
    if (this.deps.proposals.pendingInstructionsFor(lessonId)) throw new WorkItemError('this lesson already has a proposal for CLAUDE.md waiting', 409);
    const proposal = this.deps.proposals.propose(
      lesson.projectId,
      {
        target: { kind: 'instructions', file: null, section: section?.trim() || 'Lessons' },
        text: `- ${lessonLine(lesson.trigger, lesson.action)}`,
        reason: 'A lesson the person moved into CLAUDE.md',
      },
      { proposedBy: PERSON, lessonId },
    );
    // The same text decided before is answered as it was, not proposed again
    if (proposal.status !== 'pending' || proposal.lessonId !== lessonId) throw new WorkItemError(`this text was already proposed for CLAUDE.md (${proposal.status})`, 409);
    return proposal;
  }

  demote(lessonId: string, projectId?: string, by: WorkItemActor = PERSON): Lesson {
    const lesson = this.deps.store.demote(lessonId, projectId, by);
    this.emit('demoted', lesson);
    return this.read(lesson);
  }

  // ---------- decay ----------

  /** Retires what decayed below `retireBelow`; a confirmation that lands in between wins */
  sweep(): Lesson[] {
    const retired = this.deps.store.sweep();
    for (const lesson of retired) this.emit('retired', lesson);
    return retired;
  }

  /** Sweeps now, and every hour after */
  start(): void {
    if (this.timer) return;
    const run = (): void => {
      try {
        this.sweep();
      } catch {
        // A locked database is tried again in an hour; decay is computed on read either way
      }
    };
    run();
    this.timer = setInterval(run, SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
