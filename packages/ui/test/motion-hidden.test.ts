// A background tab runs no loop, and must not freeze an entrance either: fade-in, fade-rise and
// pop-in start at opacity 0, and pausing them left a row that arrived while the tab counted as hidden
// taking its room in the transcript with nothing in it (packages/ui/src/styles/motion.css).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles/motion.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('a hidden tab gives each animation one pass instead of pausing it', () => {
  const rule = /:root\[data-hidden='true'\] \*,[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /animation-iteration-count:\s*1\s*!important/);
  assert.doesNotMatch(css, /data-hidden='true'\][^{]*\{[^}]*animation-play-state:\s*paused/);
});
