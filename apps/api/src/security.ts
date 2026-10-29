import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DESKTOP_ACTOR, MAX_AUDIT_PATH, chatActor, type AgentReadRefusal, type Core, type RuntimeHosts } from '@claudio/core';
import type { HostRefusal } from '@claudio/shared';
import { allowedOrigin } from './origins.ts';
import { ROUTE_DOCS, accessOf } from './openapi/routes.ts';

/**
 * The guard in front of every route, and the audit trail behind every write.
 *
 * Both are hooks on the root instance rather than a plugin around the API: `/docs` and
 * `/openapi.json` are registered outside the `/api` prefix and must be guarded too, and a hook is
 * the only thing a hijacked reply (the event streams) still goes through.
 */

const API_PREFIX = '/api';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The routes that check their own proof, keyed as `ROUTE_DOCS` keys them; each is `open` there. The
 * receivers a code host delivers to cannot send a bearer token: a delivery is believed by its
 * signature (or token header), checked over the raw body inside the route. The `/v1` client-tool stub
 * a chat's CLI calls (`routes/openai-tools.ts`) is reached by a confined API chat, which holds no
 * credential for this API (D14.3 of docs/plans/headless-image.md): its CLI presents the stub
 * session's own secret, which opens that one session and nothing else. They answer to no actor and
 * write no audit line (a delivery is not the person's change, and a host or a CLI may send many),
 * stay open in read-only mode, since a delivery only moves a next read to now, and the host
 * allowlist still applies. Every other `open` route is a probe, which skips the host check too.
 */
const RECEIVERS = new Set([
  'POST /webhooks/github/:registrationId',
  'POST /webhooks/gitlab/:registrationId',
  'POST /openai/client-tools/:id/mcp',
  'GET /openai/client-tools/:id/mcp',
  'DELETE /openai/client-tools/:id/mcp',
]);

/**
 * The one route exempt from the host check: it is how the owner adds the host they are dialling.
 * It still needs the owner's bearer token, which a DNS-rebinding page cannot hold (it lives in the
 * real origin's storage and a browser never sends an `Authorization` header by itself).
 */
const HOST_CLAIM = 'POST /security/allowed-hosts/claim';

/**
 * The write that compares the `Origin` itself, against the authority the dev server forwarded when it
 * is believed, and records a refusal in the terminal's history where the person looks for it: the
 * cross-site check of an open install leaves it to the route rather than answer first with less.
 */
const OWN_ORIGIN_CHECK = new Set(['POST /terminals/:id/ticket']);

/**
 * `EventSource` and the browser's own GETs (an `<img src>`, a link) cannot carry an
 * `Authorization` header, so these six accept the credential as `?token=`. They are the only
 * ones: a token in a query string ends up in access logs, and a route that can be called with
 * `fetch` has no excuse. `GET /api/events` is the one the plan names; the chat stream is the same
 * kind of `EventSource`, an attachment is what the chat renders inline, and a transcript export is
 * a download link the browser follows itself — fetching a whole transcript into a blob to save it
 * would hold it twice in memory for no gain. A project export is the same download, only longer,
 * and so is an eval run's.
 */
const QUERY_TOKEN = new Set([
  'GET /events',
  'GET /chats/:id/stream',
  'GET /uploads/:id/content',
  'GET /chats/:id/export',
  'GET /projects/:id/export',
  'GET /eval-runs/:runId/export',
]);

/**
 * Loopback is always ours: it is where a local install lives, and it is the address a rebinding
 * name resolves to on the second lookup. `::ffff:127.x.x.x` is the same address seen through a
 * dual-stack socket.
 */
export const LOOPBACK = /^(?:localhost|::1|(?:::ffff:)?127(?:\.\d{1,3}){3})$/;

/** The authority without its port, with IPv6 brackets removed, lowercased so a name compares. */
export function hostNameOf(authority: string): string {
  const value = authority.trim().toLowerCase();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value.slice(1) : value.slice(1, close);
  }
  const colon = value.indexOf(':');
  // Two colons and no brackets is an address written bare, not a name followed by a port
  return colon === -1 || value.includes(':', colon + 1) ? value : value.slice(0, colon);
}

/**
 * The allowlist, read once into the two shapes it is matched by: the names answered outright, and
 * the suffixes a `*.` pattern stands for.
 *
 * A pattern exists for a deployment whose name is not fixed — a tunnel that mints a new host on
 * every start, a preview environment per branch — where naming each one would mean editing the
 * configuration as often as the host changes. It covers the subdomains of a domain and never the
 * domain itself, so an apex that is also served is listed on its own. The leading dot is kept in
 * the suffix, and that is the whole of what stops `*.example.com` from also answering to
 * `evil-example.com`.
 */
function allowlist(patterns: readonly string[]): { names: ReadonlySet<string>; suffixes: readonly string[] } {
  const names = new Set<string>();
  const suffixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) suffixes.push(pattern.slice(1));
    else names.add(pattern);
  }
  return { names, suffixes };
}

/**
 * Whether this wrapper answers to the authority the client dialled.
 *
 * A browser sends the name it was pointed at, so a page served from a name with a one-second TTL
 * that rebinds to 127.0.0.1 arrives here carrying that name, and same-origin policy has stopped
 * protecting the install. Refusing an authority nobody configured is what closes it: a local
 * install is reached through loopback, and `CLAUDIO_ALLOWED_HOSTS` names whatever else a
 * deployment answers to.
 *
 * A request with no `Host` at all passes: HTTP/1.1 requires one and every browser sends one, so it
 * cannot be the rebinding case, and refusing it would only cost an HTTP/1.0 probe.
 */
