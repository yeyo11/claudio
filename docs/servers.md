---
created_at: 2026-11-08T18:00:00Z
updated_at: 2026-11-08T18:00:00Z
tags:
    - servers
    - remote-access
    - security
    - architecture
    - reference
---
# Servers: one Claudio drives the others

A Claudio can drive other Claudios. The one the person opens is the **hub**; the others are
**servers** (the local one is "This server", id `local`). Each server keeps its own accounts, chats
and settings and is only *reached* from the hub: the hub's web client shows the selected server's
pages, and every request goes through the hub's gateway to that server's own API. The design is
[the plan](plans/claudio-servers.md); this page is what exists after orchestration A (the engine,
stages 1-3 and D12) and how it works.

**There is no visible UI yet.** Nothing in the sidebar, the top bar or Settings mentions servers. The
engine is driven through the REST routes below and reached in the browser by address
(`/s/<id>/…`). The selector, the Servers page and the Settings switch are orchestration B, after
its own design phase. A person who never turns the feature on sees no change.

## What a server is

- **An identity, not an address.** A server is its `instanceId` (a random id made once, kept in
  `<data dir>/instance.json`) plus the TLS fingerprint pinned when it was paired. It may have up to 8
  addresses, each an `https://` origin with a kind (`lan`, `tailscale`, `tunnel`, `other`); every
  address must prove the same identity.
- **A headless Claudio can be a remote but never a hub.** In the headless profile only `GET /meta`,
  `POST /server-links` (pasted token; a code needs a page to show it on) and
  `DELETE /server-links/self` are served.
- **Every Claudio is a possible remote.** `GET /api/meta` (open, no credential, answered on any
  host) says `instanceId`, `version`, `apiVersion: { current, min }` and `capabilities`
  (`server-links`, `lan-tls`, `gateway` today). It carries no account, path or host data.
- **A hub's record** is an entry of `servers.json`: id (12 hex), name, colour *token name* (never a
  hex), monogram, ordered addresses, the pinned identity (`instanceId`, certificate fingerprint,
  public-key hash), the remote's id for the token it gave this hub, `createdAt`, `lastUsedAt`. At
  most 32 servers. The token itself is never in this file.

## Pairing

Pairing needs the remote to be guarded: under auth mode `none` every pairing route answers
`409 server-links.auth-required`, as the LAN listener does. It happens on the **first address that
answers `/api/meta` as a Claudio**; the code or token is never tried on a second machine. Two ways:

1. **A one-time code.** On the remote the owner calls `POST /server-links/code` and gets 8
   characters (no `0 O 1 I L`), valid 5 minutes, single use, replacing any unused one. It lives in
   memory as a hash, so a restart voids it. The hub posts `{ code, hubInstanceId, hubName }` to
   `POST /server-links/redeem`, which is open (the code is the credential): a wrong code counts in
   the peer's sign-in back-off (`429 server-links.too-many` with `Retry-After`), and 20 wrong
   guesses from anyone void the live code.
2. **A pasted owner token.** The hub sends `{ hubInstanceId, hubName }` once to `POST /server-links`
   with the remote owner's token, receives its own named token and forgets the owner's. It works for
   a headless server or one behind OIDC.

Either returns a `ServerLinkGrant`: the token (shown once), its id, the remote's `instanceId` and the
fingerprint of its LAN certificate. The remote stores only the token's SHA-256, with the hub's name
and `instanceId`, `createdAt` and `lastUsedAt` (written at most once a minute) in `auth.json`; a hub
that pairs again replaces its earlier token, so there are no orphans.

The hub then checks, in this order, and refuses with a code if any fails: the address is not this
Claudio (`servers.self`) nor already on the list (`409 servers.already-paired`); the grant's
`instanceId` is the one `/api/meta` answered (`servers.identity-changed`); the certificate seen in the
handshake is the one the grant names (`502 servers.fingerprint-mismatch`), unless a CA vouches for it
(below); every other address that answers is the same server (`409 servers.address-identity`; one
that does not answer yet is kept, and proves itself at its first probe). If anything fails after the
remote handed its token over, the hub revokes it before answering, so a failed add leaves nothing
behind. The token goes into the secret vault, under the tool name `claudio-servers`, one entry per
server id, never in `servers.json`, a log or an API answer.

