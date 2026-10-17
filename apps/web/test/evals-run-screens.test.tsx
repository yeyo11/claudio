// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { EvalCall, EvalDefinition, EvalEstimate, EvalFileDetail, EvalRun, EvalSample, EvalSampleDetail, EvalRunSummary } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { ApiRequestError, keys } from '../src/api';
import i18n, { setLanguage } from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { EvalHistory } from '../src/pages/team/evals/History';
import { Matrix, RunView } from '../src/pages/team/evals/Run';
import { SampleView } from '../src/pages/team/evals/Sample';
import { Refusal, StartPanel } from '../src/pages/team/evals/Start';
import { estimateKey, startRequest } from '../src/pages/team/evals/run-model';

// The start dialog, the run view, a sample and the history in every state of the plan's screens
// table. Rendered on the server: the queries are seeded, so a state is what the cache holds.

const PIN = 'a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const DEFINITION: EvalDefinition = {
  version: 1,
  title: 'Developer runs the tests',
  target: { kind: 'agent', scope: 'project', name: 'developer' },
  pin: PIN,
  samples: 2,
  cases: [
    { id: 'tests', title: 'Runs the suite', prompt: 'Fix the test', expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm*test*' }, min: 1 }] },
    { id: 'lint', prompt: 'Fix the lint', expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm*lint*' }, min: 1 }] },
  ],
};

const FILE: EvalFileDetail & { definition: EvalDefinition } = { name: 'dev', path: '.claude/claudio-evals/dev.json', sha: 'sha1', definition: DEFINITION, problems: [], consented: false };

const sample = (over: Partial<EvalSample> & Pick<EvalSample, 'id' | 'caseId' | 'variant' | 'attempt'>): EvalSample => ({
  runId: 'r1',
  pressure: 'neutral',
  try: 1,
  seq: Number(over.id.replace(/\D/g, '') || 0),
  state: 'ended',
  outcome: 'passed',
  reason: null,
  chatId: null,
  account: 'acc',
  model: 'claude-sonnet-5-5',
  cliVersion: '2.1.0',
  pin: PIN,
  costUsd: 0.12,
  durationMs: 41_000,
  turns: 6,
  callsTruncated: false,
  resultText: 'Done.',
  startedAt: null,
  endedAt: null,
  checks: [],
  ...over,
});

const summary = (over: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  id: 'r1',
  projectId: 'p',
  evalName: 'dev',
  definitionSha: 'sha1',
  variants: ['current', 'proposed'],
  pressures: ['neutral'],
  samplesPerCase: 2,
  account: null,
  state: 'ended',
  outcome: 'completed',
  reason: null,
  resetsAt: null,
  maxCostUsd: 4,
  costUsd: 1.5,
  counts: {},
  scored: {},
  createdAt: new Date().toISOString(),
  startedAt: null,
  endedAt: null,
  ...over,
});

const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  ...summary(),
  definition: DEFINITION,
  variantInfo: [],
  samples: [
    sample({ id: 's1', caseId: 'tests', variant: 'current', attempt: 1 }),
    sample({ id: 's2', caseId: 'tests', variant: 'current', attempt: 2, outcome: 'failed' }),
    sample({ id: 's3', caseId: 'tests', variant: 'proposed', attempt: 1 }),
    sample({ id: 's4', caseId: 'tests', variant: 'proposed', attempt: 2 }),
    sample({ id: 's5', caseId: 'lint', variant: 'current', attempt: 1 }),
    sample({ id: 's6', caseId: 'lint', variant: 'proposed', attempt: 1, outcome: 'failed' }),
  ],
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

const runView = (data: EvalRun | undefined) =>
  page((client) => {
    if (data) client.setQueryData(keys.evalRun('r1'), data);
  }, <RunView projectId="p" runId="r1" onBack={() => {}} />);

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

// ---------- the start dialog ----------

const ESTIMATE: EvalEstimate = { samples: 8, ceilingUsd: 4, typicalUsd: 1.2, commands: [], prompts: ['Fix the test', 'Fix the lint'], consentNeeded: false, warnings: ['dirty-checkout'] };
const DEFAULT_REQUEST = startRequest({ variants: new Set(['pinned', 'current']), proposed: '', skipped: new Set(), samples: undefined, account: '', pressures: new Set(['neutral'] as const) }, DEFINITION, null, 0);

