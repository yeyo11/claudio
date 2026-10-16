import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@claudio/core';
import { EVAL_LIMITS, type EvalComparison, type EvalDefinition, type EvalEstimate, type EvalFileDetail, type EvalFileListItem, type EvalHead, type EvalRun, type EvalRunPage, type EvalRunSummary, type EvalSampleDetail, type Project } from '@claudio/shared';
import { EvalStore } from '../../../packages/core/src/evals/store.ts';
import { buildApp } from '../src/app.ts';

// The eval routes over a real core, a scratch git repository and the fake CLI
// (docs/plans/instruction-evals.md, "API"): every route and every error code of the table, the
// refusals a chat's token gets, and read-only mode.

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));
const json = (body: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const authed = (token: string, body: unknown) => json(body, { authorization: `Bearer ${token}` });
const fromChat = (token: string, body?: unknown) => ({
  remoteAddress: '127.0.0.1',
  ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  headers: { host: '127.0.0.1:34331', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

interface Wrapper {
  app: FastifyInstance;
  core: Core;
  root: string;
  project: Project;
  /** A project with the Team module off */
  plain: Project;
  head: string;
  store: EvalStore;
}

async function wrapper(): Promise<Wrapper> {
  const root = mkdtempSync(join(tmpdir(), 'claudio-api-evals-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const imported = async (name: string, modules: string[]): Promise<Project> => {
    const path = join(root, name);
    execFileSync('mkdir', ['-p', path]);
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'CLAUDE.md'), '# Rules\nRun the tests.\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'init');
    const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path, name, template: 'software', modules }) });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<Project>();
  };
  const project = await imported('crew', ['board', 'team']);
  const plain = await imported('plain', ['board']);
  return { app, core, root, project, plain, head: git(project.path, 'rev-parse', 'HEAD'), store: new EvalStore(core.db.connection) };
}

const finish = (w: Wrapper) => async () => {
  w.core.shutdown();
  await w.app.close();
  rmSync(w.root, { recursive: true, force: true });
};

const definition = (pin: string, over: Partial<EvalDefinition> = {}): EvalDefinition => ({
  version: 1,
  title: 'Runs the tests',
  target: { kind: 'instructions', scope: 'project', name: 'CLAUDE.md' },
  pin,
  samples: 1,
  limits: { maxCostUsdPerSample: 0.5, timeoutMinutes: 1 },
  cases: [{ id: 'c1', prompt: 'change a file', expect: [{ kind: 'called', call: { tool: 'Bash', command: 'pnpm test' } }] }],
  ...over,
});

const evalUrl = (w: Wrapper, name: string, tail = '') => `/api/projects/${w.project.id}/evals/${name}${tail}`;

async function put(w: Wrapper, name: string, def: unknown, ifMatch: string | null = null) {
  return w.app.inject({ method: 'PUT', url: evalUrl(w, name), ...json({ definition: def, ifMatch }) });
}

/** A run that was interrupted, as the store leaves it, for the routes that read or reopen one. */
function seedRun(w: Wrapper, id: string, evalName: string, sha: string, def: EvalDefinition, outcome: 'completed' | 'interrupted' | null, createdAt: string): void {
  w.store.insertRun(
    { id, projectId: w.project.id, evalName, definitionSha: sha, definition: def, variants: ['current'], samplesPerCase: 1, account: null, maxCostUsd: 1, startedBy: 'person', createdAt },
    [{ variant: 'current', targetPath: join(w.project.path, 'CLAUDE.md'), present: true, contentSha: 'x', content: '# Rules\nRun the tests.\n' }],
    [{ id: `${id}-s1`, caseId: 'c1', variant: 'current', attempt: 1, seq: 0, pin: def.pin }],
  );
  if (outcome === 'completed') {
    w.store.claimSample(`${id}-s1`, 1, 2, createdAt);
    w.store.addCalls(`${id}-s1`, [{ seq: 1, message: 0, toolUseId: 't1', name: 'Bash', scope: 'main', outcome: 'ok', input: '{"command":"pnpm test"}', result: 'ok', at: null }]);
    w.store.addChecks(`${id}-s1`, [{ idx: 0, kind: 'called', passed: true, detail: 'Bash ran', evidenceSeq: 1, output: null }]);
    w.store.endSample(`${id}-s1`, { outcome: 'passed', costUsd: 0.1, durationMs: 1000, turns: 2, resultText: 'done', endedAt: createdAt });
    w.store.endRun(id, { outcome: 'completed', endedAt: createdAt });
  } else if (outcome === 'interrupted') {
    w.store.endRun(id, { outcome: 'interrupted', reason: 'the server restarted', endedAt: createdAt });
  }
}

