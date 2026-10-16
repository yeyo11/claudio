import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * The second line behind the ESLint block (docs/plans/collaborators.md §3.5): Collaborators code may
 * not import, directly or through what it imports, anything that can start work. Also that
 * `@number0/iroh` is only ever loaded lazily by the host process, and that nothing calls a `watch*`
 * method of the binding, which aborts the process in 1.1.0 (§7.2).
 */

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const core = join(repo, 'packages', 'core', 'src');
const collab = join(core, 'collab');

/** Modules of `packages/core/src` that start work, by their path without `.ts` */
const FORBIDDEN_MODULES = [/^chat-service$/, /^orchestrator/, /^flow$/, /^workflow-engine/, /^processes$/, /^cli$/, /^terminals\//, /^assistant/, /^schedules$/, /^cron$/, /^index$/];
const FORBIDDEN_PACKAGES = [/^@claudio\/api(\/|$)/, /^@claudio\/core(\/|$)/];

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isSource = (file: string): boolean => /\.(ts|tsx|mts|js|mjs)$/.test(file) && !file.endsWith('.d.ts');

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
  dynamic: boolean;
}

/** Every import of a file: static, re-exports, `import()` and `require()`; comments are dropped first */
function importsOf(source: string): ImportRef[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out: ImportRef[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const clause = m[3] ?? '';
    // `import { type A, type B } from` is as type-only as `import type`
    const allTypes = /^\s*\{([^}]*)\}\s+from\s+$/.exec(clause)?.[1]?.split(',').every((p) => p.trim() === '' || p.trim().startsWith('type ')) ?? false;
    out.push({ specifier: m[4] ?? '', typeOnly: !!m[2] || allTypes, dynamic: false });
  }
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ specifier: m[1] ?? '', typeOnly: false, dynamic: true });
  return out;
}

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

const moduleName = (file: string): string => relative(core, file).replace(/\\/g, '/').replace(/\.ts$/, '');

test('nothing under collab/ reaches a module that starts work, directly or through what it imports', () => {
  const start = walk(collab, isSource);
  assert.ok(start.length >= 10, 'the collab sources are found');
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; via: string[] }> = start.map((file) => ({ file, via: [moduleName(file)] }));
  const offences: string[] = [];
  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next.file)) continue;
    seen.set(next.file, next.via);
    for (const ref of importsOf(readFileSync(next.file, 'utf8'))) {
      if (FORBIDDEN_PACKAGES.some((p) => p.test(ref.specifier))) offences.push(`${next.via.join(' → ')} → ${ref.specifier}`);
      const target = resolveRelative(next.file, ref.specifier);
      if (!target || !target.startsWith(core)) continue;
      const name = moduleName(target);
      // A type cannot start anything: a type-only import of a module is not a path to its code
      if (FORBIDDEN_MODULES.some((p) => p.test(name)) && (!ref.typeOnly || next.file.startsWith(collab))) {
        offences.push(`${[...next.via, name].join(' → ')}`);
        continue;
      }
      if (!ref.typeOnly) queue.push({ file: target, via: [...next.via, name] });
    }
  }
  assert.deepEqual(offences, []);
});

test('the scan sees the imports it is meant to refuse', () => {
  const sample = [
    "import { ChatService } from '../chat-service.ts';",
    "import type { Orchestrator } from '../orchestrator.ts';",
    "export { x } from '../terminals/host-client.ts';",
    "const flow = await import('../flow.ts');",
    "import '@claudio/core';",
  ].join('\n');
  assert.deepEqual(
    importsOf(sample).map((r) => r.specifier),
    ['../chat-service.ts', '../orchestrator.ts', '../terminals/host-client.ts', '@claudio/core', '../flow.ts'],
  );
  assert.equal(importsOf("import { type A, type B } from './a.ts';")[0]?.typeOnly, true);
  assert.equal(importsOf("import { type A, b } from './a.ts';")[0]?.typeOnly, false);
});

test('the ESLint block for collab/** refuses the same modules', async () => {
  const config = (await import(pathToFileURL(join(repo, 'eslint.config.mjs')).href)) as { default: Array<{ files?: string[]; rules?: Record<string, unknown> }> };
  const block = config.default.find((b) => b.files?.includes('packages/core/src/collab/**/*.ts'));
  assert.ok(block, 'eslint.config.mjs has a block for packages/core/src/collab/**');
  const rule = block.rules?.['no-restricted-imports'] as [string, { patterns: Array<{ regex: string }> }] | undefined;
  assert.ok(rule && rule[0] === 'error');
  const refused = (specifier: string): boolean => rule[1].patterns.some((p) => new RegExp(p.regex).test(specifier));
  for (const specifier of ['../chat-service.ts', '../orchestrator.ts', '../orchestrator-store.ts', '../flow.ts', '../workflow-engine.ts', '../processes.ts', '../cli.ts', '../terminals/service.ts', '../assistant.ts', '../assistant-draft.ts', '../schedules.ts', '../cron.ts', '@claudio/api', '@claudio/core', '../index.ts']) {
    assert.ok(refused(specifier), specifier);
  }
  for (const specifier of ['./roster.ts', '../projects.ts', '../db.ts', '../cli-facts.ts', '@claudio/shared', 'node:crypto']) assert.ok(!refused(specifier), specifier);
});

test('@number0/iroh is loaded only by the host process, lazily', () => {
  const files = [...walk(join(repo, 'packages'), isSource), ...walk(join(repo, 'apps'), isSource)].filter((f) => !f.includes(`${join('docs', 'reports')}`));
  const users: string[] = [];
  for (const file of files) {
    for (const ref of importsOf(readFileSync(file, 'utf8'))) {
      if (!ref.specifier.startsWith('@number0/iroh') || ref.typeOnly) continue;
      users.push(`${relative(repo, file)}${ref.dynamic ? ' (dynamic)' : ''}`);
    }
  }
  // Tests may load it themselves; no module of the server does, but the host's entry, with import()
  assert.deepEqual(users.filter((u) => !u.includes(`${join('core', 'test')}`)), [join('packages', 'core', 'src', 'collab', 'host', 'main.ts') + ' (dynamic)']);
});

test('nothing calls a watch* method of the binding', () => {
  const IROH_WATCH = /\.(watchAddr|watchHomeRelay|watchNetworkChange|watchPaths|watchPathEvents)\s*\(/;
  const ANY_WATCH = /\.watch[A-Z]\w*\s*\(/;
  const files = [...walk(join(repo, 'packages'), isSource), ...walk(join(repo, 'apps'), isSource), ...walk(join(repo, 'e2e'), isSource)];
  const offences: string[] = [];
  for (const file of files) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const strict = file.startsWith(collab);
    lines.forEach((line, i) => {
      if (IROH_WATCH.test(line) || (strict && ANY_WATCH.test(line))) offences.push(`${relative(repo, file)}:${String(i + 1)}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offences, []);
});
