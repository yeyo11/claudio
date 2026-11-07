// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLanguage } from '../src/i18n';
import { StalePage } from '../src/components/ReloadOffer';

// The pages that stand in for one that could not be drawn (docs/api-wire.md, "A render error is a
// page"). A page whose code the deploy removed is replaced whole inside the shell, so nothing else on
// the screen is its heading: the state's title is the page's h1, as the render-error page's is.

test("a page whose code is gone names itself as the page's heading, in the person's language", () => {
  setLanguage('en');
  const en = renderToStaticMarkup(<StalePage />);
  assert.match(en, /<h1 class="state-title">This page belongs to an older version of Claudio<\/h1>/);
  setLanguage('es');
  try {
    assert.match(renderToStaticMarkup(<StalePage />), /<h1 class="state-title">[^<]+<\/h1>/);
  } finally {
    setLanguage('en');
  }
});
