import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { TerminalError, type Core, type TerminalClient, type TerminalConnection } from '@claudio/core';
import type { TerminalClientFrame, TerminalTicket } from '@claudio/shared';
import { allowedOrigin } from './origins.ts';
import { clientOf, recordGateRefusal, terminalGate } from './terminal-gate.ts';
import { forwardingOf, type Guard } from './security.ts';

/** How long a ticket opens the socket for, and that it opens it once */
export const TICKET_TTL_MS = 30_000;
/** Tickets are minted by whoever may open a terminal, so the table is bounded rather than trusted */
const MAX_TICKETS = 1024;
/** An input frame is at most 64 KiB; the rest of the allowance is for a control frame */
const MAX_FRAME_BYTES = 64 * 1024 + 4096;
/** A client that does not answer the close handshake is cut off after this */
const CLOSE_GRACE_MS = 2000;

interface Held {
  terminalId: string;
  actor: string;
  origin: string | null;
  expires: number;
}

/**
 * The tickets for terminal sockets, in memory and as hashes (like chat tokens): 32 random bytes,
 * valid 30 s, one use, bound to the terminal, the actor and the `Origin` that asked for it. The
 * browser's `WebSocket` cannot send `Authorization`, and the owner's long-lived token would land in
 * access logs and history as a query parameter; a ticket is worth nothing a few seconds later.
 */
export class TerminalTickets {
  private readonly held = new Map<string, Held>();
  /** The sockets these tickets opened, which a change of who may get in has to end */
  private readonly sockets = new Set<WebSocket>();

  /** The clock is a parameter so a test can let a ticket expire */
  constructor(private readonly now: () => number = Date.now) {}

  mint(terminalId: string, actor: string, origin: string | null): TerminalTicket {
    this.purge();
    const ticket = randomBytes(32).toString('base64url');
    const expires = this.now() + TICKET_TTL_MS;
    // Least recent first, so the one dropped when the table is full is the oldest
    if (this.held.size >= MAX_TICKETS) this.held.delete(this.held.keys().next().value as string);
    this.held.set(hash(ticket), { terminalId, actor, origin, expires });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * The actor the ticket was minted for, or null. It is spent whatever the answer: a ticket
   * presented for the wrong terminal or from another origin is not given a second try.
   */
  consume(ticket: string, terminalId: string, origin: string | null): string | null {
    const key = hash(ticket);
    const held = this.held.get(key);
    if (!held) return null;
    this.held.delete(key);
    if (held.expires <= this.now() || held.terminalId !== terminalId || held.origin === null || held.origin !== origin) return null;
    return held.actor;
  }

  /** Keeps an accepted socket until it closes, so {@link revoke} can reach it */
  track(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  /**
   * Who may get in changed (a new or cleared token, another auth mode, a narrower `remote`): every
   * ticket is spent and every socket closed. Each was let in by the gate under the old rules, and a
   * ticket names an actor the socket never checks again. The shells keep running; the person's
   * view reconnects with a new ticket, through the gate as it is now.
   */
  revoke(): void {
    this.held.clear();
    for (const socket of this.sockets) {
      socket.close(4001, 'terminal.reauthenticate');
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref();
    }
    this.sockets.clear();
  }

  /** Tickets held now, which is what a test checks the bound by */
  get size(): number {
    return this.held.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [key, held] of this.held) if (held.expires <= now) this.held.delete(key);
  }
}

const hash = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

/** Each wrapper's tickets, for the routes outside the terminal's that change who may get in */
const ticketsOf = new WeakMap<Core, TerminalTickets>();

/** Ends every terminal socket and spends every ticket: called when who may get in has changed */
export function revokeTerminalAccess(core: Core): void {
  ticketsOf.get(core)?.revoke();
}

/**
 * Whether a socket (or the request that mints its ticket) comes from the page this wrapper served.
 * Every browser sends `Origin` on a WebSocket and CORS does not apply to it, so this is what stops
 * a page the owner visits from opening a socket to a LAN address. The origin must be the one the
 * request was dialled on, or one named in `CLAUDIO_CORS_ORIGIN` (never its `*`). Only the host is
 * compared with `Host`, not the scheme: behind the tunnel the page is `https` and the request that
 * reaches this process is plain.
 */
export function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Behind the dev server the page's authority is the one it forwarded, and only when `forwardingOf` believes it
  const forwarding = forwardingOf(req);
  const host = (typeof forwarding === 'object' ? forwarding.host : req.headers.host)?.toLowerCase();
  if (host !== undefined && parsed.host.toLowerCase() === host) return true;
  return process.env.CLAUDIO_CORS_ORIGIN?.trim() !== '*' && allowedOrigin(origin) !== null;
}

