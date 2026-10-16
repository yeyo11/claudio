import {
  MCP_SHARE_WARN,
  MCP_TOOLS_WARN,
  type ContextBreakdown,
  type ContextCategory,
  type ContextCategoryKey,
  type ContextCategoryKind,
  type ContextMcpServerWeight,
  type ContextMcpWarning,
  type ContextUnreported,
} from '@claudio/shared';

/** The names Claude Code 2.1.300 gave its rows (recordings/c0-NOTES.md, F3); any other name stays unkeyed */
const KEYS: Record<string, ContextCategoryKey> = {
  'System prompt': 'system-prompt',
  'System tools': 'system-tools',
  'System tools (deferred)': 'system-tools-deferred',
  'MCP tools': 'mcp-tools',
  'MCP tools (deferred)': 'mcp-tools-deferred',
  'Custom agents': 'custom-agents',
  'Memory files': 'memory-files',
  Skills: 'skills',
  Messages: 'messages',
  'Free space': 'free-space',
  'Autocompact buffer': 'autocompact-buffer',
};

const KINDS = new Set<string>(['used', 'free', 'buffer', 'deferred'] satisfies ContextCategoryKind[]);

// A value of the wrong type is read as absent, never thrown: the answer is the CLI's, and it changes
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.flatMap((x) => { const r = record(x); return r ? [r] : []; }) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * What a `get_context_usage` answer says, as the breakdown the panel draws. Math uses each row's
 * `kind`, never its English name (the CLI's own rule). MCP tools are counted per server: a deferred
 * tool (`isLoaded: false`) is a tool but costs nothing until it is loaded, so it is left out of the
 * server's tokens, of the share and of the warning.
 */
export function parseContextUsage(raw: Record<string, unknown>): ContextBreakdown {
  const categories: ContextCategory[] = [];
  for (const row of list(raw.categories)) {
    const name = text(row.name);
    const kind = text(row.kind);
    const tokens = num(row.tokens);
    // The CLI's own renderer leaves out a row with nothing in it
    if (name === null || kind === null || !KINDS.has(kind) || !tokens || tokens <= 0) continue;
    categories.push({ name, key: KEYS[name] ?? null, kind: kind as ContextCategoryKind, tokens });
  }

  const totalTokens = num(raw.totalTokens) ?? 0;
  const maxTokens = num(raw.maxTokens) ?? 0;
  const rawMaxTokens = num(raw.rawMaxTokens) ?? maxTokens;

  const byServer = new Map<string, ContextMcpServerWeight>();
  for (const tool of list(raw.mcpTools)) {
    const server = text(tool.serverName);
    if (!server) continue;
    const weight = byServer.get(server) ?? { server, tools: 0, loadedTools: 0, tokens: 0 };
    weight.tools += 1;
    if (tool.isLoaded !== false) {
      weight.loadedTools += 1;
      weight.tokens += num(tool.tokens) ?? 0;
    }
    byServer.set(server, weight);
  }
  const servers = [...byServer.values()].sort((a, b) => b.tokens - a.tokens || a.server.localeCompare(b.server));
  const mcpTokens = servers.reduce((sum, s) => sum + s.tokens, 0);
  const mcpLoaded = servers.reduce((sum, s) => sum + s.loadedTools, 0);
  const window = rawMaxTokens || maxTokens;
  const share = window > 0 ? mcpTokens / window : 0;
  const warnings: ContextMcpWarning[] = [];
  if (mcpLoaded > MCP_TOOLS_WARN) warnings.push('many-tools');
  if (share >= MCP_SHARE_WARN) warnings.push('large-share');

  const skills = record(raw.skills);
  const commands = record(raw.slashCommands);
  const messages = record(raw.messageBreakdown);

  return {
    model: text(raw.model) ?? '',
    totalTokens,
    rawMaxTokens,
    maxTokens,
    percentage: num(raw.percentage) ?? 0,
    autoCompact: { enabled: raw.isAutoCompactEnabled === true, thresholdTokens: num(raw.autoCompactThreshold) },
    overBy: rawMaxTokens > 0 && totalTokens > rawMaxTokens ? totalTokens - rawMaxTokens : null,
    categories,
    mcp: { servers, loadedTools: mcpLoaded, tokens: mcpTokens, share, warnings },
    memoryFiles: list(raw.memoryFiles).map((f) => ({ path: text(f.path) ?? '', type: text(f.type) ?? '', tokens: num(f.tokens) ?? 0 })),
    agents: list(raw.agents).map((a) => ({ name: text(a.agentType) ?? '', source: text(a.source) ?? '', tokens: num(a.tokens) ?? 0 })),
    skills: skills ? { total: num(skills.totalSkills) ?? 0, included: num(skills.includedSkills) ?? 0, tokens: num(skills.tokens) ?? 0 } : null,
    slashCommands: commands ? { total: num(commands.totalCommands) ?? 0, included: num(commands.includedCommands) ?? 0, tokens: num(commands.tokens) ?? 0 } : null,
    messages: messages
      ? {
          toolCalls: num(messages.toolCallTokens) ?? 0,
          toolResults: num(messages.toolResultTokens) ?? 0,
          attachments: num(messages.attachmentTokens) ?? 0,
          assistant: num(messages.assistantMessageTokens) ?? 0,
          user: num(messages.userMessageTokens) ?? 0,
          other: (num(messages.redirectedContextTokens) ?? 0) + (num(messages.unattributedTokens) ?? 0),
        }
      : null,
  };
}

/**
 * Why a `get_context_usage` request failed, from the control channel's error: a CLI that does not
 * know the request says so in the words it answers any unknown subtype with (recorded, F4), and the
 * channel's own timeout names the request that went unanswered. Anything else is a refusal.
 */
export function unreportedOf(error: unknown): Extract<ContextUnreported, 'unsupported' | 'timeout' | 'refused'> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Unsupported control request subtype')) return 'unsupported';
  if (/did not answer .* in time$/.test(message)) return 'timeout';
  return 'refused';
}
