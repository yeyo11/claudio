import { Endpoint, presetMinimal, presetN0, presetN0DisableRelay, RelayMode, EndpointAddr, EndpointTicket, SecretKey, setLogLevel } from '@number0/iroh';

export const ALPN = Array.from(new TextEncoder().encode('claudio/collab/1'));

/** preset: n0 | minimal | n0-no-relay; relayUrls: custom relay map on top of the preset */
export async function bindEndpoint({ preset = 'n0', relayUrls = [], secret = null, bindAddr = null } = {}) {
  if (process.env.IROH_LOG) setLogLevel(process.env.IROH_LOG);
  const b = Endpoint.builder();
  if (preset === 'minimal') presetMinimal(b);
  else if (preset === 'n0-no-relay') presetN0DisableRelay(b);
  else presetN0(b);
  b.alpns([ALPN]);
  if (relayUrls.length) b.relayMode(RelayMode.customFromUrls(relayUrls));
  if (secret) b.secretKey(secret);
  if (bindAddr) b.bindAddr(bindAddr);
  return b.bind();
}

export function tickets(ep) {
  const addr = ep.addr();
  const id = ep.id();
  const relay = addr.relayUrl();
  const direct = addr.directAddresses();
  return {
    id: id.toString(),
    relay,
    direct,
    full: EndpointTicket.fromAddr(addr).toString(),
    relayOnly: relay ? EndpointTicket.fromAddr(new EndpointAddr(id, relay, [])).toString() : null,
    directOnly: direct.length ? EndpointTicket.fromAddr(new EndpointAddr(id, null, direct)).toString() : null,
    idOnly: EndpointTicket.fromAddr(new EndpointAddr(id, null, [])).toString(),
  };
}

export function pathSummary(conn) {
  return conn.paths().map((p) => ({ sel: p.isSelected, relay: p.isRelay, ip: p.isIp, addr: p.remoteAddr, rttMs: Math.round(p.rttMs * 100) / 100 }));
}

export { SecretKey, EndpointTicket };
