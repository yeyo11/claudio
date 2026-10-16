import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvalExpectation, TranscriptEntry } from '@claudio/shared';
import { commandSegments, evaluateExpectations, globMatch, matchString, type EvalContext } from '../src/evals/matchers.ts';
import { compareVariants, sampleEndCheck, sampleOutcomeOf, scoreRun, tally } from '../src/evals/score.ts';
import { allToolCalls, type SeenCall } from '../src/tool-calls.ts';

const ROOT = '/lane';
let n = 0;

/** An assistant message (one entry) carrying the given calls, each answered in a later entry. */
function transcript(messages: { name: string; input: Record<string, unknown>; error?: boolean; open?: boolean; sub?: boolean }[][]): { entries: TranscriptEntry[]; ids: string[][] } {
  const entries: TranscriptEntry[] = [];
  const ids: string[][] = [];
  for (const [m, calls] of messages.entries()) {
    const own = calls.map(() => `t${++n}`);
    ids.push(own);
    entries.push({
      uuid: `a${m}`, role: 'assistant', timestamp: null, model: null,
      isSidechain: calls.some((c) => c.sub), parentToolUseId: calls.some((c) => c.sub) ? 'parent' : null,
      blocks: calls.map((c, i) => ({ type: 'tool_use' as const, id: own[i] as string, name: c.name, input: c.input })),
    });
    const results = calls.flatMap((c, i) => (c.open ? [] : [{ type: 'tool_result' as const, toolUseId: own[i] as string, content: 'out', isError: c.error === true }]));
    if (results.length) entries.push({ uuid: `u${m}`, role: 'user', timestamp: null, model: null, isSidechain: false, parentToolUseId: null, blocks: results });
  }
  return { entries, ids };
}

const ctxOf = (calls: SeenCall[], extra: Partial<EvalContext> = {}): EvalContext => ({ calls, resultText: 'done', laneRoot: ROOT, touched: [], ...extra });
const run = async (expect: EvalExpectation, calls: SeenCall[], extra: Partial<EvalContext> = {}) => (await evaluateExpectations([expect], ctxOf(calls, extra)))[0]!;

const EDIT = { tool: ['Edit', 'Write'] };

test('allToolCalls numbers calls, groups entries by message, and reads outcome, scope and denial', () => {
  const t = transcript([
    [{ name: 'Read', input: { file_path: '/lane/a.ts' } }, { name: 'Grep', input: { pattern: 'x' }, error: true }],
    [{ name: 'Bash', input: { command: 'ls' }, open: true }],
    [{ name: 'Edit', input: { file_path: '/lane/a.ts' }, sub: true }],
    [{ name: 'Write', input: { file_path: '/lane/b.ts' } }],
  ]);
  const calls = allToolCalls(t.entries, new Set([t.ids[3]![0] as string]));
  assert.deepEqual(calls.map((c) => [c.seq, c.message, c.scope, c.outcome]), [
    [1, 0, 'main', 'ok'], [2, 0, 'main', 'error'], [3, 1, 'main', 'open'], [4, 2, 'sub', 'ok'], [5, 3, 'main', 'denied'],
  ]);
});

test('entries that share a uuid are one assistant message', () => {
  const base = { role: 'assistant' as const, timestamp: null, model: null, isSidechain: false, parentToolUseId: null };
  const calls = allToolCalls([
    { ...base, uuid: 'same', blocks: [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }] },
    { ...base, uuid: 'same', blocks: [{ type: 'tool_use', id: 'x2', name: 'Edit', input: {} }] },
    { ...base, uuid: 'other', blocks: [{ type: 'tool_use', id: 'x3', name: 'Bash', input: {} }] },
  ]);
  assert.deepEqual(calls.map((c) => c.message), [0, 0, 1]);
});

// ---- string matchers ----

