import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type CoreConfig } from '../src/paths.ts';

/**
 * Isolated config/workspace/data dirs so tests never touch the real ~/.claude.
 */
export function tempConfig(): CoreConfig {
  const root = mkdtempSync(join(tmpdir(), 'claudio-test-'));
  const config = loadConfig({
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
  });
  // Guards are on for automated runs by default, and they refuse a guard program writable by the group,
  // which a checkout under a umask of 002 is. Suites that test guards write their own settings.
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'guards.json'), `${JSON.stringify({ automated: false })}\n`);
  return config;
}
