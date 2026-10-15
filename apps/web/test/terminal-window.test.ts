import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWindowMessage, parseWindowMessage, terminalWindowId, terminalWindowPath } from '../src/components/terminal/terminal-window';

test("a terminal's window route round-trips its id, odd characters included", () => {
  for (const id of ['abc-123', 'a b/c']) assert.equal(terminalWindowId(terminalWindowPath(id)), id);
});

test('only the window route is read as a terminal window, and a broken escape is not', () => {
  assert.equal(terminalWindowId('/'), null);
  assert.equal(terminalWindowId('/terminals/abc'), null);
  assert.equal(terminalWindowId('/terminal-window/'), null);
  assert.equal(terminalWindowId('/terminal-window/a/b'), null);
  assert.equal(terminalWindowId('/terminal-window/%E0%A4%A'), null);
});

test('a message from another window is used only when it is one of ours', () => {
  assert.deepEqual(parseWindowMessage({ type: 'here', id: 'x' }), { type: 'here', id: 'x' });
  assert.deepEqual(parseWindowMessage({ type: 'who' }), { type: 'who' });
  assert.equal(parseWindowMessage({ type: 'here' }), null);
  assert.equal(parseWindowMessage({ type: 'here', id: '' }), null);
  assert.equal(parseWindowMessage({ type: 'other', id: 'x' }), null);
  assert.equal(parseWindowMessage('here'), null);
  assert.equal(parseWindowMessage(null), null);
});

test("a window's presence adds its terminal to the detached set and its closing removes it", () => {
  const none: ReadonlySet<string> = new Set();
  const one = applyWindowMessage(none, { type: 'here', id: 'a' });
  assert.deepEqual([...one], ['a']);
  assert.equal(applyWindowMessage(one, { type: 'here', id: 'a' }), one, 'the same message changes nothing');
  assert.deepEqual([...applyWindowMessage(one, { type: 'here', id: 'b' })], ['a', 'b']);
  assert.deepEqual([...applyWindowMessage(one, { type: 'gone', id: 'a' })], []);
  assert.equal(applyWindowMessage(one, { type: 'gone', id: 'z' }), one);
  assert.equal(applyWindowMessage(one, { type: 'who' }), one, 'a question is not an answer');
  assert.equal(applyWindowMessage(one, { type: 'close', id: 'a' }), one, 'a request to close is for the window, not the panel');
});
