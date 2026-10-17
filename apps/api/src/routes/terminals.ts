import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import { TerminalError, type Core } from '@claudio/core';
import type { CreateTerminalRequest, UpdateTerminalSettingsRequest } from '@claudio/shared';
import type { Guard } from '../security.ts';
import { clientOf, clientRefusal, recordGateRefusal, terminalGate, type GateRefusal } from '../terminal-gate.ts';
import { TerminalTickets, originAllowed, terminalSocketRoute } from '../terminal-socket.ts';
import { count } from './chats.ts';

const send = (reply: FastifyReply, refusal: GateRefusal): FastifyReply =>
  reply.status(refusal.status).send({ error: refusal.error, code: `terminal.${refusal.reason ?? 'refused'}`, ...(refusal.reason ? { reason: refusal.reason } : {}) });

/**
 * The person's own shell. Every route here passes the gate first (`terminal-gate.ts`): the feature
 * on, read-only off, a caller that is not a chat's or the desktop app's, and from this machine or,
 * with a token, as `remote` allows. The status and the settings are the two that answer while the
 * feature is off, because they are how it is turned on and how the person learns why it is not.
 *
 * Nothing here writes into a terminal, and nothing reads what one prints: the socket relays bytes
 * between the person's browser and their shell (`terminal-socket.ts`).
 */
export const terminalRoutes: FastifyPluginAsync<{ core: Core; guard: Guard; tickets?: TerminalTickets }> = async (app, { core, guard, tickets = new TerminalTickets() }) => {
  /** Service refusals are `TerminalError`s with a status of their own; anything else is a bug and goes on */
  const handle =
    <Route extends RouteGenericInterface>(run: (req: FastifyRequest<Route>, reply: FastifyReply) => unknown) =>
    async (req: FastifyRequest<Route>, reply: FastifyReply): Promise<unknown> => {
      try {
        return await run(req, reply);
      } catch (error) {
        if (error instanceof TerminalError) return reply.status(error.status).send({ error: error.message, code: error.code });
        throw error;
      }
    };

  /** The gate for a route: answers and records the refusal, or returns null to go on */
  const gated = async (req: FastifyRequest, reply: FastifyReply, options: { feature: boolean; reducing?: boolean }): Promise<FastifyReply | null> => {
    const refused = await terminalGate(core, req, { actor: true, ...options });
    if (!refused) return null;
    recordGateRefusal(core, req, refused, (req.params as { id?: string } | undefined)?.id);
    return send(reply, refused);
  };

  app.get('/terminal', async (req, reply) => {
    // Read-only and a chat's token are refused outright; where the caller is from is an answer, not
    // an error: the person on another device is told why the terminal is not offered to them
    const refused = await clientRefusal(core, req, { actor: true });
    if (refused && (refused.status === 405 || refused.reason === 'chat-token')) return send(reply, refused);
    const status = core.terminals.status();
    return refused && status.reason === null ? { ...status, available: false, reason: refused.reason ?? null } : status;
  });

  app.put<{ Body: UpdateTerminalSettingsRequest }>(
    '/terminal/settings',
    handle<{ Body: UpdateTerminalSettingsRequest }>(async (req, reply) => {
      const body = req.body ?? {};
      const off = Object.keys(body).length === 1 && body.enabled === false;
      if (await gated(req, reply, { feature: false, reducing: off })) return reply;
      const remote = core.terminals.settings().remote;
      const status = await core.terminals.updateSettings(body);
      // A socket from another device was let in under the old `remote`: it reconnects through the gate as it is now
      if (status.settings.remote !== remote) tickets.revoke();
      return status;
    }),
  );

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/terminal/history',
    handle<{ Querystring: { limit?: string; offset?: string } }>(async (req, reply) => {
      if (await gated(req, reply, { feature: false })) return reply;
      return core.terminals.history(count(req.query.limit, 'limit'), count(req.query.offset, 'offset'));
    }),
  );

  app.get<{ Querystring: { project?: string; chat?: string } }>(
    '/terminals',
    handle<{ Querystring: { project?: string; chat?: string } }>(async (req, reply) => {
      if (await gated(req, reply, { feature: true })) return reply;
      return core.terminals.list({ ...(req.query.project ? { project: req.query.project } : {}), ...(req.query.chat ? { chat: req.query.chat } : {}) });
    }),
  );

  app.post<{ Body: CreateTerminalRequest }>(
    '/terminals',
    handle<{ Body: CreateTerminalRequest }>(async (req, reply) => {
      if (await gated(req, reply, { feature: true })) return reply;
      // Fastify also parses `text/plain`, which a cross-site form can send without a preflight
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
        return reply.status(400).send({ error: 'the body must be a JSON object', code: 'terminal.bad-request' });
      }
      const terminal = await core.terminals.create(req.body, { actor: req.actor ?? 'local', client: clientOf(core, req) });
      return reply.status(201).send(terminal);
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/terminals/:id',
    handle<{ Params: { id: string } }>(async (req, reply) => {
      if (await gated(req, reply, { feature: true })) return reply;
      const terminal = core.terminals.get(req.params.id);
      if (!terminal) return reply.status(404).send({ error: 'No such terminal', code: 'terminal.not-found' });
      return terminal;
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/terminals/:id/ticket',
    handle<{ Params: { id: string } }>(async (req, reply) => {
      if (await gated(req, reply, { feature: true })) return reply;
      const terminal = core.terminals.get(req.params.id);
      if (!terminal) return reply.status(404).send({ error: 'No such terminal', code: 'terminal.not-found' });
      if (terminal.state === 'closed') return reply.status(409).send({ error: 'The terminal was closed', code: 'terminal.ended' });
      // A browser always says where it comes from; a ticket for a page this wrapper did not serve is of no use to anyone
      if (req.headers.origin !== undefined && !originAllowed(req)) {
        core.terminals.recordRefusal({ terminalId: terminal.id, actor: req.actor ?? 'local', client: clientOf(core, req), origin: req.headers.origin, reason: 'bad-origin' });
        return reply.status(403).send({ error: 'a ticket is only given to the page this wrapper serves', code: 'terminal.bad-origin' });
      }
      return tickets.mint(terminal.id, req.actor ?? 'local', req.headers.origin ?? null);
    }),
  );

  app.delete<{ Params: { id: string } }>(
    '/terminals/:id',
    handle<{ Params: { id: string } }>(async (req, reply) => {
      if (await gated(req, reply, { feature: true })) return reply;
      const terminal = core.terminals.close(req.params.id);
      if (!terminal) return reply.status(404).send({ error: 'No such terminal', code: 'terminal.not-found' });
      return terminal;
    }),
  );

  await app.register(terminalSocketRoute, { core, guard, tickets });
};
