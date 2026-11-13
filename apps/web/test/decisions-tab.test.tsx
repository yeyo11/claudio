// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionPointInfo, DecisionPointStats, DecisionSettings } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import i18n, { setLanguage } from '../src/i18n';
import { CapLine, EngineSection } from '../src/pages/config/decisions/Engine';
import { activeBlocked, AUTO_SIGNAL_KINDS, orderSignals, bestReading, capConsequence, draftOf, gateBlocked, examplePoint, offUntilConsent, standingInforms, supervisorMeaning, supervisorOn } from '../src/pages/config/decisions/model';
import { gateMissing } from '../src/pages/config/decisions/gate';
import { PointRow } from '../src/pages/config/decisions/Points';
import { detailsOf, resolveSettingsAddress, sectionsOf } from '../src/pages/config/settingsGroups';

// Settings → Decisions (docs/plans/settings-ia.md §7): where it lives, where the old Supervisor
// link lands, what a point's row of evidence says, and what Who answers and the cap tell.

const info = (over: Partial<DecisionPointInfo> = {}): DecisionPointInfo => ({
  id: 'flow.refine-needed',
  kind: 'act',
  scope: 'project',
  primitives: ['choice'],
  defaultThreshold: 0.85,
  savesRun: true,
  causesRun: false,
  needsLowLatency: false,
  stateVersion: 2,
  effective: { mode: 'off', threshold: 0.85, provider: 'cli', consent: null, limited: false, limitedBy: null, floor: null },
  standing: 'unproven',
  decidedBy: null,
  evidencePossible: true,
  gate: { enforced: true, minCases: 30, breakEven: 0.5, minPrecision: null, maxFlagRate: null },
  live: { source: 'live', at: null, cases: 0, precision: { n: 0, hits: 0, value: null, lower90: null }, baselinePrecision: { n: 0, hits: 0, value: null, lower90: null }, actRate: { n: 0, hits: 0, value: null, lower90: null }, shortfalls: ['cases'] },
  replay: null,
  demoted: null,
  ...over,
});

const settings = (points: DecisionSettings['points'] = {}, over: Partial<DecisionSettings> = {}): DecisionSettings => ({
  provider: 'cli',
  cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02, supervisorMaxCostUsd: 0.25 },
  jev: { model: 'jev-1.13.0', keySet: false, keyHint: null },
  supervisor: { autoSignals: [] },
  points,
  historyDays: 30,
  gate: { minCases: 30, suggestMinPrecision: 0.6, suggestMaxFlagRate: 0.3 },
  ...over,
});

const stats = (over: Partial<DecisionPointStats> = {}): DecisionPointStats => ({
  point: 'flow.refine-needed',
  count: 41,
  acted: 26,
  unavailable: 2,
  meanConfidence: 0.91,
  resolved: 24,
  agreed: 21,
  useful: 5,
  notUseful: 1,
  costUsd: 0.004,
  runsSaved: 12,
  runsCaused: 0,
  netRuns: 12,
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
  ...over,
});

const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ToastProvider>
          <ConfirmProvider>
            <TooltipProvider>{node}</TooltipProvider>
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const row = (point: DecisionPointInfo, saved: DecisionSettings, provider: 'cli' | 'jev', point_stats?: DecisionPointStats | null) =>
  html(
    <PointRow
      info={point}
      settings={saved}
      provider={provider}
      draft={{ ...draftOf(saved), provider }}
      stats={point_stats}
      onMode={() => undefined}
      onThreshold={() => undefined}
      onFloor={() => undefined}
      onAutoSignals={() => undefined}
      onWithdraw={() => undefined}
    />,
  );

const engine = (saved: DecisionSettings, decisions: number | null = 0, advancedOpen = false) =>
  html(
    <EngineSection
      saved={saved}
      draft={draftOf(saved)}
      patch={() => undefined}
      costValid
      supervisorCostValid
      daysValid
      decisions={decisions}
      advancedOpen={advancedOpen}
      onAdvanced={() => undefined}
      onExample={() => undefined}
      onReset={() => undefined}
    />,
  );

