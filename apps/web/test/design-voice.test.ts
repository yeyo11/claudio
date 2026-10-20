// The voice of the UI (docs/plans/claudio-designer.md §1) over every stylesheet, component and
// locale file of the app and its packages: the four sizes and two weights, mono for literals, the
// one caps level, no weight change on state, numbers through Intl, the shared controls. The rules
// live in scripts/design-lint.mjs, which the edit hook runs on each file as it is written; this is
// what holds the whole tree to them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { coveredFiles, format, lintCss, lintFile, lintLocale, lintTsx } from '../../../scripts/design-lint.mjs';

test('the app and its packages follow the design lint', () => {
  const files = coveredFiles();
  assert.ok(files.length > 100, 'found the stylesheets, components and locale files');
  const problems = files.flatMap(lintFile);
  assert.equal(problems.length, 0, `design-lint problems:\n${format(problems.slice(0, 60))}${problems.length > 60 ? `\n… and ${problems.length - 60} more` : ''}`);
});

test('the lint catches what it is meant to catch', () => {
  const css = (text: string) => lintCss('x.css', text).map((p) => p.rule);
  assert.deepEqual(css('.a { font-size: 12px; }'), ['type-scale']);
  assert.deepEqual(css('.a { font: 500 11px var(--sans); }'), ['type-scale', 'type-weight']);
  assert.deepEqual(css('.a { font-weight: 700; }'), ['type-weight']);
  assert.deepEqual(css('.a { font: var(--fs-small) var(--sans); }'), ['type-weight']);
  assert.deepEqual(css('.a { line-height: 18px; }'), ['type-scale']);
  assert.deepEqual(css('.a:hover { font-weight: var(--fw-strong); }'), ['weight-on-state']);
  assert.deepEqual(css('.a.active { font-weight: var(--fw-strong); }'), ['weight-on-state']);
  assert.deepEqual(css('.panel-label { text-transform: uppercase; }'), ['caps']);
  assert.deepEqual(css('.a { letter-spacing: 0.08em; }'), ['tracking']);
  assert.deepEqual(css('.stat-count { font-family: var(--mono); }'), ['mono-voice']);
  assert.deepEqual(css('.badge { font: var(--fw-regular) var(--fs-small) var(--mono); }'), ['mono-voice']);
  assert.deepEqual(css('.a { min-height: 100vh; }'), ['viewport']);
  assert.deepEqual(css('.a { color: #e58a63; }'), ['tokens']);
  // What is allowed
  assert.deepEqual(css('.nav-group-label { font: var(--fw-regular) var(--fs-small) var(--sans); letter-spacing: var(--tracking-caps); text-transform: uppercase; }'), []);
  assert.deepEqual(css('.chat-id { font-family: var(--mono); font-size: var(--fs-small); line-height: var(--lh-small); }'), []);
  assert.deepEqual(css('.chat-head-id { /* literal: the chat id */ font-family: var(--mono); }'), []);
  assert.deepEqual(css('.title { font: var(--fw-strong) var(--fs-title) / var(--lh-title) var(--sans); letter-spacing: var(--tracking-title); }'), []);
  assert.deepEqual(css('.a { font: var(--fw-regular) var(--fs-small)/var(--lh-small) var(--sans); }'), []);
  assert.deepEqual(css('.a { font: inherit; }'), []);
  assert.deepEqual(css('.a { font-size: inherit; font-weight: inherit; line-height: 1.4; }'), []);
  assert.deepEqual(css('.a { font-size: 11px; /* design-lint-ok: the brand mark */ }'), []);

  const tsx = (text: string) => lintTsx('x.tsx', text).map((p) => p.rule);
  assert.deepEqual(tsx('const label = `${value}%`;'), ['number-format']);
  assert.deepEqual(tsx('<span>{n.toFixed(1)}</span>'), ['number-format']);
  assert.deepEqual(tsx('<div style={{ width: `${value}%` }} />'), []);
  assert.deepEqual(tsx('<span style={{ fontSize: 12 }} />'), ['type-inline']);
  assert.deepEqual(tsx('<select value={v} />'), ['controls']);
  assert.deepEqual(tsx('<input type="checkbox" />'), ['controls']);
  assert.deepEqual(tsx('<button type="button" title="Copy">x</button>'), ['title-on-interactive']);
  assert.deepEqual(tsx('<span title={full}>{short}</span>'), []);
  assert.deepEqual(tsx("const c = '#ff0000';"), ['tokens']);
  assert.deepEqual(tsx("const ref = '#123 fixed';"), []);
  assert.deepEqual(tsx('// design-lint-ok: SVG geometry\nconst d = x.toFixed(1);'), []);

  assert.deepEqual(lintLocale('x.json', '"weekly": "weekly {{pct}}%"').map((p) => p.rule), ['number-format']);
  assert.deepEqual(lintLocale('x.json', '"percent": "{{value}} %"').map((p) => p.rule), ['number-format']);
  assert.deepEqual(lintLocale('x.json', '"weekly": "weekly {{percent}}"'), []);
});
