#!/usr/bin/env node
// The checks of CI's `checks` job that are not lint, typecheck or the unit tests, in one place, so
// the pre-push gate (`ci-checks` in .sluice.toml) and CI run the same list and cannot drift apart.
// Two pull requests reached CI with failures only CI ran (docs/status.md counts, then a build-time
// check), which is why this exists. Nothing here writes to the tree: every step only checks.
//
// Left out on purpose: `pnpm audit` (it asks the registry, and a new advisory against a dependency
// fails any branch, so it stays CI's daily ceiling) and the e2e suite (its own `e2e` gate).
import { spawnSync } from 'node:child_process';

const steps = [
  ['OpenAPI schemas are up to date with the shared types', 'pnpm', ['--filter', '@claudio/api', 'openapi:schemas', '--check']],
  ['docs/status.md counts are up to date', 'node', ['scripts/docs-status.mjs', '--check']],
  ['The web app builds', 'pnpm', ['build']],
  ["The e2e runner's own tests", 'node', ['--test', 'e2e/shards.test.mjs', 'e2e/harness.test.mjs']],
];

for (const [name, cmd, args] of steps) {
  console.log(`\n== ${name}`);
  const started = Date.now();
  const run = spawnSync(cmd, args, { stdio: 'inherit' });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (run.status !== 0) {
    console.error(`\n✗ ${name} (${secs} s)`);
    process.exit(run.status ?? 1);
  }
  console.log(`✓ ${name} (${secs} s)`);
}
