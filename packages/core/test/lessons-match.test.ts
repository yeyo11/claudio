import assert from 'node:assert/strict';
import test from 'node:test';
import type { Lesson, LessonStatus } from '@claudio/shared';
import { alsoInProjects, matchCandidate, SAME_AT, SIMILAR_AT, similarity, tokens, type MatchCandidate } from '../src/lessons/match.ts';

const lesson = (key: string, trigger: string, action: string, status: LessonStatus = 'active'): Lesson => ({ key, trigger, action, status }) as Lesson;
const cand = (trigger: string, action: string, over: Partial<MatchCandidate> = {}): MatchCandidate => ({ trigger, action, restates: null, contradicts: null, ...over });

/** `n` distinct one-token words: with these, the Jaccard index is exact */
const words = (from: number, count: number): string => Array.from({ length: count }, (_, i) => `w${String(from + i)}`).join(' ');
const pair = (shared: number, onlyA: number, onlyB: number) => [
  { trigger: `${words(0, shared)} ${words(100, onlyA)}`, action: '' },
  { trigger: `${words(0, shared)} ${words(200, onlyB)}`, action: '' },
];

test('the normal form: case, punctuation, stopwords, a light stem, and code tokens', () => {
  assert.deepEqual([...tokens('When Editing the CART, always keep totals!')].sort(), ['alway', 'cart', 'edit', 'keep', 'total'].sort());
  assert.ok(tokens('Use `pnpm` here').has('`pnpm`'));
  assert.ok(tokens('Edit src/cart.ts and my-file_name.v2').has('src/cart.ts'));
  assert.ok(tokens('Edit src/cart.ts.').has('src/cart.ts'), 'a final period is punctuation');
  assert.ok(tokens('café').has('café'), 'NFC');
  assert.deepEqual([...tokens('files fixed running')].sort(), ['fil', 'fix', 'runn']);
  // A word of four letters or fewer keeps its ending
  assert.ok(tokens('bugs').has('bugs'));
  assert.ok(tokens('tests').has('test'));
});

test('similarity is the Jaccard index of trigger + action tokens', () => {
  assert.equal(similarity({ trigger: 'a1 b1', action: 'c1' }, { trigger: 'a1 b1', action: 'c1' }), 1);
  assert.equal(similarity({ trigger: 'x1', action: 'y1' }, { trigger: 'p1', action: 'q1' }), 0);
  assert.equal(similarity({ trigger: '', action: '' }, { trigger: '', action: '' }), 0);
  const [a, b] = pair(1, 1, 0);
  assert.equal(similarity(a!, b!), 0.5);
});

test('boundary at 0.75: three shared of four is the same, 14 of 19 is only similar', () => {
  const [a, b] = pair(3, 0, 1);
  assert.equal(similarity(a!, b!), SAME_AT);
  assert.equal(matchCandidate(cand(b!.trigger, ''), [lesson('L-1', a!.trigger, '')]).kind, 'merge');
  const [c, d] = pair(14, 2, 3);
  assert.ok(similarity(c!, d!) < SAME_AT && similarity(c!, d!) > SIMILAR_AT);
  assert.equal(matchCandidate(cand(d!.trigger, ''), [lesson('L-1', c!.trigger, '')]).kind, 'similar');
});

test('boundary at 0.45: nine of twenty is similar, four of nine is not', () => {
  const [a, b] = pair(9, 5, 6);
  assert.equal(similarity(a!, b!), SIMILAR_AT);
  assert.equal(matchCandidate(cand(b!.trigger, ''), [lesson('L-1', a!.trigger, '')]).kind, 'similar');
  const [c, d] = pair(4, 2, 3);
  assert.ok(similarity(c!, d!) < SIMILAR_AT);
  assert.equal(matchCandidate(cand(d!.trigger, ''), [lesson('L-1', c!.trigger, '')]).kind, 'new');
});

test('a rule and its negation are not the same rule', () => {
  const a = { trigger: 'When committing', action: 'Sign every commit' };
  const b = { trigger: 'When committing', action: "Don't sign every commit" };
  assert.equal(similarity(a, b), 0.44);
  assert.equal(similarity(b, { trigger: b.trigger, action: "Don't sign each commit" }) > 0.44, true, 'both negated');
});

