// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionPointStats, DecisionStats } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n, { setLanguage } from '../src/i18n';
import { DecisionsLineView } from '../src/components/DecisionsLine';

// The Usage page's decisions line (D3 u5): what Jev cost and how many Claude runs were saved.

const stat = (count: number): DecisionPointStats => ({
  point: 'board.triage',
  count,
  acted: 0,
  unavailable: 0,
  meanConfidence: null,
  resolved: 0,
  agreed: 0,
  useful: 0,
  notUseful: 0,
  costUsd: 0,
  runsSaved: 0,
  runsCaused: 0,
  netRuns: 0,
  resolvedDirect: 0,
  resolvedProxy: 0,
  baseline: { rows: 0, differs: 0, decisionRight: 0, baselineRight: 0, unresolved: 0 },
  evidence: {
    point: 'board.triage',
    answered: 0,
    resolvedDirect: 0,
    resolvedProxy: 0,
    unresolved: 0,
    precision: { n: 0, hits: 0, value: null, lower90: null },
    baselinePrecision: { n: 0, hits: 0, value: null, lower90: null },
    baseline: { rows: 0, differs: 0, decisionRight: 0, baselineRight: 0, unresolved: 0 },
    calibration: [],
    actRate: { n: 0, hits: 0, value: null, lower90: null },
  },
});
const stats = (count: number, over: Partial<DecisionStats> = {}): DecisionStats => ({ since: '2026-09-01T00:00:00.000Z', points: [stat(count)], jevCostUsd: 0.38, runsSaved: 37, runsCaused: 0, netRuns: 37, claudeRunsSaved: 37, ...over });
const render = (value: DecisionStats) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <DecisionsLineView stats={value} />
    </MemoryRouter>,
  );

test('the line says what Jev cost and the net in runs, with a link to the history', async () => {
  // setLanguage, not changeLanguage alone: the cost is an Intl format, which follows the stored
  // language, and CI's locale is not the developer's
  setLanguage('en');
  await i18n.changeLanguage('en');
  const html = render(stats(12));
  assert.match(html, /Decisions/);
  assert.match(html, /Jev (US)?\$?0[.,]38/);
  assert.match(html, /Net: 37 agent runs saved \(37 saved, 0 caused\)/);
  assert.match(html, /href="\/settings\/decisions\/history"/);
  assert.doesNotMatch(html, /agent runs saved<\/span>/);
  setLanguage('es');
  await i18n.changeLanguage('es');
  assert.match(render(stats(12, { runsSaved: 1, runsCaused: 0, netRuns: 1 })), /Neto: 1 ejecución del agente ahorrada \(1 ahorradas, 0 provocadas\)/);
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('the net counts what the decisions caused against what they saved, and says so when it is a cost or nothing', async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
  assert.match(render(stats(12, { runsSaved: 3, runsCaused: 8, netRuns: -5 })), /Net: 5 agent runs added \(3 saved, 8 caused\)/);
  assert.match(render(stats(12, { runsSaved: 4, runsCaused: 3, netRuns: 1 })), /Net: 1 agent run saved \(4 saved, 3 caused\)/);
  assert.match(render(stats(12, { runsSaved: 2, runsCaused: 2, netRuns: 0 })), /Net: no agent runs saved or added \(2 saved, 2 caused\)/);
});

test('the line is hidden when no decision was recorded in the window', async () => {
  await i18n.changeLanguage('en');
  assert.equal(render(stats(0)), '');
  assert.equal(render({ ...stats(0), points: [] }), '');
});

test('the line shows a Jev cost below a cent to four decimals, in English and Spanish', async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
  assert.match(render(stats(12, { jevCostUsd: 0.0032 })), /Jev \$0\.0032/);
  setLanguage('es');
  await i18n.changeLanguage('es');
  assert.match(render(stats(12, { jevCostUsd: 0.0032 })), /Jev 0,0032\u00a0US\$/);
  setLanguage('en');
  await i18n.changeLanguage('en');
});
