import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '@claudio/core';

/**
 * Every `/v1` chat is a confined API chat and starts only under its `declared-tools` guard (D14.5).
 * The guard's own install is tested in packages/core (guards-declared.test.ts): here the launch is
 * handed a plan of its own, whose rules file the fake CLI arms at start (`rulesSha256` all zeros),
 * and each request it was armed for is kept for the tests that read what a chat was given.
 */
export function standInGuard(core: Core, dir: string): Array<{ cwd: string; tools: string[] }> {
  const armed: Array<{ cwd: string; tools: string[] }> = [];
  mkdirSync(dir, { recursive: true });
  core.guardLauncher.prepareDeclared = async (cwd, declared) => {
    armed.push({ cwd, tools: [...declared.tools] });
    const settingsPath = join(dir, `guard-${String(armed.length)}.settings.json`);
    writeFileSync(settingsPath, '{}');
    return { rules: ['integrity', 'declared-tools'], mode: 'enforce', settingsPath, rulesSha256: '0'.repeat(64) };
  };
  return armed;
}
