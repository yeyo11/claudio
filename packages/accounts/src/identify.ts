import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/** The file `claude auth login` writes the OAuth tokens to. */
export const CREDENTIALS_FILE = '.credentials.json';

export interface CredentialsReading {
  /** Epoch ms the file was last written; a new sign-in moves it */
  mtimeMs: number;
  /** False only when the file holds an OAuth block with no non-empty `refreshToken` */
  complete: boolean;
}

const readings = new Map<string, CredentialsReading>();

/**
 * What the credentials file of a `login` account says about its sign-in, with nothing else kept: the
 * file is parsed only to learn whether `claudeAiOauth.refreshToken` is a non-empty string, and no
 * value of it leaves this function (it is neither returned, nor stored, nor in an error message).
 * Null when there is no file to judge by (a keychain, a signed-out dir) or it is not an OAuth one.
 * The answer is kept per file time, so the file is read again only after it changed.
 */
export function readCredentials(dir: string): CredentialsReading | null {
  const file = join(dir, CREDENTIALS_FILE);
  try {
    const { mtimeMs } = statSync(file);
    const known = readings.get(file);
    if (known && known.mtimeMs === mtimeMs) return known;
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const oauth = isRecord(doc) ? doc.claudeAiOauth : undefined;
    if (!isRecord(oauth)) return null;
    const reading = { mtimeMs, complete: typeof oauth.refreshToken === 'string' && oauth.refreshToken !== '' };
    readings.set(file, reading);
    return reading;
  } catch {
    return null;
  }
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