const REQUEST = { variants: ['current'], confirmMaxCostUsd: 0 };

test('the list needs the Team module, and reads files with their problems and newest run', async (t) => {
  const w = await wrapper();
  t.after(finish(w));

  const off = await w.app.inject(`/api/projects/${w.plain.id}/evals`);
  assert.equal(off.statusCode, 409);
  assert.equal(off.json().code, 'team-off');
  const missing = await w.app.inject('/api/projects/nope/evals');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'not-found');

  assert.deepEqual((await w.app.inject(`/api/projects/${w.project.id}/evals`)).json(), []);
  assert.equal((await put(w, 'runs-tests', definition(w.head))).statusCode, 200);
  writeFileSync(join(w.project.path, '.claude', 'claudio-evals', 'broken.json'), '{ "version": 1, "cases": 3 }');
  seedRun(w, 'r-done', 'runs-tests', 'a'.repeat(64), definition(w.head), 'completed', new Date().toISOString());

  const listed = (await w.app.inject(`/api/projects/${w.project.id}/evals`)).json<EvalFileListItem[]>();
  assert.deepEqual(listed.map((f) => f.name), ['broken', 'runs-tests']);
  assert.equal(listed[0]?.definition, null);
  assert.ok((listed[0]?.problems.length ?? 0) > 0);
  assert.equal(listed[1]?.latestRun?.id, 'r-done');
});

test('the head route says what Pin to HEAD pins and which eval files the repository does not have', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const url = `/api/projects/${w.project.id}/eval-head`;
  assert.equal((await w.app.inject('/api/projects/nope/eval-head')).statusCode, 404);
  assert.deepEqual((await w.app.inject(url)).json(), { git: true, sha: w.head, subject: 'init', uncommitted: [] });

  await put(w, 'runs-tests', definition(w.head));
  assert.deepEqual((await w.app.inject(url)).json<EvalHead>().uncommitted, ['runs-tests']);
  git(w.project.path, 'add', '.');
  git(w.project.path, 'commit', '-q', '-m', 'add the eval');
  assert.deepEqual((await w.app.inject(url)).json<EvalHead>().uncommitted, []);
  await put(w, 'runs-tests', definition(w.head, { title: 'Changed' }), (await w.app.inject(evalUrl(w, 'runs-tests'))).json<EvalFileDetail>().sha);
  assert.deepEqual((await w.app.inject(url)).json<EvalHead>().uncommitted, ['runs-tests']);

  git(w.project.path, 'update-ref', '-d', 'HEAD');
  assert.deepEqual((await w.app.inject(url)).json(), { git: true, sha: null, subject: null, uncommitted: [] });
  assert.deepEqual((await w.app.inject(`/api/projects/${w.plain.id}/eval-head`)).json<EvalHead>().git, true);
});

test('a file is written strictly, guarded by the SHA that was read, read back and removed', async (t) => {
  const w = await wrapper();
  t.after(finish(w));

  assert.equal((await w.app.inject(evalUrl(w, 'Bad_Name'))).statusCode, 400);
  assert.equal((await w.app.inject(evalUrl(w, 'nothing'))).statusCode, 404);
  assert.equal((await w.app.inject({ method: 'DELETE', url: evalUrl(w, 'nothing') })).statusCode, 404);

  const bad = await put(w, 'strict', { version: 1, cases: 'no' });
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.json().problems.length > 0, 'the field paths are listed');
  assert.equal((await put(w, 'Bad_Name', definition(w.head))).statusCode, 400);
  assert.equal((await w.app.inject({ method: 'PUT', url: evalUrl(w, 'strict'), ...json({ ifMatch: null }) })).statusCode, 400);
  assert.equal((await w.app.inject({ method: 'PUT', url: evalUrl(w, 'strict'), ...json({ definition: definition(w.head), ifMatch: 7 }) })).statusCode, 400);
  // Every field is within its own bound; only the file as a whole is over 256 KiB
  const expect = Array.from({ length: 30 }, () => ({ kind: 'text' as const, match: { contains: 'y'.repeat(400) } }));
  const huge = definition(w.head, { cases: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, prompt: 'x'.repeat(8000), expect })) });
  assert.equal((await put(w, 'strict', huge)).statusCode, 413);

  const created = await put(w, 'strict', definition(w.head));
  assert.equal(created.statusCode, 200, created.body);
  const first = created.json<EvalFileDetail>();
  assert.equal(first.consented, false);
  // A second writer who expected no file does not overwrite this one
  const raced = await put(w, 'strict', definition(w.head, { title: 'Other' }));
  assert.equal(raced.statusCode, 409);
  assert.equal(raced.json().code, 'changed-on-disk');
  const updated = await put(w, 'strict', definition(w.head, { title: 'Other' }), first.sha);
  assert.equal(updated.statusCode, 200);
  assert.notEqual(updated.json<EvalFileDetail>().sha, first.sha);

  const read = (await w.app.inject(evalUrl(w, 'strict'))).json<EvalFileDetail>();
  assert.equal(read.definition?.title, 'Other');
  assert.equal(read.sha, updated.json<EvalFileDetail>().sha);

  assert.equal((await w.app.inject({ method: 'DELETE', url: evalUrl(w, 'strict') })).statusCode, 200);
  assert.equal((await w.app.inject(evalUrl(w, 'strict'))).statusCode, 404);
});

