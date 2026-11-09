// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { reachability } from '../src/lib/reachability';
import { useReloadOffer } from '../src/lib/reload';
import { WidgetBoundary, WidgetFailure } from '../src/pages/dashboard/WidgetBoundary';

// A widget whose chunk is gone after an update says so in the person's language instead of
// printing the browser's English message; any other failure still shows what went wrong.

function Probe() {
  return <i>{useReloadOffer()?.reason ?? 'none'}</i>;
}

const SAFARI = new TypeError("'text/html' is not a valid JavaScript MIME type.");

async function inLanguage<T>(language: 'en' | 'es', run: () => T): Promise<T> {
  const before = i18n.language;
  await i18n.changeLanguage(language);
  try {
    return run();
  } finally {
    await i18n.changeLanguage(before);
  }
}

test('a missing chunk shows the stale-build sentence, never the raw message, in both languages', async () => {
  for (const [language, words] of [
    ['en', en],
    ['es', es],
  ] as const) {
    const html = await inLanguage(language, () => renderToStaticMarkup(<WidgetFailure title="Usage" error={SAFARI} />));
    assert.ok(html.includes(words.shell.reload.stalePageHint), `${language}: the stale-build hint is shown`);
    assert.ok(!html.includes('MIME'), `${language}: the engine's message is not`);
    assert.ok(!html.includes('text/html'), `${language}: neither is its content type`);
  }
});

test('any other error keeps its own message', async () => {
  const html = await inLanguage('en', () => renderToStaticMarkup(<WidgetFailure title="Usage" error={new Error('boom')} />));
  assert.ok(html.includes('boom'));
  assert.ok(!html.includes(en.shell.reload.stalePageHint));
});

test('the boundary raises the reload offer for a chunk error and for nothing else', async (t) => {
  // The offer is one per page; its hook reads the same snapshot on the server, so it can be probed
  const offer = () => renderToStaticMarkup(<Probe />);
  // A chunk error is taken for a new version only once the server answers (D9): the probe gets an answer
  reachability.reset();
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const boundary = new WidgetBoundary({ title: 'Usage', children: null });
  assert.equal(offer(), '<i>none</i>');
  boundary.componentDidCatch(new Error('boom'));
  await settle();
  assert.equal(offer(), '<i>none</i>', 'a widget bug is not a deploy');
  boundary.componentDidCatch(SAFARI);
  await settle();
  assert.equal(offer(), '<i>stale</i>');
});

test('the boundary swaps itself for the failure once a child threw', () => {
  const state = WidgetBoundary.getDerivedStateFromError(SAFARI);
  const boundary = new WidgetBoundary({ title: 'Usage', children: <p>fine</p> });
  assert.equal(renderToStaticMarkup(<>{boundary.render()}</>), '<p>fine</p>');
  boundary.state = state;
  assert.ok(renderToStaticMarkup(<>{boundary.render()}</>).includes('alert-bad'));
});