**Removing** a server calls `DELETE /server-links/self` on the remote with the hub's own token (allowed
in read-only mode: it only takes access away), then forgets the entry, the secret
and every connection. A remote that could not be told answers `502 servers.revoke-failed` and the
server stays; `?force=true` removes it anyway and reports `revoked: false` with the reason, so the
person knows the token may still work there. A remote that no longer knew the token is
`revoked: false` with `servers.token-unknown`.

## The switch

`servers.enabled` lives in its own file, `<data dir>/servers-settings.json`, **off by default**.
`PUT /servers/settings { enabled }` turns it on or off. Off:

- `GET /servers` answers an empty list, and every other `/servers*` write answers
  `409 servers.disabled`;
- the gateway answers `404`, as if it did not exist;
- every open connection to a remote (relayed streams and sockets) is closed at once, and no
  credential is used;
- `servers.json` and the vault stay as they were, so turning it on again restores everything.

## The gateway

`/api/servers/:id/api/*` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) is the selected remote's
`/api/*`. The browser only ever talks to the hub; no remote page, script or cookie reaches the hub's
origin (D2). Only the **person** may call it (the owner's token or OIDC identity, or the open actor under auth mode `none`); the desktop shell's actor, a chat and a webhook are refused (`403 servers.not-owner`). A paired hub's
own token is refused with `403 servers.one-hop`, and so is any path under the remote's `/servers` or
`/server-links` (D7). It is written on undici directly, in `packages/core/src/servers/transport.ts`
and `apps/api/src/routes/servers-gateway.ts`.

**Paths.** The path must start with `/api/` after the hub's own prefix and stay there however it is
decoded: it is decoded up to four times, and every spelling is checked for dot segments, `//`,
backslashes and control characters. An encoded slash, backslash or NUL is refused outright
(`400 servers.path-refused`).

**Headers.** What reaches the remote is an allowlist (`Accept`, `Content-Type`, `Range`,
conditionals, `Last-Event-ID` and `X-Claudio-*` options…); the hub's `Authorization`, cookies,
`X-Forwarded-*`, `Forwarded` and `Sec-Fetch-*` never leave. The remote gets `Authorization: Bearer
<server token>` and its own origin as `Origin`, so its cross-site check and its terminal tickets see
a consistent pair. `?token=`, the hub's credential for streams and downloads, is stripped from the
query; the hub accepts it on the gateway only for the remote's own stream and download routes. Back
to the browser, an allowlist again: no `Set-Cookie`, `Location`, CORS or HSTS. A content type a browser
would run (HTML, SVG, script) is sent as `application/octet-stream` with `Content-Disposition:
attachment`, and every answer carries `nosniff`.

**Answers.**

| Remote answers | The browser gets |
| --- | --- |
| `401` | `409 servers.needs-pairing`, so the hub's own sign-in screen is never shown for it |
| a redirect | `502 servers.redirect-refused`; redirects are never followed or passed on |
| unreachable | `502 servers.unreachable`; `409 servers.identity-changed` if no address proves the identity |
| its API range does not hold the hub's web | `409 servers.needs-update` (only `/api/meta` passes) |

**Streams.** Event streams are piped as written: no compression on the hop, no body timeout, the
remote's request is aborted when the browser leaves (or the server is removed or the switch turned
off), and `Last-Event-ID` and `?since=` pass through. Request bodies stream through unbuffered and
counted, up to the largest upload the API takes of its own (51 MiB for a file, the workspace archive
cap when that is larger): a declared `Content-Length` over it is `413 servers.body-too-large` before
anything is dialled, and a streamed body is cut where it passes it, with the same `413` (D16).

