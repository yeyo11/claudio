import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CliInstallRefusal, DESKTOP_ACTOR, ServerUpdateRefusal, type Core } from '@claudio/core';
import type { ServerUpdateApplyRequest, ServerUpdateRefusalCode } from '@claudio/shared';
import { isOwnerActor } from '../security.ts';

/**
 * The desktop shell, making a payload update with its per-launch secret where it supervises the
 * server (docs/plans/unified-updates.md, D8). The guard only lets that actor through to the four
 * update writes under `CLAUDIO_LAUNCHER=desktop`; this checks the same twice, so neither alone opens it.
 */
const fromShell = (core: Core, req: FastifyRequest): boolean => req.actor === DESKTOP_ACTOR && core.serverUpdates.desktopHost;

/** The owner check every route here makes, in the shape `ApiRequestError` reads; true when it answered */
export function refuseNonOwner(core: Core, req: FastifyRequest, reply: FastifyReply, scope: 'update' | 'cli'): boolean {
  // The shell first: under auth `none` it is the only caller an update write accepts
  if (scope === 'update' && fromShell(core, req)) return false;
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
  if (err instanceof ServerUpdateRefusal) {
    const code: ServerUpdateRefusalCode = err.reason;
    return reply.status(err.statusCode).send({ error: err.message, code, ...(err.live ? { live: err.live } : {}) });
  }
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
 * Claudio updating its payload, in its container or under the desktop shell
 * (docs/plans/container-polish.md, D4; docs/plans/unified-updates.md). Reading the state is open to
 * whoever reads the API; every change is the owner's or the desktop shell's, and the read-only gate
 * refuses them before they get here.
 */
export const serverUpdateRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const updates = core.serverUpdates;

  app.get('/system/server-update', (req) => updates.status(fromShell(core, req)));

  app.post<{ Body: { version?: string } }>('/system/server-update/download', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    try {
      return await reply.status(202).send(await updates.download(versionOf(req.body), fromShell(core, req)));
    } catch (err) {
      return sendRefusal(reply, err);
    }
  });

  app.post<{ Body: ServerUpdateApplyRequest }>('/system/server-update/apply', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    try {
      return await reply.status(202).send(await updates.apply(applyBody(req.body), fromShell(core, req)));
    } catch (err) {
      return sendRefusal(reply, err);
    }
  });

  app.delete('/system/server-update/scheduled', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    return updates.cancelScheduled(fromShell(core, req));
  });

  app.post<{ Body: ServerUpdateApplyRequest }>('/system/server-update/revert', async (req, reply) => {
    if (refuseNonOwner(core, req, reply, 'update')) return reply;
    try {
      return await reply.status(202).send(await updates.revert(applyBody(req.body), fromShell(core, req)));
    } catch (err) {
      return sendRefusal(reply, err);
    }
  });
};