function hostAllowed(authority: string | undefined, allowed: ReturnType<typeof allowlist>, runtime: RuntimeHosts, singleLabel: boolean): boolean {
  if (authority === undefined) return true;
  const name = hostNameOf(authority);
  return (
    LOOPBACK.test(name) ||
    (singleLabel && isSingleLabel(name)) ||
    allowed.names.has(name) ||
    allowed.suffixes.some((suffix) => name.endsWith(suffix)) ||
    runtime.get(name) !== undefined
  );
}

/**
 * A name with no dot that is not an address: what Docker's embedded DNS answers for a compose
 * service (`claudio`). A rebinding attack needs a name the attacker's resolver answers for, and a
 * single label only reaches the local resolver and its search domains, which are the operator's.
 * So a headless Claudio, which runs next to its project's containers, answers to one without the
 * name being configured (docs/plans/headless-image.md, D10). A bare number is an IPv4 address in
 * another spelling (`2130706433` is 127.0.0.1), and is never a name.
 */
export function isSingleLabel(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) && !/^(?:\d+|0x[0-9a-f]+)$/.test(name);
}

/**
 * The key `FailureBackoff` counts a failed credential under. Only a presented credential gets
 * here: for local traffic the address is `127.0.0.1`, shared by every process on the machine, so a
 * request carrying none is refused without touching the count (see `FailureBackoff`).
 * The address alone is not enough: behind `socat`, Docker's published ports or a tunnel, every
 * client arrives from loopback, and keyed by `req.ip` a stranger's ten wrong guesses on the LAN
 * name would make the desktop on `localhost` wait too. So the key is the address and the name the
 * client dialled (`${ip}|${host}`), and the owner's own credential skips the wait altogether once it
 * has worked (`FailureBackoff.retryAfter`).
 * A request on a runtime host is keyed by the header its owner said carries the client's address,
 * and only there: on any other host nobody vouches for that header, and anybody on the machine
 * could set it to spend someone else's budget. Without a header, or without a value in it, the
 * host's traffic still gets a bucket of its own, apart from loopback.
 */
function backoffKey(req: FastifyRequest, runtime: RuntimeHosts): string {
  // No `Host` is no runtime host: the empty name is never one
  const name = req.headers.host === undefined ? '' : hostNameOf(req.headers.host);
  const host = runtime.get(name);
  if (!host) return `${req.ip}|${name}`;
  const header = host.clientIpHeader ? req.headers[host.clientIpHeader] : undefined;
  // The last hop is the one the provider added; whatever comes before it the client could write
  const client = (Array.isArray(header) ? header.at(-1) : header)?.split(',').at(-1)?.trim();
  return client ? `runtime:${name}:${client}` : `runtime:${name}`;
}

/**
 * Whether a request came from a process on this machine and was dialled there, which is the only
 * place the desktop app's secret is ever sent from. A loopback socket is not enough on its own:
 * a tunnel and a reverse proxy both arrive from loopback, carrying the public name they were
 * reached on. `req.ip` is the socket's address, since the app does not trust proxy headers.
 */
function fromLocalMachine(req: FastifyRequest): boolean {
  const host = req.headers.host;
  return LOOPBACK.test(req.ip) && host !== undefined && LOOPBACK.test(hostNameOf(host));
}

/** How a request reached this process: straight, through a proxy on this machine we can vouch for, or relayed by something we cannot */
export type Forwarding = 'direct' | 'untrusted' | { host: string };

/**
 * Whether the forwarding headers on a request can be believed, and what they say. Nothing is
 * trusted by default: a header like `X-Forwarded-For` is whatever its sender wrote. The one proxy
 * we accept is the dev server's (`apps/web/vite.config.ts`, `xfwd: true`) and anything shaped like
 * it: the socket's peer is loopback, the `Host` it passed on is loopback, every hop in
 * `X-Forwarded-For` is loopback and `X-Forwarded-Host` (the page's own authority) is a loopback
 * name. A LAN device browsing the dev server shows up as a hop that is not loopback, a forwarded
 * host that is not loopback, or both, and so is `untrusted`. The standard `Forwarded` header is not
 * parsed: its presence alone is `untrusted`. A peer that is not loopback is never believed.
 */
export function forwardingOf(req: FastifyRequest): Forwarding {
  const { headers } = req;
  const forwardedFor = headers['x-forwarded-for'];
  const forwardedHost = headers['x-forwarded-host'];
  if (headers.forwarded === undefined && forwardedFor === undefined && forwardedHost === undefined) return 'direct';
  const peer = req.socket.remoteAddress;
  const host = headers.host;
  if (headers.forwarded !== undefined || forwardedFor === undefined || (forwardedHost !== undefined && typeof forwardedHost !== 'string')) return 'untrusted';
  if (peer === undefined || !LOOPBACK.test(peer) || host === undefined || !LOOPBACK.test(hostNameOf(host))) return 'untrusted';
  // A WebSocket upgrade through the dev server's proxy carries X-Forwarded-For but no X-Forwarded-Host
  // (its ws path adds for/port/proto only) and keeps the page's Host (`changeOrigin: false`), so the
  // Host, already checked to be loopback, is the name the page was dialled by
  const pageHost = forwardedHost ?? host;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor).split(',').map((hop) => hop.trim());
  if (hops.some((hop) => !LOOPBACK.test(hop.toLowerCase()))) return 'untrusted';
  // A list of hosts is a chain of proxies; one is all the dev server ever writes
  if (pageHost.includes(',') || !LOOPBACK.test(hostNameOf(pageHost))) return 'untrusted';
  return { host: pageHost };
}

/**
 * Whether a request came from this machine and nothing says it was relayed. A chat token may be
 * looked at only then, and the terminal opens under `mode: none` only then (`terminal-gate.ts`):
 * the socket peer is loopback, the name dialled is loopback, and no header says it was forwarded,
 * unless `forwardingOf` vouches for it (the dev server on this machine, reached from this machine).
 * The tunnel (`ssh -R` to 127.0.0.1) and any local reverse proxy arrive from loopback too, so the
 * peer alone would let a leaked chat token in from the internet; they are told apart by the public
 * name they carry and the headers they add. The socket is read rather than `req.ip`, so trusting a
 * proxy one day cannot widen this.
 */
