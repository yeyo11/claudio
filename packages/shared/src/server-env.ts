/**
 * What of the server's own environment a process it starts for an agent or a person may inherit.
 *
 * The server is configured through its environment (`PORT`, `HOST`, `CLAUDIO_DATA_DIR`,
 * `CLAUDIO_WEB_DIST`...), and a child that inherits those values is configured as the server. On
 * 2026-10-18 a worker ran `pnpm dev` in its worktree; the dev server read the desktop's
 * `CLAUDIO_DATA_DIR` and `PORT` from the worker's environment, opened the owner's live data and
 * closed the owner's tunnel (docs/chat-environment.md). So `CLAUDIO_*` is an allow-list: a variable a
 * child is meant to hold is named here, and every other one is dropped, including one added later.
 */

/** The variables a child is meant to hold: the API of the wrapper that started it, and which chat it is */
export const CHILD_CLAUDIO_VARIABLES: readonly string[] = ['CLAUDIO_API_URL', 'CLAUDIO_API_TOKEN', 'CLAUDIO_CHAT_ID'];

/**
 * Families a child is meant to hold. `CLAUDIO_FAKE_CLI_` are the switches of the browser suite's
 * fake Claude Code (`e2e/fake-cli`), which reads them in the process the server spawns.
 */
export const CHILD_CLAUDIO_PREFIXES: readonly string[] = ['CLAUDIO_FAKE_CLI_'];

/** Variables without the prefix that configure the server: where it listens */
export const SERVER_VARIABLES: readonly string[] = ['PORT', 'HOST'];

/** Whether `name` is the server's own and never reaches a child */
export function isServerVariable(name: string): boolean {
  if (SERVER_VARIABLES.includes(name)) return true;
  if (!name.startsWith('CLAUDIO_')) return false;
  return !CHILD_CLAUDIO_VARIABLES.includes(name) && !CHILD_CLAUDIO_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** A copy of `base` without the server's own variables */
export function withoutServerEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(base)) if (!isServerVariable(name)) env[name] = value;
  return env;
}