test('S: a bare string is a glob; command stars cross "/" and path stars do not', () => {
  assert.equal(matchString('pnpm*test*', 'pnpm --filter x/y test -- a', 'text'), true);
  assert.equal(matchString('pnpm test', 'pnpm test --watch', 'text'), false);
  assert.equal(globMatch('src/*.ts', 'src/a.ts', 'path'), true);
  assert.equal(globMatch('src/*.ts', 'src/deep/a.ts', 'path'), false);
  assert.equal(globMatch('src/**', 'src/deep/a.ts', 'path'), true);
  assert.equal(globMatch('src/?.ts', 'src/a.ts', 'path'), true);
  assert.equal(globMatch('src/?.ts', 'src//.ts', 'path'), false);
  assert.equal(globMatch('src/{a,b}.ts', 'src/b.ts', 'path'), true);
  assert.equal(globMatch('src/{a,b}.ts', 'src/c.ts', 'path'), false);
  assert.equal(globMatch('echo ${HOME}', 'echo ${HOME}', 'text'), true);
});

test('S: equals, contains and regex', () => {
  assert.equal(matchString({ equals: 'a' }, 'a'), true);
  assert.equal(matchString({ equals: 'a' }, 'ab'), false);
  assert.equal(matchString({ contains: 'Ab' }, 'xAby'), true);
  assert.equal(matchString({ contains: 'ab' }, 'xAby'), false);
  assert.equal(matchString({ regex: 'a.c', flags: 'i' }, 'xABCx'), true);
  assert.equal(matchString({ regex: 'a.c' }, 'xABCx'), false);
  assert.equal(matchString({ regex: '(' }, 'x'), false);
  assert.equal(matchString({ regex: 'a', flags: 'g' }, 'a'), false);
  assert.equal(matchString({ regex: 'a'.repeat(513) }, 'a'), false);
});

test('S: no regex runs on more than 16 KiB', () => {
  const big = `${'x'.repeat(16 * 1024)}NEEDLE`;
  assert.equal(matchString({ regex: 'NEEDLE' }, big), false);
  assert.equal(matchString({ regex: '^x+$' }, big), true);
  assert.equal(matchString({ contains: 'NEEDLE' }, big), true);
});

// ---- command segments ----

test('command segments: split, quote-aware, wrappers stripped', () => {
  assert.deepEqual(commandSegments('cd pkg && timeout 300 pnpm test'), ['cd pkg', 'pnpm test']);
  assert.deepEqual(commandSegments('A=1 B="x y" env nice -n 5 command pnpm test | tee out; git status'), ['pnpm test | tee out'.split(' | ')[0], 'tee out', 'git status']);
  assert.deepEqual(commandSegments('echo "a && b; c" && ls'), ['echo "a && b; c"', 'ls']);
  assert.deepEqual(commandSegments("echo 'a || b'\nls"), ["echo 'a || b'", 'ls']);
  assert.deepEqual(commandSegments('echo $(a && b) && c'), ['echo $(a && b)', 'c']);
  assert.deepEqual(commandSegments('timeout -k 5 10 pnpm test'), ['pnpm test']);
  assert.deepEqual(commandSegments('cat <<EOF\na && b\nEOF\nls'), ['cat <<EOF\na && b\nEOF', 'ls']);
});

// ---- call matcher fields ----

test('M: tool, command (whole or any segment), path, input, outcome and scope', async () => {
  const t = transcript([
    [{ name: 'Bash', input: { command: 'cd pkg && timeout 300 pnpm test' } }],
    [{ name: 'Read', input: { file_path: '/lane/src/a.ts' }, error: true }],
    [{ name: 'Skill', input: { skill: 'review' } }],
    [{ name: 'mcp__x__do', input: {}, sub: true }],
  ]);
  const calls = allToolCalls(t.entries);
  const called = (call: Parameters<typeof run>[0] extends infer _ ? Record<string, unknown> : never) => run({ kind: 'called', call } as EvalExpectation, calls).then((c) => c.passed);
  assert.equal(await called({ tool: 'Bash', command: 'pnpm test' }), true);
  assert.equal(await called({ tool: 'Bash', command: 'cd pkg && timeout 300 pnpm test' }), true);
  assert.equal(await called({ tool: 'Bash', command: 'pnpm lint' }), false);
  assert.equal(await called({ command: 'pnpm test' }), true);
  assert.equal(await called({ tool: 'Read', path: 'src/*.ts' }), true);
  assert.equal(await called({ tool: 'Read', path: 'src/**', outcome: 'error' }), true);
  assert.equal(await called({ tool: 'Read', outcome: 'ok' }), false);
  assert.equal(await called({ tool: 'Read', path: '/lane/src/a.ts' }), false, 'paths are relative to the lane');
  assert.equal(await called({ tool: 'Skill', input: { skill: 'rev*' } }), true);
  assert.equal(await called({ tool: 'Skill', input: { nope: 'x' } }), false);
  assert.equal(await called({ tool: 'mcp__*' }), false, 'scope defaults to main');
  assert.equal(await called({ tool: 'mcp__*', scope: 'sub' }), true);
  assert.equal(await called({ tool: ['Nope', 'mcp__*'], scope: 'any' }), true);
});

