import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Core } from '@claudio/core';
import type { AuditFilter, ClaimHostResult, SetAuthTokenRequest, UpdateAuthConfigRequest } from '@claudio/shared';
import { LOOPBACK, hostNameOf, isOwnerActor } from '../security.ts';
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

  // Exempt from the host check (it adds the host the request came in on), so everything else is
  // checked here: a mode that has credentials, and an owner among them
  app.post('/security/allowed-hosts/claim', async (req, reply): Promise<ClaimHostResult | FastifyReply> => {
    const fail = (status: number, code: string, error: string) => reply.status(status).send({ error, code });
    if (core.security.mode === 'none') return fail(403, 'host.needs-auth', 'protect access with a token before adding a host from here');
    if (!isOwnerActor(req.actor)) return fail(403, 'host.not-owner', "only the owner's token can add an allowed host");
    const host = req.headers.host === undefined ? '' : hostNameOf(req.headers.host);
    if (!host) return fail(400, 'host.invalid', 'the request names no host');
    const { allowedHostLayers: layers } = core.appSettings.get();
    // Loopback and a host already answered need nothing: the answer is the same list
    if (!LOOPBACK.test(host) && !layers.file.includes(host) && !layers.env.includes(host)) {
      try {
        await core.appSettings.update({ allowedHosts: [...layers.file, host] });
      } catch (error) {
        return fail(400, 'host.invalid', error instanceof Error ? error.message : String(error));
      }
    }
    return { host, allowedHosts: [...core.appSettings.allowedHosts] };
  });

  // The log and the ring of anonymous refusals answer the same query the same way
  const page = (query: AuditFilter & { limit?: string; from?: string }) => {
    // Checked here: the store clamps a number but has nothing to say about `limit=soon`, which
    // would reach SQLite as NaN and come back as the engine complaining about a datatype
    const limit = count(query.limit, 'limit');
    const from = count(query.from, 'from');
    return {
      ...(limit !== undefined ? { limit } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(query.path ? { path: query.path } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
  };
  app.get<{ Querystring: AuditFilter & { limit?: string; from?: string } }>('/audit', (req) => core.db.auditPage(page(req.query)));
  app.get<{ Querystring: AuditFilter & { limit?: string; from?: string } }>('/audit/refusals', (req) => core.db.auditRefusalsPage(page(req.query)));
};
