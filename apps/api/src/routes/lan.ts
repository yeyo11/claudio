import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';

/**
 * The listener on the local network (docs/plans/lan-access.md). Every route is the person's
 * (`access: 'person'` in the route docs). A refusal (auth off, the deploy turned it off, a value
 * the environment fixes) is a `409` with its code, from the listener.
 */
export const lanRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // The interfaces and the `.local` name are read again, so a new address shows without a restart
  app.get('/lan', () => core.lan.refresh());

  app.put<{ Body: unknown }>('/lan/settings', (req) => core.lan.updateSettings(req.body));

  app.post('/lan/start', () => core.lan.start());

  // A stop asked for from a device on the network gets its answer before its connection ends
  app.post('/lan/stop', () => core.lan.stop());
};
