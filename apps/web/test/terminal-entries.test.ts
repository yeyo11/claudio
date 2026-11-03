import assert from 'node:assert/strict';
import test from 'node:test';
import { TERMINAL_SHORTCUTS, terminalEntries, type TerminalEntryOptions } from '../src/components/terminal/terminal-entries';
import i18n from '../src/i18n';

const base = (over: Partial<TerminalEntryOptions> = {}): TerminalEntryOptions => ({
  t: i18n.getFixedT('en', 'terminal'),
  running: true,
  compact: false,
  onCopy: () => {},
  onPaste: () => {},
  onSearch: () => {},
  ...over,
});

test('the shared entries are Copy, Paste and Search, in that order, with their shortcuts', () => {
  const entries = terminalEntries(base());
  assert.deepEqual(
    entries.map(({ id, shortcut }) => [id, shortcut]),
    [
      ['copy', 'Ctrl+Shift+C'],
      ['paste', 'Ctrl+Shift+V'],
      ['search', 'Ctrl+Shift+F'],
    ],
  );
  assert.deepEqual(TERMINAL_SHORTCUTS, { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', search: 'Ctrl+Shift+F' });
});

test('a phone shows no shortcuts', () => {
  assert.ok(terminalEntries(base({ compact: true })).every((entry) => entry.shortcut === undefined));
});

test('Copy is off, with its reason, when the menu knows nothing is selected', () => {
  const [copy, paste] = terminalEntries(base({ hasSelection: false }));
  assert.equal(copy?.disabled, true);
  assert.equal(copy?.disabledReason, 'Select some text first');
  assert.equal(paste?.disabled, false);
});

test('Copy stays on with a selection, and when the selection is not known (the ⋯ menu)', () => {
  for (const hasSelection of [true, undefined]) {
    const [copy] = terminalEntries(base({ hasSelection }));
    assert.equal(copy?.disabled, false);
    assert.equal(copy?.disabledReason, undefined);
  }
});

test('an ended terminal that is gone from the screen turns all three off, each saying why', () => {
  const entries = terminalEntries(base({ running: false, hasSelection: false }));
  assert.ok(entries.every((entry) => entry.disabled === true));
  // The shell, not the selection: there is no screen to select on
  assert.deepEqual(
    entries.map((entry) => entry.disabledReason),
    ['The shell has ended', 'The shell has ended', 'The shell has ended'],
  );
});

test('an ended terminal whose last screen is shown keeps Copy and Search, as its keys do', () => {
  const [copy, paste, search] = terminalEntries(base({ running: false, readable: true, hasSelection: true }));
  assert.equal(copy?.disabled, false);
  assert.equal(search?.disabled, false);
  assert.equal(paste?.disabled, true);
  assert.equal(paste?.disabledReason, 'The shell has ended');
  // Nothing selected on that screen: Copy blames the selection, not the shell
  const [none] = terminalEntries(base({ running: false, readable: true, hasSelection: false }));
  assert.equal(none?.disabled, true);
  assert.equal(none?.disabledReason, 'Select some text first');
});

test('each entry runs its own action', () => {
  const calls: string[] = [];
  const entries = terminalEntries(base({ onCopy: () => calls.push('copy'), onPaste: () => calls.push('paste'), onSearch: () => calls.push('search') }));
  for (const entry of entries) entry.onSelect?.();
  assert.deepEqual(calls, ['copy', 'paste', 'search']);
});

test('the reasons for a disabled Copy and Paste exist in both languages', async () => {
  for (const lng of ['en', 'es']) {
    await i18n.changeLanguage(lng);
    for (const [key, text] of [
      ['copyNone', i18n.t('terminal:menu.copyNone')],
      ['ended', i18n.t('terminal:menu.ended')],
    ] as const) {
      assert.notEqual(text, `menu.${key}`);
      assert.ok(text.length > 0);
    }
  }
});
