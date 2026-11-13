// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionActivationIssue } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiRequestError } from '../src/api';
import i18n, { setLanguage } from '../src/i18n';
import { SaveError, savedNotice } from '../src/pages/config/decisions/ActivationRefusal';

// The promotion gate on save (docs/plans/decision-engine-v2.md §5): a refusal says which points and
// what each lacks, and a save that went through says once what it let pass.

const reading = (shortfalls: DecisionActivationIssue['live']['shortfalls'], cases = 12): DecisionActivationIssue['live'] => ({
  source: 'live',
  at: null,
  cases,
  precision: { n: 0, hits: 0, value: null, lower90: null },
  baselinePrecision: { n: 0, hits: 0, value: null, lower90: null },
  actRate: { n: 0, hits: 0, value: null, lower90: null },
  shortfalls,
});
const issue = (point: DecisionActivationIssue['point'], shortfalls: DecisionActivationIssue['live']['shortfalls']): DecisionActivationIssue => ({
  point,
  kind: 'act',
  standing: 'unproven',
  decidedBy: null,
  live: reading(shortfalls),
  replay: null,
  gate: { enforced: true, minCases: 30, breakEven: 0.5, minPrecision: null, maxFlagRate: null },
});
const refusal = (code: string, points: DecisionActivationIssue[]) => {
  const error = new ApiRequestError('Refused', 409, undefined, code);
  error.refused = points;
  return error;
};
const render = (error: unknown) => renderToStaticMarkup(<SaveError error={error} />);
const plain = (text: string) => text.replace(/\s/g, ' ');

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('a refused save names each point and what it lacks, and says the changes are still there', () => {
  const out = plain(render(refusal('decision-unproven', [issue('flow.bounce', ['cases']), issue('team.assign', ['break-even', 'baseline'])])));
  assert.match(out, /Not saved: 2 points cannot be Active yet/);
  assert.match(out, /data-point="flow\.bounce"[^>]*>[^<]*needs 18 more cases with a known outcome\./);
  assert.match(out, /data-point="team\.assign"[^>]*>[^<]*needs a precision above 50% and better results than today's rule\./);
  assert.match(out, /Your changes are still here\./);
  assert.match(out, /alert-warn/);
});

test('a bulk refusal says to activate one point at a time, and still names the points', () => {
  const out = plain(render(refusal('decision-bulk-activation', [issue('flow.bounce', ['cases']), issue('team.assign', ['cases'])])));
  assert.match(out, /Not saved: activate one point at a time/);
  assert.match(out, /Set one to Active, save, and then the next\./);
  assert.match(out, /data-point="team\.assign"/);
});

test('the refusal speaks Spanish for a Spanish reader', async () => {
  setLanguage('es');
  await i18n.changeLanguage('es');
  const out = plain(render(refusal('decision-unproven', [issue('flow.bounce', ['cases'])])));
  assert.match(out, /No se ha guardado: 1 punto aún no puede estar Activo/);
  assert.match(out, /necesita 18 casos más con resultado conocido\./);
  assert.match(out, /Tus cambios siguen aquí\./);
});

test('any other failure keeps the ordinary error box', () => {
  const out = render(new ApiRequestError('Disk full', 500));
  assert.match(out, /alert-bad/);
  assert.match(out, /Disk full/);
  assert.doesNotMatch(out, /Not saved/);
  assert.equal(render(null), '');
});

test('a save that let suggest points through says it once, in one notice, naming them', () => {
  const t = i18n.getFixedT('en', 'decisions');
  assert.deepEqual(savedNotice(t, []), { tone: 'ok', title: 'Decision settings saved' });
  const notice = savedNotice(t, [{ ...issue('board.triage', ['cases']), kind: 'suggest' }, { ...issue('memory.triage', ['cases']), kind: 'suggest' }]);
  assert.equal(notice.tone, 'warn');
  assert.equal(notice.title, 'Decision settings saved');
  assert.match(notice.detail ?? '', /^Active without proof yet: .+ and .+\.$/);
});