const isInteger = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min;

/** A control frame from the view, or null when it is not one */
function parseFrame(text: string): TerminalClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type === 'focus') return { type: 'focus' };
  if (frame.type === 'ack' && isInteger(frame.bytes, 0)) return { type: 'ack', bytes: frame.bytes };
  if (frame.type === 'resize' && isInteger(frame.cols, 1) && isInteger(frame.rows, 1)) return { type: 'resize', cols: frame.cols, rows: frame.rows };
  return null;
}

/** Turns a socket into what the service attaches: frames out as JSON text, output as binary */
function clientFor(socket: WebSocket, who: Pick<TerminalClient, 'actor' | 'client' | 'origin'>): TerminalClient {
  const send = (data: string | Buffer, binary: boolean): void => {
    if (socket.readyState === socket.OPEN) socket.send(data, { binary });
  };
  return {
    ...who,
    frame: (frame) => send(JSON.stringify(frame), false),
    output: (data) => send(data, true),
    buffered: () => socket.bufferedAmount,
    close: () => {
      if (socket.readyState === socket.CLOSED) return;
      socket.close(1000);
      // A peer that never answers the handshake would hold the socket open for good
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref();
    },
  };
}

/** Serves one accepted socket: queues what arrives while the terminal attaches, then drives the connection */
async function serve(core: Core, socket: WebSocket, id: string, who: Pick<TerminalClient, 'actor' | 'client' | 'origin'>): Promise<void> {
  const queue: Array<{ data: Buffer; binary: boolean }> = [];
  let connection: TerminalConnection | null = null;
  let gone = false;

  const handle = (live: TerminalConnection, data: Buffer, binary: boolean): void => {
    try {
      if (binary) {
        live.input(data);
        return;
      }
      const frame = parseFrame(data.toString('utf8'));
      if (!frame) {
        socket.close(1003, 'bad frame');
        return;
      }
      if (frame.type === 'resize') live.resize(frame.cols, frame.rows);
      else if (frame.type === 'ack') live.ack(frame.bytes);
      else live.focus();
    } catch (error) {
      socket.close(error instanceof TerminalError && error.status === 413 ? 1009 : 1011, error instanceof TerminalError ? error.code : 'error');
    }
  };

  socket.on('message', (data, isBinary) => {
    const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (connection) handle(connection, buffer, isBinary);
    else queue.push({ data: buffer, binary: isBinary });
  });
  socket.on('close', () => {
    gone = true;
    connection?.detach();
  });

  try {
    connection = await core.terminals.attach(id, clientFor(socket, who));
  } catch (error) {
    socket.close(1008, error instanceof TerminalError ? error.code : 'terminal.unavailable');
    return;
  }
  if (gone) {
    connection.detach();
    return;
  }
  for (const held of queue.splice(0)) handle(connection, held.data, held.binary);
}

/**
 * `GET /terminals/:id/socket`: the terminal's byte stream. Every refusal is an HTTP answer before
 * the upgrade, in this order: the host allowlist and read-only (the guard), the feature and who and
 * from where (the gate), the terminal itself, the `Origin`, and last the ticket, which is spent only
 * once everything else has agreed.
 */