**The terminal WebSocket.** Only `/api/terminals/:id/socket` is relayed as a WebSocket. A browser's
socket carries no token, so the hub opens it only for a ticket it saw the remote mint through the
gateway: bound to the server, the terminal, the actor and the page's origin, 30 s, one use, with
the sign-in back-off on wrong tickets. The remote's own gate then decides (D10): a `server:*` actor is a
remote peer for `terminal-gate.ts`, never local and never the tunnel, so with the default
`needs-tunnel` setting a remote's terminal stays closed through a hub unless that server allows it.
Other upgrades answer `404 servers.not-a-socket`.

## Reaching a server: addresses, TLS and identity

**What the hub dials.** It resolves each name itself and connects to the IP it checked, so a second
lookup cannot be answered differently (a rebinding). It never dials link-local, multicast, reserved
or cloud-metadata addresses (including the IPv6, IPv4-mapped and NAT64 spellings), IPv4-compatible
addresses (`::a.b.c.d`), 6to4 (`2002::/16`) or Teredo (`2001::/32`), whoever recorded them.
Private ranges stay open: the LAN is where servers live. Plain `http://` and loopback are allowed
only for an address entered as loopback (`localhost` or a loopback literal); anything else on plain
HTTP is `400 servers.address-insecure`. An address is a bare origin: no path, query, credentials or
fragment.

**Certificates.** The hub does not use a CA to judge a server. A connection is accepted if the
certificate it shows has the **pinned fingerprint**, or the **pinned public key** (a remote that
remakes its certificate on the same key, as `lan-tls` does when it gains an address, is still
recognised, and the stored fingerprint is updated), or a **CA-valid certificate for the name
dialled**. The last is how Tailscale `*.ts.net` names and a tunnel's proxy present themselves: TLS
ends before the remote, so no pin could know their certificate; no CA signs a certificate for a LAN
address or a `.local` name, so this fallback cannot stand in for a LAN server. In every case the
`instanceId` from `/api/meta` must be the one paired, and a mismatch is a hard block
(`identity-changed`) until the server is removed and added again, which gives it a new id. While
pairing, nothing is pinned yet: the first certificate is taken as it is and every later connection
of that agent must show the same one.

**Choosing the address.** Addresses are tried in the owner's order (the default is LAN, then
Tailscale, then tunnel) with a probe of `GET /api/meta` (4 s). The one in use is kept; the next
request looks for another only after **two failures in a row** (hysteresis), so a flapping network
does not move streams back and forth. A certificate that no longer matches moves at once.

**Health.** Readings (`connected`, `reconnecting`, `offline`, `needs-update`, `needs-pairing`,
`identity-changed`, with address, version, API version, latency and a `reason.code`) are taken when
a server is selected (`POST /servers/:id/use`), when its connection is tested, and from gateway
traffic. Nothing polls, and they are kept in memory only. `GET /servers` returns the last reading
(`null` before one) and never probes.

**Test connection** (`POST /servers/:id/test`) picks the address afresh and checks four things on
their own, because one often breaks while the others work: `meta` (identity and API range), `rest`
(an authenticated read, so a revoked token shows as `servers.needs-pairing`), `events` (the stream
opens and greets) and `socket` (an upgrade reaches the terminal socket route; the remote's `terminal.*`
code says whether its terminal is open to this hub).

## The version range

`API_VERSION` and `API_VERSION_MIN` are integers in `packages/shared` (both 1). A server answers
routes correctly for `min..current`; a hub's web is built for one `API_VERSION`. Outside the range the
server is **needs-update**, never a half-working screen: the gateway passes only `/api/meta`, and
the web's remote gate shows "needs an update" and renders nothing else. Bump `API_VERSION` on any
change that breaks an older web talking through a gateway, and `API_VERSION_MIN` when old routes are
dropped.

## The web client

- **Scope is the address.** `/s/<id>/…` is a remote, anything else is local. It is fixed when the
  page loads: switching is a full page load that ends with `POST /servers/:id/use`, so nothing of
  one server (feed, drafts, notifications) survives into another's page.
