// The splash is written into index.html by the build and runs before the bundle, as a plain script.
// Its choreography is checked in a browser (docs/plans/splash-eat-the-code.md); here, what decides
// whether it shows and when it lets go, driven with a fake window like the boot guard's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { SPLASH_ID } from '@claudio/ui/splash';
import { injectSplash, SPLASH_MARKER, splashStrings } from '../scripts/splash.ts';

const WEB = path.join(import.meta.dirname, '..');
const STRINGS = splashStrings(WEB);

class FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = { opacity: '', visibility: '' };
  textContent: string | null = '';
  inert = false;
  removed = false;
  constructor(readonly id: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  remove() {
    this.removed = true;
  }
}

interface Page {
  window: Record<string, unknown> & { claudioSplash?: { handOff(): Promise<void> } };
  node(id: string): FakeNode;
  frames: number;
}

/** Runs the splash's script from a built page against a fake window */
function run({ reduced = false, storage = {}, extra = {} }: { reduced?: boolean; storage?: Record<string, string>; extra?: Record<string, unknown> } = {}): Page {
  const html = injectSplash(`<div id="root"></div>${SPLASH_MARKER}`, STRINGS);
  const source = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
  const nodes = new Map<string, FakeNode>();
  const node = (id: string) => nodes.get(id) ?? nodes.set(id, new FakeNode(id)).get(id)!;
  const page: Page = { window: {}, node, frames: 0 };
  Object.assign(page.window, {
    document: { getElementById: node },
    location: { search: '' },
    matchMedia: (query: string) => ({ matches: reduced && query.includes('reduce') }),
    requestAnimationFrame: () => ++page.frames,
    setTimeout: () => 0,
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    navigator: { languages: ['en-US'] },
    ...extra,
  });
  runInNewContext(source, { window: page.window, URLSearchParams });
  return page;
}

test('index.html carries the marker after #root and before the bundle', () => {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const root = html.indexOf('<div id="root"></div>');
  const marker = html.indexOf(SPLASH_MARKER);
  const bundle = html.indexOf('<script type="module"');
  assert.ok(root >= 0 && root < marker && marker < bundle);
});

test('the splash is written in place of the marker, and a page without one is an error', () => {
  const html = injectSplash(`<body>${SPLASH_MARKER}</body>`, STRINGS);
  assert.ok(html.includes(`<div id="${SPLASH_ID}">`));
  assert.ok(!html.includes(SPLASH_MARKER));
  assert.throws(() => injectSplash('<body></body>', STRINGS), /no <!-- splash -->/);
});

test('its words come from both locales', () => {
  assert.deepEqual(STRINGS.en, { status: 'Starting Claudio…', starting: 'Starting…' });
  assert.deepEqual(STRINGS.es, { status: 'Iniciando Claudio…', starting: 'Iniciando…' });
});

test('the desktop window and the e2e driver skip it at once', async () => {
  for (const extra of [{ claudioDesktop: { platform: 'linux' } }, { __claudioNoSplash: true }]) {
    const page = run({ extra });
    assert.equal(page.node(SPLASH_ID).removed, true);
    assert.equal(page.node('root').inert, false);
    assert.equal(page.frames, 0);
    await page.window.claudioSplash?.handOff();
  }
});

test('while it plays, the UI under it is out of reach, and the intro runs on frames', async () => {
  const page = run();
  assert.equal(page.node(SPLASH_ID).removed, false);
  assert.equal(page.node('root').inert, true);
  assert.equal(page.frames, 1);
  // Asked twice (strict mode), it answers with the same wait
  const first = page.window.claudioSplash?.handOff();
  assert.equal(page.window.claudioSplash?.handOff(), first);
});

test('with motion off it shows the finished lockup and goes as soon as the app is ready', async () => {
  for (const options of [{ reduced: true }, { storage: { 'claudio-motion': 'off' } }, { storage: { 'claudio-motion': 'subtle' } }]) {
    const page = run(options);
    assert.equal(page.frames, 0);
    // The finished frame: the stage in its place and the whole name uncovered
    assert.equal(page.node('splash-stage').attributes.get('transform'), 'translate(0.000 0)');
    assert.equal(page.node('splash-wipe').attributes.get('x'), '15.000');
    assert.equal(page.node('root').inert, true);
    await page.window.claudioSplash?.handOff();
    assert.equal(page.node(SPLASH_ID).removed, true);
    assert.equal(page.node('root').inert, false);
  }
});

test('it speaks the language the app will open in', () => {
  assert.equal(run({ storage: { 'claudio-language': 'es' } }).node('splash-status').textContent, 'Iniciando Claudio…');
  assert.equal(run({ extra: { navigator: { languages: ['es-ES', 'en'] } } }).node('splash-still').textContent, 'Iniciando…');
  assert.equal(run({ extra: { navigator: { languages: ['fr-FR'] } } }).node('splash-status').textContent, 'Starting Claudio…');
});
