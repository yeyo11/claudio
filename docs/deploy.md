---
created_at: 2026-09-21T07:35:14Z
updated_at: 2026-10-29T12:00:00Z
tags:
    - deploy
    - docker
    - kubernetes
    - tls
    - operations
    - updates
    - headless
---
# Deploying Claudio

Three ways to run the image, from one machine to a cluster, what a phone needs from it, how it learns
of a new release, and what to know about restarts.

## Running the published image

Run the published image with no Claude variable at all:

```bash
docker run -d --init --name claudio --restart unless-stopped -p 127.0.0.1:8797:8797 \
  -v claudio-config:/home/node/.claude \
  -v claudio-data:/data \
  -v claudio-workspace:/workspace \
  ghcr.io/yeyo11/claudio
```

Then open Claudio, sign in with the owner token from the container's log
([the first-run token](#the-first-run-token)), and sign in to Claude in the setup assistant: **Claude
account** opens a link, you approve it and paste the code the page shows, the same
`claude auth login` you would run on a machine of your own. A pay-per-use API key is the other
choice there. A token made with `claude setup-token` still works as a headless option, for a
deployment that cannot open a browser: [configuration.md](configuration.md#claude-code-credentials).

The workspace is a named volume too. A folder of your own (`-v "$HOME/projects:/workspace"`) works
as well, as an absolute path: a relative one such as `$PWD/workspace` is a different folder from
wherever you run the command next.

The image carries Claude Code at the version Claudio's driver was written for, with `gh`, `glab` and
`youtrack-app` beside it ([What the image contains](#what-the-image-contains)). Their sign-ins live
under `/data`, so the same three volumes keep them: the setup assistant shows which ones are signed
in.

The UI and the API reference are on <http://localhost:8797> — the panel at `/`, the interactive
OpenAPI docs at `/docs`, the API under `/api` ([rest-api.md](rest-api.md)). Everything else is
configured from the UI, or from the environment ([configuration.md](configuration.md)).

The port is published on `127.0.0.1` only here. A container that is not told how to authenticate
makes an owner token on its first start, so publishing the port beyond this machine (`-p 8797:8797`)
is not open to the LAN: see [the first-run token](#the-first-run-token). Put TLS in front before
you do, though: the token travels in a header ([securing.md](securing.md) and
[SECURITY.md](../SECURITY.md)).

Name all three volumes: the image declares each as a volume, so a command that names fewer still
starts, with the others on volumes Docker made on its own, and replacing the container to update
starts again with empty ones. [Updating](#updating-a-container-without-losing-anything)
says how, and Settings → General → Updates warns when a container was started that way.

### Building it yourself instead

```bash
git clone https://github.com/yeyo11/claudio
cd claudio
cp .env.example .env        # nothing to fill in to start; sign in from the app
docker compose up --build
```

The image pins the Claude Code it installs (`CLAUDE_CODE_VERSION`, defaulting to the version in
`docker/Dockerfile`), so an image is the same tomorrow as today; set it in `.env` to move, or install a newer one from the app ([updates.md](updates.md)). Compose
publishes the port on `127.0.0.1` like the command above, and adds a `tls` profile:

```bash
docker compose --profile tls up -d    # plus Caddy on :80 and :443, in front of Claudio
```

More ways to run it, with the details — Compose profiles, the TLS proxy, a Helm chart, the pinned
CLI and its update check, health-driven restarts and the signals the server handles — are in the
sections below.

### Volumes

| Volume (`docker run` / compose) | Mount | Purpose |
| --- | --- | --- |
| `claudio-config` / `claude-config` | `/home/node/.claude` | The whole account setup: `settings.json`, `.claude.json` (MCP servers), `CLAUDE.md`, agents, skills, commands and session transcripts |
| `./workspace` / `claudio-workspace` | `/workspace` | Projects Claude works on (default `cwd` for runs) |
| `claudio-data` / `wrapper-data` | `/data` | Wrapper state. Rows in the SQLite store (`wrapper.db`): chats and their executions, orchestrations, plans, each account's usage limit, the waits at a limit, command durations, schedule runs, the supervisor's proposals, the installs registered for Web Push and the audit log. Settings-shaped files: `providers.json` (whether Claude Code is enabled, and its binary), `auth.json` (the auth mode and the hash of the token, mode 600), `secrets.json` (the sealed secret vault: every key and token given in the setup, mode 600) and `secret.key` (the vault's key when `CLAUDIO_SECRET_KEY` is not set, mode 600; see [security-model.md](security-model.md)), `tool-presets.json` (the presets and the default), `orchestration-templates.json`, `schedules.json`, `supervisor.json`, `cli-version.json`, `release.json` (what the last Claudio release check learned) and `push.json` (the VAPID keypair, mode 600). `uploads/` holds attachments, `mcp/` the per-chat MCP config files (mode 600: they can hold a server's secrets), `accounts/` the Claude accounts added in the app (one config dir each, [accounts.md](accounts.md)) and `provider-homes/` the GitHub and GitLab sign-ins of `gh` and `glab`, in the Docker image (`GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` point there) |

The compose file keeps its original volume names so an existing setup keeps its data; `docker compose`
prefixes them with the project name (`claudio_wrapper-data`…), which is the folder's name unless
`COMPOSE_PROJECT_NAME` is set. Run from another folder, it would start with three empty volumes: set
`COMPOSE_PROJECT_NAME` in `.env` once, before the first start.

### In short

What the sections below say, in brief:

- **Docker Compose**: `docker compose up -d` publishes Claudio on `127.0.0.1:8797`;
  `--profile tls` adds the Caddy proxy on `:80` and `:443` (`CLAUDIO_DOMAIN` picks the name).
- **The first start**: a container with no auth variable makes an owner token and prints it once; see
  [the first-run token](#the-first-run-token). The setup assistant signs in to Claude with the
  paste-code `claude auth login`, so no Claude variable is needed.
- **Kubernetes**: the Helm chart in `deploy/helm/claudio` is a Deployment (one replica, `Recreate`),
  a Service and one PersistentVolumeClaim that outlives `helm uninstall`. Its values cover the image
  tag (pinned to a release rather than `latest`), the port, resources, the pod and container
  security contexts, `auth.mode` (`auto`, the default, `none`, `token`, `oidc`) and `auth.readOnly`. There is no Ingress
  template; bring your own — and if it gives the pod a host name, put that name in
  `CLAUDIO_ALLOWED_HOSTS` through the chart's `env`.
- **The tunnel** (Settings → Access & safety → Remote access): the image runs a Tailscale of its own in userspace
  networking, with its node on the data volume, and you sign it in from the app with a login link or
  an auth key. Once open it goes around the published port, the proxy and the Ingress; turn it off
  with `CLAUDIO_TUNNEL=off` (or `tunnel.enabled: false`). See
  [The tunnel in Docker](#the-tunnel-in-docker).
- **A pinned Claude Code**: the image installs a fixed version and Settings → General → Updates says when a
  newer one is published, with how to move. The check reads the npm registry on demand and once a
  day.
- **Restarts**: Docker only marks a container `unhealthy`, so the image's healthcheck ends the server
  itself after three failed probes and Compose's `restart: unless-stopped` starts it again; the chart
  uses ordinary liveness and readiness probes. `SIGTERM` is a clean stop: the chats' transcripts are
  on disk and resume afterwards.

## The first-run token

A container started with none of `CLAUDIO_AUTH_MODE`, `CLAUDIO_AUTH_TOKEN` and `CLAUDIO_OIDC_ISSUER`
makes an owner token the first time it starts and turns on token authentication with it. It is the
same kind of token `POST /security/token` makes (32 random bytes, base64url) and only its hash goes
into `auth.json`, as `tokenId: 'first-run'`.

- **Where to read it.** The server prints it once to the container's standard output, in a framed
  block that calls it the owner token: `docker logs claudio` (`kubectl logs` in a cluster). It is
  also kept in `/data/first-run-token` (mode 0600) until the first request it authenticates, which
  deletes the file; rotating or removing the token deletes it too. The file exists because a log is
  easy to lose (`--rm`, a log driver), and anyone who can read `/data` already owns the install.
  Log shippers that keep the first lines of a container's output keep the token: that is the
  operator's to weigh.
- **The sign-in screen says so.** Until the token is first used, the `401` carries
  `firstRunToken: true` and the sign-in screen says where to find the token, with the command named.
- **A restart before first use** prints a pointer to the file, not a second token.
- **Recovery.** `CLAUDIO_AUTH_TOKEN_RESET` works as before ([securing.md](securing.md)).
- **Opting out.** `CLAUDIO_AUTH_MODE=none` is always respected; the server logs one line saying the
  terminal and in-app updates need a token. A person who chooses **None** in Settings → Access &
  safety is not overridden on a later start either (`noneChosenAt`).
- **Upgrading from 0.6.x.** A container whose `auth.json` says `none`, started without any of the
  three variables, gets a first-run token **once**, on the first start of the new image, recorded
  with `generatedAt` so it never happens again. A LAN device that opened Claudio with no credential
  will see the sign-in screen: read the token from the log. Under `none`, the terminal and in-app
  updates cannot work, and every device on the LAN could start chats in `bypassPermissions`; that is
  why the migration is not optional by default.
- **Helm.** `auth.mode: auto` is the default and writes no `CLAUDIO_AUTH_MODE`. `none`, `token` and
  `oidc` keep their meaning.

The decision: [decisions/container-owner-token.md](decisions/container-owner-token.md).

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
- **Adding a host later** does not need a restart. Settings → Access & safety → Allowed hosts keeps the
  variable's hosts fixed and lets you add more, which answer beside them from the next request
  ([layered-settings.md](layered-settings.md)).
- **Rewriting `Host` to the upstream** (nginx's `proxy_set_header Host $proxy_host`, some ingress
  controllers by default) makes Claudio see the service name or the pod address. Either pass the
  original name instead, or add whatever the proxy sends to `CLAUDIO_ALLOWED_HOSTS`. In the Helm
  chart that goes in `env`.

Get it wrong and **every call answers `421`**: the page's files still load, but the app has nothing
to show. `GET /api/health` is exempt, so the container healthcheck and the chart's probes keep
passing while everything else is refused: a healthy container serving 421 is this, nearly every time.

**What a person sees.** The `421` body says `code: 'host-not-allowed'`, the `host` (port stripped),
the auth `mode`, and whether the host can be claimed (`canClaim`) and whether the first-run token is
pending. A `GET` that prefers `text/html` (typing `/api/...` or `/docs` in a browser) gets a small
plain page with the same message, in English, with a link to `/`. The app, on that `421`, replaces
itself with a **Host refused** screen:

- With a token or OIDC and read-only off, it has a field for the owner token and a button, **Add
  {{host}} and sign in**. That calls `POST /api/security/allowed-hosts/claim`, the one route the host
  check lets through. It adds the name the request used to the same allowlist layer Settings edits
  (no restart), and needs an owner credential: it is refused under `none` (`host.needs-auth`), to the
  desktop and to a chat's token (`host.not-owner`), in read-only (`405`) and for a name the allowlist
  refuses (`host.invalid`). A wrong token counts in the same back-off as any sign-in. A page that
  rebinds a name to your server cannot hold the owner's bearer token, so a request that carries it
  comes from the person.
- Under `none` or read-only, there is no field. The screen says to name the host in
  `CLAUDIO_ALLOWED_HOSTS` when the container starts, or to open Claudio on localhost and add it in
  Settings → Access & safety → Allowed hosts.

One thing the allowlist does not do: it only stops a browser, which cannot choose the header it
sends. Anything scripted sets its own `Host` and walks past it. It closes DNS rebinding; it is not
access control, and it is no substitute for turning the guard on.

## Headless, next to a project

When Claudio is a project's AI backend rather than a person's app, run the **headless image**: the
same server under `CLAUDIO_PROFILE=headless`, which serves only the API such a program calls (chats,
`/v1`, the model list, [workspaces](workspaces.md), the sign-in and the probes) and answers
`404 route not found` to everything else. There is no web UI, no websocket, no terminal, no tunnel
and no in-app update: the image is the version, and a new one is a new tag. Every chat is a
[confined API chat](security-model.md#the-confined-api-chat). The plan is
[plans/headless-image.md](plans/headless-image.md).

Run **one per project**, each with its own data and sign-in volumes, sharing no filesystem with the
project: code reaches Claudio as a workspace (`POST /api/workspaces`, a `tar.gz` from a URL or the
request body), never through a volume both mount.

```yaml
services:
  claudio:
    image: ghcr.io/yeyo11/claudio:<version>-headless
    init: true
    restart: unless-stopped
    environment:
      CLAUDIO_AUTH_MODE: token
      CLAUDIO_AUTH_TOKEN: ${CLAUDIO_TOKEN:?}
      CLAUDIO_DAILY_SPEND_CAP_USD: "5"
    volumes:
      - claude-config:/home/node/.claude
      - claudio-data:/data
    stop_grace_period: 30s
  app:
    environment:
      CLAUDIO_URL: http://claudio:8797
      CLAUDIO_TOKEN: ${CLAUDIO_TOKEN:?}

volumes:
  claude-config:
  claudio-data:
```

Then sign the Claude account in, once:

```bash
docker compose exec claudio claudio login
```

`claudio login` asks the server to start Claude Code's own paste-code sign-in, prints the page to
open, reads the code without echoing it, sends it and waits until the sign-in ends; Ctrl-C cancels
it on the server too. `claudio status` says whether the server can take work, and `--json` adds the
account and its last usage reading. Both talk to the server over HTTP only, so they work from another
machine as well:

```text
claudio login  [--url URL] [--token TOKEN] [--account default]
claudio status [--url URL] [--token TOKEN] [--json]
```

The URL defaults to `http://127.0.0.1:$PORT` (8797), the token to `--token`, then
`CLAUDIO_AUTH_TOKEN`, then the first-run token file in the data directory. Exit codes: 0 done (or
ready), 1 failed or expired (or not ready), 2 a usage or connection error, a refused token included.
If the server cannot start at all, `docker compose run --rm --entrypoint claude claudio auth login`
signs the CLI in directly; Claudio learns of it at its next check.

What the headless profile requires and changes:

- **It refuses to start** without `CLAUDIO_DAILY_SPEND_CAP_USD`, with `CLAUDIO_AUTH_MODE=none` unless
  it listens on loopback only, or with a permission mode other than `dontAsk` (the image sets it).
  Every problem is named at once. Unset auth variables still give the [first-run
  token](#the-first-run-token). A chat that names no budget gets `CLAUDIO_CHAT_BUDGET_USD` (1 USD).
  [configuration.md](configuration.md#headless) has every variable.
- **The compose service name reaches it.** A single-label `Host` such as `claudio`, which only
  Docker's embedded DNS answers for, is accepted besides loopback and `CLAUDIO_ALLOWED_HOSTS`. A
  program on the host network reaches it on `127.0.0.1:8797` instead.
- **Readiness.** `GET /api/ready`, with no credential, answers `200 { ready: true }`, or `503` with
  `reason` `cli-missing`, `signed-out`, `sign-in-expired` or `starting`; it spawns nothing. The
  image's healthcheck stays on `/api/health`, since a signed-out Claudio is alive and must not be
  restarted.
- **Retention.** A chat idle 30 days (`CLAUDIO_CHAT_RETENTION_DAYS`) is deleted, with the CLI's
  session file, since both hold what it read of a repository.
- **Workspaces live in `/workspaces`** inside the container, not on a volume: each is a copy, gone two
  hours after its last use.

The image is built from the `headless` stage of `docker/Dockerfile` and published by `image.yml`
beside the full one, tagged `<version>-headless` and `headless` (where the full image gets
`latest`). It carries Node, Claude Code (pinned and checksummed as in the full image), `git`,
`ripgrep`, `procps`, `curl` (for the healthcheck), and `/app/api.mjs`, `mcp.mjs` (the `/v1`
client-tool stub), `guard.mjs`, `launcher.mjs` and `cli.mjs` (linked as `/usr/local/bin/claudio`).
It leaves out the web build, gh, glab, Tailscale, `youtrack-app`, pnpm, python3, node-pty and the
terminal host, iroh and the collaborators host, and `docker/keys`. It measured 648 MB on
2026-10-29, against 1.43 GB for the full 0.10.0 image: Claude Code's binary alone is 273 MB and the Node base
about 245 MB.

## Kubernetes (Helm)

```bash
kubectl create secret generic claudio-secret-key --from-literal=secret-key="$(openssl rand -hex 32)"

helm install claudio ./deploy/helm/claudio \
  --set secretKey.existingSecret=claudio-secret-key
kubectl logs deploy/claudio     # the owner token, printed once on the first start
```

`auth.mode` defaults to `auto`: the chart writes no `CLAUDIO_AUTH_MODE`, so the image makes an owner
token on its first start ([the first-run token](#the-first-run-token)) and `NOTES.txt` shows the
`kubectl logs` command. To choose the token yourself, make a Secret and pass
`--set auth.mode=token --set auth.token.existingSecret=claudio-token`. Sign in to Claude from the
setup assistant; a headless cluster that cannot open a browser sets `claude.existingSecret` to a
Secret holding `CLAUDE_CODE_OAUTH_TOKEN` ([configuration.md](configuration.md#claude-code-credentials)).

The chart is a Deployment (one replica, `Recreate`), a Service, and one PersistentVolumeClaim that
holds everything worth keeping through subPaths: `/data`, `~/.claude`
and `/workspace`. The claim carries `helm.sh/resource-policy: keep`, so `helm uninstall` leaves the
account setup and the transcripts alone. Values worth knowing: `image.tag` (a release, not `latest`, so
`IfNotPresent` means something), `port`, `resources`, `securityContext` and
`containerSecurityContext`, `env` (where `CLAUDIO_ALLOWED_HOSTS` goes when an Ingress gives the pod
a host name), `persistence.*`, `auth.mode` (`auto`, `none`, `token`, `oidc`), `auth.readOnly`, and
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
`tailscaled` and Settings → Access & safety → Remote access may serve it on a tailnet; see the next section. The deployment always writes `CLAUDIO_TUNNEL` as `on` or `off`,
and `NOTES.txt` warns when it is on.

## The terminal

Settings → Access & safety → Terminal opens the person's own shell in the browser. It is off until someone turns it on,
and in a container it has one condition and one default:

- **Authentication.** With `CLAUDIO_AUTH_MODE=none` the terminal reports `needs-auth` and the card
  says to protect access with a token. The first-run token ([above](#the-first-run-token)) means a
  new container is not in that state; with a token or `oidc` it works, as user `node`, in
  `/workspace/...`.
- **Where from.** In a container every request reaches the server from the Docker bridge, never from
  loopback, so no request is ever "this machine". Claudio therefore defaults **Where it opens** to
  *any device that has the token* when `CLAUDIO_DISTRIBUTION=docker`; outside a container the
  default stays the tunnel, and a value saved in `terminal.json` wins everywhere. The owner token
  already starts chats in `bypassPermissions`, which run any command as `node`, so the terminal gives
  its holder nothing new. A chat's token and the desktop credential are still refused, the Origin check
  and the one-time socket tickets are unchanged, read-only closes it, and the card keeps its warning.
  A reverse proxy such as Caddy no longer matters here: under *any device* the owner token is what
  counts, not the address.
- **A refusal is shown in words.** Each reason the terminal can be unavailable is a sentence with its
  fix, under the switch; none is a raw server message. Outside a container, raising *Where it opens*
  from another device stays refused on purpose: a remote caller must not widen its own access, so the
  sentence says to change it on this machine or through the tunnel.

The shell is the login shell of `node` plus the credentials the app keeps for `gh`, `glab` and the
tracker CLIs; never a `CLAUDIO_*` variable and never Claude's credentials. Shells outlive a closed
tab but end when the server stops.

`CLAUDIO_TERMINAL=off` vetoes the feature for the whole deployment: the environment wins and the UI
shows the setting read-only. `CLAUDIO_TERMINAL=on` switches it on. Unset leaves it to the UI. The
chart's `terminal.enabled` writes it, `false` by default. The image carries `/app/terminal-host.mjs`,
the process the server forks for the shells, and `/app/node_modules/node-pty` beside it, a prebuilt
binary: nothing is compiled in either build stage.

## The tunnel in Docker

Settings → Access & safety → Remote access serves Claudio on the person's tailnet through the Tailscale CLI
(`tailscale serve`, never Funnel; [tunnel.md](tunnel.md)). A container sees neither the host's
`tailscale` CLI nor its daemon, so **the image runs a Tailscale of its own** (owner decision,
2026-10-08), and the person signs it in from the app: the setup assistant's Access step or Settings
→ Remote access, with a login link or an auth key ([setup.md](setup.md#tailscale)). Nobody needs a
shell on the machine.

- **What is in the image.** Tailscale's static linux amd64 build (`tailscale` and `tailscaled`,
  `TAILSCALE_VERSION`, 1.104.1), from pkgs.tailscale.com, checked against the digest published beside
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

**The guard.** `/app/guard.mjs` is the program the CLI runs on each tool call
([guards.md](guards.md)). It is copied `root:root` at mode 0444, so the `node` user the agents run as
cannot change it, and `CLAUDIO_GUARD_ENTRY` points at it. The Helm chart needs no change: the
`guards/` and `tmp/` folders live on the data volume. The pinned CLI must support `--settings` and
`--include-hook-events`.

**One agent.** Claude Code is the only agent in the image; the other tools it carries are below.

**The code hosts' and YouTrack's CLIs.** `gh` and `glab`, the only way Claudio reaches GitHub and
GitLab ([[code-hosts.md]]), are in `/usr/local/bin`, taken from the vendors' linux amd64 release
tarballs: `GH_VERSION` (2.102.0) and `GLAB_VERSION` (1.123.0), the versions the host recordings were
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

Set `CLAUDIO_DAILY_SPEND_CAP_USD` in `.env` (or `dailySpendCapUsd` in Settings → Runs & spend) to stop an
unattended deployment from spending without limit: over the cap new flow runs, orchestration tasks,
schedule fires and decisions wait until the server's local midnight, and a person's new turn asks
first. Nothing running is stopped. A headless server does not start without it ([Headless](#headless-next-to-a-project)). The figure is the sum of the `total_cost_usd` of each `result`
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
  shell, and no notification while the app is closed. Settings → General → Notifications says exactly that,
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
See [securing.md](securing.md).

## Pinned Claude Code

The image pins the Claude Code it installs (`CLAUDE_CODE_VERSION` in `docker/Dockerfile`), so an
image is the same tomorrow as today. The System information on the Account tab of Settings shows the
version in use, the version the image pins and the newest published one. The registry
(`registry.npmjs.org`, package metadata only) is read when you press **Check for updates** and once a
day while the wrapper runs, never when a page loads. Turn the daily check off with
`CLAUDIO_CLI_UPDATE_CHECK=off` (the button keeps working); point it at a mirror with
`CLAUDIO_CLI_REGISTRY_URL`.

To move to a newer version, **install it from the app** (Settings → General → Updates, **Install**,
owner only: [updates.md](updates.md#claude-code)), rebuild with `CLAUDE_CODE_VERSION=<version>` (set
it in `.env` for Compose) or use a newer Claudio image. The CLI's own autoupdater is disabled in the
image so a restart cannot change the version; an install from the app goes under `/data/cli`, and a
newer image's pin wins over it.

## Updating Claudio

**How it learns of a release.** The server asks GitHub for the latest release of `yeyo11/claudio`
60 s after it starts, then once the last answer is a day old (it looks every hour), and whenever
someone presses **Check for updates** in Settings → General → Updates. GitHub's `latest` never returns a draft
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

**Updating from the app.** In a container the Updates card downloads a signed server bundle and
restarts onto it, with no `docker pull`. The full description, with the states, the owner-only rule
and the rollback, is in [updates.md](updates.md); in short:

- **What it needs.** A token or OIDC (`update.needs-auth` under `none`, `405` in read-only), the
  image's launcher as the container's `CMD` (an image from this release on), and a public key in the
  image. Without one the card says why and shows the host commands below.
- **How.** The release carries `claudio-server-<version>-linux-x64.tar.gz`, its manifest and an
  Ed25519 signature. The server checks the signature before it downloads, unpacks into
  `/data/app/<version>/`, and the root-owned launcher checks it again at every boot. If the chats
  are working it asks first, like the desktop.
- **Limits.** A release that changed the OS layer, Node or the native modules says it needs a newer
  image (`minImage`); then the host commands are the way. Only the newest release is offered.
- **Rollback.** A new bundle must answer `/api/health` within 60 s, twice at most; otherwise the
  launcher goes back to the previous one, or to the image's own `/app`, and the card says so. With
  Helm the 60 s trial fits inside the liveness probe's 30 s × 3 tolerance: keep it so.
- **The image still wins.** A `docker pull` or `helm upgrade` to a newer image beats an older
  overlay.
- **Opting out.** `CLAUDIO_SERVER_UPDATE=off` hides it.

**What to run from the host.** Where the app cannot update itself, or a release needs a newer image: the
container cannot replace its own image and cannot tell how it was started, so the card lists the command for each way below, each under the setup it is for:

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

**Checking.** `GET /api/system/storage` (and the warning at the top of Settings → General → Updates, which
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

[[workspaces.md]] · [[plans/headless-image.md]] · [[guards.md]] · [[desktop.md]] · [[status.md]] · [[plans/mobile.md]] · [[plans/app-updates.md]] · [[tunnel.md]] · [[plans/tunnel.md]] · [[code-hosts.md]] · [[container-state.md]] · [[setup.md]] · [[updates.md]] · [[decisions/container-owner-token.md]] · [[decisions/container-in-app-updates.md]] · [[security-model.md]] · [[securing.md]] · [[configuration.md]] · [[rest-api.md]]
