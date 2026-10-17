#!/usr/bin/env node
// The design lint (docs/plans/claudio-designer.md §1, docs/design-system.md): the rules a machine can
// hold, over the stylesheets, components and locale files of apps/web, packages/ui and
// packages/chat-ui. One module for three callers, so they never disagree: the PostToolUse hook in
// .claude/hooks/design-lint.mjs (the file just edited), apps/web/test/design-voice.test.ts (the
// whole tree, in `pnpm test`) and a person: `node scripts/design-lint.mjs [files…]`.
//
// A line that must break a rule on purpose says why in a comment on it or on the line above:
// `design-lint-ok: <reason>` in TSX, `/* design-lint-ok: <reason> */` in CSS, or
// `design-lint-ok-file: <reason>` in a comment of a file's first 20 lines. A mono rule whose
// selector reads like a label (`.chat-head-id`) says `/* literal */` inside its block.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOTS = ['apps/web/src', 'packages/ui/src', 'packages/chat-ui/src'];
const TOKENS = 'packages/ui/src/styles/tokens.css';
const CONTROLS = 'packages/ui/src/components/controls/';
/** The one uppercase level: the sidebar's group headings and their twin on the phone's More page */
export const CAPS_SELECTORS = ['.nav-group-label', '.live-section-head', '.more-group-head'];

const toPosix = (path) => path.split(sep).join('/');

/** Whether a path (absolute or repo-relative) is one the design lint covers, and as what */
export function kindOf(path) {
  const rel = toPosix(relative(REPO, resolve(REPO, path)));
  if (!ROOTS.some((root) => rel.startsWith(`${root}/`))) return null;
  if (rel === TOKENS) return null;
  if (rel.endsWith('.css')) return 'css';
  if (/\/locales\/.+\.json$/.test(rel)) return 'locale';
  if (/\.(tsx|ts)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel) && !rel.endsWith('.d.ts')) return 'tsx';
  return null;
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

// ---------- CSS ----------

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const WHITE = /^#fff(?:fff)?$/i;
const PX = /\d(?:\.\d+)?px\b/;
const TIME = /(?<![\w.-])\d*\.?\d+m?s\b/;
const SIZE_OK = /^(?:var\(--fs-(?:title|section|body|small|input)\)|inherit)$/;
const WEIGHT_OK = /^(?:var\(--fw-(?:regular|strong)\)|inherit)$/;
const TRACKING_OK = /^(?:0|normal|inherit|var\(--tracking-title\))$/;
const STATE = /:hover|:focus|\.active\b|\.selected\b|\.on\b|\.is-active\b|\.is-selected\b|\[aria-(?:current|selected|pressed|expanded)/;
const LABEL_LIKE = /(?:label|head|heading|title|badge|kicker|eyebrow|count|stat|time|clock|date|ago|duration|cost|price|amount|percent|pct|tnum|figure|caption|legend)/i;

/** Comments become spaces (keeping offsets and lines); a block that holds a marker keeps a flag. */
function prepareCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => {
    const blank = comment.replace(/[^\n]/g, ' ');
    if (/design-lint-ok\b/.test(comment)) return `\u0001${blank.slice(1)}`;
    if (/\bliteral\b/.test(comment)) return `\u0002${blank.slice(1)}`;
    return blank;
  });
}

/** The properties a `font:` shorthand sets: its weight, size and family, when written */
function fontShorthand(value) {
  const family = /var\(--(mono|sans)\)/.exec(value)?.[1];
  const size = /(?:^|\s)(var\(--fs-[a-z]+\)|\d*\.?\d+(?:px|r?em|%)|inherit)(?:\s*\/\s*\S+)?/.exec(value)?.[1];
  const weight = /(?:^|\s)(var\(--fw-[a-z]+\)|[1-9]00|[1-9][05]0|bold|bolder|lighter)(?=\s)/.exec(value)?.[1];
  return { family, size, weight };
}

