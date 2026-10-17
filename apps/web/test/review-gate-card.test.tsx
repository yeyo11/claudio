// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Orchestration, ReviewFinding, ReviewGateDetail, ReviewGateState, ReviewGateStatus, ReviewRound, ReviewRun, VerificationState } from '@claudio/shared';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { AcceptFields, SkippedFiles, canAcceptIncomplete, groupOfFindings } from '../src/components/ReviewGateSection';
import { VerificationCard } from '../src/components/VerificationCard';
import i18n from '../src/i18n';
import { reviewHolds } from '../src/lib/orchestration-v2';

// The review section of the verification card (docs/plans/review-gate.md, Web items 3 and 5): each
// state says its word, the actions follow the state, and a finding is text, never markup.

(globalThis as { React?: unknown }).React = React;

const gate = (status: ReviewGateStatus, over: Partial<ReviewGateState> = {}): ReviewGateState => ({
  status,
  phase: status === 'running' ? 'reviewing' : null,
  round: 1,
  maxFixRounds: 2,
  head: 'a1b2c3d4e5f6',
  startedAt: '2026-10-16T10:00:00Z',
  endedAt: status === 'running' || status === 'pending' ? null : '2026-10-16T10:09:00Z',
  costUsd: 1.84,
  reason: null,
  counts: { blocking: 0, advisory: 0, refuted: 0, outside: 0 },
  runs: { total: 4, done: 2, running: 1, failed: 0 },
  depth: 'full',
  ...over,
});

const run = (id: string, over: Partial<ReviewRun> = {}): ReviewRun => ({
  id,
  kind: 'reviewer',
  dimension: 'correctness',
  chunk: 1,
  chunks: 2,
  chatId: `chat-${id}`,
  model: 'sonnet',
  effort: null,
  account: null,
  roleSource: 'builtin',
  state: 'done',
  failure: null,
  dropped: 0,
  costUsd: 0.41,
  startedAt: '2026-10-16T10:00:00Z',
  endedAt: '2026-10-16T10:03:00Z',
  ...over,
});

const round = (n: number, state: ReviewRound['state'], runs: ReviewRun[] = [], over: Partial<ReviewRound> = {}): ReviewRound => ({
  id: `round-${String(n)}`,
  round: n,
  pass: 1,
  base: 'base',
  head: 'a1b2c3d4e5f6',
  depth: 'full',
  state,
  reason: null,
  files: 3,
  added: 10,
  deleted: 2,
  chunks: 2,
  skippedFiles: [],
  estimateUsd: null,
  costUsd: 1,
  startedAt: '2026-10-16T10:00:00Z',
  endedAt: null,
  accepted: null,
  runs,
  ...over,
});

const finding = (id: string, over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id,
  roundId: 'round-1',
  fingerprint: id,
  source: 'model',
  rule: null,
  dimensions: ['correctness'],
  reportedBy: 1,
  severity: 'high',
  confidence: 0.9,
  title: `Title ${id}`,
  path: 'src/a.ts',
  line: 10,
  side: 'right',
  anchor: 'line',
  evidence: 'return JSON.parse(raw)',
  failureScenario: 'It throws on a truncated file',
  suggestion: null,
  verdict: 'confirmed',
  verdictReason: 'Reproduced',
  verifierChatId: null,
  blocking: true,
  resolvedInRound: null,
  ...over,
});

const verification = (review: ReviewGateState): VerificationState => ({
  status: review.status === 'running' || review.status === 'pending' ? 'running' : review.status === 'passed' || review.status === 'accepted' ? 'passed' : 'failed',
  gate: 'review',
  startedAt: null,
  endedAt: null,
  attempts: 0,
  commands: [],
  commits: [],
  report: '',
  costUsd: 0,
  review,
});

