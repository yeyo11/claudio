/*
 * What the core and the Collaborators host say to each other over the fork's IPC channel
 * (`serialization: 'advanced'`, so raw bytes travel as `Uint8Array`). The host holds the iroh
 * endpoint and frames streams; it answers nothing by itself: every request a peer sends is handed to
 * the core, whose `serve.ts` decides, and every request the core makes is dialled and relayed back.
 */

/**
 * Where the host loads the binding from instead of `@number0/iroh`: a test points it at a module that
 * does not exist to see Claudio go on without it. Never set in a shipped build.
 */
export const IROH_MODULE_ENV = 'CLAUDIO_COLLAB_IROH_MODULE';

/** `n0`: n0's discovery and relays, the default; `minimal`: neither, for tests and the e2e harness (loopback tickets) */
export type HostPreset = 'n0' | 'minimal';

export interface HostStartOptions {
  /** The install's 32-byte Ed25519 seed, the iroh `SecretKey` */
  secretKey: number[];
  preset: HostPreset;
  /** A custom relay map that replaces n0's (`RelayMode.customFromUrls`); empty for the preset's own */
  relayUrls: string[];
  /** `host:port` to bind; null for the binding's default */
  bindAddr: string | null;
  /** How long `online()` is given before the status says no relay answered; it never resolves without one */
  onlineTimeoutMs?: number;
  /** How often addresses, home relay and paths are polled: the `watch*` methods abort the process (§7.2) */
  pollMs?: number;
}

/** Where a request goes: the peer's endpoint id, and its ticket when one is known (an invite carries it) */
export interface HostTarget {
  endpointId: string;
  ticket: string | null;
}

/** Core to host */
export type CoreToHost =
  | { type: 'start'; options: HostStartOptions }
  | { type: 'stop' }
  /** A reply frame to an incoming stream, as an object the host encodes */
  | { type: 'reply'; stream: number; frame: unknown }
  /** Raw bytes after a reply frame that announces them, at most 1 MiB per message */
  | { type: 'reply-bytes'; stream: number; data: Uint8Array }
  | { type: 'reply-end'; stream: number }
  /** A request to a peer: the host dials it (or reuses a connection), sends `frame` and relays the replies */
  | { type: 'request'; req: number; to: HostTarget; frame: unknown }
  | { type: 'cancel'; req: number }
  /** Closes every connection to a peer: it was removed from a group */
  | { type: 'disconnect'; endpointId: string };

/** The endpoint's own state, polled */
export type HostConnection = 'starting' | 'online' | 'no-relay';

export type HostUnavailableCode = 'platform' | 'load';

/** Host to core */
export type HostToCore =
  | { type: 'ready' }
  /** The native module did not load: Collaborators cannot run on this install, and the host stays idle */
  | { type: 'unavailable'; code: HostUnavailableCode; message: string }
  | { type: 'start-error'; message: string }
  | { type: 'status'; endpointId: string; connection: HostConnection; homeRelay: string | null; ticket: string; directAddresses: string[] }
  | { type: 'stopped' }
  | { type: 'peer'; endpointId: string; connected: boolean; path: 'direct' | 'relay' | null; rttMs: number | null }
  /** A peer opened a stream and sent this request frame (parsed JSON, not yet validated) */
  | { type: 'incoming'; stream: number; from: string; frame: unknown }
  /** That stream or its connection closed: whatever still answers it can stop */
  | { type: 'incoming-closed'; stream: number }
  | { type: 'response'; req: number; frame: unknown }
  | { type: 'response-bytes'; req: number; data: Uint8Array }
  | { type: 'response-end'; req: number }
  | { type: 'response-error'; req: number; message: string }
  | { type: 'log'; message: string };
