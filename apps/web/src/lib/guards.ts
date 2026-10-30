import type { ChatGuards, GuardOverride, GuardSettings, GuardSwitchableRuleId } from '@claudio/shared';

/** The rules a person can switch, in the order every list shows them; `integrity` is one like the others (D6). */
export const SWITCHABLE_RULES: readonly GuardSwitchableRuleId[] = ['integrity', 'no-verify', 'push', 'destructive', 'secrets', 'protect-configs'];

export interface EffectiveGuards {
  enabled: boolean;
  rules: Record<GuardSwitchableRuleId, boolean>;
}

/** What a graph or a flow stage runs with: the global settings with its override laid over them. */
export function effectiveGuards(global: GuardSettings, override: GuardOverride | undefined): EffectiveGuards {
  return {
    enabled: override?.enabled ?? global.automated,
    rules: { ...global.rules, ...override?.rules },
  };
}

/**
 * The override for a wanted state: only what differs from the global settings is kept, so a graph
 * that asks for what the settings already say stays "inherits" and follows them when they change.
 */
export function overrideOf(global: GuardSettings, wanted: EffectiveGuards): GuardOverride | undefined {
  const rules: Partial<Record<GuardSwitchableRuleId, boolean>> = {};
  for (const id of SWITCHABLE_RULES) if (wanted.rules[id] !== global.rules[id]) rules[id] = wanted.rules[id];
  const hasRules = Object.keys(rules).length > 0;
  const enabled = wanted.enabled !== global.automated;
  if (!enabled && !hasRules) return undefined;
  return { ...(enabled ? { enabled: wanted.enabled } : {}), ...(hasRules ? { rules } : {}) };
}

/** The rules that are on in the settings and off for this run: what "Workers will run without …" names. */
export function skippedRules(global: GuardSettings, wanted: EffectiveGuards): GuardSwitchableRuleId[] {
  return SWITCHABLE_RULES.filter((id) => global.rules[id] && !wanted.rules[id]);
}

export const sameGuardOverride = (a: GuardOverride | undefined, b: GuardOverride | undefined): boolean =>
  (a?.enabled ?? null) === (b?.enabled ?? null) && SWITCHABLE_RULES.every((id) => (a?.rules?.[id] ?? null) === (b?.rules?.[id] ?? null));

/** The chat header's tag: absent when the chat is not guarded, or the server did not say. */
export type GuardTagTone = 'muted' | 'warn' | 'bad';
export function guardTag(guards: ChatGuards | null | undefined): { word: 'armed' | 'observe' | 'missing'; tone: GuardTagTone } | null {
  if (!guards || guards.state === 'off') return null;
  if (guards.state === 'missing') return { word: 'missing', tone: 'bad' };
  if (guards.mode === 'observe') return { word: 'observe', tone: 'warn' };
  return { word: 'armed', tone: 'muted' };
}

/** `?guard=1` on a chat's link: open it at the first guard notice. */
export const GUARD_NOTICE_TEXT = 'Claudio guard blocked this (';
export const guardChatPath = (chatId: string): string => `/chats/${encodeURIComponent(chatId)}?guard=1`;