test('a file cannot be removed while its eval runs', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const file = (await put(w, 'busy', definition(w.head))).json<EvalFileDetail>();
  seedRun(w, 'r-live', 'busy', file.sha, definition(w.head), null, new Date().toISOString());
  const refused = await w.app.inject({ method: 'DELETE', url: evalUrl(w, 'busy') });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'eval-running');
  assert.equal((await w.app.inject(evalUrl(w, 'busy'))).statusCode, 200);
});

test('an estimate says what a start would cost, refuses what a start would, and starts nothing', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const url = evalUrl(w, 'est', '/estimate');
  assert.equal((await w.app.inject({ method: 'POST', url, ...json(REQUEST) })).statusCode, 404);
  await put(w, 'est', definition(w.head, { setup: 'pnpm install' }));

  const bodyless = await w.app.inject({ method: 'POST', url, ...json({ variants: ['nope'], confirmMaxCostUsd: 0 }) });
  assert.equal(bodyless.statusCode, 400);

  const ok = await w.app.inject({ method: 'POST', url, ...json(REQUEST) });
  assert.equal(ok.statusCode, 200, ok.body);
  const estimate = ok.json<EvalEstimate>();
  assert.equal(estimate.samples, 1);
  assert.equal(estimate.ceilingUsd, Math.round(0.5 * EVAL_LIMITS.costMargin * 100) / 100);
  assert.deepEqual(estimate.commands, ['pnpm install']);
  assert.equal(estimate.consentNeeded, true);
  assert.deepEqual(estimate.prompts, ['change a file']);
  assert.equal(estimate.typicalUsd, null);
  assert.equal(w.store.liveRun(w.project.id), null);

  const missingPin = await put(w, 'lost', definition('f'.repeat(40)));
  assert.equal(missingPin.statusCode, 200);
  const pin = await w.app.inject({ method: 'POST', url: evalUrl(w, 'lost', '/estimate'), ...json(REQUEST) });
  assert.equal(pin.statusCode, 422);
  assert.equal(pin.json().code, 'pin-missing');

  await put(w, 'user', definition(w.head, { target: { kind: 'instructions', scope: 'user', name: 'CLAUDE.md' } }));
  const proposal = await w.app.inject({ method: 'POST', url: evalUrl(w, 'user', '/estimate'), ...json({ variants: ['proposed'], proposed: 'x', confirmMaxCostUsd: 0 }) });
  assert.equal(proposal.statusCode, 422);
  assert.equal(proposal.json().code, 'user-scope-proposal');

  await put(w, 'agent', definition(w.head, { target: { kind: 'agent', scope: 'project', name: 'ghost' } }));
  const target = await w.app.inject({ method: 'POST', url: evalUrl(w, 'agent', '/estimate'), ...json(REQUEST) });
  assert.equal(target.statusCode, 422);
  assert.equal(target.json().code, 'target-missing');

  const noGit = await w.app.inject({ method: 'POST', url: `/api/projects/${w.plain.id}/evals/est/estimate`, ...json(REQUEST) });
  assert.equal(noGit.statusCode, 404);
  rmSync(join(w.project.path, '.git'), { recursive: true, force: true });
  const notGit = await w.app.inject({ method: 'POST', url, ...json(REQUEST) });
  assert.equal(notGit.statusCode, 422);
  assert.equal(notGit.json().code, 'not-git');
});

