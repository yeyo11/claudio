import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  GUARD_DEFAULT_LIMITS,
  chatActor,
  decideGuard,
  guardsWeakened,
  parseGuardOverride,
  projectGuardsWeakened,
  type Core,
  type GuardRulesFile,
} from '@claudio/core';
import {
  DEFAULT_GUARD_SETTINGS,
  GUARD_RULES,
  GUARD_RULE_IDS,
  type FlowStage,
  type GuardCheckRequest,
  type GuardCheckResult,
  type GuardEventPage,
  type GuardOutcome,
  type GuardOverride,
  type GuardRuleId,
  type GuardSettingsView,
  type GuardSwitchableRuleId,
  type UpdateGuardSettingsRequest,
} from '@claudio/shared';
import { fromChat } from './spend.ts';
import { count } from './chats.ts';

const OUTCOMES: readonly GuardOutcome[] = ['blocked', 'observed', 'missing', 'unarmed', 'error', 'allowed-once'];
const STAGES: readonly FlowStage[] = ['refine', 'work', 'verify'];

const refusal = (status: number, message: string): Error => Object.assign(new Error(message), { statusCode: status });

/**
 * Only a person can weaken a guard (D11). This is checked in the handlers as well as in
 * `CHAT_FORBIDDEN`, because under `mode: none` a chat's token only labels the request.
 */
export function refuseChat(req: FastifyRequest, what: string): void {
  if (fromChat(req)) throw refusal(403, `a chat's token cannot ${what}: guards are the person's to weaken`);
}

/**
 * Whether `override` guards less than the global settings now, or than a fresh install does. A chat
 * could otherwise launch a graph with the guard off through any route that takes one.
 */
export function overrideWeakens(core: Core, override: GuardOverride | null | undefined): boolean {
  if (override === null || override === undefined) return false;
  return guardsWeakened(null, override, core.guards.get().rules) || guardsWeakened(null, override, DEFAULT_GUARD_SETTINGS.rules);
}

/** Refuses a chat's token with 403 when the override it sends is weaker than the global default. */
export function refuseWeakerOverride(core: Core, req: FastifyRequest, override: unknown, where: string): void {
  if (!fromChat(req) || override === undefined || override === null) return;
  let parsed: GuardOverride;
  try {
    parsed = parseGuardOverride(override, where);
  } catch {
    // Malformed: the route's own validation answers 400
    return;
  }
  if (overrideWeakens(core, parsed)) throw refusal(403, `a chat's token cannot weaken the guards (${where}): that is the person's setting`);
}

/**
 * The same check for a project's settings document: the chats opt-in and the flow's stage overrides,
 * each against what is stored and against the default.
 */
export async function refuseWeakerProjectSettings(core: Core, req: FastifyRequest, projectId: string, body: unknown): Promise<void> {
  if (!fromChat(req) || typeof body !== 'object' || body === null || Array.isArray(body)) return;
  const next = body as { guards?: unknown; flow?: unknown };
  const stored = await core.projectSettings(projectId);
  const chats = (next.guards as { chats?: unknown } | undefined)?.chats;
  // A document is replaced whole, so a missing `guards` reads as the default (off)
  if (projectGuardsWeakened(stored.guards, { chats: chats === true })) {
    throw refusal(403, "a chat's token cannot turn off the guards of a project's chats: that is the person's setting");
  }
  const flow = typeof next.flow === 'object' && next.flow !== null ? (next.flow as { guards?: unknown }) : {};
  const sent = typeof flow.guards === 'object' && flow.guards !== null ? (flow.guards as Record<string, unknown>) : {};
  const was = stored.flow?.guards ?? {};
  for (const stage of STAGES) {
    refuseWeakerOverride(core, req, sent[stage], `flow.guards.${stage}`);
    let after: GuardOverride | undefined;
    try {
      after = sent[stage] === undefined ? undefined : parseGuardOverride(sent[stage], `flow.guards.${stage}`);
    } catch {
      continue;
    }
    // Dropping a stored tightening is weakening too
    if (guardsWeakened(was[stage], after, core.guards.get().rules)) {
      throw refusal(403, `a chat's token cannot weaken the guards of the flow's ${stage} stage: that is the person's setting`);
    }
  }
}

const absoluteRoots = (input: unknown): string[] => {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('roots must be an array of absolute directories');
  return input.map((root) => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('roots must be an array of absolute directories');
    return resolve(root);
  });
};

/** An extra root must exist and may not be the home folder or Claudio's own data (they would make `destructive` allow everything). */
function checkExtraRoots(core: Core, roots: string[]): void {
  for (const root of roots) {
    const path = resolve(root);
    if (path === '/' || path === resolve(homedir()) || path === resolve(core.config.dataDir)) {
      throw new Error(`extraRoots: '${root}' cannot be a root for the guard`);
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`extraRoots: '${root}' is not an existing directory`);
  }
}

