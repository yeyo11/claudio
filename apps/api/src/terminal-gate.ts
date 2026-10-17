import type { FastifyRequest } from 'fastify';
import { DESKTOP_ACTOR, type Core } from '@claudio/core';
import type { TerminalUnavailableReason } from '@claudio/shared';
import { LOOPBACK, fromLocalMachineStrict, hostNameOf } from './security.ts';

/**
 * Who may use the terminal, from where (docs/plans/terminal.md, §3.4). The guard in `security.ts`
 * already decided who the caller is; this adds the terminal's own rules, and every terminal route
 * and the socket's upgrade pass through it.
 */

export interface GateRefusal {
  status: number;
  /** `undefined` for the refusals that are not a way the terminal is unavailable (a bad Origin, a bad ticket) */
  reason?: TerminalUnavailableReason;
  error: string;
}

export interface GateOptions {
  /** Whether the feature has to be on and its backend loaded: false for the settings and the status, which say why it is not */
  feature: boolean;
  /** Whether to look at who the caller is: false for the socket, which learns it from its ticket after this */
  actor: boolean;
  /** Turning the terminal off only reduces exposure: it needs the owner, not the way they came */
  reducing?: boolean;
}

const refuse = (status: number, reason: TerminalUnavailableReason, error: string): GateRefusal => ({ status, reason, error });

/** The client's address as the audit rows keep it: `local` for this machine, else what the socket says */
export function clientOf(core: Core, req: FastifyRequest): string {
  return fromLocalMachineStrict(req, core.appSettings.runtimeHosts) ? 'local' : (req.socket.remoteAddress ?? 'unknown');
}

/** What the service can know without a caller: off, vetoed by the environment, no PTY backend, a host that keeps failing */
function serviceRefusal(core: Core): GateRefusal | null {
  const { reason } = core.terminals.status();
  if (reason === null) return null;
  const error: Record<string, string> = {
    off: 'the terminal is off: turn it on in Settings → Security',
    'disabled-by-env': 'the terminal is switched off by CLAUDIO_TERMINAL for this deployment',
    'pty-missing': 'the terminal is not available: its PTY backend could not be loaded on this machine',
    'host-failed': 'the terminal is not available: its host process keeps failing',
  };
  return refuse(409, reason, error[reason] ?? 'the terminal is not available');
}

/**
 * Who the caller is and where they came from. Read-only comes first here because a shell is the
 * largest possible change; a chat's token and the desktop app's secret are never the person.
 */
export async function clientRefusal(core: Core, req: FastifyRequest, options: Pick<GateOptions, 'actor' | 'reducing'>): Promise<GateRefusal | null> {
  if (core.security.readOnly) return refuse(405, 'read-only', 'read-only mode is on: the terminal is closed while this wrapper accepts no changes');

  if (options.actor) {
    if (req.actor?.startsWith('chat:')) return refuse(403, 'chat-token', "a chat's token cannot open, read or type into a terminal: the terminal is the person's");
    if (req.actor === DESKTOP_ACTOR) return refuse(403, 'chat-token', "the desktop app's own credential cannot open, read or type into a terminal: the terminal is the person's");
  }
  // Turning it off only reduces what is exposed, so the owner may do it however they came
  if (options.reducing) return null;

  const runtime = core.appSettings.runtimeHosts;
  const local = fromLocalMachineStrict(req, runtime);
  const mode = core.security.mode;
  if (mode === 'none') {
    if (!local) return refuse(403, 'needs-auth', 'turn on token authentication in Settings → Security to use the terminal from another device');
  } else if (!local) {
    const remote = core.terminals.settings().remote;
    if (remote === 'off') return refuse(403, 'remote-off', 'the terminal is set to open on this machine only');
    if (remote === 'tunnel') {
      // A tunnel forwards from loopback under a name only a running tunnel lends. Anything else
      // that merely writes that name in `Host` arrived over the network and does not count
      const peer = req.socket.remoteAddress;
      const name = req.headers.host === undefined ? '' : hostNameOf(req.headers.host);
      if (peer === undefined || !LOOPBACK.test(peer) || runtime.get(name) === undefined) {
        return refuse(403, 'needs-tunnel', 'the terminal opens from another device only through the tunnel: turn it on in Settings → Remote access');
      }
    }
  }

  // Defence in depth for a connection from this machine: which process opened it
  const address = req.socket.remoteAddress;
  if (address !== undefined && LOOPBACK.test(address)) {
    const verdict = await core.terminals.peer.verdict({ address, port: req.socket.remotePort ?? 0, serverPort: req.socket.localPort ?? 0 });
    if (verdict === 'agent') return refuse(403, 'from-agent', "this request came from a chat's process: the terminal is the person's, never an agent's");
    // With nothing guarding the API, a client nobody could identify is refused rather than trusted:
    // a credential already proves the person under a token or OIDC
    if (verdict === 'unknown' && mode === 'none') {
      return refuse(403, 'needs-auth', 'this machine cannot tell which process made the request: turn on token authentication in Settings → Security to use the terminal');
    }
  }
  return null;
}

/** The whole gate: the feature first, then read-only, who, and from where */
export async function terminalGate(core: Core, req: FastifyRequest, options: GateOptions): Promise<GateRefusal | null> {
  if (options.feature) {
    const unavailable = serviceRefusal(core);
    if (unavailable) return unavailable;
  }
  return clientRefusal(core, req, options);
}

/** Reasons that mean someone tried and was turned away, which the owner sees in the history */
const ATTEMPTS = new Set<TerminalUnavailableReason | undefined>(['needs-auth', 'remote-off', 'needs-tunnel', 'from-agent', 'chat-token']);

/** Writes the attempt down for the owner when it is the kind they would want to see */
export function recordGateRefusal(core: Core, req: FastifyRequest, refusal: GateRefusal, terminalId?: string | null): void {
  const reason = refusal.reason;
  if (!ATTEMPTS.has(reason) || reason === undefined) return;
  core.terminals.recordRefusal({
    terminalId: terminalId && core.terminals.get(terminalId) ? terminalId : null,
    actor: req.actor ?? 'anonymous',
    client: clientOf(core, req),
    origin: req.headers.origin ?? null,
    reason,
  });
}
