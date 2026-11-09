import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { Transform, type Duplex, type Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isServerActor, serversErrorOf, upgradeServerSocket, type Core, type GatewayTarget, type ServerUpgradeOutcome } from '@claudio/core';
import { isOwnerActor, type Guard } from '../security.ts';
import { TICKET_TTL_MS, originAllowed } from '../terminal-socket.ts';
import { UPLOAD_BODY_LIMIT } from './uploads.ts';

/**
 * The gateway (docs/plans/claudio-servers.md, D2 and §4.2): `/api/servers/:id/api/*` is the selected
 * remote's `/api/*`, sent on the hub's own token for it. The browser only ever talks to the hub, and
 * nothing a remote answers can act in the hub's origin: no remote page, script or cookie, no
 * redirect, and only content types that a browser does not run.
 *
 * Written on undici directly (`@claudio/core`'s `servers/transport.ts`): every connection dials an IP
 * the hub checked, over TLS judged by the pinned identity, and nothing follows a redirect (R2).
 */

export const GATEWAY_URL = '/servers/:id/api/*';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Request headers that reach the remote as the browser wrote them: what the API reads. Everything
 * else stays here, `Authorization`, cookies, `X-Forwarded-*`, `Forwarded` and `Sec-Fetch-*`
 * included (R1, R9): the remote is told who calls by the server token alone.
 */
const REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'last-event-id',
  'pragma',
  'range',
]);

/**
 * Response headers the browser gets from the remote. Not `Set-Cookie`, `Location`, CORS, HSTS,
 * `Clear-Site-Data` or anything else that would act on the hub's origin.
 */
const RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'retry-after',
  'vary',
  'x-accel-buffering',
  'x-next-cursor',
  'x-total-count',
]);

/** The API's own options (`X-Claudio-Spend-Override`, the OpenAI surface's) and readings (`X-Claudio-Cost-Usd`) */
const CLAUDIO_HEADER = /^x-claudio-/;

/**
 * What a remote may answer as itself. The API answers JSON, event streams, its exports and the
 * attachments it shows inline; anything else (an HTML page, an SVG, a script) would run in the hub's
 * origin if the browser opened it, so it is sent as a download (R3).
 */
const SAFE_TYPES: ReadonlySet<string> = new Set([
  'application/gzip',
  'application/json',
  'application/octet-stream',
  'application/pdf',
  'application/x-gzip',
  'application/x-ndjson',
  'application/x-tar',
  'application/zip',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/event-stream',
  'text/markdown',
  'text/plain',
]);

const TICKET_ROUTE = /^\/api\/terminals\/([^/]+)\/ticket$/;
const SOCKET_ROUTE = /^\/api\/terminals\/([^/]+)\/socket$/;
/** One hop (D7): a remote's own servers and its pairing are never reached through a hub */
const ONE_HOP = /^\/api\/(?:servers|server-links)(?:\/|$)/i;
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;
/** Until the remote answers an upgrade */
const SOCKET_TIMEOUT_MS = 10_000;
const TICKET_LIMIT = 16 * 1024;
const MAX_RELAYED_TICKETS = 1024;

interface Refusal {
  status: number;
  code: string;
  error: string;
}

/**
 * The remote path a gateway URL names, read from the raw target, or why it is refused. The guard has
 * already refused dot segments and encoded letters in the raw target; here the path is decoded again
 * and again until it stops changing, and every spelling must stay under `/api/` with no dot segment,
 * so no decoder between the hub and the remote's router can turn it into another path. An encoded
 * slash or backslash is refused outright for the same reason.
 */
