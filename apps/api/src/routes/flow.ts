import type { FastifyPluginAsync } from 'fastify';
import { parseFlowRunQuery, type Core } from '@claudio/core';
import { fromChat } from './spend.ts';

/**
 * What a project's flow by column is doing and has done: its runs going and queued, the team's
 * activity a page at a time, and every run of one item. The flow is switched and configured through
 * the project's settings, and a run starts when a card enters a column; the one thing a person asks
 * of it here is to retry a run that failed, and to start the cards that waited when it was switched on.
 */
export const flowRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/flow', (req) => core.projectFlow(req.params.id));

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/projects/:id/flow/runs', (req) =>
    core.projectFlowRuns(req.params.id, parseFlowRunQuery(req.query)),
  );

  // Switching the flow on is not a card entering a column, so the cards already on the board wait
  // until a person asks for them to start (the Flow screen's prompt after an off-to-on save)
  app.get<{ Params: { id: string } }>('/projects/:id/flow/waiting', (req) => core.projectFlowWaiting(req.params.id));

  app.post<{ Params: { id: string } }>('/projects/:id/flow/start-waiting', (req) => core.startWaitingFlowRuns(req.params.id));

  app.get<{ Params: { itemId: string } }>('/work-items/:itemId/runs', (req) => core.workItemRuns(req.params.itemId));

  // The person lets a card held by the daily spend cap start today; a chat's token cannot (security.ts)
  app.post<{ Params: { itemId: string } }>('/work-items/:itemId/spend-pass', (req) => {
    if (fromChat(req)) throw Object.assign(new Error("a chat's token cannot let a card run past the daily spend cap"), { statusCode: 403 });
    return core.grantFlowSpendPass(req.params.itemId);
  });

  app.post<{ Params: { runId: string } }>('/flow-runs/:runId/retry', async (req, reply) => {
    const run = await core.retryFlowRun(req.params.runId);
    return reply.code(201).send(run);
  });
};
