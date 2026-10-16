---
created_at: 2026-09-21T07:35:14Z
updated_at: 2026-10-16T12:00:00Z
tags:
    - deploy
    - docker
    - kubernetes
    - tls
    - operations
    - updates
---
# Deploying Claudio

Three ways to run the image, from one machine to a cluster, what a phone needs from it, how it learns
of a new release, and what to know about restarts.

## Docker Compose

```bash
cp .env.example .env
docker compose up -d                   # Claudio alone, on 127.0.0.1:8797
docker compose --profile tls up -d     # plus a TLS-terminating proxy on :80 and :443
```

The default profile publishes the API on `127.0.0.1` only. The `tls` profile adds Caddy in front of
it, using [`deploy/Caddyfile`](../deploy/Caddyfile). Set `CLAUDIO_DOMAIN` in `.env` to a public name
and Caddy fetches and renews a Let's Encrypt certificate; left as `localhost` it issues one from its
own local CA, which is enough to try it. Its certificates live in a volume, so recreating the
container does not spend a rate-limited issuance.

Claudio does not terminate TLS itself, and the proxy only encrypts: **turn on authentication before
you use the `tls` profile** (`CLAUDIO_AUTH_MODE=token` and `CLAUDIO_AUTH_TOKEN` in `.env`, or
`oidc`). Set `CLAUDIO_ALLOWED_HOSTS` in the same `.env` at the same time — see below.

The proxy must:

- pass `Host` through unchanged, and set `X-Forwarded-For`, `X-Forwarded-Proto` and
  `X-Forwarded-Host` (Caddy does all of it);
- not buffer `/api/events` and the chat streams, which are long-lived event streams
  (`flush_interval -1` in Caddy, `proxy_buffering off` in nginx);
