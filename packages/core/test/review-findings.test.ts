import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewSeverity, ReviewVerdict } from '@claudio/shared';
import {
  anchor,
  dedupe,
  fingerprint,
  isBlocking,
  roundStatus,
  STOP_WORDS,
  worseAfterFix,
  wordsOf,
  type AnchorIndex,
  type DedupInput,
} from '../src/review-findings.ts';

const index: AnchorIndex = new Map([
  ['src/a.ts', { right: [[10, 20], [40, 45]], left: [[5, 8]] }],
]);

test('anchoring: line, file, outside and none', () => {
  assert.equal(anchor({ path: 'src/a.ts', line: 12, side: 'right' }, index), 'line');
  assert.equal(anchor({ path: 'src/a.ts', line: 20, side: 'right' }, index), 'line');
  assert.equal(anchor({ path: 'src/a.ts', line: 6, side: 'left' }, index), 'line');
  assert.equal(anchor({ path: 'src/a.ts', line: 6, side: 'right' }, index), 'file');
  assert.equal(anchor({ path: 'src/a.ts', line: 30, side: 'right' }, index), 'file');
  assert.equal(anchor({ path: 'src/a.ts', line: null, side: null }, index), 'file');
  assert.equal(anchor({ path: 'src/other.ts', line: 12, side: 'right' }, index), 'outside');
  assert.equal(anchor({ path: null, line: null, side: null }, index), 'none');
});

function make(over: Partial<DedupInput> = {}): DedupInput {
  return {
    source: 'model',
    dimensions: ['correctness'],
    severity: 'high',
    confidence: 0.6,
    title: 'Empty table crashes the loader',
    evidence: 'rows[0].name is read before the length is checked',
    path: 'src/a.ts',
    line: 12,
    side: 'right',
    ...over,
  };
}

test('the stop list holds 60 words', () => {
  assert.equal(STOP_WORDS.size, 60);
  assert.deepEqual(wordsOf('The Loader, an id of it'), ['loader']);
});

