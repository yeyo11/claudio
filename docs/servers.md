---
created_at: 2026-11-08T18:00:00Z
updated_at: 2026-11-09T18:00:00Z
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
[the plan](plans/claudio-servers.md); this page is what exists after orchestration A (the engine)
and orchestration B (the UI and the gaps A left) and how it works.

It is **off by default**. Settings → Access & safety → Servers has the switch; while it is off the
sidebar, the top bar and every page look as they did before, so a person who never turns it on sees
no change. [The UI](#the-ui) below says what appears when it is on.

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
2. **A pasted owner token.** With an `https://` address the hub first opens TLS and reads the
   certificate without sending anything; with no `expectedFingerprint` in the request,
   `POST /servers` answers `409 servers.confirm-fingerprint` with `{ fingerprint, address }` for the
   person to compare with the remote's LAN card, and only a second call carrying that fingerprint sends
   the token, over a connection that shows the same certificate (a different one is
   `409 servers.fingerprint-unexpected`, a malformed one `400 servers.pairing-invalid`). Over `http://`
   on loopback there is nothing to confirm. The hub sends `{ hubInstanceId, hubName }` once to `POST /server-links`
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

**Pairing again in place.** A server whose identity changed (it was reinstalled) or whose token was
revoked keeps its entry: `POST /servers/:id/pair` takes a `ServerPairing` (a bare one, or
`{ pairing }` as `POST /servers` does) and runs the same pairing, with the same rules, D13 for an
owner token included. It keeps the id, name, colour, monogram and addresses and replaces the pinned
identity and the token. The earlier token is given back on the remote **only after the new one is
stored**, and only on an address that still answers as the *earlier* identity, so the token of a
server that was reinstalled never reaches the machine that replaced it. The answer is the server
plus `previousToken: { revoked, reason? }`; a token the remote no longer knows counts as revoked
(a remote already replaces a hub's old token when it pairs again). A pairing that fails leaves the
server exactly as it was, and `409 servers.already-paired` refuses an address that is another server
on the list. The Servers page offers it as **Pair again** on a server in `identity-changed` or
`needs-pairing`.

**Revoking from the remote.** The remote's owner lists the hubs with `GET /server-links` (no secrets)
and revokes one with `DELETE /server-links/:tokenId`; a hub's own token cannot
(`403 server-links.not-owner`). Its terminal sockets close, it works in read-only mode, and the hub's
next call through the gateway is `409 servers.needs-pairing`. The Servers page has it as **Connected
hubs**, with **Revoke**.

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
ends before the remote, so no pin could know their certificate. It counts only for a DNS name that
is not an IP, not `.local` and not a single label (D15), so it can never stand in for a LAN server,
whatever a public authority has signed. In every case the
`instanceId` from `/api/meta` must be the one paired, and a mismatch is a hard block
(`identity-changed`) until the server is paired again in place (**Pair again**, which keeps its id) or removed and added again. While
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
  (D11). The hub's token goes only to the hub. A 401 or a 421 through the gateway may be the
  remote's answer or the hub's own, so the web asks the hub itself (its auth probe, on the hub's
  base): only the hub's own 401 brings its sign-in screen, and only the hub's own 421 the
  host-refused screen, as a direct call would.
- **Storage.** Per-server `localStorage` keys get `:<serverId>` for remotes only; local keys are
  unchanged, so nothing migrates. The query cache is keyed by the server and per page. Theme,
  language and motion stay global.
- **Routes.** The router has the `/s/<id>` basename and `sw.js` treats `s` as an app route.
  Switching maps the page onto the other server (`apps/web/src/lib/server-routes.ts`):
  - a page that names no record (Home, Chats, Settings…) stays as it is; Settings keeps its group
    and detail, and a hub-only page (`/servers`) goes to Home;
  - a page that names a record (a chat, a task, an orchestration, a project's assistant, a
    schedule's edit page, a terminal, and their `/changes` pages) **stays on it when the other
    server has the record**: one read of it through the target's own base, within 2 s
    (`RECORD_READ_MS`), asks. When it has not, or does not answer in time, the switch lands on the
    list the record belongs to (`/chats`, `/tasks`, `/orchestration`…). The read is the lightest the
    record has, one that writes nothing and starts no session (a project page reads its docs
    registry, since there is no `GET /projects/:id`). A shared project of a collaborator has no read
    and goes to its list;
  - the query and the hash do not travel: they hold ids too (the top bar's project, a chat filter).

  A switch never fails to land somewhere.
- **The desktop app.** A remote's terminal window (`/s/<id>/terminal-window/:id`) opens as its own
  native window, still on the app's own origin only. When the tray or the update notice opens a page
  of this server while the window shows a remote's pages, the app reloads instead of leaving the
  person inside the remote (`apps/desktop/src/terminal-window.ts`, `main.ts`).
- **Remote gate.** A remote scope reads `/meta` first and shows "needs an update" or "unreachable";
  it renders nothing until the first auth probe settles.

## What is hub-only

One helper, `isHubOnly` (`apps/web/src/lib/server-routes.ts`), hides these in a remote scope (D7):

- the Servers page, the server selector, the status bar's and phone More's server item, and the
  Settings → Servers card;
- Settings → Access & safety's sign-in cards and the LAN and tunnel cards, which describe the hub;
- the desktop bridge (IPC actions) and the desktop app's updates, and tray navigation;
- the matching Settings search and command-palette entries.

Everything else, Settings included, is the **selected server's**: a write there lands on that
server, and its page says which one.

## The UI

Every Servers surface is hub-only and drawn only while the switch is on; the design is
[plan §12.1](plans/claudio-servers.md#121-the-design), the page-by-page description is in
[ui.md](ui.md), and the CSS is under "Servers" in [design-system.md](design-system.md).

- **The switch.** Settings → Access & safety → **Servers** has the on/off switch
  (`PUT /servers/settings`) and **Manage servers**, a link to the page. Turning it off says what
  happens (D8: the list is kept, connections close). The card is absent in a remote scope and on a
  Claudio that does not serve the routes (a headless one).
- **The selector** (top bar, before the project selector, `ServerSelector`). Its button shows the
  current server's mark and name (**This server** on the hub; inside a remote, that remote, with the
  hub's list so a switch is one hop); the menu pins
  **This server**, then the 3 servers used most recently, each with its monogram in its colour and a
  status word (a server never used, just paired, comes after them by when it was added), then **All
  servers** → `/servers`. With no server yet the last entry is **Add a server** → `/servers?add=1`.
  Picking a server runs `switchTo`, a full page load that ends with `POST /servers/:id/use`; a
  refusal (a server removed meanwhile, the switch just turned off) is a toast and the page stays. On
  a phone the same list opens as a sheet.
- **The sidebar** has **Servers** before Projects, and the phone's More list has it too.
- **In a remote scope** the status bar's first item is the server's monogram, name and status word
  (the hub's last reading, polled slowly because it probes only the server in use), with **Back to
  this server**, a plain link to the same page on the hub; the phone's More sheet shows the same as a
  card. There is no banner. A remote that cannot be reached shows the `Unreachable` screen in its
  in-page form with the server's name and address, **Retry**, **Back to this server** and **All
  servers**, never the hub-wide modal; one that **needs an update** shows its version and says
  which of the two Claudios to update.
- **The page** (`/servers`, `pages/Servers.tsx`). With the switch off, an `Empty` with **Turn on
  Servers**. Otherwise the list, one row per server: monogram, name, status word (**Not checked**
  until the hub has a reading), version, latency, **Reached at** the address in use (mono), last
  used, and why when it is not connected. Row actions: **Open** (or **Pair again** for
  `identity-changed` and `needs-pairing`), **Test connection**, **Update** (only when a newer release
  is out and the remote's desktop update unit can install it, both read through the gateway; it asks,
  then `POST /servers/:id/api/system/desktop-update`), and in a "⋯" menu **Edit** and **Remove**; on a
  phone every action is in that menu. **Add a server** is the page's one gradient.
- **Add a server** has two tabs. *Pairing code*: the addresses and the 8 characters the other Claudio
  shows. *Owner token*: the addresses and a token, which runs D13's round trip: the first call is
  answered `409 servers.confirm-fingerprint`, the dialog shows the fingerprint in groups of four
  (mono) and asks the person to compare it with the other Claudio's LAN card, optionally by pasting
  that one here (a pasted fingerprint that differs blocks pairing), and only **It matches, pair**
  sends the token. For a Tailscale or tunnel name the dialog says the fingerprint will not match the
  card's and that the name's certificate is what is checked (D15). The name defaults to the first
  address's host (without `.local`), the colour to the first one no server wears, the initials to the
  name's.
- **Edit** changes the name, colour (eight tokens: blue, violet, magenta, rose, orange, lime, teal,
  sky; none of them a status hue), monogram and the addresses (add, remove, move up or down, each
  with its kind); a new address must prove it is the same server before it is saved.
- **Test connection** shows the four checks (identity and version, API calls, live updates, terminal
  connection), each with a word and its latency, and the address reached.
- **Remove** says the token is revoked on the remote; if that fails (`502 servers.revoke-failed`) a
  second question offers **Remove anyway** (`?force=true`) and says the token may still work there.
- **Let another Claudio connect to this one** (every Claudio is the hub of itself, so this is where
  a remote is prepared): **Show a pairing code** gives the 8 characters (mono, grouped 4+4, with a
  copy button) and a 5-minute countdown, **New code**, and below it this Claudio's certificate
  fingerprint to compare. Under auth mode `none` it says another Claudio can only connect to one that
  asks for a sign-in. **Connected hubs** lists `GET /server-links` (hub name, when it paired, last
  used) with **Revoke** (D14); the secret is never shown.
- **Motion.** Only Reconnecting and Testing move (the braille spinner beside the verb), and every
  loop stops under the motion levels.

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
| The UI | `apps/web/src/pages/Servers.tsx`, `pages/servers/` (row, dialogs, pairing, the connect and hubs cards), `components/ServerSelector.tsx`, `ServerMark.tsx`, `components/shell/CurrentServer.tsx`, `pages/config/security/ServersCard.tsx`, `lib/api/servers.ts` (the client), `lib/servers-model.ts` (what the UI decides from a server) |
| The desktop window | `apps/desktop/src/terminal-window.ts`, `main.ts` |
| The routes | [rest-api.md](rest-api.md#servers) |
| The tests | `apps/api/test/servers.test.ts`, `server-links.test.ts`, `lan.test.ts`; `packages/core/test/servers.test.ts`, `server-links.test.ts`; `apps/web/test/servers-page.test.tsx`, `servers-shell.test.tsx`, `servers-model.test.ts`, `server-routes.test.ts`, `server-scope.test.tsx`, `lan-card.test.tsx` |

## Not there yet

- The e2e of the visible flow with two isolated wrappers is the `e2e` task of orchestration B; the
  [plan's Outcome](plans/claudio-servers.md#124-outcome) says whether it ran.
- Notifications and views across servers, the MCP server or the assistant acting on another server,
  chaining, a list of incoming connections on the remote, and a remote that dials out to the hub.
- Known limits: the selector lists only This server and the 3 used last (the rest are one click
  away on the page); the remote-scope status bar, the More card and the Reconnecting spinner have
  only been covered by unit tests, because no paired remote was running when the UI was reviewed.

## Related

[[plans/claudio-servers.md]] · [[lan-access.md]] · [[security-model.md]] · [[rest-api.md]] · [[configuration.md]] · [[tunnel.md]] · [[terminal.md]] · [[securing.md]] · [[api-wire.md]]
