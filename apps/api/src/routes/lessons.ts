import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import { WorkItemError } from '@claudio/core';
import { LESSON_STATUSES } from '@claudio/shared';
import type {
  DemoteLessonRequest,
  Lesson,
  LessonInstructionsRequest,
  LessonSettings,
  LessonStatus,
  PreviewMemoryProposalRequest,
  RetireLessonRequest,
  UpdateLessonRequest,
} from '@claudio/shared';

const DEFAULT_JOBS = 20;
const MAX_JOBS = 100;

// A missing body reaches core as an empty object, so its own validation names the field that is missing
const bodyOf = <T>(body: T | undefined): T => (body ?? {}) as T;

/** `active` by default; `all` is every status */
function statusOf(raw: string | undefined): LessonStatus | 'all' {
  if (raw === undefined || raw === '') return 'active';
  if (raw === 'all' || (LESSON_STATUSES as readonly string[]).includes(raw)) return raw as LessonStatus | 'all';
  throw new WorkItemError(`status must be one of ${[...LESSON_STATUSES, 'all'].join(', ')}`, 400);
}

/**
 * Lessons mined from a person's corrections (docs/plans/lessons.md, "API"). A read needs the project
 * imported; a change needs its Memory module on too. Nothing here writes a lesson in from outside
 * (export only), and a chat's token reaches none of the routes that decide, change or mine one:
 * `CHAT_FORBIDDEN_LESSONS` in `security.ts`.
 */
export const lessonRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  /** The lesson, after the access check for its project (a global lesson has none) */
  const writable = async (lessonId: string, projectId?: string | null): Promise<Lesson> => {
    const lesson = core.lessons.get(lessonId);
    const owner = lesson.projectId ?? projectId ?? null;
    if (owner) await core.memoryProject(owner, 'write');
    return lesson;
  };

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/projects/:id/lessons', async (req) => {
    const status = statusOf(req.query.status);
    await core.memoryProject(req.params.id, 'read');
    return core.lessonList(req.params.id, status === 'all' ? undefined : status);
  });

  app.get<{ Params: { id: string } }>('/projects/:id/lessons/export', async (req, reply) => {
    await core.memoryProject(req.params.id, 'read');
    void reply.header('Content-Disposition', `attachment; filename="lessons-${req.params.id}.json"`);
    return core.lessons.export(req.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/projects/:id/lessons/jobs', async (req) => {
    let limit = DEFAULT_JOBS;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new WorkItemError('limit must be a whole number from 1', 400);
    }
    await core.memoryProject(req.params.id, 'read');
    return core.lessonQueue.jobs(req.params.id, Math.min(limit, MAX_JOBS));
  });

  app.get<{ Querystring: { status?: string } }>('/lessons/global', (req) => {
    const status = statusOf(req.query.status);
    return core.lessonList(null, status === 'all' ? undefined : status);
  });

  app.get('/lessons/settings', () => core.lessonSettings.get());

  app.put<{ Body: Partial<LessonSettings> }>('/lessons/settings', (req) => core.lessonSettings.update(bodyOf(req.body)));

  app.get<{ Params: { lessonId: string } }>('/lessons/:lessonId', async (req) => {
    const lesson = core.lessons.get(req.params.lessonId);
    if (lesson.projectId) await core.memoryProject(lesson.projectId, 'read');
    return lesson;
  });

  app.patch<{ Params: { lessonId: string }; Body: UpdateLessonRequest }>('/lessons/:lessonId', async (req) => {
    await writable(req.params.lessonId);
    return core.lessons.update(req.params.lessonId, bodyOf(req.body));
  });

  app.post<{ Params: { lessonId: string } }>('/lessons/:lessonId/confirm', async (req) => {
    await writable(req.params.lessonId);
    return core.lessons.confirm(req.params.lessonId);
  });

  app.post<{ Params: { lessonId: string }; Body: RetireLessonRequest }>('/lessons/:lessonId/retire', async (req) => {
    await writable(req.params.lessonId);
    return core.lessons.retire(req.params.lessonId);
  });

  app.post<{ Params: { lessonId: string } }>('/lessons/:lessonId/restore', async (req) => {
    await writable(req.params.lessonId);
    return core.lessons.restore(req.params.lessonId);
  });

  app.delete<{ Params: { lessonId: string } }>('/lessons/:lessonId', async (req) => {
    await writable(req.params.lessonId);
    core.lessons.delete(req.params.lessonId);
    return { ok: true };
  });

  app.post<{ Params: { lessonId: string } }>('/lessons/:lessonId/promote', async (req) => {
    await writable(req.params.lessonId);
    return core.lessons.promote(req.params.lessonId);
  });

  app.post<{ Params: { lessonId: string }; Body: DemoteLessonRequest }>('/lessons/:lessonId/demote', async (req) => {
    const projectId: unknown = bodyOf(req.body).projectId;
    if (projectId !== undefined && typeof projectId !== 'string') throw new WorkItemError('projectId must be the id of a project', 400);
    await writable(req.params.lessonId, projectId);
    return core.lessons.demote(req.params.lessonId, projectId);
  });

  app.post<{ Params: { lessonId: string }; Body: LessonInstructionsRequest }>('/lessons/:lessonId/instructions', async (req, reply) => {
    await writable(req.params.lessonId);
    const section: unknown = bodyOf(req.body).section;
    if (section !== undefined && section !== null && typeof section !== 'string') throw new WorkItemError('section must be text', 400);
    return reply.status(201).send(core.lessons.toInstructions(req.params.lessonId, section ?? undefined));
  });

  app.post<{ Params: { proposalId: string }; Body: PreviewMemoryProposalRequest }>('/memory-proposals/:proposalId/preview', async (req) => {
    const proposal = core.memoryProposals.find(req.params.proposalId);
    if (!proposal) throw new WorkItemError('memory proposal not found', 404);
    try {
      await core.memoryProject(proposal.projectId, 'read');
    } catch (err) {
      // The proposal outlived its project: there is no CLAUDE.md to read it against
      if (err instanceof WorkItemError && err.statusCode === 404) throw new WorkItemError("the proposal's project is not imported", 409);
      throw err;
    }
    return core.memoryProposals.preview(proposal.id, bodyOf(req.body));
  });

  app.post<{ Params: { id: string } }>('/chats/:id/lessons/mine', async (req, reply) => reply.status(202).send(await core.lessonQueue.mineByHand(req.params.id)));
};
