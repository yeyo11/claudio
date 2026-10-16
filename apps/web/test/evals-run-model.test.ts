import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvalDefinition, EvalRun, EvalSample } from '@claudio/shared';
import { teamSearch } from '../src/pages/team/model';
import {
  callSummary,
  canStart,
  clearProposed,
  compareRuns,
  comparisonWarnings,
  evalsForAgent,
  isFlaky,
  latestTries,
  peekProposed,
  PROPOSED_MAX_BYTES,
  proposedState,
  refusalOf,
  resumeCeiling,
  runMatrix,
  runProgress,
  runStage,
  sharedVariant,
  startRequest,
  stashProposed,
} from '../src/pages/team/evals/run-model';

const DEF: EvalDefinition = {
  version: 1,
  title: 't',
  target: { kind: 'agent', scope: 'project', name: 'dev' },
  pin: 'a'.repeat(40),
  samples: 2,
  limits: { maxCostUsdPerSample: 0.5 },
  cases: [
    { id: 'a', prompt: 'p', expect: [] },
    { id: 'b', prompt: 'p', expect: [] },
  ],
};

const s = (id: number, over: Partial<EvalSample>): EvalSample => ({
  id: `s${id}`,
  runId: 'r',
  caseId: 'a',
  variant: 'current',
  attempt: 1,
  try: 1,
  seq: id,
  state: 'ended',
  outcome: 'passed',
  reason: null,
  chatId: null,
  account: null,
  model: 'm',
  cliVersion: 'v',
  pin: 'a'.repeat(40),
  costUsd: 0,
  durationMs: 0,
  turns: 1,
  callsTruncated: false,
  resultText: null,
  startedAt: null,
  endedAt: null,
  checks: [],
  ...over,
});

const store = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
};

test('the handed-over text lives under the plan\'s key, at most 256 KiB, and is cleared after use', () => {
  const st = store();
  assert.equal(stashProposed(st, 'p1', 'dev', 'text'), true);
  assert.equal([...st.map.keys()][0], 'claudio.evals.proposed.p1.dev');
  assert.equal(peekProposed(st, 'p1', 'dev'), 'text');
  clearProposed(st, 'p1', 'dev');
  assert.equal(peekProposed(st, 'p1', 'dev'), null);
  assert.equal(stashProposed(st, 'p1', 'dev', 'x'.repeat(PROPOSED_MAX_BYTES + 1)), false);
  assert.equal(st.map.size, 0);
});

test('a proposal identical to the current file keeps one variant; an empty one is not sent', () => {
  assert.equal(proposedState('', 'a'), 'empty');
  assert.equal(proposedState('a', 'a'), 'same');
  assert.equal(proposedState('b', 'a'), 'different');
  const form = { variants: new Set(['current', 'proposed'] as const), proposed: 'a', skipped: new Set<string>(), samples: undefined, account: '' };
  assert.deepEqual(startRequest(form, DEF, 'a', 3).variants, ['current']);
  assert.equal(startRequest(form, DEF, 'a', 3).proposed, undefined);
});

test('the request repeats the ceiling and sends a case subset, samples and account only when they differ', () => {
  const form = { variants: new Set(['pinned', 'proposed'] as const), proposed: 'new', skipped: new Set(['b']), samples: 3, account: 'acc' };
  assert.deepEqual(startRequest(form, DEF, 'old', 4.5), { variants: ['pinned', 'proposed'], confirmMaxCostUsd: 4.5, proposed: 'new', cases: ['a'], samples: 3, account: 'acc' });
  const plain = { variants: new Set(['pinned'] as const), proposed: '', skipped: new Set<string>(), samples: 2, account: '' };
  assert.deepEqual(startRequest(plain, DEF, null, 1), { variants: ['pinned'], confirmMaxCostUsd: 1 });
  assert.equal(canStart({ variants: [], confirmMaxCostUsd: 0 }), false);
  assert.equal(canStart({ variants: ['pinned'], cases: [], confirmMaxCostUsd: 0 }), false);
});

test('only the refusals the dialog words are named, and two of them have a fix in the editor', () => {
  assert.deepEqual(refusalOf('pin-missing'), { code: 'pin-missing', fix: 'editor' });
  assert.deepEqual(refusalOf('not-git'), { code: 'not-git', fix: null });
  assert.equal(refusalOf('boom'), null);
  assert.equal(refusalOf(undefined), null);
});

test('a run is in one stage, resumable when capped or interrupted', () => {
  assert.equal(runStage({ state: 'queued', outcome: null }), 'queued');
  assert.equal(runStage({ state: 'waiting', outcome: null }), 'waiting');
  assert.equal(runStage({ state: 'ended', outcome: 'capped' }), 'capped');
  assert.equal(runStage({ state: 'ended', outcome: null }), 'completed');
});

