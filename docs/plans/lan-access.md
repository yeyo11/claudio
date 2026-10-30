---
created_at: 2026-10-30T12:00:00Z
updated_at: 2026-10-30T12:00:00Z
tags:
    - plan
    - lan
    - remote-access
    - security
    - desktop
    - design
---
# Plan: Claudio on the local network

Status: **design settled by the owner on 2026-10-30; not built.** One pull request from `main` at
0.12.0, orchestrated on `claude-opus-5-5` and `claude-sonnet-5-5`.

This plan is the source of truth for the orchestration, with `CLAUDE.md` and `CONTRIBUTING.md`. Where
a task prompt and this plan disagree, the plan wins. It narrows the 2026-10-25 plan
`assistant-everything` (D10–D13, never built; its only commit is on branch `feat/assistant-everything`)
to the LAN alone: its approvals, MCP catalogue, accounts and handoff
parts were built by other work or dropped, and its design of the LAN is re-derived below on the code
of 0.12.0.

## Why

The desktop app starts its server with `HOST: '127.0.0.1'`, forced after the person's environment
(`apps/desktop/src/server-process.ts:59`), on a port it remembers (`server-port.ts`). Nothing else on
the network can reach it. The owner worked around that with
`socat TCP-LISTEN:8791,bind=<lan ip>,reuseaddr,fork TCP:127.0.0.1:<port>`, which makes every LAN
device arrive from `127.0.0.1`: one shared sign-in back-off bucket, no real client in the audit, and
a loopback peer that the desktop's own checks (`fromLocalMachine`) take for the machine itself.

Setting `HOST=0.0.0.0` is not an answer: the desktop overrides it, and the API would then listen on
every interface on a random port with no allowlist of its own. Claudio needs to listen on the
network **itself**, on a fixed port, with the guard and the host allowlist knowing who is asking.

## Decisions

- **D1. A second listener inside the server.** The main listener stays on loopback exactly as it is
  (the desktop window, chats, the MCP server and the shell's own credential all use it). The LAN
  listener is a second `http.Server` on a fixed port (8791 by default), on all interfaces or the ones
  the person chose. It forwards `request` to `app.routing(req, res)` and `upgrade` to
  `app.server.emit('upgrade', …)`, because `@fastify/websocket` listens for upgrades on
  `fastify.server` only (the terminal needs it).
- **D2. On by default on the desktop when auth is `token` or `oidc`; refused under `none`.** It
  closes the moment the mode becomes `none`, like the tunnel. In the container, the headless image and
  Helm it is off unless `CLAUDIO_LAN=on`; a headless start under `none` still refuses
  (`headlessStartProblems`), and the LAN never changes that.
- **D3. Its hosts join the allowlist while it listens.** Each listening address's IP, and the
  machine's `<hostname>.local` when it resolves, are added as runtime hosts and removed when it
  stops.
- **D4. Each LAN client is its own back-off bucket.** A new runtime host option
  `peerIsClient: true` keys `backoffKey` by the socket's address (`req.ip`, which the app does not
  take from proxy headers) instead of one shared `runtime:<name>` bucket.
- **D5. The writes are class `person`, as the tunnel's.** `PUT /lan/settings`, `POST /lan/start` and
  `POST /lan/stop` are refused to a chat's token. No new access class.
- **D6. The screen says it is plain HTTP.** The token travels unencrypted on the network, and a phone
  gets no installable app and no push there; Tailscale is the recommendation for the phone. TLS is
  out of scope.
- **D7. The terminal stays refused over the LAN** unless its remote setting says otherwise
  (`needs-tunnel` today); the LAN peers are not the tunnel.
- **D8. The desktop credential never reaches a LAN peer.** `fromLocalMachine` already needs a loopback
  socket **and** a loopback `Host`; the listener must not weaken it, and a test proves a LAN request
  carrying the shell's secret is refused.

## Design

The card **On the local network** sits in Settings → Access & safety → Remote access, above the
Tailscale card, built like `TunnelCard` (`RemoteAccessTab.tsx`).

