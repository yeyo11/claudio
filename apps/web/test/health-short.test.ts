import assert from 'node:assert/strict';
import test from 'node:test';
import type { HealthSignalKind } from '@claudio/shared';
import { HEALTH_REASONS } from '../../../packages/core/src/health-strings.ts';
import en from '../src/i18n/locales/en/observe.json' with { type: 'json' };
import es from '../src/i18n/locales/es/observe.json' with { type: 'json' };

type Tree = { [key: string]: string | Tree };
const lookup = (tree: Tree, path: string): string | Tree | undefined =>
  path.split('.').reduce<string | Tree | undefined>((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);

const KINDS: HealthSignalKind[] = ['hung-command', 'silence', 'last-execution', 'waiting', 'context', 'branches', 'repeat-stall', 'no-progress', 'loop', 'weakened-test', 'budget', 'guard-blocked', 'guard-missing'];
const CODES = Object.keys(HEALTH_REASONS).filter((code) => code !== 'health.ok');

for (const [language, catalogue] of [['en', en], ['es', es]] as const) {
  test(`${language}: every kind of signal has a title that fits a row of the side panel`, () => {
    for (const kind of KINDS) {
      const title = lookup(catalogue as Tree, `health.signal.${kind}`);
      assert.equal(typeof title, 'string', kind);
      assert.ok((title as string).length <= 30, `${kind}: ${String(title)}`);
    }
  });

  test(`${language}: every reason code has a short line of at most 60 characters`, () => {
    for (const code of CODES) {
      const path = code.replace(/^health\./, 'health.short.');
      // A plural is written as _one and _other next to the base key
      const found = lookup(catalogue as Tree, path) ?? lookup(catalogue as Tree, `${path}_other`);
      assert.equal(typeof found, 'string', code);
      assert.ok((found as string).replace(/\{\{[^}]+\}\}/g, 'x'.repeat(8)).length <= 60, `${code}: ${String(found)}`);
    }
  });
}
