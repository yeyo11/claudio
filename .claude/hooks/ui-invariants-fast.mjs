#!/usr/bin/env node
// PostToolUse on Edit/Write/MultiEdit: the fast UI invariants (I1, I2, and I9/I10 on a phone) on the
// screen the edited file renders, at 320 and 1280 px, when the web dev server of its checkout is
// running. Without a server, or for a file no screen maps to, it says so and lets the turn go on.
// By hand: node .claude/hooks/ui-invariants-fast.mjs --route '/settings?tab=decisions'
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { block, checkoutOf, editedPath, lintModule, readHookInput, routeFor } from './_common.mjs';

const argv = process.argv.slice(2);
let route = argv.includes('--route') ? argv[argv.indexOf('--route') + 1] : null;
let root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (!route) {
  const input = readHookInput();
  const file = editedPath(input);
  if (!file) process.exit(0);
  const owner = checkoutOf(file);
  if (!owner) process.exit(0);
  root = owner;
  const lint = await lintModule(root);
  if (lint.kindOf(file) === null) process.exit(0);
  route = routeFor(root, file);
  if (!route) {
    process.stdout.write(`ui-invariants-fast: no screen in .claude/designer/route-map.json for ${relative(root, file)}; browser invariants skipped.\n`);
    process.exit(0);
  }
}

const base = process.env.UI_BASE_URL ?? 'http://localhost:5181';
const up = await fetch(base, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
if (!up) {
  process.stdout.write(`ui-invariants-fast: no dev server at ${base} (pnpm dev:web); browser invariants skipped for ${route}.\n`);
  process.exit(0);
}

const run = spawnSync(process.execPath, [join(root, 'scripts', 'ui-check.mjs'), '--route', route, '--fast', '--base', base], { cwd: root, encoding: 'utf8', timeout: 110_000 });
if (run.status === 1) {
  block(
    `UI invariants fail on ${route} (320/1280 px). It is not done, however it looks.\n${(run.stdout ?? '').trim().slice(0, 4000)}\n` +
      'How to read a failure: .claude/skills/claudio-ui/references/invariants.md. Fix it and edit again; this check runs after every edit.',
  );
}
if (run.status !== 0) process.stdout.write(`ui-invariants-fast: the check did not run (${run.status ?? run.signal}): ${(run.stderr ?? '').trim().slice(0, 400)}\n`);
else process.stdout.write(`${(run.stdout ?? '').trim()}\n`);
process.exit(0);
