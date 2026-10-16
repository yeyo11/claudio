import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Core } from '@claudio/core';

/** The header that lets a person's request through the daily spend cap (docs/plans/agent-run-improvements.md). */
export const SPEND_OVERRIDE_HEADER = 'x-claudio-spend-override';

/** Requests that went past a closed gate on the person's say-so, so a launch can grant its graph the pass afterwards. */
const overridden = new WeakSet<FastifyRequest>();

/** Whether a chat's own token made the request: an agent never spends past the person's cap, nor raises it. */
export const fromChat = (req: FastifyRequest): boolean => typeof req.actor === 'string' && req.actor.startsWith('chat:');

/** The person asked to go on past the cap. A chat's token is ignored here: the header is the person's alone. */
const overrides = (req: FastifyRequest): boolean => req.headers[SPEND_OVERRIDE_HEADER] === '1' && !fromChat(req);

export interface SpendGateOptions {
  /** The route names the graph it starts again, so an override gives that graph today's pass before the handler runs */
  graph?: (req: FastifyRequest) => string | undefined;
  /** A message to a chat with a turn in flight was accepted before the cap closed, so it goes on */
  inFlight?: (req: FastifyRequest) => boolean;
}

/**
 * A `preHandler` for a route that starts work on the person's say-so: over the cap it answers 409
 * `spend-cap` before anything starts, unless the person overrides. Spend answers first, before any
 * concurrency refusal, because the dialog can resolve it.
 */
export function spendGate(core: Core, options: SpendGateOptions = {}) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (options.inFlight?.(req)) return undefined;
    if (core.spend.allows('person')) return undefined;
    if (!overrides(req)) return reply.status(409).send(core.spend.refusal());
    overridden.add(req);
    const graph = options.graph?.(req);
    if (graph) core.spend.grantPass(graph);
    return undefined;
  };
}

/** After a launch: a graph started past the cap on the person's override gets today's pass. */
export function grantAfterOverride(core: Core, req: FastifyRequest, orchestrationId: string): void {
  if (overridden.has(req)) core.spend.grantPass(orchestrationId);
}

/** What all of Claudio's automation spent today against the daily cap. A chat's token may read it. */
export const spendRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/spend', () => core.spend.state());
};