export function lintCss(file, raw) {
  const css = prepareCss(raw);
  const problems = [];
  const lines = css.split('\n');
  const okLine = (line) => lines[line - 1]?.includes('\u0001') || lines[line - 2]?.includes('\u0001');
  for (const match of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').replace(/[\u0001\u0002]/g, '').trim();
    const block = match[2] ?? '';
    if (selector.startsWith('@') || /^(?:from|to|\d+%)/.test(selector)) continue;
    const literal = block.includes('\u0002');
    const caps = CAPS_SELECTORS.some((s) => selector.split(',').every((part) => part.trim().startsWith(s)));
    let offset = (match.index ?? 0) + (match[1]?.length ?? 0) + 1;
    let mono = false;
    let upper = false;
    let monoLine = 0;
    for (const part of block.split(';')) {
      const colon = part.indexOf(':');
      const leading = part.length - part.trimStart().length;
      const line = lineAt(css, offset + leading);
      offset += part.length + 1;
      if (colon < 0) continue;
      const property = part.slice(0, colon).replace(/[\u0001\u0002]/g, '').trim().toLowerCase();
      const value = part.slice(colon + 1).replace(/[\u0001\u0002]/g, '').trim().replace(/\s*!important$/, '');
      if (!property || okLine(line)) continue;
      const at = `${file}:${line}`;
      const say = (rule, text) => problems.push({ file, line, rule, message: `${text} — ${property}: ${value}`, where: at });
      for (const colour of value.match(COLOUR) ?? []) {
        const onGradient = WHITE.test(colour) && /^(?:color|fill|stroke|background-color)$/.test(property) && /var\(--(?:grad|gradient-accent)\)/.test(block);
        if (!onGradient) say('tokens', `raw colour ${colour}: use a token from tokens.css`);
      }
      if (/radius/.test(property) && PX.test(value)) say('tokens', 'px radius: use --radius-*');
      if (/^(?:transition|animation)/.test(property) && TIME.test(value)) say('tokens', 'raw duration: use --dur-* or a cycle token');
      if (/\b100vh\b/.test(value)) say('viewport', '100vh leaves content under a phone browser bar: use dvh or svh');
      if (property === 'font-size' && !SIZE_OK.test(value)) say('type-scale', 'font size outside the scale: use --fs-title, --fs-section, --fs-body, --fs-small (or --fs-input on a phone field)');
      if (property === 'line-height' && /\dpx\b/.test(value)) say('type-scale', 'px line height: use the --lh-* paired with the size, or a unitless value');
      if (property === 'font-weight' && !WEIGHT_OK.test(value)) say('type-weight', 'weight outside the scale: use --fw-regular or --fw-strong');
      if (property === 'font') {
        const font = fontShorthand(value);
        if (font.size && !SIZE_OK.test(font.size)) say('type-scale', `font shorthand with size ${font.size}: use a --fs-* token`);
        if (font.weight && !WEIGHT_OK.test(font.weight)) say('type-weight', `font shorthand with weight ${font.weight}: use --fw-regular or --fw-strong`);
        if (font.family === 'mono') {
          mono = true;
          monoLine = line;
        }
      }
      if ((property === 'font-weight' || (property === 'font' && fontShorthand(value).weight)) && STATE.test(selector)) {
        say('weight-on-state', 'weight set on a hover or selected state: the text widens and moves its neighbours; say it with fill and colour');
      }
      if (property === 'font-family' && /var\(--mono\)/.test(value)) {
        mono = true;
        monoLine = line;
      }
      if (property === 'text-transform' && /uppercase/.test(value)) {
        upper = true;
        if (!caps) say('caps', `uppercase outside the one caps level (${CAPS_SELECTORS.join(', ')}): write the copy in sentence case`);
      }
      if (property === 'letter-spacing' && !TRACKING_OK.test(value) && !(caps && value === 'var(--tracking-caps)')) {
        say('tracking', 'tracking outside the scale: 0, --tracking-title, or --tracking-caps on the caps level');
      }
    }
    if (mono && !literal && monoLine && !okLine(monoLine)) {
      const last = selector.split(',').map((s) => s.trim().split(/\s+/).pop() ?? '').join(' ');
      if (upper || LABEL_LIKE.test(last)) {
        problems.push({
          file,
          line: monoLine,
          rule: 'mono-voice',
          message: `mono on "${selector.replace(/\s+/g, ' ').slice(0, 80)}": mono is for literals the machine reads (ids, paths, models, commands, hashes); a label, badge, count, time or money is sans. If this one is a literal, say /* literal */ in the block`,
          where: `${file}:${monoLine}`,
        });
      }
    }
  }
  return problems;
}

// ---------- TSX ----------

