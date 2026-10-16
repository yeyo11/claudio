// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffView } from '../src/components/changes/DiffView';
import i18n from '../src/i18n';
import { parseUnified } from '../src/lib/diff';

// The dialog draws the preview with DiffView in Reading mode (design system §5): the file as it is
// now, only what changed in colour. The dialog itself portals into the document, which a string
// render has none of, so this covers the drawing; the 409 reload and the disabled Approve are in
// the e2e spec of the lessons plan.

const preview = ['@@ -1,2 +1,5 @@', ' # Project', ' ', '+## Lessons', '+', '+- When installing packages: use pnpm'].join('\n');

test('the preview of CLAUDE.md is drawn by DiffView in reading mode, with the added lines marked', async () => {
  await i18n.changeLanguage('en');
  const html = renderToStaticMarkup(<DiffView diff={parseUnified(preview)} mode="reading" path="CLAUDE.md" trimEdges />);
  assert.match(html, /diff-read/);
  assert.match(html, /Lessons/);
  assert.match(html, /use pnpm/);
});
