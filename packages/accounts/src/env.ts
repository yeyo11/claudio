import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AccountKind } from '@claudio/shared';

/** The account that is the CLI's own config, as the person set it up outside Claudio. */
export const DEFAULT_ID = 'default';

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
 * variable removed, then this account's own set: `CLAUDE_CONFIG_DIR` pointing at the account's dir,
 * plus the token or key for the kinds that have one.
 *
 * The default account keeps whatever `CLAUDE_CONFIG_DIR` the base had. Without one, it sets it only
 * when the account's dir is not the CLI's own default (`~/.claude`): set to that, the variable moves
 * the CLI's global config from `~/.claude.json` to `~/.claude/.claude.json`, a second file without
 * the person's MCP servers, project trust and model options (seen on CLI 2.1.300: 5 models instead
 * of 13). A default dir configured elsewhere (a test, a custom setup) still needs the variable.
 */
export function envFor(account: AccountRef, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of ACCOUNT_VARS) delete env[name];
  if (account.id !== DEFAULT_ID) env.CLAUDE_CONFIG_DIR = account.dir;
  else if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  else if (resolve(account.dir) !== resolve(base.HOME ?? homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = account.dir;
  if (account.kind === 'token') env.CLAUDE_CODE_OAUTH_TOKEN = readSecret(account);
  if (account.kind === 'api-key') env.ANTHROPIC_API_KEY = readSecret(account);
  return env;
}