export function gatewayPath(url: string, id: string): { path: string; query: string } | Refusal {
  const mark = url.indexOf('?');
  const raw = mark === -1 ? url : url.slice(0, mark);
  const query = mark === -1 ? '' : url.slice(mark + 1);
  const prefix = `/api/servers/${id}`;
  const refused = (error: string): Refusal => ({ status: 400, code: 'servers.path-refused', error });
  if (!raw.startsWith(`${prefix}/api/`)) return refused('the gateway relays /api/servers/<id>/api/… only');
  const path = raw.slice(prefix.length);
  if (/[\\\u0000-\u001f\u007f]/.test(path) || /%(?:2f|5c|00)/i.test(path)) return refused('an encoded slash, a backslash or a control character is another path to whoever decodes it');
  let current = path;
  for (let round = 0; ; round += 1) {
    if (round === 4) return refused('the path is encoded too many times over');
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return refused('the path has a malformed escape');
    }
    if (!decoded.startsWith('/api/') || DOT_SEGMENT.test(decoded) || decoded.includes('//') || decoded.includes('\\')) return refused('the path must stay under /api/ however it is decoded');
    if (ONE_HOP.test(decoded)) return { status: 403, code: 'servers.one-hop', error: "a remote's own servers and pairing are never reached through a hub" };
    if (decoded === current) break;
    current = decoded;
  }
  if (new URL(path, 'https://gateway.invalid').pathname !== path) return refused('the path is not in its normal form');
  return { path, query };
}

/** The query without `token`, the hub's own credential for a stream; every other parameter as it was written */
export function withoutToken(query: string): string {
  const kept = query.split('&').filter((part) => {
    if (!part) return false;
    const key = part.split('=')[0] ?? '';
    let name: string;
    try {
      name = decodeURIComponent(key.replace(/\+/g, ' '));
    } catch {
      name = key;
    }
    return name !== 'token';
  });
  return kept.length ? `?${kept.join('&')}` : '';
}

function upstreamHeaders(req: FastifyRequest, target: GatewayTarget, options: { identity: boolean; body: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || (!REQUEST_HEADERS.has(name) && !CLAUDIO_HEADER.test(name))) continue;
    // A stream is relayed byte for byte as it is written: nothing on the hop may hold it back to compress it (R4)
    if (name === 'accept-encoding' && options.identity) continue;
    if ((name === 'content-length' || name === 'content-encoding') && !options.body) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  out.authorization = `Bearer ${target.token}`;
  // The remote's own origin, on every request: its cross-site check sees a page of its own, and a
  // terminal ticket is bound to the origin its socket will show, which is this one too
  out.origin = target.origin.origin;
  return out;
}

function downstreamHeaders(headers: IncomingHttpHeaders, status: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || (!RESPONSE_HEADERS.has(name) && !CLAUDIO_HEADER.test(name))) continue;
    out[name] = value;
  }
  const type = out['content-type'];
  const essence = typeof type === 'string' ? type.split(';')[0]?.trim().toLowerCase() : undefined;
  if (essence !== undefined && !SAFE_TYPES.has(essence)) {
    out['content-type'] = 'application/octet-stream';
    out['content-disposition'] = 'attachment';
  }
  out['x-content-type-options'] = 'nosniff';
  if (status === 204 || status === 304) delete out['content-length'];
  return out;
}

async function readLimited(body: AsyncIterable<Buffer> & { destroy: () => unknown }, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) {
      body.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The remote terminal tickets this hub handed out, bound like its own (`TerminalTickets`): to the
 * server, the terminal, the actor who asked and the page's origin, for 30 s and one use. A browser's
 * WebSocket cannot carry the hub's token, so the ticket the remote minted through the gateway is the
 * credential of the relayed socket on the hub too, and only one the hub saw minted opens it: nobody
 * can use the hub to try tickets on a remote.
 */
class RelayedTickets {
  private readonly held = new Map<string, { server: string; terminal: string; actor: string; origin: string | null; expires: number }>();

  record(ticket: string, server: string, terminal: string, actor: string, origin: string | null): void {
    const now = Date.now();
    for (const [key, held] of this.held) if (held.expires <= now) this.held.delete(key);
    if (this.held.size >= MAX_RELAYED_TICKETS) {
      const oldest = this.held.keys().next();
      if (!oldest.done) this.held.delete(oldest.value);
    }
    this.held.set(hash(ticket), { server, terminal, actor, origin, expires: now + TICKET_TTL_MS });
  }

  /** The actor, or null; spent whatever the answer, as the hub's own tickets are */
  consume(ticket: string, server: string, terminal: string, origin: string | null): string | null {
    const key = hash(ticket);
    const held = this.held.get(key);
    if (!held) return null;
    this.held.delete(key);
    if (held.expires <= Date.now() || held.server !== server || held.terminal !== terminal || held.origin === null || held.origin !== origin) return null;
    return held.actor;
  }
}

const hash = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

/**
 * The largest request body relayed (D16): the largest the API takes as an upload of its own, a file
 * (`POST /uploads`) or a workspace archive. The gateway hands the body on without parsing it, so this
 * is the only bound on what one request makes the hub stream into a remote.
 */
export const gatewayBodyLimit = (core: Core): number => Math.max(UPLOAD_BODY_LIMIT, core.workspaces.settings.maxCompressedBytes);

/**
 * The body as it arrives, counted and never held: past `limit` the copy fails, which fails the
 * remote's request with it, so the remote never gets more than the limit. The browser's request is
 * not destroyed, so the `413` still reaches it.
 */
function counted(source: Readable, limit: number, over: () => void): Transform {
  let size = 0;
  const copy = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        over();
        callback(new Error('the body is larger than the gateway relays'));
        return;
      }
      callback(null, chunk);
    },
  });
  source.once('error', (error) => copy.destroy(error));
  source.pipe(copy);
  return copy;
}

