import { spawn } from 'node:child_process';
import { envFor, type AccountRef } from './env.ts';

export interface LoginSession {
  /** The authorize URL once the CLI has printed it; null when it ended without one */
  url: Promise<string | null>;
  /** Hands the code the person pasted to the CLI, when its browser could not open */
  submitCode(code: string): void;
  cancel(): void;
  /** Resolves with the CLI's exit code; 0 is a signed-in account */
  done: Promise<number>;
}

const URL_RE = /https?:\/\/\S+/;

/**
 * `claude auth login` in the account's dir. The OAuth is the CLI's own: this only relays what it
 * prints (a URL to open) and what it waits for (a code to paste). The CLI writes the credentials
 * into the account's dir; nothing here reads them.
 */
export function login(account: AccountRef, opts: { claude?: string; env?: NodeJS.ProcessEnv; email?: string } = {}): LoginSession {
  const args = ['auth', 'login', ...(opts.email ? ['--email', opts.email] : [])];
  const child = spawn(opts.claude ?? 'claude', args, { env: envFor(account, opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
  let resolveUrl: (u: string | null) => void = () => {};
  const url = new Promise<string | null>((r) => (resolveUrl = r));
  const onData = (chunk: Buffer): void => {
    const m = URL_RE.exec(chunk.toString('utf8'));
    if (m) resolveUrl(m[0]);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // A closed stdin (the CLI ended) must not crash the writer
  child.stdin.on('error', () => {});
  const done = new Promise<number>((resolve) => {
    child.on('error', () => {
      resolveUrl(null);
      resolve(1);
    });
    child.on('close', (code) => {
      resolveUrl(null);
      resolve(code ?? 1);
    });
  });
  return {
    url,
    submitCode: (code) => void child.stdin.write(`${code.trim()}\n`),
    cancel: () => void child.kill('SIGTERM'),
    done,
  };
}
