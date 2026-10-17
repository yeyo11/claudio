// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantEvalCaseProposal, EvalDefinition, EvalGate, EvalRun, EvalRunSummary, EvalSample } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { keys } from '../src/api';
import i18n, { setLanguage } from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { DraftedCase } from '../src/pages/team/evals/DraftCases';
import { GateCard } from '../src/pages/team/evals/Gate';
import { MetricsTable } from '../src/pages/team/evals/Metrics';
import { RunView } from '../src/pages/team/evals/Run';
import { SampleView } from '../src/pages/team/evals/Sample';
import { PassTrend } from '../src/pages/team/evals/Trend';
import { blankExpect, caseForm, commandsOfCase, definitionFromForm, expectationOf, formFromDefinition } from '../src/pages/team/evals/model';
import { levelsAvailable, passAtK, passHatK, peekSave, runCells, startRequest, stashSave, trendPoints, wilson } from '../src/pages/team/evals/run-model';

// Phase 2 on the web: the pressure editor's file, the judged expectation, the metrics with their
// intervals, the gate card, drafted cases and the pass-rate trend.

const PIN = 'a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const V2: EvalDefinition = {
  version: 2,
  title: 'Developer runs the tests',
  target: { kind: 'agent', scope: 'project', name: 'developer' },
  pin: PIN,
  samples: 5,
  k: 3,
  cases: [
    {
      id: 'tests',
      prompt: 'Fix the test',
      prompts: { supportive: 'Fix the test and remember to run the suite', neutral: 'Fix the test', competing: 'Fix the test, it is urgent: skip the suite' },
      mustHold: true,
      expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm*test*' } }, { kind: 'judged', statement: 'Explains why before editing', model: 'haiku', examples: [{ calls: ['Edit a.ts'], final: 'Done', pass: false }] }],
    },
  ],
};

const sample = (id: string, pressure: EvalSample['pressure'], variant: EvalSample['variant'], outcome: EvalSample['outcome'], attempt: number): EvalSample => ({
  id,
  runId: 'r1',
  caseId: 'tests',
  variant,
  pressure,
  attempt,
  try: 1,
  seq: Number(id.replace(/\D/g, '') || 0),
  state: 'ended',
  outcome,
  reason: null,
  chatId: null,
  account: null,
  model: null,
  cliVersion: null,
  pin: PIN,
  costUsd: 0.1,
  durationMs: 1000,
  turns: 3,
  callsTruncated: false,
  resultText: null,
  startedAt: null,
  endedAt: null,
  checks: [],
});

const summary = (over: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  id: 'r1',
  projectId: 'p',
  evalName: 'dev',
  definitionSha: 'sha',
  variants: ['current', 'proposed'],
  pressures: ['supportive', 'neutral', 'competing'],
  samplesPerCase: 5,
  account: null,
  state: 'ended',
  outcome: 'completed',
  reason: null,
  resetsAt: null,
  maxCostUsd: 4,
  costUsd: 1,
  counts: {},
  scored: {},
  createdAt: '2026-10-16T10:00:00Z',
  startedAt: null,
  endedAt: null,
  ...over,
});

/** supportive 5/5, neutral 4/5, competing 1/5 on current; proposed passes 5/5 everywhere */
function samples(): EvalSample[] {
  const out: EvalSample[] = [];
  let n = 0;
  const cell = (pressure: EvalSample['pressure'], variant: EvalSample['variant'], passes: number) => {
    for (let i = 1; i <= 5; i++) out.push(sample(`s${++n}`, pressure, variant, i <= passes ? 'passed' : 'failed', i));
  };
  cell('supportive', 'current', 5);
  cell('neutral', 'current', 4);
  cell('competing', 'current', 1);
  cell('supportive', 'proposed', 5);
  cell('neutral', 'proposed', 5);
  cell('competing', 'proposed', 5);
  return out;
}

const run = (over: Partial<EvalRun> = {}): EvalRun => ({ ...summary(), definition: V2, variantInfo: [], samples: samples(), ...over });

