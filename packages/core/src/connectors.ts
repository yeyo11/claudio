import type { AccountRef } from '@claudio/accounts';
import type { Connector, ConnectorAction, ConnectorGuide, ConnectorKind, ConnectorLimit, ConnectorsOverview, LiveMcpServer } from '@claudio/shared';
import { parseMcpHealth } from './config/mcp.ts';
import { execCli } from './cli.ts';
import { childEnv } from './child-env.ts';
import type { CoreConfig } from './paths.ts';
import { probeMcpServers } from './providers/claude-code/mcp-probe.ts';

// `claude mcp list` connects to every server, so it takes seconds: an answer is reused for a minute
// unless the caller asks for a fresh one.
const HEALTH_TIMEOUT_MS = 90_000;
const TTL_MS = 60_000;
const CLAUDE_AI_PREFIX = 'claude.ai ';

/** The kinds Claudio has prepared actions for; anything else claude.ai offers is listed as `other`. */
const KNOWN_KINDS: ConnectorKind[] = ['docs', 'gmail', 'calendar'];

const ACTIONS: Record<Exclude<ConnectorKind, 'other'>, ConnectorAction[]> = {
  docs: [
    {
      id: 'docs-recent',
      label: 'Summarise my recent docs',
      prompt: 'Use the Claude Docs connector to list my most recently edited docs and summarise what each one is about in a line. Only read; do not create or change anything.',
    },
  ],
  gmail: [
    {
      id: 'gmail-unread',
      label: 'Summarise my unread email',
      prompt: 'Use the Gmail connector to look at my unread email from the last two days and group it by what needs a reply, what is informational and what can be ignored. Only read; do not send, archive or delete anything.',
    },
  ],
  calendar: [
    {
      id: 'calendar-tomorrow',
      label: "Summarise tomorrow's calendar",
      prompt: 'Use the Google Calendar connector to summarise my calendar for tomorrow: the events in order, the gaps between them and anything that overlaps. Only read; do not create, move or delete events.',
    },
    {
      id: 'calendar-week',
      label: 'Find free time this week',
      prompt: 'Use the Google Calendar connector to find the three longest free blocks of at least an hour in my working hours this week. Only read; do not create or change events.',
    },
  ],
};

export const CONNECTOR_GUIDE: ConnectorGuide = {
  steps: [
    {
      code: 'connectors.authorise.cli',
      text: 'Run `claude` in a terminal, type `/mcp`, pick the connector and choose to authenticate. The CLI opens the browser for the sign-in.',
    },
    {
      code: 'connectors.authorise.claudeAi',
      text: "Or enable and authorise it in claude.ai's connector settings; the CLI lists the connectors of the claude.ai account it is signed in with.",
    },
    {
      code: 'connectors.authorise.refresh',
      text: 'Then refresh this page: Claudio only reads the state the CLI reports and cannot authorise a connector for you.',
    },
  ],
  links: [
    { label: { code: 'connectors.link.settings', text: 'Connector settings on claude.ai' }, url: 'https://claude.ai/settings/connectors' },
    { label: { code: 'connectors.link.mcpDocs', text: 'Claude Code: connect to tools with MCP' }, url: 'https://code.claude.com/docs/en/mcp' },
  ],
};

export const CONNECTOR_LIMITS: ConnectorLimit[] = [
  {
    id: 'web-artifacts',
    name: 'Web artifacts',
    reason: {
      code: 'connectors.unavailable.webArtifacts',
      text: 'The artifacts made in claude.ai have no public API and no CLI command, so Claudio cannot list, read or create them.',
    },
  },
  {
    id: 'claude-ai-memory',
    name: 'claude.ai memory',
    reason: {
      code: 'connectors.unavailable.claudeAiMemory',
      text: "What claude.ai remembers about you has no public API and no CLI command. Claude Code's file memory is a different thing, on the Memory tab.",
    },
  },
];

export function connectorKind(name: string): ConnectorKind {
  const lower = name.toLowerCase();
  if (lower.includes('gmail')) return 'gmail';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('docs')) return 'docs';
  return 'other';
}

/**
 * The claude.ai connectors in `claude mcp list` output. Servers the person configured themselves
 * are not connectors (they have their own page under Configuration) and are left out.
 */
