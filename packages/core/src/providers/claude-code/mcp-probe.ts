import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { LiveMcpServer } from '@claudio/shared';
import { ControlChannel } from './control.ts';
import { liveMcpServers } from './mcp.ts';

/** Servers load after the process starts: about ten seconds on CLI 2.1.300, so the ceiling leaves room */
const CEILING_MS = 20_000;
const POLL_MS = 1_000;

export interface McpProbeOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  ceilingMs?: number;
  pollMs?: number;
}

/** What `mcp_authenticate` answers for a claude.ai connector: a claude.ai page that runs the whole sign-in */
export interface McpAuthStart {
  authUrl: string;
  requiresUserAction: boolean;
  callbackExpected: boolean;
}

type Request = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * A short-lived `claude -p` stream-json process that only answers control requests: no prompt is
 * sent, so no turn runs and nothing is billed. It is killed when `run` settles.
 */
async function withProbeProcess<T>(opts: McpProbeOptions, run: (request: Request) => Promise<T>): Promise<T> {
  // The flags of a chat's process, minus everything that is about a conversation
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const proc = spawn(opts.bin, args, { cwd: tmpdir(), env: opts.env, stdio: 'pipe' });
  let exited = false;
  let stderr = '';
  const control = new ControlChannel({ write: (text) => proc.stdin.write(text), end: () => proc.stdin.end(), up: () => !exited });
  const gone = new Promise<never>((_, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code) => {
      exited = true;
      reject(new Error(stderr.trim().slice(0, 300) || `the CLI exited (${String(code)}) before answering`));
    });
  });
  // The race below is its only reader: a probe that finished first must not leave it unhandled
  gone.catch(() => undefined);
  proc.stdin.on('error', () => undefined);
  proc.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 2_000) stderr += chunk.toString();
  });
  createInterface({ input: proc.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === 'control_response' && message.response && typeof message.response === 'object') control.settle(message.response as Record<string, unknown>);
    } catch {
      // not JSON: nothing to answer
    }
  });
  try {
    return await run((request) => Promise.race([control.request(request), gone]));
  } finally {
    exited = true;
    proc.kill('SIGKILL');
  }
}

/** Polls `mcp_status` while a server reads `pending`; one still pending at the ceiling is returned as it is. */
async function settledServers(opts: McpProbeOptions, request: Request): Promise<LiveMcpServer[]> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const deadline = Date.now() + (opts.ceilingMs ?? CEILING_MS);
  for (;;) {
    const servers = liveMcpServers(await request({ subtype: 'mcp_status' }));
    if (!servers.some((s) => s.status === 'pending') || Date.now() + pollMs > deadline) return servers;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * The MCP servers a fresh CLI process reports, read from `mcp_status` and nothing else.
 * Rejects when the CLI cannot be started, exits early or does not answer.
 */
export function probeMcpServers(opts: McpProbeOptions): Promise<LiveMcpServer[]> {
  return withProbeProcess(opts, (request) => settledServers(opts, request));
}

/**
 * Starts a connector's sign-in with the CLI's `mcp_authenticate`. Servers load after the process
 * starts, so it waits for them to settle first. The link is for the person's browser: it is returned,
 * never fetched. Rejects when the CLI refuses (an unknown server) or does not answer.
 */
export function startMcpAuth(opts: McpProbeOptions, serverName: string): Promise<McpAuthStart> {
  return withProbeProcess(opts, async (request) => {
    await settledServers(opts, request);
    const answer = await request({ subtype: 'mcp_authenticate', serverName });
    if (typeof answer.authUrl !== 'string' || !answer.authUrl) throw new Error('the CLI gave no sign-in link for this connector');
    return { authUrl: answer.authUrl, requiresUserAction: answer.requiresUserAction !== false, callbackExpected: answer.callbackExpected === true };
  });
}
