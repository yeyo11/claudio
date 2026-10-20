// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISION_POINT_IDS, pointSettingId, SERVER_SETTING_IDS, type DecisionSettings } from '@claudio/shared';
import { defaultLanguage, storeLanguage } from '@claudio/ui/i18n/language';
import { TooltipProvider } from '@claudio/ui/components/controls';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { defaultPrefs, prefsChanged, resetPrefsOf } from '../src/lib/notifications-model';
import { draftOf, withSettingFrom } from '../src/pages/config/decisions/model';
import { SettingChange, overriddenLine } from '../src/pages/config/SettingChange';
import { SETTINGS_INDEX } from '../src/pages/config/settingsIndex';

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

const render = (state: { changed: boolean; source: 'env' | 'stored' | 'default' } | undefined) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SettingChange setting="runs.concurrent" label="Concurrent runs" state={state} defaultText="12" onReset={() => undefined} />
    </TooltipProvider>,
  );

test('a changed row offers "Changed · Reset" with the default in the button name', () => {
  const html = render({ changed: true, source: 'stored' });
  assert.match(html, /<span class="pref-row-change-line">/);
  assert.match(html, /Changed/);
  assert.match(html, /aria-label="Reset Concurrent runs to its default \(12\)"/);
  assert.doesNotMatch(html, /aria-hidden="true"><span class="pref-row-change-dot"/);
});

test('the slot keeps its room while nothing is changed: it is in the markup, hidden', () => {
  for (const state of [{ changed: false, source: 'default' as const }, undefined]) {
    const html = render(state);
    assert.match(html, /class="pref-row-change-line is-hidden" aria-hidden="true"/);
    assert.match(html, /tabindex="-1"/);
  }
});

test('a value the environment sets never offers Reset', () => {
  const html = render({ changed: true, source: 'env' });
  assert.match(html, /is-hidden/);
});

test('the slot speaks Spanish', async () => {
  await i18n.changeLanguage('es');
  const html = render({ changed: true, source: 'stored' });
  assert.match(html, /Cambiado/);
  assert.match(html, /Restablecer/);
  assert.match(html, /Restablecer Concurrent runs a su valor predeterminado \(12\)/);
});

test('the overridden link points at the first project, and the tooltip names at most five', () => {
  const names = new Map([
    ['p1', 'Alpha'],
    ['p2', 'Beta'],
  ]);
  const line = overriddenLine(['p1', 'p2'], names);
  assert.deepEqual(line, { count: 2, href: '/?project=p1&view=settings', names: ['Alpha', 'Beta'], more: 0 });
  assert.equal(overriddenLine([], names), null);
  assert.equal(overriddenLine(undefined, names), null);
  const many = overriddenLine(['a', 'b', 'c', 'd', 'e', 'f', 'g'], new Map());
  assert.equal(many?.names.length, 5);
  assert.equal(many?.more, 2);
  assert.equal(overriddenLine(['a b'], new Map())?.href, '/?project=a%20b&view=settings');
});

const saved = (over: Partial<DecisionSettings> = {}): DecisionSettings =>
  ({
    provider: 'cli',
    cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02 },
    jev: { model: 'jev-1', keySet: false, keyHint: null },
    historyDays: 30,
    points: {},
    ...over,
  }) as unknown as DecisionSettings;

test('a reset puts the default into that field of the draft and keeps the other unsaved edits', () => {
  const draft = { ...draftOf(saved({ provider: 'jev' })), historyDays: 90 };
  const fresh = draftOf(saved());
  const next = withSettingFrom(draft, fresh, 'engine.who-answers');
  assert.equal(next.provider, 'cli');
  assert.equal(next.historyDays, 90);
  assert.equal(withSettingFrom(draft, fresh, 'engine.history-days').historyDays, 30);
  assert.equal(withSettingFrom({ ...draft, cli: { ...draft.cli, maxCostUsd: 3 } }, fresh, 'engine.cap').cli.maxCostUsd, 0.02);
});

test('a point reset takes the saved document\'s entry, or drops the draft\'s when there is none', () => {
  const id = DECISION_POINT_IDS[0];
  assert.ok(id);
  const edited = { ...draftOf(saved()), points: { [id]: { mode: 'active' as const, threshold: 0.9 } } };
  const dropped = withSettingFrom(edited, draftOf(saved()), pointSettingId(id));
  assert.equal(dropped.points[id], undefined);
  const kept = withSettingFrom(edited, draftOf(saved({ points: { [id]: { mode: 'off', threshold: 0.7, consent: null } } })), pointSettingId(id));
  assert.deepEqual(kept.points[id], { mode: 'off', threshold: 0.7 });
  assert.equal(withSettingFrom(edited, draftOf(saved()), 'nope'), edited);
});

test('notification kinds are changed once a kind or the level moves, and reset keeps the browser permission', () => {
  assert.equal(prefsChanged(defaultPrefs()), false);
  assert.equal(prefsChanged({ ...defaultPrefs(), browser: true }), false);
  const moved = defaultPrefs();
  moved.kinds[Object.keys(moved.kinds)[0] as keyof typeof moved.kinds] = false;
  assert.equal(prefsChanged(moved), true);
  assert.equal(prefsChanged(resetPrefsOf({ ...moved, browser: true })), false);
  assert.equal(resetPrefsOf({ ...moved, browser: true }).browser, true);
});

test('the language is stored only when it differs from the browser\'s, and Reset forgets it', () => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  try {
    // What node reports as the browser's language depends on the machine, so the test takes both sides from it
    const browser = defaultLanguage();
    const other = browser === 'es' ? 'en' : 'es';
    storeLanguage(other);
    assert.equal(store.get('claudio-language'), other);
    storeLanguage(browser);
    assert.equal(store.has('claudio-language'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

// The terminal's replay and login shell have no control in the UI yet, so search has nothing to take a person to
const NO_ROW = new Set(['terminal.replay', 'terminal.login-shell']);

test('every server setting that has a row in Settings is one search finds', () => {
  const ids = new Set(SETTINGS_INDEX.map((entry) => entry.id));
  for (const id of SERVER_SETTING_IDS) {
    // The accounts and collaborators rows live on their own pages
    if (id.startsWith('accounts.') || id.startsWith('collaborators.') || NO_ROW.has(id)) continue;
    assert.ok(ids.has(id), `${id} is in settingsIndex`);
  }
});
