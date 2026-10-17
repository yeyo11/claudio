import assert from 'node:assert/strict';
import { test } from 'node:test';
import { radioChoice, type MenuGroup } from '../src/components/controls/Menu.tsx';
import { sheetSections } from '../src/components/controls/MoreActions.tsx';

const group: MenuGroup = {
  id: 'accounts',
  label: 'Account',
  radio: { value: 'a', onChange: () => {} },
  items: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C', disabled: true, disabledReason: 'Exhausted until 16:00' },
  ],
};

test('a radio group reports the option picked', () => {
  assert.equal(radioChoice(group, 'b'), 'b');
});

test('a radio group never reports a disabled option, though Radix selects it', () => {
  assert.equal(radioChoice(group, 'c'), null);
});

test('a radio group never reports an option it does not have', () => {
  assert.equal(radioChoice(group, 'zzz'), null);
});

test('a sheet keeps the heading of each group and drops the separators', () => {
  const sections = sheetSections([{ id: 'one', label: 'One' }, { id: 'sep', separator: true }, group, { id: 'two', label: 'Two' }]);
  assert.deepEqual(
    sections.map((s) => [s.label ?? null, s.items.map((i) => i.id)]),
    [
      [null, ['one']],
      ['Account', ['a', 'b', 'c']],
      [null, ['two']],
    ],
  );
});

test('a sheet section keeps its radio group so the rows are read as radios', () => {
  const [section] = sheetSections([group]);
  assert.equal(section?.group?.radio?.value, 'a');
});