test('different code tokens cap the similarity at 0.44: pnpm is not yarn', () => {
  const a = { trigger: 'When adding a dependency', action: 'Use `pnpm`' };
  const b = { trigger: 'When adding a dependency', action: 'Use `yarn`' };
  assert.equal(similarity(a, b), 0.44);
  assert.equal(matchCandidate(cand(b.trigger, b.action), [lesson('L-1', a.trigger, a.action)]).kind, 'new');
  // One side with no code, or a code token in common, is not capped
  assert.ok(similarity(a, { trigger: a.trigger, action: 'Use it' }) > 0.44);
  assert.equal(similarity(a, { ...a, action: 'Use `pnpm` always' }) > 0.44, true);
  assert.equal(similarity(a, a), 1);
});

test('same as an active lesson merges; as a proposal appends; as a rejected one is a duplicate; as a retired one revives', () => {
  const text = ['When adding a dependency', 'Use the lockfile'] as const;
  for (const [status, kind] of [
    ['active', 'merge'],
    ['proposed', 'append'],
    ['rejected', 'duplicate-rejected'],
    ['retired', 'revive'],
    ['superseded', 'revive'],
  ] as const) {
    const m = matchCandidate(cand(...text), [lesson('L-1', ...text, status)]);
    assert.equal(m.kind, kind, status);
    assert.equal(m.lesson?.key, 'L-1');
  }
});

test('on a tie the live lesson wins over a refused one', () => {
  const text = ['When adding a dependency', 'Use the lockfile'] as const;
  const m = matchCandidate(cand(...text), [lesson('L-1', ...text, 'rejected'), lesson('L-2', ...text, 'active')]);
  assert.deepEqual([m.kind, m.lesson?.key], ['merge', 'L-2']);
});

test('similar to an active lesson offers a merge; to any other status it is new', () => {
  const [a, b] = pair(9, 5, 6);
  assert.equal(matchCandidate(cand(b!.trigger, ''), [lesson('L-1', a!.trigger, '', 'proposed')]).kind, 'new');
  assert.equal(matchCandidate(cand(b!.trigger, ''), [lesson('L-1', a!.trigger, '', 'rejected')]).kind, 'new');
});

test("the model's restates counts only with a similarity of its own", () => {
  const [a, b] = pair(9, 5, 6);
  const far = { trigger: `${words(0, 2)} ${words(300, 12)}` };
  const near = lesson('L-4', a!.trigger, '');
  assert.equal(matchCandidate(cand(b!.trigger, '', { restates: 'L-4' }), [near]).kind, 'similar');
  const m = matchCandidate(cand(far.trigger, '', { restates: 'L-4' }), [near]);
  assert.equal(m.kind, 'new', 'the claim is not enough on its own');
  assert.equal(matchCandidate(cand(b!.trigger, '', { restates: 'L-99' }), [lesson('L-4', 'zz1 zz2 zz3', '')]).kind, 'new');
});

test('contradicts needs an active lesson of the list', () => {
  const active = lesson('L-7', 'When committing', 'Sign every commit');
  const c = cand('When committing', 'Never sign commits', { contradicts: 'L-7' });
  const m = matchCandidate(c, [active]);
  assert.deepEqual([m.kind, m.lesson?.key], ['contradicts', 'L-7']);
  assert.equal(matchCandidate(c, [lesson('L-7', 'When committing', 'Sign every commit', 'retired')]).kind, 'new');
  assert.equal(matchCandidate(c, [lesson('L-8', 'When committing', 'Sign every commit')]).kind, 'new', 'an id that is not in the list');
  assert.equal(matchCandidate(c, []).kind, 'new');
});

test('across projects: active lessons at the same threshold are counted', () => {
  const l = { trigger: 'When adding a dependency', action: 'Use the lockfile' };
  const others = [
    { ...l, status: 'active' as const },
    { ...l, status: 'retired' as const },
    { trigger: 'When naming a branch', action: 'Prefix the ticket', status: 'active' as const },
  ];
  assert.equal(alsoInProjects(l, others), 1);
});
