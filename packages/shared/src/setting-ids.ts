import { DEFAULT_GUARD_SETTINGS } from './guards.ts';
import type { DecisionPointId, GuardSwitchableRuleId } from './types.ts';

/*
 * The ids of the settings the server can reset (`GET /settings/state`, `DELETE
 * /settings/state/:setting`) and count overrides for (`GET /settings/overrides`). They are the
 * rows' `data-setting` ids, the ones settings search already uses, so search, Reset and the
 * overridden line share one id space (docs/plans/settings-reset-and-polish.md, D6).
 */

/** Every decision point, in the engine's order; the catalogue in core checks each has a definition */
export const DECISION_POINT_IDS = [
  'flow.refine-needed',
  'flow.bounce',
  'orchestration.retry',
  'supervisor.intervene',
  'memory.triage',
  'assistant.rerank',
  'assistant.sources',
  'journal.relevance',
  'lesson.mine',
  'board.triage',
  'team.assign',
  'flow.scope-drift',
  'flow.criteria-precheck',
  'flow.criteria-merge',
  'flow.restart',
  'context.compact',
  'run.continuation',
  'orchestration.model',
  'orchestration.fixer',
  'health.semantic-loop',
  'health.test-weakening',
  'changes.unexplained-hunk',
  'palette.intent',
  'notification.urgency',
  'checks.fix',
  'review.triage',
  'issue.triage',
  'account.model-fallback',
  'review.depth',
] as const satisfies readonly DecisionPointId[];

// A point added to `DecisionPointId` and not to the list above fails to compile here
type NoneMissing<T extends never> = T;
export type DecisionPointIdsComplete = NoneMissing<Exclude<DecisionPointId, (typeof DECISION_POINT_IDS)[number]>>;

type Dashed<S extends string> = S extends `${infer Head}.${infer Tail}` ? `${Head}-${Dashed<Tail>}` : S;

/** A point's row id: `supervisor.intervene` → `point-supervisor-intervene`, an id with no dots, so it is a valid anchor */
export type PointSettingId = `point-${Dashed<DecisionPointId>}`;
export type GuardRuleSettingId = `guards.rule.${GuardSwitchableRuleId}`;

export const pointSettingId = (point: DecisionPointId): PointSettingId => `point-${point.replace(/\./g, '-')}` as PointSettingId;
export const guardRuleSettingId = (rule: GuardSwitchableRuleId): GuardRuleSettingId => `guards.rule.${rule}`;

/** The rows of one store each, named the way settings search names them */
export const FIXED_SERVER_SETTING_IDS = [
  'provider.binary',
  'provider.limits',
  'lessons.miner-model',
  'lessons.miner-effort',
  'lessons.max-cost',
  'lessons.project-daily',
  'lessons.global-daily',
  'lessons.chat-minutes',
  'lessons.jobs-daily',
  'lessons.approve-floor',
  'lessons.deliver-at',
  'lessons.budget',
  'lessons.loose-chats',
  'lessons.repeated-errors',
  'lessons.manual-mining',
  'engine.who-answers',
  'engine.cap',
  'engine.supervisor-cap',
  'engine.cli-model',
  'engine.cli-effort',
  'engine.history-days',
  'runs.permission-mode',
  'runs.concurrent',
  'spend-cap.daily',
  'evals.phase-2',
  'remote.tunnel',
  'guards.mode',
  'guards.automated',
  'terminal.max-terminals',
  'terminal.idle-minutes',
  'terminal.scrollback',
  'terminal.replay',
  'terminal.shell',
  'terminal.login-shell',
  'accounts.rotate-on-limit',
  'accounts.threshold',
  'accounts.hysteresis',
  'accounts.cooldown',
  'accounts.strategy',
  'collaborators.relay',
  'collaborators.assistant-reads',
] as const;

export type FixedServerSettingId = (typeof FIXED_SERVER_SETTING_IDS)[number];
export type ServerSettingId = FixedServerSettingId | PointSettingId | GuardRuleSettingId;

const GUARD_RULE_IDS = Object.keys(DEFAULT_GUARD_SETTINGS.rules) as GuardSwitchableRuleId[];

/** Every server setting with a Reset, in the order of the screens */
export const SERVER_SETTING_IDS: readonly ServerSettingId[] = [
  ...FIXED_SERVER_SETTING_IDS,
  ...DECISION_POINT_IDS.map(pointSettingId),
  ...GUARD_RULE_IDS.map(guardRuleSettingId),
];

export const isServerSettingId = (id: string): id is ServerSettingId => (SERVER_SETTING_IDS as readonly string[]).includes(id);
