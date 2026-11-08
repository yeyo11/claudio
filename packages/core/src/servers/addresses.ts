import { BlockList, isIP } from 'node:net';
import { isRecord, type ServerAddress, type ServerAddressKind } from '@claudio/shared';
import { ServersError } from './errors.ts';

/** A server is reached on its LAN, its tailnet and a tunnel at most; eight leaves room without inviting a scan list */
export const MAX_ADDRESSES = 8;

const KINDS: ReadonlySet<string> = new Set<ServerAddressKind>(['lan', 'tailscale', 'tunnel', 'other']);

/**
 * What the hub never dials, whoever recorded it (R2): nothing on these is a Claudio, and a hub that
 * dialled them would hand its server token, or the person's requests, to the machine's own network
 * plumbing. The private ranges stay open on purpose: the LAN is where remotes live.
 */
const REFUSED = new BlockList();
/**
 * The IPv4 ranges, each also refused in its IPv4-mapped form (`::ffff:a.b.c.d`), which a dual-stack
 * socket dials as the IPv4 address. `BlockList` happens to match mapped addresses against IPv4 rules
 * today; the explicit entries keep the refusal from resting on that.
 */
const REFUSED_V4: ReadonlyArray<readonly [string, number]> = [
  // "This network", which some stacks read as this machine
  ['0.0.0.0', 8],
  // Link-local, where every cloud keeps its instance metadata (169.254.169.254)
  ['169.254.0.0', 16],
  // Multicast, the reserved block and broadcast
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  // The metadata services that do not live in link-local: Alibaba, Azure's host agent
  ['100.100.100.200', 32],
  ['168.63.129.16', 32],
];
for (const [net, prefix] of REFUSED_V4) {
  REFUSED.addSubnet(net, prefix, 'ipv4');
  REFUSED.addSubnet(`::ffff:${net}`, 96 + prefix, 'ipv6');
}
// The unspecified address, which some stacks read as this machine
REFUSED.addAddress('::', 'ipv6');
REFUSED.addSubnet('fe80::', 10, 'ipv6');
REFUSED.addSubnet('ff00::', 8, 'ipv6');
// AWS's metadata service over IPv6
REFUSED.addAddress('fd00:ec2::254', 'ipv6');
// The same ranges reached through NAT64's well-known prefix
REFUSED.addSubnet('64:ff9b::a9fe:0', 112, 'ipv6');
REFUSED.addSubnet('64:ff9b::7f00:0', 104, 'ipv6');
// Addresses that carry an IPv4 one to reach it through a relay or a tunnel, whose far end is
// whatever IPv4 address is written inside: 6to4 and Teredo. No Claudio a person pairs lives there
REFUSED.addSubnet('2002::', 16, 'ipv6');
REFUSED.addSubnet('2001::', 32, 'ipv6');

/**
 * IPv4-compatible addresses (`::a.b.c.d`), deprecated since 2006 and dialled by some stacks as the
 * IPv4 address inside, so every range above could be reached through them. `::1` is in the block
 * too, and stays under the loopback rule.
 */
const COMPATIBLE = new BlockList();
COMPATIBLE.addSubnet('::', 96, 'ipv6');

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** `[::1]` as `URL.hostname` spells it, without the brackets the socket APIs do not take */
export const bareHost = (hostname: string): string => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);

const familyOf = (ip: string): 'ipv4' | 'ipv6' | null => {
  const family = isIP(ip);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
};

/**
 * Whether an address was recorded as loopback: `localhost` or a loopback literal. Only such an
 * address may reach this machine, so a name that resolves to 127.0.0.1 later (a rebinding) is
 * refused like any other. `BlockList` reads an IPv4-mapped IPv6 address as the IPv4 one.
 */
export function isLoopbackName(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase();
  if (host === 'localhost') return true;
  const family = familyOf(host);
  return family !== null && LOOPBACK.check(host, family);
}

/** Why the hub refuses to dial an IP it is about to connect to, or null when it may */
export function refusedIp(ip: string, loopbackAllowed: boolean): string | null {
  const family = familyOf(ip);
  if (family === null) return `${ip} is not an IP address`;
  if (REFUSED.check(ip, family)) return `${ip} is link-local, multicast, reserved, a tunnel to an IPv4 address or a cloud metadata address, which the hub never dials`;
  if (family === 'ipv6' && COMPATIBLE.check(ip, family) && !LOOPBACK.check(ip, family)) return `${ip} is an IPv4-compatible address, which the hub never dials`;
  if (!loopbackAllowed && LOOPBACK.check(ip, family)) return `${ip} is this machine, and the address was not recorded as loopback`;
  return null;
}

const invalid = (message: string): ServersError => new ServersError(400, 'servers.address-invalid', message);

/**
 * One address as a person enters it: an origin (scheme, host, port) and its kind. HTTPS always; plain
 * HTTP only on loopback, where there is no network to read the server token on. An IP literal in a
 * refused range is refused here; a name is checked again on every connection, against what it
 * resolves to then.
 */
export function parseAddress(value: unknown): ServerAddress {
  if (!isRecord(value)) throw invalid('each address is { url, kind }');
  const { url, kind } = value;
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw invalid("an address's kind is lan, tailscale, tunnel or other");
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) throw invalid("an address's url is required");
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw invalid(`${url} is not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid(`${url}: only https:// (or http:// on loopback) is dialled`);
  if (parsed.username || parsed.password) throw invalid(`${url}: an address carries no credentials; pairing gives the hub its own`);
  if (parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw invalid(`${url}: an address is a scheme, a host and a port; Claudio serves its API at /api on it`);
  const host = bareHost(parsed.hostname);
  if (!host) throw invalid(`${url} has no host`);
  const loopback = isLoopbackName(parsed.hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    throw new ServersError(400, 'servers.address-insecure', `${url}: plain HTTP would carry the server token in the clear; use https://`);
  }
  if (familyOf(host) !== null) {
    const refused = refusedIp(host, loopback);
    if (refused) throw new ServersError(400, 'servers.address-refused', refused);
  }
  return { url: parsed.origin, kind: kind as ServerAddressKind };
}

/** The ordered addresses of a server: one at least, each once */
export function parseAddresses(value: unknown): ServerAddress[] {
  if (!Array.isArray(value) || value.length === 0) throw new ServersError(400, 'servers.addresses-missing', 'addresses must list at least one { url, kind }');
  if (value.length > MAX_ADDRESSES) throw invalid(`a server has at most ${String(MAX_ADDRESSES)} addresses`);
  const out: ServerAddress[] = [];
  for (const each of value) {
    const address = parseAddress(each);
    if (out.some((kept) => kept.url === address.url)) throw invalid(`${address.url} is listed twice`);
    out.push(address);
  }
  return out;
}