test('an estimate with a lanes folder that instructions reach, or in a repository with no commit, is refused', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const url = evalUrl(w, 'est', '/estimate');
  await put(w, 'est', definition(w.head));
  // A CLAUDE.md above the lanes folder would reach every sample
  writeFileSync(join(w.root, 'CLAUDE.md'), '# not for samples\n');
  const dirty = await w.app.inject({ method: 'POST', url, ...json(REQUEST) });
  assert.equal(dirty.statusCode, 422);
  assert.equal(dirty.json().code, 'lanes-root-contaminated');
  rmSync(join(w.root, 'CLAUDE.md'));
  git(w.project.path, 'update-ref', '-d', 'HEAD');
  const none = await w.app.inject({ method: 'POST', url, ...json(REQUEST) });
  assert.equal(none.statusCode, 422);
  assert.equal(none.json().code, 'no-commit');
});

test('a start whose request cannot run is refused with the reason', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  await put(w, 'cap', definition(w.head, { limits: { maxCostUsdPerSample: 0.5, timeoutMinutes: 1, maxCostUsd: 0.6 } }));
  const url = evalUrl(w, 'cap', '/runs');
  const start = (body: unknown) => w.app.inject({ method: 'POST', url, ...json(body) });
  assert.equal((await start({ variants: [], confirmMaxCostUsd: 0 })).json().code, 'no-variants');
  assert.equal((await start({ ...REQUEST, maxCostUsd: 5 })).json().code, 'ceiling-raised');
  const big = await start({ variants: ['proposed'], proposed: 'x'.repeat(EVAL_LIMITS.fileBytes + 1), confirmMaxCostUsd: 0 });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().code, 'proposed-too-large');
});

test('consent is recorded for the content on disk and for nothing else', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const url = evalUrl(w, 'cmd', '/consent');
  assert.equal((await w.app.inject({ method: 'POST', url, ...json({ sha: 'x' }) })).statusCode, 404);
  const file = (await put(w, 'cmd', definition(w.head, { setup: 'pnpm install' }))).json<EvalFileDetail>();
  assert.equal((await w.app.inject({ method: 'POST', url, ...json({}) })).statusCode, 400);
  const stale = await w.app.inject({ method: 'POST', url, ...json({ sha: 'b'.repeat(64) }) });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'changed-on-disk');
  const granted = await w.app.inject({ method: 'POST', url, ...json({ sha: file.sha }) });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal(granted.json<EvalFileDetail>().consented, true);
  assert.equal((await w.app.inject(evalUrl(w, 'cmd'))).json<EvalFileDetail>().consented, true);
  // An edit asks again
  const edited = (await put(w, 'cmd', definition(w.head, { setup: 'rm -rf x' }), file.sha)).json<EvalFileDetail>();
  assert.equal(edited.consented, false);
});