- not cut idle connections faster than the 15 s heartbeat the streams send;
- carry the WebSocket upgrade of the [terminal](#the-terminal), which every shell uses
  (`/api/terminals/<id>/socket`).

Caddy does that by default. nginx needs these lines in the `location` that proxies Claudio:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 1h;
```

### The host allowlist, and why a proxy has to be told about it

Claudio refuses a request whose `Host` is neither loopback nor named in `CLAUDIO_ALLOWED_HOSTS`,
with `421 Misdirected Request`, before it even looks at the credential. That is what stops a page on
someone else's domain from rebinding that domain to `127.0.0.1` and driving a local install from the
browser of whoever visited it; same-origin policy does not, because to the browser the name has not
changed.

A reverse proxy is exactly the case where this bites. Behind one, the `Host` that arrives is no
longer `localhost`:

- **Passing `Host` through** (Caddy's default, nginx's `proxy_set_header Host $host`) means Claudio
  sees your public name — so put that name in `CLAUDIO_ALLOWED_HOSTS`. With the `tls` profile it is
  whatever `CLAUDIO_DOMAIN` is set to, and `.env` reaches the container through `env_file`:

  ```dotenv
  CLAUDIO_DOMAIN=claudio.example.com
  CLAUDIO_ALLOWED_HOSTS=claudio.example.com
  ```

  More than one name (an internal one alongside the public one) is a comma-separated list. Ports and
  letter case are ignored, so `claudio.example.com:8444` and `Claudio.Example.com` both match.
- **A host that is not fixed** — a tunnel that mints a new one on every start, a preview environment
  per branch — is what the `*.domain` form is for: `CLAUDIO_ALLOWED_HOSTS=*.tunnel.example` answers
  to every subdomain of `tunnel.example` without naming each one. It never covers the domain itself,
  so add that separately if it is served too, and the leading dot is part of the comparison, so
  `*.tunnel.example` does not answer to `eviltunnel.example`. Name a domain you control or that a
  provider controls; a wildcard over a public suffix (`*.com`) guards nothing and is refused at
  startup rather than accepted.
- **Adding a host later** does not need a restart. Settings → Security → Allowed hosts keeps the
  variable's hosts fixed and lets you add more, which answer beside them from the next request
  ([layered-settings.md](layered-settings.md)).
- **Rewriting `Host` to the upstream** (nginx's `proxy_set_header Host $proxy_host`, some ingress
  controllers by default) makes Claudio see the service name or the pod address. Either pass the
  original name instead, or add whatever the proxy sends to `CLAUDIO_ALLOWED_HOSTS`. In the Helm
  chart that goes in `env`.

Get it wrong and **every page and every call answers `421`** with `this wrapper does not answer to
that host`, which looks like a broken deployment rather than a setting. `GET /api/health` is exempt,
so the container healthcheck and the chart's probes keep passing while everything else is refused —
a healthy container serving 421 is this, nearly every time.

One thing the allowlist does not do: it only stops a browser, which cannot choose the header it
sends. Anything scripted sets its own `Host` and walks past it. It closes DNS rebinding; it is not
access control, and it is no substitute for turning the guard on.

## Kubernetes (Helm)

```bash
kubectl create secret generic claudio-claude --from-literal=CLAUDE_CODE_OAUTH_TOKEN=…
kubectl create secret generic claudio-token --from-literal=token="$(openssl rand -hex 32)"
kubectl create secret generic claudio-secret-key --from-literal=secret-key="$(openssl rand -hex 32)"

helm install claudio ./deploy/helm/claudio \
  --set image.tag=0.36.1 \
  --set claude.existingSecret=claudio-claude \
  --set auth.mode=token --set auth.token.existingSecret=claudio-token \
  --set secretKey.existingSecret=claudio-secret-key
```

The chart is a Deployment (one replica, `Recreate`), a Service, and one PersistentVolumeClaim that
holds everything worth keeping through subPaths: `/data`, `~/.claude`
and `/workspace`. The claim carries `helm.sh/resource-policy: keep`, so `helm uninstall` leaves the
account setup and the transcripts alone. Values worth knowing: `image.tag` (a release, not `latest`, so
`IfNotPresent` means something), `port`, `resources`, `securityContext` and
`containerSecurityContext`, `env` (where `CLAUDIO_ALLOWED_HOSTS` goes when an Ingress gives the pod
a host name), `persistence.*`, `auth.mode` (`none`, `token`, `oidc`), `auth.readOnly`, and
`secretKey.*`, the vault's key (below). `helm lint` and `helm template` are clean for every auth mode;
rendering fails on purpose when `token` or `oidc` is chosen without what it needs.

`secretKey` passes `CLAUDIO_SECRET_KEY` ([the secret vault and its key](#what-the-image-contains))
from a Secret, as `valueFrom.secretKeyRef`, the way `auth.token` passes the API token:
`secretKey.existingSecret` names a Secret you made, with the key under `secretKey.key` (`secret-key`
by default), which keeps the value out of the release; `secretKey.value` instead makes the chart
create `<release>-secret-key` holding it, which ends up in the release history, so it is for a test
cluster. Rendering fails when `secretKey.value` is not 32 bytes as hex, or when `env` also sets
`CLAUDIO_SECRET_KEY`. With neither, the server makes the key on the data volume, and the release
notes say so.

There is exactly one replica because the SQLite store is shared by the API and the CLI processes it
starts. Do not scale it.

The `auth.*` values seed a volume that has no `auth.json` yet. After that the settings saved in the UI
win, so changing the value and upgrading does not change a running install.

`terminal.enabled` (default `false`) writes `CLAUDIO_TERMINAL` as `off` or `on`; see
[the terminal](#the-terminal). `tunnel.enabled` (default `true`, as in the image) decides whether the pod runs its own
`tailscaled` and Settings → Remote access may serve it on a tailnet; see the next section. The deployment always writes `CLAUDIO_TUNNEL` as `on` or `off`,
and `NOTES.txt` warns when it is on.

## The terminal

Settings → Terminal opens the person's own shell in the browser. It is off until someone turns it on,
and in a container it has two conditions:

- **Authentication.** The image listens on `0.0.0.0`, so with `CLAUDIO_AUTH_MODE=none` every request
  reaches the server from the Docker bridge, not from loopback, and the terminal reports
  `needs-auth`. With a token (or `oidc`) it works, as user `node`, in `/workspace/...`.
- **Where from.** A device other than the container itself gets a terminal only through the
  [tunnel](tunnel.md), with a token. A reverse proxy such as Caddy counts as the plain address, not as
  the tunnel, because Claudio does not trust the headers it sends: reach the terminal through the
  tunnel, or from a shell on the host.

The shell is the login shell of `node` plus the credentials the app keeps for `gh`, `glab` and the
tracker CLIs; never a `CLAUDIO_*` variable and never Claude's credentials. Shells outlive a closed
tab but end when the server stops.

`CLAUDIO_TERMINAL=off` vetoes the feature for the whole deployment: the environment wins and the UI
shows the setting read-only. `CLAUDIO_TERMINAL=on` switches it on. Unset leaves it to the UI. The
chart's `terminal.enabled` writes it, `false` by default. The image carries `/app/terminal-host.mjs`,
the process the server forks for the shells, and `/app/node_modules/node-pty` beside it, a prebuilt
binary: nothing is compiled in either build stage.

## The tunnel in Docker

Settings → Remote access serves Claudio on the person's tailnet through the Tailscale CLI
(`tailscale serve`, never Funnel; [tunnel.md](tunnel.md)). A container sees neither the host's
`tailscale` CLI nor its daemon, so **the image runs a Tailscale of its own** (owner decision,
2026-10-08), and the person signs it in from the app: the setup assistant's Access step or Settings
→ Remote access, with a login link or an auth key ([setup.md](setup.md#tailscale)). Nobody needs a
shell on the machine.

- **What is in the image.** Tailscale's static linux amd64 build (`tailscale` and `tailscaled`,
  `TAILSCALE_VERSION`, 1.102.4), from pkgs.tailscale.com, checked against the digest published beside
  it like gh and glab.
- **How it runs.** `docker/entrypoint.sh` starts `tailscaled --tun=userspace-networking` as the
  image's user before the server, then `exec`s the server, which still receives `docker stop`.
  Userspace networking needs no root, no `NET_ADMIN` and no `/dev/net/tun`, so the container needs
  nothing added to its `docker run`, Compose service or pod spec. tailscaled ends with the container.
- **Where its state is.** `/data/tailscale/` on the data volume: the node's state
  (`tailscaled.state`, mode 0700 folder), its certificates, and `tailscaled.log`, written anew on
  each start. A replaced container keeps its node, its name and its sign-in. The socket is the CLI's
  default, `/run/tailscale/tailscaled.sock`, so `docker exec <container> tailscale status` works.
- **The node's name** is `claudio` (`CLAUDIO_TAILSCALE_HOSTNAME`); Tailscale adds a number when the
  tailnet already has one.
- **Serve in userspace networking.** The tailnet connection ends inside tailscaled's own network
  stack, and Serve's proxy dials `http://127.0.0.1:8797` from the tailscaled process, which shares the
  container's network, so the rule reaches the server as it does on a host. It is how Tailscale's own
  container image runs Serve (`TS_USERSPACE` on by default, with `TS_SERVE_CONFIG`). Measured here:
  the daemon starts in userspace mode as `node` and reports `NeedsLogin` with `TUN: false`; Serve end
  to end needs a signed-in node and was not measured.
- **Direct connections.** Without UDP 41641 published, tailnet peers reach the container through
  Tailscale's relays (DERP): it works, a little slower. Publishing `41641/udp` lets them connect
  directly.
- **Logs Tailscale uploads.** tailscaled sends its own logs to Tailscale, as it does everywhere;
  `TS_NO_LOGS_NO_SUPPORT=true` in the container's environment turns that off (and Tailscale's support
  with it).

