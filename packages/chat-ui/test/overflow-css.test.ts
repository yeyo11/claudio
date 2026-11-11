import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Design system, "Overflow": code and command output keep their lines and scroll inside their own
// block. A wrapping rule on one of them, or the phone override that once wrapped them, breaks it.
const read = (file: string): string => readFileSync(new URL(`../src/styles/${file}`, import.meta.url), 'utf8');
const transcript = read('transcript.css');
const chat = read('chat.css');

function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `${selector} has a rule`);
  return css.slice(at, css.indexOf('}', at));
}

test('code blocks and command output keep their lines instead of wrapping', () => {
  for (const selector of ['.code', '.call-term,\n.call-stderr,\n.call-stderr-neutral']) {
    const body = rule(transcript, selector);
    assert.match(body, /white-space: pre;/, selector);
    assert.doesNotMatch(body, /pre-wrap|overflow-wrap: anywhere/, selector);
  }
});

test('no phone rule turns the code blocks back into wrapping text', () => {
  assert.doesNotMatch(transcript, /\.run-scroll pre\.code/);
});

test('the chat scrollers reserve the scrollbar gutter, so content does not shift when it appears', () => {
  assert.match(rule(chat, '.run-scroll'), /scrollbar-gutter: stable;/);
  assert.match(rule(chat, '.detail-scroll'), /scrollbar-gutter: stable;/);
});

test('the Stop button and the drawer links are 44 px targets on a phone', () => {
  const start = chat.indexOf('A thumb needs 44 px');
  assert.notEqual(start, -1);
  const block = chat.slice(start, chat.indexOf('\n}\n', start));
  assert.match(block, /max-width: 767px/);
  assert.match(block, /\.composer \.composer-stop \{[^}]*height: var\(--touch\)/);
  assert.match(block, /\.detail-scroll \.link-btn,\s*\.detail-scroll dd > a \{[^}]*min-height: var\(--touch\)/);
});