export function fromLocalMachineStrict(req: FastifyRequest, runtime: RuntimeHosts): boolean {
  const peer = req.socket.remoteAddress;
  const host = req.headers.host;
  if (peer === undefined || !LOOPBACK.test(peer) || host === undefined) return false;
  const name = hostNameOf(host);
  // `localhost` is loopback by definition; a runtime host is refused even if it were named so
  if (!LOOPBACK.test(name) || runtime.get(name) !== undefined) return false;
  const forwarding = forwardingOf(req);
  if (forwarding === 'untrusted') return false;
  if (typeof forwarding === 'object' && runtime.get(hostNameOf(forwarding.host)) !== undefined) return false;
  return !runtime.list().some((each) => {
    const header = runtime.get(each)?.clientIpHeader;
    return header !== undefined && req.headers[header] !== undefined;
  });
}

/*
 * What a chat's own token may call is the route's access class in `ROUTE_DOCS` (`person`, `work`;
 * docs/security-model.md, "Chat tokens"), checked once the token is authenticated under a guarded
 * mode. Under `mode: none` the token only labels the request, and nothing but the three exceptions
 * below refuses it: the review gate, Collaborators and the terminal, whose routes check the label
 * themselves because an open install is still the person's, and what these guard must stay theirs
 * there too.
 */

/**
 * The review gate fails closed, so what opens it is the person's: a chat must not accept its own
 * graph's gate (the acceptance is bound to the head) or plant the role file a reviewer reads. Under
 * `mode: none` a chat's token only labels the request, and the label is what refuses it.
 */
const CHAT_FORBIDDEN_REVIEW_GATE = new Set([
  `POST ${API_PREFIX}/orchestrations/:id/review/accept`,
  `POST ${API_PREFIX}/projects/:id/review-roles/:role`,
]);
const CHAT_REVIEW_GATE_REFUSAL = "a chat's token cannot accept a review gate or write a reviewer's role: that is the person's";

/**
 * The terminal is the person's own shell: a chat's token cannot open, read or type into one, and
 * reads are included because the list says which shells are open and where. Under `mode: none` a
 * chat's token only labels the request, and the label is what refuses it here (`terminal-gate.ts`
 * adds the peer-process check for a chat that sends no token at all).
 */
const CHAT_FORBIDDEN_TERMINAL = new Set([
  `GET ${API_PREFIX}/terminal`,
  `PUT ${API_PREFIX}/terminal/settings`,
  `GET ${API_PREFIX}/terminal/history`,
  `GET ${API_PREFIX}/terminals`,
  `POST ${API_PREFIX}/terminals`,
  `GET ${API_PREFIX}/terminals/:id`,
  `POST ${API_PREFIX}/terminals/:id/ticket`,
  `GET ${API_PREFIX}/terminals/:id/socket`,
  `DELETE ${API_PREFIX}/terminals/:id`,
]);

/**
 * Collaborators carries teammates' work, transcripts with their tool output included: a chat's token
 * must never pull one into its own context unasked, nor change who this install shares with. Every
 * route is here, reads included, and like the terminal's it is refused under `mode: none` too, where
 * the token only labels the request. The copy reads of `AGENT_READABLE` are the one way out, and only
 * for a chat in scope (docs/plans/collaborators-agent-access.md).
 */
const CHAT_FORBIDDEN_COLLABORATORS = new Set([
  `GET ${API_PREFIX}/collaborators`,
  `PUT ${API_PREFIX}/collaborators`,
  `GET ${API_PREFIX}/collaborators/groups`,
  `POST ${API_PREFIX}/collaborators/groups`,
  `DELETE ${API_PREFIX}/collaborators/groups/:id`,
  `POST ${API_PREFIX}/collaborators/groups/:id/invites`,
  `POST ${API_PREFIX}/collaborators/join`,
  `DELETE ${API_PREFIX}/collaborators/join/:groupId`,
  `GET ${API_PREFIX}/collaborators/groups/:id/join-requests`,
  `POST ${API_PREFIX}/collaborators/groups/:id/join-requests/:from/accept`,
  `POST ${API_PREFIX}/collaborators/groups/:id/join-requests/:from/deny`,
  `DELETE ${API_PREFIX}/collaborators/groups/:id/members/:endpointId`,
  `PUT ${API_PREFIX}/collaborators/groups/:id/owner`,
  `GET ${API_PREFIX}/projects/:id/sharing`,
  `PUT ${API_PREFIX}/projects/:id/sharing`,
  `GET ${API_PREFIX}/collaborators/shared`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId`,
  `PUT ${API_PREFIX}/collaborators/shared/:owner/:shareId/link`,
  `DELETE ${API_PREFIX}/collaborators/shared/:owner/:shareId/link`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/chats`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/memory`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/journal`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/documents`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/work-items`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/artifacts`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/chats/:chatId/transcript`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/chats/:chatId/subagents/:agentId`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/blobs/:sha256`,
  `GET ${API_PREFIX}/collaborators/agent-reads`,
]);

const CHAT_COLLABORATORS_REFUSAL = "a chat's token cannot read or change Collaborators: what teammates share is the person's alone";

/**
 * The reads of a teammate's copy a chat's token may make, when `agentReadScope` lets it: the
 * assistant every copy whose sharer allows it, a chat of a project that opted in only that project's
 * copies, and never a chat that runs commands without asking. Blobs are not here: an agent is told an
 * upload's name and size, never handed its bytes. Nothing else of Collaborators is, either: linking,
 * settings and a project's sharing stay the person's.
 */