export const guardRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const view = async (): Promise<GuardSettingsView> => ({ settings: core.guards.get(), status: await core.guardStatus(), rules: [...GUARD_RULES] });

  // Reading is harmless, so a chat's token may
  app.get('/settings/guards', view);

  // Applies to the next process spawned: a running CLI keeps the hooks it started with
  app.put<{ Body: UpdateGuardSettingsRequest }>('/settings/guards', async (req) => {
    refuseChat(req, 'change the guard settings');
    const body: unknown = req.body ?? {};
    // The store checks the shape; what only the machine can answer (does it exist, is it the home folder) is checked here
    if (typeof body === 'object' && body !== null && !Array.isArray(body) && Array.isArray((body as { extraRoots?: unknown }).extraRoots)) {
      const asked = (body as { extraRoots: unknown[] }).extraRoots;
      checkExtraRoots(core, asked.filter((root): root is string => typeof root === 'string' && isAbsolute(root)));
    }
    await core.guards.update(body);
    return view();
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/guard-events', (req): GuardEventPage => {
    const q = req.query;
    const own = typeof req.actor === 'string' && req.actor.startsWith('chat:') ? req.actor : null;
    // One chat must not read what another was blocked from: its token sees its own chat and nothing wider
    if (own !== null) {
      if (q.chatId === undefined || chatActor(q.chatId) !== own) throw refusal(403, "a chat's token reads only its own chat's guard events: pass its chatId");
      if (q.orchestrationId !== undefined || q.flowRunId !== undefined || q.projectId !== undefined) throw refusal(403, "a chat's token reads only its own chat's guard events");
    }
    const limit = count(q.limit, 'limit');
    if (limit !== undefined && (limit < 1 || limit > 200)) throw new Error('limit must be between 1 and 200');
    const before = count(q.before, 'before');
    if (q.rule !== undefined && !GUARD_RULE_IDS.includes(q.rule as GuardRuleId)) throw new Error(`unknown rule '${q.rule}'`);
    if (q.outcome !== undefined && !OUTCOMES.includes(q.outcome as GuardOutcome)) throw new Error(`unknown outcome '${q.outcome}'`);
    return core.guardEvents.list({
      ...(q.chatId ? { chatId: q.chatId } : {}),
      ...(q.orchestrationId ? { orchestrationId: q.orchestrationId } : {}),
      ...(q.flowRunId ? { flowRunId: q.flowRunId } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.rule ? { rule: q.rule as GuardRuleId } : {}),
      ...(q.outcome ? { outcome: q.outcome as GuardOutcome } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  });

  // The pure decision engine, in-process; backs Settings' "Try a command". Not for an agent: it would be a probing oracle
  app.post<{ Body: GuardCheckRequest }>('/guards/check', (req): GuardCheckResult => {
    refuseChat(req, 'ask the guard what it would block');
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('the body must be an object');
    const { tool, input, rules: asked, roots: askedRoots } = body as Record<string, unknown>;
    if (typeof tool !== 'string' || !tool) throw new Error('tool is required');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('input must be an object');
    const settings = core.guards.get();
    let switchable: GuardSwitchableRuleId[];
    if (asked === undefined) {
      switchable = (Object.keys(settings.rules) as GuardSwitchableRuleId[]).filter((id) => settings.rules[id]);
    } else {
      if (!Array.isArray(asked) || asked.some((id) => !GUARD_RULES.some((rule) => rule.id === id && rule.switchable))) throw new Error('rules must list switchable rule ids');
      switchable = asked as GuardSwitchableRuleId[];
    }
    const extra = askedRoots === undefined ? settings.extraRoots : absoluteRoots(askedRoots);
    const rules: GuardRulesFile = {
      version: 1,
      mode: 'enforce',
      rules: ['integrity', ...switchable],
      roots: [...extra],
      mainCheckout: null,
      hooksPathDir: null,
      tmpDir: null,
      dataDir: core.config.dataDir,
      guardDir: resolve(core.config.dataDir, 'guards'),
      claudeConfigDirs: [core.config.configDir],
      protectConfigs: settings.protectConfigs,
      knownSecretSha256: [],
      limits: { ...GUARD_DEFAULT_LIMITS },
    };
    const decision = decideGuard(rules, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input as Record<string, unknown>, ...(extra[0] ? { cwd: extra[0] } : {}) });
    return {
      verdict: decision.verdict,
      ...(decision.rule ? { rule: decision.rule } : {}),
      ...(decision.matcher ? { matcher: decision.matcher } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  });
};
