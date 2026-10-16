import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EvalCall, EvalDefinition, EvalVariantInfo } from '@claudio/shared';
import type { ClaudioEventInput } from '../src/events.ts';
import type { CoreConfig } from '../src/index.ts';
import { migrate } from '../src/db.ts';
import { EvalConsents, EvalDefinitionStore } from '../src/evals/definition.ts';
import { exportRun, exportRunJson, exportRunMarkdown, type EvalExport } from '../src/evals/export.ts';
import { EvalRunner, type EvalRuntime } from '../src/evals/runner.ts';
import { EvalService } from '../src/evals/service.ts';
import { EvalStore } from '../src/evals/store.ts';

const PIN = 'a'.repeat(40);
const at = (n: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, n)).toISOString();
const definition = {
  version: 1,
  cases: [
    { id: 'tests-first', prompt: 'p', expect: [] },
    { id: 'no-cases-run', prompt: 'p', expect: [] },
  ],
} as unknown as EvalDefinition;
const variants: EvalVariantInfo[] = [
  { variant: 'current', targetPath: 'CLAUDE.md', present: true, contentSha: 'x', content: 'a' },
  { variant: 'proposed', targetPath: 'CLAUDE.md', present: false, contentSha: null, content: null },
];

function seed(): { db: DatabaseSync; store: EvalStore } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const store = new EvalStore(db);
  store.insertRun(
    {
      id: 'r1', projectId: 'p1', evalName: 'tests-first', definitionSha: 'd'.repeat(64), definition, variants: ['current', 'proposed'],
      samplesPerCase: 1, account: null, maxCostUsd: 5, startedBy: 'person', createdAt: at(1),
    },
    variants,
    [
      { id: 's1', caseId: 'tests-first', variant: 'current', attempt: 1, seq: 0, pin: PIN },
      { id: 's2', caseId: 'tests-first', variant: 'proposed', attempt: 1, seq: 1, pin: PIN },
    ],
  );
  store.claimSample('s1', 1, 2, at(2));
  store.claimSample('s2', 1, 2, at(2));
  const calls: EvalCall[] = [
    { seq: 1, message: 0, toolUseId: 't1', name: 'Edit', scope: 'main', outcome: 'ok', input: '{"file_path":"a.ts"}', result: 'ok', at: at(3) },
    { seq: 2, message: 1, toolUseId: 't2', name: 'Bash', scope: 'main', outcome: 'error', input: '{"command":"pnpm test"}', result: null, at: null },
  ];
  store.addCalls('s2', calls);
  store.addChecks('s1', [{ idx: 0, kind: 'called', passed: true, detail: 'Edit (#1) ran', evidenceSeq: 1, output: null }]);
  store.addChecks('s2', [
    { idx: 0, kind: 'after', passed: false, detail: 'Bash `pnpm test` (#2) | is missing\nafter Edit', evidenceSeq: 2, output: 'tail ``` of output' },
  ]);
  store.endSample('s1', { outcome: 'passed', costUsd: 0.25, durationMs: 4000, turns: 3, resultText: 'done', endedAt: at(4) });
  store.endSample('s2', { outcome: 'failed', costUsd: 0.5, durationMs: 6000, turns: 5, reason: 'checks failed', endedAt: at(5) });
  store.endRun('r1', { outcome: 'completed', endedAt: at(6) });
  return { db, store };
}

test('the JSON export carries the run rows and reads back unchanged', () => {
  const { store } = seed();
  const doc = exportRunJson(store, 'r1');
  assert.ok(doc);
  const parsed = JSON.parse(exportRun(store, 'r1', 'json')?.body ?? '') as EvalExport;
  assert.deepEqual(parsed, doc);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.run.definition, definition);
  assert.deepEqual(parsed.run.variantInfo, store.variants('r1'));
  assert.deepEqual(parsed.run.samples, store.samples('r1'));
  assert.deepEqual(parsed.calls['s2'], store.calls('s2'));
  assert.deepEqual(parsed.calls['s1'], []);
  assert.equal(parsed.run.samples.find((s) => s.id === 's2')?.checks[0]?.passed, false);
});

test('the Markdown export lists cases, variants, outcomes and the failing checks', () => {
  const { store } = seed();
  const md = exportRunMarkdown(store, 'r1') ?? '';
  for (const wanted of ['# Eval tests-first', '## Variants', '**current**', '**proposed**', 'no file', '### tests-first', '### no-cases-run', 'No samples.']) {
    assert.ok(md.includes(wanted), wanted);
  }
  assert.match(md, /\| current \| 1 \| 1 \| passed \|/);
  assert.match(md, /\| proposed \| 1 \| 1 \| failed \|/);
  assert.ok(md.includes('Failing checks:'));
  assert.ok(md.includes('Bash `pnpm test` (#2) \\| is missing after Edit'), 'a pipe and a line break do not break the line');
  assert.ok(!md.includes('Edit (#1) ran'), 'a passing check is not listed');
  // The output's own backticks cannot close the fence around it
  assert.ok(md.includes('````\ntail ``` of output\n````'));
});

test('a run that does not exist exports nothing', () => {
  const { store } = seed();
  assert.equal(exportRun(store, 'nope', 'json'), null);
  assert.equal(exportRun(store, 'nope', 'markdown'), null);
  assert.equal(exportRun(store, 'r1', 'markdown')?.filename, 'eval-run-r1.md');
});

test('a startup recovers a run its earlier life left live', async () => {
  const { store } = seed();
  const dir = mkdtempSync(join(tmpdir(), 'eval-service-'));
  try {
    store.insertRun(
      {
        id: 'r2', projectId: 'p1', evalName: 'tests-first', definitionSha: 'd'.repeat(64), definition, variants: ['current'],
        samplesPerCase: 1, account: null, maxCostUsd: 5, startedBy: 'person', createdAt: at(10),
      },
      [variants[0] as EvalVariantInfo],
      [{ id: 's3', caseId: 'tests-first', variant: 'current', attempt: 1, seq: 0, pin: PIN }],
      { pid: 4_000_001, startedAt: 'older' },
    );
    store.setRunState('r2', 'running');
    store.claimSample('s3', 4_000_001, 2, at(11));
    const events: ClaudioEventInput[] = [];
    const runner = new EvalRunner({
      store,
      runtime: {} as EvalRuntime,
      config: { dataDir: dir } as CoreConfig,
      consents: new EvalConsents({ dataDir: dir }),
      emit: (event) => events.push(event),
      projectPath: () => null,
      maxConcurrentRuns: () => 2,
      isAlive: () => false,
      env: {},
    });
    const service = new EvalService({ store, runner, definitions: new EvalDefinitionStore(), consents: new EvalConsents({ dataDir: dir }), projectPath: () => null });
    assert.equal(service.live('p1')?.id, 'r2');
    await service.load();
    const run = service.summary('r2');
    assert.equal(run?.state, 'ended');
    assert.equal(run?.outcome, 'interrupted');
    assert.deepEqual(run?.counts, { interrupted: 1 });
    assert.equal(service.live('p1'), null);
    assert.ok(events.some((e) => e.type === 'eval.run'));
    await service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
