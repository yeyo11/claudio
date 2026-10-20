import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Core } from '@claudio/core';
import type { SettingOverrides, SettingState, SettingsState } from '@claudio/shared';
import { recordGateRefusal, terminalGate } from '../terminal-gate.ts';
import { fromChat } from './spend.ts';

/**
 * Where each settings row stands against its default, the Reset that removes the person's value,
 * and the projects that override a global row (docs/plans/settings-reset-and-polish.md, D6 and D7).
 * The registry in core does the work; this checks who asks.
 */
export const settingsStateRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/settings/state', (): Promise<SettingsState> => core.settings.state());

  app.delete<{ Params: { setting: string } }>('/settings/state/:setting', async (req, reply): Promise<SettingState | FastifyReply> => {
    // A setting is the person's, for every row: an agent's token never moves one back, as it never
    // moves the spend cap or the evals' switch
    if (fromChat(req)) throw Object.assign(new Error("a chat's token cannot reset a setting"), { statusCode: 403, reason: 'chat-token' });
    const { setting } = req.params;
    // The terminal's settings answer only to whoever the terminal's own gate lets change them
    if (setting.startsWith('terminal.')) {
      const refused = await terminalGate(core, req, { actor: true, feature: false });
      if (refused) {
        recordGateRefusal(core, req, refused);
        return reply.status(refused.status).send({ error: refused.error, code: `terminal.${refused.reason ?? 'refused'}`, ...(refused.reason ? { reason: refused.reason } : {}) });
      }
    }
    return core.settings.reset(setting);
  });

  app.get('/settings/overrides', (): Promise<SettingOverrides> => core.settings.overrides());
};
