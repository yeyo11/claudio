import type { FastifyPluginAsync } from 'fastify';
import { ServersError, type Core } from '@claudio/core';
import type { ClaudioServer, RemoveServerResult, ServersSettings, ServerTestResult } from '@claudio/shared';
import type { Guard } from '../security.ts';
import { gatewayRoutes } from './servers-gateway.ts';

/**
 * The hub side of Servers (docs/plans/claudio-servers.md, §4.2 and §9.2): the switch, the list and
 * its changes, a connection test, the selection, and the gateway the web drives a remote through.
 * Every route is the person's; core refuses with a `ServersError`, which the error handler answers
 * with its status and `code`.
 */
export const serverRoutes: FastifyPluginAsync<{ core: Core; guard: Guard }> = async (app, { core, guard }) => {
  // A remote that failed is a 502 the person acts on by its `code` (`servers.revoke-failed`,
  // `servers.fingerprint-mismatch`), which the app's handler keeps only below 500. Anything else is
  // the app's to answer, so it is thrown on to it
  app.setErrorHandler((error, _req, reply) => {
    if (!(error instanceof ServersError)) throw error;
    return reply.status(error.statusCode).send({ ...error.details, error: error.message, code: error.reason });
  });

  app.get('/servers/settings', (): ServersSettings => core.servers.settings());
  app.put<{ Body: unknown }>('/servers/settings', (req): Promise<ServersSettings> => core.servers.updateSettings(req.body));

  // An empty list while the feature is off, so the page has nothing to explain away (§9.2)
  app.get('/servers', (): ClaudioServer[] => core.servers.list());
  app.post<{ Body: unknown }>('/servers', async (req, reply) => reply.status(201).send(await core.servers.add(req.body)));
  app.patch<{ Params: { id: string }; Body: unknown }>('/servers/:id', (req): Promise<ClaudioServer> => core.servers.update(req.params.id, req.body));
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/servers/:id',
    (req): Promise<RemoveServerResult> => core.servers.remove(req.params.id, { force: req.query.force === 'true' || req.query.force === '1' }),
  );
  app.post<{ Params: { id: string } }>('/servers/:id/test', (req): Promise<ServerTestResult> => core.servers.test(req.params.id));
  app.post<{ Params: { id: string } }>('/servers/:id/use', (req): Promise<ClaudioServer> => core.servers.use(req.params.id));

  await app.register(gatewayRoutes, { core, guard });
};
