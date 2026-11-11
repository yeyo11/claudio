/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathLabel } from '../src/components/changes/PathLabel';

// A path too long for its bar is cut in the middle: the directory and the name are separate spans so
// the stylesheet can shrink the directory first, and the whole path stays in the title.

test('PathLabel keeps the file name in its own span, apart from the directory', () => {
  const html = renderToStaticMarkup(<PathLabel path="apps/web/src/components/changes/steps/StepsLens.tsx" />);
  assert.match(html, /<span class="changes-path-dir">apps\/web\/src\/components\/changes\/steps\/<\/span>/);
  assert.match(html, /<span class="changes-path-name">StepsLens\.tsx<\/span>/);
});

test('PathLabel carries the full path as its title', () => {
  const html = renderToStaticMarkup(<PathLabel path="a/b/c.ts" />);
  assert.match(html, /title="a\/b\/c\.ts"/);
});

test('PathLabel of a bare file name has no directory span', () => {
  const html = renderToStaticMarkup(<PathLabel path="README.md" className="edit-step-where" />);
  assert.doesNotMatch(html, /changes-path-dir/);
  assert.match(html, /class="changes-path edit-step-where"/);
});