test('path outside the lane stays absolute and never matches a relative glob', async () => {
  const calls = allToolCalls(transcript([[{ name: 'Read', input: { file_path: '/etc/passwd' } }, { name: 'Read', input: { file_path: '/lane/../lane2/x' } }]]).entries);
  assert.equal((await run({ kind: 'called', call: { tool: 'Read', path: '**' } }, calls)).passed, false);
  assert.equal((await run({ kind: 'called', call: { tool: 'Read', path: '/etc/*' } }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: { tool: 'Read', path: 'etc/**' } }, calls)).passed, false);
});

test('M: F7 input fields: notebook_path, Glob and Grep path; Bash has no path', async () => {
  const calls = allToolCalls(transcript([[
    { name: 'NotebookEdit', input: { notebook_path: '/lane/n.ipynb' } },
    { name: 'Grep', input: { pattern: 'x', path: '/lane/src' } },
    { name: 'Bash', input: { command: 'ls', path: 'x' } },
  ]]).entries);
  assert.equal((await run({ kind: 'called', call: { tool: 'NotebookEdit', path: 'n.ipynb' } }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: { tool: 'Grep', path: 'src' } }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: { tool: 'Bash', path: '*' } }, calls)).passed, false);
});

// ---- expectations ----

test('called: min, max, min 0 with max as a cap; detail names the call by seq', async () => {
  const calls = allToolCalls(transcript([[{ name: 'Edit', input: { file_path: '/lane/a' } }], [{ name: 'Edit', input: { file_path: '/lane/b' } }]]).entries);
  const edit = { tool: 'Edit' };
  assert.equal((await run({ kind: 'called', call: edit }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: edit, min: 3 }, calls)).passed, false);
  assert.equal((await run({ kind: 'called', call: edit, max: 1 }, calls)).passed, false);
  assert.equal((await run({ kind: 'called', call: edit, min: 0, max: 2 }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: { tool: 'Nope' }, min: 0, max: 0 }, calls)).passed, true);
  const c = await run({ kind: 'called', call: edit, min: 2 }, calls);
  assert.equal(c.evidenceSeq, 1);
  assert.match(c.detail, /\(#1\)/);
});

test('not-called', async () => {
  const calls = allToolCalls(transcript([[{ name: 'Bash', input: { command: 'git push origin main' } }]]).entries);
  const bad = await run({ kind: 'not-called', call: { tool: 'Bash', command: 'git push*' } }, calls);
  assert.equal(bad.passed, false);
  assert.equal(bad.evidenceSeq, 1);
  assert.equal((await run({ kind: 'not-called', call: { tool: 'Bash', command: 'git pull*' } }, calls)).passed, true);
});

test('before: strictly earlier message; same-message calls are simultaneous', async () => {
  const earlier = allToolCalls(transcript([[{ name: 'Read', input: { file_path: '/lane/t' } }], [{ name: 'Edit', input: { file_path: '/lane/a' } }]]).entries);
  const same = allToolCalls(transcript([[{ name: 'Read', input: { file_path: '/lane/t' } }, { name: 'Edit', input: { file_path: '/lane/a' } }]]).entries);
  const later = allToolCalls(transcript([[{ name: 'Edit', input: { file_path: '/lane/a' } }], [{ name: 'Read', input: { file_path: '/lane/t' } }]]).entries);
  const e: EvalExpectation = { kind: 'before', call: { tool: 'Read' }, anchor: { tool: 'Edit' } };
  assert.equal((await run(e, earlier)).passed, true);
  const tie = await run(e, same);
  assert.equal(tie.passed, false);
  assert.match(tie.detail, /same message/);
  assert.equal((await run(e, later)).passed, false);
});

