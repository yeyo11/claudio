import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_CONTINUATIONS, type ContentBlock, type ContinuationEffect, type RunEvent } from '@claudio/shared';
import { callsOfTurn, commitCountSince, continuationEffect, continuationState, headOf } from '../src/continuation-effects.ts';
import { continuationPlan, decisionMayContinue, OWES_WORK_ITEM } from '../src/open-items.ts';

// What a continuation changed and the code rules over the next one (docs/plans/decision-engine-v2.md,
// M3 and D4): the counting is pure over a turn's events and a repository's history.

let seq = 0;
const event = (...blocks: ContentBlock[]): RunEvent => ({
  seq: ++seq,
  ts: '2026-11-13T10:00:00.000Z',
  kind: 'message',
  entry: { uuid: `u${String(seq)}`, role: blocks[0]?.type === 'tool_result' ? 'user' : 'assistant', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks },
});
const use = (id: string, name: string, input: Record<string, unknown> = {}): RunEvent => event({ type: 'tool_use', id, name, input });
const result = (id: string, isError = false): RunEvent => event({ type: 'tool_result', toolUseId: id, content: isError ? 'refused' : 'ok', isError });

const effect = (n: number, cause: ContinuationEffect['cause'], changed: boolean): ContinuationEffect => ({ n, cause, changed, commits: changed ? 1 : 0, edits: 0 });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-continuation-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}
const commit = (dir: string, file: string): void => {
  writeFileSync(join(dir, file), `${file}\n`);
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', file], { stdio: 'ignore' });
};

// ---------- counting a turn ----------

test('a turn that edited counts each file-editing call, a subagent sidechain included, and a failed one not at all', () => {
  const events = [use('w1', 'Write'), result('w1'), use('e1', 'Edit'), result('e1'), use('e2', 'MultiEdit'), result('e2', true), use('n1', 'NotebookEdit'), result('n1')];
  assert.deepEqual(callsOfTurn(events), { edits: 3, delegated: 0 });
});

test('a turn that only read or checked counts no edit', () => {
  const events = [use('r1', 'Read'), result('r1'), use('g1', 'Grep'), result('g1'), use('b1', 'Bash', { command: 'pnpm test' }), result('b1')];
  assert.deepEqual(callsOfTurn(events), { edits: 0, delegated: 0 });
  assert.equal(continuationEffect(1, 'phrase', { commits: 0, ...callsOfTurn(events) }).changed, false);
});

test('a turn that used no tool changed nothing', () => {
  assert.deepEqual(callsOfTurn([event({ type: 'text', text: 'Nothing is owed.' })]), { edits: 0, delegated: 0 });
  assert.deepEqual(continuationEffect(2, 'decision', { commits: 0, edits: 0, delegated: 0 }), { n: 2, cause: 'decision', changed: false, commits: 0, edits: 0 });
});

test('a turn that started a background subagent changed something, and a foreground one alone did not', () => {
  const background = callsOfTurn([use('a1', 'Agent', { description: 'survey', run_in_background: true }), use('t1', 'Task', { description: 'x' })]);
  assert.deepEqual(background, { edits: 0, delegated: 1 });
  assert.equal(continuationEffect(1, 'structural', { commits: 0, ...background }).changed, true);
});

test('a continuation that committed is counted from the HEAD it was sent at', () => {
  const dir = repo();
  const head = headOf(dir);
  assert.ok(head);
  assert.equal(commitCountSince(dir, head), 0);
  commit(dir, 'b.txt');
  commit(dir, 'c.txt');
  assert.equal(commitCountSince(dir, head), 2);
  const recorded = continuationEffect(1, 'phrase', { commits: commitCountSince(dir, head), edits: 0, delegated: 0 });
  assert.deepEqual(recorded, { n: 1, cause: 'phrase', changed: true, commits: 2, edits: 0 });
});

test('outside a repository, or with no HEAD to start from, a turn committed nothing', () => {
  const plain = mkdtempSync(join(tmpdir(), 'claudio-continuation-plain-'));
  assert.equal(headOf(plain), null);
  assert.equal(headOf(null), null);
  assert.equal(commitCountSince(plain, 'deadbeef'), 0);
  assert.equal(commitCountSince(repo(), null), 0);
});

// ---------- why a continuation is sent ----------

const phrase = 'Your last message offers to continue instead of continuing.';
const structural = 'You have not returned the structured result this run asks for.';

