// The eight groups of Settings, their sections and details, and the addresses that reach them: plain
// data, so a test reads it without the page (docs/plans/settings-ia.md §3, §4).

/**
 * Sections are on the group's screen, in this order, and `#<section>` scrolls to one. A detail is a
 * screen of its own at `/settings/<group>/<detail>`, reached from a row of its section.
 */
const GROUPS = {
  general: { sections: ['appearance', 'notifications', 'updates', 'install'], details: [] },
  'claude-code': { sections: ['sign-in', 'provider', 'behaviour', 'files'], details: ['behaviour', 'files'] },
  connections: { sections: ['connectors', 'code-hosts', 'trackers', 'webhooks', 'mcp'], details: ['mcp'] },
  instructions: {
    sections: ['instructions', 'memory', 'lessons', 'rules', 'output-styles'],
    details: ['claude-md', 'memory', 'lessons', 'rules', 'output-styles'],
  },
  extensions: {
    sections: ['plugins', 'skills', 'agents', 'commands', 'workflows', 'tool-presets'],
    details: ['plugins', 'skills', 'agents', 'commands', 'workflows', 'tool-presets'],
  },
  decisions: { sections: ['engine', 'points'], details: ['history'] },
  runs: { sections: ['runs', 'spend-cap', 'evals', 'machine'], details: ['machine'] },
  access: {
    sections: ['access', 'hosts', 'remote', 'secrets', 'guards', 'terminal', 'audit', 'agent-reads'],
    details: ['audit', 'agent-reads'],
  },
} as const satisfies Record<string, { sections: readonly string[]; details: readonly string[] }>;

export type SettingsGroupId = keyof typeof GROUPS;
export type SectionOf<G extends SettingsGroupId> = (typeof GROUPS)[G]['sections'][number];
export type DetailOf<G extends SettingsGroupId> = (typeof GROUPS)[G]['details'][number];
export type SettingsSectionId = { [G in SettingsGroupId]: SectionOf<G> }[SettingsGroupId];
export type SettingsDetailId = { [G in SettingsGroupId]: DetailOf<G> }[SettingsGroupId];

/** A decision point's row is an anchor of its own, `#point-supervisor-intervene` (§7). */
export type PointAnchor = `point-${string}`;
/** What `#…` may name in a group: its sections, and in Decisions each point's row. */
export type AnchorOf<G extends SettingsGroupId> = SectionOf<G> | (G extends 'decisions' ? PointAnchor : never);

export const GROUP_ORDER: readonly SettingsGroupId[] = ['general', 'claude-code', 'connections', 'instructions', 'extensions', 'decisions', 'runs', 'access'];

export const sectionsOf = <G extends SettingsGroupId>(group: G): readonly SectionOf<G>[] => GROUPS[group].sections;
export const detailsOf = <G extends SettingsGroupId>(group: G): readonly DetailOf<G>[] => GROUPS[group].details;

export const isSettingsGroup = (value: string | null | undefined): value is SettingsGroupId =>
  value !== null && value !== undefined && Object.hasOwn(GROUPS, value);

export const isDetailOf = <G extends SettingsGroupId>(group: G, value: string | null | undefined): value is DetailOf<G> =>
  value !== null && value !== undefined && (GROUPS[group].details as readonly string[]).includes(value);

// The labels are translation keys, not text: the constants are built once, the language can change
export const groupLabel = <G extends SettingsGroupId>(group: G) => `config:settings.groups.${group}` as const;
export const sectionLabel = <S extends SettingsSectionId>(section: S) => `config:settings.sections.${section}` as const;
export const detailLabel = <D extends SettingsDetailId>(detail: D) => `config:settings.details.${detail}` as const;

/** The address itself, unchecked: for data that already holds a valid group, section and detail. */
export function settingsAddress(group: SettingsGroupId, section?: string, detail?: string, query?: Record<string, string>): string {
  const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : '';
  return `/settings/${group}${detail ? `/${detail}` : ''}${search}${section ? `#${section}` : ''}`;
}