const start = (setup: (client: QueryClient) => void = () => {}, initialProposed: string | null = null) =>
  page((client) => {
    client.setQueryData(keys.accounts, []);
    setup(client);
  }, <StartPanel projectId="p" name="dev" file={FILE} initialProposed={initialProposed} onClose={() => {}} onStarted={() => {}} onEditor={() => {}} />);

test('the start dialog is estimating until the cost arrives, and the primary waits', () => {
  const html = start();
  assert.match(text(html), /Estimating the cost/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*?Run eval · up to …/);
});

test('ready: samples, ceiling, typical cost, warnings and "Run eval · up to $X"', () => {
  const html = start((client) => client.setQueryData(keys.evalEstimate('p', 'dev', estimateKey(DEFAULT_REQUEST)), ESTIMATE));
  assert.match(text(html), /8 attempts · up to \$4\.00 · typically \$1\.20/);
  assert.match(text(html), /uncommitted changes/);
  assert.match(text(html), /Run eval · up to \$4\.00/);
  assert.doesNotMatch(html, /Review what this eval runs/);
  for (const variant of ['Committed at the pin', 'Current file', 'Proposed text']) assert.match(text(html), new RegExp(variant));
  assert.match(text(html), /Runs the suite/, 'a case subset is offered');
});

test('refused: the 422 reason in words with the fix', () => {
  const html = page(() => {}, <Refusal error={new ApiRequestError('pin missing', 422, undefined, 'pin-missing')} onEditor={() => {}} />);
  assert.match(text(html), /The pinned commit is missing/);
  assert.match(text(html), /pin to HEAD/);
  assert.match(text(html), /Open the eval/);
  const other = text(page(() => {}, <Refusal error={new ApiRequestError('nope', 422, undefined, 'not-git')} onEditor={() => {}} />));
  assert.match(other, /not a git repository/);
  assert.doesNotMatch(other, /Open the eval/);
});

test('consent needed: the prompts and commands in mono and a checkbox that gates the primary', () => {
  const html = start((client) =>
    client.setQueryData(keys.evalEstimate('p', 'dev', estimateKey(DEFAULT_REQUEST)), { ...ESTIMATE, consentNeeded: true, commands: ['pnpm install'] }),
  );
  assert.match(text(html), /Review what this eval runs/);
  assert.match(text(html), /2 prompts/);
  assert.match(html, /class="evals-consent-list mono"/);
  assert.match(text(html), /pnpm install/);
  assert.match(text(html), /I understand these run on this machine/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*?Run eval · up to \$4\.00/, 'not until accepted');
});

test('"Evaluate this change" carries the unsaved text: it opens the proposed variant, prefilled', () => {
  const html = start(() => {}, '# developer\nBe terse.');
  assert.match(text(html), /Proposed text of \.claude\/agents\/developer\.md/);
  assert.match(text(html), /unsaved text from the member.{1,8}s page/);
  const request = startRequest({ variants: new Set(['current', 'proposed']), proposed: '# developer\nBe terse.', skipped: new Set(), samples: undefined, account: '', pressures: new Set(['neutral'] as const) }, DEFINITION, '# developer', 4);
  assert.deepEqual(request.variants, ['current', 'proposed']);
  assert.equal(request.proposed, '# developer\nBe terse.');
});

// ---------- the run view ----------

test('a run that is loading is a skeleton; one that fails is an error box', () => {
  assert.match(runView(undefined), /skeleton-stack/);
});

test('running: the one energy border, ring spinners on running attempts, the braille spinner by the word', () => {
  const html = runView(
    run({
      ...summary({ state: 'running', outcome: null }),
      samples: [sample({ id: 's1', caseId: 'tests', variant: 'current', attempt: 1 }), sample({ id: 's2', caseId: 'tests', variant: 'current', attempt: 2, state: 'running', outcome: null }), sample({ id: 's3', caseId: 'tests', variant: 'proposed', attempt: 1, state: 'queued', outcome: null })],
    }),
  );
  assert.equal(html.match(/live-energy/g)?.length, 1, 'one energy surface');
  assert.match(html, /spinner-ring/);
  assert.match(text(html), /Running/);
  assert.match(text(html), /Cancel run/);
  assert.match(html, /progress-segbar/);
  assert.match(text(html), /\$1\.50 of \$4\.00/);
});

