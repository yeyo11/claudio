import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DESKTOP_ACTOR, TYPED_COMPACT, chatActor, type AgentReadRefusal, type Core, type RuntimeHosts } from '@claudio/core';
import { ROUTE_DOCS } from './openapi/routes.ts';

/**
 * The guard in front of every route, and the audit trail behind every write.
 *
 * Both are hooks on the root instance rather than a plugin around the API: `/docs` and
 * `/openapi.json` are registered outside the `/api` prefix and must be guarded too, and a hook is
 * the only thing a hijacked reply (the event streams) still goes through.
 */

const API_PREFIX = '/api';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Liveness has to answer a probe that carries no credential. It says nothing about the install. */
const OPEN = new Set([`${API_PREFIX}/health`]);

/**
 * The receivers a code host delivers to. The host cannot send a bearer token; a delivery is
 * believed by its signature (or token header), checked over the raw body inside the route. They
 * answer to no actor, write no audit line (a delivery is not the person's change, and a host may
 * send many) and stay open in read-only mode, since a delivery only moves a next read to now. The
 * host allowlist still applies.
 */
const WEBHOOK_RECEIVER = /^\/api\/webhooks\/(?:github|gitlab)\/[^/]+$/;

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
const QUERY_TOKEN = [
  /^\/api\/events$/,
  /^\/api\/chats\/[^/]+\/stream$/,
  /^\/api\/uploads\/[^/]+\/content$/,
  /^\/api\/chats\/[^/]+\/export$/,
  /^\/api\/projects\/[^/]+\/export$/,
  /^\/api\/eval-runs\/[^/]+\/export$/,
];

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
function hostAllowed(authority: string | undefined, allowed: ReturnType<typeof allowlist>, runtime: RuntimeHosts): boolean {
  if (authority === undefined) return true;
  const name = hostNameOf(authority);
  return LOOPBACK.test(name) || allowed.names.has(name) || allowed.suffixes.some((suffix) => name.endsWith(suffix)) || runtime.get(name) !== undefined;
}

/**
 * The key `FailureBackoff` counts a failed credential under. Only a presented credential gets
 * here: for local traffic the key is `127.0.0.1`, shared by every process on the machine, so a
 * request carrying none is refused without touching the count (see `FailureBackoff`).
 * Everything through a tunnel arrives from loopback, so keyed by `req.ip` a stranger's ten wrong
 * guesses would make the owner wait too.
 * A request on a runtime host is keyed by the header its owner said carries the client's address,
 * and only there: on any other host nobody vouches for that header, and anybody on the machine
 * could set it to spend someone else's budget. Without a header, or without a value in it, the
 * host's traffic still gets a bucket of its own, apart from loopback.
 */
