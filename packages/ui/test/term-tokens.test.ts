import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

// The three places a theme is declared: dark on :root, then the light block and its
// prefers-color-scheme twin, which must carry the same values
const darkStart = css.indexOf(':root {');
const lightStart = css.indexOf(":root[data-theme='light'] {");
const systemStart = css.indexOf(":root[data-theme='system'] {");
assert.ok(darkStart >= 0 && lightStart > darkStart && systemStart > lightStart, 'token blocks not found');
const blocks = {
  dark: css.slice(darkStart, lightStart),
  light: css.slice(lightStart, systemStart),
  system: css.slice(systemStart),
};

function declared(block: string, prefix: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
    const name = m[1] as string;
    if (name.startsWith(prefix)) found.set(name, (m[2] as string).trim());
  }
  return found;
}

function resolve(block: string, name: string): string {
  const all = declared(block, '--');
  let value = all.get(name);
  for (let i = 0; i < 5 && value?.startsWith('var('); i++) value = all.get(value.slice(4, -1).trim());
  assert.ok(value, `${name} is not declared`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Black and bright black are backgrounds by convention (programs paint them behind text)
const EXEMPT = new Set([0, 8]);

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: every ANSI colour reads on the terminal background at 4.5:1`, () => {
    const block = blocks[theme];
    const bg = resolve(block, '--term-bg');
    for (let i = 0; i < 16; i++) {
      if (EXEMPT.has(i)) continue;
      const colour = resolve(block, `--term-ansi-${i}`);
      assert.match(colour, /^#[0-9a-f]{6}$/i, `--term-ansi-${i}`);
      const ratio = contrast(colour, bg);
      assert.ok(ratio >= 4.5, `--term-ansi-${i} ${colour} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
    assert.ok(contrast(resolve(block, '--term-fg'), bg) >= 4.5);
    assert.ok(contrast(resolve(block, '--term-cursor'), bg) >= 3);
  });

  test(`${theme}: the palette is complete`, () => {
    const names = [...declared(blocks[theme], '--term-').keys()];
    for (const n of ['--term-bg', '--term-fg', '--term-cursor', '--term-selection']) assert.ok(names.includes(n), n);
    for (let i = 0; i < 16; i++) assert.ok(names.includes(`--term-ansi-${i}`), `--term-ansi-${i}`);
  });
}

test('the light block and its system twin carry the same terminal palette', () => {
  assert.deepEqual([...declared(blocks.system, '--term-')], [...declared(blocks.light, '--term-')]);
});

test('the colours stay distinct from the status colours', () => {
  for (const theme of ['dark', 'light'] as const) {
    const status = new Set(['--ok', '--warn', '--bad', '--live', '--idle'].map((n) => resolve(blocks[theme], n).toLowerCase()));
    for (let i = 0; i < 16; i++) {
      assert.ok(!status.has(resolve(blocks[theme], `--term-ansi-${i}`).toLowerCase()), `--term-ansi-${i} equals a status colour`);
    }
  }
});