test('queued, waiting for a reset, capped, interrupted, cancelled, completed and failed each say so; none but running moves', () => {
  const cases: [Partial<EvalRunSummary>, RegExp][] = [
    [{ state: 'queued', outcome: null }, /Queued/],
    [{ state: 'waiting', outcome: null, resetsAt: '2026-10-17T10:00:00.000Z' }, /Waiting for a usage limit to reset/],
    [{ outcome: 'capped' }, /Stopped at the ceiling; 1 attempt not run/],
    [{ outcome: 'interrupted' }, /Interrupted; 1 attempt not run/],
    [{ outcome: 'cancelled' }, /This run was cancelled/],
    [{ outcome: 'completed' }, /Failed|Passed/],
    [{ outcome: 'failed', reason: 'three infra outcomes in a row' }, /The run failed/],
  ];
  for (const [over, expected] of cases) {
    const html = runView(
      run({
        ...summary(over),
        samples: [...run().samples, sample({ id: 's9', caseId: 'lint', variant: 'current', attempt: 2, outcome: 'skipped' })].filter((s) => (over.state === 'queued' ? s.id === 's9' : true)).map((s) => (over.state === 'queued' ? { ...s, state: 'queued' as const, outcome: null } : s)),
      }),
    );
    assert.match(text(html), expected);
    assert.doesNotMatch(html, /live-energy/, `${JSON.stringify(over)} does not move`);
    assert.doesNotMatch(html, /spinner-ring/, `${JSON.stringify(over)} has no ring`);
  }
});

test('waiting offers Stop, capped and interrupted offer Resume', () => {
  assert.match(text(runView(run({ ...summary({ state: 'waiting', outcome: null }) }))), /Stop/);
  for (const outcome of ['capped', 'interrupted'] as const) {
    const html = text(runView(run({ ...summary({ outcome }), samples: [sample({ id: 's1', caseId: 'tests', variant: 'current', attempt: 1, outcome: 'skipped' })] })));
    assert.match(html, /Resume/);
  }
});

test('the matrix is a real table with headers, a word for every attempt and "Flaky" as a warn tag', () => {
  const html = runView(run());
  assert.match(html, /<table class="evals-matrix"/);
  assert.match(html, /<th scope="col">Case<\/th>/);
  assert.match(html, /<th scope="row">/);
  assert.match(html, /Attempt 2: Failed/);
  assert.match(text(html), /Flaky/);
  assert.match(html, /badge[^"]*warn|tag[^"]*warn/);
});

test('the comparison column words Regressed, Improved and Same', () => {
  const html = page(
    (client) => {
      client.setQueryData(keys.evalRun('r1'), run());
      client.setQueryData(keys.evalCompare('r1', 'current', 'proposed'), {
        runId: 'r1',
        base: 'current',
        other: 'proposed',
        cases: [
          { caseId: 'tests', base: { passed: 1, scored: 2, flaky: true }, other: { passed: 2, scored: 2, flaky: false }, verdict: 'improved' },
          { caseId: 'lint', base: { passed: 1, scored: 1, flaky: false }, other: { passed: 0, scored: 1, flaky: false }, verdict: 'regressed' },
        ],
        mean: {},
      });
    },
    <RunView projectId="p" runId="r1" onBack={() => {}} />,
  );
  assert.match(text(html), /Improved/);
  assert.match(text(html), /Regressed/);
});

