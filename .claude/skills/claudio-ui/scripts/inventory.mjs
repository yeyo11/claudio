#!/usr/bin/env node
// Writes references/components.md from the shared components and controls, so "reuse before you
// create" starts from what exists. Generated on demand and not tracked: never edit the .md by hand.
//   node .claude/skills/claudio-ui/scripts/inventory.mjs [--src packages/ui/src/components,packages/chat-ui/src/components] [--out <path>]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const sources = option('src', 'packages/ui/src/components,packages/chat-ui/src/components').split(',');
const outPath = resolve(root, option('out', relative(root, join(here, '..', 'references', 'components.md'))));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx$/.test(name) && !/\.(test|stories|spec)\./.test(name) ? [path] : [];
  });
}

function componentsOf(file) {
  const src = readFileSync(file, 'utf8');
  const found = [];
  for (const m of src.matchAll(/(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?export\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9]*)/g)) {
    const doc = (m[1] ?? '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean).join(' ');
    const props = new RegExp(`(?:interface|type)\\s+${m[2]}Props\\s*(?:=|extends[^{]*)?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
    const lines = (props ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/;$/, ''));
    found.push({ name: m[2], file: relative(root, file), doc: doc.slice(0, 220), props: lines });
  }
  return found;
}

const files = sources.flatMap((dir) => {
  try {
    return walk(resolve(root, dir));
  } catch {
    console.error(`no folder ${dir}`);
    return [];
  }
});
const components = files.flatMap(componentsOf).sort((a, b) => a.name.localeCompare(b.name));
const md = [
  '# Components that exist (GENERATED, do not edit)',
  '',
  `Generated on ${new Date().toISOString().slice(0, 10)} from ${sources.map((s) => `\`${s}\``).join(', ')}: ${components.length} components.`,
  'Reuse before you create; a new component needs one line of justification in the pull request.',
  '',
  ...components.flatMap((c) => [`## ${c.name}`, `\`${c.file}\`${c.doc ? ` — ${c.doc}` : ''}`, '', c.props.length ? '```ts\n' + c.props.join('\n') + '\n```' : '_No typed props found._', '']),
].join('\n');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log(`components.md: ${components.length} components → ${relative(root, outPath)}`);
