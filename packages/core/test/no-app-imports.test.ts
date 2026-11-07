import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { roleTitleIn } from '../src/team.ts';

// Core is a library the apps depend on, never the other way round: a file of core that reaches into
// `apps/` ties the server to the web's source tree (it once read the web's Spanish locale for role
// names, docs/plans/ci-and-regression-open.md R2). Every specifier is resolved, so a relative path
// that climbs into `apps/` is caught as well as a bare `apps/...` one.

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(coreRoot, '..', '..');
const appsRoot = join(repoRoot, 'apps') + sep;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module specifier of a file: static and dynamic imports, re-exports and `require`. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [/\b(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) found.push(match[1]);
  return found;
}

test('no file of packages/core/src imports from apps/', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(join(coreRoot, 'src'))) {
    for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
      const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
      const intoApps = target ? target.startsWith(appsRoot) : /^(?:@claudio\/(?:web|api|desktop)\b|apps\/)/.test(specifier);
      if (intoApps) offenders.push(`${relative(repoRoot, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the scan sees an import that climbs into apps/', () => {
  // Guards the guard: the import core used to have must be one the scan reports
  const source = "import esTeam from '../../../apps/web/src/i18n/locales/es/team.json' with { type: 'json' };";
  const [specifier] = specifiers(source);
  assert.ok(specifier);
  assert.ok(resolve(join(coreRoot, 'src'), specifier).startsWith(appsRoot));
});

test('a flow run chat names a built-in role in Spanish, and a made-up one as written', () => {
  assert.equal(roleTitleIn('developer', 'es'), 'Desarrollador');
  assert.equal(roleTitleIn('writer', 'es'), 'Redactor técnico');
  assert.equal(roleTitleIn('developer', 'en'), 'Developer');
  assert.equal(roleTitleIn('data-wrangler', 'es'), 'Data Wrangler');
  assert.equal(roleTitleIn('constructor', 'es'), 'Constructor');
});
