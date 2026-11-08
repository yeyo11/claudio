---
created_at: 2026-11-08T14:36:12.21521472Z
updated_at: 2026-11-08T14:36:12.21521472Z
tags:
    - plan
    - servers
    - remote-access
    - security
    - architecture
    - design
---
# Plan: Servers — one Claudio drives the others

Status: **planned on 2026-11-08; orchestration A (engine, stages 1-3) launched the same day.**
Requirements gathered from the owner, prior art and pitfalls researched, design validated by the
owner the same day. The UI (stage 4) waits for its own design phase (orchestration B).

## 1. What the owner asked for

The owner runs several Claudios (desktop and headless), each reachable on its LAN listener
(`http://192.168.0.28:8791`, `.29`, `.30`), and today has to open three separate UIs. He wants one
Claudio to switch between them. In his words: each one keeps its own configuration (accounts, chats,
everything), it is only reached remotely; a scope goes **before** the project selector, the default
is always the Claudio that is running; a switch in Settings turns it on and off; a page reached only
from the sidebar (before Projects) adds a new one and lists all of them, with full CRUD; the selector
shows only the recent ones. He asked for a better name than "instance", for research across sources
and languages first (Orca, among others), and for a professional solution, not a temporary patch.

Answers gathered on 2026-11-08:

| Topic | Decision |
| --- | --- |
| What the remotes are | Claudio desktop and headless alike |
| Scope of action | **Full control**: anything one would do in the remote's own UI; it runs and spends on the remote |
| Clients | Desktop app, web in a browser, phone / PWA (not the MCP server or the assistant) |
| Networks | LAN, Tailscale / VPN, and a public tunnel or TLS proxy |
| Where the list lives | **On the local server**: every browser or phone that opens it sees the same servers; credentials never leave it |
| Others while one is selected | **Only the selected one** is queried: no notifications or aggregated views from the rest |
| Authorisation | One-time pairing code as the normal way, a pasted URL + token as the alternative |
| Version skew | First answer was "use the remote's UI"; **revised** after the research to "my UI + the remote's API" (D2) |
| Switching | Same route if it exists there, else that server's Home |
| Visibility | The server's name in the selector and the status bar, with its colour or monogram; no banner |
| Chaining | **One hop**: inside a remote, its own server selector is hidden |
| Turning it off | Servers are kept, hidden and disconnected; no credential is used until it is on again |
| Remote side | Nothing special: no list of incoming connections, no revoke UI there |
| Each entry | Name, colour/monogram, alternative addresses (LAN, Tailscale, tunnel), status and version with **Test connection** |
| Selector | Local pinned first + **3** recents + a link to the page |
| Name | **Server / Servidor**; the local one is "This server" / "Este servidor" |
| LAN transport | **TLS with a pinned fingerprint**, and the LAN listener (8791) itself moves to HTTPS (D6) |

## 2. Prior art

