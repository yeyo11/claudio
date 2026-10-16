import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// R16 (a): a streaming answer read as dark grey on the dark background until its turn ended. The
// text of a message being written is painted at full colour; only the caret after it is live.
const css = ['transcript.css', 'chat.css'].map((name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Every innermost `selector { declarations }` of the stylesheets, at-rule wrappers left out. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
const DIMMING = /(^|;)\s*(opacity|color|filter|-webkit-text-fill-color|mix-blend-mode)\s*:/;

test('no rule mutes the text of a message being written, only its caret', () => {
  const streaming = rules.filter((r) => /\.msg-streaming|\.streaming-text/.test(r.selector));
  assert.ok(streaming.length > 0, 'the streaming selectors are still there');
  for (const rule of streaming) {
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      if (!/\.msg-streaming|\.streaming-text/.test(selector) || /::(after|before)$/.test(selector)) continue;
      assert.doesNotMatch(rule.body, DIMMING, `${selector} changes how the text is painted`);
    }
  }
});

test('the newest words are not faded through highlights', () => {
  assert.doesNotMatch(css, /::highlight\(stream-/);
  assert.doesNotMatch(source('../src/lib/smooth-text.ts'), /CSS\.highlights|stream-fresh/);
  assert.doesNotMatch(source('../src/components/Transcript.tsx'), /has-fade|useStreamFade/);
});

test('the caret shows at every motion level, so the stream always has its live mark', () => {
  const caret = rules.find((r) => r.selector === '.streaming-text > :last-child::after');
  assert.ok(caret, 'the caret is not scoped to a fade any more');
  assert.match(caret.body, /background:\s*var\(--live\)/);
});