test('a run starts only with consent and the ceiling repeated, is cancelled, listed, compared and exported', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const url = evalUrl(w, 'go', '/runs');
  assert.equal((await w.app.inject({ method: 'POST', url, ...json(REQUEST) })).statusCode, 404);
  const file = (await put(w, 'go', definition(w.head, { setup: 'true' }))).json<EvalFileDetail>();

  assert.equal((await w.app.inject({ method: 'POST', url, ...json({ variants: ['current'] }) })).statusCode, 400);
  const needed = await w.app.inject({ method: 'POST', url, ...json(REQUEST) });
  assert.equal(needed.statusCode, 412);
  assert.equal(needed.json().code, 'consent-needed');
  await w.app.inject({ method: 'POST', url: evalUrl(w, 'go', '/consent'), ...json({ sha: file.sha }) });

  const unconfirmed = await w.app.inject({ method: 'POST', url, ...json(REQUEST) });
  assert.equal(unconfirmed.statusCode, 409);
  assert.equal(unconfirmed.json().code, 'cost-not-confirmed');
  const ceiling = (await w.app.inject({ method: 'POST', url: evalUrl(w, 'go', '/estimate'), ...json(REQUEST) })).json<EvalEstimate>().ceilingUsd;

  const started = await w.app.inject({ method: 'POST', url, ...json({ ...REQUEST, confirmMaxCostUsd: ceiling }) });
  assert.equal(started.statusCode, 201, started.body);
  const run = started.json<EvalRunSummary>();
  assert.equal(run.evalName, 'go');
  assert.equal(run.maxCostUsd, ceiling);

  const second = await w.app.inject({ method: 'POST', url, ...json({ ...REQUEST, confirmMaxCostUsd: ceiling }) });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'eval-running');
  const cancelling = await w.app.inject({ method: 'DELETE', url: `/api/eval-runs/${run.id}` });
  assert.equal(cancelling.statusCode, 409, 'a live run is not deleted');

  const cancelled = await w.app.inject({ method: 'POST', url: `/api/eval-runs/${run.id}/cancel` });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json<EvalRunSummary>().outcome, 'cancelled');
  // Idempotent
  assert.equal((await w.app.inject({ method: 'POST', url: `/api/eval-runs/${run.id}/cancel` })).json<EvalRunSummary>().outcome, 'cancelled');
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/eval-runs/nope/cancel' })).statusCode, 404);

  assert.equal((await w.app.inject({ method: 'DELETE', url: `/api/eval-runs/${run.id}` })).statusCode, 200);
  assert.equal((await w.app.inject(`/api/eval-runs/${run.id}`)).statusCode, 404);
  assert.equal((await w.app.inject({ method: 'DELETE', url: `/api/eval-runs/${run.id}` })).statusCode, 404);

  const unknownCase = await w.app.inject({ method: 'POST', url, ...json({ ...REQUEST, cases: ['nope'], confirmMaxCostUsd: ceiling }) });
  assert.equal(unknownCase.statusCode, 400);
  const noProposal = await w.app.inject({ method: 'POST', url, ...json({ variants: ['proposed'], confirmMaxCostUsd: ceiling }) });
  assert.equal(noProposal.statusCode, 400);
});

test('runs are read as a page, one run, one sample, a comparison and an export', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const def = definition(w.head);
  await put(w, 'hist', def);
  assert.equal((await w.app.inject('/api/projects/nope/eval-runs')).statusCode, 404);
  seedRun(w, 'r1', 'hist', 'a'.repeat(64), def, 'completed', '2026-10-16T10:00:00.000Z');
  seedRun(w, 'r2', 'hist', 'a'.repeat(64), def, 'completed', '2026-10-16T11:00:00.000Z');
  seedRun(w, 'r3', 'other', 'a'.repeat(64), def, 'completed', '2026-10-16T12:00:00.000Z');

  const base = `/api/projects/${w.project.id}/eval-runs`;
  const all = (await w.app.inject(base)).json<EvalRunPage>();
  assert.deepEqual(all.runs.map((r) => r.id), ['r3', 'r2', 'r1']);
  const mine = (await w.app.inject(`${base}?eval=hist&limit=1`)).json<EvalRunPage>();
  assert.deepEqual(mine.runs.map((r) => r.id), ['r2']);
  assert.ok(mine.next);
  assert.deepEqual((await w.app.inject(`${base}?eval=hist&limit=1&before=${encodeURIComponent(mine.next ?? '')}`)).json<EvalRunPage>().runs.map((r) => r.id), ['r1']);
  assert.equal((await w.app.inject(`${base}?limit=0`)).statusCode, 400);
  assert.equal((await w.app.inject(`${base}?limit=500`)).statusCode, 200);

  const run = (await w.app.inject('/api/eval-runs/r1')).json<EvalRun>();
  assert.equal(run.samples.length, 1);
  assert.equal(run.samples[0]?.checks.length, 1);
  assert.equal((await w.app.inject('/api/eval-runs/nope')).statusCode, 404);

  const sample = (await w.app.inject('/api/eval-runs/r1/samples/r1-s1')).json<EvalSampleDetail>();
  assert.equal(sample.calls[0]?.name, 'Bash');
  assert.equal(sample.resultText, 'done');
  assert.equal((await w.app.inject('/api/eval-runs/r2/samples/r1-s1')).statusCode, 404, 'a sample of another run');

  const same = await w.app.inject('/api/eval-runs/r1/compare?base=current&other=current');
  assert.equal(same.statusCode, 200);
  assert.equal(same.json<EvalComparison>().cases[0]?.verdict, 'same');
  const absent = await w.app.inject('/api/eval-runs/r1/compare?base=current&other=proposed');
  assert.equal(absent.statusCode, 400);
  assert.equal((await w.app.inject('/api/eval-runs/r1/compare?base=bogus')).statusCode, 400);
  assert.equal((await w.app.inject('/api/eval-runs/nope/compare')).statusCode, 404);

  const exported = await w.app.inject('/api/eval-runs/r1/export');
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers['content-disposition']), /^attachment; filename="/);
  assert.match(String(exported.headers['content-type']), /json/);
  assert.equal(exported.json().version, 1);
  const markdown = await w.app.inject('/api/eval-runs/r1/export?format=markdown');
  assert.match(String(markdown.headers['content-type']), /markdown/);
  assert.match(String(markdown.headers['content-disposition']), /attachment/);
  assert.equal((await w.app.inject('/api/eval-runs/r1/export?format=csv')).statusCode, 400);
  assert.equal((await w.app.inject('/api/eval-runs/nope/export')).statusCode, 404);
});