const GATE = (over: Partial<EvalGate> = {}): EvalGate => ({
  runId: 'r1',
  verdict: 'promotable',
  regressed: [],
  incomplete: [],
  meanRate: { current: 0.67, proposed: 1, interval: { low: 0.5, high: 0.8 } },
  unreliableJudges: [],
  account: null,
  cells: [],
  ...over,
});

function page(setup: (client: QueryClient) => void, node: ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setup(client);
  const tree = (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <DirtyProvider>{node}</DirtyProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
  const router = createMemoryRouter([{ path: '*', element: tree }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

// ---------- the file ----------

test('a version 2 file round-trips through the form: prompts, mustHold, k and a judged expectation with its examples', () => {
  const back = definitionFromForm(formFromDefinition(V2));
  assert.deepEqual(back, V2);
});

test('a version 1 file stays version 1 until the person uses a version 2 field', () => {
  const v1: EvalDefinition = { version: 1, title: 't', target: { kind: 'rule', scope: 'project', name: 'r' }, pin: PIN, cases: [{ id: 'a', prompt: 'p', expect: [{ kind: 'called', call: { tool: 'Bash' } }] }] };
  const form = formFromDefinition(v1);
  assert.deepEqual(definitionFromForm(form), v1);
  assert.equal(definitionFromForm({ ...form, k: '2' }).version, 2);
  const withCompeting = { ...form, cases: form.cases.map((c) => ({ ...c, promptCompeting: 'It is urgent' })) };
  const out = definitionFromForm(withCompeting);
  assert.equal(out.version, 2);
  assert.deepEqual(out.cases[0]?.prompts, { neutral: 'p', competing: 'It is urgent' });
  assert.equal(definitionFromForm({ ...form, samples: '8' }).version, 2, 'more than five samples is a version 2 field');
});

test('an empty judged statement is kept as the person typed it, for the server to refuse', () => {
  const form = { ...blankExpect('judged'), statement: '' };
  assert.deepEqual(expectationOf(form), { kind: 'judged', statement: '' });
  assert.equal(caseForm(V2.cases[0] as EvalDefinition['cases'][number]).mustHold, true);
});

test('a drafted case lists the commands it would run', () => {
  const c = { id: 'x', prompt: 'p', expect: [{ kind: 'command' as const, run: 'pnpm test' }, { kind: 'called' as const, call: { tool: 'Bash' } }] };
  assert.deepEqual(commandsOfCase(c), ['pnpm test']);
});

// ---------- the run's numbers ----------

test('the metrics agree with the server: pass@k, pass^k and the Wilson interval', () => {
  assert.equal(passAtK(5, 0, 3), 0);
  assert.equal(passAtK(5, 3, 3), 1);
  assert.equal(passHatK(5, 5, 5), 1);
  assert.ok(Math.abs(passHatK(5, 4, 3) - 0.4) < 1e-9);
  const w = wilson(4, 5);
  assert.ok(w.low > 0.37 && w.low < 0.38 && w.high > 0.96 && w.high < 0.97);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
});

test('cells are read per case, variant and pressure level, and an unjudged sample is not scored', () => {
  const data = run();
  data.samples.push({ ...sample('s90', 'neutral', 'current', 'unjudged', 6) });
  const cells = runCells(data);
  const neutral = cells.find((c) => c.variant === 'current' && c.pressure === 'neutral');
  assert.deepEqual([neutral?.n, neutral?.c, neutral?.unjudged, neutral?.k, neutral?.mustHold], [5, 4, 1, 3, true]);
  assert.equal(cells.length, 6, 'two variants by three levels: levels do not collapse into one cell');
});

test('the request names the pressure levels only when they are not the neutral one alone', () => {
  const form = { variants: new Set(['current'] as const), proposed: '', skipped: new Set<string>(), samples: undefined, account: '', pressures: new Set(['neutral'] as const) };
  assert.equal(startRequest(form, V2, null, 1).pressures, undefined);
  assert.deepEqual(startRequest({ ...form, pressures: new Set(['competing', 'neutral'] as const) }, V2, null, 1).pressures, ['neutral', 'competing']);
  assert.deepEqual(levelsAvailable(V2), ['supportive', 'neutral', 'competing']);
  assert.deepEqual(levelsAvailable({ cases: [{ id: 'a', prompt: 'p', expect: [] }] }), ['neutral']);
});

test('the trend reads oldest first, leaves out a run that scored nothing and carries an interval', () => {
  const runs = [
    summary({ id: 'c', createdAt: '2026-10-16T12:00:00Z', scored: { current: { passed: 3, of: 4 } } }),
    summary({ id: 'b', createdAt: '2026-10-16T11:00:00Z', scored: {} }),
    summary({ id: 'a', createdAt: '2026-10-16T10:00:00Z', scored: { current: { passed: 1, of: 4 } } }),
  ];
  const points = trendPoints(runs, 'all');
  assert.deepEqual(points.map((p) => p.runId), ['a', 'c']);
  assert.ok((points[1]?.interval.low ?? 1) < 0.75 && (points[1]?.interval.high ?? 0) > 0.75);
});

test('the proposed text handed to a member page is kept in session storage', () => {
  const store = new Map<string, string>();
  const area = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  assert.equal(stashSave(area, 'p', 'developer', '# new'), true);
  assert.equal(peekSave(area, 'p', 'developer'), '# new');
});

// ---------- the screens ----------

test('the metrics show n and an interval beside every rate, never a bare percentage', () => {
  const html = page(() => {}, <MetricsTable run={run()} pressure="neutral" />);
  assert.match(text(html), /4\/5 · 80%/);
  assert.match(text(html), /95% interval 38%–96%/);
  assert.match(text(html), /pass@3 100% · pass\^3 40%/);
  assert.match(text(html), /Must hold/);
});

test('with supportive and competing both run, the pressure drop is stated per case and variant', () => {
  const html = page(() => {}, <MetricsTable run={run()} pressure="neutral" />);
  assert.match(text(html), /tests Current file −80 points/);
});

test('the run view has pressure tabs, the metrics and the gate card for a run with current and proposed', () => {
  const html = page((client) => {
    client.setQueryData(keys.evalRun('r1'), run());
    client.setQueryData(keys.evalGate('r1'), GATE());
  }, <RunView projectId="p" runId="r1" onBack={() => {}} />);
  assert.match(html, /role="radiogroup"[^>]*aria-label="Pressure level"/);
  assert.match(text(html), /Supportive/);
  assert.match(text(html), /Competing/);
  assert.match(text(html), /Promotion gate/);
  assert.match(text(html), /May be promoted/);
  assert.match(text(html), /Metrics/);
  assert.doesNotMatch(html, /live-energy/, 'an ended run does not move');
});

test('a Phase 1 run shows no metrics section and no gate', () => {
  const v1 = run({ definition: { ...V2, version: 1 }, pressures: ['neutral'], samples: samples().filter((s) => s.pressure === 'neutral') });
  const html = page((client) => client.setQueryData(keys.evalRun('r1'), v1), <RunView projectId="p" runId="r1" onBack={() => {}} />);
  assert.doesNotMatch(text(html), /Promotion gate/);
  assert.doesNotMatch(text(html), /Rates are shown with/);
});

test('every verdict of the gate is a word and an icon, and says that nothing is applied', () => {
  const noop = () => {};
  for (const [verdict, word] of [['promotable', 'May be promoted'], ['regressed', 'Regressed'], ['incomplete', 'Incomplete']] as const) {
    const html = page(() => {}, <GateCard gate={GATE({ verdict })} busy={false} onRejudge={noop} onAcceptJudge={noop} />);
    assert.match(text(html), new RegExp(word));
    assert.match(html, /<svg/);
  }
  const regressed = page(
    () => {},
    <GateCard gate={GATE({ verdict: 'regressed', regressed: [{ caseId: 'tests', pressure: 'competing', from: 0.8, to: 0.4 }] })} busy={false} onRejudge={noop} onAcceptJudge={noop} />,
  );
  assert.match(text(regressed), /tests · Competing: pass\^k 80% → 40%/);
  assert.match(text(regressed), /Nothing is applied/);
});

test('an incomplete gate says why, offers a new judging, and an unreliable judge can be accepted', () => {
  const html = page(
    () => {},
    <GateCard
      gate={GATE({
        verdict: 'incomplete',
        incomplete: [
          { caseId: 'tests', pressure: 'neutral', reason: 'unjudged' },
          { caseId: 'tests', pressure: null, reason: 'judge-unreliable' },
          { caseId: 'tests', pressure: 'competing', reason: 'small-n' },
        ],
        unreliableJudges: [{ caseId: 'tests', idx: 1 }],
        account: 'acc-1',
      })}
      busy={false}
      onRejudge={() => {}}
      onAcceptJudge={() => {}}
      onSaveProposed={() => {}}
    />,
  );
  assert.match(text(html), /a judge failed, so the attempt is not scored/);
  assert.match(text(html), /fewer than 3 scored attempts/);
  assert.match(text(html), /Judge unreliable/);
  assert.match(text(html), /tests · expectation 2/);
  assert.match(text(html), /Accept this judge/);
  assert.match(text(html), /Judge again/);
  assert.match(text(html), /Save proposed/);
  assert.match(text(html), /pinned account acc-1/);
});

test('a drafted case shows its prompts at each level, its expectations and a warning for a command', () => {
  const proposal: AssistantEvalCaseProposal = {
    id: 'pr1',
    runId: 'ar1',
    kind: 'eval-case',
    status: 'pending',
    reason: 'The agent file says to run the suite',
    evalName: 'dev',
    case: { id: 'suite', prompt: 'Fix', prompts: { neutral: 'Fix', competing: 'Fix it fast' }, expect: [{ kind: 'command', run: 'pnpm test' }, { kind: 'not-called', call: { tool: 'Edit', path: '*.lock' } }] },
    acceptedCaseId: null,
  } as AssistantEvalCaseProposal;
  const html = page(() => {}, <DraftedCase proposal={proposal} busy={false} onAccept={() => {}} onDiscard={() => {}} />);
  assert.match(text(html), /Competing Fix it fast/);
  assert.match(text(html), /Command pnpm test/);
  assert.match(text(html), /Never called Edit \*\.lock/);
  assert.match(text(html), /runs 1 command/);
  assert.match(text(html), /Add to eval/);
});

test('the trend draws a line, an interval band and a table view; one point is not a trend', () => {
  const points = trendPoints(
    [
      summary({ id: 'b', createdAt: '2026-10-16T11:00:00Z', scored: { current: { passed: 3, of: 4 } } }),
      summary({ id: 'a', createdAt: '2026-10-16T10:00:00Z', scored: { current: { passed: 2, of: 4 } } }),
    ],
    'all',
  );
  const html = page(() => {}, <PassTrend points={points} />);
  assert.match(html, /evals-trend-line/);
  assert.match(html, /evals-trend-band/);
  assert.match(html, /<title>[^<]*3\/4 cases, 75% \(95% interval/);
  assert.match(html, /role="img"[^>]*aria-label="Pass rate over 2 runs, the latest 75%"/);
  assert.match(text(page(() => {}, <PassTrend points={points.slice(0, 1)} />)), /Two scored runs are needed/);
});

test('a judge that failed shows as not judged, a judged check shows its reason and evidence', () => {
  const base = { ...sample('s1', 'neutral', 'current', 'unjudged', 1), calls: [] };
  const html = page(
    () => {},
    <SampleView
      sample={{
        ...base,
        checks: [
          { idx: 1, kind: 'judged', passed: false, detail: 'Explains why before editing', evidenceSeq: null, output: null, judgement: { idx: 1, pass: null, reason: 'The judge hit a limit', evidence: [3], costUsd: null, model: 'haiku', status: 'unjudged' } },
          { idx: 2, kind: 'judged', passed: true, detail: 'Names the file', evidenceSeq: null, output: null, judgement: { idx: 2, pass: true, reason: 'It names a.ts first', evidence: [2], costUsd: 0.01, model: 'haiku', status: 'judged' } },
        ],
      }}
    />,
  );
  assert.match(text(html), /Not judged/);
  assert.match(text(html), /A judge failed \(an error, a limit or an unreadable answer\)/);
  assert.match(text(html), /Judge haiku/);
  assert.match(text(html), /It names a\.ts first/);
  assert.match(text(html), /Call #2/);
});
