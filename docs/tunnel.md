---
created_at: 2026-09-27T18:00:00Z
updated_at: 2026-10-30T20:00:00Z
tags:
    - tunnel
    - remote-access
    - security
    - mobile
    - tailscale
    - docker
    - setup
---
# Remote access through Tailscale

Settings → Access & safety → **Remote access** serves this Claudio on the person's own
[Tailscale](https://tailscale.com) tailnet, so a phone or a laptop signed in to the same tailnet can
reach it. The address is the machine's MagicDNS name on a port of Claudio's own,
`https://<machine>.<tailnet>.ts.net:8444`, shown with a QR code, and it stays the same from one
start to the next. Nothing is published on the internet: Claudio uses `tailscale serve`, never
Funnel.

Until 2026-10-06 the tunnel went through localhost.run over `ssh`; why it moved, and what was
measured, is in [the plan](plans/tunnel.md#the-move-to-tailscale-2026-10-06).

## A phone and the local network

Claudio can also listen on the local network ([lan-access.md](lan-access.md)), but for a phone this
is the way to use: Tailscale gives the phone HTTPS, so it can install the app and receive push
notifications, and its token is encrypted. The local network is plain HTTP on a port of its own: no
installable app, no push, and a token in clear. Use it for a laptop at home; use the tailnet for the
phone, and for any network you do not trust. Both can run at once.

## The rule it follows

Tailscale is reached **only through its CLI**: its flags and its `--json` output. No LocalAPI socket,
no tsnet. A machine's own Tailscale (a source checkout, the desktop app) is used with the session the
person gave it, and Claudio never runs `tailscale up`, `login`, `logout` or `set` on it. Only the
`tailscaled` the Docker image starts for Claudio (**managed**, below) is signed in and out from the
app, with the same CLI's documented `up` and `logout`. It is the same rule Claudio follows for the agents
([providers.md](providers.md)) and the code hosts ([code-hosts.md](code-hosts.md)). The calls:

| Call | Why |
| --- | --- |
| `tailscale version` | Installed, and at least 1.52, where `serve` took its current arguments |
| `tailscale status --json` | `BackendState`, `Self.DNSName`, `CurrentTailnet.MagicDNSEnabled`, `CertDomains` |
| `tailscale serve status --json` | The node's Serve config, read before adding, after adding, and before removing |
| `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<claudio port>` | Adds Claudio's rule |
| `tailscale serve --yes --https=<port> off` | Removes it |
| `tailscale up --reset --hostname=<name>` | Managed only: the sign-in with a login URL ([setup.md](setup.md#tailscale)) |
| `tailscale up --reset --hostname=<name> --auth-key=file:<path>` | Managed only: the sign-in with an auth key, read from a 0600 file removed right after |
| `tailscale logout` | Managed only: the sign-out, after the tunnel closed |

The tunnel does not touch Claude Code. It forwards HTTP to Claudio's own port.

## What has to be ready

The whole section depends on Tailscale. Until it is ready, the tab offers neither the button nor
"start with Claudio"; it says what is missing, and `GET /api/tunnel` carries it as
`tailscale.state` with a `reason` to translate:

| `tailscale.state` | Reason code | What the tab offers |
| --- | --- | --- |
| `missing` | `tunnel.tailscaleMissing` | `Empty` with the `cli-missing` illustration and **Install Tailscale** (`https://tailscale.com/download`) |
| `unsupported` | `tunnel.tailscaleUnsupported` | Older than 1.52: **Update Tailscale** |
| `daemonDown` | `tunnel.tailscaleDaemonDown` | The CLI cannot reach `tailscaled`: start the service |
| `loggedOut` | `tunnel.tailscaleLoggedOut` | `NeedsLogin` or `NeedsMachineAuth`: run `tailscale up` |
| `stopped` | `tunnel.tailscaleNotConnected` | Any other state than `Running` (`Stopped`…): run `tailscale up` |
| `httpsDisabled` | `tunnel.magicDnsOff`, `tunnel.httpsOff` | MagicDNS or HTTPS certificates are off: **Open DNS settings** (`https://login.tailscale.com/admin/dns`) |
| `ready` | – | The tunnel card, with the node's name |

Where the daemon is managed, `loggedOut` and `stopped` offer **Sign in to Tailscale** instead of a
command (the shared sign-in panel, inside the card: a login link or an auth key), the reasons are
`tunnel.managedLoggedOut`, `tunnel.managedNotConnected` and `tunnel.managedDaemonDown` (restart the
container), and a signed-in node shows **Sign out** beside its name. `GET /api/tunnel` says
`managed: true`.

Every state but `missing` has **Check again**, which reads the status again: `GET /api/tunnel` asks
the CLI anew when its last answer is more than two seconds old, so a `tailscale up` in a terminal
shows without a restart.

Two more things are only learned when the rule is added, and fail the start with their reason:

- **`tunnel.servePermission`**: tailscaled refuses Serve changes from a user who is not the node's
  operator ("Access denied: serve config denied", measured). The fix is
  `sudo tailscale set --operator=$USER`, once; the tab says so and never runs it.
- **`tunnel.portTaken`**: the port already serves something Claudio did not add (below).

## Using it

1. **Turn on authentication first** (Settings → Access & safety: a token or OIDC). While the mode is
   `none`, the tab shows a warning with a link to Security instead of the button. Every device on the
   tailnet that can reach the machine could otherwise drive it.
2. Press **Open tunnel**. The state reads *opening* while the rule is added, then *checking* while
   Claudio reads the Serve config back. Only then does it read *open*.
3. Once *open*, the tab shows the address in mono with a copy button and a QR code.
4. On the phone, with the Tailscale app signed in to the same tailnet, open the address and sign in
   to Claudio with the token once.
5. **Close tunnel** takes the name off the allowlist, then removes the rule. When the page you are on
   came through the tunnel itself, it asks first, and answers before the rule goes.

**Open the tunnel when Claudio starts** is a switch on the same tab, off by default, kept in
`tunnel-settings.json` in the data directory. **Port on the tailnet name** sits under it: `8444` by
default, any port from 1024 to 65535, saved in the same file. It changes only while the tunnel is
closed or failed (closing takes the rule on the old port away first), and where
`CLAUDIO_TUNNEL_PORT` is set (Helm's `tunnel.port`) it is shown read-only, naming the variable.

A start that finds its port taken says what holds it, from `tailscale serve status`
(`https://<node>:8444/ → http://127.0.0.1:41985` for another Claudio on the same machine, a TCP
forwarder, or a `tailscale serve` running in a terminal), and offers **Use the next free port
(8445)**: the first port above it that the node's Serve config leaves free. It saves that port and
opens the tunnel there. A desktop app and a dev server on one machine each get a port this way,
without an environment variable the desktop app cannot set.

Two starts at once (a click racing "start with Claudio") are one start: the tunnel is wanted from
the first instruction of `start()`, before anything is awaited, so the second waits for the first's
answer instead of opening a second rule, finding the first's, calling the port taken and removing
it. A stop sent while a start is still reading Tailscale aborts that start.

| State | Word on the tab | Colour | What is happening |
| --- | --- | --- | --- |
| `stopped` | closed | idle | No rule of Claudio's |
| `starting` | opening | warn | Reading the Serve config and adding the rule |
| `verifying` | checking | warn | Reading the Serve config back |
| `active` | open | ok | The rule holds, and the node's exact name is on the allowlist |
| `stopping` | closing | warn | The name left the allowlist; the rule is being removed |
| `failed` | failed | bad | Gave up, with a reason |

`active` with `checking: true` keeps its colour and adds the word "Checking…" (below).

While active, Claudio reads Tailscale and the Serve config again every 30 s. A node renamed in the
admin console moves the allowed name and the address with it. The reason a reading fails the
tunnel with says what Tailscale answered:

| Reason | When |
| --- | --- |
| `tunnel.ruleRemoved` | Tailscale is running and answers, and the port no longer holds Claudio's rule: removed (`tailscale serve reset`, another program's `serve off`) or changed to point elsewhere. At once, on the first reading |
| `tunnel.tailscaleNotConnected`, `tunnel.tailscaleLoggedOut` | `BackendState` is not `Running`, or the node signed out; two readings in a row |
| `tunnel.tailscaleDaemonDown` | The CLI answered but could not reach tailscaled: no status JSON, or `serve status` said so; two readings in a row |
| `tunnel.serveStatusFailed`, `tunnel.servePermission` | `serve status` failed otherwise, with its first line (and the first address it gave), or was refused for this user; two readings in a row |
| `tunnel.tailscaleNotAnswering` | Not a failure: ten minutes of readings that got no answer at all (below) |

The rule is checked against what this process added, which it keeps in memory, not against the
record on disk. On 2026-10-18 a second server deleted the desktop's record and took its rule away;
the desktop read the missing record as "Tailscale is down" and said `tunnel.tailscaleDaemonDown`
while tailscaled was running. Now that reads `tunnel.ruleRemoved`, and a record deleted while the
rule still stands is written again.

### A slow machine is not a dead Tailscale

A reading the CLI did not answer (the call timed out after 10 s, or could not be spawned) is
**unknown**, not down. On 2026-10-18 a machine at 97 % CPU made two readings in a row time out, the
tunnel closed itself and took its Serve rule away while Tailscale was fine. Now:

- **Only an answer closes the tunnel**: `BackendState` not `Running`, signed out, a daemon that
  answers it is down, or the Serve rule gone or changed by someone else. An unknown never counts as a
  miss and never runs `serve off` or withdraws the host.
- **The tunnel stays `active`** and `GET /api/tunnel` says `checking: true`; the tab shows
  "Checking…" with no change of status colour. The readings back off (30 s, 60 s, 120 s, capped at
  5 min) and the first answer clears the flag.
- **After 10 minutes of nothing but unknowns** the status carries the reason
  `tunnel.tailscaleNotAnswering` while the state stays `active`: the tab shows a warning, "Tailscale
  is not answering". The rule and the host are still kept.
- **It comes back on its own.** A tunnel the person had opened that failed because Tailscale was
  down, signed out or disconnected is started again when a later reading finds Tailscale ready, with
  the audit row "Start the tunnel again: Tailscale is ready". Closing it with the button, or
  shutting Claudio down, cancels that; a failure of any other kind (the rule removed, the port taken)
  waits for the button.

## Only what Claudio added

Serve config is global to the node, and the person may have rules of their own. So:

- **A port of its own.** The rule lives on the tab's port (`tunnel-settings.json`), or on
  `CLAUDIO_TUNNEL_PORT` where that is set, `8444` by default, and never on `443`, which
  `tailscale serve` uses when no port is named: the setting takes 1024 to 65535. A variable that is
  not a port from 1 to 65535 stops Claudio at startup.
- **One reading of the Serve config.** Opening, checking, removing and shutting down read
  `tailscale serve status --json` through one parser, which answers the config or why there is none:
  no answer in time, the CLI missing, tailscaled down, a refusal for this user, or another failure
  with the CLI's first line and the first address it printed. A refusal of `serve --bg` keeps that
  address too: "Serve is not enabled on your tailnet." is followed, lines below, by the admin page
  that turns it on.
- **A port that is not free is left alone.** Claudio's rule has one shape: an HTTPS listener on the
  port with one `/` handler proxying to this server. If the port holds anything (another target, a
  path beside `/`, a TCP forwarder, a foreground `tailscale serve`), the start fails with
  `tunnel.portTaken`, with what holds it and the next free port (`portTaken`). Even a rule of exactly
  Claudio's shape is not adopted unless Claudio recorded adding it.
- **Recorded before it is added.** `<dataDir>/tunnel/serve-rule.json` (mode 600) holds the port, the
  name and the target, written before `serve --bg` runs.
- **Only the rule this process added.** Stop, shutdown and a failure take away the rule this process
  added, never one a record on disk names: a server that never opened the tunnel (one that failed to
  bind its port and shut down at once) removes nothing.
- **Removed only while it is still exactly that.** On stop, on shutdown, and when the tunnel fails, Claudio reads the config and runs
  `serve --https=<port> off` only if the port still holds its rule. A port someone else took over
  drops the record and keeps their rule. `off` on a missing handler answers "handler does not exist"
  (measured), which counts as gone.
- **Shutdown is bounded.** The name leaves the allowlist at once, while the database that records it
  is still open; taking the rule away then has 4 s, and a `tailscale` call still running at the bound
  is killed. The desktop kills the server 5 s after asking it to stop, so the rest of the shutdown
  (the database closing) never waits behind a slow tailscaled; a rule left by the bound keeps its
  record, and the next start takes it away.
- **Reconciled after a crash.** A background Serve rule outlives the process that added it, so a
  record found when Claudio starts is reconciled the same way before anything else, including "start
  with Claudio". The record carries the id of the data directory's lock its writer held
  ([security-model.md](security-model.md#one-server-per-data-directory)): a server holds that lock
  before it gets here, so a record written under an earlier lock is a gone server's, and its rule is
  taken away. A record without a lock (written by a Claudio from before the lock) may be a running Claudio's, and is left
  alone while something answers at its target. A second Claudio on the same machine needs its own
  data directory, which it cannot share with a running one; on its own data directory it gets
  `tunnel.portTaken` rather than taking the first one's rule, and **Use the next free port** moves it.

## What has to hold before a byte crosses

- **No tunnel without authentication.** `POST /api/tunnel/start` answers `409` under `mode: none`.
  Switching the mode to `none` stops the tunnel first, before the change is saved.
- **Only the node's exact name is let in, and only while the rule holds.** It joins the runtime
  allowlist ([layered-settings.md](layered-settings.md)) once the rule reads back, and leaves on stop,
  on failure and on shutdown. A pattern such as `*.ts.net` is never added.
- **No verification through the tailnet name.** The localhost.run tunnel asked `GET /api/health`
  through its public address. Reading the Serve config back proves the rule is in place and points at
  this server, without depending on MagicDNS resolving on this machine (`--accept-dns=false` is
  common on servers) or on a node reaching its own Serve listener, which could not be measured here.
- **The security history records it.** The name joining and leaving the allowlist, and every start
  or stop Claudio does on its own, are audit rows.

## Who sees what

- **Tailscale encrypts end to end**, and TLS is terminated by tailscaled on this machine with a
  certificate for the node's name, so no relay reads the requests. The bearer token and the five
  `?token=` URLs stay between the phone and this machine.
- **The tailnet is the audience.** Every device the tailnet's access rules let reach this node can
  reach the address; the token is still required.
- **No trusted client address.** Serve sets `Tailscale-User-Login` and friends for tailnet users,
  documented as replacing a client's own copies. Whether it also sets `X-Forwarded-For`, and whether a
  client could forge it, could not be measured (the test machine's user is not the node's operator),
  so no header is trusted: every request through the tunnel shares one failed-login bucket, apart
  from loopback. A guess from another tailnet device can make your phone wait for up to a minute,
  never the desk.

## The address

The address is the node's MagicDNS name, which does not change while the machine keeps its name, so
an installed app, its push subscription and the token stored for that origin keep working from one
start to the next. The certificate is real (Let's Encrypt, through Tailscale), so the browser gives
the PWA a service worker and push.

It moves only when the machine is renamed or the port changes. Each push carries the
current address (`PushPayload.url`), and the worker of an install made on an older `*.ts.net` origin
follows it to the new one (`TUNNEL_SUFFIX` in `apps/web/public/sw.js`), as it did for localhost.run's
changing names; an install at the desk or on the LAN keeps its own origin. The phone signs in again
on a new origin.

## Webhooks

The tunnel is no longer a public origin: a code host on the internet cannot deliver to a tailnet
address. Registering a hook answers `no-public-url`, polling carries the pull requests, and `Core`
no longer re-points hooks on `tunnel.changed`, so a hook is never moved to a tailnet name
([code-hosts.md](code-hosts.md#events-and-paced-polling), [deploy.md](deploy.md#webhooks-and-the-public-address)).
Funnel would give one, and is left out on purpose (owner decision, 2026-10-06).

## Where it is available

| Install | Default | Turn it on or off |
| --- | --- | --- |
| Source checkout | on | `CLAUDIO_TUNNEL=off` |
| Desktop app | on (Tailscale installed separately; not a `.deb` dependency) | `CLAUDIO_TUNNEL=off` |
| Docker image | on, with a tailscaled of its own (managed) | `CLAUDIO_TUNNEL=off` in `.env` |
| Helm chart | on, as the image | `tunnel.enabled: false` |

In a container the host's `tailscale` CLI and `tailscaled` are not visible, so since 2026-10-08 the
image carries both and its entrypoint starts `tailscaled --tun=userspace-networking`, with its state
in `/data/tailscale/` and the CLI's default socket, and tells the server with
`CLAUDIO_TAILSCALE_MANAGED=1`. The person signs it in from the app; with `CLAUDIO_TUNNEL=off` no
daemon starts. Once it opens, the rule goes around the published port, the proxy and the Ingress.
[deploy.md](deploy.md#the-tunnel-in-docker) has the details, including how Serve works in userspace
networking. `CLAUDIO_TUNNEL` accepts `on`, `1`, `true`, `off`, `0` and `false`; empty or unset means the
default, and any other value stops Claudio at startup. `TAILSCALE_BIN` points at another CLI (the
macOS app keeps it inside the bundle).

## Where things live

| What | Path |
| --- | --- |
| The rule Claudio added, while it exists | `<dataDir>/tunnel/serve-rule.json` |
| "Open the tunnel when Claudio starts" and the port | `<dataDir>/tunnel-settings.json` (only the keys the person set) |
| The node's name on the allowlist | memory only, never a file |
| The code | `packages/core/src/tunnel.ts`, `apps/api/src/routes/tunnel.ts`, `apps/web/src/pages/config/RemoteAccessTab.tsx` |
| The fake CLI the tests and the e2e suite use | `packages/core/test/fixtures/fake-tailscale.mjs` (also `up` and `logout`) |
| The image's node state and daemon log | `/data/tailscale/` |
| The image's entrypoint | `docker/entrypoint.sh` |

## API

`GET /api/tunnel` returns the state, `url` and `since` (only while `active`), `reason` (only while
`failed`), `enabled`, `managed`, `tailscale` (`state`, `version`, `host`, `reason`), `port` with
`portSource` (`env`, `file` or `default`), `portTaken` (`port`, `holder`, `nextFree`, while failed
for it) and the settings. `GET /api/tunnel/settings` answers the settings with their sources and
defaults; `PUT /api/tunnel/settings` takes `{ startWithClaudio?, port? }` (`409
tunnel.portWhileRunning` unless the tunnel is closed or failed, `409 tunnel.portFromEnv` where the
variable sets it), and `POST /api/tunnel/start` and
`POST /api/tunnel/stop` open and close the tunnel. A stop that arrives through the tunnel itself
answers first, with `state: 'stopping'`, and removes the rule a second after the reply is sent.
Every move emits `tunnel.changed` on `/api/events`, carrying the whole status; the event's title
never contains the address, and it never becomes a notification. The rows are in the
[Remote access](rest-api.md#remote-access) table of the REST API.

## Related

[[plans/tunnel.md]] · [[lan-access.md]] · [[setup.md]] · [[plans/in-app-setup.md]] · [[code-hosts.md]] · [[layered-settings.md]] · [[deploy.md]] · [[desktop.md]] · [[notifications.md]] · [[plans/mobile.md]] · [[providers.md]] · [[security-model.md]]
