import {
  DEFAULT_GUARD_SETTINGS,
  GUARD_RULE_IDS,
  type FlowStage,
  type GuardMode,
  type GuardOverride,
  type GuardRuleId,
  type GuardSettings,
  type GuardSwitchableRuleId,
  type ProjectSettings,
  type ToolPolicy,
} from '@claudio/shared';

/**
 * What kind of run asks. The automated kinds take `settings.automated`; `chat` takes the project's
 * opt-in; the confined and internal ones never get a guard (D12).
 */
export type GuardRunKind =
  | 'worker'
  | 'integration'
  | 'synthesis'
  | 'verification-fixer'
  | 'checks-fix'
  | 'workflow'
  | 'flow'
  | 'chat'
  | 'planner'
  | 'supervisor'
  | 'assistant'
  | 'decision'
  | 'project-docs'
  | 'lesson';

const AUTOMATED_KINDS: ReadonlySet<GuardRunKind> = new Set(['worker', 'integration', 'synthesis', 'verification-fixer', 'checks-fix', 'workflow', 'flow']);

export interface GuardResolveContext {
  kind: GuardRunKind;
  settings: GuardSettings;
  /** The graph's override, for orchestration runs */
  graph?: GuardOverride | null;
  /** The flow stage, for `flow` runs; its override comes from `project.flow.guards` */
  stage?: FlowStage;
  /** The project the run belongs to: its chat opt-in and its stage overrides */
  project?: Pick<ProjectSettings, 'guards' | 'flow'> | null;
  /**
   * The run's tool policy. A run that can neither run commands nor write files gets no guard (D12),
   * whatever its kind says. Unknown reads as capable, so a caller that forgets it errs on guarding.
   */
  policy?: { commands?: boolean; edits?: boolean } | null;
  /** The run is confined (`--restricted`/`--tools`) and internal */
  confined?: boolean;
}

export interface ResolvedGuards {
  /** The effective rules in the order they run, never empty */
  rules: GuardRuleId[];
  mode: GuardMode;
  protectConfigs: string[];
  extraRoots: string[];
}

type Switches = Record<GuardSwitchableRuleId, boolean>;

/** What a guard needs of a run's tool policy: whether it can run commands and whether it can write files. */
export function guardPolicyOf(policy: ToolPolicy | null | undefined): { commands: boolean; edits: boolean } | null {
  return policy ? { commands: policy.commands.allow !== 'none', edits: policy.edit.allow !== 'none' } : null;
}

/**
 * Pure. Null means the run gets no guard at all: no rules file, no hook. `integrity` is a rule like
 * the others (D6): a run whose every rule is off is not guarded, rather than guarded by the one rule
 * nobody could switch off.
 */
export function resolveGuards(ctx: GuardResolveContext): ResolvedGuards | null {
  if (ctx.confined) return null;
  if (ctx.policy && ctx.policy.commands === false && ctx.policy.edits === false) return null;
  let enabled: boolean;
  if (ctx.kind === 'chat') enabled = ctx.project?.guards?.chats ?? false;
  else if (AUTOMATED_KINDS.has(ctx.kind)) enabled = ctx.settings.automated;
  else return null;

  // A chat has no override: the project's switch is the whole of what it can say
  let override: GuardOverride | null | undefined;
  if (ctx.kind === 'flow') override = ctx.stage ? ctx.project?.flow?.guards?.[ctx.stage] : undefined;
  else if (ctx.kind !== 'chat') override = ctx.graph;
  if (override?.enabled !== undefined) enabled = override.enabled;
  if (!enabled) return null;

  const switches: Switches = { ...ctx.settings.rules, ...override?.rules };
  const rules = GUARD_RULE_IDS.filter((id) => switches[id as GuardSwitchableRuleId] === true);
  if (rules.length === 0) return null;
  return { rules, mode: ctx.settings.mode, protectConfigs: [...ctx.settings.protectConfigs], extraRoots: [...ctx.settings.extraRoots] };
}

/** The rules an override leaves on over `base`; null when it switches the guard off. */
function effective(override: GuardOverride | null | undefined, base: Switches): Set<GuardSwitchableRuleId> | null {
  if (override?.enabled === false) return null;
  const merged: Switches = { ...base, ...override?.rules };
  return new Set((Object.keys(merged) as GuardSwitchableRuleId[]).filter((id) => merged[id]));
}

/**
 * Whether `after` guards less than `before`: it switches the guard off where `before` left it on,
 * or a rule off that `before` had on. An absent field inherits, so both sides are read against the
 * same `base` (the global rules; the shipped defaults when the caller has none) and what runs is
 * compared. Tightening and an unchanged override are not weakening. Whoever sends no override
 * (`before` absent) is compared with the inherited one, so a first override that only tightens, or
 * leaves things as they are, passes. The routes refuse a chat token when this is true.
 */
export function guardsWeakened(before: GuardOverride | null | undefined, after: GuardOverride | null | undefined, base: Switches = DEFAULT_GUARD_SETTINGS.rules): boolean {
  const was = effective(before, base);
  const now = effective(after, base);
  if (was === null) return false;
  if (now === null) return true;
  for (const id of was) if (!now.has(id)) return true;
  return false;
}

/** The same check for a project's chat opt-in: turning it off weakens. */
export function projectGuardsWeakened(before: { chats: boolean } | null | undefined, after: { chats: boolean } | null | undefined): boolean {
  return (before?.chats ?? false) && !(after?.chats ?? false);
}