test('before/after: ifAnchor decides when the anchor never happened', async () => {
  const calls = allToolCalls(transcript([[{ name: 'Read', input: { file_path: '/lane/t' } }]]).entries);
  for (const kind of ['before', 'after'] as const) {
    const without = await run({ kind, call: { tool: 'Bash' }, anchor: { tool: 'Edit' } }, calls);
    assert.equal(without.passed, false);
    assert.match(without.detail, /anchor never happened/);
    assert.equal((await run({ kind, call: { tool: 'Bash' }, anchor: { tool: 'Edit' }, ifAnchor: true }, calls)).passed, true);
  }
});

test('after: strictly later than the last anchor; ties fail', async () => {
  const ok = allToolCalls(transcript([[{ name: 'Edit', input: { file_path: '/lane/a' } }], [{ name: 'Bash', input: { command: 'pnpm test' } }]]).entries);
  const tie = allToolCalls(transcript([[{ name: 'Edit', input: { file_path: '/lane/a' } }, { name: 'Bash', input: { command: 'pnpm test' } }]]).entries);
  const lastEdit = allToolCalls(transcript([[{ name: 'Edit', input: { file_path: '/lane/a' } }], [{ name: 'Bash', input: { command: 'pnpm test' } }], [{ name: 'Edit', input: { file_path: '/lane/a' } }]]).entries);
  const e: EvalExpectation = { kind: 'after', call: { tool: 'Bash', command: 'pnpm*test*' }, anchor: EDIT, ifAnchor: true };
  const pass = await run(e, ok);
  assert.equal(pass.passed, true);
  assert.match(pass.detail, /\(#2\) is after the last anchor Edit/);
  assert.equal((await run(e, tie)).passed, false);
  assert.equal((await run(e, lastEdit)).passed, false, 'the last anchor is the one that counts');
});

test('sequence: subsequence over increasing messages; strict means consecutive main calls', async () => {
  const calls = allToolCalls(transcript([
    [{ name: 'Read', input: { file_path: '/lane/a' } }],
    [{ name: 'Grep', input: {} }],
    [{ name: 'Edit', input: { file_path: '/lane/a' } }],
    [{ name: 'Bash', input: { command: 'pnpm test' } }],
  ]).entries);
  const seq = (names: string[], strict?: boolean) => run({ kind: 'sequence', calls: names.map((tool) => ({ tool })), ...(strict ? { strict } : {}) }, calls);
  assert.equal((await seq(['Read', 'Edit', 'Bash'])).passed, true);
  assert.equal((await seq(['Edit', 'Read'])).passed, false);
  assert.equal((await seq(['Read', 'Edit'], true)).passed, false);
  assert.equal((await seq(['Grep', 'Edit', 'Bash'], true)).passed, true);
  const fail = await seq(['Read', 'Nope']);
  assert.match(fail.detail, /step 2 of 2 never happens after Read/);
  // two matchers cannot be satisfied by one message
  const one = allToolCalls(transcript([[{ name: 'Read', input: {} }, { name: 'Edit', input: {} }]]).entries);
  assert.equal((await run({ kind: 'sequence', calls: [{ tool: 'Read' }, { tool: 'Edit' }] }, one)).passed, false);
});

test('denied, open and subagent calls', async () => {
  const t = transcript([
    [{ name: 'Bash', input: { command: 'rm -rf x' } }],
    [{ name: 'Bash', input: { command: 'sleep 9' }, open: true }],
    [{ name: 'Edit', input: { file_path: '/lane/a' }, sub: true }],
  ]);
  const calls = allToolCalls(t.entries, new Set([t.ids[0]![0] as string]));
  assert.equal((await run({ kind: 'called', call: { tool: 'Bash', command: 'rm*', outcome: 'denied' } }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: { tool: 'Bash', command: 'rm*', outcome: 'ok' } }, calls)).passed, false);
  assert.equal((await run({ kind: 'called', call: { tool: 'Bash', command: 'sleep*' } }, calls)).passed, true);
  assert.equal((await run({ kind: 'called', call: { tool: 'Bash', command: 'sleep*', outcome: 'ok' } }, calls)).passed, false);
  assert.equal((await run({ kind: 'not-called', call: { tool: 'Edit' } }, calls)).passed, true, 'a subagent call is not a main call');
  assert.equal((await run({ kind: 'not-called', call: { tool: 'Edit', scope: 'any' } }, calls)).passed, false);
});

test('text: matches the final result; none is a failure', async () => {
  assert.equal((await run({ kind: 'text', match: { contains: 'do' } }, [])).passed, true);
  assert.equal((await run({ kind: 'text', match: 'x*' }, [])).passed, false);
  const none = await run({ kind: 'text', match: '*' }, [], { resultText: null });
  assert.equal(none.passed, false);
  assert.match(none.detail, /no final text/);
});

test('touched: matches git status paths', async () => {
  const touched = ['src/a.ts', 'docs/x.md'];
  assert.equal((await run({ kind: 'touched', path: 'src/*.ts', expect: true }, [], { touched })).passed, true);
  assert.equal((await run({ kind: 'touched', path: 'CHANGELOG.md', expect: false }, [], { touched })).passed, true);
  assert.equal((await run({ kind: 'touched', path: 'docs/**', expect: false }, [], { touched })).passed, false);
  assert.equal((await run({ kind: 'touched', path: 'CHANGELOG.md', expect: true }, [], { touched })).passed, false);
});

test('file: exists, contains, and realpath containment', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'ev-out-'));
  const lane = mkdtempSync(join(tmpdir(), 'ev-lane-'));
  try {
    mkdirSync(join(lane, 'src'));
    writeFileSync(join(lane, 'src', 'r.ts'), 'for (i = 0; i <= end; i++)');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(outside, join(lane, 'link'));
    symlinkSync(join(outside, 'gone'), join(lane, 'dangling'));
    const f = (e: Partial<Extract<EvalExpectation, { kind: 'file' }>> & { path: string }) => run({ kind: 'file', ...e }, [], { laneRoot: lane });
    assert.equal((await f({ path: 'src/r.ts', exists: true })).passed, true);
    assert.equal((await f({ path: 'src/r.ts', contains: { regex: '<=\\s*end' } })).passed, true);
    assert.equal((await f({ path: 'src/r.ts', contains: { contains: 'nope' } })).passed, false);
    assert.equal((await f({ path: 'src/none.ts', exists: false })).passed, true);
    assert.equal((await f({ path: 'src/none.ts', exists: true })).passed, false);
    assert.equal((await f({ path: 'src/r.ts', exists: false })).passed, false);
    assert.equal((await f({ path: 'src/none.ts', contains: 'x' })).passed, false);
    const escaped = await f({ path: 'link/secret.txt', contains: 'SECRET' });
    assert.equal(escaped.passed, false);
    assert.match(escaped.detail, /outside the lane/);
    assert.equal((await f({ path: '../x', exists: false })).passed, false);
    assert.equal((await f({ path: '/etc/passwd', exists: true })).passed, false);
    assert.equal((await f({ path: 'src/*.ts', exists: true })).passed, false);
    assert.equal((await f({ path: 'dangling', exists: false })).passed, false, 'a dangling link is not absent');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(lane, { recursive: true, force: true });
  }
});

