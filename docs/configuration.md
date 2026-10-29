---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-29T12:00:00Z
tags:
    - configuration
    - environment
    - deploy
    - reference
---
# Configuration: the environment variables

What the server reads from its environment. Most of it is also editable in the app: a variable that
**seeds** a setting applies to a fresh install, and one that **fixes** a setting shows it read-only in
Settings ([layered-settings.md](layered-settings.md) has the rule). In Docker they go in `.env` or
`-e`; the desktop app sets its own ([desktop.md](desktop.md)). Until 2026-10-17 this table was the
README's.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | **Headless and legacy**, not the way to start: a subscription token from `claude setup-token`, for a deployment that cannot open a browser. See [Claude Code credentials](#claude-code-credentials) |
| `ANTHROPIC_API_KEY` | – | API key billing. Also a choice in the setup assistant, which keeps it in the vault |
| `PORT` / `HOST` | `8797` / `127.0.0.1` (`0.0.0.0` in the image) | API listen address. Loopback by default because the API runs commands on the machine and starts with no credential; the image opens it because Compose publishes the container on `127.0.0.1` anyway. Binding every interface while the mode is `none` logs a warning |
| `CLAUDE_BIN` | `claude` | CLI binary to use |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude config dir (`/home/node/.claude` in the image) |
| `CLAUDIO_WORKSPACE_DIR` | `./workspace` | Default working directory for runs. Created once at server start; a chat whose `cwd` is missing is refused (`400 cwd-missing`), never created |
| `CLAUDIO_PROFILE` | `full` | What the server registers and starts: `full` is the app; `headless` is an AI backend for one project, serving only the API such a client calls, with every chat a confined API chat ([workspaces.md](workspaces.md), [deploy.md](deploy.md#headless-next-to-a-project)). The headless image sets it. Any other value stops the start. `GET /api/system` carries it as `profile` |
| `CLAUDIO_DATA_DIR` | `./data` | Wrapper state. One server at a time: it takes `<data>/server.lock` first, and a second one on the same directory exits with code 73 without touching it ([security-model.md](security-model.md)) |
| `CLAUDIO_SECRET_KEY` | – | 32 bytes as hex: the key the secret vault (`secrets.json`) seals the keys and tokens Claudio hands a CLI with. The desktop app passes its own. Without it the Docker image makes one beside the data on the first write (`secret.key`, mode 600), which protects a copy of the files but not the volume, so passing it here is the recommended setup; a source install without it keeps the values plain at 0600. The server drops it from its environment once read |
| `CLAUDIO_DEFAULT_PERMISSION_MODE` | `acceptEdits` (`bypassPermissions` in the image, `dontAsk` in the headless one) | Mode for runs that do not set one. A headless server refuses to start with any mode but `dontAsk`. Without the variable it is editable in Settings → Runs & spend and applies to the next run; set, it is shown read-only there. Empty counts as unset |
| `CLAUDIO_MAX_CONCURRENT_RUNS` | `8` | Max simultaneous `claude` processes (1 to 64). Editable in Settings → Runs & spend unless set here, like the mode above. Empty counts as unset |
| `CLAUDIO_SETUP_SEEN` | off | `on` records that the setup assistant was finished or skipped. Without the variable the assistant writes it to `app-settings.json` (`POST /api/setup/seen`). The older `CLAUDIO_PROVIDERS_STEP_SEEN`, and a `providersStepSeen` already stored, still count. Empty counts as unset |
| `CLAUDIO_PUSH_SUBJECT` | `https://github.com/yeyo11/claudio` | The VAPID `sub` claim of every Web Push this server signs: a `mailto:` or `https:` a push service can complain to, naming a real domain — Apple refuses the whole JWT with `403 BadJwtToken` for something like `mailto:claudio@localhost`. Changing it takes effect on the next start, keypair and registered installs untouched |
| `CLAUDIO_AUTH_MODE` | `none` (in the image: unset makes a first-run token, see below) | `none`, `token` or `oidc`. **Seeds** an install that has no `auth.json` yet; after that the setting saved from the UI wins. In the image, `none` set here is always respected and logs one line saying the terminal and in-app updates need a token. See [securing.md](securing.md) |
| `CLAUDIO_AUTH_TOKEN` | – | The bearer token to seed with when the mode is `token`. Only its SHA-256 is stored |
| *(none)* first-run token | – | In the image, when none of `CLAUDIO_AUTH_MODE`, `CLAUDIO_AUTH_TOKEN` and `CLAUDIO_OIDC_ISSUER` is set, the first start makes an owner token, prints it once and keeps it in `/data/first-run-token` until first used. The Helm chart's `auth.mode: auto` (the default) writes no variable so this happens. See [deploy.md](deploy.md#the-first-run-token) |
| `CLAUDIO_AUTH_TOKEN_RESET` | – | `1` makes `CLAUDIO_AUTH_TOKEN` replace the stored token on start, on an install that already has one. The change is audited with actor `env`, and a value already applied is not applied twice |
| `CLAUDIO_DESKTOP_TOKEN` | – | Set by the desktop app on the server it starts: a secret generated at each launch that its tray sends as a bearer token. Accepted only from loopback, dialled on a loopback name, as the read-only actor `desktop`; kept in memory, never stored, and removed from the environment chats inherit. See [docs/desktop.md](desktop.md) |
| `CLAUDIO_READ_ONLY` | `false` | Seeds read-only mode |
| `CLAUDIO_OIDC_ISSUER` / `_AUDIENCE` / `_CLIENT_ID` | – | Seed the OIDC settings: the issuer whose JWKS validates a JWT, the `aud` it must carry and the client id. A configured client id refuses a token whose `azp` names another client, and accepts one that carries no `azp` at all |
| `CLAUDIO_CLI_UPDATE_CHECK` | on | `off` stops the daily check for a newer Claude Code (the button in Settings keeps working) |
| `CLAUDIO_CLI_REGISTRY_URL` | the npm registry | Where that check reads the package metadata, and where the in-app install of a newer Claude Code downloads the platform package from: a mirror, for an air-gapped install |
| `CLAUDIO_UPDATE_CHECK` | on | `off` stops the daily check for a newer Claudio release (**Check for updates** in Settings keeps working) |
| `CLAUDIO_RELEASES_URL` | GitHub's latest release of `yeyo11/claudio` | Where that check asks instead: a mirror or a test fixture. It must answer in GitHub's shape (`tag_name`, `html_url`, `published_at`, and `assets[]` with `name` and `browser_download_url`, which the in-app server update reads) |
| `CLAUDIO_SERVER_UPDATE` | on | `off` hides in-app server updates in a container: the Updates card shows the host commands. See [updates.md](updates.md) |
| `CLAUDIO_BUNDLE_KEYS_DIR` | `/app/keys` | The public keys the **server** checks a downloaded bundle against; tests and e2e point it at a fixture. The launcher ignores it and always uses `/app/keys` |
| `CLAUDIO_LAUNCHER`, `CLAUDIO_APP_DIR` | set by the launcher | `CLAUDIO_LAUNCHER=1` (the container's launcher) or `desktop` (the desktop shell, [updates.md](updates.md#files-and-variables)) tells the server it is supervised and may exit 75 to be restarted; `CLAUDIO_APP_DIR` is the directory the running bundle came from (`/app` or `/data/app/<version>`). Not for setting by hand |
| `CLAUDIO_DISTRIBUTION` | – (a source checkout) | How this server was installed, which decides the update steps the UI offers: `docker` (set by the image), `appimage` or `deb` (set by the desktop app) |
| `CLAUDIO_PID_FILE` | `/tmp/claudio.pid` in the image | Where the server writes its pid, so the image's healthcheck can end a wedged server |
| `CLAUDIO_HEALTH_RESTART_AFTER` | `3` | Consecutive failed health probes (30 s apart) after which the container restarts itself |
| `CLAUDIO_ALLOWED_HOSTS` | – (loopback only) | Comma-separated host names this wrapper answers to besides loopback, each a name or a `*.domain` pattern standing for that domain's subdomains. A `Host` that matches none of them is refused `421` before the credential is read. Ports and letter case are ignored; `GET /api/health` is exempt. Behind a proxy, name the public host here or everything answers `421`. Its hosts are fixed; more can be added in Settings → Access & safety, without a restart ([docs/layered-settings.md](layered-settings.md)); a running tunnel's exact host is added on its own |
| `CLAUDIO_TUNNEL` | on | Whether Settings → Access & safety → Remote access may serve Claudio on the tailnet through `tailscale serve`: `on`/`1`/`true` or `off`/`0`/`false`, empty meaning the default; anything else stops the server at startup. In the image, `off` also keeps the entrypoint from starting its own tailscaled. See [docs/tunnel.md](tunnel.md) |
| `CLAUDIO_TAILSCALE_MANAGED` | set by the image's entrypoint | `1` when the tailscaled behind the CLI is Claudio's own (the image's), which the app then signs in and out. Not for setting by hand |
| `CLAUDIO_TAILSCALE_HOSTNAME` | `claudio` | The node's name when the image's Tailscale signs in (`tailscale up --hostname`); a DNS label, or the server stops at startup |
| `CLAUDIO_TUNNEL_PORT` | `8444` | The HTTPS port of Claudio's Serve rule on the tailnet name, kept off 443 so a Serve rule of your own is never touched. Not a port between 1 and 65535 stops the server at startup |
| `TAILSCALE_BIN` | `tailscale` | The Tailscale CLI the tunnel runs |
| `CLAUDIO_CORS_ORIGIN` | – (CORS off) | Comma-separated origins (or `*`, which echoes the caller) for external browser clients. The event streams obey this list too. The bundled UI never needs it: in dev it uses the Vite `/api` proxy, in production it is same-origin |
| `VITE_API_TARGET` | `http://localhost:8797` | Where the Vite dev server proxies `/api` |
| `CLAUDIO_IDLE_TIMEOUT_MS` | `600000` | Idle runs are closed after this (they resume transparently) |
| `CLAUDIO_WEB_DIST` | `apps/web/dist` (`/app/web` in the image) | Built UI the API serves (the desktop app points it at its bundled copy) |
| `CLAUDIO_MCP_ENTRY` | the `mcp.mjs` beside the API bundle, when it exists | The bundle of Claudio's own MCP server a confined chat's CLI starts; from source it runs `packages/mcp` with tsx. See [docs/claudio-mcp-server.md](claudio-mcp-server.md) |
| `CLAUDIO_GUARD_ENTRY` | the `guard.mjs` beside the API bundle | The bundle of Claudio's guard, the program the CLI runs on each tool call. It must not be group- or world-writable or sit under a project; from source it runs `packages/core/src/guards/main.ts`. See [docs/guards.md](guards.md) |
| `CLAUDIO_CHAT_BUDGET_USD` | `1` | The budget of a confined API chat that names none (`maxBudgetUsd`, `X-Claudio-Max-Budget-Usd`), in USD, above 0 and up to the spend cap's maximum; another value stops the start |
| `CLAUDIO_CHAT_RETENTION_DAYS` | `30` | Headless only: a chat idle this many days is deleted with its rows and the CLI's session files, by a sweep at start and every hour. A whole number from 1 to 3650 |
| `LOG_LEVEL` | `info` | Fastify/pino log level (`trace` … `fatal`, or `silent`) |

Claudio sets two variables for every chat it starts, so an agent that calls the REST API reaches the
wrapper that runs it and not another one on the same machine: `CLAUDIO_API_URL` (this server's API,
e.g. `http://127.0.0.1:34331/api`) and `CLAUDIO_CHAT_ID` (the chat's own id). With authentication on,
the agent still needs a token of its own.

A confined API chat (every chat of a headless Claudio, and every chat in a workspace) gets
`CLAUDIO_CHAT_ID` only: no URL and no token, so it has no way back into Claudio
([security-model.md](security-model.md#the-confined-api-chat)).

## Headless

A server with `CLAUDIO_PROFILE=headless` refuses to start, naming every problem at once, unless:

- `CLAUDIO_DAILY_SPEND_CAP_USD` is set (in the full profile unset means no cap);
- the guard has a credential (`CLAUDIO_AUTH_MODE=token` with `CLAUDIO_AUTH_TOKEN`, or the image's
  first-run token), unless it listens on loopback only;
- the permission mode is `dontAsk` (`CLAUDIO_DEFAULT_PERMISSION_MODE=dontAsk`, which the headless
  image sets).

In headless a single-label `Host` such as `claudio`, the name Docker's embedded DNS answers for a
compose service, is accepted besides loopback and `CLAUDIO_ALLOWED_HOSTS`; the full profile keeps
its allowlist. The launcher ignores any update overlay under `/data/app`: the image is the version.

### Workspaces

The ephemeral workspaces of [workspaces.md](workspaces.md) are bounded by these variables, read at
start in any profile. A value that is not a whole number above 0 stops the start rather than run with
a cap nobody chose.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDIO_WORKSPACES_DIR` | `/workspaces` in the image; elsewhere `workspaces` beside the data directory | Where the `ws_<id>` folders live. It may not be, hold or sit inside `CLAUDIO_WORKSPACE_DIR`, `CLAUDIO_DATA_DIR` or `CLAUDE_CONFIG_DIR`, nor be `/`: the start refuses it. The sweeper never removes anything outside it |
| `CLAUDIO_WORKSPACE_HOSTS` | `codeload.github.com` | Hosts a `{ url }` source and each of its redirects may name, separated by commas or spaces |
| `CLAUDIO_WORKSPACE_MAX_COMPRESSED_MB` | `100` | The archive as sent or downloaded (`413 workspace-too-large`) |
| `CLAUDIO_WORKSPACE_MAX_EXTRACTED_MB` | `500` | What the extraction writes, counted as bytes are written (`413`) |
| `CLAUDIO_WORKSPACE_MAX_FILES` | `50000` | Files and directories of one archive (`413`) |
| `CLAUDIO_WORKSPACE_TIMEOUT_SECONDS` | `60` | Download and extraction together (`408 workspace-timeout`) |
| `CLAUDIO_WORKSPACE_MAX_COUNT` | `20` | Workspaces at once, the ones being created included (`429 workspace-limit`) |
| `CLAUDIO_WORKSPACES_MAX_TOTAL_MB` | `2048` | Every workspace together under the root (`413`) |
| `CLAUDIO_WORKSPACE_TTL_MINUTES` | `120` | Lifetime from the last use; a chat started in it moves it |

## Set elsewhere

Variables that belong to one feature, described where that feature is:

| Variable | What it does | Where |
| --- | --- | --- |
| `CLAUDIO_DAILY_SPEND_CAP_USD` | The daily spend cap, fixed from the environment; required in headless ([Headless](#headless)) | [deploy.md](deploy.md#the-daily-spend-cap), [layered-settings.md](layered-settings.md) |
| `CLAUDIO_TERMINAL` | `off` vetoes the terminal for the whole deployment, `on` switches it on | [terminal.md](terminal.md), [deploy.md](deploy.md#the-terminal) |
| `CLAUDIO_TASK_MAX_MINUTES` | The default time limit of an orchestration task that sets none (180 minutes); `0` turns the default off | [resource-control.md](resource-control.md) |
| `CLAUDIO_ADMIT_MEMORY_PRESSURE` / `CLAUDIO_ADMIT_MEMORY_FLOOR_MB` | When the machine is too loaded to admit a new chat | [resource-control.md](resource-control.md) |
| `CLAUDIO_EVALS_PHASE2` / `CLAUDIO_EVALS_DIR` | Instruction evals' phase 2, and where eval files are read | [evals.md](evals.md) |
| `CLAUDIO_SHELL_PATH_PROBE` | Not for setting: the desktop app sets it to `1` on the login shell it asks for `PATH`, so an rc file can skip prompts and plugins | [desktop.md](desktop.md), [providers.md](providers.md) |
| `CLAUDIO_DOMAIN` | The public name the `tls` compose profile's Caddy serves | [deploy.md](deploy.md#docker-compose) |
| `CLAUDIO_COLLAB_PRESET` / `CLAUDIO_COLLAB_BIND` | Collaborators' iroh endpoint: `minimal` (no relay, no discovery, peers reached by loopback tickets) and the address it binds; for tests on one machine | [collaborators.md](collaborators.md) |

## Related

[[layered-settings.md]] · [[deploy.md]] · [[desktop.md]] · [[securing.md]] · [[chat-environment.md]] · [[security-model.md]] · [[rest-api.md]]

## Claude Code credentials

Claudio signs in to Claude Code in the app: the setup assistant, Settings → Claude Code and
Accounts → Add account offer **Claude account** (the CLI's own `claude auth login`, relayed: open a
link, approve, paste the code the page shows) and **API key**. In the assistant and Settings the
Claude account goes into the CLI's own config dir (`/home/node/.claude` in the image), so the
`claude` run in the terminal is signed in too ([decisions/claude-sign-in-paste-code.md](decisions/claude-sign-in-paste-code.md)).

The environment still works, for headless deployments:

- **`CLAUDE_CODE_OAUTH_TOKEN`** (compose, `docker run -e`, Helm's `claude.existingSecret`) is read by
  the CLI itself. It is the way to start only where nobody can open a browser. Settings → Claude Code
  names it as the source, it is validated like any credential, and it takes precedence over an
  account signed in from the app, which the sign-in panel warns about. Make the token with
  `claude setup-token` on a machine where you are signed in.
- **`ANTHROPIC_API_KEY`** in the environment works the same way.
- A token that an older Claudio kept in its vault keeps working until it fails or is replaced; a
  successful Claude-account sign-in clears it. `PUT /auth/credentials { oauthToken }` and
  `POST /accounts/token` still answer for scripts but are deprecated.
