---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
tags:
    - security
    - authentication
    - deploy
    - operations
---
# Securing an install

How to put Claudio where people other than you can reach it: the guards on agent runs, the
authentication modes, what stays open and the proxy in front. [SECURITY.md](../SECURITY.md) lists
what is and is not protected, and [security-model.md](security-model.md) why the secrets are kept the
way they are. Until 2026-10-17 this page was the README's "Securing it".

> [!IMPORTANT]
> **Authentication is off until you turn it on.** That is right for a port bound to `127.0.0.1`, and
> wrong for anything else: with `mode: none`, anyone who reaches the port can start a chat on your
> account and read every transcript on the machine. Before publishing the port, set
> `CLAUDIO_AUTH_MODE=token` (or `oidc`) and put a TLS-terminating proxy in front.

Claudio starts with authentication **off**, so a local install keeps working untouched. It also
starts bound to `127.0.0.1` and answering only to loopback host names, so "off" is not the same as
"open". Turn the guard on before the port is reachable by anyone you do not trust, and put a
TLS-terminating proxy in front.

## Guards on agent runs

**Guards.** Agent runs are covered by deterministic hooks that hold even in `bypassPermissions`: no
`--no-verify`, no push, no force push, `reset --hard` or recursive delete outside the worktree, and no
secret written into a file. They are on for orchestration workers and the flow, and per project for
chats; Settings → Access & safety → Guards switches them. They are defence in depth against mistakes, **not
a sandbox**: an agent that can run arbitrary code can get round them, so real isolation is still the
container, the user account and the worktree ([docs/guards.md](guards.md)).

## Authentication

**Modes.** Set from Settings → Access & safety, or seeded from the environment on a fresh install
(`CLAUDIO_AUTH_MODE`, `CLAUDIO_AUTH_TOKEN`, `CLAUDIO_OIDC_*`; once an `auth.json` exists in the data
directory it wins over the environment).

| Mode | What a request must carry |
| --- | --- |
| `none` | Nothing. The default |
| `token` | `Authorization: Bearer <token>`. Only the SHA-256 of the token is stored; the token exists once, in the answer that created it, and can be rotated or removed but never read back |
| `oidc` | A JWT that the issuer's JWKS validates, with the `aud` you configured and an unexpired `exp`. With a client id configured, a token whose `azp` names another client is refused |

- **Which hosts it answers to.** A request whose `Host` is neither loopback nor named in
  `CLAUDIO_ALLOWED_HOSTS` is refused `421`, and that happens **before** the credential is looked at,
  so it holds in `mode: none` as well. It is what stops a page on another domain from pointing that
  domain at `127.0.0.1` and driving your install from your own browser. Put a proxy in front and you
  must name the public host there; `GET /api/health` is exempt, so probes are unaffected. Without
  the variable the list is editable in Settings → Access & safety, and a running tunnel adds its own exact
  host, never a pattern, for as long as it answers.
- **Guessing is slowed down.** After ten failed authentications an address is answered `429` with a
  `Retry-After` that doubles from a second to a minute, and is forgotten after fifteen quiet minutes.
  Only a credential that was presented and failed counts (a wrong bearer token, a wrong `?token=`, an
  invalid JWT): a request carrying none is answered `401` and neither counted nor made to wait,
  because on a local install every process shares `127.0.0.1` and something polling without a
  credential would otherwise lock the owner out.
  A token you supply yourself must be at least 24 characters; one Claudio generates is 32 random
  bytes. The wait counts the peer's address, so behind a reverse proxy every client shares one
  count — see [SECURITY.md](../SECURITY.md). Through the tunnel, whose client address is not trusted,
  all traffic shares one count of its own, apart from loopback, so a guess from the tailnet never
  makes the desk wait.
- **The tunnel.** Settings → Access & safety → Remote access refuses to open while the mode is `none`, and turning the
  mode to `none` closes it first. Tailscale encrypts it end to end and terminates TLS on this machine,
  so no third party sees the requests; every member of your tailnet who can reach the node can reach
  the address. See [docs/tunnel.md](tunnel.md).
- **What stays open.** `GET /api/health`, so a probe needs no credential, and the built UI bundle,
  which is what gives a `401` a sign-in screen instead of a blank page. `/docs` and `/openapi.json`
  are guarded like everything else.
