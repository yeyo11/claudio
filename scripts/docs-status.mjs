#!/usr/bin/env node
// Writes the counts of docs/status.md's "Today" table (source files, the API contract's lines, route
// files, test files and browser specs) from the tree itself, so the page never states a number
// nobody re-counted: node scripts/docs-status.mjs. With --check it writes nothing and fails when the
// page is out of date, which is what CI runs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const PAGE = resolve(ROOT, 'docs/status.md');

// Tracked files, and new ones not yet added, so a run before a commit counts what the commit adds
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);
const count = (re) => files.filter((f) => re.test(f)).length;
const number = (n) => new Intl.NumberFormat('en').format(n);

const counts = {
  source: count(/\.(ts|tsx)$/),
  contract: readFileSync(resolve(ROOT, 'packages/shared/src/types.ts'), 'utf8').split('\n').length - 1,
  routes: count(/^apps\/api\/src\/routes\/[^/]+\.ts$/),
  tests: count(/\.test\.(ts|tsx)$/),
  specs: count(/^e2e\/specs\/[^/]+\.spec\.mjs$/),
};

// Each row is written whole; the words around the numbers are this script's, not the page's
const rows = {
  Source: `${number(counts.source)} tracked \`.ts\`/\`.tsx\` files (1,620 at Agentry 0.37.0, before the fork); the API contract is ${number(counts.contract)} lines of \`packages/shared/src/types.ts\``,
  REST: `${number(counts.routes)} route files, documented as OpenAPI 3.1 and served at \`/docs\``,
  Tests: `${number(counts.tests)} unit and integration test files, plus ${number(counts.specs)} browser specs under \`e2e/specs/\``,
};

const before = readFileSync(PAGE, 'utf8');
let after = before;
for (const [label, text] of Object.entries(rows)) {
  const row = new RegExp(`^\\| ${label} \\| .* \\|$`, 'm');
  if (!row.test(after)) {
    console.error(`docs/status.md has no "| ${label} |" row in its "Today" table`);
    process.exit(1);
  }
  after = after.replace(row, `| ${label} | ${text} |`);
}

if (process.argv.includes('--check')) {
  if (after !== before) {
    console.error('docs/status.md is out of date: run node scripts/docs-status.mjs and commit the result');
    process.exit(1);
  }
} else if (after !== before) {
  writeFileSync(PAGE, after);
  console.log('docs/status.md updated', counts);
}
