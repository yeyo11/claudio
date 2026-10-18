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
import { activeBlocked, capConsequence, draftOf, examplePoint, isLimited, supervisorMeaning } from '../src/pages/config/decisions/model';
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
  needsLowLatency: false,
  stateVersion: 2,
  effective: { mode: 'off', threshold: 0.85, provider: 'cli', consent: null, limited: false },
  ...over,
});

const settings = (points: DecisionSettings['points'] = {}, over: Partial<DecisionSettings> = {}): DecisionSettings => ({
  provider: 'cli',
  cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02 },
  jev: { model: 'jev-1.13.0', keySet: false, keyHint: null },
  points,
  historyDays: 30,
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
      onWithdraw={() => undefined}
    />,
  );

const engine = (saved: DecisionSettings, decisions: number | null = 0) =>
  html(
    <EngineSection
      saved={saved}
      draft={draftOf(saved)}
      patch={() => undefined}
      costValid
      daysValid
      decisions={decisions}
      advancedOpen={false}
      onAdvanced={() => undefined}
      onExample={() => undefined}
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

test('the evidence line counts, agrees and links its disagreements to History filtered by the point', () => {
  const out = row(info(), settings(), 'cli', stats());
  assert.match(out, /41 decisiones/);
  assert.match(out, /coincide contigo en un 88\s?%/);
  assert.match(out, /href="\/settings\/decisions\/history\?point=flow\.refine-needed"[^>]*>3 discrepancias</);
  assert.match(row(info(), settings(), 'cli', null), /Aún no hay decisiones/);
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
  assert.match(cliActive, /Envía cada pista por su cuenta/);
  assert.match(at('active', 'jev'), /Envía una pista cuando Jev espera que ayude/);
  assert.match(at('shadow', 'cli'), /Propone pistas para que las envíes tú/);
  assert.match(at('off', 'cli'), /No vigila/);

  // Active on the CLI without consent is Active in full for the Supervisor, as the engine has it
  const unconsented = (provider: 'cli' | 'jev') =>
    row(supervisor, settings({ 'supervisor.intervene': { mode: 'active', threshold: 0.85, consent: null } }), provider, null);
  assert.doesNotMatch(unconsented('cli'), /Funciona como sombra/);
  assert.match(unconsented('jev'), /Funciona como sombra hasta que tenga consentimiento/);
  assert.match(unconsented('jev'), /Propone pistas para que las envíes tú/);
  assert.match(unconsented('cli'), /Envía cada pista por su cuenta/);
  assert.equal(isLimited(supervisor, null, 'active', 'cli'), false);
  assert.equal(isLimited(supervisor, null, 'active', 'jev'), true);
  assert.equal(isLimited(info(), null, 'shadow', 'jev'), false);
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
