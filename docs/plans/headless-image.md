---
created_at: 2026-10-28T21:00:00Z
updated_at: 2026-10-29T01:15:00Z
tags:
    - plan
    - docker
    - api
    - security
    - sign-in
    - deploy
    - workspaces
---
# Plan: a headless image, one Claudio per project

Status: **planned**, decisions taken by the owner on 2026-10-28; nothing is built. The design is the
definitive one: no interim path (shared volumes, fallbacks to another surface) is planned or kept,
by the owner's decision and the consumers' replies (below). It was reviewed for leaks on 2026-10-28
([Review](#review-2026-10-28)), which reshaped D12 into the confined API chat (D14).

## Context

The owner runs Claudio as the AI backend of two personal projects on the server `apps-1`, both
against one shared container (`ghcr.io/yeyo11/claudio:0.10.0`, stack `stacks/claudio` of the owner's
infra repository). What was read there on 2026-10-28:

| What | Reading |
|---|---|
| Image | 1.43 GB |
| Memory of the container | 186 MiB: `api.mjs` 216 MB RSS, `launcher.mjs` 55 MB, and a `tailscaled` of 40 MB nobody uses (Traefik and the host's own Tailscale already serve it on the tailnet) |
| CPU at rest | 0.07 % |
| Load | 12 chats that day, all `haiku`, all with `cwd=/workspace` |
| Sign-in | Once, through the web UI, behind Traefik on the tailnet |

What the two consumers call, and their replies to the advisory (2026-10-28):

- **trading-bot** (`src/tradingbot/integrations/claudio_model.py`): `POST /api/chats` with `jsonSchema`,
  `allowedTools: []`, `permissionMode: 'dontAsk'`, `maxBudgetUsd` and `keepAlive: false`, polling
  `GET /api/chats/:id?limit=20` and ending with `POST /api/chats/:id/stop`; it sends no `cwd`. No other
  route is called. Its connection test moves from a work item (`GET /api/work-items/by-key/:key`,
  which headless does not serve) to `GET /api/ready` (D11) plus an authenticated `GET /api/system`;
  `comment()` and its `claudio` delivery channel are removed on its side; its own instance on
  `127.0.0.1:8797` with a new token fits.
- **shipcast** (`shipcast/data/advisory-reply-claudio-headless.md`): today the same `POST /api/chats`
  shape with a `cwd` and read-only tools, `GET /api/providers/claude-code/models`, and `/api/v1` for
  streamed text. Its definitive design is an AI SDK provider over `/api/v1` and `/api/workspaces` only,
  with a readiness route and no filesystem shared with Claudio (its `heavy` process scales on its own).
  It enables Claudio in production once a headless release carries D7, D8, D10 and D11.

So the problem is not the UI files, a few static megabytes the server only reads when a browser
asks. It is everything else the image carries and the server starts for a client that only runs
one-shot model turns. The memory saved is modest; what is gained is a much smaller image, fewer
moving parts, and an attack surface reduced to one token-guarded API whose runs are confined.

Defects found on the way, all fixed by this plan:

- **A missing `cwd` is created, not refused** (`ChatManager.begin`, `packages/core/src/chats.ts:1014`).
  On `apps-1` shipcast's clones live in its own volume and the shared Claudio's `/workspace` is empty,
  so a content pack would be written without reading any code, with no error (D9).
- **Declared tool rules are narrower than what runs.** Shipcast's transcripts show
  `ls && cat package.json && head -150 README.md`, `git ls-files | grep … | head`,
  `sed -n 150,260p README.md; cat ROADMAP.md | head -120` running with only `Bash(ls:*)`,
  `Bash(git log:*)`, `Bash(git tag:*)`, `Bash(git show:*)`, Read, Grep and Glob allowed under
  `dontAsk`. That is Claude Code's documented behaviour
  ([permissions](https://code.claude.com/docs/en/permissions)): a built-in, non-configurable set of
  read-only commands (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, read-only `git`…) runs without
  a prompt in every mode, `dontAsk` included; a compound command runs when each part is allowed or
  read-only; and those commands may read outside the working directory unless
  `permissions.blockReadsOutsideWorkingDirectories` is set.
- **An API chat is not confined today.** It loads the settings of its working directory
  (`--setting-sources` is passed only to confined runs, `packages/core/src/providers/claude-code/args.ts:45-47`),
  so a repository's `.claude/settings.json` hooks would run; it receives `CLAUDIO_API_URL` and its own
  `CLAUDIO_API_TOKEN` (`chats.ts:1864-1869`), with which it can start further chats; `POST /api/chats`
  takes any `cwd` and `bypassPermissions`, which is also the image's default
  (`CLAUDIO_DEFAULT_PERMISSION_MODE`); and `PATCH /api/chats/:id` changes the mode of a live chat.

## Decisions

- **D1. What a headless Claudio serves** (owner, 2026-10-28). Routes, not plugins: a plugin that
  serves more than this registers only the listed routes in headless.

  | Route | Notes |
  |---|---|
  | `GET /api/health`, `GET /api/ready` | Unauthenticated (D11) |
  | `GET /api/system` | Carries `profile` |
  | `POST /api/chats`, `GET /api/chats/:id`, `POST /api/chats/:id/messages`, `POST /api/chats/:id/stop`, `DELETE /api/chats/:id`, `GET /api/chats` | Under D14; not resume, fork, `PATCH`, `claudio-mcp`, `mcp/:name`, permission decisions, workflows, environments, usage, tasks |
  | `POST /api/uploads` (the chat attachment upload) | Attachments of a chat |
  | `/api/v1/*` and the client-tool stub | Under D14 |
  | `POST /api/workspaces`, `GET /api/workspaces/:id`, `DELETE /api/workspaces/:id` | D7 |
  | `GET /api/providers`, `GET /api/providers/claude-code/models` | The model list |
  | `GET /api/config/tool-presets` | Read only: no `PUT`, `DELETE`, `restore` |
  | `/api/accounts` (list, add, sign-in, its code and state, cancel, refresh, remove), the rotation settings | D3; several accounts and rotation stay |
  | `/api/auth`, `/api/security` | As far as the token needs them (task 1 lists them) |

  Everything else answers `404` (`route not found`). No web UI. The OpenAPI document is generated from
  the registered routes, so it describes only what is served. Task 1 confirms each route's exact path.
- **D2. One codebase, a second image target and a start profile** (owner, 2026-10-28).
  `docker/Dockerfile` gains a `headless` stage beside `runtime`, and the server reads
  `CLAUDIO_PROFILE=headless` (default `full`) to decide what to register and start. Rejected: a
  build-time flag that strips code from `api.mjs`; one bundle that behaves by profile is one bundle to
  test.
- **D3. Sign-in without UI is the paste-code `claude auth login`, driven by a command** (owner,
  2026-10-28, option A). `claudio login` and `claudio status` call the routes the UI already uses:
  `POST /api/accounts/default/login`, `POST /api/accounts/logins/:id/code`,
  `GET /api/accounts/logins/:id`. Inside the container (`docker compose exec claudio claudio login`) or
  from any machine (`--url`, `--token`). Rejected: running `claude auth login` straight in the
  container, since Claudio learns of it only at its next check and skips its account bookkeeping; it
  stays documented as the way out when the server cannot start. `CLAUDE_CODE_OAUTH_TOKEN` stays
  headless and legacy ([claude-sign-in-paste-code](../decisions/claude-sign-in-paste-code.md)).
- **D4. Headless means token auth, a spend cap and a budget per chat.** A headless start refuses to
  run with `CLAUDIO_AUTH_MODE=none` unless it listens on loopback only, and refuses to run without
  `CLAUDIO_DAILY_SPEND_CAP_USD` (today unset means no cap, `packages/core/src/paths.ts:198`). A chat
  that sends no `maxBudgetUsd` (or `X-Claudio-Max-Budget-Usd`) gets `CLAUDIO_CHAT_BUDGET_USD`
  (default 1 USD). The docker first-run token
  ([container-owner-token](../decisions/container-owner-token.md)) still applies.
- **D5. One instance per project, sharing no filesystem with it** (owner, 2026-10-28; shipcast's
  reply). Each project runs its own headless Claudio with its own data and sign-in volumes. Code
  reaches Claudio through a workspace (D7), never through a volume the project also mounts.
- **D6. No in-app updates in headless.** The image is the version; a new one is a new tag. The
  launcher stays (signals, restarts) and, with no keys in the image, boots only `/app/api.mjs`: an
  overlay under `/data/app` is ignored, whatever `state.json` says. The server-update and CLI-install
  routes are not registered.
- **D7. Ephemeral workspaces** (shipcast 4.1, both sources as asked; owner: no interim solution).
  `POST /api/workspaces` makes a copy of a source tree from a `tar.gz`, given either as
  `{ "url": "https://…" }` (Claudio downloads it) or as the request body (`application/gzip`). It
  answers `201 { id, bytes, files, expiresAt }`; `GET` reads one; `DELETE` stops the chats running in
  it and removes it. A workspace expires after a TTL counted from its last use. The `cwd` is not
  returned: a chat names the workspace by id (D8), and nothing else can name its folder. Design below.
- **D8. `/v1` takes every per-call option `/api/chats` takes** (shipcast 4.2). New request headers,
  on Chat Completions and Responses alike: `X-Claudio-Workspace` (a workspace id),
  `X-Claudio-Max-Turns`, `X-Claudio-Max-Budget-Usd`, and `X-Claudio-Allowed-Tools` (a JSON array of
  Claude Code permission rules). `POST /api/chats` takes `workspaceId`. Headers, because every Claudio
  parameter on `/v1` already is one. `X-Claudio-Allowed-Tools` and `X-Claudio-Tool-Preset` together
  are a `400`. **These four are part of the conversation's key**, unlike `X-Claudio-Cwd` today
  (`docs/openai-compatible-api.md`, "It applies only when a chat is created"): the same history sent
  with another workspace or other tools is a new conversation, never the old chat on another policy.
  A continuation that names a chat (`X-Claudio-Chat-Id`, `previous_response_id`) with a policy that
  differs from the chat's own answers `409 policy_mismatch`. A request whose history has no assistant
  message is never looked up (`packages/core/src/openai/request.ts:332`), so a one-shot run (system
  and one user message) always starts a new chat, a retry included; no "new chat" header is added
  (shipcast's second reply asked for one; answered 2026-10-28).
- **D16. Typed run errors on `/v1`** (shipcast's second reply). A turn that ends without the answer it
  owed is a non-retryable `422` in OpenAI's error shape whose `code` names why, instead of today's
  `500 server_error`: `max_turns` (`X-Claudio-Max-Turns` reached), `max_budget` (the chat's budget
  reached), `tool_blocked` (no answer, and the guard blocked at least one call in the turn; the message
  names the last blocked subcommand or path and the missing rule), `no_structured_output` (the model
  gave up on the schema with nothing blocked). Streamed, the same error is the last chunk before
  `[DONE]` (Chat Completions) or `response.failed` with `error.code` (Responses). The workspace and
  policy refusals use the same shape on `/v1`: `400 cwd_missing`, `404 workspace_not_found`,
  `410 workspace_expired`, `409 policy_mismatch`. Codes are snake_case on `/v1`, as OpenAI's own
  (`rate_limit_exceeded`), and kebab-case on the REST API, as Claudio's are there. The spend cap and
  usage limits stay `429` with `Retry-After` (D13): those are retryable.
- **D9. A chat's `cwd` must exist, at every start.** `ChatManager.begin` no longer creates its `cwd`;
  a start or a resume (a `/v1` cold resume included) whose `cwd` is missing is refused: `400
  cwd-missing`, or `410 workspace-expired` for a chat in a workspace. The default working directory
  (`CLAUDIO_WORKSPACE_DIR`) is created once at server start. Task 1 lists the internal callers of
  `begin` (orchestrator, flows, evals, the assistant) and makes each create its own directory first
  where it relied on `begin`. Applies in every profile.
- **D10. The compose service name reaches a headless Claudio** (shipcast 4.4). In the headless
  profile a single-label `Host` (no dot, not an IP: what Docker's embedded DNS answers for, such as
  `claudio`) is allowed besides loopback and `CLAUDIO_ALLOWED_HOSTS`. DNS rebinding needs a name an
  attacker's resolver answers for; a single label reaches only the local resolver and its search
  domains, which are the operator's. The full profile keeps its allowlist.
- **D11. Readiness** (shipcast 4.5). `GET /api/ready`, unauthenticated like `/api/health`: `200` when
  the store is open, the CLI is installed and an account is signed in; otherwise `503` with
  `{ ready: false, reason }` (`cli-missing`, `signed-out`, `sign-in-expired`, `starting`). It spawns
  nothing and says nothing about the account beyond the reason. `/api/health` stays the liveness probe
  of the image's healthcheck (a signed-out Claudio is alive and must not be restarted).
  `claudio status --json` prints the same state plus the account and its last usage reading.
- **D12. The declared tool policy is the effective policy** (shipcast 4.3). Superseded in its form by
  D14 after the review: the policy is enforced by confining the run, with the guard behind it.
  Rejected: documenting the CLI's semantics and leaving it to consumers. The CLI's read-only set is not
  configurable, so a consumer cannot get an exact policy any other way, and headless chats read
  untrusted repositories next to `/data`.
- **D13. Usage limits on `/v1` answer `429` with `Retry-After`** (shipcast 4.6). Already built
  ([openai-compatible-api.md](../openai-compatible-api.md)); kept, and covered by a headless test.
- **D14. Every chat of a headless Claudio, and every chat in a workspace in any profile, is a
  confined API chat.** There is no other kind in headless. A confined API chat:
  1. **Starts confined**, through the confinement Claudio already has (`ChatConfinement`,
     `args.ts`): `--restricted` (the file tools stay in the working directory), `--tools=` the declared
     tools only (plus `StructuredOutput` when a schema is set), `--setting-sources=` empty (no user,
     project or local settings: a repository's `.claude/settings.json`, its hooks, its permission rules
     and its `additionalDirectories` are never read), `--strict-mcp-config` with no server but the
     `/v1` client-tool stub when the request carries client tools, and
     `permissions.blockReadsOutsideWorkingDirectories` in the settings file Claudio passes.
  2. **Runs in `dontAsk`, always.** Any other `permissionMode` is a `400`; the image's
     `CLAUDIO_DEFAULT_PERMISSION_MODE=bypassPermissions` does not apply (the headless stage sets
     `dontAsk`); there is no `PATCH`.
  3. **Has no way back into Claudio**: no `CLAUDIO_API_URL`, no `CLAUDIO_API_TOKEN` (`api: false`, as
     the lesson miner already runs, `docs/security-model.md`), and `claudioMcp` or `mcp` in the request
     are a `400`.
  4. **Has its policy fixed at creation and stored with the chat**: workspace, declared tools, turns,
     budget, schema. Resume, fork and settings changes are not served; a `/v1` continuation with
     another policy is a `409` (D8); a continuation in an expired workspace is a `410` (D9).
  5. **Is guarded by `declared-tools`**, a new rule of Claudio's `PreToolUse` guard
     ([guards.md](../guards.md)), as defence in depth behind the confinement:
     - a tool call passes only when its tool is declared (`StructuredOutput` and the client-tool
       stub's tools always pass); WebFetch, WebSearch, Task, `mcp__*` and the rest are blocked unless
       declared;
     - a Bash call passes only when **every** subcommand the shell reader finds (through wrappers,
       `cd`, `env`, `xargs`, `bash -c`) matches a declared `Bash(...)` rule, **and** every argument
       that names a path resolves (after `~`, `..` and symlinks, with `guards/paths.ts`) inside the
       chat's working directory or one of the chat's own attachment files. A variable expansion
       (`$X`, `${X}`), a command substitution or a process substitution anywhere in the line is
       blocked, since what it reads cannot be known in advance. A bare `Bash` or `Bash(*)` rule is
       refused at creation (`400`). Pipes and `&&`, `||`, `;` chains pass when every part does.
       Path checks cover option values too (`grep -f FILE`, `--file=FILE`, `find -newer FILE`);
     - a declared command that can write or run something passes only in its read-only forms,
       whatever the rule says: `sed` only with `-n` and a script made of addresses and `p` (no `w`,
       `W`, `r`, `R`, `e`, no `s///` flags `w` or `e`, no `-i`, `-f`, `--in-place`); `find` without
       `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`;
       no output redirection but to `/dev/null`; `xargs` is blocked, since its arguments come from
       stdin and cannot be checked;
     - a file tool passes only on a path inside the working directory or an attachment of the chat;
     - anything the reader cannot parse is blocked, as the guard already does.
     The rule cannot be switched off by the chat's own token, and a block is a transcript line and a
     `guard_events` row naming the subcommand or path and what was missing.
  6. **Reads its attachments.** Image attachments go inline as today; other attachments are read by
     path from the uploads folder, and only the chat's own files there are allowed (by `--restricted`'s
     additional paths and by the guard), never the folder.
  7. **Runs git safely.** The environment carries `GIT_CONFIG_NOSYSTEM=1`,
     `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CEILING_DIRECTORIES` set to the workspaces root, so no git
     configuration but the run's own is read.
  8. **Defaults to no tools.** With no declared tools and no preset, a confined API chat can only
     answer (with `StructuredOutput` for a schema). On `/v1` in headless this replaces the app's
     default preset. `X-Claudio-Tool-Preset` names a stored preset, read only in headless.

  In the full profile, a person's chats, orchestrations, flows and the assistant are unchanged; only
  chats in a workspace are confined API chats there. Rejected: applying the guard alone to unconfined
  chats (the review showed hooks from the repository run before any guard sees a tool call).
- **D15. Retention.** In headless, chats are deleted 30 days after their last activity
  (`CLAUDIO_CHAT_RETENTION_DAYS`), with their rows and the CLI's session files under
  `~/.claude/projects`, since both hold the content of the repositories they read. `DELETE
  /api/chats/:id` removes the same at once. Task 1 checks that the deletion that exists today removes
  the CLI's session file too, and makes it do so if not.

## Design

### The image (`docker/Dockerfile`, stage `headless`)

From `node:26-bookworm-slim`, with `ca-certificates`, `git`, `ripgrep`, `procps`, Claude Code
(pinned and checksummed as in `runtime`), and `/app/api.mjs`, `/app/mcp.mjs` (the `/v1` client-tool
stub), `/app/guard.mjs`, `/app/launcher.mjs`, `/app/image.json`, `/app/cli.mjs` (linked as
`/usr/local/bin/claudio`). Same user, root-owned read-only `/app`, the `/data` and
`/home/node/.claude` volumes, `/workspace` (the default working directory) and `/workspaces` (D7)
inside the container, the same healthcheck. Environment: `CLAUDIO_PROFILE=headless`,
`CLAUDIO_TUNNEL=off`, `CLAUDIO_DEFAULT_PERMISSION_MODE=dontAsk`, `CLAUDIO_SERVER_UPDATE=off`.

Without: the web build, gh, glab, Tailscale, `youtrack-app`, pnpm, python3, node-pty and the terminal
host, iroh and the collaborators host, `docker/keys` (D6).

Size goal: under 500 MB, measured; the Outcome records the real number.

### The profile (`CLAUDIO_PROFILE=headless`)

- **Routes** (`apps/api/src/app.ts`): the full plugin list in `full`; in `headless`, the D1 routes
  only, registered route by route where a plugin serves more. The security guard, the error handler,
  compression and ETags stay; `fastifyStatic` and the websocket plugin are skipped.
- **Start checks** (D4): auth, spend cap, and a refusal to start with a permission mode other than
  `dontAsk`.
- **Core** (`packages/core/src/index.ts`): what the constructor and `startServer` start gets a profile
  check. Task 1 lists them with what each needs. Starting point (2026-10-28): `sampler`, `spend`,
  `decisionResolvers`, `healthMonitor`, `changeWatcher`, `lessonQueue`, `lessons`,
  `pullRequestWatcher`, `schedules`, `rotation`, `collaborators`, `tunnel.attach`,
  `hosts.startWatching`, `cliVersion.startDaily`, `release.startDaily`. Expected to stay: `spend`,
  `healthMonitor`, `rotation`, providers watching, the workspace sweeper (D7) and the retention sweeper
  (D15). Each one kept or dropped is recorded with its reason.

### Workspaces (D7)

- **Root.** `/workspaces/ws_<id>` (`CLAUDIO_WORKSPACES_DIR`), outside `CLAUDIO_WORKSPACE_DIR`. No
  `cwd`, `X-Claudio-Cwd` or project path may be, or contain, a folder under it (`400`): a workspace is
  reached only by its id, so only as a confined API chat (D14).
- **Sources.** `{ url }`: `https` only; the host must be in `CLAUDIO_WORKSPACE_HOSTS` (default
  `api.github.com,codeload.github.com`, so shipcast may pass GitHub's
  `/repos/{o}/{r}/tarball/{ref}` link and its redirect is followed); at most three redirects, each to
  an allowed host; every resolved address public, through the address guard of
  `packages/core/src/openai/fetch-image.ts` applied at DNS lookup, so a rebinding name cannot reach a
  private address. The URL carries GitHub's short-lived token: it is never logged, stored, put in an
  error or an event; errors name the host only. The body: `application/gzip`, read as a stream by a
  content-type parser of its own on this route, with its own `bodyLimit` (the compressed cap).
- **Caps** (settings; defaults checked against a large real repository in task 4): 100 MB compressed,
  500 MB extracted (counted as bytes are written, not from headers), 50 000 entries, 60 s to download
  and extract, 20 workspaces (counted with the ones being created, reserved atomically before the
  download starts), and 2 GB in total under the root. Over a cap: `413` (size, entries, total) or `429`
  (count), and nothing is left on disk.
- **Extraction.** Streamed, entry by entry, each checked after PAX and GNU long names are resolved and
  before anything is written: regular files and directories only (symlinks, hard links, devices and
  FIFOs refuse the archive), no absolute path, no `..`, no name that leaves the folder after
  normalisation, and **no path component named `.git`** (the archive is refused: shipcast needs no
  history, and a hostile `.git/config` would make git run its programs). When the archive holds one
  top-level directory (GitHub's `owner-repo-sha/`), the chat's working directory is that directory.
  Task 4 chooses between the `tar` package with its filters and a small tar reader over `node:zlib`;
  GNU `tar` from the shell is rejected, since its safety depends on flags and version. Files are
  written `0444` and directories `0555` as a hint only: the agent's user owns them and could change
  that, so read-only comes from D14 (no write tool can be declared in a workspace: `400`) and from the
  guard.
- **Store.** A row per workspace in SQLite (`workspaces`: id, source kind, host for a URL, bytes,
  files, created, last used, expires, state), since workspaces are records that come and go
  ([CONTRIBUTING](../../CONTRIBUTING.md)).
- **Lifetime.** TTL 2 h from last use (setting); each chat start in it moves `lastUsed`. A sweeper
  removes expired workspaces whose chats have ended, at start and every 5 minutes; at start it also
  removes `ws_*` folders under the workspaces root that have no row, and nothing outside that root.
  `DELETE` stops running chats first.
- **Refusals** carry codes: `workspace-host-not-allowed`, `workspace-address-blocked`,
  `workspace-too-large`, `workspace-bad-archive`, `workspace-limit`, `workspace-not-found`,
  `workspace-expired`.

### `/v1` parity (D8)

The headers map to the chat options `POST /api/chats` takes (`maxTurns`, `maxBudgetUsd`,
`allowedTools`, `workspaceId`). Their values go into the conversation key's seed, so a follow-up with
other values is another conversation; a continuation that names a chat compares them with the chat's
stored policy (`409 policy-mismatch`). Invalid values are a `400 invalid_request_error` naming the
header. This changes the key for every `/v1` client; recorded in the release note.

### The `declared-tools` guard (D14.5)

A new rule in `packages/core/src/guards/`, beside `command.ts` and `files.ts`, fed the chat's declared
rules, working directory and attachment paths through the rules file the launch already writes. It
reuses the shell reader and `paths.ts`, and matches each subcommand against the declared Bash rules
with Claude Code's own wildcard semantics. The bypass corpus gains: shipcast's four transcript
commands (blocked without their rules, passed with them); `cat ~/.claude/.credentials.json`,
`cat /proc/self/environ`, `cat /data/auth.json`, `head ../../data/wrapper.db`, `ls $HOME`,
`cat $(echo /data/auth.json)`, a symlink-free path that climbs out with `..`; a WebFetch and an
`mcp__*` call; trading-bot's exact request (`allowedTools: []`, a schema, `dontAsk`), which must pass.
Under shipcast's declared rules (Read, Grep, Glob, `Bash(ls *)`, `Bash(find *)`, `Bash(cat *)`,
`Bash(head *)`, `Bash(tail *)`, `Bash(sed -n *)`, `Bash(grep *)`, `Bash(wc *)`, `Bash(cut *)`):
`grep -n x f | head -40` and `ls && cat package.json` pass; `sed -n '1,20p' README.md` passes;
`sed -n '1w /tmp/x' f`, `sed -n '1e id' f`, `find . -exec cat {} +`, `find . -delete`,
`cat f > out`, `ls | xargs cat` and `grep -f /data/auth.json x` are blocked.

### The `claudio` command (D3, D11)

```text
claudio login  [--url URL] [--token TOKEN] [--account default]
claudio status [--url URL] [--token TOKEN] [--json]
```

Defaults: `http://127.0.0.1:$PORT`, `$CLAUDIO_AUTH_TOKEN`, then the first-run token file. `login`
prints the URL, reads the code without echo, sends it and waits for the end; `Ctrl-C` cancels it. Exit
codes: 0 done, 1 failed or expired, 2 usage or connection error. English output (an operator's
command, not the app's UI).

### One Claudio per project

The example for `docs/deploy.md` ("Headless, next to a project"):

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
      CLAUDIO_URL: http://claudio:8797   # allowed by D10
```

Then, once: `docker compose exec claudio claudio login`.

On `apps-1` (the owner's infra repository): shipcast moves with its web / worker / heavy split
(from 2026-10-30) and runs a day on its own Claudio; trading-bot gets one on `127.0.0.1:8797` (host
network) and keeps its calls; then `stacks/claudio` is removed. Nothing is migrated from it.

### Release

`.github/workflows/image.yml` builds the `headless` target too, tagged `<version>-headless` and
`headless`. No signed server bundle for it (D6). The release note lists the behaviour changes of every
profile: D9 (a missing `cwd` is refused) and D8 (the `/v1` conversation key). Shipcast is told which
version carries D7, D8, D10 and D11.

## Tasks

1. **Inventory** (read only): every route against D1 with its exact path; every started subsystem;
   the internal callers of `ChatManager.begin` that rely on it creating the `cwd` (D9); whether chat
   deletion removes the CLI's session file (D15); the routes `/api/auth` and `/api/security` the token
   needs. Recorded here.
2. **Profile**: `CLAUDIO_PROFILE`, the route-by-route registration, the core checks, `profile` in
   `/api/system`, D4's start checks, D6's launcher rule, D10. Tests: `404` on `/api/work-items`,
   `/api/terminals`, `PATCH /api/chats/:id`, `POST /api/chats/:id/resume`, `PUT
   /api/config/tool-presets/:id` and `/`; the D1 routes served; dropped subsystems never started;
   `Host: claudio` accepted in headless and refused in full; a start without a spend cap refused; an
   overlay in `/data/app` not booted.
3. **Readiness and the command**: `/api/ready` (D11), `claudio login` and `status` against a fake
   server (every sign-in state, cancel, bad token, server down).
4. **Workspaces** (D7): root, store, routes, fetch, extraction, sweeper. Tests: each refusal code with
   archives built for them (symlink, hard link, `..`, absolute path, a PAX long name with `..`, a
   `.git` folder, oversize, too many entries, a gzip bomb, the total cap, two concurrent creations at
   the count cap); a URL on a host not allowed; a redirect to one not allowed; a name resolving to
   `127.0.0.1`; the URL absent from logs and errors; the single top-level directory; TTL and `DELETE`
   with a running chat; `X-Claudio-Cwd` and `cwd` naming a workspace refused; a real GitHub tarball of
   a small public repository, once, by hand.
5. **Confined API chat** (D14) and D9: the launch (`confine`, settings, strict MCP, no API token, git
   environment), `dontAsk` only, the stored policy, the refusals (`claudioMcp`, `mcp`, bare `Bash`, a
   write tool in a workspace, another permission mode), attachments by file. Tests: a workspace whose
   tarball carries `.claude/settings.json` with a `SessionStart` and a `PreToolUse` hook, a
   `permissions.allow` and a `.mcp.json`: nothing of it runs or applies (with the real CLI, once, by
   hand, besides the unit test of the arguments); the chat's environment has no `CLAUDIO_*`; D9 at a
   cold `/v1` resume after the workspace is gone (`410`).
6. **`declared-tools` guard** (D14.5): the rule and its corpus.
7. **`/v1` parity and typed run errors** (D8, D16): the headers on both endpoints, the key,
   `409 policy_mismatch`, the default of no tools in headless, a one-shot retry starting a new chat,
   and each D16 code whole and streamed on both endpoints (`max_turns`, `max_budget`, `tool_blocked`,
   `no_structured_output`).
8. **Retention** (D15): the sweeper and the session-file deletion.
9. **Image and release**: the stage, `cli.mjs` in the bundle, the workflow. Checked by running it: a
   sign-in with the real CLI, a workspace from a real tarball, a `/v1` structured turn in it with
   declared tools, a blocked read of `/data/auth.json` through a declared `Bash(cat *)`, a `429` at the
   spend cap, trading-bot's request answered.
10. **Docs**: `deploy.md`, `configuration.md` (`CLAUDIO_PROFILE`, `CLAUDIO_WORKSPACES_DIR`,
    `CLAUDIO_WORKSPACE_HOSTS`, caps, `CLAUDIO_CHAT_BUDGET_USD`, `CLAUDIO_CHAT_RETENTION_DAYS`),
    `rest-api.md` and `routes.ts` (every new route with summary and tag), `openai-compatible-api.md`
    (headers, key, policy), `guards.md` (`declared-tools`), `security-model.md` (the confined API
    chat), `workspaces.md` (new), a decision record for D14, this plan's Outcome, `status.md`.

`packages/shared/src/types.ts` gains the workspace types, `workspaceId`, `profile` and the readiness
answer; the OpenAPI schemas are regenerated (`pnpm --filter @claudio/api openapi:schemas`).

## Measures

Before (2026-10-28, `0.10.0` on `apps-1`): image 1.43 GB, container 186 MiB, 30 processes. After:
the same readings for a headless container with one finished workspace chat, in the Outcome.

## Risks

- **D9 and D8 change behaviour for every client**, in every profile: a missing `cwd` is refused, and
  the `/v1` key now includes the per-call policy. The release note says so; trading-bot sends no `cwd`
  and shipcast moves to workspaces.
- **D14 can block a command a consumer expected to run.** Every block names the subcommand or path and
  what was missing, so the fix is a declared rule; commands that need a variable or a substitution
  cannot be declared and must be written another way.
- **Archive handling is the new attack surface.** Mitigated by the caps, the entry rules, the host
  allowlist, the address guard and task 4's hostile archives.
- **The confinement is the CLI's.** `--restricted`, `--tools=` and `--setting-sources=` are documented
  flags Claudio already relies on for confined runs; a CLI release that changed them would surface in
  task 5's argument tests and in the pinned CLI's recordings.
- **Two Claudios on one Claude subscription** share its usage limits, as the one instance does today.

## Review (2026-10-28)

An independent review of the plan's first draft, checked against the code, found what D14, D15 and
the reworked D1, D4, D6, D7, D8 and D9 now close: settings and hooks of a workspace's repository
loaded by an unconfined chat; path arguments of a declared Bash rule reading credentials; a chat's own
API token reaching back into Claudio; an unfixed permission mode (`bypassPermissions` by default in the
image, `PATCH` on a live chat); a hostile `.git`; workspaces nameable as a `cwd` and a start sweep that
could reach projects; the `/v1` key ignoring the new headers; a continuation recreating an expired
workspace's folder; whole plugins registered where routes were meant; attachments and the full
profile's chats broken by the first form of D12; missing caps on concurrent creation, the body parser
and the URL's token in logs; no spend cap by default; and no retention for chats that hold repository
content.

## Open questions

None. Both consumers answered on 2026-10-28, the review's findings are in the decisions, and the owner
approved the result the same day.

## Related

[[openai-compatible-api.md]] · [[plans/openai-compatible-api.md]] · [[plans/container-polish.md]] · [[guards.md]] · [[plans/guards.md]] · [[security-model.md]] · [[decisions/claude-sign-in-paste-code.md]] · [[decisions/container-owner-token.md]] · [[decisions/container-in-app-updates.md]] · [[deploy.md]] · [[rest-api.md]] · [[cli-surfaces.md]] · [[status.md]]