function backoffKey(req: FastifyRequest, runtime: RuntimeHosts): string {
  // No `Host` is no runtime host: the empty name is never one
  const name = req.headers.host === undefined ? '' : hostNameOf(req.headers.host);
  const host = runtime.get(name);
  if (!host) return req.ip;
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

/**
 * What a chat's own token cannot do: administer the guard in front of it. A prompt injection
 * holding it could otherwise rotate the owner's token, switch the guard off or open the tunnel.
 * Stopping the tunnel stays allowed, because it only reduces exposure.
 */
const CHAT_FORBIDDEN = new Set([
  `PUT ${API_PREFIX}/security/auth`,
  `POST ${API_PREFIX}/security/token`,
  `DELETE ${API_PREFIX}/security/token`,
  `POST ${API_PREFIX}/tunnel/start`,
  `PUT ${API_PREFIX}/tunnel/settings`,
  // It names a binary Claudio will run, so a prompt injection must not be able to point it at one
  `PUT ${API_PREFIX}/providers/settings`,
  `POST ${API_PREFIX}/providers/refresh`,
  // Letting a graph run past the daily spend cap is the person's click: an agent that could grant itself the pass would have no cap
  `POST ${API_PREFIX}/orchestrations/:id/spend-pass`,
  `POST ${API_PREFIX}/work-items/:itemId/spend-pass`,
  // Same for the code hosts: the settings name the gh or glab binary Claudio will run
  `PUT ${API_PREFIX}/hosts/settings`,
  `POST ${API_PREFIX}/hosts/refresh`,
  // And the trackers: the same binaries
  `PUT ${API_PREFIX}/trackers/settings`,
  `POST ${API_PREFIX}/trackers/refresh`,
  // YouTrack's token is the one tracker secret Claudio keeps: a chat neither reads where it points nor changes it
  `GET ${API_PREFIX}/trackers/youtrack/credentials`,
  `PUT ${API_PREFIX}/trackers/youtrack/credentials`,
  `DELETE ${API_PREFIX}/trackers/youtrack/credentials`,
  // Only a person weakens or probes a guard: an agent that could switch its own off, or ask what it blocks, would have none
  `PUT ${API_PREFIX}/settings/guards`,
  `POST ${API_PREFIX}/guards/check`,
]);

/**
 * A sign-in hands a CLI a key or shows a device code meant for the person: a prompt injection must
 * not start one, read one's code, end one or sign a tool out. What is set up (`GET /setup`) stays readable.
 */
const CHAT_FORBIDDEN_SETUP = new Set([
  `POST ${API_PREFIX}/setup/seen`,
  `POST ${API_PREFIX}/setup/logins`,
  `GET ${API_PREFIX}/setup/logins/:id`,
  `DELETE ${API_PREFIX}/setup/logins/:id`,
  `DELETE ${API_PREFIX}/setup/credentials/:tool`,
]);

/**
 * An account is a sign-in or a secret on this machine: adding, signing in, removing, enabling,
 * renaming and the rotation settings and policies are the person's. A chat's token cannot even read
 * a sign-in (it carries the page the person opens). The accounts, their usage and the events stay
 * readable.
 */
const CHAT_FORBIDDEN_ACCOUNTS = new Set([
  `POST ${API_PREFIX}/accounts`,
  `POST ${API_PREFIX}/accounts/token`,
  `POST ${API_PREFIX}/accounts/:id/login`,
  `POST ${API_PREFIX}/accounts/refresh`,
  `POST ${API_PREFIX}/accounts/:id/refresh`,
  `POST ${API_PREFIX}/chats/:id/account`,
  `GET ${API_PREFIX}/accounts/logins/:id`,
  `POST ${API_PREFIX}/accounts/logins/:id/code`,
  `DELETE ${API_PREFIX}/accounts/logins/:id`,
  `PATCH ${API_PREFIX}/accounts/:id`,
  `DELETE ${API_PREFIX}/accounts/:id`,
  `PUT ${API_PREFIX}/accounts/settings`,
  `PUT ${API_PREFIX}/accounts/model-fallbacks`,
  `POST ${API_PREFIX}/accounts/policies`,
  `PUT ${API_PREFIX}/accounts/policies/:id`,
  `DELETE ${API_PREFIX}/accounts/policies/:id`,
]);

/** How Home is laid out is the person's own setting; a chat may read it. */
const CHAT_FORBIDDEN_LAYOUT = new Set([`PUT ${API_PREFIX}/dashboard/layout`, `DELETE ${API_PREFIX}/dashboard/layout`]);

/**
 * What a limit does with the person's work is theirs to choose: a prompt injection in a transcript
 * must not be able to start a wait or stop one. The waits stay readable.
 */
const CHAT_FORBIDDEN_ROTATION = new Set([
  `POST ${API_PREFIX}/chats/:id/wait`,
  `POST ${API_PREFIX}/limits/waits/:id/cancel`,
  `POST ${API_PREFIX}/limits/waits/:id/run-now`,
]);

/**
 * Registering a webhook puts a URL and a secret on the person's repository, and removing one stops
 * Claudio hearing from it: the person's click, never a chat's. Reading them stays open.
 */
const CHAT_FORBIDDEN_WEBHOOKS = new Set([
  `POST ${API_PREFIX}/projects/:id/webhooks`,
  `POST ${API_PREFIX}/projects/:id/webhooks/:registrationId/test`,
  `DELETE ${API_PREFIX}/projects/:id/webhooks/:registrationId`,
]);

/** Authorising a connector signs the person's account in to a service: their click, never a chat's. */
const CHAT_FORBIDDEN_CONNECTORS = new Set([`POST ${API_PREFIX}/connectors/:id/authorise`]);

/**
 * Approving a memory proposal writes its text into `CLAUDE.md`, a memory file or the journal, which
 * every later run of the project reads as instructions: a chat that could approve (or reject) its
 * own proposals would write its own standing orders. Deciding is the person's click; proposing stays
 * open to a chat.
 */
const CHAT_FORBIDDEN_MEMORY = new Set([
  `POST ${API_PREFIX}/memory-proposals/:proposalId/approve`,
  `POST ${API_PREFIX}/memory-proposals/:proposalId/reject`,
]);

/**
 * A lesson rests on the person's corrections and is handed to every later run of the project, so a
 * chat that could approve, edit, promote or mine one would write its own standing orders. Reading
 * lessons stays open. Deciding a `lesson` proposal, or an `instructions` proposal made from a lesson,
 * is covered by `CHAT_FORBIDDEN_MEMORY`: a chat's token decides no memory proposal.
 */
const CHAT_FORBIDDEN_LESSONS = new Set([
  `PATCH ${API_PREFIX}/lessons/:lessonId`,
  `POST ${API_PREFIX}/lessons/:lessonId/confirm`,
  `POST ${API_PREFIX}/lessons/:lessonId/retire`,
  `POST ${API_PREFIX}/lessons/:lessonId/restore`,
  `DELETE ${API_PREFIX}/lessons/:lessonId`,
  `POST ${API_PREFIX}/lessons/:lessonId/promote`,
  `POST ${API_PREFIX}/lessons/:lessonId/demote`,
  `POST ${API_PREFIX}/lessons/:lessonId/instructions`,
  `POST ${API_PREFIX}/chats/:id/lessons/mine`,
  `PUT ${API_PREFIX}/lessons/settings`,
]);

/**
 * Importing, linking and syncing issues writes the person's work items and their tracker, and an
 * issue's text is untrusted: an injection in one must not be able to import more issues, link or
 * unlink them, change which tracker a project uses or write to the tracker through a chat's token.
 * Reading the tracker's issues and a project's tracker stays open.
 */
const CHAT_FORBIDDEN_TRACKERS = new Set([
  `PUT ${API_PREFIX}/projects/:id/tracker`,
  `POST ${API_PREFIX}/projects/:id/tracker/import`,
  `POST ${API_PREFIX}/work-items/:itemId/issues`,
  `DELETE ${API_PREFIX}/work-items/:itemId/issues/:key`,
  `POST ${API_PREFIX}/work-items/:itemId/issues/:key/sync`,
]);

/**
 * An instruction eval spends the person's account and runs commands a file asks for, and a consent
 * is the person's alone: an injection in a chat must not write an eval file, consent to one, start
 * or resume a run, or delete a run's results. Reading, estimating and cancelling stay open.
 */
const CHAT_FORBIDDEN_EVALS = new Set([
  `PUT ${API_PREFIX}/projects/:id/evals/:name`,
  `DELETE ${API_PREFIX}/projects/:id/evals/:name`,
  `POST ${API_PREFIX}/projects/:id/evals/:name/consent`,
  `POST ${API_PREFIX}/projects/:id/evals/:name/runs`,
  `POST ${API_PREFIX}/eval-runs/:runId/resume`,
  `POST ${API_PREFIX}/eval-runs/:runId/rejudge`,
  `POST ${API_PREFIX}/eval-runs/:runId/accept-judge`,
  `POST ${API_PREFIX}/projects/:id/evals/:name/draft-cases`,
  `DELETE ${API_PREFIX}/eval-runs/:runId`,
]);

/**
 * Adding, creating, refreshing, removing and asking about a project's Claude Docs spends the
 * person's account on the Docs connector, and a document's text is untrusted: a chat's token
 * cannot reach the connector through these. Reading the registry stays open.
 */
const CHAT_FORBIDDEN_PROJECT_DOCS = new Set([
  `POST ${API_PREFIX}/projects/:id/docs`,
  `POST ${API_PREFIX}/projects/:id/docs/refresh`,
  `DELETE ${API_PREFIX}/projects/:id/docs/:docId`,
  `POST ${API_PREFIX}/projects/:id/docs/:docId/ask`,
]);

/**
 * A re-run, a cancel or a fix spends the person's CI minutes or pushes their branch, and log text
 * is untrusted: an injection in a job's output must not be able to ask for any of them through a
 * chat's token. Reading the checks and their logs stays open.
 */
const CHAT_FORBIDDEN_CHECKS = new Set([
  `POST ${API_PREFIX}/change-requests/:id/checks/rerun`,
  `POST ${API_PREFIX}/change-requests/:id/checks/cancel`,
  `POST ${API_PREFIX}/change-requests/:id/checks/:checkId/run`,
  `POST ${API_PREFIX}/change-requests/:id/checks/fix`,
  `POST ${API_PREFIX}/change-requests/:id/push-fix`,
]);

/**
 * Merging is the person's click, never a run's, a decision's or a chat's: it changes the base
 * branch for everyone, and a review comment or a log line is untrusted text that could ask for it.
 * Arming, turning off, updating the branch and marking ready are refused with it. Reading the
 * merge state stays open.
 */
const CHAT_FORBIDDEN_MERGE = new Set([
  `POST ${API_PREFIX}/change-requests/:id/merge`,
  `POST ${API_PREFIX}/change-requests/:id/auto-merge`,
  `DELETE ${API_PREFIX}/change-requests/:id/auto-merge`,
  `POST ${API_PREFIX}/change-requests/:id/update-branch`,
  `POST ${API_PREFIX}/change-requests/:id/ready`,
]);

/**
 * A review is posted under the person's name, and thread text is untrusted: an injection in a
 * comment must not be able to post, approve, resolve or hand threads to an agent through a chat's
 * token. Reading the threads, the drafts, the approval and the reviewers stays open.
 */
const CHAT_FORBIDDEN_REVIEWS = new Set([
  `POST ${API_PREFIX}/change-requests/:id/review-drafts`,
  `PUT ${API_PREFIX}/change-requests/:id/review-drafts/:draftId`,
  `DELETE ${API_PREFIX}/change-requests/:id/review-drafts/:draftId`,
  `POST ${API_PREFIX}/change-requests/:id/reviews`,
  `POST ${API_PREFIX}/change-requests/:id/reviews/:postId/publish-saved`,
  `POST ${API_PREFIX}/change-requests/:id/reviews/:postId/discard-saved`,
  `POST ${API_PREFIX}/change-requests/:id/threads/:threadId/reply`,
  `POST ${API_PREFIX}/change-requests/:id/threads/:threadId/resolve`,
  `POST ${API_PREFIX}/change-requests/:id/threads/:threadId/unresolve`,
  `POST ${API_PREFIX}/change-requests/:id/approval`,
  `DELETE ${API_PREFIX}/change-requests/:id/approval`,
  `POST ${API_PREFIX}/change-requests/:id/reviewers`,
  `POST ${API_PREFIX}/change-requests/:id/address`,
]);

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
 * Consent is the owner's (D12): these widen what the decision engine sends off the machine, so a
 * prompt injection in a chat must not be able to consent to a point or switch the provider to Jev.
 * A project's own override, which does not touch consent, stays open through the project settings.
 */
const CHAT_FORBIDDEN_DECISIONS = new Set([
  `PUT ${API_PREFIX}/decisions/settings`,
  `PUT ${API_PREFIX}/decisions/credentials`,
  `DELETE ${API_PREFIX}/decisions/credentials`,
  `PUT ${API_PREFIX}/decisions/points/:point/consent`,
  // What the person did is theirs to report: a chat must not write the signal a resolver judges by
  `POST ${API_PREFIX}/decisions/:id/palette-action`,
  `POST ${API_PREFIX}/decisions/notification-opened`,
]);

/**
 * Compacting a chat and asking it for a note are paid turns the person chose to spend; the chat
 * that is running must not be able to spend them on itself or on another. Reads stay open.
 */
const CHAT_FORBIDDEN_CONTEXT = new Set([
  `POST ${API_PREFIX}/chats/:id/compact`,
  `POST ${API_PREFIX}/chats/:id/notes`,
  `DELETE ${API_PREFIX}/chats/:id/notes/:noteId`,
]);

const CHAT_CANNOT_COMPACT = "a chat's token cannot compact a chat or ask it for a note: that is the person's click";

/**
 * The same paid turn reached through a text the CLI reads as its own `/compact`: the field of each
 * route that becomes a user turn. Read once the body is parsed, so in `preHandler`.
 */
const CHAT_FORBIDDEN_COMPACT_TEXT = new Map([
  [`POST ${API_PREFIX}/chats/:id/messages`, 'text'],
  [`POST ${API_PREFIX}/chats/:id/resume`, 'prompt'],
  [`POST ${API_PREFIX}/chats/:id/fork`, 'prompt'],
]);

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
const TERMINAL_SOCKET = /^\/api\/terminals\/[^/]+\/socket$/;

/**
 * The desktop app's secret exists to let its tray read what is live, so it reads and nothing
 * else: a secret that has to sit in a second process's memory is kept to the least it needs.
 */
const DESKTOP_METHODS = new Set(['GET', 'HEAD']);

/** Failed authentications a client address gets for free before it is asked to wait. */
const FAILURES_BEFORE_WAIT = 10;
const FIRST_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
/** A client that stops failing for this long is forgotten: a mistyped token leaves no trace. */
const FORGET_AFTER_MS = 15 * 60_000;
/** The map is fed by whoever can reach the port, so it is bounded rather than trusted. */
const MAX_CLIENTS = 1024;

interface Failures {
  count: number;
  /** The last failure; both the wait and the forgetting are measured from it */
  at: number;
}

/**
 * Failed authentications per client address, with a wait that doubles.
 *
 * Written here rather than pulled in as a rate-limiting plugin, for the reason `cron.ts` gives for
 * its own parser: what this needs is a count and an instant per address, and a plugin would bring
 * a store, a policy language and a dependency to hold them. A token Claudio generates is 32 random
 * bytes and out of reach of guessing, but a token someone chooses is accepted from 16 characters,
 * and 16 characters under an unlimited online attack are not enough.
 *
 * The wait is per address and not per credential, so an honest client sharing an address with an
 * attacker pays it too: the cap is what keeps that to a minute instead of a lockout.
 *
 * Only a credential that was presented and failed is counted. A request with none at all is not a
 * guess: it cannot get closer to the token by repeating itself, and on a local install every
 * process on the machine shares 127.0.0.1, so a tray, a stale tab or a chat polling without a
 * credential would otherwise make the owner's own authenticated window wait.
 */
export class FailureBackoff {
  private readonly clients = new Map<string, Failures>();

  /** The clock is a parameter so a test can watch a wait grow and a client be forgotten. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds before this client's credential is looked at again; 0 when it may try now. */
  retryAfter(client: string): number {
    const seen = this.clients.get(client);
    if (!seen) return 0;
    const now = this.now();
    if (now - seen.at >= FORGET_AFTER_MS) return 0;
    const remaining = seen.at + this.waitMs(seen.count) - now;
    return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
  }

  fail(client: string): void {
    const now = this.now();
    const seen = this.clients.get(client);
    const count = seen && now - seen.at < FORGET_AFTER_MS ? seen.count + 1 : 1;
    // Re-inserted, so the map runs least-recent first and eviction drops from the front
    this.clients.delete(client);
    this.clients.set(client, { count, at: now });
    this.evict(now);
  }

  succeed(client: string): void {
    this.clients.delete(client);
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
const READ_ONLY_ALLOWED = new Set([`POST ${API_PREFIX}/chats/:id/permissions/:requestId`, `PUT ${API_PREFIX}/security/auth`]);

/** Only what this process serves is guarded; the UI bundle is public so a 401 has a page to show. */
const isGuarded = (path: string): boolean => path === '/openapi.json' || path === '/docs' || path.startsWith('/docs/') || path.startsWith(`${API_PREFIX}/`);

const pathOf = (url: string): string => url.split('?')[0] ?? url;

function credentialOf(req: FastifyRequest, path: string): string | undefined {
  const [scheme, ...rest] = (req.headers.authorization ?? '').split(' ');
  // An empty bearer is no credential rather than a wrong one, so it is not counted as a guess
  if (scheme?.toLowerCase() === 'bearer' && rest.length) return rest.join(' ').trim() || undefined;
  // A header that is not a bearer token (a proxy's own `Basic`, say) is not ours: fall through
  if (req.method !== 'GET' || !QUERY_TOKEN.some((re) => re.test(path))) return undefined;
  const token = (req.query as { token?: unknown } | undefined)?.token;
  return typeof token === 'string' && token ? token : undefined;
}

/**
 * One line about what a request did, taken from the route's own documentation. Built from the
 * route and never from the payload: a body holds prompts and secrets and is not written down.
 */
export function auditSummary(method: string, routeUrl: string | undefined, path: string): string {
  const pattern = routeUrl?.startsWith(API_PREFIX) ? routeUrl.slice(API_PREFIX.length) : undefined;
  const doc = pattern ? ROUTE_DOCS[`${method} ${pattern}`] : undefined;
  return doc?.summary ?? `${method} ${path}`;
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

  app.addHook('onRequest', async (req, reply) => {
    // A CORS preflight carries no credential by definition, and answering it reveals nothing
    if (req.method === 'OPTIONS') return;
    const path = pathOf(req.url);
    const receiver = req.method === 'POST' && WEBHOOK_RECEIVER.test(path);
    const guarded = isGuarded(path) && !OPEN.has(path);
    const mode = core.security.mode;
    // Before the credential, because an authority this wrapper does not serve is refused whether
    // or not the caller holds one: under `mode: 'none'` there is no credential to refuse it by
    if (guarded && !hostAllowed(req.headers.host, allowedHosts(), runtimeHosts)) {
      req.actor = 'anonymous';
      void reply.status(421).send({
        error: 'this wrapper does not answer to that host. Reach it on localhost, or name the host in CLAUDIO_ALLOWED_HOSTS.',
      });
      return reply;
    }
    if (receiver) {
      req.actor = 'webhook';
      return;
    }
    // A socket's ticket is its credential; the route checks it once the gate has had its say
    const ticketed = req.method === 'GET' && TERMINAL_SOCKET.test(path);
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
          .send({ error: 'authentication required', mode });
      };
      const credential = credentialOf(req, path);
      // Nothing to check is nothing guessed: neither counted nor made to wait, so a local process
      // polling without a credential cannot lock the owner out of their own install
      if (credential === undefined) {
        void refuse();
        return reply;
      }
      const client = backoffKey(req, runtimeHosts);
      const wait = backoff.retryAfter(client);
      if (wait > 0) {
        req.actor = 'anonymous';
        // Not counted as another failure: a client that kept trying would never serve its wait
        void reply.header('Retry-After', String(wait)).status(429).send({ error: 'too many failed authentications from this address', mode });
        return reply;
      }
      const owner = await core.security.actorFor(credential, fromLocalMachine(req));
      // The owner's credential first; a chat token is only ever the fallback, and fails the same
      // way. Told apart by where it came from, not by its prefix: an OIDC subject could be anything
      const chat = owner === null ? core.security.chatActorFor(credential, fromLocalMachineStrict(req, runtimeHosts)) : null;
      const actor = owner ?? chat;
      if (!actor) {
        backoff.fail(client);
        void refuse();
        return reply;
      }
      backoff.succeed(client);
      req.actor = actor;
      if (actor === DESKTOP_ACTOR && !DESKTOP_METHODS.has(req.method)) {
        void reply.status(403).send({ error: "the desktop app's own credential only reads; sign in with the API token to change anything" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot change the API's authentication" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_CONTEXT.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: CHAT_CANNOT_COMPACT });
        return reply;
      }
      if (chat !== null) chatCredentials.add(req);
      if (chat !== null && CHAT_FORBIDDEN_DECISIONS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot change what the decision engine sends" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_ROTATION.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot start or stop a wait for work: what a limit does is the person's choice" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_CHECKS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot re-run, cancel or fix a change request's checks" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_MERGE.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot merge, arm auto-merge, update the branch or mark ready a change request: that is the person's click" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_REVIEWS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot post, approve, resolve or hand out a change request's review" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_REVIEW_GATE.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: CHAT_REVIEW_GATE_REFUSAL });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_WEBHOOKS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot register, test or remove a repository's webhook: that is the person's click" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_LAYOUT.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot change how Home is laid out: that is the person's setting" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_SETUP.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot start, read or cancel a sign-in, or sign a tool out: that is the person's" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_ACCOUNTS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot add, sign in, change or remove an account, or change how work moves between them: that is the person's" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_PROJECT_DOCS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot add, create, refresh, remove or ask about a project's Claude Docs: that is the person's click" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_CONNECTORS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot authorise a connector: that is the person's click" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_MEMORY.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot approve or reject a memory proposal: what is written into memory is the person's decision" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_LESSONS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot decide, change or mine lessons: that is the person's" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_EVALS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot write, consent to, start, resume, re-judge, draft cases for or delete an eval: that spends money and runs commands on the person's behalf" });
        return reply;
      }
      if (chat !== null && CHAT_FORBIDDEN_TRACKERS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
        void reply.status(403).send({ error: "a chat's token cannot import, link, unlink or sync issues, or change a project's tracker" });
        return reply;
      }
    }
    // Open mode grants everything already, so a chat's token only labels who wrote: a missing, wrong
    // or expired one leaves `local` and is never refused
    if (mode === 'none' && req.actor === null) {
      const presented = credentialOf(req, path);
      const chatId = presented === undefined ? null : core.security.chatTokens.verify(presented);
      if (chatId !== null) req.actor = chatActor(chatId);
    }
    req.actor ??= 'local';

    if (req.actor.startsWith('chat:') && CHAT_FORBIDDEN_REVIEW_GATE.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
      void reply.status(403).send({ error: CHAT_REVIEW_GATE_REFUSAL });
      return reply;
    }

    if (req.actor.startsWith('chat:') && AGENT_READABLE.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
      const refusal = await agentReadRefusal(core, req.actor.slice('chat:'.length), req.params as { owner?: unknown; shareId?: unknown } | undefined);
      if (refusal) {
        void reply.status(403).send(refusal);
        return reply;
      }
    } else if (req.actor.startsWith('chat:') && CHAT_FORBIDDEN_COLLABORATORS.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
      void reply.status(403).send({ error: CHAT_COLLABORATORS_REFUSAL, code: 'collaborators.chat-token' });
      return reply;
    }

    if (req.actor.startsWith('chat:') && CHAT_FORBIDDEN_TERMINAL.has(`${req.method} ${req.routeOptions.url ?? path}`)) {
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

    if (core.security.readOnly && MUTATING.has(req.method) && isGuarded(path)) {
      const routeUrl = req.routeOptions.url;
      if (!routeUrl || !READ_ONLY_ALLOWED.has(`${req.method} ${routeUrl}`)) {
        void reply.status(405).send({
          error: 'read-only mode is on: this wrapper accepts no changes. Turn it off with PUT /api/security/auth, which stays open for exactly that.',
        });
        return reply;
      }
    }
    return;
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!chatCredentials.has(req)) return;
    const field = CHAT_FORBIDDEN_COMPACT_TEXT.get(`${req.method} ${req.routeOptions.url ?? ''}`);
    const text = field ? (req.body as Record<string, unknown> | null | undefined)?.[field] : undefined;
    if (typeof text === 'string' && TYPED_COMPACT.test(text.trim())) {
      void reply.status(403).send({ error: CHAT_CANNOT_COMPACT });
      return reply;
    }
    return;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const path = pathOf(req.url);
    if (!path.startsWith(`${API_PREFIX}/`)) return;
    if (req.actor === 'webhook') return;
    core.db.appendAudit({
      at: new Date().toISOString(),
      actor: req.actor ?? 'local',
      method: req.method,
      // The query string is dropped: it can carry `?token=`, and the path is what a filter needs
      path,
      status: reply.statusCode,
      summary: auditSummary(req.method, req.routeOptions.url, path),
    });
  });

  return { backoff, backoffKey: (req) => backoffKey(req, runtimeHosts) };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Who made the request: a token id, an OIDC subject, `desktop`, `chat:<chatId>`, or `local` when nothing guards the API */
    actor: string | null;
  }
}
