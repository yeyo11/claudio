import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountKind } from '@agentry/shared';

/** The file inside an account's own dir holding a `token` or `api-key` secret; mode 0600. */
export const SECRET_FILE = 'secret';

/** What the code that launches a process needs of an account: no identity, no usage. */
export interface AccountRef {
  id: string;
  kind: AccountKind;
  /** Absolute config dir of the account */
  dir: string;
}

/** Every variable that selects an account; a process never inherits another kind's. */
export const ACCOUNT_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export function readSecret(account: AccountRef): string {
  const secret = readFileSync(join(account.dir, SECRET_FILE), 'utf8').trim();
  if (!secret) throw new Error(`account ${account.id} has an empty secret`);
  return secret;
}

/**
 * The environment a `claude` process of this account needs: the base one with every account
 * variable removed, then this account's own set. Always `CLAUDE_CONFIG_DIR`, so the CLI's config
 * (and its usage cache) is the account's; plus the token or key for the kinds that have one.
 */
export function envFor(account: AccountRef, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of ACCOUNT_VARS) delete env[name];
  env.CLAUDE_CONFIG_DIR = account.dir;
  if (account.kind === 'token') env.CLAUDE_CODE_OAUTH_TOKEN = readSecret(account);
  if (account.kind === 'api-key') env.ANTHROPIC_API_KEY = readSecret(account);
  return env;
}
