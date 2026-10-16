import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import { projectExportFilename, REVIEW_ROLES, type ReviewRole, projectToJson, projectToMarkdown, WebhooksError, WorkItemError } from '@claudio/core';
import { refuseWeakerProjectSettings } from './guards.ts';
import type { CreateProjectRequest, ImportProjectRequest, ProjectTrackerSettings, TrackerImportRequest, TrackerImportResult, TrackerIssuesPage, UpdateProjectRequest, ProjectWebhooks, WebhookRegistration } from '@claudio/shared';

/** The directories the person imported. Nothing here discovers a project: it is added by hand. */
export const projectRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/projects', () => core.projects());

  // What a first start offers instead of an empty screen. Registered before `/projects/:id`, which
  // would otherwise take "candidates" for an id.
  app.get('/projects/candidates', () => core.projectCandidates());

  // Also before `/projects/:id`, for the same reason
  app.get('/projects/templates', () => core.projectTemplates());

  app.post<{ Body: ImportProjectRequest }>('/projects/import', async (req, reply) =>
    reply.status(201).send(await core.importProject({ ...req.body, path: req.body?.path ?? '' })),
  );

  // A new directory in the workspace, imported straight away: creating a project means wanting it.
  app.post<{ Body: CreateProjectRequest }>('/projects', async (req, reply) =>
    reply.status(201).send(await core.createProject({ ...req.body, name: req.body?.name ?? '' })),
  );

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>('/projects/:id', (req) => core.updateProject(req.params.id, req.body ?? {}));

  // Which text each reviewer of the review gate runs with: the project's own file or Claudio's built-in
  app.get<{ Params: { id: string } }>('/projects/:id/review-roles', async (req) => {
    const roles = await core.reviewRoles(req.params.id);
    if (!roles) throw Object.assign(new Error(`project ${req.params.id} not found`), { statusCode: 404 });
    return roles;
  });

  // Writes Claudio's default where no file exists, never over one; a chat's token is refused in security.ts
  app.post<{ Params: { id: string; role: string } }>('/projects/:id/review-roles/:role', async (req, reply) => {
    const role = REVIEW_ROLES.find((r) => r === req.params.role);
    if (!role) throw Object.assign(new Error(`unknown review role ${req.params.role}`), { statusCode: 404 });
    const written = await core.writeReviewRole(req.params.id, role as ReviewRole);
    if (!written) throw Object.assign(new Error(`project ${req.params.id} not found`), { statusCode: 404 });
    if (!written.written) throw Object.assign(new Error(`${written.file} exists already: Claudio never overwrites it`), { statusCode: 409, reason: 'role-exists' });
    const info = (await core.reviewRoles(req.params.id))?.find((r) => r.role === role);
    return reply.status(201).send(info);
  });

  app.get<{ Params: { id: string } }>('/projects/:id/settings', (req) => core.projectSettings(req.params.id));

  // Whether the project can open pull and merge requests, and where `origin` points
  app.get<{ Params: { id: string } }>('/projects/:id/code-host', async (req) => {
    const host = await core.projectCodeHost(req.params.id);
    if (!host) throw Object.assign(new Error(`project ${req.params.id} not found`), { statusCode: 404 });
    return host;
  });

  // Validated in core, whole: a document is replaced, never merged
  // Three parts are not a chat's to save, so its copy of the document keeps the stored ones:
  // - the tracker: its scope, query and status map decide what is imported and written to it;
  // - the providers: their order and what happens at a limit decide which vendor the work spends on;
  // - the lessons: whether approved lessons reach chats, workers and other projects is the person's call.
  app.put<{ Params: { id: string }; Body: unknown }>('/projects/:id/settings', async (req) => {
    const body = req.body;
    // A chat may tighten its project's guards but never loosen them
    await refuseWeakerProjectSettings(core, req, req.params.id, body);
    if (req.actor?.startsWith('chat:') && typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const { tracker: _tracker, providers: _providers, lessons: _lessons, ...rest } = body as Record<string, unknown>;
      const { tracker, providers, lessons } = await core.projectSettings(req.params.id);
      return core.saveProjectSettings(req.params.id, { ...rest, ...(tracker ? { tracker } : {}), ...(providers ? { providers } : {}), ...(lessons ? { lessons } : {}) });
    }
    return core.saveProjectSettings(req.params.id, body);
  });

  // A project's tracker lives in its settings document; null when it has none
  app.get<{ Params: { id: string } }>('/projects/:id/tracker', async (req): Promise<ProjectTrackerSettings | null> => (await core.projectSettings(req.params.id)).tracker ?? null);

  // Validated with the whole document, where the tracker is checked; a null body clears it. Only the
  // tracker changes: the rest is written back as it was read
  app.put<{ Params: { id: string }; Body: ProjectTrackerSettings | null }>('/projects/:id/tracker', async (req): Promise<ProjectTrackerSettings | null> => {
    const { tracker: _before, ...rest } = await core.projectSettings(req.params.id);
    const body = req.body ?? null;
    const saved = await core.saveProjectSettings(req.params.id, body === null ? rest : { ...rest, tracker: body });
    return saved.tracker ?? null;
  });

  // The tracker's own query, one page; readable with the Board module off, as the board is
  app.get<{ Params: { id: string }; Querystring: { query?: string; page?: string } }>('/projects/:id/tracker/issues', async (req): Promise<TrackerIssuesPage> => {
    await core.workItemProject(req.params.id, 'read');
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isInteger(page) || page < 1) throw new WorkItemError('page must be a whole number from 1', 400);
    return core.trackerImport.list(req.params.id, req.query.query === undefined || req.query.query === '' ? null : req.query.query, page);
  });

  app.post<{ Params: { id: string }; Body: TrackerImportRequest }>('/projects/:id/tracker/import', async (req): Promise<TrackerImportResult> => {
    await core.workItemProject(req.params.id, 'write');
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) throw new WorkItemError('keys must be a list of issue keys', 400);
    return core.trackerImport.importIssues(req.params.id, keys);
  });

  // Streamed a chat at a time: a project can hold hundreds of chats, and a transcript alone can run
  // to tens of megabytes
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/projects/:id/export', async (req, reply) => {
    const format = req.query.format ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') throw new Error('format must be markdown or json');
    const source = await core.projectExport(req.params.id);
    void reply.header('content-disposition', `attachment; filename="${projectExportFilename(source.project, format)}"`);
    if (format === 'json') return reply.type('application/json; charset=utf-8').send(Readable.from(projectToJson(source)));
    return reply.type('text/markdown; charset=utf-8').send(Readable.from(projectToMarkdown(source)));
  });

  // The hooks Claudio keeps on the project's repository (GitHub only for now). The secret that signs
  // their deliveries never leaves the server. The writes are the person's click: a chat's token
  // gets 403 in `security.ts`.
  const webhook = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof WebhooksError)) throw err;
      // `expose` lets a 502 keep its sentence; `reason` is the code a client words
      throw Object.assign(new Error(err.message), { statusCode: err.status, reason: err.code, expose: true, ...(err.detail ? { detail: err.detail } : {}) });
    }
  };
  app.get<{ Params: { id: string } }>('/projects/:id/webhooks', (req): Promise<ProjectWebhooks> => webhook(() => core.webhookService.overview(req.params.id)));
  app.post<{ Params: { id: string } }>('/projects/:id/webhooks', async (req, reply): Promise<WebhookRegistration> => {
    const registration = await webhook(() => core.webhookService.register(req.params.id));
    return reply.status(201).send(registration);
  });
  app.post<{ Params: { id: string; registrationId: string } }>('/projects/:id/webhooks/:registrationId/test', (req): Promise<WebhookRegistration> =>
    webhook(() => core.webhookService.test(req.params.id, req.params.registrationId)),
  );
  app.delete<{ Params: { id: string; registrationId: string } }>('/projects/:id/webhooks/:registrationId', (req): Promise<WebhookRegistration> =>
    webhook(() => core.webhookService.remove(req.params.id, req.params.registrationId)),
  );

  // Harmless: Claudio forgets the directory and leaves everything else where it is
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req) => {
    await core.removeProject(req.params.id);
    return { ok: true };
  });

  // Everything Claude Code keeps about a project: transcripts, tasks, file history, config entry.
  // The CLI owns that layout, so `claude project purge` does the deleting. Irreversible.
  app.delete<{ Params: { id: string } }>('/projects/:id/state', (req) => core.purgeProject(req.params.id));
};
