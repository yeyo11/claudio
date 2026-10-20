import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { auditRouteStrings, EN_FILE, ES_FILE, SAME_IN_BOTH, untranslated } from '../scripts/generate-audit-strings.ts';

// The audit log words each row from the web's `auditRoutes` namespace (docs/plans/
// settings-reset-and-polish.md, D5). A route added without its Spanish would show English to a
// Spanish reader with nothing failing, so these hold the two files to ROUTE_DOCS.
const read = (file: string): Record<string, string> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
const en = read(EN_FILE);
const es = read(ES_FILE);
const routes = auditRouteStrings();

test('every write route has a non-empty English and Spanish line', () => {
  const missing = Object.keys(routes).filter((key) => !en[key]?.trim() || !es[key]?.trim());
  assert.deepEqual(missing, [], 'run `pnpm --filter @claudio/api audit:strings` and translate what it lists');
});

test('English is the route summary, byte for byte', () => {
  const drifted = Object.entries(routes).filter(([key, summary]) => en[key] !== summary).map(([key]) => key);
  assert.deepEqual(drifted, [], 'run `pnpm --filter @claudio/api audit:strings`');
});

test('no Spanish line is the English one left untranslated', () => {
  const left = Object.keys(routes).filter((key) => untranslated(key, en[key] ?? '', es[key] ?? ''));
  assert.deepEqual(left, []);
  for (const key of SAME_IN_BOTH) assert.ok(key in routes, `${key} is in SAME_IN_BOTH but no longer a write route`);
});

test('no key is left from a route that is gone, and nothing but write routes is there', () => {
  const known = new Set(Object.keys(routes));
  assert.deepEqual(Object.keys(en).filter((key) => !known.has(key)), []);
  assert.deepEqual(Object.keys(es).filter((key) => !known.has(key)), []);
});

test('a string with letters in it is untranslated when it equals English, unless it is listed', () => {
  assert.equal(untranslated('POST /x', 'Stop a chat', 'Stop a chat'), true);
  assert.equal(untranslated('POST /x', 'Stop a chat', 'Detener un chat'), false);
  assert.equal(untranslated('POST /x', '—', '—'), false);
});
