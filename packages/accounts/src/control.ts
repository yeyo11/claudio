import { spawn } from 'node:child_process';
import { envFor, type AccountRef } from './env.ts';
import { isRecord } from './fs.ts';

export interface ControlOptions {
  claude?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Sends the CLI one stream-json control request (`initialize`, `get_usage`) in the account's own
 * environment and returns the `response` of the answer: no prompt, no turn, no tokens. This is the
 * protocol the CLI documents for programs; the process is ended as soon as it has answered, or when
 * the timeout passes.
 */
export function controlRequest(account: AccountRef, subtype: string, opts: ControlOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.claude ?? 'claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      env: envFor(account, opts.env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const requestId = `claudio-${subtype}`;
    let buffer = '';
    let settled = false;
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`the CLI did not answer ${subtype} in time`)), opts.timeoutMs ?? 20_000);
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(new Error(`the CLI ended without answering ${subtype}`)));
    child.stdin.on('error', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(msg) || msg.type !== 'control_response' || !isRecord(msg.response) || msg.response.request_id !== requestId) continue;
        if (msg.response.subtype === 'error') return finish(new Error(typeof msg.response.error === 'string' && msg.response.error ? msg.response.error : `the CLI refused ${subtype}`));
        return finish(null, msg.response.response);
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype } })}\n`);
  });
}
