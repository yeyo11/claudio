// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatOrigin } from '@claudio/shared';
import * as React from 'react';
import { register } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import i18n from '../src/i18n';

// ChatBadges imports its stylesheet, which Vite bundles and Node cannot load: an empty module stands in
register(
  'data:text/javascript,' +
    encodeURIComponent(
      "export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
    ),
);
const { OriginBadge } = await import('@claudio/chat-ui/components/ChatBadges');

// The origin badge's hint was reachable only by hovering: no Tab stop and no description, so a
// keyboard never opened it and a screen reader never heard it.

(globalThis as { React?: typeof React }).React = React;

const ORIGINS: ChatOrigin[] = ['claudio', 'external', 'orchestration', 'internal', 'api'];

const render = (origin: ChatOrigin, label?: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <OriginBadge origin={origin} label={label} />
    </TooltipProvider>,
  );

const unescape = (text: string) => text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The badge's element and the text of what its aria-describedby points at */
function described(html: string): { badge: string; hint: string } {
  const badge = /<span[^>]*class="badge badge-muted"[^>]*>/.exec(html)?.[0];
  assert.ok(badge, 'the badge is drawn');
  const id = /aria-describedby="([^"]+)"/.exec(badge)?.[1];
  assert.ok(id, 'the badge names a description');
  const target = new RegExp(`<span id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" hidden="">([^<]*)</span>`).exec(html);
  assert.ok(target, 'the description is in the document, hidden from sight');
  return { badge, hint: unescape(target[1] ?? '') };
}

test.after(async () => {
  await i18n.changeLanguage('es');
});

for (const lang of ['en', 'es'] as const) {
  test(`every origin badge describes itself with its hint for a screen reader (${lang})`, async () => {
    await i18n.changeLanguage(lang);
    for (const origin of ORIGINS) {
      const { hint } = described(render(origin));
      assert.equal(hint, i18n.t(`chat:badges.originHint.${origin}`, { agent: i18n.t('chat:agent.generic') }), origin);
      // The external hint names the agent: a raw placeholder must never reach a screen reader
      assert.doesNotMatch(hint, /\{\{|\}\}/, origin);
    }
  });
}

test('every origin badge is a Tab stop, so a keyboard opens its tooltip', async () => {
  await i18n.changeLanguage('en');
  for (const origin of ORIGINS) {
    const { badge } = described(render(origin));
    assert.match(badge, /tabindex="0"/, origin);
  }
});

test('the origin badge keeps its visible word: the label passed in, or the origin name', async () => {
  await i18n.changeLanguage('en');
  assert.match(render('orchestration', 'Release · Build'), /<\/svg> Release · Build<\/span>/);
  assert.match(render('api'), /<\/svg> API<\/span>/);
  const { hint } = described(render('api'));
  assert.equal(hint, 'Started by a client of the OpenAI-compatible API');
});

test('two origin badges on one screen point at their own hints', async () => {
  await i18n.changeLanguage('en');
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <OriginBadge origin="claudio" />
      <OriginBadge origin="api" />
    </TooltipProvider>,
  );
  const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});