test('an interrupted run is resumed under a ceiling that is repeated, and nothing else is', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const def = definition(w.head);
  const file = (await put(w, 'again', def)).json<EvalFileDetail>();
  const resume = (id: string, body: unknown) => w.app.inject({ method: 'POST', url: `/api/eval-runs/${id}/resume`, ...json(body) });

  assert.equal((await resume('nope', { confirmMaxCostUsd: 1 })).statusCode, 404);
  assert.equal((await resume('nope', {})).statusCode, 400);
  seedRun(w, 'done', 'again', file.sha, def, 'completed', '2026-10-16T09:00:00.000Z');
  const finished = await resume('done', { confirmMaxCostUsd: 1 });
  assert.equal(finished.statusCode, 409);
  assert.equal(finished.json().code, 'not-resumable');

  // Not written by Claudio: its content needs the person's consent again
  seedRun(w, 'foreign', 'again', 'c'.repeat(64), def, 'interrupted', '2026-10-16T10:00:00.000Z');
  const consent = await resume('foreign', { confirmMaxCostUsd: 1 });
  assert.equal(consent.statusCode, 412);
  assert.equal(consent.json().code, 'consent-needed');
  assert.equal((await w.app.inject({ method: 'DELETE', url: `/api/eval-runs/foreign` })).statusCode, 200);

  seedRun(w, 'cut', 'again', file.sha, def, 'interrupted', '2026-10-16T11:00:00.000Z');
  const wrong = await resume('cut', { confirmMaxCostUsd: 1 });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().code, 'cost-not-confirmed');
  const ceiling = Number(wrong.json().detail);
  assert.equal(ceiling, Math.round(0.5 * EVAL_LIMITS.costMargin * 100) / 100);

  const resumed = await resume('cut', { confirmMaxCostUsd: ceiling });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json<EvalRunSummary>().maxCostUsd, ceiling);
  assert.notEqual(resumed.json<EvalRunSummary>().state, 'ended');
  const twice = await resume('cut', { confirmMaxCostUsd: ceiling });
  assert.equal(twice.statusCode, 409);
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/eval-runs/cut/cancel' })).json<EvalRunSummary>().outcome, 'cancelled');

  // Another run live in the project
  seedRun(w, 'cut2', 'again', file.sha, def, 'interrupted', '2026-10-16T12:00:00.000Z');
  seedRun(w, 'live', 'again', file.sha, def, null, '2026-10-16T13:00:00.000Z');
  const busy = await resume('cut2', { confirmMaxCostUsd: ceiling });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'eval-running');
});

