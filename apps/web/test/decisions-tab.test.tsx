// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionPointInfo, DecisionSettings } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import i18n from '../src/i18n';
import { PointRow } from '../src/pages/config/DecisionsTab';
import { detailsOf, resolveSettingsAddress, sectionsOf } from '../src/pages/config/settingsGroups';

// Settings → Decisions (D3 u1): where the tab lives, where the old Supervisor link lands, and what a
// point's row says about what it may do.

const info = (over: Partial<DecisionPointInfo> = {}): DecisionPointInfo => ({
  id: 'flow.refine-needed',
  kind: 'act',
  scope: 'project',
  primitives: ['choice'],
  defaultThreshold: 0.85,
  savesRun: true,
  needsLowLatency: false,
  stateVersion: 2,
  effective: { mode: 'off', threshold: 0.85, provider: 'cli', consent: null, limited: false },
  ...over,
});

const settings = (points: DecisionSettings['points'] = {}): DecisionSettings => ({
  provider: 'cli',
  cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02 },
  jev: { model: 'jev-1.13.0', keySet: false, keyHint: null },
  points,
  historyDays: 30,
});

const row = (point: DecisionPointInfo, saved: DecisionSettings, provider: 'cli' | 'jev') =>
  renderToStaticMarkup(
    <TooltipProvider>
      <PointRow
        info={point}
        settings={saved}
        provider={provider}
        draft={{ provider, cli: saved.cli, historyDays: saved.historyDays, points: {} }}
        onMode={() => undefined}
        onThreshold={() => undefined}
      />
    </TooltipProvider>,
  );

test.beforeEach(async () => {
  await i18n.changeLanguage('es');
});

test('Decisions is a group of its own, with History as its detail and no Supervisor section', () => {
  assert.deepEqual(sectionsOf('decisions'), ['engine', 'points']);
  assert.deepEqual(detailsOf('decisions'), ['history']);
});

test('?tab=supervisor lands on Decisions, at the supervisor.intervene point', () => {
  assert.equal(resolveSettingsAddress('?tab=supervisor', ''), '/settings/decisions#point-supervisor-intervene');
  assert.equal(resolveSettingsAddress('?tab=decisions', ''), '/settings/decisions');
  assert.equal(resolveSettingsAddress('?tab=nope', ''), '/settings');
  assert.equal(resolveSettingsAddress('', ''), null);
  // An inherited key of Object.prototype is not a tab
  assert.equal(resolveSettingsAddress('?tab=constructor', ''), '/settings');
});

test('an act point on the CLI cannot be active, and says why', () => {
  const html = row(info(), settings(), 'cli');
  assert.match(html, /Umbral de flow\.refine-needed/);
  assert.match(html, /Sin consentir/);
  assert.match(html, /aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Activo/s);
});

test('a suggest point has no threshold, and a consent for an older state asks again', () => {
  const consent = { at: '2026-09-30T10:00:00Z', stateVersion: 1, providers: ['cli' as const] };
  const html = row(info({ id: 'board.triage', kind: 'suggest' }), settings({ 'board.triage': { mode: 'shadow', threshold: 0.85, consent } }), 'cli');
  assert.match(html, /Sin umbral/);
  assert.doesNotMatch(html, /Umbral de/);
  assert.match(html, /Volverá a preguntar/);
});

test('a consented point shows its state version', () => {
  const consent = { at: '2026-09-30T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const html = row(info(), settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }), 'jev');
  assert.match(html, /Consentido/);
  assert.match(html, />v2</);
});
