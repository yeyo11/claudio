// Drift net over every UI string: moving a key between namespaces keeps this multiset, while
// changing, dropping or duplicating a string breaks it. It began as the guard of the web packages
// split; today a commit that adds, changes or removes copy updates test/fixtures/strings.json in the
// same commit (both languages, kept sorted), and the reviewer reads that diff as the list of copy the
// change touched. What the net catches is a string lost or altered by a change that did not mean to.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en, es } from '../src/i18n/resources';

interface Tree {
  [key: string]: string | Tree;
}

function values(tree: Tree, into: string[] = []): string[] {
  for (const value of Object.values(tree)) {
    if (typeof value === 'string') into.push(value);
    else values(value, into);
  }
  return into;
}

const sorted = (tree: Tree): string[] => values(tree).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const fixture = JSON.parse(readFileSync(new URL('./fixtures/strings.json', import.meta.url), 'utf8')) as { en: string[]; es: string[] };

test('every English string is still there, once per key', () => {
  assert.deepEqual(sorted(en), fixture.en);
});

test('every Spanish string is still there, once per key', () => {
  assert.deepEqual(sorted(es), fixture.es);
});
