---
created_at: 2026-10-28T21:00:00Z
updated_at: 2026-10-29T12:00:00Z
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

Status: **built** on 2026-10-29 by orchestration `f354f179`, every decision D1–D16 in code, not yet
released; the checks with the real CLI are the owner's ([Outcome](#outcome)). Decisions taken by the
owner on 2026-10-28. The design is the
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
  `codeload.github.com`; shipcast resolves GitHub's `/repos/{o}/{r}/tarball/{ref}` redirect on its
  own side and passes the `codeload` URL, so no GitHub token ever reaches Claudio, as its second reply
  confirmed on 2026-10-28); at most three redirects, each to an allowed host; every resolved address public, through the address guard of
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

## Contracts

Written here so the first-stage tasks start in parallel; the task that owns a contract may refine a
name, never the shape, and says so in its result.

**Shared types** (`packages/shared/src/types.ts`; each owner adds its own part):

```ts
export type ServerProfile = 'full' | 'headless';                 // profile
// SystemInfo (GET /api/system) gains `profile: ServerProfile`  // profile
export type ReadyReason = 'cli-missing' | 'signed-out' | 'sign-in-expired' | 'starting';
export interface ReadyStatus { ready: boolean; reason?: ReadyReason }   // profile

export interface Workspace {                                   // workspaces
  id: string;                       // `ws_` + random
  source: 'url' | 'upload';
  host: string | null;              // the URL's host; never the URL
  bytes: number; files: number;
  createdAt: string; lastUsedAt: string; expiresAt: string;
  state: 'creating' | 'ready' | 'removing';
}

export interface ApiChatPolicy {                               // confined-chat
  workspaceId: string | null;
  allowedTools: string[];
  maxTurns: number | null;
  maxBudgetUsd: number;
  schema: boolean;
}
// ChatStartOptions gains `workspaceId?: string`; a chat's view gains `policy: ApiChatPolicy | null`
```

**Core seams.** `core.workspaces` (workspaces) exposes `resolve(id)` → the working directory of a
ready workspace, or throws a refusal with the codes of D7; `touch(id)`; `root`. `guards` exports one
builder from `packages/core/src/guards/declared.ts` that turns an `ApiChatPolicy`, the working
directory and the attachment paths into what a launch passes to arm the `declared-tools` rule;
confined-chat calls it. `core.profile` (profile) is the `ServerProfile`.

**Routes.** `POST /api/workspaces` (`{ url }` JSON or an `application/gzip` body) → `201 Workspace`;
`GET /api/workspaces/:id` → `Workspace`; `DELETE /api/workspaces/:id` → `204`; `GET /api/ready` →
`200 ReadyStatus` or `503 ReadyStatus`. REST refusals carry kebab-case codes, `/v1` snake_case ones
(D16).

## Tasks

One orchestration, every task on `opus`, each in its own worktree. Four stages in series:
`{profile, cli-image, workspaces, guard} → confined-chat → v1 → {review, docs}`.

| Task | Depends on | Builds | Owns (others touch these only where named) |
|---|---|---|---|
| `profile` | — | D1 (the allowlist and its enforcement), D2, D4, D6, D10, D11 (`/api/ready`), D15, plan task 1's inventory | `apps/api/src/app.ts`, `apps/api/src/security.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/system.ts`, a new `apps/api/src/headless.ts` (the D1 allowlist, the one source of truth), `packages/core/src/index.ts` (subsystem gating), `packages/core/src/paths.ts`, `packages/core/src/launcher/`, a new retention sweeper in `packages/core/src/`, their tests |
| `cli-image` | — | D3 (`claudio login`, `status`, `--json`), the image stage, the release build | a new `apps/api/src/cli/`, `apps/api/scripts/bundle.mjs`, `docker/Dockerfile`, `docker/entrypoint.sh`, `.github/workflows/image.yml`, their tests |
| `workspaces` | — | D7 whole | a new `packages/core/src/workspaces/`, a migration in `packages/core/src/db.ts`, a new `apps/api/src/routes/workspaces.ts` and its one registration line in `app.ts`, `package.json` of core if a tar dependency is added, their tests |
| `guard` | — | D14.5 (`declared-tools`), the corpus of the Design section | `packages/core/src/guards/`, `packages/core/test/guards-*` |
| `confined-chat` | `workspaces`, `guard` | D14 (1–4, 6–8), D9, `workspaceId` on `POST /api/chats`, D16's REST codes | `packages/core/src/chats.ts`, `live-chat.ts`, `chat-service.ts`, `packages/core/src/providers/claude-code/args.ts`, `apps/api/src/routes/chats.ts`, `apps/api/src/routes/tool-presets.ts`, their tests |
| `v1` | `confined-chat` | D8, D16 on `/v1`, the headless default of no tools | `apps/api/src/routes/openai.ts`, `apps/api/src/routes/openai-tools.ts`, `packages/core/src/openai/`, their tests |
| `review` | all the above | Reviews the merged design against this plan: every D1–D16 present, the leak review's findings closed, no route outside the allowlist in headless | findings and small fixes only |
| `docs` | all implementation tasks | Plan task 10: every doc it lists, the D14 decision record, this plan's Outcome, `status.md` | `docs/` |