test('a continuation records its cause: structural over phrase, phrase over the decision', () => {
  assert.deepEqual(continuationPlan({ structural: [structural], phrases: [phrase], reading: null, decisionAllowed: true }), { items: [structural, phrase], cause: 'structural' });
  assert.deepEqual(continuationPlan({ structural: [], phrases: [phrase], reading: 'owes', decisionAllowed: true }), { items: [phrase], cause: 'phrase' });
  assert.deepEqual(continuationPlan({ structural: [], phrases: [], reading: 'owes', decisionAllowed: true }), { items: [OWES_WORK_ITEM], cause: 'decision' });
  assert.equal(continuationPlan({ structural: [], phrases: [], reading: null, decisionAllowed: true }), null);
});

test('done and hands-off both waive the phrase list, and never a structural item', () => {
  assert.equal(continuationPlan({ structural: [], phrases: [phrase], reading: 'done', decisionAllowed: true }), null);
  assert.deepEqual(continuationPlan({ structural: [structural], phrases: [phrase], reading: 'done', decisionAllowed: true }), { items: [structural], cause: 'structural' });
});

test('a decision-only continuation the code rules hold back is not sent, while a structural one still is', () => {
  assert.equal(continuationPlan({ structural: [], phrases: [], reading: 'owes', decisionAllowed: false }), null);
  assert.deepEqual(continuationPlan({ structural: [structural], phrases: [], reading: 'owes', decisionAllowed: false }), { items: [structural, OWES_WORK_ITEM], cause: 'structural' });
});

test('the decision-only continuation asks for the step announced or one line saying nothing is owed', () => {
  assert.match(OWES_WORK_ITEM, /a step of your own task is still to be taken\. If one is, take it now\./);
  assert.match(OWES_WORK_ITEM, /If nothing of your task is owed, say so in one line and stop\./);
});

// ---------- the code rules (D4) ----------

test('no second decision-only continuation in a run', () => {
  assert.equal(decisionMayContinue(0, []), true);
  assert.equal(decisionMayContinue(1, [effect(1, 'decision', true)]), false);
  assert.equal(decisionMayContinue(2, [effect(1, 'phrase', true), effect(2, 'decision', true)]), false);
});

test('no decision-only continuation after a continuation that changed nothing', () => {
  assert.equal(decisionMayContinue(1, [effect(1, 'phrase', false)]), false);
  assert.equal(decisionMayContinue(1, [effect(1, 'structural', false)]), false);
  assert.equal(decisionMayContinue(2, [effect(1, 'phrase', false), effect(2, 'phrase', true)]), false);
  assert.equal(decisionMayContinue(1, [effect(1, 'phrase', true)]), true);
});

test('a continuation sent but not on record holds the decision back', () => {
  // A restart lost its effect, or the run was stored before effects were kept
  assert.equal(decisionMayContinue(1, []), false);
  assert.equal(decisionMayContinue(2, [effect(1, 'phrase', true)]), false);
});

test('structural items still reach three continuations, whatever the earlier ones changed', () => {
  const effects: ContinuationEffect[] = [];
  let sent = 0;
  while (sent < MAX_CONTINUATIONS) {
    const plan = continuationPlan({ structural: [structural], phrases: [], reading: 'done', decisionAllowed: decisionMayContinue(sent, effects) });
    if (!plan) break;
    sent += 1;
    effects.push({ n: sent, cause: plan.cause, changed: false, commits: 0, edits: 0 });
  }
  assert.equal(sent, MAX_CONTINUATIONS);
  assert.ok(effects.every((e) => e.cause === 'structural'));
});

// ---------- the state of the question ----------

test("the decision's state carries the deliverable cut to fit, the phrase list's match and the turn's facts", () => {
  const state = continuationState({
    title: 'Wire the route',
    deliverable: `Build the route.\n${'x'.repeat(10_000)}`,
    tail: 'The route is in.',
    continuations: 'no continuation yet',
    phraseListMatched: false,
    turn: { commits: 1, edits: 3 },
    maxBytes: 4096,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 4096);
  assert.match(String(state.deliverable), /^Build the route\./);
  assert.match(String(state.deliverable), /…$/);
  assert.deepEqual([state.tail, state.phraseListMatched, state.turn], ['The route is in.', false, { commits: 1, edits: 3 }]);
  const short = continuationState({ title: 't', deliverable: '  Do it.  ', tail: 'Done.', continuations: 'no continuation yet', phraseListMatched: true, turn: { commits: 0, edits: 0 }, maxBytes: 4096 });
  assert.equal(short.deliverable, 'Do it.');
});
