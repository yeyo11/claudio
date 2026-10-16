import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvalDefinition, EvalPressure, EvalSampleOutcome, EvalVariant } from '@claudio/shared';
import { computeGate, gateApplies } from '../src/evals/gate.ts';

const def = (mustHold: string[] = ['a'], k?: number): EvalDefinition => ({
  version: 2,
  title: 't',
  target: { kind: 'instructions', scope: 'project', name: 'CLAUDE.md' },
  pin: 'a'.repeat(40),
  ...(k !== undefined ? { k } : {}),
  cases: ['a', 'b'].map((id) => ({ id, prompt: 'p', ...(mustHold.includes(id) ? { mustHold: true } : {}), expect: [{ kind: 'text', match: { contains: 'x' } }] })) as EvalDefinition['cases'],
});

type S = { caseId: string; variant: EvalVariant; pressure: EvalPressure; outcome: EvalSampleOutcome };
const cell = (caseId: string, variant: EvalVariant, outcomes: EvalSampleOutcome[], pressure: EvalPressure = 'neutral'): S[] =>
  outcomes.map((outcome) => ({ caseId, variant, pressure, outcome }));
const P = 'passed' as const;
const F = 'failed' as const;
const gate = (samples: S[], over: { mustHold?: string[]; k?: number; unreliable?: Array<{ caseId: string; idx: number }> } = {}) =>
  computeGate({ runId: 'r', definition: def(over.mustHold, over.k), variants: ['current', 'proposed'], samples, unreliableJudges: over.unreliable ?? [] });

test('the gate applies only with current and proposed', () => {
  assert.equal(gateApplies(['current', 'proposed']), true);
  assert.equal(gateApplies(['pinned', 'current']), false);
  assert.equal(computeGate({ runId: 'r', definition: def(), variants: ['current'], samples: [] }), null);
});

test('promotable: nothing fell and every mustHold cell is scored enough', () => {
  const g = gate([...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [P, P, P]), ...cell('b', 'current', [P, F, P]), ...cell('b', 'proposed', [P, P, P])]);
  assert.equal(g?.verdict, 'promotable');
  assert.deepEqual(g?.regressed, []);
  assert.deepEqual(g?.incomplete, []);
  assert.equal(g?.cells.length, 4);
});

test('regressed: a mustHold cell whose pass^k fell, with the levels', () => {
  const g = gate([
    ...cell('a', 'current', [P, P, P, P], 'competing'), ...cell('a', 'proposed', [P, F, P, P], 'competing'),
    ...cell('a', 'current', [P, P, P, P]), ...cell('a', 'proposed', [P, P, P, P]),
  ]);
  assert.equal(g?.verdict, 'regressed');
  assert.equal(g?.regressed.length, 1);
  const r = g?.regressed[0];
  assert.equal(r?.caseId, 'a');
  assert.equal(r?.pressure, 'competing');
  assert.equal(r?.from, 1);
  assert.ok((r?.to ?? 1) < 1);
});

test('a case that is not mustHold may fall without regressing the gate while the mean holds within its interval', () => {
  const g = gate([...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [P, P, P]), ...cell('b', 'current', [P, P, P]), ...cell('b', 'proposed', [P, P, F])]);
  assert.equal(g?.verdict, 'promotable');
});

test('regressed: the mean pass rate falls below the interval around the current one', () => {
  const g = gate(
    [...cell('a', 'current', Array(10).fill(P) as S['outcome'][]), ...cell('a', 'proposed', Array(10).fill(F) as S['outcome'][])],
    { mustHold: [] },
  );
  assert.equal(g?.verdict, 'regressed');
  assert.deepEqual(g?.regressed, []);
  assert.equal(g?.meanRate.current, 1);
  assert.equal(g?.meanRate.proposed, 0);
  assert.ok((g?.meanRate.interval?.low ?? 0) > 0.5);
});

test('incomplete: unjudged mustHold samples fail closed', () => {
  const g = gate([...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [P, P, P, 'unjudged'])]);
  assert.equal(g?.verdict, 'incomplete');
  assert.deepEqual(g?.incomplete, [{ caseId: 'a', pressure: 'neutral', reason: 'unjudged' }]);
});

test('incomplete: a mustHold cell with fewer than the minimum scored samples, or none', () => {
  const small = gate([...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [P, P])]);
  assert.equal(small?.verdict, 'incomplete');
  assert.deepEqual(small?.incomplete, [{ caseId: 'a', pressure: 'neutral', reason: 'small-n' }]);
  const none = gate([...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', ['infra', 'limit', 'skipped'])]);
  assert.deepEqual(none?.incomplete, [{ caseId: 'a', pressure: 'neutral', reason: 'not-scored' }]);
  const missing = gate(cell('a', 'current', [P, P, P]));
  assert.equal(missing?.verdict, 'incomplete');
});

test('incomplete: an unreliable judge holds the gate until it is accepted', () => {
  const samples = [...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [P, P, P])];
  const held = gate(samples, { unreliable: [{ caseId: 'a', idx: 0 }] });
  assert.equal(held?.verdict, 'incomplete');
  assert.deepEqual(held?.incomplete, [{ caseId: 'a', pressure: null, reason: 'judge-unreliable' }]);
  assert.deepEqual(held?.unreliableJudges, [{ caseId: 'a', idx: 0 }]);
  assert.equal(gate(samples)?.verdict, 'promotable');
});

test('a regression stands even when other cells are incomplete', () => {
  const g = gate([
    ...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [F, F, F]),
    ...cell('b', 'current', [P, P, P]), ...cell('b', 'proposed', [P]),
  ], { mustHold: ['a', 'b'] });
  assert.equal(g?.verdict, 'regressed');
  assert.equal(g?.incomplete.length, 1);
});

test('the account is shown on the card and does not change the verdict', () => {
  const samples = [...cell('a', 'current', [P, P, P]), ...cell('a', 'proposed', [P, P, P])];
  const g = computeGate({ runId: 'r', definition: def(), variants: ['current', 'proposed'], samples, account: 'work' });
  assert.equal(g?.account, 'work');
  assert.equal(g?.verdict, 'promotable');
});
