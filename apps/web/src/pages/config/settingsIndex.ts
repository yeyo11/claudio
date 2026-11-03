// What settings search and the palette (Ctrl K) find: one entry per section and per setting of the
// eight groups (docs/plans/settings-ia.md §5). Every text is a translation key, so a person searches
// in the language they read; every screen gives its row the entry's id as `data-setting`.
import type { DecisionPointId } from '@claudio/shared';
import {
  GROUP_ORDER,
  sectionLabel,
  type DetailOf,
  type PointAnchor,
  type SectionOf,
  type SettingsDetailId,
  type SettingsGroupId,
  type SettingsSectionId,
} from './settingsGroups';

export interface SettingEntry {
  /** The row's `data-setting`, and the section's anchor for a section's own entry */
  id: string;
  group: SettingsGroupId;
  /** The anchor on the group's screen: a section, or a decision point's row */
  section: SettingsSectionId | PointAnchor;
  /** The detail screen the setting lives on, when it is not on the group's screen */
  detail?: SettingsDetailId;
  label: string;
  keywords: string;
  consequence?: string;
}

interface RowSpec {
  detail?: string;
  /** The row has a fixed consequence line worth searching; a live one stays on the screen */
  consequence?: boolean;
}

type Rows = Readonly<Record<string, RowSpec>>;

const entries: SettingEntry[] = [];

function add<G extends SettingsGroupId>(group: G, section: SectionOf<G>, rows: Rows = {}) {
  const at = section as SettingsSectionId;
  entries.push({ id: at, group, section: at, label: sectionLabel(at), keywords: `config:settings.keywords.${at}.section` });
  for (const [row, spec] of Object.entries(rows)) {
    entries.push({
      id: `${at}.${row}`,
      group,
      section: at,
      ...(spec.detail ? { detail: spec.detail as DetailOf<G> & SettingsDetailId } : {}),
      label: `config:settings.rows.${at}.${row}`,
      keywords: `config:settings.keywords.${at}.${row}`,
      ...(spec.consequence ? { consequence: `config:settings.consequences.${at}.${row}` } : {}),
    });
  }
}

add('general', 'appearance', { theme: {}, language: {}, motion: {} });
add('general', 'notifications', { kinds: {}, devices: {} });
add('general', 'updates', { claudio: {}, cli: {} });
add('general', 'install', { app: {} });

add('claude-code', 'sign-in', { account: {}, panel: {}, accounts: {} });
add('claude-code', 'provider', { binary: {}, limits: {}, check: {} });
add('claude-code', 'behaviour', { 'settings-json': { detail: 'behaviour' } });
add('claude-code', 'files', { tree: { detail: 'files' } });

add('connections', 'connectors', { authorise: {} });
add('connections', 'code-hosts', { github: {}, gitlab: {} });
add('connections', 'trackers', { youtrack: {} });
add('connections', 'webhooks');
add('connections', 'mcp', { servers: { detail: 'mcp' } });

add('instructions', 'instructions', { 'claude-md': { detail: 'claude-md' } });
add('instructions', 'memory', { projects: { detail: 'memory' } });
add('instructions', 'lessons', {
  'miner-model': {},
  'miner-effort': {},
  'max-cost': {},
  'project-daily': {},
  'global-daily': {},
  'chat-minutes': {},
  'jobs-daily': {},
  'approve-floor': {},
  'deliver-at': {},
  budget: {},
  'loose-chats': {},
  'repeated-errors': {},
  'manual-mining': {},
  global: { detail: 'lessons' },
});
add('instructions', 'rules', { list: { detail: 'rules' } });
add('instructions', 'output-styles', { list: { detail: 'output-styles' } });

add('extensions', 'plugins', { list: { detail: 'plugins' } });
add('extensions', 'skills', { list: { detail: 'skills' } });
add('extensions', 'agents', { list: { detail: 'agents' } });
add('extensions', 'commands', { list: { detail: 'commands' } });
add('extensions', 'workflows', { list: { detail: 'workflows' } });
add('extensions', 'tool-presets', { list: { detail: 'tool-presets' } });

add('decisions', 'engine', {
  'who-answers': { consequence: true },
  'jev-key': {},
  cap: {},
  'supervisor-cap': {},
  'cli-model': {},
  'cli-effort': {},
  'history-days': {},
});
add('decisions', 'points', { history: { detail: 'history' } });

/** Every decision point, in the order of its area on the screen (§7.1). */
export const DECISION_POINTS: readonly DecisionPointId[] = [
  'flow.refine-needed',
  'flow.bounce',
  'flow.scope-drift',
  'flow.criteria-precheck',
  'flow.criteria-merge',
  'flow.restart',
  'context.compact',
  'board.triage',
  'team.assign',
  'memory.triage',
  'journal.relevance',
  'lesson.mine',
  'assistant.rerank',
  'assistant.sources',
  'orchestration.retry',
  'orchestration.model',
  'orchestration.fixer',
  'run.continuation',
  'account.model-fallback',
  'review.depth',
  'supervisor.intervene',
  'health.semantic-loop',
  'health.test-weakening',
  'changes.unexplained-hunk',
  'checks.fix',
  'review.triage',
  'issue.triage',
  'notification.urgency',
  'palette.intent',
];

/** `supervisor.intervene` → `point-supervisor-intervene`: an id with no dots, so it is a valid anchor. */
export const pointAnchor = (point: DecisionPointId): PointAnchor => `point-${point.replace(/\./g, '-')}`;
// The point's name is a flat camelCase key, as the Decisions screen keeps it
const pointName = (point: DecisionPointId) => `decisions:points.names.${point.replace(/[.-](\w)/g, (_, c: string) => c.toUpperCase())}`;

for (const point of DECISION_POINTS) {
  const anchor = pointAnchor(point);
  entries.push({ id: anchor, group: 'decisions', section: anchor, label: pointName(point), keywords: 'config:settings.keywords.points.point' });
}

add('runs', 'runs', { 'permission-mode': {}, concurrent: { consequence: true } });
add('runs', 'spend-cap', { daily: { consequence: true } });
add('runs', 'evals', { 'phase-2': {} });
add('runs', 'machine', { history: { detail: 'machine' } });

add('access', 'access', { mode: {}, token: {}, 'read-only': { consequence: true } });
add('access', 'hosts', { allowed: { consequence: true } });
add('access', 'remote', { tunnel: { consequence: true } });
// The local network card's three settings live in the Remote access section, but their ids are the
// registry's own (`lan.*`), which is also what each row's `data-setting` says
for (const row of ['enabled', 'port', 'bind']) {
  entries.push({ id: `lan.${row}`, group: 'access', section: 'remote', label: `config:settings.rows.lan.${row}`, keywords: `config:settings.keywords.lan.${row}` });
}
add('access', 'secrets', { storage: {} });
add('access', 'guards', {
  rules: {},
  mode: {},
  automated: {},
  'rule.integrity': {},
  'rule.no-verify': {},
  'rule.push': {},
  'rule.destructive': {},
  'rule.secrets': {},
  'rule.protect-configs': {},
});
add('access', 'terminal', { enabled: {}, remote: {}, 'max-terminals': {}, 'idle-minutes': {}, scrollback: {}, shell: {} });
add('access', 'audit', { log: { detail: 'audit' } });
add('access', 'agent-reads', { log: { detail: 'agent-reads' } });

export const SETTINGS_INDEX: readonly SettingEntry[] = entries;

/** An entry's place in the groups' order, for ties in search. */
export const groupRank = (group: SettingsGroupId) => GROUP_ORDER.indexOf(group);