test.beforeEach(async () => {
  // setLanguage, not changeLanguage alone: money and figures are Intl formats, which follow the stored
  // language, and CI's locale is not the developer's (it read "$0.40" in a Spanish sentence there)
  setLanguage('es');
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

test("a point's row is its own anchor and search target", () => {
  const out = row(info(), settings(), 'cli', null);
  assert.match(out, /id="point-flow-refine-needed"/);
  assert.match(out, /data-setting="point-flow-refine-needed"/);
});

test('an act point on the CLI cannot be active, says why, and shows no threshold', () => {
  const consent = { at: '2026-09-30T10:00:00Z', stateVersion: 2, providers: ['cli' as const] };
  const out = row(info(), settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }), 'cli', null);
  assert.match(out, /aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Activo/s);
  // A threshold acts only on Jev's probabilities
  assert.doesNotMatch(out, /Umbral de/);
});

test('under Jev an act point that is not off shows its threshold; a suggest point never does', () => {
  const consent = { at: '2026-09-30T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const act = row(info(), settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }), 'jev', null);
  assert.match(act, /Umbral de flow\.refine-needed/);
  const off = row(info(), settings(), 'jev', null);
  assert.doesNotMatch(off, /Umbral de/);
  const suggest = row(info({ id: 'board.triage', kind: 'suggest' }), settings({ 'board.triage': { mode: 'shadow', threshold: 0.85, consent } }), 'jev', null);
  assert.doesNotMatch(suggest, /Umbral de/);
});

test("the evidence line counts, says what is known for sure, the precision and the difference with today's rule, and links its disagreements to History", () => {
  const scored = stats({
    resolvedDirect: 30,
    baseline: { rows: 40, differs: 10, decisionRight: 6, baselineRight: 2, unresolved: 2 },
    evidence: { ...stats().evidence, precision: { n: 20, hits: 18, value: 0.9, lower90: 0.76 } },
  });
  const out = row(info(), settings(), 'cli', scored);
  assert.match(out, /41 decisiones/);
  assert.match(out, /30 con resultado conocido/);
  assert.match(out, /acierta en un 90\s?% cuando actúa/);
  assert.match(out, /difiere de la regla de siempre en un 25\s?% de las respuestas/);
  assert.match(out, /href="\/settings\/decisions\/history\?point=flow\.refine-needed"[^>]*>3 discrepancias</);
  // A suggest point flags rather than acts, and the old "agrees with you" line is gone
  assert.match(row(info({ kind: 'suggest' }), settings(), 'cli', scored), /acierta en un 90\s?% cuando avisa/);
  assert.doesNotMatch(out, /coincide contigo/);
  assert.match(row(info(), settings(), 'cli', null), /Aún no hay decisiones/);
});

const shadowSaved = () => settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent: null } });

test('the row says where the point stands in words: unproven, proven or failing', () => {
  assert.match(row(info({ standing: 'unproven' }), shadowSaved(), 'cli', null), /badge-muted[^>]*>(?:(?!<\/span>).)*(?:<span[^>]*>)?Sin demostrar/s);
  assert.match(row(info({ standing: 'proven' }), shadowSaved(), 'cli', null), /badge-ok[^>]*>(?:(?!<\/span>).)*(?:<span[^>]*>)?Demostrado/s);
  assert.match(row(info({ standing: 'failing' }), shadowSaved(), 'cli', null), /badge-warn[^>]*>(?:(?!<\/span>).)*(?:<span[^>]*>)?Con fallos/s);
});

test('the standing badge shows only when it informs a decision: the point is on, has cases behind it or was demoted', () => {
  const badge = /class="badge /;
  // An Off point nobody has read keeps the row it had before standing existed
  assert.doesNotMatch(row(info(), settings(), 'cli', null), badge);
  assert.match(row(info(), shadowSaved(), 'cli', null), badge);
  const reading = { ...info().live, cases: 12 };
  assert.match(row(info({ live: reading }), settings(), 'cli', null), badge);
  assert.match(row(info({ replay: { ...reading, source: 'replay', at: '2026-11-01T10:00:00Z' } }), settings(), 'cli', null), badge);
  const evidence = { cases: 40, precision: { n: 20, hits: 9, value: 0.45, lower90: 0.3 }, breakEven: 0.5, shortfalls: ['break-even' as const], recentRows: 30, recentActs: 25, recentRate: 0.83, promotedRate: 0.3 };
  assert.match(row(info({ demoted: { at: '2026-11-10T10:00:00Z', reason: 'failing', evidence } }), settings(), 'cli', null), badge);
  assert.equal(standingInforms(info(), 'off'), false);
  assert.equal(standingInforms(info(), 'active'), true);
});

