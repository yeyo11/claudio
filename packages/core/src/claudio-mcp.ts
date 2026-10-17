import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLAUDIO_MCP_COLLAB_TOOLS, CLAUDIO_MCP_READ_TOOLS, CLAUDIO_MCP_SERVER, CLAUDIO_MCP_TOOLSETS_ENV, type ClaudioMcpToolset } from '@claudio/mcp';
import type { ChatToolConfig, McpSelection, PermissionMode } from '@claudio/shared';
import { writeMcpConfigSync } from './chat-tools.ts';
import type { ChatConfinement } from './live-chat.ts';

/** The absolute path of the bundled `mcp.mjs`. The API bundle and the desktop app set it; from source it is unset. */
export const MCP_ENTRY_ENV = 'CLAUDIO_MCP_ENTRY';

/** What a caller spreads into the options of a chat to hand it Claudio's own MCP server and nothing else. */
export interface ClaudioMcpLaunch {
  /** `--mcp-config` (with `--strict-mcp-config`): a file holding only the `claudio` server */
  mcp: McpSelection & { config: string };
  /** `--allowedTools`: the read tools, by the names the CLI gives them */
  allowedTools: string[];
  /** `--tools=` and `--setting-sources=`, both empty: no built-in tool, no settings file */
  confine: ChatConfinement;
  /** Whatever is not allowed is denied, not prompted */
  permissionMode: PermissionMode;
}

export interface ClaudioMcpOptions {
  dataDir: string;
  /** `CLAUDIO_API_URL` of the wrapper that runs the chat; null while the API is not listening */
  apiUrl: string | null;
  /** The version the server reports, so a client can tell which Claudio it talks to */
  version: string;
  env?: NodeJS.ProcessEnv;
  /** The binary that runs the server: Node, or the Electron binary acting as Node */
  execPath?: string;
  /**
   * What the server offers: `claudio` (the assistant's reads and writes, the default) and `collab`
   * (the reads of teammates' copies), each only where the chat's scope allows it
   */
  toolsets?: readonly ClaudioMcpToolset[];
}

/**
 * How the CLI starts the server, in each of the three runtimes: the bundled file when the runtime
 * handed one over (`CLAUDIO_MCP_ENTRY`: the API bundle and the desktop app), else the source file
 * through `tsx`. Throws rather than return a command the CLI could not start.
 */
export function mcpCommand(env: NodeJS.ProcessEnv, execPath: string): { command: string; args: string[] } {
  const bundled = env[MCP_ENTRY_ENV];
  if (bundled) {
    if (!existsSync(bundled)) throw new Error(`Claudio's MCP server is not at ${bundled} (${MCP_ENTRY_ENV})`);
    return { command: execPath, args: [bundled] };
  }
  const source = fileURLToPath(new URL('../../mcp/src/main.ts', import.meta.url));
  if (existsSync(source)) {
    try {
      // tsx is the mcp package's own dev dependency: resolved from the file it runs, not from the chat's directory
      const tsx = join(dirname(createRequire(source).resolve('tsx/package.json')), 'dist', 'loader.mjs');
      return { command: execPath, args: ['--import', pathToFileURL(tsx).href, source] };
    } catch {
      // falls through to the error below
    }
  }
  throw new Error(`Claudio's MCP server cannot be started: ${MCP_ENTRY_ENV} is not set and the source is not runnable here`);
}

/**
 * Writes the config file of Claudio's own MCP server and the flags that confine a chat to its read
 * tools. The CLI starts the server; this never talks to it.
 *
 * The file is the same for every chat. It holds the URL, which is the bound address of this wrapper,
 * and refers to the chat's id and token by `${NAME}`, which the CLI expands from the environment of
 * the process it starts: both are only known once the process spawns (the token is minted per
 * process), and referring to them keeps the secret out of the file. Checked against the real CLI:
 * it expands them, and passes the rest of its environment through as well.
 */
export async function claudioMcp(opts: ClaudioMcpOptions): Promise<ClaudioMcpLaunch> {
  return claudioMcpSync(opts);
}

/** `claudioMcp` for a caller that cannot wait: a process about to spawn. */
export function claudioMcpSync(opts: ClaudioMcpOptions): ClaudioMcpLaunch {
  const toolsets = opts.toolsets ?? ['claudio'];
  const config = writeMcpConfigSync(opts.dataDir, { [CLAUDIO_MCP_SERVER]: serverEntry(opts, toolsets) });
  return {
    mcp: { servers: [CLAUDIO_MCP_SERVER], config },
    allowedTools: allowedFor(toolsets),
    confine: { tools: [], settingSources: [] },
    permissionMode: 'dontAsk',
  };
}

