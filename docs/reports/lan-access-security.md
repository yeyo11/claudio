---
created_at: 2026-10-30T19:30:00Z
updated_at: 2026-10-30T19:30:00Z
tags:
    - report
    - security
    - lan
    - remote-access
---
# Security review: Claudio on the local network

An adversarial review of the LAN listener that `lan-core` and `lan-web` built for
[plans/lan-access.md](../plans/lan-access.md), read against [security-model.md](../security-model.md).
The attacker is a device on the same network as the machine (a phone, a laptop, anything on the café
Wi-Fi), holding no credential, who can send any bytes to port 8791. Where a finding needs a process
on the machine instead, it says so.

Reviewed at `379e21df0` (the LAN commits `dcd13dee3` and `379e21df0`): `packages/core/src/lan.ts`,
`apps/api/src/server.ts` (`lanForwarders`), `apps/api/src/security.ts` (`backoffKey`,
`fromLocalMachine`, `fromLocalMachineStrict`, the guard), `apps/api/src/terminal-gate.ts`,
`packages/core/src/security/auth.ts` (the hook lists), `packages/core/src/paths.ts`
(`CLAUDIO_LAN*`), `apps/api/src/routes/lan.ts`, `apps/api/src/routes/events.ts` and the card in
`apps/web/src/pages/config/RemoteAccessTab.tsx`.

Every reproduction is a test in `apps/api/test/lan.test.ts`: the wrapper's LAN listener on loopback,
port 0, with the machine made to look as if it had `192.168.77.10`, and `inject` with a
`remoteAddress` standing for a device's socket. Nothing bound a real LAN address or port 8791.

## Summary

| Id | Area | Finding | Severity | State |
| --- | --- | --- | --- | --- |
| F1 | D4 | A device names the tunnel's host and spends the tunnel's shared back-off bucket | Medium | Fixed |
| F2 | D2 | A start queued behind the unguard hook reopens the listener under `none` | Low | Fixed |
| F3 | Bind | `0.0.0.0` in the bind list binds every interface and joins the allowlist as a name | Low | Fixed |
| F4 | Bind | `all` (the desktop's default) includes public, Docker bridge and Tailscale interfaces | Medium | Left |
| F5 | Events | `lan.changed` reaches a chat's token, though `GET /lan` is the person's | Low | Left |
| F6 | D6 | Plain HTTP: the token, the `?token=` of the streams and the origin can be taken on the wire | Medium (accepted) | Left |
| F7 | Audit | An audit row does not say which device made a change | Info | Left |
| F8 | Listener | The LAN servers carry Node's default timeouts and no connection cap | Info | Left |
| F9 | Close | A person's stop spares a busy connection for up to a second | Info | Left |

What held, each with the attempt that failed:

- **D8, the desktop credential.** `fromLocalMachine` reads `req.ip`, the socket's address (the app
  sets no `trustProxy`), and needs a loopback `Host` as well. A device sending the shell's secret
  under its LAN name, `localhost`, `127.0.0.1:<port>` or `[::1]`, with `X-Forwarded-For: 127.0.0.1`,
  gets 401; so does a chat's token (`fromLocalMachineStrict` reads the socket and refuses any
  forwarding header from a non-loopback peer). New test: *a device on the network writing a loopback
  Host is neither the desktop app nor a chat*, beside lan-core's own.
- **Owner-only routes.** Every request on the LAN port goes through `app.routing`, so the same
  `onRequest` guard, host allowlist and access classes run. `GET /lan` and the three writes are
  `person`. No route answers a LAN peer without the owner's credential.
- **D7, the terminal.** With `remote: tunnel`, `clientRefusal` needs a loopback peer *and* a lent name
  that is not `peerIsClient`: a device naming the tunnel's host fails the first, a local process
  dialling a LAN name fails the second. The socket's upgrade is handed to `app.server`'s `upgrade`
  event, where `@fastify/websocket` routes it through the same guard and gate.
- **D2, closing.** `beforeUnguarded` is now a list awaited with `allSettled`, the LAN's hook closes
  every connection (upgraded ones included) before the mode is stored, and the request handler
  answers 503 and destroys upgrades under `none` as a second wall. Apart from F2, nothing reopened it.