test('the reason Active is out of reach is written on the row for a point in play, and a point left off says nothing more', () => {
  const needs = /Activo se gana: aún necesita 30 casos más con resultado conocido\./;
  // Visible text, not only the segment's title: a tap on a phone opens no tooltip
  const shown = row(info(), shadowSaved(), 'jev', null);
  assert.match(shown, /<p class="dp-point-line">Activo se gana: aún necesita/);
  assert.match(shown, needs);
  // The accessible text stays in the segment, so the check is on the row's own line
  assert.doesNotMatch(row(info(), settings(), 'jev', null), /<p class="dp-point-line">/);
  assert.match(row(info({ evidencePossible: false }), shadowSaved(), 'jev', null), /<p class="dp-point-line">Ningún resultado/);
  assert.doesNotMatch(row(info({ standing: 'proven' }), shadowSaved(), 'jev', null), /<p class="dp-point-line">/);
});

test('active in name only, the row says why in one sentence, and says nothing when the point is off or acts', () => {
  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const active = settings({ 'flow.refine-needed': { mode: 'active', threshold: 0.85, consent } }, { provider: 'jev' });
  const limited = (limitedBy: 'cli' | 'unproven' | 'failing' | 'no-consent' | 'demoted' | null, standing: DecisionPointInfo['standing'] = 'unproven') =>
    row(info({ standing, effective: { ...info().effective, mode: 'active', limited: limitedBy !== null, limitedBy } }), active, 'jev', null);
  assert.match(limited('unproven'), /Funciona como Sombra: aún necesita 30 casos más con resultado conocido\./);
  assert.match(limited('failing', 'failing'), /Funciona como Sombra: ya no supera el listón y necesita 30 casos más con resultado conocido\./);
  assert.match(limited('cli'), /Funciona como Sombra: el CLI no da una confianza/);
  // Consent and a demotion have their own words elsewhere in the row
  assert.doesNotMatch(limited('no-consent'), /Funciona como Sombra/);
  assert.doesNotMatch(limited('demoted'), /Funciona como Sombra/);
  assert.doesNotMatch(limited(null), /Funciona como Sombra/);
  // What was asked in this form and not yet saved is not what the server read
  const off = settings({ 'flow.refine-needed': { mode: 'off', threshold: 0.85, consent } }, { provider: 'jev' });
  assert.doesNotMatch(row(info({ effective: { ...info().effective, mode: 'active', limited: true, limitedBy: 'unproven' } }), off, 'jev', null), /Funciona como Sombra/);
});

test('a point no outcome can prove says so instead of asking for cases that cannot arrive', () => {
  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const active = settings({ 'flow.refine-needed': { mode: 'active', threshold: 0.85, consent } }, { provider: 'jev' });
  const shadow = settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }, { provider: 'jev' });
  const held = info({ evidencePossible: false, effective: { ...info().effective, mode: 'active', limited: true, limitedBy: 'unproven' } });
  const sentence = /Ningún resultado que Claudio pueda observar demuestra este punto; solo tu propio útil o no útil\./;
  const out = row(held, active, 'jev', null);
  assert.match(out, sentence);
  assert.doesNotMatch(out, /aún necesita 30 casos/);
  // The standing tag stays
  assert.match(out, /Sin demostrar/);
  // The reason Active is not offered says the same
  assert.match(row(info({ evidencePossible: false }), shadow, 'jev', null), sentence);
  // A point that can be proven keeps asking for its cases
  assert.match(row(info({ effective: held.effective }), active, 'jev', null), /aún necesita 30 casos más/);
});

