import { envFor, type AccountRef } from '@claudio/accounts';
import { withoutServerEnv } from '@claudio/shared';
import type { SecretVault } from './secret-vault.ts';
import { exclusiveVariables } from './setup/methods.ts';

/**
 * The vault every child environment reads. One per process: Core sets it when it starts, the way
 * the old credential store set `process.env`, so a spawn site deep in a driver needs no handle on
 * it. Null (a test that built no Core, a tool run outside the server) adds nothing.
 */
let current: Pick<SecretVault, 'get'> | null = null;

/** Sets the vault; the function returned takes it away again, unless another took its place since */
export function useVaultForChildren(vault: Pick<SecretVault, 'get'> | null): () => void {
  current = vault;
  return () => {
    if (current === vault) current = null;
  };
}

/** The vault's name for a CLI that goes by another name (`youtrack-app` is YouTrack's) */
const TOOL_OF: Readonly<Record<string, string>> = { 'youtrack-app': 'youtrack' };

/**
 * The environment of one process of `tool`: `base` (the inherited environment by default) with the
 * variables the vault keeps for that tool laid over it. A value in the vault wins over the
 * container's, and clearing it lets the container's show through again, since nothing is ever
 * written to `process.env`. For Claude Code, a credential in the vault also hides the container's
 * other one: with both a token and a key in its environment the CLI would pick for us.
 *
 * Every spawn of an agent, a host CLI or `youtrack-app` builds its environment here, so a secret
 * reaches only the tool it belongs to and never argv.
 *
 * The server's own variables never reach it (`withoutServerEnv`): `PORT`, `HOST` and every
 * `CLAUDIO_*` but the API's address, the chat's token and its id. A child that runs a Claudio of its
 * own (`pnpm dev` in a worktree) must not find the server's data directory and port there.
 *
 * With an `account` the process is that account's and no other's: `envFor` strips every account
 * variable of the base and sets only its own, and the vault is not consulted, so a token saved in
 * setup can never ride along with another account's config dir.
 */
export function childEnv(tool: string, base: NodeJS.ProcessEnv = process.env, account?: AccountRef | null): NodeJS.ProcessEnv {
  if (account) return envFor(account, base);
  const env: NodeJS.ProcessEnv = withoutServerEnv(base);
  const name = TOOL_OF[tool] ?? tool;
  const kept = current?.get(name) ?? {};
  if (Object.keys(kept).length === 0) return env;
  const exclusive = exclusiveVariables(name);
  if (exclusive.some((variable) => variable in kept)) for (const variable of exclusive) delete env[variable];
  return Object.assign(env, kept);
}