test('command: runs in the lane through runCommand and checks the exit code', async () => {
  const seen: { command: string; cwd: string; ms: number }[] = [];
  const outcome = (exitCode: number, extra: object = {}) => ({ ok: exitCode === 0, exitCode, timedOut: false, cancelled: false, output: 'x'.repeat(5000), failedSpecs: [], durationMs: 1, ...extra });
  const runner = (code: number, extra?: object) => async (command: string, cwd: string, ms: number) => {
    seen.push({ command, cwd, ms });
    return outcome(code, extra);
  };
  const pass = await run({ kind: 'command', run: 'pnpm test' }, [], { runCommand: runner(0) as EvalContext['runCommand'] });
  assert.equal(pass.passed, true);
  assert.deepEqual(seen[0], { command: 'pnpm test', cwd: ROOT, ms: 120_000 });
  assert.equal(pass.output?.length, 4096);
  assert.equal((await run({ kind: 'command', run: 'x' }, [], { runCommand: runner(1) as EvalContext['runCommand'] })).passed, false);
  assert.equal((await run({ kind: 'command', run: 'x', exitCode: 3, timeoutSeconds: 99999 }, [], { runCommand: runner(3) as EvalContext['runCommand'] })).passed, true);
  assert.equal(seen[2]?.ms, 1_800_000);
  const timedOut = await run({ kind: 'command', run: 'x' }, [], { runCommand: runner(0, { timedOut: true }) as EvalContext['runCommand'] });
  assert.equal(timedOut.passed, false);
  assert.match(timedOut.detail, /did not finish/);
  const real = await run({ kind: 'command', run: 'exit 2', exitCode: 2 }, [], { laneRoot: tmpdir() });
  assert.equal(real.passed, true);
});

