import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { git, isGitRepo } from '../git.ts';
import { parseRemote, resolveSshHost, type SshExec } from '../hosts/remote.ts';

/**
 * Hosts whose repository paths are case-insensitive, so `Acme/API` and `acme/api` are one
 * repository there. Any other host keeps the path as written: a self-hosted Gitea or Gerrit may
 * tell them apart.
 */
const CASE_INSENSITIVE_HOSTS: ReadonlySet<string> = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'dev.azure.com']);

/**
 * What an edited key may hold. Upper case is allowed because the default key of a case-sensitive
 * host keeps the path's case; anything else outside the set is folded to `-` when the default is built.
 */
const SHARE_KEY = /^[A-Za-z0-9._/#-]{3,200}$/;
const MAX_LENGTH = 200;

export function isValidShareKey(key: string): boolean {
  return SHARE_KEY.test(key);
}

/** A share key holds slashes and `#`, so routes and files use this instead: `sha256(key)` as 32 hex characters. */
export function shareIdOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

/** `upstream` first so teammates whose `origin` is their own fork still meet, then `origin`, then the only remote. */
export function preferredRemote(names: readonly string[]): string | null {
  if (names.includes('upstream')) return 'upstream';
  if (names.includes('origin')) return 'origin';
  return names.length === 1 ? (names[0] ?? null) : null;
}

export interface ShareKeyOptions {
  /** The remote the person picked in the Sharing section; ignored when the repository no longer has it */
  remote?: string | null;
  /** Runs `ssh`, for `ssh -G` on an alias; defaults to the real one */
  sshExec?: SshExec;
  /** 16 random bytes as hex, for a project without a remote; injected so tests are deterministic */
  randomHex?: () => string;
}

const realSsh: SshExec = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

const clean = (text: string): string => text.replace(/[^A-Za-z0-9._/#-]/g, '-');

/** The remotes of the repository `projectPath` is in, empty when it is not one. */
export function listRemotes(projectPath: string): string[] {
  if (!existsSync(projectPath) || !isGitRepo(projectPath)) return [];
  try {
    return git(projectPath, ['remote'], 10_000)
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `<host>/<path>` of a remote URL, or null when it names no host (a local path, `file://`). The
 * host is the real one behind an SSH alias, lower-cased; the path is lower-cased only on the hosts
 * that ignore its case.
 */
export async function remoteShareKey(url: string, sshExec: SshExec = realSsh): Promise<string | null> {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  const host = (parsed.protocol === 'ssh' ? await resolveSshHost(parsed.hostname, sshExec) : parsed.hostname).toLowerCase();
  const path = CASE_INSENSITIVE_HOSTS.has(host) ? parsed.path.toLowerCase() : parsed.path;
  return clean(`${host}/${path}`);
}

/**
 * The default share key of a project (§3.4 of the Collaborators plan): `<host>/<path>[#<subpath>]`
 * from its preferred remote, the subpath being where the project sits inside its repository, or
 * `local/<random hex>` when there is no usable remote. Computed once and stored, so the random
 * fallback does not change under the person.
 */
export async function shareKeyFor(projectPath: string, opts: ShareKeyOptions = {}): Promise<string> {
  const local = (): string => `local/${(opts.randomHex ?? (() => randomBytes(16).toString('hex')))()}`;
  const remotes = listRemotes(projectPath);
  const name = opts.remote && remotes.includes(opts.remote) ? opts.remote : preferredRemote(remotes);
  if (!name) return local();
  let base: string | null;
  let prefix: string;
  try {
    base = await remoteShareKey(git(projectPath, ['remote', 'get-url', name], 10_000), opts.sshExec ?? realSsh);
    prefix = git(projectPath, ['rev-parse', '--show-prefix'], 10_000).replace(/\/+$/, '');
  } catch {
    return local();
  }
  if (!base) return local();
  const key = prefix ? `${base}#${clean(prefix)}` : base;
  return key.slice(0, MAX_LENGTH);
}
