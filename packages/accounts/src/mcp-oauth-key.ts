import { createHash } from 'node:crypto';

/**
 * The key the CLI keeps an MCP server's OAuth entry under, in `<config dir>/.credentials.json`
 * (`mcpOAuth`): `<name>|<first 16 hex of sha256(JSON.stringify({type, url, headers ?? {}}))>`. Read in
 * the 2.1.325 bundle and checked against every entry of a real default account (the S6 spike,
 * docs/reports/account-config-spikes.md). It does not depend on the config dir, so the same server
 * definition has the same key in every account, which is what lets an entry be copied. The format is
 * undocumented: the canary's `s6` check guards it, and this is the one place the formula lives.
 */
export interface McpOAuthServer {
  /** The server's name in the account's MCP configuration */
  name: string;
  type: string;
  url: string;
  headers?: Record<string, string>;
}

export function mcpOAuthKey(server: McpOAuthServer): string {
  // The field order is the CLI's: `type`, `url`, `headers`
  const hash = createHash('sha256').update(JSON.stringify({ type: server.type, url: server.url, headers: server.headers ?? {} })).digest('hex');
  return `${server.name}|${hash.slice(0, 16)}`;
}
