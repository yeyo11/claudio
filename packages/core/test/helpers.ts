import { mkdtempSync } from 'node:fs';
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
  return config;
}
