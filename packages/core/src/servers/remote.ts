import type { Socket } from 'node:net';
import { isRecord, type ServerCheck, type ServerLinkGrant, type ServerMeta, type ServerPairing } from '@claudio/shared';
import type { Agent, Dispatcher } from 'undici';
import { ServersError, serversErrorOf } from './errors.ts';
import { upgrade } from './transport.ts';

/**
 * What the hub asks a remote of its own accord: who it is, a pairing, a revoke and the three checks of
 * a connection test. Each answer is read with a size limit and a deadline: a remote is another
 * machine, and the hub must not hang on it or hold whatever it sends.
 */

const ANSWER_LIMIT = 64 * 1024;

export interface Answer {
  status: number;
  json: unknown;
  headers: Dispatcher.ResponseData['headers'];
}

async function readLimited(body: Dispatcher.ResponseData['body'], limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      body.destroy();
      throw new ServersError(502, 'servers.bad-answer', 'the server answered more than a Claudio would');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface CallOptions {
  method: Dispatcher.HttpMethod;
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs: number;
}

/** One JSON request to a remote, its answer read whole (within `ANSWER_LIMIT`) */
export async function call(agent: Agent, origin: string, options: CallOptions): Promise<Answer> {
  const res = await agent.request({
    origin,
    path: options.path,
    method: options.method,
    headers: {
      accept: 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const raw = await readLimited(res.body, ANSWER_LIMIT);
  let json: unknown = null;
  try {
    json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, headers: res.headers };
}

const codeOf = (json: unknown): string | undefined => (isRecord(json) && typeof json.code === 'string' ? json.code : undefined);
const errorOf = (json: unknown): string | undefined => (isRecord(json) && typeof json.error === 'string' ? json.error : undefined);

/** `GET /api/meta`'s answer, or null when what answered is not a Claudio */
export function parseMeta(json: unknown): ServerMeta | null {
  if (!isRecord(json) || !isRecord(json.apiVersion)) return null;
  const { instanceId, version, capabilities } = json;
  const { current, min } = json.apiVersion;
  if (typeof instanceId !== 'string' || !instanceId || typeof version !== 'string') return null;
  if (typeof current !== 'number' || typeof min !== 'number' || !Number.isInteger(current) || !Number.isInteger(min)) return null;
  if (!Array.isArray(capabilities) || !capabilities.every((each) => typeof each === 'string')) return null;
  return { instanceId, version, apiVersion: { current, min }, capabilities: capabilities as string[] };
}

export async function readMeta(agent: Agent, origin: string, timeoutMs: number): Promise<ServerMeta> {
  const answer = await call(agent, origin, { method: 'GET', path: '/api/meta', timeoutMs });
  const meta = answer.status === 200 ? parseMeta(answer.json) : null;
  if (!meta) throw new ServersError(502, 'servers.not-claudio', `${origin} did not answer as a Claudio (GET /api/meta: ${String(answer.status)})`);
  return meta;
}

function parseGrant(json: unknown): ServerLinkGrant | null {
  if (!isRecord(json)) return null;
  const { token, tokenId, instanceId, tlsFingerprint } = json;
  if (typeof token !== 'string' || !token || typeof tokenId !== 'string' || typeof instanceId !== 'string') return null;
  if (tlsFingerprint !== null && typeof tlsFingerprint !== 'string') return null;
  return { token, tokenId, instanceId, tlsFingerprint };
}

export interface HubName {
  hubInstanceId: string;
  hubName: string;
}

/**
 * Pairs by the code a person read off the remote, or by the owner's token they pasted, which is sent
 * this once and never kept. A refusal keeps the remote's own code (`server-links.code-invalid`,
 * `server-links.too-many`…) so the person is told what the remote said.
 */
export async function pair(agent: Agent, origin: string, pairing: ServerPairing, hub: HubName, timeoutMs: number): Promise<ServerLinkGrant> {
  const answer =
    pairing.kind === 'code'
      ? await call(agent, origin, { method: 'POST', path: '/api/server-links/redeem', body: { code: pairing.code, ...hub }, timeoutMs })
      : await call(agent, origin, { method: 'POST', path: '/api/server-links', token: pairing.token, body: hub, timeoutMs });
  if (answer.status === 200) {
    const grant = parseGrant(answer.json);
    if (!grant) throw new ServersError(502, 'servers.bad-answer', `${origin} answered the pairing with something that is not a grant`);
    return grant;
  }
  const remote = codeOf(answer.json);
  const said = errorOf(answer.json) ?? `the server refused the pairing (${String(answer.status)})`;
  if (answer.status === 401) throw new ServersError(400, 'servers.token-invalid', 'the server does not take that token: paste the owner token of that server');
  const status = answer.status === 409 || answer.status === 429 ? answer.status : answer.status >= 500 ? 502 : 400;
  throw new ServersError(status, remote?.startsWith('server-links.') ? remote : 'servers.pairing-failed', said);
}

export type RevokeOutcome = { kind: 'revoked' } | { kind: 'unknown' } | { kind: 'failed'; code: string };

/**
 * Gives the hub's token back (`DELETE /api/server-links/self`, R8). A 401 means the remote no longer
 * knows the token, so nothing is left behind there; anything else is a token that may still work.
 */
export async function revokeSelf(agent: Agent, origin: string, token: string, timeoutMs: number): Promise<RevokeOutcome> {
  try {
    const answer = await call(agent, origin, { method: 'DELETE', path: '/api/server-links/self', token, timeoutMs });
    if (answer.status === 204) return { kind: 'revoked' };
    if (answer.status === 401) return { kind: 'unknown' };
    return { kind: 'failed', code: codeOf(answer.json) ?? `servers.revoke-${String(answer.status)}` };
  } catch (error) {
    return { kind: 'failed', code: serversErrorOf(error)?.reason ?? 'servers.unreachable' };
  }
}

const failed = (error: unknown): ServerCheck => ({ ok: false, code: serversErrorOf(error)?.reason ?? 'servers.unreachable' });

/** REST: an authenticated read every profile serves, so a revoked token shows as itself */
export async function checkRest(agent: Agent, origin: string, token: string, timeoutMs: number): Promise<ServerCheck> {
  const started = Date.now();
  try {
    const answer = await call(agent, origin, { method: 'GET', path: '/api/security/auth', token, timeoutMs });
    if (answer.status === 200) return { ok: true, latencyMs: Date.now() - started };
    if (answer.status === 401) return { ok: false, code: 'servers.needs-pairing' };
    return { ok: false, code: codeOf(answer.json) ?? `servers.rest-${String(answer.status)}` };
  } catch (error) {
    return failed(error);
  }
}

/**
 * SSE: the event stream opens and its first event (`stream.hello`) arrives within the deadline. A
 * proxy that buffers or compresses a stream fails here while plain REST still works.
 */
export async function checkEvents(agent: Agent, origin: string, token: string, timeoutMs: number): Promise<ServerCheck> {
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await agent.request({ origin, path: '/api/events', method: 'GET', headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }, signal: abort.signal });
    if (res.statusCode !== 200) {
      res.body.destroy();
      return { ok: false, code: res.statusCode === 401 ? 'servers.needs-pairing' : `servers.events-${String(res.statusCode)}` };
    }
    let seen = '';
    for await (const chunk of res.body as AsyncIterable<Buffer>) {
      seen += chunk.toString('utf8');
      if (seen.includes('stream.hello')) return { ok: true, latencyMs: Date.now() - started };
      if (seen.length > ANSWER_LIMIT) break;
    }
    return { ok: false, code: 'servers.events-silent' };
  } catch (error) {
    return abort.signal.aborted ? { ok: false, code: 'servers.events-silent' } : failed(error);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** A terminal id no terminal has: the route answers before it would look for a ticket */
const PROBE_TERMINAL = 'claudio-servers-check';

/**
 * WebSocket: an upgrade reaches the remote's terminal socket route intact. The route answers every
 * upgrade with a `terminal.*` refusal before its ticket (no such terminal, or the terminal closed to
 * this hub: D10), so that answer is proof the upgrade got through; a proxy that drops `Upgrade` shows
 * as `terminal.upgrade-required`, one that refuses sockets as anything else. The remote's code comes
 * back with it, so the person learns whether its terminal is open to the hub.
 */
export async function checkSocket(origin: URL, token: string, open: () => Promise<Socket>, timeoutMs: number): Promise<ServerCheck> {
  const started = Date.now();
  try {
    const outcome = await upgrade(
      origin,
      `/api/terminals/${PROBE_TERMINAL}/socket`,
      { authorization: `Bearer ${token}`, origin: origin.origin, 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('claudio-servers!').toString('base64') },
      open,
      timeoutMs,
    );
    if (outcome.upgraded) {
      outcome.socket.destroy();
      return { ok: true, latencyMs: Date.now() - started };
    }
    let code: string | undefined;
    try {
      code = codeOf(JSON.parse(outcome.body.toString('utf8')));
    } catch {
      code = undefined;
    }
    if (code === 'terminal.upgrade-required') return { ok: false, code: 'servers.socket-upgrade-dropped' };
    if (code?.startsWith('terminal.')) return { ok: true, latencyMs: Date.now() - started, code };
    return { ok: false, code: `servers.socket-${String(outcome.status)}` };
  } catch (error) {
    return failed(error);
  }
}