export const terminalSocketRoute: FastifyPluginAsync<{ core: Core; guard: Guard; tickets: TerminalTickets }> = async (app, { core, guard, tickets }) => {
  ticketsOf.set(core, tickets);
  const turnAway = (req: FastifyRequest, reply: FastifyReply, status: number, body: { error: string; code: string; reason?: string }, terminalId: string, why: string): FastifyReply => {
    // The gate's own attempts are written by the caller; these are the socket's
    core.terminals.recordRefusal({ terminalId: core.terminals.get(terminalId) ? terminalId : null, actor: req.actor ?? 'anonymous', client: clientOf(core, req), origin: req.headers.origin ?? null, reason: why });
    void reply.status(status).send(body);
    return reply;
  };

  app.get<{ Params: { id: string }; Querystring: { ticket?: string } }>(
    '/terminals/:id/socket',
    {
      websocket: true,
      preHandler: async (req, reply) => {
        const { id } = req.params;
        if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
          void reply.status(426).send({ error: 'this route is a WebSocket', code: 'terminal.upgrade-required' });
          return reply;
        }
        // The actor is the ticket's, learned below: only the feature, read-only and where from are decided here
        const refused = await terminalGate(core, req, { feature: true, actor: false });
        if (refused) {
          recordGateRefusal(core, req, refused, id);
          void reply.status(refused.status).send({ error: refused.error, code: `terminal.${refused.reason ?? 'refused'}`, ...(refused.reason ? { reason: refused.reason } : {}) });
          return reply;
        }
        if (!originAllowed(req)) {
          return turnAway(req, reply, 403, { error: 'the socket must be opened from the page this wrapper serves', code: 'terminal.bad-origin' }, id, 'bad-origin');
        }
        const terminal = core.terminals.get(id);
        if (!terminal) {
          void reply.status(404).send({ error: 'No such terminal', code: 'terminal.not-found' });
          return reply;
        }
        if (terminal.state === 'closed') {
          void reply.status(409).send({ error: 'The terminal was closed', code: 'terminal.ended' });
          return reply;
        }
        if (terminal.clients >= 4) {
          void reply.status(409).send({ error: 'At most 4 clients can attach to one terminal', code: 'terminal.clients' });
          return reply;
        }

        const key = guard.backoffKey(req);
        const ticket = req.query.ticket;
        if (typeof ticket !== 'string' || ticket === '') {
          return turnAway(req, reply, 401, { error: 'a ticket is required', code: 'terminal.bad-ticket' }, id, 'bad-ticket');
        }
        const wait = guard.backoff.retryAfter(key);
        if (wait > 0) {
          void reply.header('Retry-After', String(wait)).status(429).send({ error: 'too many failed tickets from this address', code: 'terminal.bad-ticket' });
          return reply;
        }
        const actor = tickets.consume(ticket, id, req.headers.origin ?? null);
        if (actor === null) {
          guard.backoff.fail(key);
          return turnAway(req, reply, 401, { error: 'the ticket is wrong, used or expired', code: 'terminal.bad-ticket' }, id, 'bad-ticket');
        }
        req.actor = actor;
        // The ticket was minted through the gate; a caller that has since become a chat's or the desktop's is still turned away
        const again = await terminalGate(core, req, { feature: false, actor: true });
        if (again) {
          recordGateRefusal(core, req, again, id);
          void reply.status(again.status).send({ error: again.error, code: `terminal.${again.reason ?? 'refused'}`, ...(again.reason ? { reason: again.reason } : {}) });
          return reply;
        }
        return;
      },
    },
    (socket, req) => {
      tickets.track(socket);
      void serve(core, socket, req.params.id, { actor: req.actor ?? 'local', client: clientOf(core, req), origin: req.headers.origin ?? null }).catch((err: unknown) => {
        req.log.error({ err }, 'terminal socket failed');
        socket.terminate();
      });
    },
  );
};

/** Lets a socket past the size cap the service enforces: handed to `@fastify/websocket` as its `ws` option */
export const SOCKET_OPTIONS = { maxPayload: MAX_FRAME_BYTES } as const;
