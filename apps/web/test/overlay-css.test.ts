// What keeps a dialog, a drawer and a sheet inside the window (docs/plans/claudio-designer.md §2).
// The pixels are measured by `overlayFit` in the e2e spec ui-overlays; this holds the rules that
// measurement found missing, so the one-line fix that was needed is not undone by a tidy-up: a long
// title that wraps instead of pushing the close button out, footers that wrap their actions, bodies
// that wrap an id with no break in it, overlays that end above the on-screen keyboard and below the
// desktop app's window controls, and the scroll-jump buttons the scroller must not cut.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(REPO, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule whose selector list is exactly `selector` (the first one that is) */
function rule(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  assert.fail(`no rule for ${selector}`);
}
const has = (block: string, declaration: RegExp, message: string) => assert.match(block, declaration, message);

const overlays = read('apps/web/src/styles/overlays.css');
const controls = read('packages/ui/src/controls.css');
const feedback = read('packages/ui/src/styles/feedback.css');
const workItem = read('apps/web/src/styles/work-item.css');
const transcript = read('packages/chat-ui/src/styles/transcript.css');

test('a dialog title cannot push the close button out, whatever it holds', () => {
  const title = rule(overlays, '.dialog-head h2');
  has(title, /min-width:\s*0/, 'the title is a flex child: min-width 0');
  has(title, /overflow-wrap:\s*anywhere/, 'a name with no break in it wraps');
  has(rule(overlays, '.dialog-head h2 > .ellipsis'), /display:\s*block/, 'an ellipsis needs a box');
  has(rule(controls, '.sheet-title'), /overflow-wrap:\s*anywhere/, 'the sheet title wraps too');
  has(rule(controls, '.sheet-description'), /overflow-wrap:\s*anywhere/, 'and its description');
});

test('the footers wrap their actions and the bodies wrap an id with no break in it', () => {
  has(rule(overlays, '.dialog-foot'), /flex-wrap:\s*wrap/, 'three actions do not fit a 320 px phone in a row');
  has(rule(controls, '.sheet-foot'), /flex-wrap:\s*wrap/, 'nor do they in a sheet');
  has(rule(overlays, '.dialog-foot > .btn'), /white-space:\s*normal/, 'a label longer than the footer wraps');
  has(rule(controls, '.sheet-foot > .btn'), /white-space:\s*normal/, 'also in a sheet');
  has(rule(overlays, '.dialog-body'), /overflow-wrap:\s*anywhere/, 'the dialog body never scrolls sideways');
  has(rule(controls, '.sheet-body'), /overflow-wrap:\s*anywhere/, 'nor the sheet body');
});

test('overlays end above the on-screen keyboard that iOS does not resize the page for', () => {
  has(rule(overlays, '.overlay'), /inset:\s*0 0 var\(--keyboard-inset, 0px\)/, 'the scrim and the dialog stop above the keyboard');
  has(rule(controls, '.sheet-bottom'), /var\(--keyboard-inset, 0px\)/, 'a bottom sheet sits on the keyboard');
  has(rule(workItem, '.newtask-screen'), /inset:\s*0 0 var\(--keyboard-inset, 0px\)/, 'the phone new-task screen keeps its Create button in reach');
});

test('a full-window overlay starts below the desktop app window controls', () => {
  has(rule(overlays, '.viewer'), /padding-top:\s*max\(env\(safe-area-inset-top, 0px\), var\(--chrome-top\)\)/, 'the media viewer bar is below --chrome-top');
  has(rule(overlays, '.overlay'), /padding:\s*var\(--ov-top\)/, 'a dialog keeps the overlay gutter, which holds --chrome-top');
});

test('the scroll-jump buttons overflow their empty box upwards, where the scroller does not cut them', () => {
  const jump = rule(feedback, '.scroll-jump');
  has(jump, /height:\s*0/, 'the box takes no room in the flow');
  has(jump, /justify-content:\s*flex-end/, 'so its buttons overflow toward the start, not past the end of the scroller');
});

test('the copy button of a code block is not taller than a one-line block on a touch screen', () => {
  const touch = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(transcript)?.[1] ?? '';
  assert.match(touch, /\.code-block:not\(\.has-header\)\s*\{[^}]*min-height:\s*calc\(var\(--touch\) \+ 10px\)/);
});