test('a proven or failing point says which reading decided, and an unproven one says nothing of it', () => {
  assert.match(row(info({ standing: 'proven', decidedBy: 'live' }), shadowSaved(), 'cli', null), /Demostrado[\s\S]*según su historial/);
  assert.match(row(info({ standing: 'proven', decidedBy: 'replay' }), shadowSaved(), 'cli', null), /Demostrado[\s\S]*según una repetición/);
  assert.match(row(info({ standing: 'failing', decidedBy: 'live' }), shadowSaved(), 'cli', null), /Con fallos[\s\S]*según su historial/);
  const unproven = row(info({ standing: 'unproven', decidedBy: null }), settings(), 'cli', null);
  assert.doesNotMatch(unproven, /según su historial|según una repetición/);
});

test('a demoted point says when and why it went back to Shadow', () => {
  const evidence = { cases: 40, precision: { n: 20, hits: 9, value: 0.45, lower90: 0.3 }, breakEven: 0.5, shortfalls: ['break-even' as const], recentRows: 30, recentActs: 25, recentRate: 0.83, promotedRate: 0.3 };
  const failing = row(info({ demoted: { at: '2026-11-10T10:00:00Z', reason: 'failing', evidence } }), settings(), 'cli', null);
  assert.match(failing, /Volvió a Sombra el [^:]+: acertó 9 de 20 respuestas que actuaban, por debajo del listón\./);
  const rate = row(info({ demoted: { at: '2026-11-10T10:00:00Z', reason: 'rate', evidence } }), settings(), 'cli', null);
  assert.match(rate, /en los últimos 7 días actuó en 25 de 30 respuestas, más del doble que en Sombra/);
});

test('Active is not offered to a point that has not earned it, with the reason, and is once it is proven or already active', () => {
  const disabledActive = /aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Activo/s;
  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const shadow = settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }, { provider: 'jev' });
  assert.match(row(info(), shadow, 'jev', null), disabledActive);
  assert.match(row(info({ standing: 'failing' }), shadow, 'jev', null), disabledActive);
  assert.doesNotMatch(row(info({ standing: 'proven' }), shadow, 'jev', null), disabledActive);
  // A suggest point whose gate is not enforced may be activated (the server answers with a warning)
  const free = info({ kind: 'suggest', gate: { enforced: false, minCases: 30, breakEven: null, minPrecision: 0.6, maxFlagRate: 0.3 } });
  assert.doesNotMatch(row(free, shadow, 'jev', null), disabledActive);
  // Already active: the control does not turn against a point the person chose before
  const active = settings({ 'flow.refine-needed': { mode: 'active', threshold: 0.85, consent } }, { provider: 'jev' });
  assert.doesNotMatch(row(info(), active, 'jev', null), disabledActive);
  assert.equal(gateBlocked(info(), 'shadow'), true);
  assert.equal(gateBlocked(info(), 'active'), false);
  // Saved as active: the form moving it to Shadow does not close the way back, the server judges a step up from what is saved
  assert.equal(gateBlocked(info(), 'shadow', 'active'), false);
  assert.equal(gateBlocked(info(), 'shadow', 'shadow'), true);
});

test('the reason Active is out of reach names what is missing, from the gate in force', () => {
  const t = i18n.getFixedT('es', 'decisions');
  const act = info({ gate: { enforced: true, minCases: 30, breakEven: 0.5, minPrecision: null, maxFlagRate: null }, live: { ...info().live, cases: 12, shortfalls: ['cases', 'break-even', 'baseline'] } });
  // Spanish writes "50 %" with a no-break space: compare the words, not the kind of space
  const plain = (text: string) => text.replace(/\s/g, ' ');
  assert.equal(plain(gateMissing(t, act.gate, bestReading(act.live, act.replay))), '18 casos más con resultado conocido, una precisión por encima de 50 % y mejores resultados que la regla de siempre');
  const suggest = info({ kind: 'suggest', gate: { enforced: true, minCases: 30, breakEven: null, minPrecision: 0.6, maxFlagRate: 0.3 }, live: { ...info().live, shortfalls: ['precision', 'flag-rate'] } });
  assert.equal(plain(gateMissing(t, suggest.gate, suggest.live)), 'una precisión de al menos 60 % y avisar como mucho en 30 % de las respuestas');
  // A replay that lacks less is the reading the standing came from
  const replay = { ...act.live, source: 'replay' as const, shortfalls: ['baseline' as const] };
  assert.equal(bestReading(act.live, replay), replay);
  assert.equal(bestReading(act.live, null), act.live);
});

