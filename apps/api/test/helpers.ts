import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gives the CLI's own login a credentials file in `configDir`, so it is an account work can start on.
 * Without a credential of any kind it is a ghost no choice lands on and no list shows (regression
 * audit 2026-10-29, §2.9), and a test whose chats run on it would have no account at all.
 */
export function signInDefault(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-access', refreshToken: 'test-refresh' } }));
}
