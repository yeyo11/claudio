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

/**
 * The MCP servers a fresh CLI process reports, read from `mcp_status` and nothing else: no prompt is
 * sent, so no turn runs and nothing is billed. The process lives only as long as the answer takes,
 * polling while a server still reads `pending`; one still pending at the ceiling is returned as it is.
 * Rejects when the CLI cannot be started, exits early or does not answer.
 */
export async function probeMcpServers(opts: McpProbeOptions): Promise<LiveMcpServer[]> {
  const ceilingMs = opts.ceilingMs ?? CEILING_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
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
      reject(new Error(stderr.trim().slice(0, 300) || `the CLI exited (${String(code)}) before answering mcp_status`));
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
  const deadline = Date.now() + ceilingMs;
  try {
    for (;;) {
      const servers = liveMcpServers(await Promise.race([control.request({ subtype: 'mcp_status' }), gone]));
      if (!servers.some((s) => s.status === 'pending') || Date.now() + pollMs > deadline) return servers;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    exited = true;
    proc.kill('SIGKILL');
  }
}
