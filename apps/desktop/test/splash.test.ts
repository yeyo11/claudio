import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BRAND_C, BRAND_SPARK, BRAND_WORDMARK, LIGHT_SURFACE, SPLASH_HANDOFF_MAX_MS, SPLASH_INTRO_SECONDS, splashHtml } from '@claudio/ui/splash';

const kit = (path: string) => readFileSync(new URL(`../../../docs/design-system/claudio-brand-kit/${path}`, import.meta.url), 'utf8');

test('the splash draws the brand kit lockup path for path', () => {
  const lockup = kit('logos/svg/claudio-horizontal-dark.svg');
  const paths = [...lockup.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, [BRAND_C, BRAND_SPARK, BRAND_WORDMARK]);
  // The block and the wordmark's placement, as the lockup has them
  assert.ok(lockup.includes('<rect x="98" y="51.5" width="11" height="17" rx="3"'));
  assert.ok(lockup.includes('transform="translate(130 87.5)"'));
  const page = splashHtml();
  assert.ok(page.includes('<rect id="splash-block" x="98" y="51.5" width="11" height="17" rx="3"'));
  // The lockup's gradient vector; the page maps it onto the C's own box at load time
  assert.ok(page.includes('<linearGradient id="splash-brand" gradientUnits="userSpaceOnUse" x1="0.35" y1="0" x2="0.6" y2="1">'));
  assert.ok(lockup.includes('<linearGradient id="claudio-brand" x1="0.35" y1="0" x2="0.6" y2="1">'));
});

test('the splash uses the brand palette, and the surface of the light theme', () => {
  // The light surface is the app's: the splash fades into the background the UI paints next
  const tokens = readFileSync(new URL('../../../packages/ui/src/styles/tokens.css', import.meta.url), 'utf8');
  const light = tokens.slice(tokens.indexOf(":root[data-theme='light']"));
  assert.match(light, new RegExp(`--bg: ${LIGHT_SURFACE.bg.toLowerCase()};`));
  assert.ok(light.toLowerCase().includes(LIGHT_SURFACE.line.toLowerCase()));
  const palette = new Set(['#0B1020', '#246BFD', '#00E5FF', '#A78BFA', '#F4F7FF', '#17233D', LIGHT_SURFACE.bg, LIGHT_SURFACE.line]);
  const used = new Set([...splashHtml().matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase()));
  assert.deepEqual([...used].filter((hex) => !palette.has(hex)), []);
});

test('the splash is self-contained and its script parses', () => {
  const page = splashHtml();
  // Nothing to fetch: no font, image or script from anywhere (the SVG namespace is only a name)
  assert.doesNotMatch(page.replace(/xmlns="[^"]*"/g, ''), /https?:|src=|@import|url\((?!#)/);
  const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? '';
  assert.ok(script.includes('claudioSplash'), 'the main process hands off through window.claudioSplash');
  assert.doesNotThrow(() => new Function(script));
});

test('the splash stands still under reduced motion', () => {
  assert.ok(splashHtml().includes('prefers-reduced-motion: reduce'));
});

test('the intro lasts four seconds and the UI never waits on it for longer than it takes', () => {
  assert.equal(SPLASH_INTRO_SECONDS, 4);
  // The intro, its pause and its fade fit inside the main process's cap
  assert.ok(SPLASH_HANDOFF_MAX_MS > SPLASH_INTRO_SECONDS * 1000 + 600);
  assert.ok(SPLASH_HANDOFF_MAX_MS <= 6000);
});

test('the preview in the design system is the splash the app ships', () => {
  const preview = readFileSync(new URL('../../../docs/design-system/splash/eat-the-code.html', import.meta.url), 'utf8');
  assert.equal(preview, `${splashHtml()}\n`, 'regenerate it with `pnpm --filter @claudio/desktop splash:preview`');
});