/** The one way a link reaches Settings: no `?tab=` string is built anywhere else. */
export function settingsHref<G extends SettingsGroupId>(
  group: G,
  to: { section?: AnchorOf<G>; detail?: DetailOf<G>; query?: Record<string, string> } = {},
): string {
  return settingsAddress(group, to.section, to.detail, to.query);
}

/** Which group an editor's dirty key belongs to, for the dot beside its group in the nav. */
const DIRTY_KEYS: Readonly<Record<string, SettingsGroupId>> = {
  settings: 'claude-code',
  files: 'claude-code',
  mcp: 'connections',
  instructions: 'instructions',
  'lessons-settings': 'instructions',
  rules: 'instructions',
  'output-styles': 'instructions',
  agents: 'extensions',
  skills: 'extensions',
  commands: 'extensions',
  workflows: 'extensions',
  tools: 'extensions',
  decisions: 'decisions',
  supervisor: 'decisions',
};

export function groupOfDirtyKey(key: string): SettingsGroupId | null {
  if (Object.hasOwn(DIRTY_KEYS, key)) return DIRTY_KEYS[key] ?? null;
  // A global lesson being edited (`lesson:<id>`) is a detail of Instructions & memory
  if (key.startsWith('lesson:')) return 'instructions';
  return null;
}

export const isGroupDirty = (keys: ReadonlySet<string>, group: SettingsGroupId) => [...keys].some((key) => groupOfDirtyKey(key) === group);

interface LegacyTarget {
  group: SettingsGroupId;
  section?: string;
  detail?: string;
}

/**
 * Every `?tab=` id the app, the docs and people's bookmarks used before the eight groups (§4.3).
 * This map is the contract the link migration and the e2e specs rely on.
 */
export const LEGACY_TABS: Readonly<Record<string, LegacyTarget>> = {
  appearance: { group: 'general', section: 'appearance' },
  notifications: { group: 'general', section: 'notifications' },
  install: { group: 'general', section: 'install' },
  account: { group: 'claude-code', section: 'sign-in' },
  providers: { group: 'claude-code', section: 'provider' },
  settings: { group: 'claude-code', detail: 'behaviour' },
  files: { group: 'claude-code', detail: 'files' },
  integrations: { group: 'connections', section: 'code-hosts' },
  mcp: { group: 'connections', detail: 'mcp' },
  instructions: { group: 'instructions', detail: 'claude-md' },
  memory: { group: 'instructions', detail: 'memory' },
  lessons: { group: 'instructions', detail: 'lessons' },
  rules: { group: 'instructions', detail: 'rules' },
  'output-styles': { group: 'instructions', detail: 'output-styles' },
  plugins: { group: 'extensions', detail: 'plugins' },
  skills: { group: 'extensions', detail: 'skills' },
  agents: { group: 'extensions', detail: 'agents' },
  commands: { group: 'extensions', detail: 'commands' },
  workflows: { group: 'extensions', detail: 'workflows' },
  tools: { group: 'extensions', detail: 'tool-presets' },
  decisions: { group: 'decisions' },
  supervisor: { group: 'decisions', section: 'point-supervisor-intervene' },
  security: { group: 'access' },
  remote: { group: 'access', section: 'remote' },
};

/** The cards of the old Security tab that are details now, by the hash their links carried. */
const SECURITY_DETAILS: Readonly<Record<string, DetailOf<'access'>>> = { 'agent-reads': 'agent-reads', audit: 'audit' };

/**
 * Where an old address lands: `null` when the URL has no `?tab=` (nothing to redirect), `/settings`
 * when the tab is unknown, otherwise the new path. Any other query (a file path, a filter) travels
 * along, and a hash the old tab carried stays when the new target names no section of its own.
 */
export function resolveSettingsAddress(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  if (tab === null) return null;
  params.delete('tab');
  const target = Object.hasOwn(LEGACY_TABS, tab) ? LEGACY_TABS[tab] : undefined;
  if (!target) return '/settings';

  const anchor = hash.replace(/^#/, '');
  let { section, detail } = target;
  if (target.group === 'access' && anchor && Object.hasOwn(SECURITY_DETAILS, anchor)) detail = SECURITY_DETAILS[anchor];
  else if (!section && anchor) section = anchor;

  return settingsAddress(target.group, section, detail, Object.fromEntries(params));
}