test("a suggest point under Jev takes its floor with the row's slider; an act point and the CLI do not", () => {
  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const suggest = info({ id: 'board.triage', kind: 'suggest', effective: { ...info().effective, floor: 0.7 } });
  const shadow = settings({ 'board.triage': { mode: 'shadow', threshold: 0.85, floor: 0.8, consent } }, { provider: 'jev' });
  const out = row(suggest, shadow, 'jev', null);
  assert.match(out, /Confianza mínima de board\.triage/);
  assert.match(out, /<output>0,80<\/output>/);
  assert.doesNotMatch(out, /Umbral de/);
  // The CLI gives no confidence, so there is nothing to hold a suggestion to
  assert.doesNotMatch(row(suggest, settings({ 'board.triage': { mode: 'shadow', threshold: 0.85, consent } }), 'cli', null), /Confianza mínima de/);
  assert.doesNotMatch(row(suggest, settings(), 'jev', null), /Confianza mínima de/);
  // Unset, the slider reads the server's floor
  assert.match(row(suggest, settings({ 'board.triage': { mode: 'shadow', threshold: 0.85, consent } }, { provider: 'jev' }), 'jev', null), /<output>0,70<\/output>/);
  assert.doesNotMatch(row(info(), shadow, 'jev', null), /Confianza mínima de/);
});

test('consent shows only on a point that is not off, with its date and a way to withdraw it', () => {
  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['cli' as const] };
  const off = row(info(), settings({ 'flow.refine-needed': { mode: 'off', threshold: 0.85, consent } }), 'cli', null);
  assert.doesNotMatch(off, /Consentido|Retirar|Sin consentir/);
  const shadow = row(info(), settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }), 'cli', null);
  assert.match(shadow, /Consentido el/);
  assert.match(shadow, />Retirar</);
  const stale = row(info({ stateVersion: 3 }), settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }), 'cli', null);
  assert.match(stale, /Volverá a preguntar/);
});

test("the Supervisor's point can be active on the CLI, and its row says what each mode does", () => {
  const supervisor = info({ id: 'supervisor.intervene', kind: 'act', scope: 'global' });
  assert.equal(activeBlocked(supervisor, 'cli'), false);
  assert.equal(activeBlocked(info(), 'cli'), true);
  assert.equal(activeBlocked(info(), 'jev'), false);

  assert.equal(supervisorMeaning('off', 'cli'), 'off');
  assert.equal(supervisorMeaning('shadow', 'jev'), 'shadow');
  assert.equal(supervisorMeaning('active', 'cli'), 'activeCli');
  assert.equal(supervisorMeaning('active', 'jev'), 'activeJev');

  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['cli' as const, 'jev' as const] };
  const at = (mode: 'off' | 'shadow' | 'active', provider: 'cli' | 'jev') =>
    row(supervisor, settings({ 'supervisor.intervene': { mode, threshold: 0.85, consent } }), provider, null);
  const cliActive = at('active', 'cli');
  assert.doesNotMatch(cliActive, /aria-disabled="true"/);
  assert.match(cliActive, /Envía por su cuenta los tipos que elijas y propone el resto/);
  assert.match(at('active', 'jev'), /Envía por su cuenta, cuando Jev espera que ayude, los tipos que elijas/);
  assert.match(at('shadow', 'cli'), /Propone pistas para que las envíes tú/);
  assert.match(at('off', 'cli'), /No vigila/);

  // Active on the CLI without consent is Active in full for the Supervisor, as the engine has it
  const unconsented = (provider: 'cli' | 'jev') =>
    row(supervisor, settings({ 'supervisor.intervene': { mode: 'active', threshold: 0.85, consent: null } }), provider, null);
  assert.doesNotMatch(unconsented('cli'), /Apagado hasta que tenga consentimiento/);
  assert.match(unconsented('jev'), /Apagado hasta que tenga consentimiento/);
  // Without consent the engine does nothing: the Supervisor's line says it is off, not that it proposes
  assert.match(unconsented('jev'), /No vigila/);
  assert.match(unconsented('cli'), /Envía por su cuenta los tipos que elijas y propone el resto/);
});