- **Orca** ([onorca.dev](https://www.onorca.dev/), [github.com/stablyai/orca](https://github.com/stablyai/orca)).
  A remote is an *execution host* (`local`, `ssh:<id>`, `runtime:<id>`), shown as "hosts"; its
  selector type is `ExecutionHostScope = 'all' | hostId`. A Remote Orca Server is paired with an
  access link generated on the server (relay invites expire within 10 minutes); each client gets its
  own revocable token. Client and server exchange a protocol version with a minimum on each side and
  block a host as "client too old" / "server too old"
  ([protocol-compat.ts](https://github.com/stablyai/orca/blob/main/src/shared/protocol-compat.ts)).
  **The client ships its own UI** and drives the remote's API; it never loads the remote's UI. Open
  issues worth avoiding: settings saved locally while a remote was active
  ([#26935](https://github.com/stablyai/orca/issues/26935)), frequent disconnects
  ([#14878](https://github.com/stablyai/orca/issues/14878)), one address per server.
- **Cockpit** loaded each remote host's own pages inside the primary's origin and **deprecated the
  host switcher in 322**: a remote host could take over the primary and the other hosts, and no way to
  prevent it was found ([cockpit 322](https://cockpit-project.org/blog/cockpit-322.html),
  [multi-host](https://cockpit-project.org/guide/latest/multi-host.html)). Grafana's data-source
  proxy XSS ([CVE-2022-21702](https://nvd.nist.gov/vuln/detail/CVE-2022-21702)) is the same lesson.
- **Proxmox Datacenter Manager** calls them *remotes*: API token plus a pinned TLS fingerprint;
  removing a remote leaves its token behind on the other side ([docs](https://pdm.proxmox.com/remotes.html)).
- **Portainer** *environments* (Edge agent dials out, reverse tunnel on demand), **Rancher**
  downstream clusters (agent WebSocket), **1Panel** 节点 (nodes: current node bottom-left to switch,
  version per node with Update, online/offline with the reason;
  [1Panel](https://1panel.pro/docs/v2/user_manual/xpack/node/)), **Netdata** nodes with Live / Stale /
  Offline, **Dockge** agents proxied by the primary, **Home Assistant** apps with several servers,
  **Syncthing** devices identified by certificate fingerprint, **Jellyfin** Quick Connect and the OAuth
  device flow ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) for short-lived pairing codes.
- Non-English sources (Chinese 主控/被控 and 节点 panels, Habr Q&A, Spanish Portainer threads) add the
  same complaints: agents on every server, wrong keys failing silently, self-signed certificates and
  clock skew.

## 3. Decisions

- **D1. The name is Server / Servidor.** Used by Orca's docs and Home Assistant; plain in Spanish.
  The local one is "This server" / "Este servidor" with the fixed id `local`; the page is "Servers" /
  "Servidores". MCP servers are always qualified as "MCP servers". Rejected: instance (technical),
  host (anglicism), node (suggests a cluster), machine (two Claudios can share one), environment,
  workspace, peer, agent, device (taken or misleading in Claudio). In code: `ClaudioServer`, routes
  under `/api/servers` (free; `ServerProfile` in `packages/shared/src/types.ts:307` is unrelated).
- **D2. The local UI drives the remote's API through the local server (Orca's model).** The browser
  only ever talks to the server it opened; that server is a gateway to the selected remote. No remote
  JavaScript runs in the local origin. Rejected:
  - *The remote's UI under a path prefix on the local origin* (`/r/<id>/`): Cockpit's mistake. In
    Claudio the remote's UI would read `localStorage['claudio.token']` (`apps/web/src/lib/auth.ts:13`)
    and send the hub's token to the remote, overwrite the hub's drafts, filters and notifications
    (fixed storage keys), and reach the desktop IPC, updates included, because Electron accepts IPC
    from any page of its origin (`apps/desktop/src/main.ts:394`).
  - *The remote's UI on an origin per remote* (a port or subdomain per remote on the hub): isolated,
    but breaks on the transports the owner wants — Tailscale Funnel serves only ports 443, 8443 and
    10000, and a phone outside the LAN would need a hostname per remote.
  - *Redirect the browser to the remote with a one-time ticket*: the browser must reach every remote
    directly; contradicts "the list and credentials live on the local server".
  - *Browser talks to the remote over CORS*: puts the remote's credential in the browser.
  - *Remote dials out to the hub* (Portainer Edge): solves NAT, but a large build that still needs
    one of the above for the UI; kept as a possible later transport.
- **D3. Version compatibility is a contract, checked at connect.** A new `API_VERSION` integer in
  `packages/shared` and a supported range on each server. A remote outside the range is
  **Needs an update**, never a half-working screen. The remote serves `GET /api/meta`.
- **D4. Credentials are per pairing, named and revocable, kept on the hub.** The remote gains named
  access tokens (today auth holds one owner token: `packages/core/src/security/auth.ts:349-384`).
  The hub never stores the remote owner's own token. Deleting a server on the hub revokes its token on
  the remote.
- **D5. Identity is per server, not per address.** `instanceId` plus the TLS fingerprint, pinned at
  pairing. Any address of a server must prove the same identity; a change is a hard block.
- **D6. The LAN listener moves to HTTPS.** The 8791 listener serves TLS with a certificate the server
  generates and keeps; the hub pins its fingerprint. Plain HTTP stays only on loopback. Chosen by the
  owner over a separate server-to-server port and over protocol sniffing on one port. Consequences in
  [Risks](#6-risks) (R11, R12).
- **D7. One hop.** Inside a remote scope, the Servers page, the selector of servers and every
  hub-only surface are hidden. A remote's own servers are never reachable through the hub.
- **D8. Off by default, kept when off.** `servers.enabled` in the app settings; off hides the page and
  the selector, closes the gateway and leaves `servers.json` and the secrets untouched.

## 4. Architecture

### 4.1 Remote side (every Claudio, since each can be a remote)

- **`GET /api/meta`** (no auth): `instanceId` (generated once, kept in the data dir), `version`,
  `apiVersion: { current, min }`, `capabilities: string[]`. No account, path or host data.
- **Named server tokens.** A new token kind beside the owner token, stored hashed, each with a name,
  the pairing hub's `instanceId`, `createdAt`, `lastUsedAt`. The actor is `server:<tokenId>`; it is an
  owner actor for authorisation (full control) and appears as such in the audit. It is **never**
  `fromLocalMachine`, even on a loopback socket, and never a chat token.
- **Pairing, two ways:**
  1. *Code.* The remote's own Servers page has "Allow a connection from another Claudio", which shows
     a one-time code (8 characters, 5 minutes, single use, attempts rate-limited per peer like the
     sign-in back-off). The hub posts the code and its own `instanceId` and name to
     `POST /api/server-links/redeem` and receives a named token plus the remote's `instanceId` and
     fingerprint (already seen in the TLS handshake; must match). This button is the only UI the
     remote needs; it lives on the same page every Claudio has.
  2. *URL + owner token pasted.* The hub calls `POST /api/server-links` once with the owner token to
     mint its named token, then forgets the owner token. Works for headless servers and OIDC ones
     (the owner pastes a token minted for this purpose).
- **`DELETE /api/server-links/self`** lets a hub revoke its own token when the owner removes the
  server.
- **Auth mode `none` cannot be a remote.** Pairing answers `409` as the LAN listener already does.

### 4.2 Hub side

- **Registry.** `<data dir>/servers.json`: per server `id`, `name`, `color`, `monogram`,
  `addresses[]` (ordered; `{ url, kind: 'lan' | 'tailscale' | 'tunnel' | 'other' }`),
  `identity { instanceId, tlsFingerprint }`, `lastUsedAt`, `createdAt`. Settings-shaped, so JSON
  (CONTRIBUTING). Health readings (`status`, `version`, `apiVersion`, `latencyMs`, `checkedAt`) are
  runtime state, not persisted beyond the last one.
- **Secrets.** Each server's token goes in the existing secret vault (`packages/core/src/secret-vault.ts`,
  `secrets.json` sealed by `SecretBox` with `CLAUDIO_SECRET_KEY` on the desktop, a key file beside
  the data in Docker, plain in a 0600 file on a source install without a key, exactly as every other
  secret), never in `servers.json`, never in an API answer.
- **Gateway.** `ALL /api/servers/:id/api/*` → the remote's `/api/*`, owner-only, `404` while the
  feature is off.
  - *Headers.* Strips the hub's `Authorization`, `?token=`, cookies and `X-Forwarded-*`; injects the
    server token; sets `Host` to the chosen address; rewrites or drops `Origin` so the remote's
    cross-site check (`apps/api/src/security.ts:794-798`) and the terminal ticket's origin binding
    (`apps/api/src/terminal-socket.ts:40-59`) see a consistent pair.
  - *SSRF.* Only addresses recorded on the server are reachable; the resolved IP is pinned for the
    connection (undici `connect.lookup`), no redirects are followed, link-local and cloud metadata
    ranges are refused, loopback only when the address was recorded as loopback, and only paths
    under `/api/` pass, normalised and re-checked after decoding. The existing guard
    (`isPublicAddress` in `openai/fetch-image.ts`) refuses private ranges, so it is not reused as is.
  - *TLS.* One `undici.Agent` per server whose certificate check is the pinned fingerprint, not a CA.
  - *Streams.* SSE (`/events`, `/chats/:id/stream`) and the terminal WebSocket are piped, not
    buffered: no compression on the hop, no `bodyTimeout`, the upstream request aborted when the
    browser goes away, `Last-Event-ID` / `?since=` passed through. The remote's 15 s ping keeps
    tunnels open.
- **Address choice.** Probe `GET /api/meta` in the order the owner set (default LAN → Tailscale →
  tunnel), with a short timeout; accept an address only if `instanceId` and fingerprint match. The
  choice is sticky and changes only after consecutive failures (hysteresis), so a flapping network
  does not move streams back and forth.
- **Health.** Only the selected server is probed while in use (owner's choice), plus on demand from
  the page (**Test connection**: REST, SSE and WebSocket checked separately, as Dockge and Portainer
  users find that one breaks while the others work).

### 4.3 Web

- **Scope in the URL.** Remote routes live under `/s/:serverId/…`; the local server keeps its routes
  unprefixed, so nothing changes for anyone who never turns the feature on. Switching maps the current
  route onto the other server and falls back to its Home when the route names something that does
  not exist there.
- **One API client per scope.** `createApi(base)` replaces the fixed `BASE = '/api'`
  (`apps/web/src/api.ts:335`). Every hard-coded `/api` goes through it (`lib/auth.ts:118,169,190`,
  `lib/events.ts:835`, export links, the terminal URL in
  `components/terminal/terminal-connection.ts:182`). The chat stream URL is already injected into
  `packages/chat-ui` (`apps/web/src/lib/chat-ui.tsx:43`).
- **Cache and storage keyed by server.** TanStack query keys start with the `serverId`; the events
  feed is the selected server's; `localStorage` keys that hold per-server data (project scope,
  filters, drafts, review state, notifications, branches, terminal preferences) are namespaced by
  `serverId`. The hub's own token stays the hub's. Theme, language and motion stay global.
- **Hub-only surfaces hidden in a remote scope** (D7): Servers, desktop IPC actions, app updates of
  the desktop, the LAN and tunnel cards that describe the hub. Settings inside a remote scope are
  **that remote's** settings, labelled with its name, so a write never lands on the wrong server
  (Orca #26935).
- **Compatibility gate.** On entering a scope the web reads `/meta`; outside the range it shows the
  server as **Needs an update** and does not render its pages.

### 4.4 UI (to be designed, not settled here)

- Selector before the project selector in the top bar: monogram and name; menu with This server
  pinned, the 3 most recent, and **All servers**. Each row has a status word (Connected,
  Reconnecting, Offline, Needs an update, Needs pairing again).
- The status bar shows the current server.
- Sidebar item **Servers** before Projects, only while the feature is on; on a phone it goes under
  More and the selector opens as a `Sheet`.
- The Servers page: list with status, version and latency; add (code or URL + token); edit name,
  colour and addresses (reorder); Test connection; remove (revokes on the remote).
- Settings switch for the feature.
- Errors: an offline server shows `Empty` with the error illustration and **Retry**; a changed
  identity is a hard block that asks to pair again; a revoked token (401 from the remote) asks to pair
  again.

## 5. Out of scope

Notifications and aggregated views across servers; the MCP server or the assistant acting on other
servers; chaining hops; a list of incoming connections or a revoke UI on the remote; the remote
dialling out to the hub (D2) as a transport.

## 6. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | The hub's credential reaches a remote | Gateway strips `Authorization`, `?token=`, cookies; test per route kind |
| R2 | SSRF from the hub into the LAN or metadata | Recorded addresses only, pinned IP, no redirects, link-local refused, `/api/` prefix only |
| R3 | A remote's code runs in the hub's origin | D2: none ever does |
| R4 | SSE buffered or cut | No compression on the hop, no `bodyTimeout`, abort propagation, the remote's ping |
| R5 | Six HTTP/1.1 connections per origin | Only the selected server's feed is open; never the hub's and a remote's chat streams beyond the current page |
| R6 | A write lands on the wrong server | The API client is per scope; Settings labelled with the server; e2e asserts it |
| R7 | Version skew breaks screens | D3 range check before rendering; `API_VERSION` bump enforced by a test |
| R8 | Orphan tokens on remotes | Remove revokes through `DELETE /api/server-links/self`; a failed revoke is reported, not hidden |
| R9 | The remote takes the gateway for "this machine" | `server:*` actors are never `fromLocalMachine`; no forwarding headers |
| R10 | Address flapping and Host allowlist rejections | Sticky choice with hysteresis; a server-token request is accepted on any Host the listener serves, the token being the proof |
| R11 | **8791 on HTTPS warns in phone browsers** and breaks `http://` bookmarks | Documented in `lan-access.md`; the card shows the fingerprint to compare; plain HTTP on 8791 answers a redirect only if the listener can tell (open question Q1) |
| R12 | Service workers do not register on an origin with a certificate error | No regression: they do not register on plain-HTTP LAN origins today either; a trusted certificate (Tailscale `*.ts.net`) is the way for the PWA |
| R13 | Pairing codes guessed | 8 characters, 5 minutes, single use, per-peer back-off |
| R14 | Secrets at rest on headless | 0600 key file apart from the data, stated in the security model |

The CVE numbers for `@fastify/http-proxy` quoted during research were not verified; the gateway is
written on undici directly (or the plugin at a verified patched version) and its path handling is
tested on its own either way.

## 7. Stages

Each stage is its own pull request, in this order, every one leaving `main` releasable:

1. **Remote side.** `/api/meta`, `instanceId`, `API_VERSION`, named server tokens and the `server:*`
   actor, pairing (code and pasted token), self-revoke; TLS on the LAN listener with a kept
   certificate and its fingerprint shown on the LAN card. REST docs and OpenAPI for each route.
2. **Hub registry and gateway.** `servers.json`, encrypted secrets, the feature switch, CRUD routes,
   address choice, the gateway for REST, SSE and the terminal WebSocket, Test connection.
3. **Scope-aware web, no visible change.** `createApi`, `/s/:serverId` routes, per-server query keys
   and storage keys, hub-only surfaces behind a scope check. The local server must behave exactly as
   before (existing e2e green).
4. **UI.** Design phase first (the `claudio-ui` skill, references, the owner's choice), then the
   selector, the status bar, the Servers page, the settings switch, phone layout, i18n `en`/`es`.
5. **Docs.** `docs/servers.md` as built, `lan-access.md`, `security-model.md`, `rest-api.md`,
   `configuration.md`.

Tests: unit tests for the gateway (header stripping, path normalisation, SSRF, fingerprint, abort),
pairing and token revocation; API tests with two servers in one process; an e2e spec with two
isolated wrappers through Sluice (switch, same-route mapping, a write landing on the remote, offline
and needs-update states).

## 8. Decisions taken after the design (2026-11-08)

- **D9 (was Q1). Plain HTTP on 8791 is redirected.** The listener reads the first byte of each
  connection: a TLS handshake (`0x16`) goes to the HTTPS server, anything else gets a `301` to the
  same path on `https://`. Old bookmarks keep working.
- **D10 (was Q2). The terminal of a remote follows that remote's own rule.** A `server:*` actor is a
  remote peer for `terminal-gate.ts` (never local, never the tunnel), so with the default
  `needs-tunnel` setting a remote's terminal stays closed through the hub unless that server allows
  it. The gateway still proxies the WebSocket so that a server which allows it works.
- **D11 (was Q3). Only the selected server's feed is open.** While a remote is selected the web closes
  the hub's own `/api/events` and opens the remote's through the gateway; switching back reopens the
  hub's. Two feeds are never open together from one tab.

- **D12. A chat with Claudio's MCP on has full control of orchestrations** (owner, 2026-11-08, no
  exceptions). Today the chat token's `person` class keeps from every chat: `permissionMode`,
  `permissionPrompts`, `verification`, `guards`, `allowedTools` on `POST /orchestrations`, deleting
  an orchestration, integrating, opening its pull request, accepting a review gate, the spend pass,
  the Supervisor's send and dismiss, saving a workflow, pruning worktrees and the templates' writes.
  From now on a chat token whose chat has `tools.claudioMcp === true`, read on every request (so
  switching the MCP off takes the access away at once), is treated as the owner on every
  `/orchestrations*` route and field. Every other chat, the orchestration workers included, keeps
  today's classes. The audit still names the chat (`chat:<id>`). The Claudio MCP server gains a tool
  for every orchestration route it lacks (delete, integrate, verify, open the pull request, accept or
  retry the review, spend pass, relaunch, skip, retry clean, rerun, Supervisor send and dismiss,
  prune worktrees, save the workflow, templates, and a message to a task's running chat), so a chat
  can drive a graph from launch to pull request. It sits in this plan because the owner asked for it
  in the same orchestration; it does not depend on servers.

## 9. Contracts and orchestration A (engine: stages 1-3 and their docs)

The UI (stage 4) is a later orchestration B, after its design phase with the owner. Orchestration A
builds everything below it and changes nothing visible for a person who never turns the feature on.

### 9.1 Shared types (`packages/shared/src/types.ts`, owned by `remote-side`)

```ts
/** Bumped on any change that breaks an older web talking to this API through a gateway */
export const API_VERSION = 1;
/** The oldest API_VERSION this server's routes still answer correctly */
export const API_VERSION_MIN = 1;

export interface ServerMeta {
  instanceId: string;            // random, made once, kept in <data dir>/instance.json
  version: string;               // the app version
  apiVersion: { current: number; min: number };
  capabilities: string[];        // e.g. 'server-links', 'gateway', 'lan-tls'
}

export interface ServerLinkCode { code: string; expiresAt: string }           // 8 chars, 5 min, single use
export interface RedeemServerLinkRequest { code: string; hubInstanceId: string; hubName: string }
export interface CreateServerLinkRequest { hubInstanceId: string; hubName: string }
export interface ServerLinkGrant {
  token: string;                 // shown once, never readable again
  tokenId: string;
  instanceId: string;            // this server's
  tlsFingerprint: string | null; // SHA-256 of the LAN certificate's DER, hex with colons; null without TLS
}

export type ServerAddressKind = 'lan' | 'tailscale' | 'tunnel' | 'other';
export interface ServerAddress { url: string; kind: ServerAddressKind }
export type ServerStatus = 'connected' | 'reconnecting' | 'offline' | 'needs-update' | 'needs-pairing' | 'identity-changed';
export interface ServerHealth {
  status: ServerStatus;
  address: string | null;        // the URL in use
  version: string | null;
  apiVersion: number | null;
  latencyMs: number | null;
  checkedAt: string;
  reason?: { code: string };     // i18n code, e.g. 'servers.unreachable'
}
export interface ClaudioServer {
  id: string;                    // never 'local'
  name: string;
  color: string | null;          // a token name, not a hex
  monogram: string | null;
  addresses: ServerAddress[];    // ordered by preference
  identity: { instanceId: string; tlsFingerprint: string | null };
  createdAt: string;
  lastUsedAt: string | null;
  health: ServerHealth | null;   // runtime, not persisted beyond the last reading
}
export interface ServersSettings { enabled: boolean }
export type ServerPairing = { kind: 'code'; code: string } | { kind: 'token'; token: string };
export interface AddServerRequest { name: string; color?: string | null; monogram?: string | null; addresses: ServerAddress[]; pairing: ServerPairing }
export interface UpdateServerRequest { name?: string; color?: string | null; monogram?: string | null; addresses?: ServerAddress[] }
export interface ServerCheck { ok: boolean; latencyMs?: number; code?: string }
export interface ServerTestResult { address: string | null; meta: ServerCheck; rest: ServerCheck; events: ServerCheck; socket: ServerCheck }
export interface RemoveServerResult { revoked: boolean; reason?: { code: string } }
```

### 9.2 Routes

Every route gets a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in
`docs/rest-api.md`; schemas regenerated with `pnpm --filter @claudio/api openapi:schemas`.

| Route | Who | Access | What |
| --- | --- | --- | --- |
| `GET /meta` | remote side | open (no auth) | `ServerMeta` |
| `POST /server-links/code` | remote side | person | a new `ServerLinkCode`; replaces any unused one |
| `POST /server-links/redeem` | remote side | open, rate-limited per peer like sign-in | `RedeemServerLinkRequest` → `ServerLinkGrant`; `409` under auth mode `none` |
| `POST /server-links` | remote side | person (owner token) | `CreateServerLinkRequest` → `ServerLinkGrant` |
| `DELETE /server-links/self` | remote side | the `server:*` actor itself | revokes the calling token; `204` |
| `GET /servers/settings`, `PUT /servers/settings` | hub | person | `ServersSettings` |
| `GET /servers` | hub | person | `ClaudioServer[]`, `404`-free even when off (empty list + settings say off) |
| `POST /servers` | hub | person | `AddServerRequest` → `ClaudioServer`; pairs, pins identity, stores the token in the vault |
| `PATCH /servers/:id` | hub | person | `UpdateServerRequest`; a new address must prove the same identity |
| `DELETE /servers/:id` | hub | person | revokes on the remote, then removes; `?force=true` removes even if the revoke failed; `RemoveServerResult` |
| `POST /servers/:id/test` | hub | person | `ServerTestResult` |
| `POST /servers/:id/use` | hub | person | marks it used (`lastUsedAt`), probes, returns `ClaudioServer` |
| `ALL /servers/:id/api/*` | hub | person | the gateway (REST, SSE, WebSocket); `404` while off |

The `server:<tokenId>` actor: an owner actor for authorisation (`isOwnerActor`), recorded in the
audit, never `fromLocalMachine`/`fromLocalMachineStrict`, a remote peer for `terminal-gate.ts`, and
accepted on any `Host` the listener serves (the token is the proof; R10).

### 9.3 Web contract (owned by `web-scope`)

- Remote pages live under `/s/:serverId/<the same path as local>`; local paths do not change.
- `createApi(base)` where `base` is `/api` for local and `/api/servers/<id>/api` for a remote; one
  `ServerScope` context (`apps/web/src/lib/server-scope.tsx`) gives the current `serverId`
  (`'local'` or an id), its `base`, and `switchTo(id)` which maps the current route (same path if
  it exists, else Home) and calls `POST /servers/:id/use`.
- Every query key starts with the `serverId`; per-server `localStorage` keys get a `:<serverId>`
  suffix for remotes only, so local keys stay as they are (no migration).
- Hub-only surfaces (`/servers`, desktop IPC actions, desktop app updates, LAN, tunnel and auth
  cards) are hidden under a remote scope through one helper (`isHubOnly`), not scattered checks.
- No selector, page or settings UI in this orchestration: the scope is reachable by URL only, and
  the e2e for the visible flow comes with orchestration B.

### 9.4 Tasks

Graph `claudio-servers-engine`, engine `graph`, worktrees on, concurrency 4, base `feat/servers`.
Models are chosen per task (the owner's split of 2026-11-08): opus where security or architecture
decide, sonnet for the wide but specified refactor and for prose.

| id | Owns | Depends on | Model / effort |
| --- | --- | --- | --- |
| `remote-side` | `packages/shared/src/types.ts` (9.1), `/meta`, `instance.json`, named server tokens in `packages/core/src/security/auth.ts`, the `server:*` actor in `apps/api/src/security.ts`, `/server-links*` routes (new `apps/api/src/routes/server-links.ts`), OpenAPI + schemas, `docs/rest-api.md` rows for its routes, tests | — | opus · high |
| `lan-tls` | TLS on the LAN listener (`packages/core/src/lan.ts`): a kept self-signed certificate (`<data dir>/lan-tls/`), the fingerprint in `LanStatus`, the first-byte split and the `301` (D9), `https://` addresses; `apps/api/test/lan.test.ts` | — | opus · high |
| `web-scope` | 9.3 in `apps/web` and `packages/chat-ui`: `createApi`, `server-scope.tsx`, `/s/:serverId` routes, keys, storage, the events feed rule (D11), `isHubOnly` | — | sonnet · high |
| `hub-gateway` | `packages/core/src/servers/` (registry `servers.json`, vault use, address choice, health, pairing client), `apps/api/src/routes/servers.ts` (CRUD, settings, test, use), the gateway for REST, SSE and WebSocket with the SSRF and header rules of 4.2, OpenAPI + rows for its routes, API tests with two servers in one process | `remote-side`, `lan-tls` | opus · xhigh |
| `orchestration-access` | D12: the per-request widening in `apps/api/src/security.ts` (beside the access-class check) and the field check of `POST /orchestrations`, the MCP tools in `packages/mcp/src/write-tools.ts` (+ `names.ts`, `catalogue.ts`), `docs/security-model.md` § Chat tokens, `docs/claudio-mcp-server.md`, tests in `apps/api/test/route-access.test.ts` and the MCP's tests | — | opus · high |
| `security-review` | Reads the whole diff against R1-R14 and D2-D11, fixes what it finds, runs the gates through Sluice | `hub-gateway`, `web-scope` | opus · high |
| `docs` | `docs/servers.md` (new, as built), `docs/lan-access.md`, `docs/security-model.md`, `docs/configuration.md`, the plan's Outcome | `hub-gateway`, `web-scope` | sonnet · medium |

Three stages in series: `remote-side`/`lan-tls`/`web-scope`/`orchestration-access` → `hub-gateway` → `security-review`/`docs`. `security-review` also depends on `orchestration-access`.

Rules for every task: read this plan whole, then `CLAUDE.md` and `CONTRIBUTING.md`; touch only what
your row owns, and say so in your result where a minimal change elsewhere was unavoidable; every
change carries its tests; TypeScript strict, no `any`, `noUncheckedIndexedAccess`; comments explain
why; English everywhere technical; Conventional Commits with a body saying why; never push; verify
through Sluice's `verify` tool with your worktree as `working_directory` (gates `lint`,
`typecheck`, `test`), never by running gates in the shell; no new dependency without saying why in
the result (a certificate generator for `lan-tls` is expected: prefer a maintained pure-JS package).

## Related

[[lan-access.md]] · [[plans/lan-access.md]] · [[security-model.md]] · [[securing.md]] ·
[[api-wire.md]] · [[collaborators.md]] · [[tunnel.md]] · [[accounts.md]] · [[desktop.md]] ·
[[pwa.md]]
