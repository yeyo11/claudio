// Settings in eight groups (docs/plans/settings-ia.md §3, §4): every old address still lands, an
// unknown one goes to /settings, no `?tab=` link is built outside the map, and the search registry
// names real places and real strings in both languages.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { en, es } from '../src/i18n/resources';
import {
  detailsOf,
  GROUP_ORDER,
  groupOfDirtyKey,
  isDetailOf,
  isGroupDirty,
  isSettingsGroup,
  LEGACY_TABS,
  resolveSettingsAddress,
  sectionsOf,
  settingsHref,
} from '../src/pages/config/settingsGroups';
import { DECISION_POINTS, pointAnchor, SETTINGS_INDEX } from '../src/pages/config/settingsIndex';

test('eight groups, in the order the owner decided', () => {
  assert.deepEqual(GROUP_ORDER, ['general', 'claude-code', 'connections', 'instructions', 'extensions', 'decisions', 'runs', 'access']);
  assert.ok(isSettingsGroup('runs'));
  assert.ok(!isSettingsGroup('security'));
  assert.ok(!isSettingsGroup('constructor'), 'an inherited key is not a group');
  assert.ok(isDetailOf('access', 'agent-reads'));
  assert.ok(!isDetailOf('general', 'files'));
});

test('every old address of §4.3 lands where the plan says', () => {
  const cases: Array<[string, string, string]> = [
    ['?tab=appearance', '', '/settings/general#appearance'],
    ['?tab=notifications', '', '/settings/general#notifications'],
    ['?tab=install', '', '/settings/general#install'],
    ['?tab=account', '', '/settings/claude-code#sign-in'],
    ['?tab=providers', '', '/settings/claude-code#provider'],
    ['?tab=settings', '', '/settings/claude-code/behaviour'],
    ['?tab=files', '', '/settings/claude-code/files'],
    ['?tab=integrations', '', '/settings/connections#code-hosts'],
    ['?tab=mcp', '', '/settings/connections/mcp'],
    ['?tab=instructions', '', '/settings/instructions/claude-md'],
    ['?tab=memory', '', '/settings/instructions/memory'],
    ['?tab=lessons', '', '/settings/instructions/lessons'],
    ['?tab=rules', '', '/settings/instructions/rules'],
    ['?tab=output-styles', '', '/settings/instructions/output-styles'],
    ['?tab=plugins', '', '/settings/extensions/plugins'],
    ['?tab=skills', '', '/settings/extensions/skills'],
    ['?tab=agents', '', '/settings/extensions/agents'],
    ['?tab=commands', '', '/settings/extensions/commands'],
    ['?tab=workflows', '', '/settings/extensions/workflows'],
    ['?tab=tools', '', '/settings/extensions/tool-presets'],
    ['?tab=decisions', '', '/settings/decisions'],
    ['?tab=supervisor', '', '/settings/decisions#point-supervisor-intervene'],
    ['?tab=security', '', '/settings/access'],
    ['?tab=security', '#guards', '/settings/access#guards'],
    ['?tab=security', '#agent-reads', '/settings/access/agent-reads'],
    ['?tab=remote', '', '/settings/access#remote'],
  ];
  for (const [search, hash, expected] of cases) assert.equal(resolveSettingsAddress(search, hash), expected, `${search}${hash}`);
  // Every id the map knows is in the table above: a tab added to the map without its case fails here
  assert.deepEqual(Object.keys(LEGACY_TABS).sort(), [...new Set(cases.map(([search]) => search.slice('?tab='.length)))].sort());
});

test('every target of the map is a real group, detail and anchor', () => {
  for (const [tab, target] of Object.entries(LEGACY_TABS)) {
    assert.ok(isSettingsGroup(target.group), tab);
    if (target.detail) assert.ok(isDetailOf(target.group, target.detail), tab);
    if (target.section) assert.ok((sectionsOf(target.group) as readonly string[]).includes(target.section) || target.section.startsWith('point-'), tab);
  }
});

test('an unknown tab goes to /settings, an address without one is left alone, and the rest of the query travels', () => {
  assert.equal(resolveSettingsAddress('?tab=nope', ''), '/settings');
  assert.equal(resolveSettingsAddress('?tab=', ''), '/settings');
  assert.equal(resolveSettingsAddress('?tab=__proto__', ''), '/settings');
  assert.equal(resolveSettingsAddress('', ''), null);
  assert.equal(resolveSettingsAddress('?section=browse', '#x'), null);
  assert.equal(resolveSettingsAddress('?tab=plugins&section=browse', ''), '/settings/extensions/plugins?section=browse');
  // A hash the old tab carried stays when the target names no section of its own
  assert.equal(resolveSettingsAddress('?tab=decisions', '#decisions-history'), '/settings/decisions#decisions-history');
  assert.equal(resolveSettingsAddress('?tab=appearance', '#motion'), '/settings/general#appearance');
});

