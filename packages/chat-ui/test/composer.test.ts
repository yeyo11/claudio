import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAFT_TTL_MS, draftKey, readDraft, writeDraft, type DraftStore } from '../src/composer/drafts';
import { docFromText, offsetOfPos, plainSlice, posOfOffset, schema, textOf } from '../src/composer/editor/text';
import { historyStep } from '../src/composer/history';

test('a text goes into the box as paragraphs and comes out as it went in', () => {
  for (const text of ['', 'one line', 'two\nlines', 'blank\n\nbetween', '\nleading', 'trailing\n', 'a\n\n\nb']) {
    assert.equal(textOf(docFromText(text)), text);
  }
  assert.equal(textOf(docFromText('windows\r\nline\rends')), 'windows\nline\nends');
});

test('a caret offset and a document position map onto each other across paragraphs', () => {
  const text = 'ab\n\ncde';
  const doc = docFromText(text);
  for (let offset = 0; offset <= text.length; offset++) {
    assert.equal(offsetOfPos(doc, posOfOffset(doc, offset)), offset, `offset ${offset}`);
  }
  // The start of the text is just inside the first paragraph
  assert.equal(posOfOffset(doc, 0), 1);
  // Past the end lands at the end
  assert.equal(offsetOfPos(doc, posOfOffset(doc, 999)), text.length);
});

test('pasted text keeps its lines and joins the paragraph it lands in', () => {
  const slice = plainSlice('first\nsecond');
  assert.equal(slice.openStart, 1);
  assert.equal(slice.openEnd, 1);
  assert.equal(slice.content.childCount, 2);
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('x'))]);
  assert.equal(textOf(doc), 'x');
});

function memory(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

test('a draft is kept per chat and kind, cleared when blank, and let go after a week', () => {
  const store = memory();
  const key = draftKey('chat-1', 'send');
  assert.notEqual(key, draftKey('chat-1', 'resume'));
  writeDraft(key, 'half a thought', 1000, store);
  assert.equal(readDraft(key, 2000, store), 'half a thought');
  writeDraft(key, '   ', 3000, store);
  assert.equal(store.map.has(key), false);
  writeDraft(key, 'old', 0, store);
  assert.equal(readDraft(key, DRAFT_TTL_MS + 1, store), '');
  assert.equal(store.map.has(key), false);
  store.map.set(key, 'not json');
  assert.equal(readDraft(key, 0, store), '');
  assert.equal(readDraft(key, 0, null), '');
});

test('ArrowUp recalls the sent messages from an empty box, newest first, and ArrowDown walks back', () => {
  const history = ['first', 'second', 'third'];
  const up1 = historyStep('ArrowUp', { history, index: null, text: '', caret: 0 });
  assert.deepEqual(up1, { index: 0, text: 'third' });
  const up2 = historyStep('ArrowUp', { history, index: 0, text: 'third', caret: 0 });
  assert.deepEqual(up2, { index: 1, text: 'second' });
  assert.deepEqual(historyStep('ArrowUp', { history, index: 2, text: 'first', caret: 0 }), null);
  assert.deepEqual(historyStep('ArrowDown', { history, index: 1, text: 'second', caret: 0 }), { index: 0, text: 'third' });
  assert.deepEqual(historyStep('ArrowDown', { history, index: 0, text: 'third', caret: 5 }), { index: null, text: '' });
});

test('the arrows are the caret\'s in a box with words of the person\'s own', () => {
  const history = ['first'];
  assert.equal(historyStep('ArrowUp', { history, index: null, text: 'typed', caret: 0 }), null);
  assert.equal(historyStep('ArrowUp', { history, index: null, text: '', caret: 0 }) !== null, true);
  // Edited after recalling: no longer the recalled message, so Up does not replace it
  assert.equal(historyStep('ArrowUp', { history, index: 0, text: 'first!', caret: 0 }), null);
  assert.equal(historyStep('ArrowDown', { history, index: null, text: '', caret: 0 }), null);
  // Caret in the middle of a recalled message: the arrows move it
  assert.equal(historyStep('ArrowDown', { history, index: 0, text: 'first', caret: 2 }), null);
  assert.equal(historyStep('ArrowUp', { history: [], index: null, text: '', caret: 0 }), null);
});
