import { execFile } from 'node:child_process';
import { isRecord } from './fs.ts';
import { envFor, type AccountRef } from './env.ts';

export interface Identity {
  signedIn: boolean;
  email: string | null;
  organization: string | null;
  plan: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseAuthStatus(out: string): Identity {
  const doc: unknown = JSON.parse(out);
  if (!isRecord(doc)) throw new Error('claude auth status did not print an object');
  return { signedIn: doc.loggedIn === true, email: str(doc.email), organization: str(doc.orgName), plan: str(doc.subscriptionType) };
}

/** Through `claude auth status --json` in the account's own environment; no file of the account is read. */
export function identify(account: AccountRef, opts: { claude?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Identity> {
  return new Promise((resolve, reject) => {
    execFile(
      opts.claude ?? 'claude',
      ['auth', 'status', '--json'],
      { env: envFor(account, opts.env), timeout: opts.timeoutMs ?? 20_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        // A signed-out CLI exits non-zero but still prints the JSON
        if (stdout.trim()) {
          try {
            resolve(parseAuthStatus(stdout));
          } catch (e) {
            reject(e);
          }
          return;
        }
        reject(err ?? new Error('claude auth status printed nothing'));
      },
    );
  });
}