- **`?token=`.** A browser cannot put a header on an `EventSource`, an `<img>` or a download link,
  so six GETs also accept the credential in the query string: `/api/events`,
  `/api/chats/:id/stream`, `/api/uploads/:id/content`, `/api/chats/:id/export`,
  `/api/projects/:id/export` and `/api/eval-runs/:runId/export`. Nothing else does. A proxy's access log will record that token, so keep
  query strings out of it for those routes.
- **OIDC is validation only.** Claudio checks a JWT and never talks to a token endpoint or signs
  anyone in; the browser UI signs in with a token, so in `oidc` mode clients bring a JWT their
  identity provider issued (or you run an identity-aware proxy that adds it).
- **Locked out.** Set `CLAUDIO_AUTH_TOKEN` to a new value, add `CLAUDIO_AUTH_TOKEN_RESET=1` and
  restart: the token in the environment replaces the stored hash, the audit log records it with
  actor `env`, and the mode, the OIDC settings and read-only stay as they were. The hash of the
  value applied is kept, so leaving both variables set does not undo a token rotated afterwards.
  With access to the data volume, deleting `<data dir>/auth.json` still works, but it resets the
  whole guard to whatever the environment seeds.
- **Read-only mode.** Every mutating request answers `405`, except answering a permission prompt (a
  person watching a chat can still unblock it) and the switch itself. The prompt has to belong to the
  chat in the path: a request id from another chat answers `404`, exactly as one that never existed
  does. It is for showing the panel to someone.
- **Secrets are not sent back.** `GET /config/mcp` and `GET /config/settings` return the names in a
  server's `env` and `headers` (and in settings' `env`) with a placeholder instead of the value. A
  write that sends the placeholder back keeps what is stored. The per-chat MCP config files Claudio
  writes for `--mcp-config` do hold real values, so they are mode 600 in a mode 700 directory.
- **Push payloads travel through a relay.** A Web Push goes out to the push service of the browser's
  maker (Mozilla, Apple, Google), encrypted per RFC 8291 so they cannot read it — but they do see
  that an install of yours was notified, and when. What a payload holds is therefore only what a lock
  screen shows anyway: the kind, the title and body, the chat or orchestration id, and the path to
  open. No prompt text, no tool arguments, no secrets. The VAPID private key lives in `push.json`
  (mode 600, in the mode 700 data directory) and no route returns it; `GET /push/subscriptions`
  truncates every endpoint, because a full push endpoint URL is a capability to notify that install.
- **Audit log.** Every mutating request is a row: when, who (a token id, an OIDC subject, or `local`
  when nothing guards the API), method, path, status and a one-line summary taken from the route's
  documentation. Bodies are never recorded, because they hold prompts and secrets. `GET /audit`, or
  Settings → Access & safety.
- **The bundle is served locked down.** The UI (and the SPA fallback) carries `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a Content-Security-Policy that
  names the SHA-256 of its one inline script instead of allowing inline script at all. `style-src`
  keeps `'unsafe-inline'`: Vite's build hands out no nonce. The `tls` profile's Caddy sets the three
  simple headers on everything it proxies that did not already send them, `/docs` included, and
  deliberately sets no policy of its own.

## A proxy, and TLS

**TLS.** Claudio does not terminate TLS itself: a proxy does it better, renews certificates and is
already what you run elsewhere. The proxy must pass `Host` **unchanged**, and the name it passes has
to be in `CLAUDIO_ALLOWED_HOSTS` or every request answers `421`; it must set `X-Forwarded-For`,
`X-Forwarded-Proto` and `X-Forwarded-Host`; must not buffer `/api/events` and the chat streams
(`flush_interval -1` in Caddy, `proxy_buffering off` in nginx); and must not cut idle connections
faster than the 15 s heartbeat those streams send. `docker compose --profile tls up -d` runs Caddy
in front of Claudio with all of that already set (`deploy/Caddyfile`); a bare proxy in front of
`mode: none` only encrypts, so **turn authentication on first**. What is still true with everything
on: chats in the image default to `bypassPermissions`, there is one credential for everyone who
holds it, and nothing isolates one person's chats from another's. [SECURITY.md](../SECURITY.md) lists
what is and is not protected.


## Related

[[security-model.md]] · [[guards.md]] · [[tunnel.md]] · [[deploy.md]] · [[configuration.md]] · [[rest-api.md]] · [[known-limitations.md]]