test("a chat's token reads, estimates and cancels, but cannot write, consent, start, resume or delete", async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const created = await w.app.inject({ method: 'POST', url: '/api/security/token', ...json({}) });
  const owner = (created.json() as { token: string }).token;
  await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...authed(owner, { mode: 'token' }) });
  const chat = w.core.security.chatTokens.mint('chat-42');
  const def = definition(w.head);
  const file = (await w.app.inject({ method: 'PUT', url: evalUrl(w, 'guarded'), ...authed(owner, { definition: def, ifMatch: null }) })).json<EvalFileDetail>();
  seedRun(w, 'r1', 'guarded', file.sha, def, 'completed', '2026-10-16T10:00:00.000Z');

  const refused: Array<[string, string, unknown?]> = [
    ['PUT', evalUrl(w, 'guarded'), { definition: def, ifMatch: file.sha }],
    ['DELETE', evalUrl(w, 'guarded')],
    ['POST', evalUrl(w, 'guarded', '/consent'), { sha: file.sha }],
    ['POST', evalUrl(w, 'guarded', '/runs'), REQUEST],
    ['POST', '/api/eval-runs/r1/resume', { confirmMaxCostUsd: 1 }],
    ['DELETE', '/api/eval-runs/r1'],
  ];
  for (const [method, url, body] of refused) {
    const res = await w.app.inject({ method: method as 'PUT', url, ...fromChat(chat, body) });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.match(res.json().error, /chat's token/);
  }
  // Nothing was done by those
  assert.equal((await w.app.inject({ url: evalUrl(w, 'guarded'), ...bearer(owner) })).json<EvalFileDetail>().consented, false);
  assert.equal((await w.app.inject({ url: '/api/eval-runs/r1', ...bearer(owner) })).statusCode, 200);

  assert.equal((await w.app.inject({ url: `/api/projects/${w.project.id}/evals`, ...fromChat(chat) })).statusCode, 200);
  assert.equal((await w.app.inject({ url: evalUrl(w, 'guarded'), ...fromChat(chat) })).statusCode, 200);
  assert.equal((await w.app.inject({ url: `/api/projects/${w.project.id}/eval-runs`, ...fromChat(chat) })).statusCode, 200);
  assert.equal((await w.app.inject({ url: '/api/eval-runs/r1', ...fromChat(chat) })).statusCode, 200);
  assert.equal((await w.app.inject({ url: '/api/eval-runs/r1/samples/r1-s1', ...fromChat(chat) })).statusCode, 200);
  assert.equal((await w.app.inject({ url: '/api/eval-runs/r1/compare?base=current&other=current', ...fromChat(chat) })).statusCode, 200);
  assert.equal((await w.app.inject({ method: 'POST', url: evalUrl(w, 'guarded', '/estimate'), ...fromChat(chat, REQUEST) })).statusCode, 200);
  assert.equal((await w.app.inject({ method: 'POST', url: '/api/eval-runs/nope/cancel', ...fromChat(chat) })).statusCode, 404);

  // The export joins the routes a download link reaches: the token in the query, and nothing else
  assert.equal((await w.app.inject('/api/eval-runs/r1/export')).statusCode, 401);
  assert.equal((await w.app.inject(`/api/eval-runs/r1/export?token=${encodeURIComponent(owner)}`)).statusCode, 200);
  assert.equal((await w.app.inject(`/api/eval-runs/r1?token=${encodeURIComponent(owner)}`)).statusCode, 401);
});

test('read-only mode refuses every eval write and leaves the reads', async (t) => {
  const w = await wrapper();
  t.after(finish(w));
  const def = definition(w.head);
  const file = (await put(w, 'quiet', def)).json<EvalFileDetail>();
  seedRun(w, 'r1', 'quiet', file.sha, def, 'completed', '2026-10-16T10:00:00.000Z');
  assert.equal((await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: true }) })).statusCode, 200);

  const writes: Array<[string, string, unknown?]> = [
    ['PUT', evalUrl(w, 'quiet'), { definition: def, ifMatch: file.sha }],
    ['DELETE', evalUrl(w, 'quiet')],
    ['POST', evalUrl(w, 'quiet', '/estimate'), REQUEST],
    ['POST', evalUrl(w, 'quiet', '/consent'), { sha: file.sha }],
    ['POST', evalUrl(w, 'quiet', '/runs'), REQUEST],
    ['POST', '/api/eval-runs/r1/cancel'],
    ['POST', '/api/eval-runs/r1/resume', { confirmMaxCostUsd: 1 }],
    ['DELETE', '/api/eval-runs/r1'],
  ];
  for (const [method, url, body] of writes) {
    const res = await w.app.inject({ method: method as 'PUT', url, ...(body === undefined ? {} : json(body)) });
    assert.equal(res.statusCode, 405, `${method} ${url}`);
  }
  for (const url of [`/api/projects/${w.project.id}/evals`, evalUrl(w, 'quiet'), `/api/projects/${w.project.id}/eval-runs`, '/api/eval-runs/r1', '/api/eval-runs/r1/samples/r1-s1', '/api/eval-runs/r1/compare?base=current&other=current', '/api/eval-runs/r1/export']) {
    assert.equal((await w.app.inject(url)).statusCode, 200, url);
  }
  await w.app.inject({ method: 'PUT', url: '/api/security/auth', ...json({ readOnly: false }) });
});