test('on a phone the matrix is one card per case with a variant per line', () => {
  const html = page(() => {}, <Matrix run={run()} verdicts={null} phone onOpen={() => {}} />);
  assert.equal(html.match(/evals-matrix-card"/g)?.length, 2);
  assert.doesNotMatch(html, /<table/);
  assert.match(text(html), /Current file/);
  assert.match(text(html), /Proposed text/);
});

// ---------- a sample ----------

const call = (seq: number, over: Partial<EvalCall> = {}): EvalCall => ({ seq, message: seq, toolUseId: null, name: 'Bash', scope: 'main', outcome: 'ok', input: JSON.stringify({ command: 'pnpm test' }), result: null, at: null, ...over });
const detail = (over: Partial<EvalSampleDetail> = {}): EvalSampleDetail => ({
  ...sample({ id: 's1', caseId: 'tests', variant: 'current', attempt: 1 }),
  calls: [call(1, { name: 'Task', input: JSON.stringify({ description: 'look around' }) }), call(2, { scope: 'sub', name: 'Read', input: JSON.stringify({ file_path: 'a.ts' }) }), call(3, { outcome: 'denied' })],
  checks: [
    { idx: 0, kind: 'called', passed: true, detail: 'Bash `pnpm test` (#3) was called', evidenceSeq: 3, output: null },
    { idx: 1, kind: 'text', passed: false, detail: 'the final text does not mention the tests', evidenceSeq: null, output: null },
  ],
  ...over,
});

test('a sample lists numbered calls with subagents under their Task, the checks with a word and the footer', () => {
  const html = page(() => {}, <SampleView sample={detail()} />);
  assert.match(html, /id="sample-call-3"/);
  assert.match(html, /evals-call-row is-sub/);
  assert.match(text(html), /#1 Task look around/);
  assert.match(text(html), /Denied/);
  assert.match(text(html), /Passed Bash `pnpm test` \(#3\) was called/);
  assert.match(text(html), /Failed the final text does not mention/);
  assert.match(text(html), /Call #3/);
  assert.match(text(html), /Cost \$0\.12/);
  assert.match(text(html), /Model claude-sonnet-5-5/);
  assert.match(text(html), /Pin a56d826/);
});

test('a sample that was not scored says why', () => {
  for (const [outcome, why] of [
    ['limit', /usage limit stopped this attempt/],
    ['interrupted', /interrupted before/],
    ['infra', /outside the target failed/],
  ] as const) {
    const html = text(page(() => {}, <SampleView sample={detail({ outcome, reason: 'login expired' })} />));
    assert.match(html, /Not scored/);
    assert.match(html, why);
    assert.match(html, /login expired/);
  }
});

// ---------- the history ----------

const history = (runs: EvalRunSummary[] | undefined, next: string | null = null) =>
  page((client) => {
    if (runs) client.setQueryData(keys.evalRuns('p', 'dev'), { pages: [{ runs, next }], pageParams: [''] });
  }, <EvalHistory projectId="p" name="dev" onBack={() => {}} onOpenRun={() => {}} />);

test('the history is a skeleton while it loads and a compact line, with no illustration, when empty', () => {
  assert.match(history(undefined), /skeleton-stack/);
  const html = history([]);
  assert.match(text(html), /This eval has not run yet/);
  assert.doesNotMatch(html, /data-illustration/);
});

test('the history lists runs newest first with word, cases, cost and a way to compare and page', () => {
  const html = history([summary({ id: 'r2', scored: { current: { passed: 2, of: 2 } } }), summary({ id: 'r1', outcome: 'capped', costUsd: 0.4 })], 'r1');
  assert.match(text(html), /2\/2 cases/);
  assert.match(text(html), /Capped/);
  assert.match(text(html), /Compare with…/);
  assert.match(html, /list-more/);
  assert.match(text(html), /Show more/);
  assert.doesNotMatch(html, /type="checkbox"|role="checkbox"/, 'no always-visible checkboxes');
});

// ---------- phone and motion rules, in the stylesheet ----------

test('the stylesheet keeps the phone targets and uses only tokens', () => {
  const css = readFileSync(new URL('../src/styles/evals.css', import.meta.url), 'utf8');
  assert.match(css, /\.evals-start-sheet input/);
  assert.match(css, /font-size: var\(--fs-input\)/);
  assert.match(css, /\.evals-start-sheet \.btn/);
  assert.match(css, /min-height: var\(--touch\)/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|\d+ms\b/, 'no hex, rgb or millisecond value');
  assert.doesNotMatch(css, /@keyframes|animation:/, 'nothing here moves on its own: the live border and spinners come from the primitives');
});