const render = (review: ReviewGateState, detail?: Partial<ReviewGateDetail>) => {
  const orch = { id: 'o1', verification: verification(review) } as unknown as Orchestration;
  const client = new QueryClient();
  if (detail) {
    const full: ReviewGateDetail = { state: review, rounds: [], findings: [], totalFindings: detail.findings?.length ?? 0, ...detail };
    client.setQueryData([...keys.orchestrationReview('o1'), review.round, review.status, review.runs.done], full);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <VerificationCard orch={orch} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a graph with no review draws no review section', () => {
  const html = renderToStaticMarkup(
    <VerificationCard orch={{ id: 'o', verification: { status: 'passed', startedAt: null, endedAt: null, attempts: 0, commands: [], commits: [], report: '', costUsd: 0 } } as unknown as Orchestration} />,
  );
  assert.doesNotMatch(html, /class="rg/);
});

test('pending and skipped stand still and say their word', () => {
  const pending = render(gate('pending', { runs: { total: 0, done: 0, running: 0, failed: 0 } }));
  assert.match(text(pending), /Review pending/);
  assert.match(pending, /badge badge-idle/);
  assert.doesNotMatch(pending, /live-energy/);
  assert.match(text(pending), /starts once the checks have passed/);
  assert.match(text(render(gate('skipped'))), /Review skipped/);
});

test('a running review has the verb, the sub-phase, the round, the cost of the budget and the one energy border', () => {
  const html = render(gate('running'), {
    rounds: [round(1, 'running', [run('r1'), run('r2', { state: 'running', chunk: 2, costUsd: 0.2 }), run('r3', { dimension: 'tests', chunk: 1, chunks: 1, state: 'pending', startedAt: null })])],
  });
  assert.match(html, /class="rg live-energy"/);
  assert.match(text(html), /Review reviewing/);
  assert.match(text(html), /round 1 of 3/);
  assert.match(text(html), /1[.,]84.* of .*5[.,]00/);
  assert.match(html, /spinner-ring/);
  assert.match(html, /rg-run live-rail/);
  assert.match(text(html), /correctness 1\/2/);
  assert.match(text(html), /queued/);
  assert.match(html, /progress-segbar/);
  // Running offers no action: nothing to accept or retry yet
  assert.doesNotMatch(html, /Retry the review|Accept anyway|Verify again/);
});

test('each sub-phase names itself', () => {
  const phases = { preparing: 'Preparing', reviewing: 'Reviewing', verifying: 'Verifying findings', fixing: 'Fixing', rechecking: 'Re-running the checks' } as const;
  for (const [phase, word] of Object.entries(phases)) {
    assert.match(text(render(gate('running', { phase: phase as keyof typeof phases }))), new RegExp(word));
  }
});

test('fixing round 2 of 3 reads the round in the head', () => {
  assert.match(text(render(gate('running', { phase: 'fixing', round: 2 }))), /Fixing.*round 2 of 3/);
});

test('waiting for a usage limit is a warn line with the reset time', () => {
  const html = render(gate('running', { waiting: { provider: 'claude', resetsAt: '2026-10-16T15:00:00Z', moveId: 'm' } }));
  assert.match(html, /rg-reason warn/);
  assert.match(text(html), /Waiting for a usage limit to reset at/);
});

test('passed with no findings is one ok line and no actions but Verify again', () => {
  const html = render(gate('passed', { runs: { total: 4, done: 4, running: 0, failed: 0 } }), { rounds: [round(1, 'passed')], findings: [] });
  assert.match(html, /badge badge-ok/);
  assert.match(text(html), /Review passed/);
  assert.match(text(html), /No findings/);
  assert.doesNotMatch(html, /Retry the review|Accept anyway/);
});

test('passed with advisories keeps them folded', () => {
  const html = render(gate('passed', { counts: { blocking: 0, advisory: 1, refuted: 0, outside: 0 } }), {
    rounds: [round(1, 'passed')],
    findings: [finding('f1', { blocking: false, severity: 'low' })],
  });
  assert.match(text(html), /Advisory 1/);
  assert.doesNotMatch(text(html), /No findings/);
  assert.match(html, /data-state="closed"/);
});

test('blocked shows the reason in bad, the blocking findings open, and Accept anyway but no Retry', () => {
  const html = render(gate('blocked', { reason: '2 blocking findings remain open after 2 fix rounds', counts: { blocking: 1, advisory: 0, refuted: 0, outside: 0 } }), {
    rounds: [round(1, 'blocked')],
    findings: [finding('f1')],
  });
  assert.match(html, /badge badge-bad/);
  assert.match(html, /rg-reason bad/);
  assert.match(text(html), /2 blocking findings remain open after 2 fix rounds/);
  assert.match(text(html), /Blocking 1/);
  assert.match(html, /rt finding/);
  assert.match(text(html), /Title f1/);
  assert.match(text(html), /Accept anyway/);
  assert.doesNotMatch(html, /Retry the review/);
  assert.match(text(html), /holds the pull request/);
});

test('Retry the review is the zone primary and only for an incomplete gate', () => {
  for (const status of ['pending', 'running', 'passed', 'blocked', 'accepted', 'skipped'] as const) {
    assert.doesNotMatch(render(gate(status)), /Retry the review/, status);
  }
  const html = render(gate('incomplete', { reason: 'A reviewer answered with no findings block' }), { rounds: [round(1, 'incomplete')] });
  assert.match(html, /badge badge-warn/);
  assert.match(html, /rg-reason warn/);
  assert.match(html, /class="btn btn-primary"[^>]*>Retry the review/);
});

test('accepting an incomplete gate stays disabled until a retry also ended incomplete', () => {
  assert.equal(canAcceptIncomplete(undefined), false);
  assert.equal(canAcceptIncomplete({ state: null, rounds: [round(1, 'incomplete')], findings: [], totalFindings: 0 }), false);
  assert.equal(canAcceptIncomplete({ state: null, rounds: [round(1, 'incomplete'), round(2, 'incomplete')], findings: [], totalFindings: 0 }), true);
  const first = render(gate('incomplete', { reason: 'why' }), { rounds: [round(1, 'incomplete')] });
  assert.match(first, /disabled=""[^>]*>Accept anyway/);
  assert.match(text(first), /only after a retry that also ends incomplete/);
  const second = render(gate('incomplete', { reason: 'why', round: 2 }), { rounds: [round(1, 'incomplete'), round(2, 'incomplete')] });
  assert.doesNotMatch(second, /disabled=""[^>]*>Accept anyway/);
});

test('accepted says it in warn with the person and the quoted reason', () => {
  const html = render(gate('accepted', { accepted: { by: 'Marta', reason: 'Generated file, checked by hand', at: '2026-10-16T11:00:00Z', head: 'a1b2c3d4e5f6' } }), {
    rounds: [round(1, 'accepted')],
  });
  assert.match(html, /badge badge-warn/);
  assert.match(text(html), /Review accepted/);
  assert.match(text(html), /Accepted by Marta, who wrote: Generated file, checked by hand/);
  assert.doesNotMatch(html, /Retry the review|Accept anyway/);
});

test('findings fall into blocking, advisory, refuted and outside the diff, and the skipped files are listed with why', () => {
  const all = [finding('b'), finding('a', { blocking: false }), finding('r', { blocking: false, verdict: 'refuted' }), finding('o', { blocking: false, anchor: 'outside' })];
  const groups = groupOfFindings(all);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, (v as ReviewFinding[]).map((f) => f.id)])), { blocking: ['b'], advisory: ['a'], refuted: ['r'], outside: ['o'] });
  const html = render(gate('blocked', { reason: 'x' }), {
    rounds: [round(1, 'blocked', [], { skippedFiles: [{ path: 'dist/big.js', why: 'not-reviewable', detail: '2 MB' }] })],
    findings: all,
  });
  assert.match(text(html), /Blocking 1 .*Advisory 1 .*Refuted 1 .*Outside the diff 1 .*Not reviewed 1/);
  const list = text(renderToStaticMarkup(<SkippedFiles files={[{ path: 'dist/big.js', why: 'not-reviewable', detail: '2 MB' }, { path: 'a.png', why: 'binary' }]} />));
  assert.match(list, /dist\/big\.js too large or over the budget · 2 MB/);
  assert.match(list, /a\.png binary file/);
});