const TSX_RULES = [
  [/(['"`])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\1|\b(?:rgba?|hsla?|oklch)\(\s*\d/, 'tokens', 'raw colour in a component: use a token (var(--…)) or a class'],
  [/\b(?:fontSize|fontWeight|fontFamily|letterSpacing|textTransform)\s*[:=]/, 'type-inline', 'type set inline: use the classes and the --fs-*/--fw-* tokens in a stylesheet'],
  [/\.toFixed\(/, 'number-format', 'toFixed() to show a number: use the helpers in packages/ui/src/lib/format.ts (Intl.NumberFormat)'],
  [/\$\{[^}]+\}\s?%(?![a-z\d])|\+\s*['"]\s?%['"]/, 'number-format', 'a number glued to "%": use formatPercent() (Intl.NumberFormat)'],
  [/\b100vh\b/, 'viewport', '100vh leaves content under a phone browser bar: use dvh or svh'],
];

const CSS_LENGTH = /\b(?:width|height|left|right|top|bottom|inset|flexBasis|transform|translate[XY]?|background|gradient|style|offset|clipPath|mask)\b|['"]--[a-z-]+['"]/i;

export function lintTsx(file, text) {
  const problems = [];
  const lines = text.split('\n');
  const inControls = toPosix(file).includes(CONTROLS);
  const ok = (i) => /design-lint-ok\b/.test(lines[i] ?? '') || /design-lint-ok\b/.test(lines[i - 1] ?? '');
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line) || ok(i)) return;
    for (const [re, rule, message] of TSX_RULES) {
      // A percentage that is a CSS length (a bar's width, a gradient stop) is not a number shown to anyone
      if (rule === 'number-format' && /%/.test(re.source) && CSS_LENGTH.test(line)) continue;
      if (re.test(line)) problems.push({ file, line: i + 1, rule, message, where: `${file}:${i + 1}` });
    }
    if (!inControls && /<select\b|<details\b|<input\b[^>]*\btype=["'](?:checkbox|radio|range|number)["']/.test(line)) {
      problems.push({ file, line: i + 1, rule: 'controls', message: 'native control: use Select, Toggle, Slider, NumberInput or Collapsible from packages/ui/src/components/controls', where: `${file}:${i + 1}` });
    }
  });
  // `title=` on a button or a link: a hover-only name a finger and a screen reader never get
  for (const match of text.matchAll(/<(button|a)\b((?:[^>{]|\{[^}]*\})*)>/g)) {
    if (!/\stitle=/.test(match[2] ?? '')) continue;
    const line = lineAt(text, match.index ?? 0);
    if (ok(line - 1)) continue;
    problems.push({ file, line, rule: 'title-on-interactive', message: `title= on <${match[1]}>: use Tooltip (or aria-label for an icon button)`, where: `${file}:${line}` });
  }
  return problems;
}

// ---------- locale files ----------

export function lintLocale(file, text) {
  const problems = [];
  text.split('\n').forEach((line, i) => {
    if (/\}\}\s?%/.test(line) || /%\s?\{\{/.test(line)) {
      problems.push({ file, line: i + 1, rule: 'number-format', message: 'a "%" in the copy: pass the value formatted by formatPercent() and leave the sign to Intl', where: `${file}:${i + 1}` });
    }
  });
  return problems;
}

export function lintText(file, text) {
  const kind = kindOf(file);
  // A whole file outside the rules on purpose (an official logo's colours, the terminal's cell size)
  if (/design-lint-ok-file:/.test(text.split('\n').slice(0, 20).join('\n'))) return [];
  if (kind === 'css') return lintCss(file, text);
  if (kind === 'tsx') return lintTsx(file, text);
  if (kind === 'locale') return lintLocale(file, text);
  return [];
}

export function lintFile(path) {
  const rel = toPosix(relative(REPO, resolve(REPO, path)));
  return lintText(rel, readFileSync(resolve(REPO, path), 'utf8'));
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
    return [path];
  });
}

/** Every file the lint covers, repo-relative */
export function coveredFiles() {
  return ROOTS.flatMap((root) => walk(join(REPO, root)))
    .map((path) => toPosix(relative(REPO, path)))
    .filter((rel) => kindOf(rel) !== null);
}

export function format(problems) {
  return problems.map((p) => `${p.where} [${p.rule}] ${p.message}`).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length ? args.filter((path) => kindOf(path) !== null) : coveredFiles();
  const problems = files.flatMap(lintFile);
  if (problems.length) {
    console.log(format(problems));
    const byRule = Object.entries(problems.reduce((acc, p) => ({ ...acc, [p.rule]: (acc[p.rule] ?? 0) + 1 }), {}));
    console.log(`\n${problems.length} problem(s) in ${new Set(problems.map((p) => p.file)).size} file(s): ${byRule.map(([r, n]) => `${r} ${n}`).join(', ')}`);
    process.exit(1);
  }
  console.log(`design-lint: ${files.length} file(s), no problems`);
}
