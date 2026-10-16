// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowCheckVerdict, Orchestration, VerificationFix, VerificationState } from '@claudio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { VerificationCard, VerificationFixes } from '../src/components/VerificationCard';
import { FixVerdicts } from '../src/pages/tasks/item/FixVerdicts';

// What a fixer fixed and why its loop stopped (idea 8): the "Arreglos" rows under the commits, the
// warn tag with the word "Stopped", and the same call per check in the fix panel.

const fix = (attempt: number, over: Partial<VerificationFix> = {}): VerificationFix => ({
  runId: `r${String(attempt)}`,
  command: 'pnpm test',
  attempt,
  startedAt: '2026-10-16T10:00:00Z',
  endedAt: '2026-10-16T10:05:00Z',
  costUsd: 0.1,
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('the fixes list shows one mono path:line row per fix with its note, and no link', () => {
  const html = renderToStaticMarkup(
    <VerificationFixes fixes={[fix(1, { fixed: [{ path: 'src/cart.ts', line: 12, note: 'wrong import' }, { path: 'src/totals.ts', line: null, note: 'rounded twice' }] })]} />,
  );
  assert.match(html, /<code class="mono break">src\/cart\.ts:12<\/code><span class="break">wrong import<\/span>/);
  assert.match(html, /<code class="mono break">src\/totals\.ts<\/code>/);
  assert.match(text(html), /Fixes Attempt 1/);
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /vfix-stop/);
});

test('a fixer that stopped carries a warn tag with the word, the kind in words and its note', () => {
  const html = renderToStaticMarkup(<VerificationFixes fixes={[fix(1, { stop: { kind: 'design', note: 'the stored format must change', by: 'fixer' } })]} />);
  assert.match(html, /badge badge-warn/);
  assert.match(text(html), /Stopped needs a design decision the stored format must change/);
  const kinds = { 'same-error': 'the same error after three attempts', 'more-errors': 'more errors than before', design: 'needs a design decision' } as const;
  for (const [kind, words] of Object.entries(kinds)) {
    const one = renderToStaticMarkup(<VerificationFixes fixes={[fix(2, { stop: { kind: kind as keyof typeof kinds, note: '', by: 'claudio' } })]} />);
    assert.match(text(one), new RegExp(`Stopped ${words}`));
  }
});

test('with no fixes the section is hidden, and a fix without rows is its attempt line alone', () => {
  assert.equal(renderToStaticMarkup(<VerificationFixes fixes={[]} />), '');
  const bare = renderToStaticMarkup(<VerificationFixes fixes={[fix(1)]} />);
  assert.match(text(bare), /Fixes Attempt 1/);
  assert.doesNotMatch(bare, /vfix-row small/);
});

test('more than eight rows fold behind a title that counts them', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${String(i)}.ts`, line: i + 1, note: 'typo' }));
  const folded = renderToStaticMarkup(<VerificationFixes fixes={[fix(1, { fixed: many })]} />);
  assert.match(text(folded), /9 fixes/);
  assert.doesNotMatch(folded, /vfix-row small/);
  const shown = renderToStaticMarkup(<VerificationFixes fixes={[fix(1, { fixed: many.slice(0, 8) })]} />);
  assert.equal((shown.match(/vfix-row small/g) ?? []).length, 8);
});

test('the card puts the fixes under the checks and before the commits', () => {
  const state: VerificationState = {
    status: 'failed',
    startedAt: null,
    endedAt: null,
    fixes: [fix(1, { fixed: [{ path: 'a.ts', line: 1, note: 'n' }], stop: { kind: 'more-errors', note: 'B', by: 'claudio' } })],
    attempts: 1,
    commands: [],
    commits: [{ hash: 'abcdef1234567890', subject: 'fix: a', author: 'Claude', at: '2026-10-16T10:00:00Z' }],
    report: 'stopped',
    costUsd: 0.1,
  };
  const html = renderToStaticMarkup(<VerificationCard orch={{ verification: state } as unknown as Orchestration} />);
  assert.ok(html.indexOf('vfix-row small') > 0 && html.indexOf('vfix-row small') < html.indexOf('abcdef12'));
  assert.match(text(html), /Stopped more errors than before/);
});

test('the same rows read in Spanish', async () => {
  await i18n.changeLanguage('es');
  const html = renderToStaticMarkup(
    <VerificationFixes fixes={[fix(2, { fixed: [{ path: 'a.ts', line: 3, note: 'x' }], stop: { kind: 'same-error', note: 'sigue', by: 'claudio' } })]} />,
  );
  assert.match(text(html), /Arreglos Intento 2/);
  assert.match(text(html), /Detenido el mismo error tras tres intentos sigue/);
});

test('the fix panel shows locations under a fixed check and a stop in warn in place of "No change"', async () => {
  const verdicts: FlowCheckVerdict[] = [
    { name: 'unit', cause: 'branch', fixed: true, locations: ['src/a.ts:3', 'src/b.ts:9'] },
    { name: 'lint', cause: 'branch', fixed: false, stopped: 'design' },
    { name: 'e2e', cause: 'not-branch', fixed: false },
  ];
  const html = renderToStaticMarkup(<FixVerdicts verdicts={verdicts} />);
  assert.match(html, /badge badge-ok/);
  assert.match(html, /<code class="mono">src\/a\.ts:3<\/code>/);
  assert.match(text(html), /lint Stopped needs a design decision/);
  assert.match(text(html), /e2e No change/);
  assert.equal(renderToStaticMarkup(<FixVerdicts verdicts={[]} />), '');
  await i18n.changeLanguage('es');
  const es = text(renderToStaticMarkup(<FixVerdicts verdicts={verdicts} />));
  assert.match(es, /unit Arreglado/);
  assert.match(es, /lint Detenido necesita una decisión de diseño/);
  assert.match(es, /e2e Sin cambios/);
});
