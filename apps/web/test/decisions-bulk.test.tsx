// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionPointId, DecisionPointInfo, DecisionMode } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import i18n from '../src/i18n';
import { BulkConsentBody } from '../src/pages/config/decisions/BulkConsentDialog';
import { planBulk } from '../src/pages/config/decisions/model';

const info = (id: DecisionPointId, kind: 'act' | 'suggest', over: Partial<DecisionPointInfo> = {}): DecisionPointInfo => ({
  id,
  kind,
  scope: 'project',
  primitives: ['choice'],
  defaultThreshold: 0.85,
  savesRun: false,
  causesRun: false,
  needsLowLatency: false,
  stateVersion: 2,
  effective: { mode: 'off', threshold: 0.85, provider: 'cli', consent: null, limited: false, limitedBy: null, floor: null },
  // Proven by default: the bulk tests are about the CLI and consent, the gate has its own test below
  standing: 'proven',
  gate: { enforced: true, minCases: 30, breakEven: 0.5, minPrecision: null, maxFlagRate: null },
  live: { source: 'live', at: null, cases: 0, precision: { n: 0, hits: 0, value: null, lower90: null }, baselinePrecision: { n: 0, hits: 0, value: null, lower90: null }, actRate: { n: 0, hits: 0, value: null, lower90: null }, shortfalls: ['cases'] },
  replay: null,
  demoted: null,
  ...over,
});

const catalogue = [info('flow.bounce', 'act'), info('board.triage', 'suggest'), info('health.test-weakening', 'suggest'), info('team.assign', 'act')];
const ids = catalogue.map((point) => point.id);
const jevConsent = { at: '2026-09-30T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };

const plan = (mode: DecisionMode, provider: 'cli' | 'jev', modes: Partial<Record<DecisionPointId, DecisionMode>> = {}, consented: DecisionPointId[] = []) =>
  planBulk(catalogue, ids, mode, (id) => modes[id] ?? 'off', (id) => (consented.includes(id) ? jevConsent : null), provider);

test('active on the CLI keeps the act points in shadow and counts them as kept', () => {
  const result = plan('active', 'cli');
  assert.deepEqual(result.capped.sort(), ['flow.bounce', 'team.assign']);
  assert.deepEqual(
    result.changes.map((change) => [change.id, change.mode]),
    [
      ['flow.bounce', 'shadow'],
      ['board.triage', 'active'],
      ['health.test-weakening', 'active'],
      ['team.assign', 'shadow'],
    ],
  );
});

test('active on Jev sets every point', () => {
  const result = plan('active', 'jev');
  assert.equal(result.capped.length, 0);
  assert.ok(result.changes.every((change) => change.mode === 'active'));
});

test('a bulk active plans only proven points: the rest stay as they are, and an active one is never sent back', () => {
  const unproven = [info('flow.bounce', 'act', { standing: 'unproven' }), info('team.assign', 'act', { standing: 'failing' }), info('board.triage', 'suggest', { gate: { enforced: false, minCases: 30, breakEven: null, minPrecision: 0.6, maxFlagRate: 0.3 }, standing: 'unproven' }), info('memory.triage', 'suggest')];
  const result = planBulk(unproven, unproven.map((point) => point.id), 'active', (id) => (id === 'team.assign' ? 'active' : id === 'flow.bounce' ? 'shadow' : 'off'), () => null, 'jev');
  // The server refuses more than one unproven step up at once, suggest points included
  assert.deepEqual(result.unproven, ['flow.bounce', 'board.triage']);
  assert.deepEqual(result.changes.map((change) => [change.id, change.mode]), [['memory.triage', 'active']]);
  assert.deepEqual(result.unchanged.sort(), ['board.triage', 'flow.bounce', 'team.assign']);
  assert.deepEqual(result.capped, []);
});

test('a point saved as active is not held back by a bulk active even when the form moved it to shadow', () => {
  const failing = [info('flow.bounce', 'act', { standing: 'failing' })];
  const result = planBulk(failing, ['flow.bounce'], 'active', () => 'shadow', () => jevConsent, 'jev', () => 'active');
  assert.deepEqual(result.unproven, []);
  assert.deepEqual(result.changes.map((change) => [change.id, change.mode]), [['flow.bounce', 'active']]);
});

test('a point already in the resulting mode does not change nor ask', () => {
  const result = plan('shadow', 'jev', { 'board.triage': 'shadow' });
  assert.deepEqual(result.unchanged, ['board.triage']);
  assert.ok(!result.needConsent.some((item) => item.id === 'board.triage'));
});

test('only changed points without consent for the provider are asked', () => {
  const result = plan('active', 'jev', {}, ['flow.bounce', 'board.triage']);
  assert.deepEqual(result.needConsent.map((item) => item.id), ['health.test-weakening', 'team.assign']);
  // Consent given for the CLI does not cover Jev
  const cliOnly = planBulk(catalogue, ['flow.bounce'], 'shadow', () => 'off', () => ({ ...jevConsent, providers: ['cli'] }), 'jev');
  assert.equal(cliOnly.needConsent.length, 1);
});

test('turning points off never asks for consent', () => {
  const result = plan('off', 'jev', { 'flow.bounce': 'active', 'board.triage': 'shadow' });
  assert.equal(result.needConsent.length, 0);
  assert.deepEqual(result.changes.map((change) => change.id), ['flow.bounce', 'board.triage']);
  assert.deepEqual(result.unchanged, ['health.test-weakening', 'team.assign']);
});

test('the bulk consent dialog lists every point with its name, id and target mode, and a single agree', async () => {
  await i18n.changeLanguage('en');
  const items = catalogue.slice(0, 2).map((point, index) => ({
    info: point,
    name: `Point ${index}`,
    mode: index === 0 ? ('shadow' as const) : ('active' as const),
    consent: null,
  }));
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <BulkConsentBody items={items} previews={[{ point: 'flow.bounce', provider: 'jev', source: 'built', stateVersion: 2, bytes: 2048, state: { card: 'x' } }, undefined]} leaves error={null} />
    </TooltipProvider>,
  );
  assert.match(html, /Before moving 2 points/);
  assert.match(html, /Point 0/);
  assert.match(html, /flow\.bounce/);
  assert.match(html, /board\.triage/);
  assert.match(html, /api\.typesafe\.ai/);
  assert.match(html, /2[.,]0 KB/);
});
