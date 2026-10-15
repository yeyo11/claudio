import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readTerminalTheme } from '../src/components/terminal/terminal-theme';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const TOKENS = readFileSync(path.join(REPO, 'packages/ui/src/styles/tokens.css'), 'utf8');
const DIR = path.join(import.meta.dirname, '..', 'src/components/terminal');

/** A style that answers every `--term-*` token with its own name, so the theme shows which token fed each colour. */
const named = { getPropertyValue: (name: string) => (name.startsWith('--term-') ? ` ${name} ` : '') };

test('the theme is built from the --term-* tokens: surface, text, cursor, selection and all sixteen colours', () => {
  const theme = readTerminalTheme(named);
  assert.equal(theme.background, '--term-bg');
  assert.equal(theme.foreground, '--term-fg');
  assert.equal(theme.cursor, '--term-cursor');
  assert.equal(theme.selectionBackground, '--term-selection');
  const normal = [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white];
  const bright = [theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite];
  assert.deepEqual(normal, Array.from({ length: 8 }, (_, i) => `--term-ansi-${i}`));
  assert.deepEqual(bright, Array.from({ length: 8 }, (_, i) => `--term-ansi-${i + 8}`));
});

test('a token the page lacks leaves xterm its own default for that colour', () => {
  const theme = readTerminalTheme({ getPropertyValue: () => '' });
  assert.deepEqual(theme, {});
});

test('every token the theme reads is defined in tokens.css, in the dark block and the light one', () => {
  const used = new Set(Object.values(readTerminalTheme(named)));
  assert.ok(used.size >= 20);
  for (const token of used) {
    const count = TOKENS.split(`${token}:`).length - 1;
    assert.ok(count >= 2, `${token} is defined for both themes (${count})`);
  }
});

test('no colour is written in the terminal components or in terminal.css', () => {
  const files = [
    ...readdirSync(DIR).map((name) => path.join(DIR, name)),
    path.join(import.meta.dirname, '..', 'src/styles/terminal.css'),
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${file} has a hex colour`);
    assert.doesNotMatch(source, /\b(?:rgba?|hsla?)\(/, `${file} has a function colour`);
  }
});