- **Token in a URL, a log or an event.** The QR and the copied URLs carry `http://<ip>:<port>` only.
  The logger's `req` serializer runs `redactUrl`, which strips `?token=` and `?ticket=`; the audit
  drops the query string; `lan.changed`, the audit summaries and the refusal bodies carry no
  credential.
- **The port.** The setting takes 1024–65535 only; a held port is a state (`port-in-use`) and never
  killed; on Linux a wildcard bind conflicts with another program's specific bind and the other way
  round, so the listener cannot slip in beside a service on the same port.
- **Another device's bucket.** Keys are `runtime:<name>:<req.ip>` for a LAN name and
  `<req.ip>|<name>` for any other, so a `Host` or forwarded header of a device's choosing never
  reaches another device's count. The one exception was F1.

## Findings

### F1 · A device names the tunnel's host and spends the tunnel's bucket (Medium, fixed)

The tunnel's name is a runtime host without a client header (`TUNNEL_HOST_OPTIONS = {}`), so all
tunnel traffic shares one bucket, `runtime:<ts name>`: it arrives from loopback, and nothing tells
its clients apart. Nothing checked that a request on that name arrived from loopback. A device on the
network could send `Host: node.tailnet.ts.net` to port 8791 (the name passes the allowlist while the
tunnel runs) with ten wrong tokens, and every tunnel client whose credential had not worked since the
server started then got 429, the owner's phone signing in again after a restart included. One wrong
guess a minute keeps the wait at its 60-second ceiling. Before the LAN listener only a process on
the machine could do that.

**Reproduced:** *a device on the network naming the tunnel's host spends its own budget, never the
tunnel's*. Ten 401s from `192.168.77.20` under the tunnel's name, then the tunnel's own traffic
(`127.0.0.1`, same name) with the right token: 429 before the fix, 200 after.

**Fix:** `backoffKey` keys a runtime host by the socket's address whenever the peer is not
loopback, not only when the host is `peerIsClient`: a relay runs on this machine, so a peer from the
network is its own client whatever name it writes.

### F2 · A start queued behind the unguard hook reopens the listener under `none` (Low, fixed)

`AuthStore.update` awaits the hooks and only then stores the mode. A `POST /lan/start`, a
`PUT /lan/settings` or a settings reset that reached `LanListener.serial` while the hook's close was
running ran right after it, read the mode while it was still `token`, and opened the listener again;
the mode then turned to `none` with the LAN listening, its addresses lent to the allowlist and the
card saying *Listening*. The request handler's 503 kept every route behind it, so this was a port
left open and a false state rather than an unguarded API.

**Reproduced:** *a start that races authentication being turned off never leaves the listener open*:
`security.update({ mode: 'none' })` and `lan.start()` in the same turn; the state was `listening`
under `none` before the fix.

**Fix:** `open()` reads the mode again once bound; under `none` it gives the port back and refuses.
The hook's close has finished by then and the mode is stored in the same run of microtasks, before
the bind's callback.

### F3 · `0.0.0.0` in the bind list (Low, fixed)

`parseBind` and `CLAUDIO_LAN_BIND` took any IPv4 address, `0.0.0.0` included. The listener then
bound every interface while the person had chosen specific ones, advertised `http://0.0.0.0:8791`,
and lent `0.0.0.0` to the allowlist as a host name, which a page using the 0.0.0.0 route to the
machine sends as its `Host`. The guard still asked for the token, so nothing was reachable without
it; the harm was a wider bind than chosen and an allowlist entry no one meant. The card's chips never
offer it; the API and the environment did.

**Reproduced:** *the unspecified address is not an interface*: `PUT /lan/settings
{ bind: ['0.0.0.0'] }` answered 200; `CLAUDIO_LAN_BIND=0.0.0.0` started.

**Fix:** both refuse it and point at `all` (or leaving the variable unset). Loopback addresses are
still accepted: they lend nothing (`reconcileAddresses` drops loopback) and the tests listen there.

### F4 · `all` includes every IPv4 interface (Medium, left)

