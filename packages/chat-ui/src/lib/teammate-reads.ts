/*
 * The calls of Claudio's MCP tools that read what teammates share (docs/plans/collaborators-agent-access.md):
 * a row of one says whose content went into the chat. The tools are named by the MCP server
 * (`packages/mcp`); every one but the list takes the sharing install as `owner` and its share's
 * `shareId`. Pure, so which call names whom is unit tested.
 */

const PREFIX = 'mcp__claudio__collab_';

/** What a teammate-read call read: the list of every share, or one copy of one install */
export type TeammateRead = { kind: 'list' } | { kind: 'copy'; owner: string; shareId: string | null };

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** The read a call made, from its name and input; null for any other tool, or one that named no install */
export function teammateRead(name: string | null, input: unknown): TeammateRead | null {
  if (!name?.startsWith(PREFIX)) return null;
  if (name === `${PREFIX}list_shared`) return { kind: 'list' };
  const o = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const owner = str(o.owner);
  return owner ? { kind: 'copy', owner, shareId: str(o.shareId) } : null;
}
