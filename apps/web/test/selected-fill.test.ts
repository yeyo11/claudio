// The chosen pill or chip filled with the text colour (--selected-fill) and selected text: both must
// stay readable in both themes. On /chats on a phone the chosen state tab once read white on white:
// the base `.segment:hover` rule, which a tapped pill keeps on a touch screen, gave it back the text
// colour on a fill of the same colour.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = [join(REPO, 'apps/web/src'), join(REPO, 'packages/ui/src'), join(REPO, 'packages/chat-ui/src')];
const TOKENS = readFileSync(join(REPO, 'packages/ui/src/styles/tokens.css'), 'utf8');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

interface Rule {
  file: string;
  selector: string;
  decls: Map<string, string>;
}

/** Every innermost rule: its selector (the text since the last brace) and its declarations */
function rules(file: string): Rule[] {
  const css = stripComments(readFileSync(file, 'utf8'));
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const decls = new Map<string, string>();
    for (const part of (m[2] ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    return { file, selector: (m[1] ?? '').trim().replace(/\s+/g, ' '), decls };
  });
}

const ALL = ROOTS.flatMap(cssFiles).flatMap(rules);

/** The declarations of the first block whose selector is exactly `selector` in tokens.css */
function tokenBlock(selector: string): Map<string, string> {
  const block = rules(join(REPO, 'packages/ui/src/styles/tokens.css')).find((r) => r.selector === selector);
  assert.ok(block, `tokens.css has a ${selector} block`);
  return block.decls;
}

function resolve(name: string, theme: Map<string, string>, base: Map<string, string>, depth = 0): string {
  const value = theme.get(name) ?? base.get(name);
  assert.ok(value !== undefined && depth < 10, `${name} resolves`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias?.[1] ? resolve(alias[1], theme, base, depth + 1) : value;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  assert.match(h, /^[0-9a-f]{6}$/i, `${hex} is an opaque hex colour`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const dark = tokenBlock(':root');
const THEMES: Array<[string, Map<string, string>]> = [
  ['dark', dark],
  ['light', tokenBlock(":root[data-theme='light']")],
];

for (const [theme, block] of THEMES) {
  test(`the chosen pill's text and selected text hold 4.5:1 in the ${theme} theme`, () => {
    for (const [fg, bg] of [
      ['--on-selected', '--selected-fill'],
      ['--selection-fg', '--selection-bg'],
    ] as const) {
      const got = ratio(resolve(fg, block, dark), resolve(bg, block, dark));
      assert.ok(got >= 4.5, `${fg} on ${bg} is ${got.toFixed(2)}:1 in ${theme}`);
    }
  });
}

test('selected text uses the selection pair, opaque, so no surface shows through it', () => {
  const selection = ALL.filter((r) => /::selection/.test(r.selector));
  assert.ok(selection.length > 0, 'a ::selection rule exists');
  for (const rule of selection) {
    assert.equal(rule.decls.get('background'), 'var(--selection-bg)', `${rule.file} ${rule.selector}`);
    assert.equal(rule.decls.get('color'), 'var(--selection-fg)', `${rule.file} ${rule.selector}`);
  }
});

test('a fill of the text colour always carries the colour that reads on it', () => {
  for (const rule of ALL) {
    const bg = rule.decls.get('background') ?? rule.decls.get('background-color');
    const color = rule.decls.get('color');
    // A bar, a dot or a knob filled with a grey has no text; a fill that sets a text colour does
    if (!bg || color === undefined) continue;
    if (/^var\(--(?:text|fg|selected-fill)\)$/.test(bg)) {
      assert.match(color, /^var\(--(?:bg|on-selected)\)$/, `${rule.file} ${rule.selector}: text on a ${bg} fill`);
    }
  }
});

test('the chosen segment never takes the hover colour', () => {
  const hovers = ALL.filter((r) => /^\.segment\b/.test(r.selector) && r.selector.includes(':hover') && r.decls.has('color'));
  assert.ok(hovers.length > 0, 'the segment hover rule exists');
  for (const rule of hovers) assert.match(rule.selector, /:not\([^)]*\.segment-on/, `${rule.file} ${rule.selector}`);
});

test('nothing inside a chosen chip or strip pill keeps a foreground colour of its own', () => {
  const inside = /\.chip-on\s|\.list-toolbar-strip \.segment-on\s/;
  const readsOnFill = /^(?:inherit|currentColor|var\(--on-selected\)|color-mix\(in srgb, (?:currentColor|var\(--on-selected\)) \d+%, transparent\))$/;
  for (const rule of ALL.filter((r) => inside.test(r.selector))) {
    for (const prop of ['color', 'stroke', 'fill', 'background']) {
      const value = rule.decls.get(prop);
      if (value !== undefined) assert.match(value, readsOnFill, `${rule.file} ${rule.selector} { ${prop}: ${value} }`);
    }
  }
});
