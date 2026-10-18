---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
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
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | – | Alternative: API key billing |
| `PORT` / `HOST` | `8797` / `127.0.0.1` (`0.0.0.0` in the image) | API listen address. Loopback by default because the API runs commands on the machine and starts with no credential; the image opens it because Compose publishes the container on `127.0.0.1` anyway. Binding every interface while the mode is `none` logs a warning |
| `CLAUDE_BIN` | `claude` | CLI binary to use |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude config dir (`/home/node/.claude` in the image) |
| `CLAUDIO_WORKSPACE_DIR` | `./workspace` | Default working directory for runs |
| `CLAUDIO_DATA_DIR` | `./data` | Wrapper state |
| `CLAUDIO_SECRET_KEY` | – | 32 bytes as hex: the key the secret vault (`secrets.json`) seals the keys and tokens Claudio hands a CLI with. The desktop app passes its own. Without it the Docker image makes one beside the data on the first write (`secret.key`, mode 600), which protects a copy of the files but not the volume, so passing it here is the recommended setup; a source install without it keeps the values plain at 0600. The server drops it from its environment once read |
| `CLAUDIO_DEFAULT_PERMISSION_MODE` | `acceptEdits` (`bypassPermissions` in the image) | Mode for runs that do not set one. Without the variable it is editable in Settings → Access & safety and applies to the next run; set, it is shown read-only there. Empty counts as unset |
| `CLAUDIO_MAX_CONCURRENT_RUNS` | `8` | Max simultaneous `claude` processes (1 to 64). Editable in Settings → Access & safety unless set here, like the mode above. Empty counts as unset |
| `CLAUDIO_SETUP_SEEN` | off | `on` records that the setup assistant was finished or skipped. Without the variable the assistant writes it to `app-settings.json` (`POST /api/setup/seen`). The older `CLAUDIO_PROVIDERS_STEP_SEEN`, and a `providersStepSeen` already stored, still count. Empty counts as unset |
| `CLAUDIO_PUSH_SUBJECT` | `https://github.com/yeyo11/claudio` | The VAPID `sub` claim of every Web Push this server signs: a `mailto:` or `https:` a push service can complain to, naming a real domain — Apple refuses the whole JWT with `403 BadJwtToken` for something like `mailto:claudio@localhost`. Changing it takes effect on the next start, keypair and registered installs untouched |
| `CLAUDIO_AUTH_MODE` | `none` | `none`, `token` or `oidc`. **Seeds** an install that has no `auth.json` yet; after that the setting saved from the UI wins. See [securing.md](securing.md) |
| `CLAUDIO_AUTH_TOKEN` | – | The bearer token to seed with when the mode is `token`. Only its SHA-256 is stored |
| `CLAUDIO_AUTH_TOKEN_RESET` | – | `1` makes `CLAUDIO_AUTH_TOKEN` replace the stored token on start, on an install that already has one. The change is audited with actor `env`, and a value already applied is not applied twice |
| `CLAUDIO_DESKTOP_TOKEN` | – | Set by the desktop app on the server it starts: a secret generated at each launch that its tray sends as a bearer token. Accepted only from loopback, dialled on a loopback name, as the read-only actor `desktop`; kept in memory, never stored, and removed from the environment chats inherit. See [docs/desktop.md](desktop.md) |
| `CLAUDIO_READ_ONLY` | `false` | Seeds read-only mode |
| `CLAUDIO_OIDC_ISSUER` / `_AUDIENCE` / `_CLIENT_ID` | – | Seed the OIDC settings: the issuer whose JWKS validates a JWT, the `aud` it must carry and the client id. A configured client id refuses a token whose `azp` names another client, and accepts one that carries no `azp` at all |
| `CLAUDIO_CLI_UPDATE_CHECK` | on | `off` stops the daily check for a newer Claude Code (the button in Settings keeps working) |
| `CLAUDIO_CLI_REGISTRY_URL` | the npm registry | Where that check reads the package metadata: a mirror, for an air-gapped install |
| `CLAUDIO_UPDATE_CHECK` | on | `off` stops the daily check for a newer Claudio release (**Check for updates** in Settings keeps working) |
| `CLAUDIO_RELEASES_URL` | GitHub's latest release of `yeyo11/claudio` | Where that check asks instead: a mirror or a test fixture. It must answer in GitHub's shape (`tag_name`, `html_url`, `published_at`) |
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
| `LOG_LEVEL` | `info` | Fastify/pino log level (`trace` … `fatal`, or `silent`) |

Claudio sets two variables for every chat it starts, so an agent that calls the REST API reaches the
wrapper that runs it and not another one on the same machine: `CLAUDIO_API_URL` (this server's API,
e.g. `http://127.0.0.1:34331/api`) and `CLAUDIO_CHAT_ID` (the chat's own id). With authentication on,
the agent still needs a token of its own.


## Set elsewhere

Variables that belong to one feature, described where that feature is:

| Variable | What it does | Where |
| --- | --- | --- |
| `CLAUDIO_DAILY_SPEND_CAP_USD` | The daily spend cap, fixed from the environment | [deploy.md](deploy.md#the-daily-spend-cap), [layered-settings.md](layered-settings.md) |
| `CLAUDIO_TERMINAL` | `off` vetoes the terminal for the whole deployment, `on` switches it on | [terminal.md](terminal.md), [deploy.md](deploy.md#the-terminal) |
| `CLAUDIO_TASK_MAX_MINUTES` | The default time limit of an orchestration task that sets none (180 minutes); `0` turns the default off | [resource-control.md](resource-control.md) |
| `CLAUDIO_ADMIT_MEMORY_PRESSURE` / `CLAUDIO_ADMIT_MEMORY_FLOOR_MB` | When the machine is too loaded to admit a new chat | [resource-control.md](resource-control.md) |
| `CLAUDIO_EVALS_PHASE2` / `CLAUDIO_EVALS_DIR` | Instruction evals' phase 2, and where eval files are read | [evals.md](evals.md) |
| `CLAUDIO_SHELL_PATH_PROBE` | Not for setting: the desktop app sets it to `1` on the login shell it asks for `PATH`, so an rc file can skip prompts and plugins | [desktop.md](desktop.md), [providers.md](providers.md) |
| `CLAUDIO_DOMAIN` | The public name the `tls` compose profile's Caddy serves | [deploy.md](deploy.md#docker-compose) |
| `CLAUDIO_COLLAB_PRESET` / `CLAUDIO_COLLAB_BIND` | Collaborators' iroh endpoint: `minimal` (no relay, no discovery, peers reached by loopback tickets) and the address it binds; for tests on one machine | [collaborators.md](collaborators.md) |

## Related

[[layered-settings.md]] · [[deploy.md]] · [[desktop.md]] · [[securing.md]] · [[chat-environment.md]] · [[security-model.md]] · [[rest-api.md]]