Every task that adds or changes a route adds its summary and tag in `apps/api/src/openapi/routes.ts`
and its row in `docs/rest-api.md`, and regenerates the schemas when it changes `types.ts`.

**Patterns to follow** (read at these places by the plan's author; open the file and find them by
name):

- Route registration: `apps/api/src/app.ts:210`; an unauthenticated route: the `OPEN` set,
  `apps/api/src/security.ts:18`; the host check: `apps/api/src/security.ts:871`.
- A route answering health: `apps/api/src/routes/system.ts:23`.
- An environment setting refused when invalid: `spendCapFromEnv`, `packages/core/src/paths.ts:198`.
- A SQLite table added by migration: `openai_conversations`, `packages/core/src/db.ts:1411`.
- An outbound fetch with the address guard: `isPublicAddress` and `fetchImage`,
  `packages/core/src/openai/fetch-image.ts:54` and `:124`.
- A confined launch: `--restricted`, `--tools=`, `--setting-sources=`,
  `packages/core/src/providers/claude-code/args.ts:47`; confinements built at
  `packages/core/src/index.ts:2899` and `packages/core/src/claudio-mcp.ts:86`.
- The chat token handed to a process: `packages/core/src/chats.ts:1863`; the `cwd` created at start:
  `chats.ts:1014`.
- `/v1`'s permission mode and its `cwd` check: `apps/api/src/routes/openai.ts:255` and `:234`.
- Tool preset routes: `apps/api/src/routes/tool-presets.ts:9`.
- The bundle entry points: `apps/api/scripts/bundle.mjs:26`; the image's runtime stage:
  `docker/Dockerfile`, stage `runtime`.
- Guards: no line was opened for this plan; read `docs/guards.md`, then `packages/core/src/guards/`
  (`command.ts`, `files.ts`, `paths.ts`) and `packages/core/test/guards-corpus.ts`.
- Tests: `apps/api/test/openai.test.ts`, `apps/api/test/security.test.ts`,
  `packages/core/test/chats.test.ts`, `packages/core/test/claude-args.test.ts`,
  `packages/core/test/guards-corpus.test.ts`, `packages/core/test/launcher.test.ts`.

**Rules for every task.**

- Read this plan whole first, then `CLAUDE.md` and `CONTRIBUTING.md`. Do exactly your task, touching
  only what its row owns; the plan wins over older docs. Re-verify facts in the code before relying
  on them.
- TypeScript strict, no `any`, `noUncheckedIndexedAccess`; English for code, comments, docs and
  commits; Conventional Commits with a body saying why; never push.
- Run `pnpm typecheck` and the full test suites of the packages you touch
  (`CI=1 pnpm --filter <pkg> test`, wrapped in `timeout`). Never run `pnpm e2e`.