`bind: 'all'` is `0.0.0.0`, and on the desktop the listener opens by itself whenever a sign-in method
is on (`CLAUDIO_LAN=auto`, D2). So turning on a token for the tunnel also listens, in plain HTTP, on
whatever network the laptop joins (a café, a hotel, a conference), on a public address where the
machine has one, on the Docker bridge (`172.17.0.1`: every container on the machine, a chat's dev
containers included, can now reach the API, which they could not on loopback), and on `tailscale0`
(the tailnet reaches the listener directly, beside `tailscale serve`). Each address joins the
allowlist. The token still guards all of it and each peer has its own back-off, so this is exposure,
not a way in.

**Not fixed:** it is the behaviour D1 and D2 settle, so changing it is the owner's decision. Options:
leave out of `all` the addresses outside RFC 1918, link-local and CGNAT, and the bridge and tunnel
interfaces (`docker*`, `br-*`, `veth*`, `tailscale*`); or keep them and mark them on the card; or make
`auto` mean "on for the networks the person approved".

### F5 · `lan.changed` reaches a chat's token (Low, left)

`GET /lan` is `person`, but `/api/events` hands every stream every event, and only `login.updated` is
trimmed for a stream that is not the owner's (`routes/events.ts`). A chat's token therefore learns
the machine's interfaces, its LAN addresses and `.local` name, and when the listener opens. The same
holds for `tunnel.changed` and the tunnel's URL today, so it is a property of the feed rather than of
the LAN. **Not fixed:** trimming `interfaces` and `addresses` for streams that are not the owner's
belongs with the tunnel's case, in one decision.

### F6 · Plain HTTP (Medium, accepted by D6)

On the LAN listener the bearer token, the `?token=` of `EventSource` and the downloads, and the
terminal's ticket travel in clear. Anyone who can see the traffic (a shared Wi-Fi, an ARP spoof)
takes the token. Anyone who can answer for the name (an mDNS reply for `<host>.local`, an ARP spoof
of the IP) serves their own page on the same origin, which reads the token the app keeps in that
origin's storage. The card says the connection is unencrypted, always visible while it is on, and
recommends Tailscale for the phone; TLS is out of the plan's scope. **Left**, as decided.

### F7 · An audit row does not say which device (Info, left)

A change over the LAN is audited with its actor (the token id) and no client address, so the owner
cannot tell the phone's changes from the laptop's or from a stranger who took the token (F6). The
terminal's history does keep the socket address. Adding a client column to the audit is a schema
change outside this review.

### F8 · Node's defaults on the LAN servers (Info, left)

Each LAN `http.Server` is created bare: Node's `headersTimeout` (60 s) and `requestTimeout` (300 s)
apply, there is no `maxConnections`, and body limits come from the routes (`app.routing`). A device
can hold many idle connections. Exhaustion attacks are outside this review; worth a cap if the
listener ever leaves the desktop.

### F9 · A person's stop spares a busy connection for a second (Info, left)

`stop('request')` and a settings change close gracefully: a connection with a reply in flight lives
up to `REPLY_GRACE_MS` (1 s), so the stop answered over the LAN reaches the phone. A request
pipelined behind it in that second is still routed, with the LAN names already out of the allowlist
(only a loopback `Host` passes) and the token still required. Turning authentication off never
spares anything.

## Changes

- `apps/api/src/security.ts`: `backoffKey`, F1.
- `packages/core/src/lan.ts`: `open()` reads the mode once bound (F2); `parseBind` refuses `0.0.0.0`
  (F3).
- `packages/core/src/paths.ts`: `CLAUDIO_LAN_BIND` refuses `0.0.0.0` (F3).
- `apps/api/test/lan.test.ts`: the three reproductions, failing before the fixes, and the D8 test from
  the device's side.

Gaps `lan-core` left in the suite, not security findings, fixed so the suite passes:

- `packages/core/test/profile.test.ts`: `lan` is started by the server, like `tunnel`, not by the
  core's constructor.
- `apps/api/scripts/generate-schemas.ts` and `schemas.json`: `UpdateLanSettingsRequest`, which
  `PUT /lan/settings` refers to, was missing from the components.
- `apps/web/src/i18n/locales/{en,es}/auditRoutes.json`: the three LAN writes, with their Spanish,
  and the six strings in `apps/web/test/fixtures/strings.json`.

## Related

- [[plans/lan-access]]
- [[security-model]]
- [[securing]]
- [[tunnel]]
- [[terminal]]
