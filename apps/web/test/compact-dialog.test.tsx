// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPACT_FOCUS_MAX } from '@claudio/shared';
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { setLanguage } from '../src/i18n';
import { CompactForm } from '../src/pages/chat/CompactDialog';
import { ApiRequestError } from '../src/api';

// The compact confirmation (docs/plans/context-control.md, "The compact confirmation"): the form is
// drawn from data here; sending it and the Dialog / Sheet shell belong to the e2e spec.

(globalThis as { React?: typeof React }).React = React;

function render(node: ReactNode, lang: 'en' | 'es' = 'en'): string {
  setLanguage(lang);
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

const form = (over: Partial<React.ComponentProps<typeof CompactForm>> = {}, lang: 'en' | 'es' = 'en') =>
  render(<CompactForm size={142_000} focus="" onFocus={() => undefined} note onNote={() => undefined} {...over} />, lang);

test('it says what compaction does, that it is a paid turn, and how big the context is now', () => {
  const html = form();
  assert.match(html, /summarises the conversation/);
  assert.match(html, /paid like any other/);
  assert.match(html, /about 142k tokens/);
  assert.match(form({}, 'es'), /unos 142k tokens/);
  assert.doesNotMatch(form({ size: null }), /about .* tokens/);
});

test('the focus field is a textarea capped at 500, with a tabular counter and an example placeholder', () => {
  assert.equal(COMPACT_FOCUS_MAX, 500);
  const html = form({ focus: 'the plan' });
  assert.match(html, /<textarea[^>]*maxLength="500"/);
  assert.match(html, /placeholder="the plan and the failing test"/);
  assert.match(html, /<span class="small muted tnum compact-count"[^>]*>8 \/ 500<\/span>/);
  assert.match(form({}, 'es'), /placeholder="el plan y el test que falla"/);
  assert.match(form({ focus: 'x'.repeat(500) }), />500 \/ 500</);
});

test('the note switch starts on and follows the prop', () => {
  assert.match(form(), /role="switch"[^>]*aria-checked="true"/);
  assert.match(form({ note: false }), /role="switch"[^>]*aria-checked="false"/);
  assert.match(form(), /Save the summary as a session note/);
});

test('a refusal stays in the dialog as the sentence the server wrote', () => {
  const html = form({ error: new ApiRequestError('The chat is working. Interrupt it first, or wait for the turn to end.', 409, undefined, 'busy') });
  assert.match(html, /role="alert"/);
  assert.match(html, /The chat is working\. Interrupt it first/);
});

test('while it is sent nothing can be edited', () => {
  const html = form({ disabled: true });
  assert.match(html, /<textarea[^>]*disabled/);
});
