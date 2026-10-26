// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tooltip, TooltipProvider } from '../src/components/controls/Tooltip.tsx';

const render = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

test('a described tooltip gives its trigger the hint as a description while closed, for a screen reader', () => {
  const html = render(
    <Tooltip content="Started from Claudio" describe>
      <span tabIndex={0}>Claudio</span>
    </Tooltip>,
  );
  const id = /<span tabindex="0" aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(id, html);
  assert.ok(html.includes(`<span id="${id}" hidden="">Started from Claudio</span>`), html);
});

test('a plain tooltip adds no description: its hint stays the hover and focus layer alone', () => {
  const html = render(
    <Tooltip content="Copy">
      <button type="button">Copy</button>
    </Tooltip>,
  );
  assert.doesNotMatch(html, /aria-describedby|hidden=""/);
});

test('a described tooltip with nothing to say describes nothing', () => {
  const html = render(
    <Tooltip content="" describe>
      <span tabIndex={0}>Claudio</span>
    </Tooltip>,
  );
  assert.doesNotMatch(html, /aria-describedby|hidden=""/);
});
