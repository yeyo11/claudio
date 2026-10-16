import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvalDefinition, EvalFileListItem, EvalRunSummary } from '@claudio/shared';
import { teamSearch, teamSection } from '../src/pages/team/model';
import {
  blankDefinition,
  casesScored,
  definitionFromForm,
  definitionFromJson,
  formFromDefinition,
  jsonOf,
  listRows,
  nameFromTitle,
  problemsAt,
  runWord,
  targetPath,
} from '../src/pages/team/evals/model';

// The Evals editor's two faces of one file, and what the list reads off a file and its newest run
// (docs/plans/instruction-evals.md, "Web").

const PIN = 'a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c';

/** The plan's example, every expectation kind included. */
const DEFINITION: EvalDefinition = {
  version: 1,
  title: 'Developer runs the tests after its last edit',
  target: { kind: 'agent', scope: 'project', name: 'developer' },
  runAs: { agent: 'developer', stage: 'work', model: 'claude-sonnet-5-5', effort: 'high' },
  pin: PIN,
  samples: 2,
  limits: { maxCostUsdPerSample: 0.6, timeoutMinutes: 10, maxCostUsd: 6 },
  setup: 'pnpm install',
  cases: [
    {
      id: 'fix-off-by-one',
      title: 'Fixes a failing test and runs the suite after the edit',
      prompt: 'The test `packages/core/test/range.test.ts` fails. Fix `packages/core/src/range.ts`.',
      pin: PIN,
      expect: [
        { kind: 'before', call: { tool: 'Read', path: 'packages/core/test/range.test.ts' }, anchor: { tool: ['Edit', 'MultiEdit', 'Write'] } },
        { kind: 'after', call: { tool: 'Bash', command: 'pnpm*test*' }, anchor: { tool: ['Edit', 'MultiEdit', 'Write'] }, ifAnchor: true },
        { kind: 'not-called', call: { tool: 'Bash', command: 'git push*' } },
        { kind: 'called', call: { tool: 'Edit', path: 'packages/core/src/**', outcome: 'ok', scope: 'any', input: { file_path: { contains: 'range' } } }, min: 1, max: 6 },
        { kind: 'sequence', calls: [{ tool: 'Read' }, { tool: 'Edit' }], strict: true },
        { kind: 'text', match: { regex: 'tests? pass', flags: 'i' } },
        { kind: 'touched', path: 'CHANGELOG.md', expect: false },
        { kind: 'file', path: 'packages/core/src/range.ts', exists: true, contains: { regex: '<=\\s*end' } },
        { kind: 'file', path: 'README.md', contains: { equals: 'x' } },
        { kind: 'command', run: 'pnpm test', exitCode: 0, timeoutSeconds: 300 },
      ],
    },
  ],
};

test('a definition goes through the form and back unchanged', () => {
  assert.deepEqual(definitionFromForm(formFromDefinition(DEFINITION)), DEFINITION);
});

test('what the file leaves empty or null stays out, and a form made from that is the form it came from', () => {
  const plan = {
    ...DEFINITION,
    runAs: { agent: 'developer', stage: 'work', model: 'claude-sonnet-5-5', effort: null },
    policy: null,
    setup: null,
  } as unknown as EvalDefinition;
  const settled = definitionFromForm(formFromDefinition(plan));
  assert.equal('policy' in settled, false);
  assert.equal('setup' in settled, false);
  assert.deepEqual(settled.runAs, { agent: 'developer', stage: 'work', model: 'claude-sonnet-5-5' });
  assert.deepEqual(formFromDefinition(settled), formFromDefinition(plan));
  assert.deepEqual(definitionFromForm(formFromDefinition(settled)), settled);
});

test('a tool policy is carried through the form untouched', () => {
  const policy = { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'any' }, network: 'omit', gitPush: 'deny' } as unknown as EvalDefinition['policy'];
  assert.deepEqual(definitionFromForm(formFromDefinition({ ...DEFINITION, policy })).policy, policy);
});

test('the JSON view reads a definition, and says when the text is not one', () => {
  const read = definitionFromJson(jsonOf(DEFINITION));
  assert.ok(read.ok);
  assert.deepEqual(read.ok && read.definition, DEFINITION);
  assert.equal(definitionFromJson('{ nope').ok, false);
  assert.equal(definitionFromJson('{"title":"x"}').ok, false, 'JSON that is no eval');
  assert.equal(definitionFromJson('{"title":"x","target":{},"pin":"","cases":[{"prompt":1}]}').ok, false);
});

test('a new eval starts with one case that has one check, and the pin of the checkout', () => {
  const blank = blankDefinition(PIN);
  assert.equal(blank.pin, PIN);
  assert.equal(blank.cases.length, 1);
  assert.equal(blank.cases[0]?.expect.length, 1);
  assert.deepEqual(definitionFromForm(formFromDefinition(blank)), blank);
});

test('a title becomes a file name within the name pattern', () => {
  assert.equal(nameFromTitle('Developer runs the tests'), 'developer-runs-the-tests');
  assert.equal(nameFromTitle('  ¿Corre las pruebas? '), 'corre-las-pruebas');
  assert.equal(nameFromTitle('!!!'), '');
  assert.ok(nameFromTitle('x'.repeat(100)).length <= 64);
});

