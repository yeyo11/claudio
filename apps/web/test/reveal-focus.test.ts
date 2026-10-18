import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryControl } from '../src/pages/config/search/reveal';

// A row reduced to what primaryControl reads, since the web tests run without a DOM
interface Fake {
  name: string;
  tabIndex: number;
  primary: boolean;
  disabled?: boolean;
}
const row = (children: Fake[]): HTMLElement => {
  const el = (c: Fake) => ({ ...c, hasAttribute: (a: string) => a === 'disabled' && !!c.disabled, getAttribute: () => null });
  const all = children.map(el);
  return {
    matches: () => false,
    querySelectorAll: (selector: string) => (selector.startsWith('input') && !selector.includes('button') ? all.filter((c) => c.primary) : all),
  } as unknown as HTMLElement;
};

test("a row's own field takes the focus before its tabindex=-1 helper buttons", () => {
  const found = primaryControl(
    row([
      { name: 'decrease', tabIndex: -1, primary: false },
      { name: 'input', tabIndex: 0, primary: true },
      { name: 'increase', tabIndex: -1, primary: false },
    ]),
  ) as unknown as Fake;
  assert.equal(found.name, 'input');
});

test('a row with only tabindex=-1 helpers has no control to focus', () => {
  assert.equal(primaryControl(row([{ name: 'decrease', tabIndex: -1, primary: false }])), null);
});
