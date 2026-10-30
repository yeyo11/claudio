import { ApiError, type ApiClient } from './client.ts';
import { COLLAB_TOOLS } from './collab-tools.ts';
import type { ClaudioMcpToolset } from './names.ts';
import { DEFAULT_HINT, render } from './render.ts';
import { validate } from './schema.ts';
import { TOOLS, type Tool } from './tools.ts';
import { TextResult } from './untrusted.ts';
import { WRITE_TOOLS } from './write-tools.ts';

/** Newest first: the version the client asked for is used when it is in this list */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface Request {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

export interface Server {
  /** One line of the protocol in, the reply line out; undefined for a notification */
  handleLine(line: string): Promise<string | undefined>;
}

const reply = (id: Request['id'], result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Request['id'], code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * The answer to a line whose handling threw: JSON-RPC's internal error, with the request's id when
 * the line had one, and nothing for a notification, which gets no answer.
 */
export function internalError(line: string): string | undefined {
  let id: Request['id'] = null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      const raw = (parsed as { id: unknown }).id;
      if (raw === undefined) return undefined;
      id = typeof raw === 'string' || typeof raw === 'number' ? raw : null;
    } else if (parsed && typeof parsed === 'object') return undefined;
  } catch {
    // not JSON: answered with a null id
  }
  return fail(id, -32603, 'internal error');
}

/** The tools a process offers for its toolsets, in the order of the catalogue */
export function toolsFor(toolsets: readonly ClaudioMcpToolset[]): Tool[] {
  return [...(toolsets.includes('claudio') ? [...TOOLS, ...WRITE_TOOLS] : []), ...(toolsets.includes('collab') ? COLLAB_TOOLS : [])];
}

export function createServer(options: { api: ApiClient; version: string; tools?: readonly Tool[] }): Server {
  const tools = options.tools ?? [...TOOLS, ...WRITE_TOOLS];
  const byName = new Map(tools.map((tool) => [tool.name as string, tool]));

  async function call(params: unknown): Promise<unknown> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    const outcome = (message: string, isError: boolean) => ({ content: [{ type: 'text', text: message }], isError });
    if (!tool) return outcome(`unknown tool: ${String(name)}`, true);
    const problem = validate(tool.inputSchema, args);
    if (problem) return outcome(`invalid arguments for ${tool.name}: ${problem}`, true);
    try {
      const result = await tool.run((args ?? {}) as Record<string, unknown>, options.api);
      // A teammate's content comes already fenced and cut to size: cutting it here could lose the closing fence
      return outcome(result instanceof TextResult ? result.text : render(result, undefined, tool.paging ?? DEFAULT_HINT), false);
    } catch (err) {
      if (err instanceof ApiError) return outcome(`${tool.name} failed: ${err.message}`, true);
      return outcome(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  async function handleLine(line: string): Promise<string | undefined> {
    if (!line.trim()) return undefined;
    let message: Request;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(null, -32600, 'a request is a JSON object');
      message = parsed as Request;
    } catch {
      return fail(null, -32700, 'parse error');
    }
    const { id, method } = message;
    // A notification has no id and gets no answer
    if (id === undefined) return undefined;
    switch (method) {
      case 'initialize': {
        const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
        return reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'claudio', version: options.version } });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call':
        return reply(id, await call(message.params));
      default:
        return fail(id, -32601, `method not found: ${String(method)}`);
    }
  }

  return { handleLine };
}
