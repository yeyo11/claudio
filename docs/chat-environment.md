---
created_at: 2026-09-27T12:00:00Z
updated_at: 2026-10-18T20:00:00Z
tags:
    - chats
    - api
    - desktop
    - decision
    - fix
    - security
---
# A chat knows which wrapper runs it

Every chat Claudio starts gets these variables in its environment:

- `CLAUDIO_API_URL`: the REST API of the wrapper that spawned it, with the real port it bound (for
  example `http://127.0.0.1:34331/api`). `startServer` sets it on the runtime once it listens.
- `CLAUDIO_CHAT_ID`: the chat's own id.
- `CLAUDIO_API_TOKEN`: a credential of the chat's own for that API, minted for each process (each
  turn) whenever `CLAUDIO_API_URL` is set. Send it as `Authorization: Bearer $CLAUDIO_API_TOKEN`.
  Under `mode: none` nothing reads it.

## Why

On one machine there are often two wrappers: the desktop app (loopback, a port it keeps between
launches, data in `~/.config/Claudio/data`) and a dev server from a checkout (`8797`, data in the
checkout's `data/`). A chat in the desktop app asked to launch an orchestration called
`localhost:8797` from habit. The orchestration ran, on the dev server, and never appeared in the
app the person was looking at. Nothing told the agent where its own wrapper was.

## Decisions

- **The address comes from the listening server, not from config.** A port asked for is only a
  preference (`listenOn` falls back to a free one), so only the bound address is right.
- **An inherited value is removed.** A wrapper started from a chat of another wrapper inherits that
  chat's `CLAUDIO_API_URL`. Its own chats must not see it: before the API listens, they get none.
- **The chat gets its own token, never the owner's** (CW-10, replacing "no credential is passed").
  With the guard on, a chat with a URL and no credential got `401` on every call, and one had to read
  `wrapper.db` to diagnose the board. Handing it the owner's token would widen what a prompt
  injection reaches, so `spawnProcess` mints a fresh token per process instead
  (`packages/core/src/security/chat-tokens.ts`):
  - 32 random bytes in base64url with the prefix `agc_`, held in memory only as its SHA-256 beside
    the chat id, the process and the mint time; never in `auth.json`, SQLite or a log.
  - Revoked when its own process exits or fails to spawn (keyed by that process's token, so a late
    exit of an earlier process leaves the current one alone), on `stopAll`, on a restart by
    construction, and after `CHAT_TOKEN_MAX_AGE_MS` (24 h) at most.
  - Accepted in `token` and `oidc` modes only from a loopback peer, on a loopback `Host`, with no
    `Forwarded`, `X-Forwarded-For` or tunnel client-IP header: the tunnel arrives from 127.0.0.1 too.
    Anything else answers the same `401` as a wrong token and counts toward the wait.
  - It cannot administer the guard: `PUT /api/security/auth`, `POST|DELETE /api/security/token`,
    `POST /api/tunnel/start` and `PUT /api/tunnel/settings` answer `403`, and so do the tool guards'
    `PUT /api/settings/guards` and `POST /api/guards/check`. About twenty other groups of routes
    are refused to it the same way (accounts, sign-ins, rotation, memory, lessons, evals, merges,
    reviews, the terminal, collaborators and more): the reasons are in
    [security-model.md](security-model.md), the full list in the `CHAT_FORBIDDEN*` sets of
    `apps/api/src/security.ts`. Read-only and the host allowlist apply as to the owner.
  - Writes are audited as `chat:<chatId>`, also under `mode: none`: there the token grants nothing
    (the mode already allows everything) and only labels the request, so a wrong or missing one stays
    `local` and is never refused (CW-17, `apps/api/src/security.ts`). The work-item routes turn that
    label into an agent actor with the cause `chat.api-write`
    ([work-items.md](work-items.md#a-write-from-a-chat)).
  - An inherited `CLAUDIO_API_TOKEN` is always removed, like the URL: it is another wrapper's.
  - MCP servers the CLI starts inherit it, which is how the assistant's server calls the API. Claudio's
    own server (`claudio`) is given it in its config file as `${CLAUDIO_API_TOKEN}`, expanded by the CLI
    ([claudio-mcp-server.md](plans/claudio-mcp-server.md)). The global assistant chat uses it for its
    read and write tools ([claudio-assistant.md](claudio-assistant.md)).

  The full specification is [chat-api-token.md](plans/chat-api-token.md); the decision is §2 of
  [flow-start-and-chat-token.md](plans/flow-start-and-chat-token.md).
- **Nothing is added to the system prompt.** The variable is there for whoever looks. This repo's
  `CLAUDE.md` tells agents to use it; other projects do not call Claudio's API.

## What a child gets, and what it never gets

The server is configured through its own environment, and a process that inherits it is configured
as the server. On 2026-10-18 a chat had all of these from the desktop app: `PORT`,
`CLAUDIO_WEB_DIST`, `CLAUDIO_DATA_DIR`, `CLAUDIO_WORKSPACE_DIR`, `CLAUDIO_VERSION`,
`CLAUDIO_DISTRIBUTION`, `CLAUDIO_MCP_ENTRY` and `CLAUDIO_GUARD_ENTRY`. A worker ran `pnpm dev` in
its worktree; the dev server read the desktop's data directory and port from them, opened the
owner's live data and closed the owner's tunnel.

Now every process Claudio starts for an agent or a person gets the inherited environment through
`withoutServerEnv` (`packages/shared/src/server-env.ts`):

| Variable | A chat's Claude Code (and its hooks, guards and MCP servers) | Other children |
| --- | --- | --- |
| `CLAUDIO_API_URL` | set by `spawnProcess` to this wrapper's API, or removed while it is not listening | passed through if the server had one |
| `CLAUDIO_API_TOKEN` | minted for the process; an inherited one is always removed | passed through if the server had one |
| `CLAUDIO_CHAT_ID` | the chat's id | passed through if the server had one (it was started from a chat, and so are they) |
| `CLAUDIO_AGENT_RUN` | not set | set by a verification command of an orchestration, which the terminal refuses by it |
| `CLAUDIO_FAKE_CLI_*` | passed through: the switches of the browser suite's fake Claude Code | passed through |
| any other `CLAUDIO_*` | never | never |
| `PORT`, `HOST` | never | never |

"Other children" are the setup and sign-in CLIs, the accounts' probes, gh, glab and youtrack-app,
and the project's verification and eval commands. The terminal's shell is stricter: it gets no
`CLAUDIO_*` at all, and no `PORT` or `HOST` (`terminals/env.ts`). Claudio's own MCP server is
handed `CLAUDIO_VERSION` and `CLAUDIO_MCP_TOOLSETS` in its config file, not through the environment.

`CLAUDIO_*` is an allow-list: a variable the server adds later stays out of every child without
anyone remembering to drop it. A child that runs a Claudio of its own (`pnpm dev` in a worktree) gets
the checkout's own `data/` and `:8797`, and a second server on a data directory a running one holds
stops before it touches it ([security-model.md](security-model.md#one-server-per-data-directory)).

## Guards

A chat in a project that opted in (*Guards in this project's chats*) runs with [[guards]]. Its
`TMPDIR` points at a scratch folder of the run, `rm -rf /tmp/...` is blocked, and the header shows a
"Guards" tag (warn "Observe", bad "Guards not running"). A block appears as a "Guard blocked" line in
the transcript. A chat of a project that did not opt in has no guard.

Related: [[desktop]], [[pinned-chat-rotation]], [[plans/chat-api-token.md]], [[plans/flow-start-and-chat-token.md]].