export const AGENT_READABLE = new Set([
  `GET ${API_PREFIX}/collaborators/shared`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/chats`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/memory`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/journal`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/documents`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/work-items`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/artifacts`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/chats/:chatId/transcript`,
  `GET ${API_PREFIX}/collaborators/shared/:owner/:shareId/chats/:chatId/subagents/:agentId`,
]);

/** What each refusal of `agentReadScope` tells the agent, so its tool can say why it read nothing */
const AGENT_READ_REFUSALS: Record<AgentReadRefusal | 'copy', string> = {
  off: 'Collaborators is off on this install',
  'assistant-off': "the person turned off the assistant's reads of what teammates share",
  'no-chat': 'no chat of this install holds this token',
  mode: "a chat that runs commands without asking cannot read teammates' shares",
  'no-project': "a chat under no project cannot read teammates' shares",
  'project-off': "this chat's project does not let its agents read what teammates share",
  copy: "this chat cannot read that shared project: it is not its project's, or its sharer does not let agents read it",
};

/**
 * Whether a chat's token may make this copy read, and if not, the refusal to answer. The scope is
 * the chat's now; the copy, when the route names one, has to be in it. The list is filtered by the
 * route itself, from the same scope.
 */
export async function agentReadRefusal(core: Pick<Core, 'agentReadScope' | 'collaborators'>, chatId: string, params: { owner?: unknown; shareId?: unknown } | undefined): Promise<{ code: string; error: string } | null> {
  const decision = core.agentReadScope(chatId);
  if ('refusal' in decision) return { code: `collaborators.agent-read.${decision.refusal}`, error: AGENT_READ_REFUSALS[decision.refusal] };
  const { owner, shareId } = params ?? {};
  if (owner === undefined && shareId === undefined) return null;
  if (typeof owner === 'string' && typeof shareId === 'string' && (await core.collaborators.agentMayRead(decision.scope, owner, shareId))) return null;
  return { code: 'collaborators.agent-read.copy', error: AGENT_READ_REFUSALS.copy };
}

/**
 * The browser's `WebSocket` cannot send `Authorization`, so the terminal's socket carries its own
 * proof: a one-time ticket that the bearer-authenticated `POST /terminals/:id/ticket` handed out.
 * The route checks it, after the host allowlist, read-only and the gate, and a wrong one counts in
 * the back-off like a wrong token.
 */
const TERMINAL_SOCKET = 'GET /terminals/:id/socket';

/**
 * The desktop app's secret exists to let its tray read what is live, so it reads and nothing
 * else: a secret that has to sit in a second process's memory is kept to the least it needs.
 */
const DESKTOP_METHODS = new Set(['GET', 'HEAD']);

/**
 * The exception (docs/plans/unified-updates.md, D8): where the desktop shell supervises the server
 * (`CLAUDIO_LAUNCHER=desktop`), the page in its window holds no owner credential, so the shell makes
 * the payload's update writes itself with its per-launch secret. Exactly these four, and only there;
 * under auth `none` they are the only routes that read a credential at all, so an agent's `curl` to
 * 127.0.0.1, which cannot hold the shell's secret, stays `local` and is refused by the routes.
 */
const DESKTOP_UPDATE_WRITES = new Set([
  `POST ${API_PREFIX}/system/server-update/download`,
  `POST ${API_PREFIX}/system/server-update/apply`,
  `DELETE ${API_PREFIX}/system/server-update/scheduled`,
  `POST ${API_PREFIX}/system/server-update/revert`,
]);

/** Failed authentications a client address gets for free before it is asked to wait. */
const FAILURES_BEFORE_WAIT = 10;
const FIRST_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
/** A client that stops failing for this long is forgotten: a mistyped token leaves no trace. */
const FORGET_AFTER_MS = 15 * 60_000;
/** The map is fed by whoever can reach the port, so it is bounded rather than trusted. */
const MAX_CLIENTS = 1024;
/** Credentials remembered as having worked: the owner's token, a few chats', an OIDC token or two */
const MAX_TRUSTED = 64;

interface Failures {
  count: number;
  /** The last failure; both the wait and the forgetting are measured from it */
  at: number;
}

/** A credential is remembered by its hash only, so the map never holds a secret */
const credentialHash = (credential: string): string => createHash('sha256').update(credential).digest('hex');

/**
 * Failed authentications per client, with a wait that doubles.
 *
 * Written here rather than pulled in as a rate-limiting plugin, for the reason `cron.ts` gives for
 * its own parser: what this needs is a count and an instant per address, and a plugin would bring
 * a store, a policy language and a dependency to hold them. A token Claudio generates is 32 random
 * bytes and out of reach of guessing, but a token someone chooses is accepted from 16 characters,
 * and 16 characters under an unlimited online attack are not enough.
 *
 * The wait is per client (`backoffKey`: the address and the name dialled), not per credential, so
 * whoever shares both with an attacker would pay it too. What keeps the owner out of it is the
 * credential itself: one whose hash last succeeded is never made to wait, since being able to
 * present it is the proof the wait exists to ask for. A success does not wipe the count either: on
 * a shared key that would hand the guesser beside the owner a fresh allowance at every poll.
 *
 * Only a credential that was presented and failed is counted. A request with none at all is not a
 * guess: it cannot get closer to the token by repeating itself, and on a local install every
 * process on the machine shares 127.0.0.1, so a tray, a stale tab or a chat polling without a
 * credential would otherwise make the owner's own authenticated window wait.
 */
export class FailureBackoff {
  private readonly clients = new Map<string, Failures>();
  /** Hashes of the credentials that last succeeded, least recent first */
  private readonly trusted = new Set<string>();

  /** The clock is a parameter so a test can watch a wait grow and a client be forgotten. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Seconds before this client's credential is looked at again; 0 when it may try now. A credential
   * that last succeeded is looked at at once: if it no longer works, `fail` forgets it.
   */
  retryAfter(client: string, credential?: string): number {
    if (credential !== undefined && this.trusted.has(credentialHash(credential))) return 0;
    const seen = this.clients.get(client);
    if (!seen) return 0;
    const now = this.now();
    if (now - seen.at >= FORGET_AFTER_MS) return 0;
    const remaining = seen.at + this.waitMs(seen.count) - now;
    return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
  }

  fail(client: string, credential?: string): void {
    // Revoked or rotated since it last worked: it waits like any other guess from now on
    if (credential !== undefined) this.trusted.delete(credentialHash(credential));
    const now = this.now();
    const seen = this.clients.get(client);
    const count = seen && now - seen.at < FORGET_AFTER_MS ? seen.count + 1 : 1;
    // Re-inserted, so the map runs least-recent first and eviction drops from the front
    this.clients.delete(client);
    this.clients.set(client, { count, at: now });
    this.evict(now);
  }

  /** Remembers the credential that worked; the client's failures stay counted (see the class) */
  succeed(credential: string): void {
    const hash = credentialHash(credential);
    this.trusted.delete(hash);
    this.trusted.add(hash);
    for (const old of this.trusted) {
      if (this.trusted.size <= MAX_TRUSTED) break;
      this.trusted.delete(old);
    }
  }

  /** Addresses remembered right now. Bounded by `MAX_CLIENTS`, which is what a test checks. */
  get size(): number {
    return this.clients.size;
  }

  private waitMs(count: number): number {
    if (count < FAILURES_BEFORE_WAIT) return 0;
    return Math.min(FIRST_WAIT_MS * 2 ** (count - FAILURES_BEFORE_WAIT), MAX_WAIT_MS);
  }

  private evict(now: number): void {
    if (this.clients.size <= MAX_CLIENTS) return;
    for (const [client, seen] of this.clients) {
      if (this.clients.size <= MAX_CLIENTS) return;
      if (now - seen.at >= FORGET_AFTER_MS) this.clients.delete(client);
    }
    // Still full: the least recent failure goes, which at worst hands one client a clean slate
    for (const client of this.clients.keys()) {
      if (this.clients.size <= MAX_CLIENTS) return;
      this.clients.delete(client);
    }
  }
}

/**
 * What read-only still lets through. Answering a prompt is the point of it: a person watching a
 * chat has to be able to unblock it. The guard's own switch stays reachable because a switch that
 * cannot be turned back is a trap, and it is administration of the wrapper, not of its work.
 */
const READ_ONLY_ALLOWED = new Set(['POST /chats/:id/permissions/:requestId', 'PUT /security/auth']);

/** The OpenAI-compatible surface, which needs a credential in every mode */
const OPENAI_SURFACE = new RegExp(`^${API_PREFIX}/v1(?:/|$)`);

/** A path this process serves itself and guards: the API and its documentation */
const guardedPath = (path: string): boolean => path === '/openapi.json' || path === '/docs' || path.startsWith('/docs/') || path.startsWith(`${API_PREFIX}/`);

/**
 * Whether a request is guarded. The matched route decides: Fastify routes on the decoded path, so
 * the raw target is only a spelling of it (report §8.1: `/%61pi/chats` reached `/api/chats`
 * unguarded). A request no route took is guarded unless it is the web app's own, a file of the
 * bundle or the page the router falls back to: the UI is public so a 401 has a page to show. The
 * raw path can be read for that because `plainTarget` refused every other spelling first.
 */
const isGuarded = (routeUrl: string | undefined, path: string): boolean => (routeUrl !== undefined && guardedPath(routeUrl)) || guardedPath(path);

/** The matched route keyed as `ROUTE_DOCS` keys it (`POST /chats/:id/stop`), or null for what is not an API route */
function apiRoute(req: FastifyRequest): string | null {
  const url = req.routeOptions.url;
  return url?.startsWith(`${API_PREFIX}/`) ? `${req.method} ${url.slice(API_PREFIX.length)}` : null;
}

const pathOf = (url: string): string => url.split('?')[0] ?? url;

/**
 * The letters, digits and `-._~` of RFC 3986: a client never has to percent-encode them, so an
 * encoded one is only ever another spelling of a path (`/%61pi`, `/%2e%2e/`).
 */
const ENCODED_UNRESERVED = /%(?:[46][1-9a-f]|[57][0-9a]|3[0-9]|2[de]|5f|7e)/i;
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;

/**
 * Whether the request target is a plain origin-form path, the one spelling the guard reads. An
 * absolute-form target (`GET http://x/api/health`), a dot segment, a malformed escape or an encoded
 * unreserved character is refused before anything else. Escapes of anything else stay: a file or
 * server name with a space or an accent in it is a real path, and the route is what decides.
 */
function plainTarget(url: string, path: string): boolean {
  if (!url.startsWith('/') || DOT_SEGMENT.test(path) || ENCODED_UNRESERVED.test(path)) return false;
  try {
    decodeURI(path);
    return true;
  } catch {
    return false;
  }
}

function credentialOf(req: FastifyRequest, route: string | null): string | undefined {
  const [scheme, ...rest] = (req.headers.authorization ?? '').split(' ');
  // An empty bearer is no credential rather than a wrong one, so it is not counted as a guess
  if (scheme?.toLowerCase() === 'bearer' && rest.length) return rest.join(' ').trim() || undefined;
  // A header that is not a bearer token (a proxy's own `Basic`, say) is not ours: fall through
  if (route === null || !QUERY_TOKEN.has(route)) return undefined;
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === 'string' && token ? token : undefined;
}

/**
 * One line about what a request did, taken from the route's own documentation. Built from the
 * route and never from the payload: a body holds prompts and secrets and is not written down.
 */
export function auditSummary(method: string, routeUrl: string | undefined, path: string): string {
  const route = auditRoute(method, routeUrl);
  const doc = route ? ROUTE_DOCS[route] : undefined;
  return doc?.summary ?? `${method} ${path}`;
}

/**
 * The route a request matched, keyed as `ROUTE_DOCS` keys it (`POST /chats/:id/stop`), or null when
 * Fastify matched none. Stored beside the English summary so the web can word the row in the
 * reader's language (`auditRoutes` in its locales) without a second copy of every summary here.
 */
export function auditRoute(method: string, routeUrl: string | undefined): string | null {
  const pattern = routeUrl?.startsWith(`${API_PREFIX}/`) ? routeUrl.slice(API_PREFIX.length) : undefined;
  return pattern ? `${method} ${pattern}` : null;
}

/**
 * Whether an actor is the owner: the holder of the owner token or an OIDC identity. Not the open
 * install's `local`, the desktop app's own credential, a chat, a webhook or nobody.
 */
export function isOwnerActor(actor: string | null): actor is string {
  if (actor === null) return false;
  return actor !== 'local' && actor !== DESKTOP_ACTOR && actor !== 'anonymous' && actor !== 'webhook' && !actor.startsWith('chat:');
}

/** Whether `Accept` ranks `text/html` above JSON: a person typing a URL, not a script */
function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  const types = accept.split(',').map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '');
  const html = types.indexOf('text/html');
  const json = types.findIndex((type) => type === 'application/json' || type === 'application/*');
  return html !== -1 && (json === -1 || html < json);
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * What a person sees when they type an unlisted host's `/api/...` or `/docs` into a browser. Plain
 * HTML with no script and no stylesheet, English only (there is no locale before the app loads); the
 * app's own screen at `/` is where the token form lives.
 */
export function hostRefusalPage(host: string): string {
  const name = host.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>This Claudio does not answer to ${name} yet</title>
</head>
<body>
<main>
<h1>This Claudio does not answer to <code>${name}</code> yet</h1>
<p>It answers only to the addresses it was told about, so that no other site can drive it from your browser.</p>
<p>Add it where Claudio runs: name it in CLAUDIO_ALLOWED_HOSTS when you start the container, or open Claudio on localhost and add it in Settings &rarr; Access &amp; safety &rarr; Allowed hosts.</p>
<p>If this Claudio is protected with a token, <a href="/">open the app on this address</a>: it offers to add the host when you paste the owner token.</p>
</main>
</body>
</html>
`;
}

/** What the terminal's routes share with the guard: the back-off a wrong ticket counts in, and the key it counts under */
export interface Guard {
  backoff: FailureBackoff;
  backoffKey(req: FastifyRequest): string;
}

export function registerSecurity(app: FastifyInstance, core: Core): Guard {
  // `null` and not a string: Fastify v5 refuses a shared reference, and the value is per request
  app.decorateRequest('actor', null);

  // Read on every request, because the settings page can change it, but only rebuilt when it did:
  // the store hands out the same array until then. It comes from the core rather than from
  // `process.env`, so a test can build a wrapper with its own.
  let configured = { from: core.appSettings.allowedHosts, allowed: allowlist(core.appSettings.allowedHosts) };
  const allowedHosts = (): ReturnType<typeof allowlist> => {
    const from = core.appSettings.allowedHosts;
    if (from !== configured.from) configured = { from, allowed: allowlist(from) };
    return configured.allowed;
  };
  const runtimeHosts = core.appSettings.runtimeHosts;
  const backoff = new FailureBackoff();
  // Requests a chat's token authenticated under a guarded mode: `preHandler` reads their bodies
  const chatCredentials = new WeakSet<FastifyRequest>();
  const desktopUpdateWrite = (req: FastifyRequest): boolean => core.serverUpdates.desktopHost && DESKTOP_UPDATE_WRITES.has(`${req.method} ${req.routeOptions.url ?? ''}`);

  /**
   * Checks the credential a request presents, the one flow every guarded check goes through: no
   * credential is refused without touching the back-off, a client in its back-off waits (429) unless
   * the credential is one that last worked, a wrong credential counts and is refused, a right one is
   * remembered and names the actor. `resolve` says whose a credential is; `refuse` writes the 401 of
   * the caller's rule. Returns the actor, or null once the reply has been sent.
   */
  const authenticate = async (
    req: FastifyRequest,
    reply: FastifyReply,
    route: string | null,
    mode: string,
    refuse: () => unknown,
    resolve: (credential: string) => Promise<{ actor: string; chat: boolean } | null>,
  ): Promise<{ actor: string; chat: boolean } | null> => {
    const credential = credentialOf(req, route);
    // Nothing to check is nothing guessed: neither counted nor made to wait, so a local process
    // polling without a credential cannot lock the owner out of their own install
    if (credential === undefined) {
      void refuse();
      return null;
    }
    const client = backoffKey(req, runtimeHosts);
    const wait = backoff.retryAfter(client, credential);
    if (wait > 0) {
      req.actor = 'anonymous';
      // Not counted as another failure: a client that kept trying would never serve its wait
      void reply.header('Retry-After', String(wait)).status(429).send({ error: 'too many failed authentications from this address', mode });
      return null;
    }
    const found = await resolve(credential);
    if (!found) {
      backoff.fail(client, credential);
      void refuse();
      return null;
    }
    backoff.succeed(credential);
    req.actor = found.actor;
    return found;
  };

  app.addHook('onRequest', async (req, reply) => {
    const path = pathOf(req.url);
    // Before anything else, a preflight included: every rule below reads one spelling of the path
    if (!plainTarget(req.url, path)) {
      req.actor = 'anonymous';
      void reply.status(400).send({
        error: 'the request target must be a plain path: no absolute URL, no `.` or `..` segment, and no letter, digit or `-._~` percent-encoded',
        code: 'request-target',
      });
      return reply;
    }
    // A CORS preflight carries no credential by definition, and answering it reveals nothing
    if (req.method === 'OPTIONS') return;
    const route = apiRoute(req);
    const guarded = isGuarded(req.routeOptions.url, path);
    // A request no route took needs a credential, and there is nothing behind it to refuse a chat
    const access = route ? accessOf(req.method, route.slice(route.indexOf(' ') + 1)) : 'work';
    const receiver = guarded && access === 'open' && route !== null && RECEIVERS.has(route);
    const probe = guarded && access === 'open' && !receiver;
    const mode = core.security.mode;
    // Before the credential, because an authority this wrapper does not serve is refused whether
    // or not the caller holds one: under `mode: 'none'` there is no credential to refuse it by
    if (guarded && !probe && route !== HOST_CLAIM && !hostAllowed(req.headers.host, allowedHosts(), runtimeHosts, core.profile === 'headless')) {
      req.actor = 'anonymous';
      const host = hostNameOf(req.headers.host ?? '');
      if (req.method === 'GET' && prefersHtml(req.headers.accept)) {
        void reply.status(421).type('text/html; charset=utf-8').send(hostRefusalPage(host));
        return reply;
      }
      const refusal: HostRefusal = {
        error: 'this wrapper does not answer to that host. Reach it on localhost, or name the host in CLAUDIO_ALLOWED_HOSTS.',
        code: 'host-not-allowed',
        host,
        mode,
        canClaim: (mode === 'token' || mode === 'oidc') && !core.security.readOnly,
        firstRunToken: core.security.firstRunPending,
      };
      void reply.status(421).send(refusal);
      return reply;
    }
    if (probe) return;
    if (receiver) {
      req.actor = 'webhook';
      return;
    }
    // With nothing to authenticate, the browser itself is the only thing that tells a page of this
    // app from a page of any other site that posts here: a body-less POST is a simple request no
    // preflight stops (report §8.8). Guarded modes need a bearer token, which no page sends unasked
    if (mode === 'none' && guarded && MUTATING.has(req.method) && !(route !== null && OWN_ORIGIN_CHECK.has(route)) && crossSite(req)) {
      req.actor = 'anonymous';
      void reply.status(403).send({ error: 'a page of another site cannot change anything here', code: 'cross-site' });
      return reply;
    }
    // A socket's ticket is its credential; the route checks it once the gate has had its say
    const ticketed = route === TERMINAL_SOCKET;
    if (ticketed && mode !== 'none') req.actor = 'anonymous';
    if (guarded && mode !== 'none' && !ticketed) {
      // Still audited when it is a write, and as what it was: nobody we could name
      const refuse = () => {
        req.actor = 'anonymous';
        // The mode travels with the refusal: it is what tells the UI whether to ask for a token
        // or to send the person to their identity provider, without an open route to ask first.
        return reply
          .header('WWW-Authenticate', mode === 'token' ? 'Bearer realm="Claudio"' : `Bearer realm="Claudio", error="invalid_token"`)
          .status(401)
          .send({ error: 'authentication required', mode, ...(core.security.firstRunPending ? { firstRunToken: true } : {}) });
      };
      const found = await authenticate(req, reply, route, mode, refuse, async (credential) => {
        const owner = await core.security.actorFor(credential, fromLocalMachine(req));
        // The owner's credential first; a chat token is only ever the fallback, and fails the same
        // way. Told apart by where it came from, not by its prefix: an OIDC subject could be anything
        const chat = owner === null ? core.security.chatActorFor(credential, fromLocalMachineStrict(req, runtimeHosts)) : null;
        const actor = owner ?? chat;
        return actor ? { actor, chat: chat !== null } : null;
      });
      if (!found) return reply;
      if (found.actor === DESKTOP_ACTOR && !DESKTOP_METHODS.has(req.method) && !desktopUpdateWrite(req)) {
        void reply.status(403).send({ error: "the desktop app's own credential only reads; sign in with the API token to change anything" });
        return reply;
      }
      if (found.chat) chatCredentials.add(req);
    }
    // The OpenAI-compatible routes start chats that may run commands for whoever calls them, so an
    // open install still asks them for a credential: the owner's token, or a chat's own from this
    // machine (docs/openai-compatible-api.md). Guarded modes already asked above
    if (mode === 'none' && guarded && (OPENAI_SURFACE.test(req.routeOptions.url ?? '') || OPENAI_SURFACE.test(path))) {
      const refuse = (): void => {
        req.actor = 'anonymous';
        const error = core.security.config.tokenSet
          ? 'authentication required: send the API token as `Authorization: Bearer <token>`'
          : 'authentication required: this API runs commands for its callers, so it needs a token even with authentication off. Set one in Settings → Access & safety (or `POST /api/security/token`) and send it as `Authorization: Bearer <token>`';
        void reply.header('WWW-Authenticate', 'Bearer realm="Claudio"').status(401).send({ error, mode });
      };
      const found = await authenticate(req, reply, route, mode, refuse, async (credential) => {
        // The owner's API token whatever the mode, or a chat's own from this machine
        const actor = core.security.credentialActorFor(credential, fromLocalMachineStrict(req, runtimeHosts));
        return actor ? { actor, chat: actor.startsWith('chat:') } : null;
      });
      if (!found) return reply;
    }
    // Open mode grants everything already, so a chat's token only labels who wrote: a missing, wrong
    // or expired one leaves `local` and is never refused
    if (mode === 'none' && req.actor === null && desktopUpdateWrite(req) && core.security.isDesktopCredential(credentialOf(req, route), fromLocalMachine(req))) {
      req.actor = DESKTOP_ACTOR;
    }
    if (mode === 'none' && req.actor === null) {
      const presented = credentialOf(req, route);
      const chatId = presented === undefined ? null : core.security.chatTokens.verify(presented);
      if (chatId !== null) req.actor = chatActor(chatId);
    }
    req.actor ??= 'local';

    // The three exceptions, which hold in every mode (see the note above the review gate's set)
    const key = `${req.method} ${req.routeOptions.url ?? path}`;
    if (req.actor.startsWith('chat:') && CHAT_FORBIDDEN_REVIEW_GATE.has(key)) {
      void reply.status(403).send({ error: CHAT_REVIEW_GATE_REFUSAL, code: 'chat-forbidden' });
      return reply;
    }

    if (req.actor.startsWith('chat:') && AGENT_READABLE.has(key)) {
      const refusal = await agentReadRefusal(core, req.actor.slice('chat:'.length), req.params as { owner?: unknown; shareId?: unknown } | undefined);
      if (refusal) {
        void reply.status(403).send(refusal);
        return reply;
      }
    } else if (req.actor.startsWith('chat:') && CHAT_FORBIDDEN_COLLABORATORS.has(key)) {
      void reply.status(403).send({ error: CHAT_COLLABORATORS_REFUSAL, code: 'collaborators.chat-token' });
      return reply;
    }

    if (req.actor.startsWith('chat:') && CHAT_FORBIDDEN_TERMINAL.has(key)) {
      const id = (req.params as { id?: unknown } | undefined)?.id;
      core.terminals.recordRefusal({
        terminalId: typeof id === 'string' && core.terminals.get(id) ? id : null,
        actor: req.actor,
        client: fromLocalMachineStrict(req, runtimeHosts) ? 'local' : (req.socket.remoteAddress ?? 'unknown'),
        origin: req.headers.origin ?? null,
        reason: 'chat-token',
      });
      void reply.status(403).send({
        error: "a chat's token cannot open, read or type into a terminal: the terminal is the person's",
        code: 'terminal.chat-token',
        reason: 'chat-token',
      });
      return reply;
    }

    // The class of the matched route, for a chat's token a guarded mode authenticated
    if (chatCredentials.has(req) && access === 'person') {
      const summary = route ? ROUTE_DOCS[route]?.summary : undefined;
      void reply.status(403).send({
        error: `a chat's token cannot do this${summary ? ` (${summary.charAt(0).toLowerCase()}${summary.slice(1)})` : ''}: it is the person's`,
        code: 'chat-forbidden',
      });
      return reply;
    }

    if (core.security.readOnly && MUTATING.has(req.method) && guarded) {
      if (route === null || !READ_ONLY_ALLOWED.has(route)) {
        void reply.status(405).send({
          error: 'read-only mode is on: this wrapper accepts no changes. Turn it off with PUT /api/security/auth, which stays open for exactly that.',
        });
        return reply;
      }
    }
    return;
  });

  // The body of a `work` write a chat's token sends holds only the fields the route lists for it
  // (`workFields`): a sibling started with `bypassPermissions` or a wider tool list would undo the
  // rules the class enforces (report §8.3). Read once the body is parsed, so in `preHandler`
  app.addHook('preHandler', async (req, reply) => {
    if (!chatCredentials.has(req)) return;
    const route = apiRoute(req);
    const fields = route ? ROUTE_DOCS[route]?.workFields : undefined;
    const body: unknown = req.body;
    if (!fields || body === null || typeof body !== 'object' || Array.isArray(body)) return;
    const field = Object.keys(body).find((name) => !fields.includes(name));
    if (field === undefined) return;
    void reply.status(403).send({
      error: `a chat's token cannot set \`${field}\` here: it is the person's. An agent may send ${fields.map((name) => `\`${name}\``).join(', ')}`,
      code: 'chat-forbidden-field',
      field,
    });
    return reply;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method) || req.actor === 'webhook') return;
    const path = pathOf(req.url);
    const anonymous = req.actor === 'anonymous';
    // A refused spelling of a path is a refusal like the others, whatever it looked like
    if (!anonymous && !(req.routeOptions.url ?? path).startsWith(`${API_PREFIX}/`) && !path.startsWith(`${API_PREFIX}/`)) return;
    const stored = path.length > MAX_AUDIT_PATH ? path.slice(0, MAX_AUDIT_PATH) : path;
    const entry = {
      at: new Date().toISOString(),
      actor: req.actor ?? 'local',
      method: req.method,
      // The query string is dropped: it can carry `?token=`, and the path is what a filter needs
      path: stored,
      status: reply.statusCode,
      summary: auditSummary(req.method, req.routeOptions.url, stored),
      route: auditRoute(req.method, req.routeOptions.url),
    };
    // Whoever can reach the port writes these, so they go to their own small ring and can never
    // push what identified callers did out of the log
    if (anonymous) core.db.appendAuditRefusal(entry);
    else core.db.appendAudit(entry);
  });

  return { backoff, backoffKey: (req) => backoffKey(req, runtimeHosts) };
}

/**
 * Whether a write comes from a page of another site. A request with no `Origin` and no
 * `Sec-Fetch-Site` is not a browser's (a CLI, a script, a chat's `curl`) and passes; an origin on
 * `CLAUDIO_CORS_ORIGIN` passes; otherwise the page must have been served from the authority it is
 * writing to (behind the dev server, the one it forwarded). An opaque origin (`null`) is never ours.
 */
function crossSite(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && allowedOrigin(origin) !== null) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  if (origin === undefined) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const forwarding = forwardingOf(req);
  const own = typeof forwarding === 'object' ? forwarding.host : req.headers.host;
  return own === undefined || host.toLowerCase() !== own.toLowerCase();
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Who made the request: a token id, an OIDC subject, `desktop`, `chat:<chatId>`, `webhook`, `anonymous` for a refused host, or `local` when nothing guards the API */
    actor: string | null;
  }
}
