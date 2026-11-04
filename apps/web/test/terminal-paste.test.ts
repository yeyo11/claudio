import assert from 'node:assert/strict';
import test from 'node:test';
import i18n from '../src/i18n';

const text = (lng: 'en' | 'es', key: string): string => (i18n.getFixedT(lng, 'terminal') as (key: string) => string)(key);

const PASTE_KEYS = ['paste.title', 'paste.field', 'paste.help', 'paste.helpTouch', 'paste.send', 'paste.cancel'];

test('the paste sheet has its copy in English and Spanish', () => {
  for (const key of PASTE_KEYS) {
    for (const lng of ['en', 'es'] as const) {
      const value = text(lng, key);
      assert.notEqual(value, key, `${lng} ${key}`);
      assert.ok(value.length > 0, `${lng} ${key}`);
    }
  }
  assert.equal(text('en', 'paste.send'), 'Send to terminal');
  assert.equal(text('es', 'paste.send'), 'Enviar a la terminal');
  assert.equal(text('es', 'paste.cancel'), 'Cancelar');
});

test('a refused clipboard names no key: a phone has none to press', () => {
  for (const lng of ['en', 'es'] as const) {
    assert.doesNotMatch(text(lng, 'notices.pasteBlocked'), /ctrl|shift|⌘/i, lng);
  }
  assert.match(text('en', 'notices.pasteBlocked'), /box that opened/);
});

test('the phone helper says press and hold, and the desktop one names no gesture of a finger', () => {
  assert.match(text('en', 'paste.helpTouch'), /press and hold/i);
  assert.match(text('es', 'paste.helpTouch'), /mant[eé]n pulsado/i);
  assert.doesNotMatch(text('en', 'paste.help'), /hold/i);
  assert.doesNotMatch(text('es', 'paste.help'), /pulsado/i);
});

test('copying with nothing selected says how to select, by touch or by pointer', () => {
  assert.match(text('en', 'notices.nothingSelectedTouch'), /press and hold/i);
  assert.match(text('en', 'notices.nothingSelected'), /drag/i);
  assert.match(text('es', 'notices.nothingSelectedTouch'), /mant[eé]n pulsado/i);
  assert.match(text('es', 'notices.nothingSelected'), /arrastra/i);
});