test('the newest try of an attempt counts, and progress separates scored from not scored', () => {
  const samples = [
    s(1, { outcome: 'limit' }),
    s(2, { try: 2, outcome: 'passed' }),
    s(3, { attempt: 2, outcome: 'failed' }),
    s(4, { caseId: 'b', state: 'running', outcome: null }),
    s(5, { caseId: 'b', attempt: 2, state: 'queued', outcome: null }),
    s(6, { caseId: 'b', attempt: 3, outcome: 'skipped' }),
  ];
  assert.equal(latestTries(samples).length, 5);
  assert.deepEqual(runProgress(samples), { done: 1, failed: 1, running: 1, pending: 1, skipped: 1 });
});

test('a case that passes some attempts and fails others is flaky; one that only fails is not', () => {
  assert.equal(isFlaky([s(1, {}), s(2, { outcome: 'failed' })]), true);
  assert.equal(isFlaky([s(1, { outcome: 'failed' }), s(2, { outcome: 'failed' })]), false);
  assert.equal(isFlaky([s(1, {}), s(2, { outcome: 'limit' })]), false);
});

test('the matrix has a row per case that has attempts and a cell per variant of the run', () => {
  const rows = runMatrix({ definition: DEF, variants: ['current', 'proposed'], samples: [s(1, {}), s(2, { variant: 'proposed' })] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.cells.map((c) => c.variant), ['current', 'proposed']);
});

test('the resume ceiling is what was spent plus the worst case of what is left, held to the limit', () => {
  const samples = [s(1, { outcome: 'skipped' }), s(2, { outcome: 'interrupted', attempt: 2 })];
  assert.equal(resumeCeiling({ costUsd: 1, definition: DEF, samples }), 2.25);
  assert.equal(resumeCeiling({ costUsd: 1, definition: { ...DEF, limits: { maxCostUsdPerSample: 0.5, maxCostUsd: 1.5 } }, samples }), 1.5);
});

test('two runs are compared on the variant they share, case by case', () => {
  const a = { definition: DEF, variants: ['current'] as const, samples: [s(1, {}), s(2, { attempt: 2, outcome: 'failed' }), s(3, { caseId: 'b' })] };
  const b = { definition: DEF, variants: ['current', 'proposed'] as const, samples: [s(1, {}), s(2, { attempt: 2 }), s(3, { caseId: 'b', outcome: 'failed' })] };
  assert.equal(sharedVariant(a, b), 'current');
  assert.equal(sharedVariant({ variants: ['pinned'] }, { variants: ['proposed'] }), null);  const rows = compareRuns(a, b, 'current');
  assert.equal(rows.find((r) => r.caseId === 'a')?.verdict, 'improved');
  assert.equal(rows.find((r) => r.caseId === 'b')?.verdict, 'regressed');
});

test('runs that differ in definition, model, CLI or account say so', () => {
  const base = { definitionSha: 'x', account: null, samples: [s(1, {})] } as unknown as EvalRun;
  assert.deepEqual(comparisonWarnings(base, base), []);
  const other = { definitionSha: 'y', account: 'acc', samples: [s(1, { model: 'n', cliVersion: 'w' })] } as unknown as EvalRun;
  assert.deepEqual(comparisonWarnings(base, other), ['definition', 'model', 'cli', 'account']);
});

test('a call is summarised by its command, path or skill, never the raw JSON', () => {
  assert.equal(callSummary('Bash', JSON.stringify({ command: 'pnpm test\nmore' })), 'pnpm test');
  assert.equal(callSummary('Read', JSON.stringify({ file_path: 'a.ts' })), 'a.ts');
  assert.equal(callSummary('Skill', JSON.stringify({ skill: 'review' })), 'review');
  assert.equal(callSummary('Bash', 'not json'), 'not json');
});

test('the evals for an agent are the ones that target its file', () => {
  const file = (name: string, def: EvalDefinition | null) => ({ name, path: '', sha: '', definition: def, problems: [], latestRun: null });
  const list = [file('a', DEF), file('b', { ...DEF, target: { kind: 'skill', scope: 'project', name: 'dev' } }), file('c', null)];
  assert.deepEqual(evalsForAgent(list, 'dev').map((f) => f.name), ['a']);
});

test('the member page opens the evals filtered to its agent, and leaving the section drops the filter', () => {
  const params = new URLSearchParams('view=team&member=dev&project=p');
  const evals = new URLSearchParams(teamSearch(params, { section: 'evals', member: null, eval: null, run: null, for: 'dev' }));
  assert.equal(evals.get('section'), 'evals');
  assert.equal(evals.get('for'), 'dev');
  assert.equal(evals.get('member'), null);
  assert.equal(evals.get('project'), 'p');
  const away = new URLSearchParams(teamSearch(evals, { section: 'flow' }));
  assert.equal(away.get('for'), null);
});
