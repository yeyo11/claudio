import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';

/** The claude.ai connectors the CLI reports. Authorising one hands back the CLI's sign-in link for the person's browser. */
export const connectorRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Querystring: { refresh?: string } }>('/connectors', (req) => core.connectors.overview(req.query.refresh === 'true'));
  // The link is a credential-bearing page: it goes to the caller only, and is never logged
  app.post<{ Params: { id: string } }>('/connectors/:id/authorise', (req) => core.connectors.authorise(req.params.id));
};