test('a bad regex fails the check with the reason; one throwing check does not stop the rest', async () => {
  const checks = await evaluateExpectations(
    [{ kind: 'text', match: { regex: '(' } }, { kind: 'text', match: { contains: 'do' } }],
    ctxOf([]),
  );
  assert.equal(checks[0]?.passed, false);
  assert.match(checks[0]?.detail ?? '', /does not compile/);
  assert.equal(checks[1]?.passed, true);
  assert.deepEqual(checks.map((c) => c.idx), [0, 1]);
});

// ---- scoring ----

test('sample end check and outcome', () => {
  assert.equal(sampleEndCheck({ isError: false }).passed, true);
  const budget = sampleEndCheck({ isError: true, budgetExceeded: true });
  assert.equal(budget.passed, false);
  assert.equal(budget.kind, 'sample');
  assert.match(budget.detail, /budget/);
  assert.match(sampleEndCheck({ isError: false, timedOut: true }).detail, /time limit/);
  assert.equal(sampleOutcomeOf([budget]), 'failed');
  assert.equal(sampleOutcomeOf([sampleEndCheck({ isError: false })]), 'passed');
});

test('tally and scoreRun count only passed and failed', () => {
  assert.deepEqual(tally(['passed', 'failed', 'limit', 'infra', null]), { passed: 1, scored: 2, flaky: true });
  assert.deepEqual(tally(['passed', 'passed']), { passed: 2, scored: 2, flaky: false });
  assert.deepEqual(tally(['limit']), { passed: 0, scored: 0, flaky: false });
  const s = (caseId: string, variant: 'pinned' | 'current', outcome: 'passed' | 'failed' | 'limit') => ({ caseId, variant, outcome });
  assert.deepEqual(
    scoreRun([s('a', 'pinned', 'passed'), s('a', 'pinned', 'passed'), s('b', 'pinned', 'passed'), s('b', 'pinned', 'failed'), s('c', 'pinned', 'limit'), s('a', 'current', 'failed')]),
    { pinned: { passed: 1, of: 2 }, current: { passed: 0, of: 1 } },
  );
});

test('compareVariants: regressed, improved, same, with mean cost and duration', () => {
  const s = (caseId: string, variant: 'pinned' | 'current', outcome: 'passed' | 'failed' | 'limit', costUsd = 1, durationMs = 100) => ({ caseId, variant, outcome, costUsd, durationMs });
  const cmp = compareVariants('r1', 'pinned', 'current', [
    s('reg', 'pinned', 'passed'), s('reg', 'pinned', 'passed'), s('reg', 'current', 'passed'), s('reg', 'current', 'failed'),
    s('imp', 'pinned', 'failed'), s('imp', 'current', 'passed'),
    s('same', 'pinned', 'passed'), s('same', 'current', 'passed'),
    s('flaky', 'pinned', 'passed'), s('flaky', 'pinned', 'failed'), s('flaky', 'current', 'passed'), s('flaky', 'current', 'failed'),
    s('lim', 'pinned', 'passed'), s('lim', 'current', 'limit'),
  ]);
  const verdict = Object.fromEntries(cmp.cases.map((c) => [c.caseId, c.verdict]));
  assert.deepEqual(verdict, { reg: 'regressed', imp: 'improved', same: 'same', flaky: 'same', lim: 'same' });
  assert.equal(cmp.cases.find((c) => c.caseId === 'flaky')?.base.flaky, true);
  assert.deepEqual(cmp.mean.pinned, { costUsd: 1, durationMs: 100 });
});