```
On the local network                                    [switch] ● Listening
Devices on your network open Claudio at:
  http://192.168.0.30:8791     [Copy] [QR]
  http://yeyo-pc.local:8791    [Copy] [QR]
Port [ 8791 ]   Interfaces (•) All  ( ) Choose…  [192.168.0.30 ✓] [10.0.0.4]
⚠ Plain HTTP: your token travels unencrypted on this network, and a phone
  gets no app or notifications here. For the phone, use Tailscale below.
                                                            Changed · Reset
```

- **States:** Listening (ok, with the word), Off, **Needs a sign-in method** (warn; mode `none`; the
  switch is disabled and links to Security, as `TunnelPanel` does), **Port in use** (bad; "Another
  program holds port 8791", the port field focused, and **Use the next free port** reusing the
  tunnel's `portTaken` pattern), Failed (bad, the error in mono).
- One QR at a time (the one opened), drawn with `QrCode`. The URL list is mono; the rest is sans.
- `Changed · Reset` slot per setting (`lan.enabled`, `lan.port`, `lan.bind`), as every row.
- Phone: the card stacks, URLs wrap, the QR opens in a `Sheet`, touch targets ≥ 44 px.
- The notice about plain HTTP is always visible while the card is on, never behind a click.
- Copy goes through i18n with `en`/`es` parity, `es` per `apps/web/src/i18n/GLOSSARY.md`.

## Contracts

- **Types** (`packages/shared/src/types.ts`): `LanSettings { enabled: boolean | null; port: number;
  bind: 'all' | string[] }` (`enabled: null` = the launcher's default, D2);
  `LanStatus { state: 'off' | 'listening' | 'refused' | 'port-in-use' | 'failed'; reason: { code,
  text } | null; port; addresses: { ip: string; host: string | null; url: string }[]; settings:
  LanSettings; available: boolean; portTaken: TunnelPortTaken | null }` (`available` is false where
  the environment turns it off). Regenerate the schemas after changing them.
- **Core** `packages/core/src/lan.ts`, `LanListener` in the shape of `TunnelManager`: `attach(handler,
  upgradeForwarder)` from `startServer`; `start()` refuses mode `none`; `stop('request' |
  'unguarded')`; settings in `<dataDir>/lan-settings.json` (a settings-shaped document, so JSON).
- **Guard hook:** `security.beforeUnguarded` is a single slot today (`packages/core/src/index.ts:698`,
  where the tunnel sets it). It becomes a list, and the tunnel and the LAN each register.
- **Runtime hosts:** `RuntimeHostOptions` (`packages/core/src/app-settings.ts:119`) gains
  `peerIsClient?: boolean`; `RuntimeHosts.add` keeps it; `backoffKey` (`apps/api/src/security.ts:161`)
  keys such a host by `req.ip`.
- **Server** (`apps/api/src/server.ts`): the second `http.Server` is created and closed in
  `startServer`, and started through `core.startSubsystem('lan', …)` as the tunnel is (`:147`), so a
  failure of it is never the server's.
- **Routes:** `GET /lan`, `PUT /lan/settings`, `POST /lan/start`, `POST /lan/stop`; tag `Remote
  access`; access `person` for the writes and the read; a summary each in
  `apps/api/src/openapi/routes.ts` and a row each in `docs/rest-api.md` (a test checks both). Every
  move emits `lan.changed` on `/api/events` with the whole status, never as a notification.
- **Environment:** `CLAUDIO_LAN` (`on` | `off` | `auto`; `auto` = on with a credential),
  `CLAUDIO_LAN_PORT` (8791), `CLAUDIO_LAN_BIND` (comma-separated IPs), parsed in
  `packages/core/src/paths.ts` like `CLAUDIO_TUNNEL`; an unknown value stops the start. The desktop's
  `serverEnv` sets `CLAUDIO_LAN=auto` unless the person's environment sets it. The image and Helm
  default to `off`; Helm gains `values.lan.enabled` (false) and `values.lan.port`.
- **Setting ids** `lan.enabled`, `lan.port`, `lan.bind` in `packages/shared/src/setting-ids.ts` and
  the settings registry (`packages/core/src/settings-registry.ts`), each resettable.
- **Audit:** starting, stopping and a refusal under `none` write a row, as the tunnel's.

## Tasks

```
lan-core (opus) ── lan-web (sonnet) ──┐
                                      ├─ security-review (opus) ── docs (sonnet)
```

| Id | Model | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- | --- |
| `lan-core` | claude-opus-5-5 | D1–D5, D7, D8, Contracts (server side) | – | `packages/core/src/lan.ts`; `packages/core/src/index.ts` (the hook list, the `lan` member); `packages/core/src/app-settings.ts`; `packages/core/src/paths.ts`; `packages/core/src/settings-registry.ts`; `apps/api/src/server.ts`; `apps/api/src/security.ts` (`backoffKey` only); `apps/api/src/routes/lan.ts`; `apps/api/src/openapi/routes.ts`; `packages/shared/src/types.ts`, `setting-ids.ts`; `apps/desktop/src/server-process.ts`; `docker/`, `docker-compose.yml`, Helm values and deployment; tests: refused under `none`, closed on unguard, port in use, a request on the LAN port reaches a route, an upgrade reaches the terminal socket, back-off per peer, the shell's secret refused from a LAN peer | `verify` lint, typecheck, test |
| `lan-web` | claude-sonnet-5-5 | Design above | `lan-core` | `apps/web/src/pages/config/RemoteAccessTab.tsx` (the new card above `TunnelCard`); `apps/web/src/api.ts`; the `lan.changed` event; `remoteAccess` strings in `apps/web/src/i18n/locales/{en,es}/config.json`; its subsection in `docs/design-system.md` and `docs/design-system/claudio-ds.css`; tests; `e2e/specs/remote-access.spec.mjs` (the card's states) | `verify` lint, typecheck, test, e2e `remote-access`; `/ui-review` of the card, both themes, 1280 × 720 and 390 × 844 |
| `security-review` | claude-opus-5-5 | Adversarial review of the listener, the host allowlist, the back-off keys and D8 | `lan-core`, `lan-web` | a report in `docs/reports/lan-access-security.md`; fixes only for findings it can prove with a test | `verify` test |
| `docs` | claude-sonnet-5-5 | `docs/lan-access.md` (new), `docs/configuration.md` (`CLAUDIO_LAN*`), `docs/securing.md`, `docs/security-model.md`, `docs/tunnel.md` (what to use for a phone), `docs/rest-api.md` rows, `docs/status.md`, this plan's Outcome | `security-review` | the listed docs | prose only: every path and link exists |

Workers start in fresh worktrees from `main`. None runs `pnpm dev` with the owner's
`CLAUDIO_DATA_DIR` or `PORT` in its environment (it once closed the owner's tunnel), and none starts
a listener on the LAN port of the owner's machine: tests bind port 0 on loopback or a chosen test IP.

## Risks

- **A shared back-off bucket** would let one device on the network lock out every other. D4 and its
  test are the guard.
- **The LAN listener is a new way in.** It is guarded by the same token or OIDC as everything else
  and closes under `none`, but it is plain HTTP; the card says so, and `security-review` tries to
  reach the desktop credential and the owner-only routes from a LAN peer.
- **`@fastify/websocket` upgrades** are tied to `fastify.server`; forwarding them is the part most
  likely to differ from the plan, so the upgrade test comes first.
- **Port 8791 may be taken** (the owner's old `socat` holds it). The card reports it and offers the
  next free port; it never kills the holder.

## Not in this plan

- TLS on the LAN listener (Tailscale covers the encrypted case).
- mDNS advertising, a firewall helper, or opening the router.
- Any change to the loopback listener or to how the desktop window reaches the server.

## Related

- [[plans/tunnel]]
- [[tunnel]]
- [[security-model]]
- [[securing]]
- [[desktop]]
- [[configuration]]
- [[rest-api]]
- [[design-system]]
- [[plans/headless-image]]