export function parseConnectors(output: string): Connector[] {
  const connectors: Connector[] = [];
  for (const server of parseMcpHealth(output)) {
    if (!server.name.startsWith(CLAUDE_AI_PREFIX)) continue;
    const kind = connectorKind(server.name);
    // A failure or a pending connection says nothing about the session: `unknown`, with the CLI's words
    const status = server.status === 'connected' || server.status === 'needs-auth' ? server.status : 'unknown';
    const connector: Connector = { id: server.name, name: server.name.slice(CLAUDE_AI_PREFIX.length), kind, status, detail: server.detail };
    if (status !== 'needs-auth' && kind !== 'other') connector.actions = ACTIONS[kind];
    connectors.push(connector);
  }
  return connectors;
}

/**
 * The claude.ai connectors in the CLI's `mcp_status`: the servers with the scope `claudeai`, which
 * include those still waiting for their authorisation (`claude mcp list` leaves those out).
 */
export function connectorsFromStatus(servers: LiveMcpServer[]): Connector[] {
  const connectors: Connector[] = [];
  for (const server of servers) {
    if (server.kind !== 'connector') continue;
    const kind = connectorKind(server.name);
    const status = server.status === 'connected' || server.status === 'needs-auth' ? server.status : 'unknown';
    const connector: Connector = { id: server.name, name: server.label, kind, status };
    if (server.status === 'connected') connector.toolCount = server.tools.length;
    // A failure or a connection that never settled says nothing about the session: `unknown`, in words
    if (server.status === 'failed') connector.detail = server.error ?? 'Failed to connect';
    else if (server.status === 'pending') connector.detail = 'Still connecting';
    else if (server.status === 'disabled') connector.detail = 'Disabled';
    if (status !== 'needs-auth' && kind !== 'other') connector.actions = ACTIONS[kind];
    connectors.push(connector);
  }
  return connectors;
}

export interface ConnectorsOptions {
  /** The account whose connectors are read: the default one, as `claude mcp list` always did */
  account?: () => AccountRef;
  probeCeilingMs?: number;
  probePollMs?: number;
}

export class Connectors {
  private cache: ConnectorsOverview | null = null;

  constructor(
    private readonly config: CoreConfig,
    private readonly opts: ConnectorsOptions = {},
  ) {}

  /** The structured source: a short-lived CLI process answering `mcp_status`. Null when it could not. */
  private async probe(): Promise<Connector[] | null> {
    try {
      const servers = await probeMcpServers({
        bin: this.config.claudeBin,
        env: childEnv('claude-code', process.env, this.opts.account?.() ?? null),
        ...(this.opts.probeCeilingMs !== undefined ? { ceilingMs: this.opts.probeCeilingMs } : {}),
        ...(this.opts.probePollMs !== undefined ? { pollMs: this.opts.probePollMs } : {}),
      });
      return connectorsFromStatus(servers);
    } catch {
      return null;
    }
  }

  async overview(refresh = false): Promise<ConnectorsOverview> {
    if (!refresh && this.cache && Date.now() - Date.parse(this.cache.checkedAt) < TTL_MS) return this.cache;
    const probed = await this.probe();
    // The scrape stays as the fallback until the CLI ships `mcp list --json`
    const res = probed ? { stdout: '', stderr: '', code: 0 } : await execCli(this.config, ['mcp', 'list'], { timeoutMs: HEALTH_TIMEOUT_MS });
    const connectors = probed ?? parseConnectors(res.stdout);
    const listed = new Set(connectors.map((c) => c.kind));
    const overview: ConnectorsOverview = {
      connectors,
      notListed: KNOWN_KINDS.filter((kind) => !listed.has(kind)),
      authorisation: CONNECTOR_GUIDE,
      unavailable: CONNECTOR_LIMITS,
      checkedAt: new Date().toISOString(),
    };
    if (res.code !== 0) {
      // Not cached: the next call should try again rather than repeat a failure for a minute
      overview.error = (res.stderr || res.stdout).trim().slice(0, 500) || 'claude mcp list failed';
      return overview;
    }
    this.cache = overview;
    return overview;
  }
}
