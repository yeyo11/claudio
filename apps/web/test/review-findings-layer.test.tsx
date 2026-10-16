// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import type { ReviewFinding, ReviewGateDetail, ReviewRound } from '@claudio/shared';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffView } from '../src/components/changes/DiffView';
import { FileFindingsFold, FindingCard, findingCounts, findingLayer, groupFindings, mergeLayers } from '../src/components/changes/ReviewFindings';
import { threadLayer } from '../src/components/changes/ReviewThreads';
import i18n from '../src/i18n';
import { parseUnified } from '../src/lib/diff';

// The review gate's findings in the integration diff (docs/plans/review-gate.md, Web item 4): a
// card under its line that reuses the `.rt` classes, a pill with the count, file-level findings at
// the top and older heads folded as outdated. Findings are text and never live.

(globalThis as { React?: unknown }).React = React;
void i18n.changeLanguage('en');

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  id: 'f1',
  roundId: 'round-2',
  fingerprint: 'fp',
  source: 'model',
  rule: null,
  dimensions: ['correctness'],
  reportedBy: 1,
  severity: 'high',
  confidence: 0.9,
  title: 'A half-written file aborts the load',
  path: 'a.ts',
  line: 2,
  side: 'right',
  anchor: 'line',
  evidence: 'return JSON.parse(raw)',
  failureScenario: 'It throws on a truncated file',
  suggestion: 'return parse(raw)',
  verdict: 'confirmed',
  verdictReason: 'Reproduced with a file cut at 40 bytes',
  verifierChatId: null,
  blocking: true,
  resolvedInRound: null,
  ...over,
});

const round = (n: number, head: string): ReviewRound => ({
  id: `round-${String(n)}`,
  round: n,
  pass: 1,
  base: 'base',
  head,
  depth: 'full',
  state: 'blocked',
  reason: null,
  files: 1,
  added: 1,
  deleted: 0,
  chunks: 1,
  skippedFiles: [],
  estimateUsd: null,
  costUsd: 0,
  startedAt: '2026-10-16T10:00:00Z',
  endedAt: null,
  accepted: null,
  runs: [],
});

const detail = (findings: ReviewFinding[]): ReviewGateDetail => ({
  state: {
    status: 'blocked',
    phase: null,
    round: 2,
    maxFixRounds: 2,
    head: 'new',
    startedAt: null,
    endedAt: null,
    costUsd: 0,
    reason: null,
    counts: { blocking: 1, advisory: 0, refuted: 0, outside: 0 },
    runs: { total: 0, done: 0, running: 0, failed: 0 },
    depth: 'full',
  },
  rounds: [round(1, 'old'), round(2, 'new')],
  findings,
  totalFindings: findings.length,
});

const DIFF = parseUnified(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n'));

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a finding card reuses the thread card, with severity as a word, no reply field and its text as text', () => {
  const html = renderToStaticMarkup(<FindingCard finding={finding({ title: '<img src=x onerror=alert(1)>' })} />);
  assert.match(html, /class="rt finding open"/);
  assert.match(html, /rt-sev bad/);
  assert.match(text(html), /high correctness a\.ts:2 .*confirmed/);
  assert.match(text(html), /What fails It throws on a truncated file/);
  assert.match(html, /<pre class="rt-evidence">return JSON\.parse\(raw\)<\/pre>/);
  assert.match(text(html), /Suggestion return parse\(raw\)/);
  assert.match(text(html), /Verifier confirmed Reproduced/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /rt-foot|<form|<input/);
});

test('severity colours: critical and high bad, medium warn, low neutral', () => {
  const tone = (severity: ReviewFinding['severity']) => renderToStaticMarkup(<FindingCard finding={finding({ severity })} />).match(/class="rt-sev([^"]*)"/)?.[1];
  assert.equal(tone('critical'), ' bad');
  assert.equal(tone('high'), ' bad');
  assert.equal(tone('medium'), ' warn');
  assert.equal(tone('low'), '');
});