- **`createApi(base)`** replaces the fixed `/api`: the base is `/api` locally and
  `/api/servers/<id>/api` through the gateway. Export links, uploads, the chat stream, the terminal
  socket and the events feed all use the scope's base, and only the selected server's feed is open
  (D11). The hub's token goes only to the hub; a 401 through the gateway asks the hub about its own
  session instead of showing the hub's sign-in, and a 421 through the gateway does not trigger the
  host-refused screen.
- **Storage.** Per-server `localStorage` keys get `:<serverId>` for remotes only; local keys are
  unchanged, so nothing migrates. The query cache is keyed by the server and per page. Theme,
  language and motion stay global.
- **Routes.** The router has the `/s/<id>` basename and `sw.js` treats `s` as an app route.
  Switching keeps the page when it names no record and exists on both (Home, Chats, Settings…); a
  page that names a record (`/chats/:id`) goes to Home, since ids belong to one server.
- **Remote gate.** A remote scope reads `/meta` first and shows "needs an update" or "unreachable";
  it renders nothing until the first auth probe settles.
- `apps/web/src/lib/server-meta.ts` still mirrors `ServerMeta` and `WEB_API_VERSION` instead of
  importing the shared constants; the values must match `API_VERSION`.

## What is hub-only

One helper, `isHubOnly` (`apps/web/src/lib/server-routes.ts`), hides these in a remote scope (D7):

- the Servers page and the server selector (when they exist);
- Settings → Access & safety's sign-in cards and the LAN and tunnel cards, which describe the hub;
- the desktop bridge (IPC actions) and the desktop app's updates, and tray navigation;
- the matching Settings search and command-palette entries.

Everything else, Settings included, is the **selected server's**: a write there lands on that
server, and its page says which one.

## Who is who: the `server:<tokenId>` actor

A request with a paired hub's token is `server:<tokenId>` in the audit. It is an owner for
authorisation (full control by design), accepted on any `Host` the listener serves (the token is the
proof, so a hub can use a LAN address, a Tailscale name or a proxy without being on the allowlist),
and **never** this machine, even over a loopback socket, and never a chat token. It cannot mint
pairing codes or tokens (`server-links.not-owner`) and cannot drive another hub's gateway. The
security rules are in [security-model.md](security-model.md#servers).

## Where things live

| | |
| --- | --- |
| `instance.json`, `/meta` | `packages/core/src/meta.ts`, `apps/api/src/routes/server-links.ts` |
| Hub tokens, pairing codes | `packages/core/src/security/auth.ts`, `server-links.ts` |
| Registry, service, transport, addresses | `packages/core/src/servers/` |
| The CRUD routes and the gateway | `apps/api/src/routes/servers.ts`, `servers-gateway.ts` |
| The LAN certificate | `packages/core/src/lan-tls.ts`, [lan-access.md](lan-access.md) |
| The web scope | `packages/ui/src/lib/server-scope.ts`, `apps/web/src/lib/server-scope.tsx`, `server-routes.ts`, `server-meta.ts` |
| The routes | [rest-api.md](rest-api.md#servers) |
| The tests | `apps/api/test/servers.test.ts`, `server-links.test.ts`, `lan.test.ts`; `packages/core/test/servers.test.ts`, `server-links.test.ts` |

## Not there yet

- The UI: selector, status bar, Servers page, Settings switch, phone layout (orchestration B). The
  fingerprint is in `GET /lan` but the LAN card does not show it yet.
- An e2e spec for the visible flow with two isolated wrappers, which comes with the UI.
- Notifications and views across servers, the MCP server or the assistant acting on another server,
  chaining, a list of incoming connections on the remote, and a remote that dials out to the hub.
- Known limits: the relay of a terminal socket reads the bytes sent before the `101` from a private
  field of `@fastify/websocket` (nearly always empty); the hub sets no size limit on request bodies it
  relays; a server whose identity changed can only be removed (`?force=true`) and added again.

## Related

[[plans/claudio-servers.md]] · [[lan-access.md]] · [[security-model.md]] · [[rest-api.md]] · [[configuration.md]] · [[tunnel.md]] · [[terminal.md]] · [[securing.md]] · [[api-wire.md]]
