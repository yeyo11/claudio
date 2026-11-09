import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { focusOpenedDialog } from '../src/components/controls/Menu.tsx';
import { focusReturn } from '../src/components/controls/layer.ts';

// A menu item that opens a dialog (a row's "⋯" → Edit, Remove) must leave focus in that dialog, not
// on the trigger behind its backdrop. No DOM here: a document of a few stand-ins is enough to drive it.

interface Fake {
  name: string;
  focused: string[];
  focus: () => void;
}

function element(name: string, log: string[]): Fake {
  return { name, focused: log, focus: () => log.push(name) };
}

function dialog(name: string, log: string[], { autofocus, controls = [] }: { autofocus?: string; controls?: string[] } = {}) {
  const own = controls.map((c) => element(c, log));
  const marked = autofocus ? element(autofocus, log) : null;
  return {
    ...element(name, log),
    contains: (node: unknown) => node !== null && (own.includes(node as Fake) || node === marked),
    querySelector: (selector: string) => (selector === '[data-autofocus]' ? marked : null),
    querySelectorAll: () => own,
  };
}

const realDocument = globalThis.document;
afterEach(() => {
  globalThis.document = realDocument;
});

function withDialogs(dialogs: unknown[], active: unknown = null) {
  globalThis.document = { querySelectorAll: () => dialogs, activeElement: active } as unknown as Document;
}

const closing = () => {
  let prevented = false;
  return { event: { preventDefault: () => (prevented = true) } as unknown as Event, prevented: () => prevented };
};

test('a dialog opened by the item takes the focus, on its marked field, and Radix does not send it back to the trigger', () => {
  const log: string[] = [];
  withDialogs([dialog('edit', log, { autofocus: 'name', controls: ['close', 'name', 'save'] })]);
  const { event, prevented } = closing();
  focusOpenedDialog(event, 0);
  assert.ok(prevented());
  assert.deepEqual(log, ['name']);
});

test('the menu’s trigger is where the dialog gives focus back, since the item that opened it is gone when it closes', () => {
  const log: string[] = [];
  const opened = dialog('edit', log, { autofocus: 'name', controls: ['close', 'name'] });
  withDialogs([opened]);
  const trigger = { focus: () => log.push('trigger') } as unknown as HTMLElement;
  focusOpenedDialog(closing().event, 0, trigger);
  assert.equal(focusReturn.get(opened as unknown as HTMLElement), trigger);
});

test('with no field marked, the first control after the close button is focused', () => {
  const log: string[] = [];
  withDialogs([dialog('remove', log, { controls: ['close', 'cancel', 'remove'] })]);
  const { event } = closing();
  focusOpenedDialog(event, 0);
  assert.deepEqual(log, ['cancel']);
});

test('no new dialog leaves the return to the trigger alone, and a menu inside an open dialog is not mistaken for one that opened it', () => {
  const log: string[] = [];
  withDialogs([dialog('settings', log, { controls: ['close', 'x'] })]);
  const { event, prevented } = closing();
  focusOpenedDialog(event, 1);
  assert.equal(prevented(), false);
  assert.deepEqual(log, []);
});
