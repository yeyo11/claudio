import type { LiveMcpServer } from '@claudio/shared';

const STATUSES: ReadonlySet<LiveMcpServer['status']> = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);

/** A claude.ai connector: the CLI lists it under this prefix, with the scope `claudeai`. */
const CONNECTOR_PREFIX = 'claude.ai ';
const CONNECTOR_SCOPE = 'claudeai';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The servers in the CLI's answer to `mcp_status`, as the page shows them. Read defensively: the
 * answer is the CLI's (confirmed on 2.1.300), and a field it renames must cost a detail, not the list.
 * The server's own config is left out: it can hold tokens and headers, and nothing here needs it.
 */
export function liveMcpServers(response: Record<string, unknown>): LiveMcpServer[] {
  const list = Array.isArray(response.mcpServers) ? response.mcpServers : [];
  const servers: LiveMcpServer[] = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) continue;
    const status = typeof raw.status === 'string' && STATUSES.has(raw.status as LiveMcpServer['status']) ? (raw.status as LiveMcpServer['status']) : 'unknown';
    const tools = Array.isArray(raw.tools)
      ? raw.tools.flatMap((tool) => {
          if (!isRecord(tool) || typeof tool.name !== 'string') return [];
          const notes = isRecord(tool.annotations) ? tool.annotations : {};
          return [{ name: tool.name, readOnly: notes.readOnly === true, destructive: notes.destructive === true }];
        })
      : [];
    const scope = typeof raw.scope === 'string' ? raw.scope : null;
    const connector = scope === CONNECTOR_SCOPE || raw.name.startsWith(CONNECTOR_PREFIX);
    servers.push({
      name: raw.name,
      label: connector && raw.name.startsWith(CONNECTOR_PREFIX) ? raw.name.slice(CONNECTOR_PREFIX.length) : raw.name,
      kind: connector ? 'connector' : 'server',
      status,
      scope,
      tools,
      error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    });
  }
  return servers;
}
