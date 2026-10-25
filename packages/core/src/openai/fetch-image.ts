import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Addresses an image URL may never reach: loopback, private and link-local ranges, the cloud
 * metadata address among them, and every special-purpose block a public image cannot live in. A
 * request that can make Claudio fetch any URL is otherwise a way to read the machine's own services
 * and its network from outside.
 */
const BLOCKED = (() => {
  const list = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(net, bits, 'ipv4');
  }
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    // NAT64 and 6to4 carry an IPv4 address inside, which may be a private one
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(net, bits, 'ipv6');
  }
  return list;
})();

/** Whether an image may be fetched from this address. IPv4-mapped IPv6 is judged by its IPv4 part. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface FetchImageOptions {
  /** The whole fetch, every redirect included */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Which addresses may be reached; tests widen it to their own loopback server */
  allowAddress?: (address: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;

class Blocked extends Error {}

/**
 * A `lookup` that resolves every address of the name and refuses the connection when any of them is
 * not allowed. Checked here, at connect time, rather than by resolving first and connecting after:
 * a name that answers a public address to the check and a private one to the connection (DNS
 * rebinding) is then caught too.
 */
function guardedLookup(allow: (address: string) => boolean): LookupFunction {
  return (hostname, options: LookupOptions, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      const first = addresses[0];
      if (!first || addresses.some((a) => !allow(a.address))) {
        return callback(Object.assign(new Blocked(`${hostname} resolves to an address Claudio does not fetch from`), { code: 'EBLOCKED' }), '', 0);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, first.address, first.family);
    });
  };
}

function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      reject(new Error(`it is ${String(declared)} bytes; the most is ${String(maxBytes)}`));
      return;
    }
    const parts: Buffer[] = [];
    let size = 0;
    res.on('data', (part: Buffer) => {
      size += part.length;
      // Stopped as soon as it is too big: a server that lies about the length cannot fill the memory
      if (size > maxBytes) {
        res.destroy();
        reject(new Error(`it is more than ${String(maxBytes)} bytes`));
        return;
      }
      parts.push(part);
    });
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', reject);
  });
}

/**
 * Fetches an image a request names by an http(s) URL, for `uploadOpenAiImages`. Refuses an address
 * that is not public (the URL's own, a name's, and every redirect's), stops reading past `maxBytes`,
 * follows at most a few redirects and gives up after a timeout. The bytes decide whether it is an
 * image, later; the type the server claims is only passed along.
 */
export async function fetchImage(url: string, maxBytes: number, options: FetchImageOptions = {}): Promise<{ bytes: Buffer; mediaType: string | null }> {
  const allow = options.allowAddress ?? isPublicAddress;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('only http and https URLs are fetched');
    if (target.username || target.password) throw new Error('a URL with credentials is not fetched');
    const host = target.hostname.replace(/^\[|\]$/g, '');
    // A literal address never goes through the lookup, so it is judged here
    if (isIP(host) !== 0 && !allow(host)) throw new Blocked(`${host} is an address Claudio does not fetch from`);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timed out');
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(target, { method: 'GET', lookup: guardedLookup(allow), agent: false, headers: { accept: 'image/*' } }, resolve);
      req.setTimeout(left, () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new Error('too many redirects');
      // Every hop is checked again: a public URL that redirects to a private one is refused there
      target = new URL(res.headers.location, target);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`the server answered ${String(status)}`);
    }
    const timer = setTimeout(() => res.destroy(new Error('timed out')), Math.max(1, deadline - Date.now()));
    try {
      const bytes = await readCapped(res, maxBytes);
      const type = res.headers['content-type'];
      return { bytes, mediaType: typeof type === 'string' ? (type.split(';')[0]?.trim() ?? null) : null };
    } finally {
      clearTimeout(timer);
    }
  }
}
