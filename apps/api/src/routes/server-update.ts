import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CliInstallRefusal, ServerUpdateRefusal, type Core } from '@claudio/core';
import type { ServerUpdateApplyRequest } from '@claudio/shared';
import { isOwnerActor } from '../security.ts';

/** The owner check every route here makes, in the shape `ApiRequestError` reads; true when it answered */
export function refuseNonOwner(core: Core, req: FastifyRequest, reply: FastifyReply, scope: 'update' | 'cli'): boolean {
  if (core.security.mode === 'none') {
    void reply.status(403).send({ error: `${scope === 'update' ? 'updating Claudio' : 'installing Claude Code'} from here needs access protected by a token`, code: `${scope}.needs-auth` });
    return true;
  }
  if (isOwnerActor(req.actor)) return false;
  void reply.status(403).send({ error: 'only the owner may do this', code: `${scope}.not-owner` });
  return true;
}

/** A refusal of the manager or the installer as `{ error, code }`, with the live counts for `update.live-work` */
export function sendRefusal(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ServerUpdateRefusal) return reply.status(err.statusCode).send({ error: err.message, code: err.reason, ...(err.live ? { live: err.live } : {}) });
  if (err instanceof CliInstallRefusal) return reply.status(err.statusCode).send({ error: err.message, code: err.reason });
  throw err;
}

const applyBody = (body: unknown): ServerUpdateApplyRequest => {
  const { force, whenIdle } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return { force: force === true, whenIdle: whenIdle === true };
};

const versionOf = (body: unknown): string | undefined => {
  const version = body && typeof body === 'object' ? (body as { version?: unknown }).version : undefined;
  if (version === undefined || version === null) return undefined;
  if (typeof version !== 'string') throw new Error('version must be a string');
  return version;
};

/**
 * Claudio updating itself inside its container (docs/plans/container-polish.md, D4). Reading the
 * state is open to whoever reads the API; every change is the owner's, and the read-only gate
 * refuses them before they get here.
 */
export const serverUpdateRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const updates = core.serverUpdates;

  app.get('/system/server-update', () => updates.status());

  app.post<{ Body: { version?: string } }>('/system/server-update/download', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    try {
      return await reply.status(202).send(await updates.download(versionOf(req.body)));
    } catch (err) {
      return sendRefusal(reply, err);
    }
  });

  app.post<{ Body: ServerUpdateApplyRequest }>('/system/server-update/apply', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    try {
      return await reply.status(202).send(await updates.apply(applyBody(req.body)));
    } catch (err) {
      return sendRefusal(reply, err);
    }
  });

  app.delete('/system/server-update/scheduled', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    return updates.cancelScheduled();
  });

  app.post<{ Body: ServerUpdateApplyRequest }>('/system/server-update/revert', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    try {
      return await reply.status(202).send(await updates.revert(applyBody(req.body)));
    } catch (err) {
      return sendRefusal(reply, err);
    }
  });
};