test('settingsHref builds the paths the redirects land on', () => {
  assert.equal(settingsHref('general'), '/settings/general');
  assert.equal(settingsHref('runs', { section: 'spend-cap' }), '/settings/runs#spend-cap');
  assert.equal(settingsHref('extensions', { detail: 'skills' }), '/settings/extensions/skills');
  assert.equal(settingsHref('decisions', { detail: 'history', query: { point: 'flow.bounce' } }), '/settings/decisions/history?point=flow.bounce');
  assert.equal(settingsHref('decisions', { section: 'point-supervisor-intervene' }), '/settings/decisions#point-supervisor-intervene');
});

test("an editor's unsaved changes mark its group", () => {
  assert.equal(groupOfDirtyKey('settings'), 'claude-code');
  assert.equal(groupOfDirtyKey('skills'), 'extensions');
  assert.equal(groupOfDirtyKey('supervisor'), 'decisions');
  assert.equal(groupOfDirtyKey('lesson:12'), 'instructions');
  assert.equal(groupOfDirtyKey('project'), null);
  assert.ok(isGroupDirty(new Set(['tools']), 'extensions'));
  assert.ok(!isGroupDirty(new Set(['tools']), 'general'));
});

// The tree the app's links live in; `settingsGroups.ts` is the one place an old address is spelled
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCES = ['apps/web/src', 'packages/chat-ui/src', 'packages/ui/src', 'packages/shared/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('no ?tab= link to Settings is built outside the redirect map', () => {
  // A literal link to the old tabs, or a query that starts with one: comments may name them in backticks
  const OLD = [/\/settings\?tab=/, /['"]\?tab=/];
  const found: string[] = [];
  for (const source of SOURCES) {
    for (const file of files(join(ROOT, source))) {
      const at = relative(ROOT, file);
      if (at.endsWith('pages/config/settingsGroups.ts')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, n) => {
          if (OLD.some((pattern) => pattern.test(line))) found.push(`${at}:${n + 1}: ${line.trim()}`);
        });
    }
  }
  assert.deepEqual(found, []);
});

test('no link leads to the Connectors page, which is a section of Connections now', () => {
  const found: string[] = [];
  for (const source of SOURCES) {
    for (const file of files(join(ROOT, source))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, n) => {
          // A link, a path constant or a palette command; the redirect's own route is `path=`
          if (/(to=|href=|: |go\()['"]\/connectors['"]/.test(line)) found.push(`${relative(ROOT, file)}:${n + 1}: ${line.trim()}`);
        });
    }
  }
  assert.deepEqual(found, []);
});

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | undefined {
  const [ns, path] = key.includes(':') ? (key.split(':') as [string, string]) : ['', key];
  let node: string | Tree | undefined = tree[ns];
  for (const part of path.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

test('the search registry: unique ids, real places, and every text in both languages', () => {
  const ids = SETTINGS_INDEX.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const entry of SETTINGS_INDEX) {
    assert.ok(isSettingsGroup(entry.group), entry.id);
    if (entry.detail) assert.ok(isDetailOf(entry.group, entry.detail), entry.id);
    assert.ok((sectionsOf(entry.group) as readonly string[]).includes(entry.section) || entry.section.startsWith('point-'), entry.id);
    for (const key of [entry.label, entry.keywords, ...(entry.consequence ? [entry.consequence] : [])]) {
      assert.ok(lookup(en as unknown as Tree, key), `en ${key}`);
      assert.ok(lookup(es as unknown as Tree, key), `es ${key}`);
    }
  }
  // Every section of every group, every detail and every decision point can be found
  for (const group of GROUP_ORDER) {
    for (const section of sectionsOf(group)) assert.ok(ids.includes(section), `${group}#${section}`);
    for (const detail of detailsOf(group)) assert.ok(SETTINGS_INDEX.some((entry) => entry.group === group && entry.detail === detail), `${group}/${detail}`);
  }
  for (const point of DECISION_POINTS) assert.ok(ids.includes(pointAnchor(point)), point);
  assert.equal(pointAnchor('supervisor.intervene'), 'point-supervisor-intervene');
});

test('every group, section and detail has its name in both languages', () => {
  for (const group of GROUP_ORDER) {
    for (const tree of [en, es] as unknown as Tree[]) {
      assert.ok(lookup(tree, `config:settings.groups.${group}`), group);
      for (const section of sectionsOf(group)) assert.ok(lookup(tree, `config:settings.sections.${section}`), section);
      for (const detail of detailsOf(group)) assert.ok(lookup(tree, `config:settings.details.${detail}`), detail);
    }
  }
});
