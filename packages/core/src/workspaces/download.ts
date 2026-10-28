import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { guardedLookup, isPublicAddress } from '../openai/fetch-image.ts';
import { refuse } from './refusal.ts';

export interface DownloadOptions {
  hosts: readonly string[];
  maxBytes: number;
  maxRedirects?: number;
  signal: AbortSignal;
  /** Which addresses may be reached; tests widen it to their own loopback server */
  allowAddress?: (address: string) => boolean;
  /** `https:` only; tests add `http:` for a server without a certificate */
  protocols?: readonly string[];
}

const MAX_REDIRECTS = 3;

/** The host a URL names, for messages and the row: the only part of the URL that ever leaves here */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Opens the archive a `{ url }` source names and answers its body as a stream. The URL carries the
 * code host's short-lived token, so nothing here puts it in an error: every refusal names the host
 * alone, and a failure of the network is reworded rather than passed on. The host of the URL and of
 * every redirect must be on the allowlist, and every address it resolves to public, checked at
 * connect time by the lookup of `fetch-image.ts`, so a name rebound to a private address is caught.
 */
export async function openDownload(url: string, opts: DownloadOptions): Promise<{ body: IncomingMessage; host: string }> {
  const allow = opts.allowAddress ?? isPublicAddress;
  const protocols = opts.protocols ?? ['https:'];
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw Object.assign(new Error('url is not a valid URL'), { statusCode: 400 });
  }
  const first = hostOf(target);
  for (let hop = 0; ; hop++) {
    const host = hostOf(target);
    if (!protocols.includes(target.protocol)) {
      throw hop === 0 ? Object.assign(new Error('only https URLs are downloaded'), { statusCode: 400 }) : refuse('workspace-download-failed', `${first} redirected to a URL that is not https`);
    }
    if (target.username || target.password) throw Object.assign(new Error('a URL with credentials in it is not downloaded'), { statusCode: 400 });
    if (!opts.hosts.includes(host)) throw refuse('workspace-host-not-allowed', `${host} is not in CLAUDIO_WORKSPACE_HOSTS`);
    // A literal address never goes through the lookup, so it is judged here
    if (isIP(host) !== 0 && !allow(host)) throw refuse('workspace-address-blocked', `${host} is an address Claudio does not download from`);
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        target,
        { method: 'GET', lookup: guardedLookup(allow), agent: false, signal: opts.signal, headers: { accept: 'application/gzip, application/x-gzip, application/octet-stream', 'user-agent': 'claudio-workspaces' } },
        resolve,
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (opts.signal.aborted) return reject(opts.signal.reason instanceof Error ? opts.signal.reason : err);
        if (err.code === 'EBLOCKED') return reject(refuse('workspace-address-blocked', `${host} resolves to an address Claudio does not download from`));
        reject(refuse('workspace-download-failed', `${host} could not be reached`));
      });
      req.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw refuse('workspace-download-failed', `${first} redirected more than ${String(maxRedirects)} times`);
      try {
        // Every hop is judged again: a redirect to a host off the list, or to a private address, is refused there
        target = new URL(res.headers.location, target);
      } catch {
        throw refuse('workspace-download-failed', `${host} redirected to something that is not a URL`);
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw refuse('workspace-download-failed', `${host} answered ${String(status)}`);
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      res.destroy();
      throw refuse('workspace-too-large', `the archive is larger than ${String(Math.floor(opts.maxBytes / (1024 * 1024)))} MB compressed`);
    }
    return { body: res, host: first };
  }
}