**Turning it off.** `CLAUDIO_TUNNEL=off` in `.env` (or `tunnel.enabled: false` in the chart) starts no
tailscaled and offers no tunnel; the tab says so and names the switch. A source install and the
desktop app use the machine's own Tailscale, on by default, and `CLAUDIO_TUNNEL=off` turns it off
there too. `CLAUDIO_TUNNEL` accepts `on`/`1`/`true` and `off`/`0`/`false`, with empty or unset meaning
the default. Any other value stops the server at startup. In the image, the default follows the
daemon: the server offers the tunnel because the entrypoint said it started one
(`CLAUDIO_TAILSCALE_MANAGED=1`); an image started with another entrypoint offers none.

What to know before you open it:

- **The tunnel goes around everything in front of the server.** Once it opens, the Serve rule reaches
  `127.0.0.1:8797` inside the container, so tailnet members come in around the port Compose publishes
  only on `127.0.0.1`, the `tls` profile's Caddy, and in Kubernetes the Service, the Ingress and any
  ingress NetworkPolicy. (The localhost.run tunnel this replaced was measured doing exactly that, from a
  container that published no port; the evidence is in [the plan](plans/tunnel.md#answer-the-tunnel-in-docker).)
- **Operators decide ingress in their manifests**, and a pod that opens its own way in can look like a
  backdoor to a security review. Nothing opens by itself: a node has to be signed in, authentication
  turned on, and the tunnel opened by someone. Where that is not wanted, turn it off as above.

Turned on, the tunnel is the same as everywhere else. It refuses to open while the auth mode is
`none`, even if `auth.mode` in the chart only seeded a volume and the UI changed it later: it checks
the live mode. Only the node's exact name joins the allowlist, and it opens only when someone presses
the button or turns on "start with Claudio". Where it is off, the tab says so and names the switch.

## Webhooks and the public address

GitHub can tell Claudio that a pull request, a check or a review changed
([code-hosts.md](code-hosts.md#events-and-paced-polling)). A host delivers only to an address it can
reach, so a hook needs a public one:

- **Today Claudio knows no public address.** The tunnel is tailnet-only (`tailscale serve`), so a
  code host on the internet cannot deliver to it ([tunnel.md](tunnel.md#webhooks)). Registering is
  refused with `no-public-url`, and polling carries on alone, which is correct, only slower. There is
  no "configured public origin" setting yet. A deployment behind its own domain (the `tls` profile, an
  Ingress) has no way to register a hook until one exists.
- **Expose one path.** A delivery is `POST /api/webhooks/github/<registration id>` (and `gitlab`).
  It carries no bearer token: the signature is the credential. If a proxy or an Ingress filters by
  path, let `/api/webhooks/` through to Claudio and keep the rest as it is. The public name must be
  on `CLAUDIO_ALLOWED_HOSTS` like any other.
- **Keep the body as it comes.** The signature is over the raw bytes, so a proxy must not rewrite,
  recompress or re-encode a body. Bodies over 5 MiB are answered `413`, and at most 60 deliveries a
  minute per registration are accepted (`429`).
- **The secrets are in the data directory**, in `webhook-secrets.json` (mode 0600), so the volume
  that holds the accounts holds them too. Back it up and protect it the same way.
- **Read-only mode** (`auth.readOnly`) still takes deliveries: they change no state of their own.

## What the image contains

The image is built in two stages. The stage that runs holds one compiled JavaScript file
(`/app/api.mjs`, started by `CMD`, with `/app/terminal-host.mjs` and the `node-pty` module beside it), the built UI (`/app/web`, which is why the image sets
`CLAUDIO_WEB_DIST=/app/web`), the Claude Code CLI and the tools a chat needs. There is no source
tree, no transpiler and no `node_modules` but `node-pty`'s: `docker build -f docker/Dockerfile .` is unchanged for
you, the image is smaller and it starts faster. pnpm is still installed, for the projects Claude
works on under `/workspace`, not to start anything.

**One agent.** Claude Code is the only agent in the image; the other tools it carries are below.

**The code hosts' and YouTrack's CLIs.** `gh` and `glab`, the only way Claudio reaches GitHub and
GitLab ([[code-hosts.md]]), are in `/usr/local/bin`, taken from the vendors' linux amd64 release
tarballs: `GH_VERSION` (2.102.0) and `GLAB_VERSION` (1.120.0), the versions the host recordings were
made with. Each tarball is checked against a pinned SHA-256 (`GH_SHA256`, `GLAB_SHA256`), and that
digest must also be the one in the vendor's published checksums file, so a bump is the version and
the digest together; `docker/Dockerfile` carries the two commands that print it. JetBrains'
`youtrack-app` ([[trackers.md]]) comes through npm, pinned as `YOUTRACK_APP_VERSION`
(1.0.3). Their sign-ins live in `/data/provider-homes/gh` and `/data/provider-homes/glab` through
`GH_CONFIG_DIR` and `GLAB_CONFIG_DIR`, which the server creates on start. A
container has no keyring, so both keep the token in plain text there (glab says so as it signs in,
and its `config.yml` is mode 0600). They are signed in and out from the app, with a token or a device
code ([setup.md](setup.md), [code-hosts.md](code-hosts.md#signing-in-from-claudio)). The YouTrack
token is Claudio's own, kept in the secret vault below.

**The secret vault and its key.** What a CLI reads from its environment (Claude Code's token or key,
YouTrack's address and token) is kept in
`/data/secrets.json`, mode 0600, sealed with AES-256-GCM ([setup.md](setup.md#the-secret-vault)).
The image sets `CLAUDIO_DISTRIBUTION=docker`, so when the environment brings no
`CLAUDIO_SECRET_KEY` the server makes one on the first write and keeps it beside the data, in
`/data/secret.key` (32 random bytes as hex, mode 0600). That key protects a copy of the files (a
backup, a file sent by mistake), not the volume: whoever reads `/data` reads both. Settings →
Security says which case a container is in. The recommended setup passes the key in the environment
instead, kept somewhere other than the data volume:

```bash
openssl rand -hex 32   # once; keep it in your secret store
docker run … -e CLAUDIO_SECRET_KEY=<that hex> … ghcr.io/yeyo11/claudio
```

With Compose, put it in `.env` and add it to the service's `environment`; with the chart, keep it in
a Secret and name it in `secretKey.existingSecret` ([Kubernetes](#kubernetes-helm)). The
server drops it from its environment once read, so no child process inherits it. The environment's
key wins over `secret.key`, and a value sealed with another key reads as absent: moving a container
from the file key to one in the environment means entering its keys again in the app (then
`secret.key` can be removed). Losing the key loses what it sealed, never more: the sign-ins gh, glab
and Tailscale keep themselves are not in the vault. The whole model is in
[security-model.md](security-model.md).

The installer the build downloads, Claude Code's, is fetched to a file, checked against a SHA-256
and only then run, so a compromised install script fails the build instead of running as root. The
digest is a build arg (`CLAUDE_CODE_INSTALLER_SHA256`), overridable with `--build-arg`;
`docker/Dockerfile` carries the command that recomputes it. The URL always serves the newest script,
so rotating that digest is a commit of its own that records what moved.

The image carries no claude-swap or uv: Claudio never calls claude-swap. The accounts
([accounts.md](accounts.md)) live in an `accounts/` directory inside the data volume, with
`accounts.json` beside it, and there is nothing else to mount. The directory holds each account's
config dir, with its `0600` secret for a token or API-key account, so back it up and protect it
like the rest of the volume. A `login` account is signed in from the Accounts page, which runs
`claude auth login` in the container.

## The daily spend cap

Set `CLAUDIO_DAILY_SPEND_CAP_USD` in `.env` (or `dailySpendCapUsd` in Settings → Security) to stop an
unattended deployment from spending without limit: over the cap new flow runs, orchestration tasks,
schedule fires and decisions wait until the server's local midnight, and a person's new turn asks
first. Nothing running is stopped. The figure is the sum of the `total_cost_usd` of each `result`
the CLI reports, so on a subscription account it is the API price of the same use. Unset means no
cap. The setting follows the layers of [layered-settings.md](layered-settings.md): a value from the
environment wins over the file and cannot be changed from Settings.

## Notifications on a phone

Claudio installs to a home screen and can push a notification to it while the app is closed. Both
rest on a service worker, and a browser gives a page a service worker **only on a secure origin**:
`https://…`, or `localhost`. There is nothing to configure beyond that — no push account, no
Firebase project, no key of anyone else's.

- **Serve it over TLS.** `docker compose --profile tls up -d` is the short answer: Caddy in front of
  Claudio, with `CLAUDIO_DOMAIN` set to a public name so it fetches and renews a certificate. Behind
  a proxy of your own, the requirements are the ones above — plus letting the `Authorization` header
  through, since the push routes are guarded like every other one.
- **A LAN install over plain HTTP gets the app, not the push.** On `http://192.168.1.10:8797` a phone
  can still add Claudio to its home screen, but the browser registers no worker there: no cached
  shell, and no notification while the app is closed. Settings → Notifications says exactly that,
  naming the origin, rather than showing a switch that does nothing. A browser on the same machine as
  the server is the exception: `http://localhost:8797` is a secure origin, so push works untouched.
- **The keypair is made on first use** and kept as `push.json` in the data directory (mode 600, in
  the mode 700 directory). The private half never leaves the server and no route returns it. It is
  made once and never rotated, because every subscription was taken out against that public key:
  keep the data volume and push survives a restart, a rebuild and a new image. Lose it and every
  registered install goes quiet until it subscribes again.
- **Set `CLAUDIO_PUSH_SUBJECT`** to a `mailto:` or `https:` a push service can complain to. It has
  to name a real domain: Firefox and FCM take anything, but Apple refuses the whole JWT with `403
  BadJwtToken` for a `sub` like `mailto:claudio@localhost`, and every iPhone goes quiet with no
  clue why. The claim is stored beside the keypair, and changing it takes effect on the next start
  — the keypair itself never changes, so no install has to subscribe again.
- **Outbound only.** The server POSTs each notification to whatever endpoint the browser handed it —
  `*.push.services.mozilla.com`, `web.push.apple.com`, `fcm.googleapis.com`. A wrapper behind NAT
  needs nothing opened; an egress-filtered one needs those hosts allowed, and without them a push is
  a log line and nothing else.
- **No domain or proxy at hand?** On a machine with Tailscale, the [tunnel](tunnel.md) gives an HTTPS
  origin with a real certificate on the tailnet, and its address stays the same while the machine keeps
  its name. In the image it is the container's own Tailscale, signed in from the app (above).
- **In Kubernetes**, `push.json` sits on the same PersistentVolumeClaim as the rest of the data
  directory, which the chart keeps through `helm uninstall`. Bring your own Ingress, and terminate
  TLS there.

The payload itself holds only what a lock screen shows anyway — the kind, a title and body, the chat
or orchestration id and the path to open — because it passes through a push service nobody here runs.
See "Securing it" in the [README](../README.md#securing-it).

## Pinned Claude Code

The image pins the Claude Code it installs (`CLAUDE_CODE_VERSION` in `docker/Dockerfile`), so an
image is the same tomorrow as today. The System information on the Account tab of Settings shows the
version in use, the version the image pins and the newest published one. The registry
(`registry.npmjs.org`, package metadata only) is read when you press **Check for updates** and once a
day while the wrapper runs, never when a page loads. Turn the daily check off with
`CLAUDIO_CLI_UPDATE_CHECK=off` (the button keeps working); point it at a mirror with
`CLAUDIO_CLI_REGISTRY_URL`.

To move to a newer version, rebuild with `CLAUDE_CODE_VERSION=<version>` (set it in `.env` for
Compose) or use a newer Claudio image. The CLI's own autoupdater is disabled in the image so a
restart cannot change the version.

## Updating Claudio

**How it learns of a release.** The server asks GitHub for the latest release of `yeyo11/claudio`
60 s after it starts, then once the last answer is a day old (it looks every hour), and whenever
someone presses **Check for updates** in Settings → Account. GitHub's `latest` never returns a draft
or a pre-release. What it said is kept as `release.json` in the data directory, and pages read that
file, never GitHub: `GET /api/system/release` makes no network call. A failed check keeps the
previous answer and shows the error on the card. One request a day stays far below GitHub's 60 an
hour for unauthenticated callers.

When a check finds a version newer than the last one it announced, it sends `system.release` on
`/api/events`, so every open page — a browser, a phone, the desktop window — shows it without
polling, and a dot marks Settings (More, on a phone). It is not a notification and never goes in the
bell or out as a push, and a restart does not announce the same release again.

- `CLAUDIO_UPDATE_CHECK=off` stops the daily check; the button still works.
- `CLAUDIO_RELEASES_URL` points the check at a mirror or a fixture that answers in GitHub's shape
  (`tag_name`, `html_url`, `published_at`). An egress-filtered install needs `api.github.com`, or
  this.
- The image sets `CLAUDIO_DISTRIBUTION=docker`, which is how the Updates card knows to show Docker
  steps rather than a source checkout's or the desktop app's.

**What to run.** The container cannot replace its own image, and it cannot tell how it was started,
so the card lists the command for each way below, each under the setup it is for:

- **A compose file whose service uses the published image** (`image: ghcr.io/yeyo11/claudio`), from
  the folder that holds it: `docker compose pull && docker compose up -d`.
- **The repository's own `docker-compose.yml`** builds the image locally (`image: claudio:dev`), so
  there is nothing to pull: `git pull && docker compose up -d --build`.
- **`docker run`**: `docker pull ghcr.io/yeyo11/claudio`, then remove the container and run the
  command again, which has to name all three volumes (see
  [Updating a container without losing anything](#updating-a-container-without-losing-anything)).
- **Helm**: raise `image.tag` and `helm upgrade`.

A page that stayed open across the update notices on its next reconnection to `/api/events`: the
server's `stream.hello` carries its version, and a page built from another one says **Claudio was
updated to X** with a **Reload** button. It never reloads on its own, so a half-written message is
safe. With a service worker in control, Reload first asks it to update and waits up to 5 s for the
new one to take over, so the new build is served rather than the cached one. A lazy route whose file
the new build no longer has shows the same banner instead of breaking. None of this needs a service
worker, so it works on a plain `http://<lan-ip>:8797` too.

## Updating a container without losing anything

An update replaces the container: the image is pulled, the old container removed and a new one
started from it. Whatever is not on a volume with a name goes with the old one. The image declares
a volume for each of the three folders that matter, and Docker makes an anonymous one for each the
command does not name, so a command that names fewer **still starts, and loses the rest at the
next update**:

| Folder | Holds | Lost when it is not named |
| --- | --- | --- |
| `/home/node/.claude` | transcripts of every chat, MCP servers, agents, skills, `CLAUDE.md`, settings | the history and the account setup |
| `/data` | the wrapper's database and settings, uploads, the secret vault (`secrets.json`, and `secret.key` unless the key comes from the environment), the other agents', gh's and glab's sign-ins (`provider-homes/`) and the image's Tailscale node (`tailscale/`) | chats' records, schedules, the auth mode, every provider, GitHub and GitLab sign-in, the kept keys and the tailnet node |
| `/workspace` | the projects the agents work on | the projects, if they live there |

Start it with all three named, and a name for the container to replace:

```bash
docker run -d --init --name claudio --restart unless-stopped -p 127.0.0.1:8797:8797 \
  -v claudio-config:/home/node/.claude -v claudio-data:/data -v claudio-workspace:/workspace \
  ghcr.io/yeyo11/claudio
```

To update it: `docker pull ghcr.io/yeyo11/claudio && docker stop claudio && docker rm claudio`, then
the same `docker run`. A named volume is reattached by name, so the new container finds everything.
Do not add `-v` to `docker rm`: it removes the anonymous volumes too.

**Checking.** `GET /api/system/storage` (and the warning at the top of Settings → Account, which
reads it) says what each folder sits on: `persistent` for a named volume, a bind mount or a claim,
`anonymous`, `container` (the container's own layer) or `temporary` (memory or an `emptyDir`).
`atRisk` is true when any of them would not survive. It reads the mounts the server itself sees, so
it works under any way of starting the container, and says nothing outside the Docker image. It
cannot tell a named volume that is *new* from the one you meant: started from another folder,
Compose finds three empty ones and reports them persistent.

### Moving to named volumes

If Settings says a folder is on an anonymous volume, the data is still there while the container
exists, stopped or not. **Do not remove it yet.** Copy each folder into a named volume, then start
the new container on those:

```bash
docker stop claudio
for pair in "home/node/.claude:claudio-config" "data:claudio-data" "workspace:claudio-workspace"; do
  docker run --rm --volumes-from claudio -v "${pair#*:}":/to alpine \
    sh -c "cp -a /${pair%%:*}/. /to/"
done
docker rename claudio claudio-old
# the docker run above, with the three named volumes
```

Check that the new one has your chats, then `docker rm -v claudio-old`.

**Already replaced it?** `docker rm` without `-v` leaves the anonymous volumes behind, so what the old
container held may still be on disk. `docker volume ls --filter dangling=true` lists them, 64-digit
names and all; look inside one with `docker run --rm -v <name>:/v alpine ls /v` (`.claude` holds
`projects/` and `sessions/`, `/data` holds `wrapper.db`) and copy it into a named volume with
`docker run --rm -v <name>:/from -v claudio-config:/to alpine cp -a /from/. /to/`. Do not run
`docker volume prune` before you have looked: it deletes exactly these. A container started with
`-v claudio-data:/data` alone already has `/data` on a named volume: copy only the other two.

**Compose.** The volumes are `<project>_claude-config` and `<project>_wrapper-data`, where the
project is the folder's name, and `./workspace` is a folder next to the compose file. Set
`COMPOSE_PROJECT_NAME` in `.env` before the first start so a move or a rename of the checkout does
not leave the data behind under the old name.

**Helm.** One claim holds all three through subPaths, and it is kept on `helm uninstall`: an upgrade
needs nothing but the new `image.tag`. The tag the chart defaults to is the release it ships with
and moves with every release.

## Health and restarts

`GET /api/health` is open even with authentication on — the host allowlist lets it through too — and
answers `200` while Claude is logged out: a restart would not fix a missing credential, so it is a
liveness probe, not a login check. It reports the CLI and login state as the last authenticated read
left it and spawns nothing of its own, so a probe costs nothing however often it runs, and in a
container nobody is using it keeps reporting what was seen at boot. `GET /api/system` is what takes
a fresh reading.

- **Docker Compose.** Docker only *marks* a container unhealthy; a restart policy reacts to an exit,
  never to `unhealthy`. The image's healthcheck (`docker/healthcheck.sh`) therefore ends the server
  itself after `CLAUDIO_HEALTH_RESTART_AFTER` consecutive failed probes (default 3, 30 s apart): it
  sends `SIGTERM` to the process named in `CLAUDIO_PID_FILE`, waits up to five seconds and then sends
  `SIGKILL`, because a wedged event loop never runs the `SIGTERM` handler. The container exits and
  `restart: unless-stopped` starts it again. It needs a restart policy: without one the container
  stays down.
- **Kubernetes.** The image's `HEALTHCHECK` is ignored; the chart declares startup, liveness and
  readiness probes on the same route, and a failing liveness probe restarts the container natively.

### Signals

| Signal | What the server does |
| --- | --- |
| `SIGTERM`, `SIGINT` | Clean shutdown: stops the update timers (Claude Code's and Claudio's), stops every chat process (the transcripts are on disk, so the chats can be resumed), closes the SQLite store, closes the HTTP server **including open event streams**, exits `0`. |
| `SIGKILL` | Nothing runs. Chats in flight are restored on the next start as cut off by the restart, and the store is left to SQLite's own crash recovery. |

`docker stop` exits `0`: the process being signalled is the server itself, not a package manager
reporting a killed child, so a script that checks the status of a stop no longer has to allow `143`.

Both orchestrators allow 30 s between `SIGTERM` and `SIGKILL` (`stop_grace_period` in Compose,
`terminationGracePeriodSeconds` in the chart). Run the image with `--init` (Compose does) so the
`claude` processes are reaped.

## Related

[[desktop.md]] · [[status.md]] · [[plans/mobile.md]] · [[plans/app-updates.md]] · [[tunnel.md]] · [[plans/tunnel.md]] · [[code-hosts.md]] · [[container-state.md]] · [[setup.md]] · [[security-model.md]]