test('dedup merges the same finding from two dimensions and keeps the strongest', () => {
  const out = dedupe([
    make({ severity: 'medium', confidence: 0.9, dimensions: ['tests'] }),
    make({ severity: 'high', confidence: 0.4, dimensions: ['correctness'] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.severity, 'high');
  assert.equal(out[0]?.confidence, 0.9);
  assert.deepEqual(out[0]?.dimensions, ['correctness', 'tests']);
  assert.equal(out[0]?.reportedBy, 2);
});

test('dedup line distance: 3 merges, 4 does not', () => {
  assert.equal(dedupe([make({ line: 12 }), make({ line: 15 })]).length, 1);
  assert.equal(dedupe([make({ line: 12 }), make({ line: 16 })]).length, 2);
});

test('dedup needs the same file, side and source; a missing line only matches a missing line', () => {
  assert.equal(dedupe([make(), make({ path: 'src/b.ts' })]).length, 2);
  assert.equal(dedupe([make(), make({ side: 'left' })]).length, 2);
  assert.equal(dedupe([make(), make({ source: 'claudio' })]).length, 2);
  assert.equal(dedupe([make({ line: null, side: null }), make({ line: null, side: null })]).length, 1);
  assert.equal(dedupe([make({ line: null, side: null }), make()]).length, 2);
});

test('dedup Jaccard threshold: 0.5 merges, below does not', () => {
  const a = make({ title: 'alpha beta gamma delta', evidence: '' });
  const half = make({ title: 'alpha beta zeta omega', evidence: '' }); // 2 shared of 6 words = 0.33
  const merged = make({ title: 'alpha beta gamma omega', evidence: '' }); // 3 shared of 5 = 0.6
  assert.equal(dedupe([a, half]).length, 2);
  assert.equal(dedupe([a, merged]).length, 1);
  // 2 shared of 4 distinct words is exactly 0.5
  assert.equal(dedupe([make({ title: 'alpha beta', evidence: '' }), make({ title: 'alpha beta gamma delta', evidence: '' })]).length, 1);
});

test('dedup chains through union-find', () => {
  const a = make({ line: 10, title: 'alpha beta gamma', evidence: '' });
  const b = make({ line: 13, title: 'alpha beta gamma', evidence: '' });
  const c = make({ line: 16, title: 'alpha beta gamma', evidence: '' });
  // a-c are 6 apart, but both are near b
  assert.equal(dedupe([a, b, c]).length, 1);
});

test('dedup is independent of input order', () => {
  const items = [
    make({ title: 'Empty table crashes the loader', confidence: 0.5, dimensions: ['tests'] }),
    make({ title: 'Empty table crashes the loader badly', confidence: 0.7 }),
    make({ path: 'src/z.ts', title: 'Unrelated parser leak', evidence: 'socket never closed' }),
    make({ path: 'src/b.ts', severity: 'low', title: 'Naming drift here', evidence: 'name differs' }),
    make({ line: 14, evidence: 'the same loader crash seen from elsewhere', confidence: 0.6 }),
  ];
  const expected = JSON.stringify(dedupe(items));
  for (let round = 0; round < 12; round += 1) {
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    assert.equal(JSON.stringify(dedupe(shuffled)), expected);
  }
});

test('fingerprint is stable across rounds and moves with the file, side and line bucket', () => {
  const base = { path: 'src/a.ts', line: 12, side: 'right' as const, title: 'Empty table crashes the loader', evidence: 'rows[0].name is read first' };
  const fp = fingerprint(base);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fingerprint({ ...base }), fp);
  assert.equal(fingerprint({ ...base, line: 13 }), fp);
  assert.notEqual(fingerprint({ ...base, line: 40 }), fp);
  assert.notEqual(fingerprint({ ...base, path: 'src/b.ts' }), fp);
  assert.notEqual(fingerprint({ ...base, side: 'left' }), fp);
  assert.notEqual(fingerprint({ ...base, line: null, side: null }), fp);
});

test('blocking truth table', () => {
  const severities: ReviewSeverity[] = ['critical', 'high', 'medium', 'low'];
  const verdicts: ReviewVerdict[] = ['not-asked', 'confirmed', 'refuted', 'uncertain', 'unverified', 'deterministic'];
  for (const severity of severities) {
    for (const verdict of verdicts) {
      const high = severity === 'critical' || severity === 'high';
      const open = verdict === 'confirmed' || verdict === 'uncertain' || verdict === 'unverified';
      assert.equal(isBlocking({ source: 'model', severity, verdict }), high && open, `model ${severity} ${verdict}`);
      assert.equal(isBlocking({ source: 'claudio', blockingByRule: true, severity, verdict }), true, `rule ${severity} ${verdict}`);
      assert.equal(isBlocking({ source: 'claudio', blockingByRule: false, severity, verdict }), high && open, `claudio advisory ${severity} ${verdict}`);
    }
  }
  // A model finding cannot claim the rule
  assert.equal(isBlocking({ source: 'model', blockingByRule: true, severity: 'low', verdict: 'refuted' }), false);
});

test('round status precedence: blocked, incomplete, passed', () => {
  const clean = { blocking: 0, runsNotOk: 0, filesNotReviewable: 0, overBudget: false };
  assert.equal(roundStatus(clean), 'passed');
  assert.equal(roundStatus({ ...clean, runsNotOk: 1 }), 'incomplete');
  assert.equal(roundStatus({ ...clean, filesNotReviewable: 1 }), 'incomplete');
  assert.equal(roundStatus({ ...clean, overBudget: true }), 'incomplete');
  assert.equal(roundStatus({ ...clean, blocking: 1, runsNotOk: 2, overBudget: true }), 'blocked');
});

test('worseAfterFix', () => {
  const prev = [{ fingerprint: 'a' }, { fingerprint: 'b' }];
  const touched = new Set(['src/a.ts']);
  assert.equal(worseAfterFix(prev, [{ fingerprint: 'a', path: 'src/a.ts' }], touched), false);
  assert.equal(worseAfterFix(prev, [], touched), false);
  // More findings than before
  assert.equal(worseAfterFix(prev, [{ fingerprint: 'a', path: null }, { fingerprint: 'b', path: null }, { fingerprint: 'c', path: null }], touched), true);
  // A new one in a file the fixer changed
  assert.equal(worseAfterFix(prev, [{ fingerprint: 'c', path: 'src/a.ts' }], touched), true);
  // A new one elsewhere, with no more findings than before, is not the fixer's doing
  assert.equal(worseAfterFix(prev, [{ fingerprint: 'c', path: 'src/z.ts' }], touched), false);
});