test("the Supervisor's Active is never held back for proof, and lists the kinds it sends on its own only while Active", () => {
  const supervisor = info({ id: 'supervisor.intervene', kind: 'act', scope: 'global' });
  assert.equal(gateBlocked(supervisor, 'shadow'), false);
  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['cli' as const] };
  const at = (mode: 'off' | 'shadow' | 'active', autoSignals: Array<'loop' | 'silence'> = []) => {
    const saved = settings({ 'supervisor.intervene': { mode, threshold: 0.85, consent } }, { supervisor: { autoSignals } });
    return row(supervisor, saved, 'cli', null);
  };
  assert.doesNotMatch(at('shadow'), /aria-disabled="true"/);
  // Folded to one line with the count, so a phone does not open on a column of checkboxes
  const active = at('active', ['loop', 'silence']);
  assert.match(active, /Envía por su cuenta 2 de 9 tipos de señal/);
  assert.equal(active.match(/role="checkbox"/g)?.length ?? 0, 0);
  assert.doesNotMatch(at('shadow'), /tipos de señal/);
  assert.doesNotMatch(at('off'), /tipos de señal/);
  assert.deepEqual(orderSignals(['silence', 'loop', 'hung-command']), ['hung-command', 'loop', 'silence']);
  assert.deepEqual(orderSignals(['waiting', 'loop']), ['loop', 'waiting']);
  assert.equal(AUTO_SIGNAL_KINDS.length, 9);
});

test('a point that is not off and has no consent says it is off, and offers the way out', () => {
  const unconsented = (mode: 'off' | 'shadow' | 'active', onReview = true) => {
    const saved = settings({ 'flow.refine-needed': { mode, threshold: 0.85, consent: null } });
    return html(
      <PointRow
        info={info()}
        settings={saved}
        provider="jev"
        draft={{ ...draftOf(saved), provider: 'jev' }}
        stats={null}
        onMode={() => undefined}
        onThreshold={() => undefined}
        onFloor={() => undefined}
        onAutoSignals={() => undefined}
        {...(onReview ? { onReviewConsent: () => undefined } : {})}
      />,
    );
  };
  for (const mode of ['shadow', 'active'] as const) {
    const out = unconsented(mode);
    assert.match(out, /Apagado hasta que tenga consentimiento\./);
    assert.match(out, />Revisar y consentir</);
    assert.doesNotMatch(out, /Funciona como sombra/);
  }
  const off = unconsented('off');
  assert.doesNotMatch(off, /Apagado hasta que tenga consentimiento/);
  assert.doesNotMatch(off, /Revisar y consentir/);
  // A row with nobody to open the dialog keeps the warning but draws no dead link
  assert.doesNotMatch(unconsented('shadow', false), /Revisar y consentir/);

  const consent = { at: '2026-10-17T10:00:00Z', stateVersion: 2, providers: ['jev' as const] };
  const given = row(info(), settings({ 'flow.refine-needed': { mode: 'shadow', threshold: 0.85, consent } }), 'jev', null);
  assert.match(given, /Consentido el/);
  assert.doesNotMatch(given, /Apagado hasta que tenga consentimiento/);

  assert.equal(offUntilConsent(info(), null, 'shadow', 'cli'), true);
  assert.equal(offUntilConsent(info(), null, 'off', 'cli'), false);
  assert.equal(offUntilConsent(info({ id: 'supervisor.intervene', kind: 'act' }), null, 'active', 'cli'), false);
  assert.equal(offUntilConsent(info({ id: 'supervisor.intervene', kind: 'act' }), null, 'shadow', 'cli'), true);
});

test("the example payload is the first consented point's, or the Supervisor's when none is", () => {
  const order = ['flow.bounce', 'board.triage', 'supervisor.intervene'] as const;
  assert.equal(examplePoint(order, (id) => id === 'board.triage'), 'board.triage');
  assert.equal(examplePoint(order, () => false), 'supervisor.intervene');
});

