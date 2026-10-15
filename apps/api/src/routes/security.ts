import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import type { AuditFilter, SetAuthTokenRequest, UpdateAuthConfigRequest } from '@claudio/shared';
import { revokeTerminalAccess } from '../terminal-socket.ts';
import { count } from './chats.ts';

/**
 * The guard's own configuration, and the trail it leaves. The token is never returned here: it
 * exists once, in the answer to `POST /security/token`, and only its hash is kept.
 */
export const securityRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/security/auth', () => core.security.config);
  app.put<{ Body: UpdateAuthConfigRequest }>('/security/auth', async (req) => {
    const before = JSON.stringify(core.security.config);
    const config = await core.security.update(req.body ?? {});
    // A shell is the largest change there is: read-only closes every one, and refuses new ones (the gate)
    if (config.readOnly) await core.terminals.closeAll('read-only');
    // A terminal socket was let in under the old rules: it reconnects through the gate as it is now
    if (JSON.stringify(config) !== before) revokeTerminalAccess(core);
    return config;
  });
  // A new or cleared token is how the owner shuts out one that leaked, sockets it opened included
  app.post<{ Body: SetAuthTokenRequest }>('/security/token', async (req) => {
    const result = await core.security.setToken(req.body ?? {});
    revokeTerminalAccess(core);
    return result;
  });
  app.delete('/security/token', async () => {
    const config = await core.security.clearToken();
    revokeTerminalAccess(core);
    return config;
  });

  app.get<{ Querystring: AuditFilter & { limit?: string; from?: string } }>('/audit', (req) => {
    // Checked here: the store clamps a number but has nothing to say about `limit=soon`, which
    // would reach SQLite as NaN and come back as the engine complaining about a datatype
    const limit = count(req.query.limit, 'limit');
    const from = count(req.query.from, 'from');
    return core.db.auditPage({
      ...(limit !== undefined ? { limit } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(req.query.path ? { path: req.query.path } : {}),
      ...(req.query.method ? { method: req.query.method } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
    });
  });
};
