// Drift net over the stylesheets: no class is lost, renamed or invented unnoticed, and they keep
// their cascade order. It began as the guard of the web packages split; today a commit that adds,
// renames or removes a class regenerates test/fixtures/class-names.json in the same commit
// (`tsx scripts/class-inventory.ts --write`), and the reviewer reads that diff as the list of classes
// the change touched. What the net catches is a class lost by a change that did not mean to, often
// one an e2e spec selects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classInventory, FIXTURE, selectorsOf, type ClassInventory } from '../scripts/class-inventory';

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ClassInventory;
const now = classInventory();

function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((item) => !other.has(item));
}

test('every class selector of every stylesheet is still defined, and none is new', () => {
  assert.deepEqual({ lost: difference(fixture.selectors, now.selectors), added: difference(now.selectors, fixture.selectors) }, { lost: [], added: [] });
});

test('every static className token is still used, and none is new', () => {
  assert.deepEqual({ lost: difference(fixture.classNames, now.classNames), added: difference(now.classNames, fixture.classNames) }, { lost: [], added: [] });
});

test('the stylesheets are imported in the same order', () => {
  assert.deepEqual(now.stylesheets, fixture.stylesheets);
});

test('selectors are read from rule preludes only', () => {
  const css = '/* .comment */ .a:hover > .b-c, .d { margin: 1.5rem; background: url("x.svg#.e"); }\n@media (min-width: 40rem) { .f::after { content: ".g"; } }';
  assert.deepEqual(selectorsOf(css).sort(), ['a', 'b-c', 'd', 'f']);
});
