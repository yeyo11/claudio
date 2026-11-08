export { MAX_ADDRESSES, bareHost, isLoopbackName, parseAddress, parseAddresses, refusedIp } from './addresses.ts';
export { ServersError, serversErrorOf } from './errors.ts';
export { SERVERS_FILE, SERVERS_SETTINGS_FILE, SERVERS_VAULT_TOOL, ServerRegistry, type StoredServer } from './registry.ts';
export { FAILURES_BEFORE_MOVE, MAX_SERVERS, Servers, apiCompatibility, type GatewayOutcome, type GatewayTarget, type ServersOptions } from './service.ts';
export { agentFor, dial, sameFingerprint, systemLookup, upgrade, type Lookup, type PeerPins, type PeerSeen, type Trust, type UpgradeOutcome } from './transport.ts';

/** What `GET /meta` lists on a hub that serves the gateway (§9.1) */
export const GATEWAY_CAPABILITY = 'gateway';
