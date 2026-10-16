import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import { fromChat } from './spend.ts';

/** The settings that change at runtime, layered under the environment: `app-settings.json`. */
export const appSettingsRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/settings/app', () => core.appSettings.get());

  app.put<{ Body: unknown }>('/settings/app', (req) => {
    // The cap is what keeps an agent from spending without limit, so an agent's token never moves it
    // (nor the switch that lets the instruction evals' judge spend: that is the person's)
    const body = req.body;
    if (fromChat(req) && typeof body === 'object' && body !== null) {
      if ('dailySpendCapUsd' in body) throw Object.assign(new Error("a chat's token cannot change the daily spend cap"), { statusCode: 403 });
      if ('evalsPhase2' in body) throw Object.assign(new Error("a chat's token cannot switch the instruction evals' Phase 2 on or off"), { statusCode: 403 });
    }
    return core.appSettings.update(body);
  });
};
