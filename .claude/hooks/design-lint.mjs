#!/usr/bin/env node
// PostToolUse on Edit/Write/MultiEdit: the design lint (scripts/design-lint.mjs) over the file just
// edited. Exit 2 hands the problems back to Claude, which fixes them before going on; the rules are
// the ones apps/web/test/design-voice.test.ts holds the whole tree to.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { block, checkoutOf, editedPath, lintModule, markDirty, readHookInput } from './_common.mjs';

const input = readHookInput();
const file = editedPath(input);
if (!file) process.exit(0);
const root = checkoutOf(file);
if (!root) process.exit(0);
const lint = await lintModule(root);
if (lint.kindOf(file) === null) process.exit(0);

markDirty(root, input.session_id, file);
const rel = relative(root, file);
const problems = lint.lintText(rel, readFileSync(file, 'utf8'));
if (problems.length) {
  const shown = problems.slice(0, 25);
  block(
    `design-lint: ${problems.length} problem(s) in ${rel}. Fix them before going on.\n` +
      lint.format(shown).split('\n').map((line) => `  • ${line}`).join('\n') +
      (problems.length > shown.length ? `\n  … and ${problems.length - shown.length} more (node scripts/design-lint.mjs ${rel})` : '') +
      '\nThe rules: .claude/skills/claudio-ui/references/typography-voice.md and invariants.md (I15–I18). ' +
      'A line that breaks one on purpose says why: `design-lint-ok: <reason>`.',
  );
}
process.exit(0);
