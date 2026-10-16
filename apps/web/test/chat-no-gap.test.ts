import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// R16 (b): after a send, a blank block as tall as the rest of the viewport opened between the answer
// and the composer. It was CHAT-14's turn spacer, sized to keep the new question at the top while
// the answer was shorter than the view. The conversation ends where its last row ends.
const view = readFileSync(new URL('../src/pages/ChatView.tsx', import.meta.url), 'utf8');

/** The JSX of the conversation's scroller, from its opening tag to the button that jumps to the end. */
const scroller = view.slice(view.indexOf('ref={scroller}'), view.indexOf('jump-latest'));

test('nothing after the conversation reserves room below it', () => {
  assert.ok(scroller.includes('<LiveTail'), 'the scroller is found');
  const tail = scroller.slice(scroller.indexOf('<LiveTail'));
  assert.doesNotMatch(tail, /style=\{\{[^}]*height/, 'an element after the live tail is sized by hand');
  assert.doesNotMatch(view, /useTurnSpacer|spacerRef/);
  assert.equal(existsSync(new URL('../../../packages/chat-ui/src/composer/turn-spacer.ts', import.meta.url)), false);
});

test('the scroller and its rows keep no height of their own for what is not there', () => {
  const css = readFileSync(new URL('../../../packages/chat-ui/src/styles/chat.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim();
    if (!/\.run-scroll\s*>|\.chat-now\b/.test(selector)) continue;
    assert.doesNotMatch(m[2] ?? '', /(^|;)\s*(min-height|height)\s*:/, `${selector} reserves height`);
  }
});
