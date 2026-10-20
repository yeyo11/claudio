// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as RadixPopover from '@radix-ui/react-popover';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMBOBOX_POPUP_ATTRS } from '../src/components/controls/Combobox.tsx';

// The Combobox's popup renders through a portal once the input opens it, which a static render
// cannot reach; the popup's own attributes are rendered here through the same Radix Content
test('the combobox popup is not an unnamed dialog around its listbox', () => {
  const html = renderToStaticMarkup(
    <RadixPopover.Root open>
      <RadixPopover.Anchor>field</RadixPopover.Anchor>
      <RadixPopover.Content {...COMBOBOX_POPUP_ATTRS}>
        <div role="listbox" aria-label="Model" />
      </RadixPopover.Content>
    </RadixPopover.Root>,
  );
  assert.doesNotMatch(html, /role="dialog"/);
  assert.match(html, /data-state="open" role="presentation"/);
  // A focusable element would ignore role="presentation" (axe presentation-role-conflict)
  assert.doesNotMatch(html, /role="presentation"[^>]*tabindex/);
  assert.match(html, /role="listbox" aria-label="Model"/);
});
