---
created_at: 2026-10-30T20:00:00Z
updated_at: 2026-11-08T18:00:00Z
tags:
    - lan
    - remote-access
    - security
    - desktop
---
# Claudio on the local network

Claudio listens on the local network **itself**, on a fixed port (8791 by default), so a phone or a
laptop on the same Wi-Fi opens `https://<the machine's address>:8791`. It is a second listener inside
the server, with the same sign-in as everything else, a host allowlist that knows its addresses, and
a sign-in back-off bucket for each device. Since 2026-11-08 it speaks **HTTPS** with a certificate of
its own ([below](#https-the-certificate-and-the-redirect)). The design was settled on 2026-10-30 in
[the plan](plans/lan-access.md); this page is how it works as built.

## Why it exists

The desktop app starts its server on `127.0.0.1` and forces it after the person's environment, so
nothing else on the network could reach it. A `socat` forward from a LAN address to that port made
every device arrive from `127.0.0.1`: one shared back-off bucket, no real client in the audit, and a
peer that the desktop's own check (`fromLocalMachine`) takes for the machine itself. `HOST=0.0.0.0`
was not an answer either: the desktop overrides it, and the API would listen on every interface on a
random port with no allowlist of its own.

## What it is

- **A second listener** (`packages/core/src/lan.ts`, `LanListener`, started by the server in
  `apps/api/src/server.ts`). The main listener stays on loopback exactly as it was: the desktop
  window, chats, the MCP server and the shell's own credential all use it. The LAN listener hands
  `request` to the same Fastify routing and `upgrade` to the server's own `upgrade` event, because
  `@fastify/websocket` listens for upgrades on the main server only; the terminal needs it.
- **Guarded like everything else.** The bearer token or OIDC, the access classes and the `Host`
  allowlist run on every request that arrives on it. It speaks TLS.
- **A subsystem of its own**, as the tunnel: a failure to open it (a held port, an address the
  machine no longer has) is the listener's state, never the server's.

## HTTPS, the certificate and the redirect

The LAN listener moved to HTTPS so that another Claudio can pin it ([servers.md](servers.md)) and a
token never crosses the network in clear ([the plan's D6](plans/claudio-servers.md)). Plain HTTP stays
only on the loopback listener.

- **A kept, self-signed certificate** (`packages/core/src/lan-tls.ts`), ECDSA P-256 with SHA-256,
  valid 3650 days (backdated a day for devices with a slow clock). The key (`key.pem`, mode 0600) and the
  certificate (`cert.pem`) live in `<data dir>/lan-tls/`, a directory of mode 0700. It names the
  addresses the listener serves, `<hostname>.local` and the name mDNS answered for.
- **It is made again only when it must be**: when the listener serves an address the certificate does
  not name (a new DHCP lease, a `.local` name that starts to answer), or it is within 30 days of its
  end. Never on a plain restart. A renewal keeps the **key**, so the public key outlives an address
  change; but the fingerprint changes, and each renewal is audited as `Made a new LAN certificate`
  with its fingerprint. The listener serves TLS 1.2 or later.
- **The fingerprint** is the SHA-256 of the certificate's DER, upper-case hex pairs joined by colons.
  `GET /lan` carries it as `fingerprint` (`null` until the listener has ever made a certificate), and
  it is what a pairing grant hands a hub to pin. It survives the listener being turned off. Showing
  it on the LAN card, so a person can compare it with a browser's warning, comes with the Servers UI;
  until then read it from `GET /lan`.
- **The browser warns.** No CA vouches for the certificate, so a browser shows its warning on the
  first visit to `https://<address>:8791`; compare the fingerprint it shows with the one above before
  accepting. A service worker does not register on an origin with a certificate error, so the PWA is
  no worse than it was on plain HTTP; for an installable app and push on a phone, use a trusted
  certificate: Tailscale's `*.ts.net` ([tunnel.md](tunnel.md#a-phone-and-the-local-network)).
- **Plain HTTP is redirected** (D9), so old `http://` bookmarks keep working. One TCP listener per
  address reads the first byte of each connection: a TLS handshake (`0x16`) goes to the app; anything
  else is answered `301` with `Location: https://<the Host the client wrote><path>` and
  `Cache-Control: no-store`. A `Host` that is not a bare name or address with a port, or a target that
  is not a path, gets `400`, so `Location` never carries anything else. A `ws://` upgrade over plain
  HTTP is closed, and a connection that says nothing for 10 s is dropped. The redirect serves nothing
  of the app.

## When it listens

| Where | Default | Why |
| --- | --- | --- |
| Desktop app | on, once a sign-in method is on | The desktop's launcher sets `CLAUDIO_LAN=auto` unless the person's environment sets it |
| Source checkout | off | `CLAUDIO_LAN=on` or the switch in Settings turns it on |
| Docker image, headless image, Helm | off | The container's network is the bridge, not the person's; the published port is the way in. `CLAUDIO_LAN=on`, or `lan.enabled: true` in Helm, opens it |

- **Never under auth mode `none`.** Starting it answers `409 lan.authRequired`, and the moment the
  mode becomes `none` the listener closes every connection, the upgraded ones included, before the
  mode is stored. A headless start under `none` still refuses ([headless image](plans/headless-image.md));
  the LAN never changes that.
- **The settings** are `lan.enabled`, `lan.port` and `lan.bind` (all resettable), kept in
  `<data dir>/lan-settings.json`. `enabled: null` means the launcher's default. Where `CLAUDIO_LAN*`
  fixes a value, the setting is read-only and a write answers `409` with `lan.enabledFromEnv`,
  `lan.portFromEnv` or `lan.bindFromEnv`. The variables are in [configuration.md](configuration.md).
- **The port** is 1024–65535. A held port is the state `port-in-use`: the card says so, names what
  holds it when it can, and offers the next free port. Claudio never kills the holder.
- **The interfaces** are `all` (every IPv4 address) or a list of addresses the machine has. `0.0.0.0`
  is refused in a list: it means every interface, which is `all`.

## The hosts and the back-off

- **Its hosts join the allowlist while it listens.** Each listening address's IP, and the machine's
  `<hostname>.local` when it resolves to one, are runtime hosts, and they leave when it stops.
  `CLAUDIO_ALLOWED_HOSTS` is not touched.
- **Each device is its own bucket.** A LAN host is added with `peerIsClient`, so the back-off of
  wrong credentials is keyed by the socket's address (`req.ip`, which the app never takes from proxy
  headers) and not by one shared bucket. After ten failures a device waits 1 s, doubling to 60 s,
  and no other device is slowed down. The review found that the tunnel's shared bucket could be
  spent from the network by a device naming the tunnel's host (F1), so any runtime host is keyed
  by the socket's address when the peer is not loopback.
- **The desktop credential never reaches a LAN peer.** `fromLocalMachine` needs a loopback socket
  **and** a loopback `Host`; the shell's secret sent from a device, under any name and with a forged
  `X-Forwarded-For`, is `401`. A chat's token is held to the same rule.
- **The terminal** stays as its own remote setting says (`needs-tunnel` by default): LAN peers are
  not the tunnel ([terminal.md](terminal.md)).

## Using it

Settings → Access & safety → Remote access has the card **On the local network**, above the
Tailscale card. It shows a switch and one of five states: **Listening** (ok), **Off**, **Needs a
sign-in method** (the switch is disabled and links to Security), **Port in use** (bad, with **Use the
next free port**), and **Failed** (the error in mono). While it listens it lists the URLs with
**Copy** and a QR, one QR at a time, and a notice about the connection that stays visible while the card is on (its copy still describes the
plain-HTTP listener and changes with the Servers UI). The port and the interfaces have the usual **Changed · Reset** slot.
The design is in [design-system.md](design-system.md).

**For a phone, use Tailscale.** The LAN certificate is self-signed, so the phone warns about it and gets no installable app and no
push notifications (both need a trusted origin). See
[tunnel.md](tunnel.md#a-phone-and-the-local-network).

## The API

`GET /lan`, `PUT /lan/settings`, `POST /lan/start` and `POST /lan/stop`, tag Remote access; all four
are class `person`, so a chat's token is refused, as the tunnel's. Every move emits `lan.changed` on
`/api/events` carrying the whole status, never as a notification. Starting, stopping and a refusal
under `none` are audit rows. The rows are in the [Remote access](rest-api.md#remote-access) table.

## What it does not do

- **No trusted certificate.** The traffic is encrypted since 2026-11-08, but the certificate is
  self-signed: until a device accepts it, whoever can answer for the name (mDNS, ARP) can present
  another certificate, and only comparing the fingerprint tells them apart. A hub that paired with
  the server pins the fingerprint, so it is not exposed to this. Tailscale gives a certificate
  browsers trust ([the review's F6](reports/lan-access-security.md), written when the listener was
  plain HTTP).
- No mDNS advertising, firewall helper or router change, and no change to the loopback listener or
  to how the desktop window reaches the server.

## Known limits

From [the security review](reports/lan-access-security.md), left open on purpose:

- **`all` is every IPv4 interface** (F4): a café network, a public address, the Docker bridge and
  `tailscale0` are listened on too, and on the desktop that happens by itself once a token is on.
  The token still guards it and each peer has its own back-off; narrowing `all` is the owner's
  decision.
- `lan.changed` reaches a chat's token like `tunnel.changed` does (F5); an audit row does not say
  which device made a change (F7); the servers carry Node's default timeouts and no connection cap
  (F8); a person's stop spares a busy connection for up to a second (F9).

## Where things live

| | |
| --- | --- |
| The listener | `packages/core/src/lan.ts` |
| The certificate | `packages/core/src/lan-tls.ts` |
| The forwarders and the second server | `apps/api/src/server.ts` |
| The back-off key and the local-machine checks | `apps/api/src/security.ts` |
| The routes | `apps/api/src/routes/lan.ts` |
| The environment | `packages/core/src/paths.ts` |
| The card | `apps/web/src/pages/config/RemoteAccessTab.tsx` |
| The tests | `apps/api/test/lan.test.ts`, `apps/web/test/lan-card.test.tsx` |

## Related

[[plans/lan-access.md]] · [[plans/claudio-servers.md]] · [[servers.md]] · [[reports/lan-access-security.md]] · [[tunnel.md]] · [[securing.md]] · [[security-model.md]] · [[configuration.md]] · [[rest-api.md]] · [[desktop.md]] · [[terminal.md]] · [[deploy.md]] · [[design-system.md]]