- Never start a Claudio server with the inherited environment (it is the owner's live app); if one is
  needed, start it isolated with `env -u CLAUDIO_DATA_DIR -u PORT -u CLAUDIO_WEB_DIST -u
  CLAUDIO_API_URL -u CLAUDIO_API_TOKEN`, a temp data dir and free ports, and kill its process group
  after. Never spend tokens on a real Claude turn: tests drive the fake CLI. The steps the plan marks
  "once, by hand" with the real CLI are the owner's, after the merge.
- Never touch `/home/yeyo/Escritorio/shipcast` or `/home/yeyo/Escritorio/trading-bot`.

### Checklist (what the tasks above cover)

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

## Outcome

Built on 2026-10-29 by orchestration `f354f179`, one worktree per task (`profile`, `cli-image`,
`workspaces`, `guard`, then `confined-chat`, then `v1`, then `review` and `docs`), merged into one
branch. Not released yet; the release note comes from the commits.

### What was built

- **Profile** (D1, D2, D4, D6, D10, D11, D15): `CLAUDIO_PROFILE`, the allowlist
  `apps/api/src/headless.ts` and the subsystem table `packages/core/src/subsystems.ts` (both recorded
  in the [Inventory](#inventory)), the start refusals (`headlessStartProblems`), `profile` on
  `GET /api/system`, `GET /api/ready` (`core.readiness()`), the launcher ignoring overlays, the
  single-label `Host`, and the retention sweeper `packages/core/src/chat-retention.ts`.
- **The command and the image** (D3): `claudio login` and `claudio status [--json]` in
  `apps/api/src/cli/`, bundled as `cli.mjs`; the `headless` stage of `docker/Dockerfile`, before
  `runtime`; `image.yml` builds and tags it.
- **Workspaces** (D7): `packages/core/src/workspaces/`, the `workspaces` table, the three routes
  ([workspaces.md](../workspaces.md)).
- **The `declared-tools` guard** (D14.5): `packages/core/src/guards/rules/declared-tools.ts`, the
  builder `guards/declared.ts` and `DECLARED_CORPUS` ([guards.md](../guards.md#declared-tools-the-confined-api-chat)).
- **The confined API chat** (D14 1–4, 6–8) and D9: `packages/core/src/confined-chat.ts`,
  `ChatService.createConfined` and its resume, `workspaceId` and `policy` on chats, `cwd-missing`
  ([security-model.md](../security-model.md#the-confined-api-chat),
  [the decision](../decisions/confined-api-chat.md)).
- **`/v1`** (D8, D13, D16): the four headers, the policy in the conversation key (seed version 2),
  `409 policy_mismatch`, the typed `422` run errors whole and streamed, the start refusals in OpenAI's
  shape ([openai-compatible-api.md](../openai-compatible-api.md)).

### Measures

The headless image measured **648 MB** (cli-image, 2026-10-29), against 1.43 GB for 0.10.0: over the
500 MB goal. The Claude Code 2.1.302 binary alone is 273 MB and the `node:26-bookworm-slim` base
about 245 MB, so the goal cannot be reached on this base; `git` and the `perl` it pulls in add about
90 MB. The container's memory and process count with a finished workspace chat were not measured:
no task ran the image's server or a real turn.

### What differs from the plan

- **D1 is enforced by hiding, not by registering route by route.** Every plugin still registers its
  routes; in headless an `onRoute` hook turns each one outside the allowlist into a `404 route not
  found` that runs before its body parser, hooks or handler, and leaves it out of the OpenAPI
  document. `/api/auth` is dropped whole; `/accounts/refresh`, `/accounts/settings` and
  `/accounts/policies` stay for rotation; `GET /uploads/:id` is dropped. The supervisor does not run
  in headless.
- **Every `/v1` chat is a confined API chat, in both profiles**, not only in headless or a workspace.
  Without declared tools it has none in headless and the app's default preset in the full profile.
- **D14.2: a `/v1` chat with client tools runs in `manual`**, with its client-tool session as the
  permission host, since `dontAsk` would deny the client's calls before the session could hold them.
  The effective policy is the same; `review` was asked to validate it.
- **Workspaces** gained two refusal codes, `workspace-timeout` (`408`) and `workspace-download-failed`
  (`502`). A `DELETE` while creating is `409`, of one already removed `204`; a removed id answers
  `410` for 30 days. The tar reader is Claudio's own over `node:zlib`. Outside the image the root
  defaults to `workspaces` beside the data directory.
- **The guard's choices**: `cd`, `pushd` and `popd` need no rule (their target is checked as a path);
  leading variable assignments are blocked except `LANG`, `LC_*`, `TZ`, `NO_COLOR`, `TERM`,
  `COLUMNS`; only the wrappers Claude Code strips itself pass undeclared; interpreters such as `awk`
  are blocked even when declared. Shipcast's `git ls-files | grep | head` needs `Bash(git ls-files *)`,
  which the plan's rule list lacks. `GuardRuleId` gained `declared-tools`, kept out of the switchable
  ids.
- **D15** needed no fix: deleting a chat already removed its session file and sidecar folder.
- **The image** keeps `curl` (the healthcheck uses it). Its tag suffix also gives the shorter version
  tags, `edge` and `sha` a `-headless` copy. `cli.mjs` also lands in the signed server bundle, which
  is harmless. `claudio status` reads `GET /api/accounts` too, for the last usage reading.
- **D9**: the orchestrator now creates its task's folder itself, which `begin` used to.

### What is not done

- **The checks with the real CLI**, the owner's after the merge (Checklist 4, 5 and 9): a sign-in in
  the image, a workspace from a real GitHub tarball, the caps against a large real repository, the
  hostile workspace (hooks, `permissions.allow`, `.mcp.json`) with the real CLI, a `/v1` structured
  turn in a workspace with declared tools, a blocked read of `/data/auth.json` through a declared
  `Bash(cat *)`, a `429` at the spend cap, trading-bot's request; whether `--tools` accepts
  `StructuredOutput`; and the `/v1` client-tool flow in a confined chat.
- **The after measures** of the container (memory, processes).
- **No browser spec** was written or run for this plan; the API and core suites cover it.
- **Follow-ups found on the way:**
  - the start warning for a server with no account still says to sign in under Settings
    (`apps/api/src/server.ts`); in headless it should name `claudio login`;
  - `apps/api/test/headless.test.ts` still allows the workspaces routes to be missing, from before
    their plugin existed;
  - after a restart a confined chat cannot read by path the attachments of earlier turns, and a file
    that is neither an image nor a PDF, sent later to a live process, is refused;
  - what the CLI keeps per session outside `projects/` (`todos/`, `file-history/`, `session-env/`,
    `shell-snapshots/`, `debug/`) is not removed by retention;
  - `docs/openai-compatible-api.md` links to this plan for workspaces; it should link to
    [workspaces.md](../workspaces.md).
- **The move on `apps-1`** (shipcast and trading-bot each on its own Claudio, then `stacks/claudio`
  removed) and telling shipcast which release carries D7, D8, D10 and D11 wait for the release.

## Inventory

Plan task 1, recorded by the `profile` task on 2026-10-28 against the code of its branch. The
allowlist is `apps/api/src/headless.ts` (`HEADLESS_ROUTES`, plus the `/api/v1/` and `/docs`
subtrees) and the subsystem table is `packages/core/src/subsystems.ts` (`SUBSYSTEMS`). Both are the
source of truth; this section says why.

### Routes

How it is enforced: every plugin still registers its routes. In headless an `onRoute` hook
(`enforceHeadless`) turns each route outside the allowlist into one whose own `onRequest` answers
`404 { error: 'route not found' }` before its body parser, hooks or handler run, with `schema.hide`
so the OpenAPI document leaves it out. A `HEAD` is judged as its `GET`, and an unregistered path
answers the same body. The websocket plugin and `fastifyStatic` are not registered, so there is no
web UI and no socket. `apps/api/test/headless.test.ts` enumerates every registered route and checks
it against the allowlist.

Kept, with their exact paths (Fastify's names, under `/api`):

| Routes | Plugin | Why |
|---|---|---|
| `GET /health`, `GET /ready` | `system.ts` | Probes, unauthenticated (`OPEN` in `security.ts`); `/ready` is new (D11) |
| `GET /system` | `system.ts` | Carries `profile` |
| `GET /chats`, `POST /chats`, `GET /chats/:id`, `POST /chats/:id/messages`, `POST /chats/:id/stop`, `DELETE /chats/:id` | `chats.ts` | The consumers' calls (D14) |
| `POST /uploads` | `uploads.ts` | A chat's attachments. `GET /uploads/:id` and `/uploads/:id/content` are dropped: the chat reads its attachment by path (D14.6) and the caller already has the bytes |
| `GET`, `POST`, `DELETE /openai/client-tools/:id/mcp` | `openai-tools.ts` | The `/v1` client-tool stub the CLI calls |
| `/v1/*`: `GET /v1/models`, `GET /v1/models/:id`, `POST /v1/chat/completions`, `POST /v1/responses`, `GET` and `DELETE /v1/responses/:id`, `GET /v1/responses/:id/input_items` | `openai.ts` | D8, under D14 |
| `POST /workspaces`, `GET /workspaces/:id`, `DELETE /workspaces/:id` | `workspaces.ts` (task `workspaces`) | D7; listed before the plugin exists, so the test checks their registration only once it does |
| `GET /providers`, `GET /providers/:id/models` | `providers.ts` | The model list (`claude-code` is the one id) |
| `GET /config/tool-presets` | `tool-presets.ts` | Read only (D14.8) |
| `GET /accounts`, `POST /accounts`, `POST /accounts/refresh`, `POST /accounts/:id/refresh`, `POST /accounts/:id/login`, `GET /accounts/logins/:id`, `POST /accounts/logins/:id/code`, `DELETE /accounts/logins/:id`, `DELETE /accounts/:id` | `accounts.ts` | D3: list, add, sign-in with its code, state and cancel, refresh, remove |
| `GET` and `PUT /accounts/settings`, `GET` and `POST /accounts/policies`, `PUT` and `DELETE /accounts/policies/:id` | `accounts.ts` | The rotation settings and policies: several accounts and rotation stay |
| `GET /security/auth`, `POST /security/token` | `security.ts` | What the token needs: the guard's mode, and replacing a token, the first-run one included ([container-owner-token](../decisions/container-owner-token.md)) |
| `GET /openapi.json`, `/docs` | `openapi/plugin.ts` | Outside `/api`; they describe only what is served, behind the token |

Dropped, with the reason:

- `/auth`, `/auth/credentials`, `/auth/verify`: a second way to hand Claude Code a credential;
  sign-in is the accounts' paste-code flow (D3), and `/system` already carries `auth`.
- `PUT /security/auth`, `DELETE /security/token`, `/security/allowed-hosts/claim`, `/audit`: they
  could open the guard (D4 forbids `none` off loopback) or serve the audit screen; allowed hosts come
  from `CLAUDIO_ALLOWED_HOSTS` and D10.
- `POST /accounts/token`, `PATCH /accounts/:id`, `/accounts/:id/models`, `/accounts/model-fallbacks*`,
  `/accounts/usage-history`, `/accounts/events`: not in D1's list. The token sign-in is legacy
  (`CLAUDE_CODE_OAUTH_TOKEN` stays an environment variable); the rest feed Settings screens.
- `/providers/refresh`, `/providers/settings`, `/providers/:id`, `/limits/waits*`: Settings and the
  rotation's wait screen; readiness and the model list read the detector without them.
- Every other route of `chats.ts`: resume, fork, `PATCH`, account switch, wait, interrupt, hint,
  command cancel, `mcp`, `claudio-mcp`, context and compaction, notes, permissions, logs, stream,
  export, changes, search, checklist, subagents, tasks, workflows, environments, `/usage*` (D1, D14.4).
- `/system/*` (CLI version and install, release, server update, storage, load, processes, history)
  and `/overview`: D6, and screens.
- Whole plugins with nothing kept: projects, work items, team, evals, flow, documents, project docs,
  assistant, events (SSE), orchestrations, config (MCP, plugins, agents, memory, settings files),
  app settings, settings state, spend (the cap is the environment's), dashboard layout, tunnel,
  plugins, connectors, memory, journal, lessons, schedules, supervisor, decisions, change requests,
  hosts, trackers, setup, push, webhooks, terminals, collaborators, guards (the settings screen; the
  guard itself runs) and server update.

### Subsystems

Gated through `Core.startSubsystem` (`packages/core/src/index.ts`, `apps/api/src/server.ts`), which
records what started in `core.started`; `packages/core/test/profile.test.ts` checks both profiles.

| Subsystem | Headless | Why |
|---|---|---|
| `spend` | kept | The daily cap D4 requires |
| `healthMonitor` | kept | Live chats' health signals, which the chat view carries |
| `rotation` (start and recover) | kept | Several accounts and rotation stay (D3) |
| `accountsWatch` | kept | Usage caches and models lists: sign-in, rotation and the model list |
| `guardSelfTest` | kept | The `declared-tools` rule runs in the guard (D14.5) |
| `decisionPruning` | kept | A timer trimming old decision rows, nothing else |
| `transcriptWarmRead` | kept | The first `GET /api/chats` does not wait for every transcript |
| `providersWatch` (server) | kept | `/ready`, `/health` and `/system` answer from it |
| `chatRetention` | headless only | D15 |
| the workspace sweeper | kept | Started by task `workspaces` |
| `sampler` | dropped | The Machine page's charts (`/system/history` is not served) |
| `decisionResolvers` | dropped | Outcomes of the flow's, orchestrations' and reviews' decisions; none run |
| `supervisor` (woken by the health monitor) | dropped | A hint is text the caller did not send (D14) |
| `changeWatcher` | dropped | The orchestrations' Changes view |
| `lessonQueue`, `lessons` | dropped | Mining spends model turns on transcripts that hold repository content |
| `pullRequestWatcher`, `codeHostsWatch` (server) | dropped | No gh or glab in the image, no code-host routes |
| `schedules` | dropped | No schedule routes |
| `collaborators` | dropped | No iroh in the image |
| `terminalStrays` | dropped | No terminals |
| `serverUpdates`, `releaseWatch` (server) | dropped | D6 |
| `cliVersionWatch` (server) | dropped | The image pins the CLI, and no install route is served |
| `orchestrationRecovery`, `evals`, `flow`, `assistant` | dropped | None of them is served |
| `tunnel` (server) | dropped | `CLAUDIO_TUNNEL=off`; the host's proxy serves the port |

Constructed in both profiles but not started on their own: the stores, the push service (an
observer of the bus, with no subscription to send to in headless), the permission broker, the
sessions watcher; `runtime.restore` runs in both, so the chats come back after a restart.

### D9: who relies on `ChatManager.begin` creating the `cwd`

`begin` (`packages/core/src/chats.ts:1013`) is reached through `ChatManager.start` and `fork`. Their
callers, and the directory each starts in:

- `ChatService.create` and `fork` (`chat-service.ts:778`, `:898`): the person's or the API's `cwd`,
  else the default working directory. This is the case D9 refuses; the default directory is created
  by `loadConfig` at server start.
- `Core.runWorkflow` (`index.ts`): `request.cwd` as given, else the default; it relied on `begin` for
  a missing one, and is refused under D9 like a chat.
- The orchestrator (`orchestrator.ts:3187`): the planner runs in `resolve(req.cwd ?? workspaceDir)`,
  tasks in `join(worktree, subdir)` or the integration directory. Git makes the worktrees first, but
  a task's `subdir` inside one, and a planner's missing `req.cwd`, were created by `begin`. Under D9 the
  orchestrator has to create a task's `subdir` itself and refuse a missing planner `cwd` like a
  chat's; that is task `confined-chat`'s, which owns `begin`.
- One-shot chats (`one-shot.ts`: the decision engine's CLI provider, the lesson miner) and
  `Core.verifyAuth`: no `cwd`, so the default directory, which exists from the start.
- `Core.askSupervisor` (`question.cwd`, the worker's own directory), `project-docs.ts:299`, and the
  eval runner (`evals/runner.ts:873`, `lane.path`, made by the runner) with its judge: directories
  that exist before the chat starts.

### D15: does deleting a chat remove the CLI's session files

Yes, for what lives under `~/.claude/projects`, so nothing had to be fixed. `DELETE /api/chats/:id`
calls `ChatService.remove` (`chat-service.ts:997`), which calls `SessionStore.deleteSession`
(`sessions.ts:909`): it removes `<projects>/<dir>/<id>.jsonl` and its sidecar folder `<id>/`
(subagent transcripts, tool results), and then the chat's rows (`ChatManager.remove`,
`db.deleteChat`). Every account reads and writes one `projects/`, since an account's directory links
it to the default one (`packages/accounts/src/dirs.ts`, `HISTORY`), so no copy is left under another
account. A chat with a live process is refused (`409`), and the sweeper tries it again on its next
pass. Not removed, and outside D15's scope: what the CLI keeps per session elsewhere in its config
directory (`todos/`, `file-history/`, `session-env/`, `shell-snapshots/`, `debug/`). The retention
sweeper (`packages/core/src/chat-retention.ts`) runs once the chats are restored and then hourly, and
deletes through the same `ChatService.remove`.

### Contract refinements

- `core.profile` is the `ServerProfile`. `core.config.chatBudgetUsd` (`CLAUDIO_CHAT_BUDGET_USD`,
  default 1) and `core.config.chatRetentionDays` (`CLAUDIO_CHAT_RETENTION_DAYS`, default 30) are read
  in `loadConfig`; confined-chat applies the budget.
- `core.readiness()` answers the `ReadyStatus`; `GET /api/ready` sends it with `200` or `503`.
- `headlessStartProblems` (core) holds D4's three refusals; `startServer` throws with all of them.
- The launcher ignores overlays when `CLAUDIO_PROFILE=headless` or the image carries no keys, and
  writes nothing under `/data/app` then.

## Related

[[openai-compatible-api.md]] · [[plans/openai-compatible-api.md]] · [[plans/container-polish.md]] · [[guards.md]] · [[plans/guards.md]] · [[security-model.md]] · [[decisions/claude-sign-in-paste-code.md]] · [[decisions/container-owner-token.md]] · [[decisions/container-in-app-updates.md]] · [[deploy.md]] · [[rest-api.md]] · [[cli-surfaces.md]] · [[workspaces.md]] · [[decisions/confined-api-chat.md]] · [[configuration.md]] · [[status.md]]