const tooLarge = (reply: FastifyReply, limit: number): FastifyReply =>
  // The rest of the body is never read: the connection closes once the answer is out
  reply
    .status(413)
    .header('connection', 'close')
    .send({ error: `the body is larger than the ${String(Math.floor(limit / (1024 * 1024)))} MB the gateway relays`, code: 'servers.body-too-large' });

function failure(reply: FastifyReply, error: unknown): FastifyReply {
  const refusal = serversErrorOf(error);
  if (!refusal) throw error;
  return reply.status(refusal.statusCode).send({ error: refusal.message, code: refusal.reason });
}

/** The remote's JSON refusal of an upgrade, kept to its `error` and `code`; anything else is not passed on */
function refusalOf(body: Buffer): { error: string; code?: string } {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { error, code } = parsed as { error?: unknown; code?: unknown };
      if (typeof error === 'string') return { error, ...(typeof code === 'string' ? { code } : {}) };
    }
  } catch {
    // Not JSON: not ours to relay
  }
  return { error: 'the server refused the socket' };
}

export const gatewayRoutes: FastifyPluginAsync<{ core: Core; guard: Guard }> = async (app, { core, guard }) => {
  // The body goes to the remote as it arrived: no parser here reads it; `relay` counts it against the cap
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  // What an upgrade carried past its head. Node hands it to the server's `upgrade` listeners only,
  // and this one runs before `@fastify/websocket`'s, which routes the request on to `relaySocket`.
  // A client waits for the 101 before it sends, so this is nearly always empty. Without that plugin
  // (headless) nothing listens for upgrades, and adding a listener would leave them unanswered
  const heads = new WeakMap<IncomingMessage, Buffer>();
  if (app.hasDecorator('websocketServer')) {
    const keepHead = (raw: IncomingMessage, _socket: Duplex, head: Buffer): void => {
      if (head.length) heads.set(raw, head);
    };
    app.server.prependListener('upgrade', keepHead);
    app.addHook('onClose', (_instance, done) => {
      app.server.off('upgrade', keepHead);
      done();
    });
  }

  const tickets = new RelayedTickets();
  const relays = new Set<() => void>();
  app.addHook('preClose', (done) => {
    for (const end of relays) end();
    done();
  });

  const notFound = (reply: FastifyReply): FastifyReply => reply.status(404).send({ error: 'route not found' });

  /** The person's, and only on this hub: a paired hub's token driving this one's gateway would be a second hop (D7) */
  const callerRefusal = (req: FastifyRequest): Refusal | null => {
    if (isServerActor(req.actor)) return { status: 403, code: 'servers.one-hop', error: 'a hub cannot drive another hub’s servers (one hop)' };
    if (req.actor !== 'local' && !isOwnerActor(req.actor)) return { status: 403, code: 'servers.not-owner', error: 'only the person drives a remote server' };
    return null;
  };

  const relay = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (!core.servers.enabled) return notFound(reply);
    const located = gatewayPath(req.url, req.params.id);
    if ('status' in located) return reply.status(located.status).send({ error: located.error, code: located.code });
    const refused = callerRefusal(req);
    if (refused) return reply.status(refused.status).send({ error: refused.error, code: refused.code });
    const limit = gatewayBodyLimit(core);
    // A declared length over the cap is refused before anything is dialled; one that lies, or a
    // chunked body, is cut where it passes the cap
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return tooLarge(reply, limit);
    let target: GatewayTarget;
    try {
      target = await core.servers.target(req.params.id, located.path);
    } catch (error) {
      return failure(reply, error);
    }
    const id = req.params.id;
    const origin = target.origin.origin;
    const ticket = req.method === 'POST' ? TICKET_ROUTE.exec(located.path) : null;
    const stream = (req.headers.accept ?? '').includes('text/event-stream');
    const body = req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    // The browser went away (a closed tab, a stream given up), or the server was removed or the
    // feature turned off: the remote's request goes too, so no stream outlives its reader (R4)
    const abort = new AbortController();
    const release = core.servers.hold(id, () => abort.abort());
    reply.raw.once('close', () => {
      abort.abort();
      release();
    });
    const started = Date.now();
    let over = false;
    let res: Awaited<ReturnType<GatewayTarget['agent']['request']>>;
    try {
      res = await target.agent.request({
        origin,
        path: `${located.path}${withoutToken(located.query)}`,
        method: req.method as (typeof METHODS)[number] | 'HEAD',
        headers: upstreamHeaders(req, target, { identity: stream || ticket !== null, body }),
        body: body
          ? counted(req.raw, limit, () => {
              over = true;
            })
          : null,
        signal: abort.signal,
      });
    } catch (error) {
      release();
      // The browser's fault, not the remote's: its health is not touched
      if (over && !reply.raw.destroyed) return tooLarge(reply, limit);
      if (reply.raw.destroyed) return reply.hijack();
      const reason = serversErrorOf(error)?.reason ?? (abort.signal.aborted ? 'servers.disconnected' : 'servers.unreachable');
      core.servers.report(id, origin, { kind: 'failed', reason });
      return reply.status(reason === 'servers.identity-changed' ? 409 : reason === 'servers.disconnected' ? 503 : 502).send({ error: `${target.server.name} could not be reached (${reason})`, code: reason });
    }
    const status = res.statusCode;
    // The remote no longer takes the hub's token: a 401 passed on would read as the hub's own sign-in lapsing
    if (status === 401) {
      res.body.destroy();
      core.servers.report(id, origin, { kind: 'needs-pairing' });
      return reply.status(409).send({ error: `${target.server.name} no longer takes this hub's token: pair it again`, code: 'servers.needs-pairing' });
    }
    // Followed by the browser, a redirect could send a write, with the hub's own token, to any path
    // of the hub (a 307 keeps the method and the body): it never leaves the gateway
    if (status >= 300 && status < 400 && status !== 304) {
      res.body.destroy();
      return reply.status(502).send({ error: `${target.server.name} answered with a redirect, which the gateway never follows`, code: 'servers.redirect-refused' });
    }
    core.servers.report(id, origin, { kind: 'ok', latencyMs: Date.now() - started });
    void reply.status(status).headers(downstreamHeaders(res.headers, status));
    if (ticket && status === 200) {
      const answer = await readLimited(res.body as AsyncIterable<Buffer> & { destroy: () => unknown }, TICKET_LIMIT);
      if (answer === null) return reply.status(502).send({ error: 'the ticket answer is larger than a ticket', code: 'servers.bad-answer' });
      try {
        const minted = JSON.parse(answer.toString('utf8')) as { ticket?: unknown };
        if (typeof minted.ticket === 'string') tickets.record(minted.ticket, id, ticket[1] ?? '', req.actor ?? 'local', req.headers.origin ?? null);
      } catch {
        // Not a ticket: passed on as it is, and it opens nothing
      }
      return reply.send(answer);
    }
    if (status === 204 || status === 304 || req.method === 'HEAD') {
      res.body.destroy();
      return reply.send();
    }
    return reply.send(res.body);
  };

  /**
   * A WebSocket: the remote's terminal socket, and nothing else. The hub checks its own ticket, then
   * relays the upgrade and, once the remote switches protocols, the bytes both ways, so the remote's
   * own gate decides (D10) and the frames reach it as the browser wrote them.
   */
  const relaySocket = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (req.headers.upgrade === undefined || req.method !== 'GET') return undefined;
    const refuse = (status: number, code: string, error: string): FastifyReply => reply.status(status).send({ error, code });
    if (!core.servers.enabled) return notFound(reply);
    const id = req.params.id;
    const located = gatewayPath(req.url, id);
    if ('status' in located) return refuse(located.status, located.code, located.error);
    const socketRoute = SOCKET_ROUTE.exec(located.path);
    if (req.headers.upgrade.toLowerCase() !== 'websocket' || !socketRoute) return refuse(404, 'servers.not-a-socket', "only a remote's terminal socket is relayed as a WebSocket");
    if (!originAllowed(req)) return refuse(403, 'terminal.bad-origin', 'the socket must be opened from the page this wrapper serves');
    const presented = new URLSearchParams(located.query).get('ticket');
    if (!presented) return refuse(401, 'terminal.bad-ticket', 'a ticket is required');
    const key = guard.backoffKey(req);
    const wait = guard.backoff.retryAfter(key);
    if (wait > 0) {
      void reply.header('Retry-After', String(wait));
      return refuse(429, 'terminal.bad-ticket', 'too many failed tickets from this address');
    }
    const actor = tickets.consume(presented, id, socketRoute[1] ?? '', req.headers.origin ?? null);
    if (actor === null) {
      guard.backoff.fail(key);
      return refuse(401, 'terminal.bad-ticket', 'the ticket is wrong, used or expired');
    }
    req.actor = actor;
    let target: GatewayTarget;
    try {
      target = await core.servers.target(id, located.path);
    } catch (error) {
      return failure(reply, error);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${target.token}`, origin: target.origin.origin };
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const started = Date.now();
    let outcome: ServerUpgradeOutcome;
    try {
      outcome = await upgradeServerSocket(target.origin, `${located.path}${withoutToken(located.query)}`, headers, target.open, SOCKET_TIMEOUT_MS);
    } catch (error) {
      const reason = serversErrorOf(error)?.reason ?? 'servers.unreachable';
      core.servers.report(id, target.origin.origin, { kind: 'failed', reason });
      return refuse(reason === 'servers.identity-changed' ? 409 : 502, reason, `${target.server.name} could not be reached (${reason})`);
    }
    if (!outcome.upgraded) {
      const status = outcome.status >= 400 && outcome.status < 600 && outcome.status !== 401 ? outcome.status : 502;
      return reply.status(status).send(refusalOf(outcome.body));
    }
    core.servers.report(id, target.origin.origin, { kind: 'ok', latencyMs: Date.now() - started });

    reply.hijack();
    const client: Socket = req.raw.socket;
    const upstream = outcome.socket;
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
    for (const name of ['sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
      const value = outcome.headers[name];
      if (typeof value === 'string') lines.push(`${name}: ${value}`);
    }
    client.write(`${lines.join('\r\n')}\r\n\r\n`);
    // The remote greets at once (`hello`): those frames may have come with its 101
    if (outcome.head.length) client.write(outcome.head);
    const pending = heads.get(req.raw);
    heads.delete(req.raw);
    if (pending) upstream.write(pending);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      relays.delete(end);
      release();
      client.destroy();
      upstream.destroy();
    };
    const release = core.servers.hold(id, end);
    relays.add(end);
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    client.pipe(upstream);
    upstream.pipe(client);
    return reply;
  };

  for (const method of METHODS) {
    app.route<{ Params: { id: string } }>({
      method,
      url: GATEWAY_URL,
      // Nothing is compressed or decompressed on the hop: a stream must flush each event as the remote writes it (R4)
      compress: false,
      decompress: false,
      ...(method === 'GET' ? { preHandler: relaySocket } : {}),
      handler: relay,
    });
  }
};
