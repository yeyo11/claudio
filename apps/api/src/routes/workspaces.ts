import { PassThrough, Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { WorkspaceRefusal, type Core } from '@claudio/core';
import type { CreateWorkspaceRequest } from '@claudio/shared';

const GZIP = 'application/gzip';

export const workspaceRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const limit = core.workspaces.settings.maxCompressedBytes;
  // The archive is the body, handed on as a stream: never held whole in memory, counted against the
  // compressed cap as it comes. A parser of this plugin's own, so no other route takes gzip
  app.addContentTypeParser(GZIP, { bodyLimit: limit }, (_req, payload, done) => done(null, payload));

  app.post<{ Body: CreateWorkspaceRequest | Readable }>('/workspaces', async (req, reply) => {
    if (req.body instanceof Readable) {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        throw new WorkspaceRefusal('workspace-too-large', `the archive is larger than ${String(Math.floor(limit / (1024 * 1024)))} MB compressed`);
      }
      // Through a pass-through, so a refusal mid-way ends the extraction without destroying the
      // request's socket: the answer still reaches the client, and Node drops the rest of the body
      const body = new PassThrough();
      req.body.pipe(body);
      return reply.status(201).send(await core.workspaces.create({ kind: 'upload', body }));
    }
    const url = (req.body as Partial<CreateWorkspaceRequest> | undefined)?.url;
    if (typeof url !== 'string' || url.trim() === '') {
      throw Object.assign(new Error(`send { "url": "https://…" } as JSON, or the archive itself with Content-Type: ${GZIP}`), { statusCode: 400 });
    }
    return reply.status(201).send(await core.workspaces.create({ kind: 'url', url: url.trim() }));
  });

  app.get<{ Params: { id: string } }>('/workspaces/:id', (req) => core.workspaces.get(req.params.id));

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    await core.workspaces.remove(req.params.id);
    return reply.status(204).send();
  });
};
