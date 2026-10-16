import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import { spendGate } from './spend.ts';
import { claudioLanguage, type AddProjectDocRequest, type ChatSummary, type ProjectDoc, type ProjectDocsOverview } from '@claudio/shared';

/**
 * A project's Claude Docs: a registry of ids and links, read, created and refreshed through a
 * confined `claude` session that has the Docs connector. Validation and the statuses live in core.
 * Writes are the person's: a chat's token is refused in `security.ts`.
 */
export const projectDocsRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/docs', (req): ProjectDocsOverview => {
    core.assertProjectDocsProject(req.params.id);
    return core.projectDocs.overview(req.params.id);
  });

  // Registered before `/projects/:id/docs/:docId` routes so "refresh" is never taken for a document id
  app.post<{ Params: { id: string } }>('/projects/:id/docs/refresh', (req): Promise<ProjectDocsOverview> => {
    core.assertProjectDocsProject(req.params.id);
    return core.projectDocs.refresh(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: AddProjectDocRequest }>('/projects/:id/docs', async (req, reply): Promise<ProjectDoc> => {
    core.assertProjectDocsProject(req.params.id);
    const doc = await core.projectDocs.add(req.params.id, req.body ?? {}, claudioLanguage(req.headers['accept-language']));
    return reply.status(201).send(doc);
  });

  app.delete<{ Params: { id: string; docId: string } }>('/projects/:id/docs/:docId', async (req, reply) => {
    core.assertProjectDocsProject(req.params.id);
    await core.projectDocs.remove(req.params.id, req.params.docId);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string; docId: string } }>('/projects/:id/docs/:docId/ask', { preHandler: spendGate(core) }, async (req, reply): Promise<ChatSummary> =>
    reply.status(201).send(await core.askAboutProjectDoc(req.params.id, req.params.docId, claudioLanguage(req.headers['accept-language']))),
  );
};