test('a finding is drawn as text, never as markup, with severity, dimension, path:line and the verdict as words', () => {
  const html = render(gate('blocked', { reason: 'x' }), {
    rounds: [round(1, 'blocked')],
    findings: [finding('f1', { title: '<img src=x onerror=alert(1)>', evidence: '<script>alert(1)</script>', dimensions: ['security', 'correctness'] })],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /rt-sev bad/);
  assert.match(text(html), /High/);
  assert.match(text(html), /security correctness/);
  assert.match(text(html), /src\/a\.ts:10/);
  assert.match(text(html), /confirmed/);
});

test('the review holds the pull request until it passed or was accepted', () => {
  for (const status of ['pending', 'running', 'blocked', 'incomplete'] as const) assert.equal(reviewHolds(gate(status)), true, status);
  for (const status of ['passed', 'accepted', 'skipped'] as const) assert.equal(reviewHolds(gate(status)), false, status);
  assert.equal(reviewHolds(undefined), false);
});

test('the accept dialog asks for a reason, warns that it is recorded, and confirms with a button', () => {
  const html = renderToStaticMarkup(<AcceptFields reason="" onReason={() => {}} touched={false} onSubmit={() => {}} />);
  assert.match(text(html), /Verification will pass without the review\. This is recorded with your name/);
  assert.match(html, /aria-required="true"/);
  assert.match(html, /maxLength="1000"|maxlength="1000"/);
  // Nothing was touched yet, so no error is shown; an empty reason is refused once it was
  assert.doesNotMatch(html, /Write a reason to accept/);
  const refused = renderToStaticMarkup(<AcceptFields reason="   " onReason={() => {}} touched onSubmit={() => {}} />);
  assert.match(refused, /role="alert"/);
  assert.match(text(refused), /Write a reason to accept/);
  assert.match(refused, /aria-invalid="true"/);
  const written = renderToStaticMarkup(<AcceptFields reason="checked by hand" onReason={() => {}} touched onSubmit={() => {}} />);
  assert.doesNotMatch(written, /Write a reason to accept/);
});

test('every word of the section has a Spanish copy', async () => {
  await i18n.changeLanguage('es');
  const html = render(gate('blocked', { reason: 'x' }), { rounds: [round(1, 'blocked')], findings: [finding('f1')] });
  assert.match(text(html), /Revisión bloqueada/);
  assert.match(text(html), /Aceptar de todos modos/);
  assert.match(text(html), /Verificar de nuevo/);
  assert.match(text(html), /Bloqueantes 1/);
  assert.doesNotMatch(html, /review\./);
});
