import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import type { ModelOption, ProviderMove, ProviderMoveState, ProviderStatus, ProvidersSettings } from '@claudio/shared';

/**
 * Claude Code's detection (served from the detector's cache), a re-detection on demand and the
 * settings document; and what happens at its usage limit: the waits so far and stopping one.
 * Validation lives in core. The writes that name a binary Claudio runs are refused to a chat's token
 * in `security.ts`.
 */

const MOVE_STATES: readonly ProviderMoveState[] = ['waiting', 'resuming', 'moved', 'resumed', 'failed', 'cancelled'];

const fail = (status: number, message: string): Error => Object.assign(new Error(message), { statusCode: status });

export const providerRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/providers', (): Promise<ProviderStatus[]> => core.providers.statuses());

  app.post('/providers/refresh', (): Promise<ProviderStatus[]> => core.providers.refresh());

  app.get('/providers/settings', (): ProvidersSettings => core.providersSettings.get());

  const settingsChanged = (): void => {
    // The answer does not wait for the probes: `providers.changed` tells every page what they found
    core.providers.settingsChanged().catch((err: unknown) => app.log.warn({ err }, 'providers: re-detection after a settings change failed'));
  };

  app.put<{ Body: unknown }>('/providers/settings', async (req): Promise<ProvidersSettings> => {
    const settings = await core.providersSettings.set(req.body);
    settingsChanged();
    return settings;
  });

  // Waits, newest first: the history and the queue in one
  app.get<{ Querystring: { chatId?: string; projectId?: string; state?: string; limit?: string } }>('/limits/waits', (req): ProviderMove[] => {
    const { chatId, projectId, state, limit } = req.query;
    const wanted = state ? MOVE_STATES.find((s) => s === state) : undefined;
    if (state && !wanted) throw new Error(`state must be one of ${MOVE_STATES.join(', ')}`);
    const max = limit === undefined || limit === '' ? undefined : Number(limit);
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new Error('limit must be a positive integer');
    return core.db.providerMoves({ ...(chatId ? { chatId } : {}), ...(projectId ? { projectId } : {}), ...(wanted ? { state: wanted } : {}), ...(max ? { limit: max } : {}) });
  });

  // Stop waiting: the run or task the wait belonged to then ends `stopped`
  app.post<{ Params: { id: string } }>('/limits/waits/:id/cancel', (req): ProviderMove => {
    const move = core.db.providerMove(req.params.id);
    if (!move) throw fail(404, `move ${req.params.id} not found`);
    if (!core.rotation.cancel(move.id)) throw fail(409, 'this wait is already over');
    return core.db.providerMove(move.id) ?? move;
  });

  app.get<{ Params: { id: string } }>('/providers/:id', async (req): Promise<ProviderStatus> => {
    const status = (await core.providers.statuses()).find((s) => s.id === req.params.id);
    if (!status) throw Object.assign(new Error(`provider ${req.params.id} not found`), { statusCode: 404 });
    return status;
  });

  app.get<{ Params: { id: string } }>('/providers/:id/models', (req): ModelOption[] => {
    const driver = core.runtime.providers.driverFor(req.params.id);
    if (!driver) throw Object.assign(new Error(`provider ${req.params.id} has no driver`), { statusCode: 404 });
    return driver.models();
  });
};