test('the problems of a refused write are found by the field they name, and by what holds it', () => {
  const problems = ['title: must be 1-120 characters', 'cases[0].expect[2].anchor.tool: must be a string', 'cases[1].prompt: must be a string', 'pin: must be a full 40-character commit SHA'];
  assert.deepEqual(problemsAt(problems, 'title'), ['must be 1-120 characters']);
  assert.deepEqual(problemsAt(problems, 'cases[0]'), ['must be a string']);
  assert.deepEqual(problemsAt(problems, 'cases[0].expect[2]'), ['must be a string']);
  assert.deepEqual(problemsAt(problems, 'cases[1].expect'), []);
  assert.deepEqual(problemsAt(problems, 'cases[10]'), [], 'cases[1] is not cases[10]');
  assert.equal(problemsAt(problems, 'pin').length, 1);
});

const run = (over: Partial<EvalRunSummary>): EvalRunSummary => ({
  id: 'r',
  projectId: 'p',
  pressures: ['neutral'],
  evalName: 'e',
  definitionSha: 'x',
  variants: ['current'],
  samplesPerCase: 2,
  account: null,
  state: 'ended',
  outcome: 'completed',
  reason: null,
  resetsAt: null,
  maxCostUsd: 1,
  costUsd: 0.5,
  counts: {},
  scored: {},
  createdAt: '2026-10-16T10:00:00Z',
  startedAt: null,
  endedAt: null,
  ...over,
});

test('the list says one word for the newest run', () => {
  assert.equal(runWord(run({ counts: { passed: 4 } })), 'passed');
  assert.equal(runWord(run({ counts: { passed: 3, failed: 1 } })), 'failed');
  assert.equal(runWord(run({ outcome: 'capped' })), 'capped');
  assert.equal(runWord(run({ outcome: 'interrupted' })), 'interrupted');
  assert.equal(runWord(run({ outcome: 'cancelled' })), 'cancelled');
  assert.equal(runWord(run({ outcome: 'failed' })), 'failed');
  assert.equal(runWord(run({ state: 'running', outcome: null })), 'running');
  assert.equal(runWord(run({ state: 'queued', outcome: null })), 'running');
  assert.equal(runWord(run({ state: 'waiting', outcome: null })), 'waiting');
});

test('"n/m cases" is the current variant when the run has it, else the proposed one, else the pinned one', () => {
  assert.deepEqual(casesScored(run({ scored: { pinned: { passed: 1, of: 3 }, current: { passed: 2, of: 3 } } })), { passed: 2, of: 3 });
  assert.deepEqual(casesScored(run({ scored: { pinned: { passed: 1, of: 3 }, proposed: { passed: 3, of: 3 } } })), { passed: 3, of: 3 });
  assert.deepEqual(casesScored(run({ scored: { pinned: { passed: 1, of: 3 } } })), { passed: 1, of: 3 });
  assert.equal(casesScored(run({})), null);
});

test('a file with problems, or without a definition, is listed as invalid; the others as evals with their target', () => {
  const file = (name: string, definition: EvalDefinition | null, problems: string[]): EvalFileListItem => ({ name, path: `.claude/claudio-evals/${name}.json`, sha: 's', definition, problems, latestRun: null });
  const rows = listRows([file('ok', DEFINITION, []), file('broken', null, ['version: unsupported']), file('half', DEFINITION, ['cases[0].prompt: must be a string'])]);
  assert.deepEqual(rows.map((r) => r.kind), ['eval', 'invalid', 'invalid']);
  assert.equal(rows[0]?.kind === 'eval' && rows[0].target, '.claude/agents/developer.md');
  assert.equal(rows[0]?.kind === 'eval' && rows[0].cases, 1);
});

test('the target path follows kind and scope, as the resolvers do', () => {
  assert.equal(targetPath({ kind: 'skill', scope: 'project', name: 'review' }), '.claude/skills/review/SKILL.md');
  assert.equal(targetPath({ kind: 'rule', scope: 'user', name: 'style' }), '~/.claude/rules/style.md');
  assert.equal(targetPath({ kind: 'instructions', scope: 'project', name: 'CLAUDE.local.md' }), 'CLAUDE.local.md');
});

test("the Team tab's address gains the evals section, which keeps its own depth only there", () => {
  assert.equal(teamSection('evals'), 'evals');
  assert.equal(teamSection('nope'), 'members');
  const params = new URLSearchParams('project=p');
  assert.equal(teamSearch(params, { section: 'evals' }), '?project=p&view=team&section=evals');
  const open = new URLSearchParams(teamSearch(params, { section: 'evals', eval: 'runs-tests' }));
  assert.equal(open.get('eval'), 'runs-tests');
  assert.equal(new URLSearchParams(teamSearch(open, { run: 'r1' })).get('run'), 'r1');
  assert.equal(new URLSearchParams(teamSearch(open, { eval: null })).get('eval'), null);
  const deep = new URLSearchParams(teamSearch(open, { run: 'r1' }));
  assert.equal(new URLSearchParams(teamSearch(deep, { eval: 'other' })).get('run'), null, 'a run belongs to its eval');
  const left = new URLSearchParams(teamSearch(deep, { section: 'flow' }));
  assert.equal(left.get('eval'), null);
  assert.equal(left.get('run'), null);
});