test("the cap's consequence: a day's cost at the window's volume, and how many fit in the daily cap", () => {
  // 600 decisions over 30 days is 20 a day: 20 × $0.02 = $0.40
  assert.deepEqual(capConsequence(0.02, 600, 30, null), { perDayUsd: 0.4, withinDaily: null });
  assert.deepEqual(capConsequence(0.02, 600, 30, 5), { perDayUsd: 0.4, withinDaily: 250 });
  assert.deepEqual(capConsequence(0.02, 0, 30, null), { perDayUsd: null, withinDaily: null });
  // An invalid cap promises nothing
  assert.deepEqual(capConsequence(0, 600, 30, 5), { perDayUsd: null, withinDaily: null });

  assert.match(html(<CapLine cap={0.02} decisions={600} days={30} dailyCapUsd={5} />), /≈ 0,40\s?US\$ al día con el volumen de hoy/);
  const within = html(<CapLine cap={0.02} decisions={600} days={30} dailyCapUsd={5} />);
  assert.match(within, /href="\/settings\/runs#spend-cap"[^>]*>≈ 250 decisiones al día dentro de tu tope</);
  assert.match(html(<CapLine cap={0.02} decisions={0} days={30} dailyCapUsd={null} />), /Como mucho 0,02\s?US\$ por decisión/);
});

test('Who answers: the CLI keeps everything here; Jev reveals its key and model and links an example payload', () => {
  const cli = engine(settings());
  assert.match(cli, /Usa tu cuota de Claude Code\. Nada sale de esta máquina\./);
  assert.match(cli, /class="settings-reveal" inert/);
  assert.doesNotMatch(cli, /Ver un ejemplo de lo que se envía/);
  // Beta once, on the Jev option, and no privacy box
  assert.equal(cli.match(/Beta/g)?.length, 1);
  assert.doesNotMatch(cli, /Privacidad/);

  const jev = engine(settings({}, { provider: 'jev' }));
  assert.match(jev, /Envía a Jev el estado declarado de cada punto\./);
  assert.match(jev, /Ver un ejemplo de lo que se envía/);
  assert.match(jev, /class="settings-reveal is-open"/);
  assert.match(jev, /<span class="dp-mono">jev-1\.13\.0<\/span>, fijado/);
  assert.match(jev, /data-setting="engine\.jev-key"/);
  assert.match(jev, /data-setting="engine\.cap"/);
});

test("the Supervisor's cap shows only while its point is not off, under the CLI and under Jev", () => {
  const point = (mode: 'off' | 'shadow' | 'active') => ({ 'supervisor.intervene': { mode, threshold: 0.85, consent: null } });
  const cap = /data-setting="engine\.supervisor-cap"/;
  // A settings document with no row for the point has it off too
  assert.doesNotMatch(engine(settings(), 0, true), cap);
  assert.doesNotMatch(engine(settings(point('off')), 0, true), cap);
  assert.doesNotMatch(engine(settings(point('off'), { provider: 'jev' }), 0, true), cap);
  assert.match(engine(settings(point('shadow')), 0, true), cap);
  assert.match(engine(settings(point('active')), 0, true), cap);
  // Under Jev the Supervisor still drafts its hint with a CLI chat, whose cost the cap bounds
  assert.match(engine(settings(point('active'), { provider: 'jev' }), 0, true), cap);

  assert.equal(supervisorOn({ points: {} }), false);
  assert.equal(supervisorOn({ points: { 'supervisor.intervene': { mode: 'shadow', threshold: 0.85 } } }), true);
});

test('an invalid Supervisor cap stays visible with the Supervisor off, so no hidden error blocks Save', () => {
  const saved = settings({ 'supervisor.intervene': { mode: 'off', threshold: 0.85, consent: null } });
  const out = html(
    <EngineSection
      saved={saved}
      draft={{ ...draftOf(saved), cli: { ...saved.cli, supervisorMaxCostUsd: 0 } }}
      patch={() => undefined}
      costValid
      supervisorCostValid={false}
      daysValid
      decisions={0}
      advancedOpen
      onAdvanced={() => undefined}
      onExample={() => undefined}
      onReset={() => undefined}
    />,
  );
  assert.match(out, /data-setting="engine\.supervisor-cap"/);
});