/** The `claudio` entry of a config file: how the CLI starts the server, and with what */
function serverEntry(opts: ClaudioMcpOptions, toolsets: readonly ClaudioMcpToolset[]): Record<string, unknown> {
  if (!opts.apiUrl) throw new Error("Claudio's MCP server needs the API's address, and the API is not listening yet");
  const env = opts.env ?? process.env;
  const { command, args } = mcpCommand(env, opts.execPath ?? process.execPath);
  return {
    command,
    args,
    env: {
      CLAUDIO_API_URL: opts.apiUrl,
      CLAUDIO_CHAT_ID: '${CLAUDIO_CHAT_ID}',
      CLAUDIO_API_TOKEN: '${CLAUDIO_API_TOKEN}',
      CLAUDIO_VERSION: opts.version,
      // Named only when it is not the default, so the assistant's file stays the one it always was
      ...(toolsets.length === 1 && toolsets[0] === 'claudio' ? {} : { [CLAUDIO_MCP_TOOLSETS_ENV]: toolsets.join(',') }),
      // The desktop's Electron binary runs the bundle as Node only with this
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}

/** The tools allowed ahead of time: every read, never a write, which the person confirms one by one */
function allowedFor(toolsets: readonly ClaudioMcpToolset[]): string[] {
  return [...(toolsets.includes('claudio') ? CLAUDIO_MCP_READ_TOOLS : []), ...(toolsets.includes('collab') ? CLAUDIO_MCP_COLLAB_TOOLS : [])];
}

/** What a chat that is not the assistant gets to read its teammates' copies with */
export interface CollabMcpLaunch {
  /** The file for `--mcp-config` */
  mcpConfig: string;
  /**
   * The file adds to the servers the CLI loads on its own (no `--strict-mcp-config`): the chat chose
   * none. When it chose some, the file is theirs and the server together, and stays strict.
   */
  adds: boolean;
  /** The collab read tools, allowed ahead of time on top of the chat's own list */
  allowedTools: string[];
}

/**
 * Claudio's MCP server with only the reads of teammates' copies, for a chat of a project that opted
 * in (docs/plans/collaborators-agent-access.md). The caller decided the chat's scope allows it; the
 * API decides again at every call. `chosen` is the config file of the servers the chat picked, if
 * any: one `--mcp-config` file is all the CLI is ever given, so the server joins that file.
 */
export function collabMcpSync(opts: ClaudioMcpOptions, chosen: string | null): CollabMcpLaunch {
  const entry = serverEntry(opts, ['collab']);
  let servers: Record<string, Record<string, unknown>> = {};
  if (chosen) {
    const parsed: unknown = JSON.parse(readFileSync(chosen, 'utf8'));
    const listed = parsed && typeof parsed === 'object' && 'mcpServers' in parsed ? parsed.mcpServers : null;
    if (!listed || typeof listed !== 'object' || Array.isArray(listed)) throw new Error(`the chat's MCP config ${chosen} lists no servers`);
    servers = { ...(listed as Record<string, Record<string, unknown>>) };
  }
  // Ours under its own name, over any server of the person's that took it: the tools' names say `claudio`
  servers[CLAUDIO_MCP_SERVER] = entry;
  return { mcpConfig: writeMcpConfigSync(opts.dataDir, servers), adds: chosen === null, allowedTools: [...CLAUDIO_MCP_COLLAB_TOOLS] };
}

/**
 * What a Claudio assistant chat runs with, whoever asked for what. This is the one place its argv
 * is decided: the core applies it again at every process of the chat (start, resume, fork, a turn
 * after a restart), over whatever the request or the stored record held. The write tools extend
 * this function, and nothing else.
 */
export interface AssistantChatOptions {
  appendSystemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  toolConfig: ChatToolConfig;
  mcp: ClaudioMcpLaunch['mcp'];
  confine: ChatConfinement;
  permissionMode: PermissionMode;
  permissionPrompts: 'none' | 'host';
  /** No uploads directory: the chat reads nothing the person attached to other chats */
  uploads: false;
  keepAlive: true;
}

export function assistantChatOptions(launch: ClaudioMcpLaunch, guide: string): AssistantChatOptions {
  return {
    appendSystemPrompt: guide,
    allowedTools: launch.allowedTools,
    disallowedTools: [],
    toolConfig: { preset: null, allowedTools: launch.allowedTools, disallowedTools: [], mcp: launch.mcp },
    mcp: launch.mcp,
    confine: launch.confine,
    // `manual` (the CLI's default), never acceptEdits, auto or bypassPermissions: the read tools are allowed ahead of time and no write tool
    // is, so the CLI asks the person (a host prompt) before it runs one. Under dontAsk a write would be denied outright
    permissionMode: 'manual',
    permissionPrompts: 'host',
    uploads: false,
    keepAlive: true,
  };
}