test('a check of Claudio is named as such, and a refuted finding is dimmed', () => {
  const claudio = renderToStaticMarkup(<FindingCard finding={finding({ source: 'claudio', verdict: 'deterministic', verdictReason: 'Matched the secret scan' })} />);
  assert.match(text(claudio), /Claudio&#x27;s check/);
  const refuted = renderToStaticMarkup(<FindingCard finding={finding({ verdict: 'refuted', blocking: false })} />);
  assert.match(refuted, /class="rt finding refuted"/);
});

test('the layer puts a finding under the line it is about, with a pill, and the right side only', () => {
  const grouped = groupFindings(detail([finding({ roundId: 'round-2' })]), 'a.ts');
  const html = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" layer={findingLayer({ file: grouped, phone: false })} />));
  assert.match(html, /diff-note-pill is-open/);
  assert.match(html, /class="rt finding open"/);
  assert.ok(html.indexOf('two') < html.indexOf('class="rt finding open"'));
  assert.ok(html.indexOf('class="rt finding open"') < html.indexOf('three'));
  // A finding on the left side of the same number is not under the new line
  const left = groupFindings(detail([finding({ side: 'left', line: 99 })]), 'a.ts');
  const none = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" layer={findingLayer({ file: left, phone: false })} />));
  assert.doesNotMatch(none, /class="rt finding/);
});

test('the pill counts the findings of the line, and a phone has no pill', () => {
  const two = groupFindings(detail([finding({ id: 'a' }), finding({ id: 'b' })]), 'a.ts');
  const html = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" layer={findingLayer({ file: two, phone: false })} />));
  assert.match(html, /aria-label="2 findings"/);
  const phone = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" wrap layer={findingLayer({ file: two, phone: true })} />));
  assert.doesNotMatch(phone, /diff-note-pill/);
  assert.match(phone, /class="rt finding open"/);
});

test('findings with no line sit at the top of the file, and those of an older head fold as outdated', () => {
  const d = detail([
    finding({ id: 'whole', anchor: 'file', line: null }),
    finding({ id: 'old', roundId: 'round-1' }),
    finding({ id: 'fixed', resolvedInRound: 2 }),
    finding({ id: 'now' }),
  ]);
  const grouped = groupFindings(d, 'a.ts');
  assert.deepEqual(grouped.file.map((f) => f.id), ['whole']);
  assert.deepEqual(grouped.outdated.map((f) => f.id).sort(), ['fixed', 'old']);
  assert.equal(grouped.byLine.get('right:2')?.length, 1);
  const html = renderToStaticMarkup(<FileFindingsFold file={grouped} phone={false} />);
  assert.match(html, /class="rt finding open"/);
  assert.match(text(html), /2 outdated findings · from an earlier commit/);
  // Folded: the outdated cards are not drawn until opened
  assert.equal((html.match(/class="rt finding/g) ?? []).length, 1);
});

test('refuted and outside findings have no line to stand under, and other files are left alone', () => {
  const d = detail([finding({ id: 'r', verdict: 'refuted' }), finding({ id: 'o', anchor: 'outside' }), finding({ id: 'other', path: 'b.ts' })]);
  const grouped = groupFindings(d, 'a.ts');
  assert.equal(grouped.total, 0);
  assert.equal(groupFindings(undefined, 'a.ts').total, 0);
  assert.deepEqual([...findingCounts(d)], [['b.ts', 1]]);
});

test('a thread layer and a finding layer share one DiffView', () => {
  const threads = threadLayer({ changeRequestId: 'cr', file: null, phone: false });
  const merged = mergeLayers(threads, findingLayer({ file: groupFindings(detail([finding({})]), 'a.ts'), phone: false }));
  const html = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" layer={merged} />));
  assert.match(html, /class="rt finding open"/);
  assert.equal(mergeLayers(undefined, undefined), undefined);
});

test('nothing in a finding is live', () => {
  const html = renderToStaticMarkup(<FindingCard finding={finding({})} />);
  assert.doesNotMatch(html, /spinner|live|energy/);
});
