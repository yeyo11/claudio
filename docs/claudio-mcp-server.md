---
created_at: 2026-10-01T12:00:00Z
updated_at: 2026-10-17T18:00:00Z
tags:
    - mcp
    - assistant
    - chats
    - api
    - desktop
---
# Claudio's own MCP server

Claudio ships a small MCP server, named **`claudio`**, so a chat can look things up in the wrapper that
runs it: "how is AGN-12 going?", "why did the verification of orchestration 7 fail?". The CLI starts it
from a config file Claudio hands over with `--mcp-config`, and it calls the REST API at
`CLAUDIO_API_URL`. Its tools reach the CLI as `mcp__claudio__<tool>`: 16 read tools (CW-6), nine
write tools (CW-17, [below](#write-tools)) and seven reads of teammates' shared copies (R13,
[below](#teammates-shared-copies)). The spec is [plans/claudio-mcp-server.md](plans/claudio-mcp-server.md) (CW-6, epic
[plans/claudio-assistant.md](plans/claudio-assistant.md)).

It adds no screen and no route. The Claudio assistant's chat ([claudio-assistant.md](claudio-assistant.md))
is what hands it to a chat, through the helper below.

## The one rule

Claudio reaches Claude Code only through its CLI, and the CLI reaches Claudio through a tool Claudio
configured. The server makes HTTP calls only to `CLAUDIO_API_URL`, never to Anthropic, and uses no
Anthropic package. The MCP protocol (JSON-RPC 2.0 over stdio, one message per line: `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`) is written by hand in
`packages/mcp`, which has no runtime dependency apart from the types of `@claudio/shared`.

## The tools

Every read tool is a `GET` on a route that already exists. The client's `request` and `get` refuse any
other method; the write tools below go through `send`, the only way to write.

| Tool | Returns |
|---|---|
| `list_projects` | the projects |
| `get_overview` | the dashboard in one call, the usual first look |
| `get_board` | the work-item board, of a project or global; filters by status, type, priority, labels, assignee |
| `get_work_item` | one item by key (`AGN-12`, any case) or id, with its children, comments, history, links and flow runs, in one call |
| `list_orchestrations` | the orchestrations, newest first |
| `get_orchestration` | one orchestration with its tasks, verification and final report |
| `get_team` | a project's team |
| `list_flow_runs` | a project's flow runs, filtered by agent, role, status, item |
| `get_journal` | a project's journal |
| `list_documents`, `read_document` | a project's documents, and one file |
| `list_chats` | the chats, filtered by project, state, origin |
| `get_chat` | a chat's metadata, its last 20 transcript entries and what it waits on; never the export or the stream |
| `get_usage` | usage and its breakdown for a date range (today by default) |
| `list_providers` | the agent providers with their readiness, account and usage limit per window, as last detected (claude-swap's accounts are gone since providers phase 4) |
| `list_accounts` | the Claude accounts with their kind, plan, state and usage limit per account, from `GET /accounts` |

The names live in `packages/mcp/src/names.ts` (`CLAUDIO_MCP_SERVER`, `CLAUDIO_MCP_READ_TOOLS`); a test
keeps the catalogue in `tools.ts` equal to that list, and the allow list is built from it.

## Fields of the list tools

A list tool answers **only the fields a model needs to choose a row, and the id that fetches the rest**
(`packages/mcp/src/fields.ts`; the format plan is [plans/agent-wire-format.md](plans/agent-wire-format.md)). A
field that is null or absent is left out. The detail tools (`get_work_item`, `get_orchestration`,
`get_chat`, `read_document`, `get_overview`, `get_usage`) keep the route's shape.

| Tool | Row |
|---|---|
| `list_projects` | `id`, `name`, `key`, `path`, `modules`, `chatCount`, `lastActivity`, `exists` |
| `get_board` | per column `status`, `count`, `limit`, `overLimit`, `more`; per card `key`, `id`, `type`, `title`, `status`, `priority`, `labels`, `hasDescription`, `waiting`, `assignee` (role or kind), `epic` (key) |
| `list_orchestrations` | `id`, `name`, `status`, `createdAt`, `endedAt`, `costUsd`, `cwd`, `error`, `tasks` (`total` and a count per status), `verification` (its status) |
| `get_team` | `projectId`, `enabled`; per member `agent`, `role`, `model`, `responsibility`, `columns`, `queued`, `running` (`run`, `item` key), `lastRun` (`run`, `item`, `outcome`) |
| `list_flow_runs` | `runs` of `id`, `role`, `agent`, `model`, `step`, `state`, `outcome`, `summary`, `error`, `chatId`, `queuedAt`, `endedAt`, `item` (key); then `total`, `nextCursor` |
| `get_journal` | `entries` of `id`, `kind`, `text`, `documentPath`, `createdAt`, `item` (key), `author` (role or kind); then `total`, `nextBefore` |
| `list_documents` | `root`, `exists`, `fileCount`; per node `path`, `type`, `title`, `fileCount`, `children` |
| `list_chats` | `id`, `title`, `state`, `origin`, `model`, `messageCount`, `updatedAt`, `atLimit`, `project` (name), `projectId`, `orchestration` (id), `costUsd` |
| `list_providers` | `id`, `label`, `state`, `reason`, `account`, `version`, `limit` (`state`, `window`, `utilization`, `resetsAt`) |
| `list_accounts` | `id`, `kind`, `alias`, `email`, `plan`, `enabled`, `signedIn`, `limit` (`state`, `window`, `utilization`, `resetsAt`, `observedAt`, `source`) |

Rules for every tool:

- The input schema is strict (`additionalProperties: false`). An input that fails it is answered as a
  tool error (`isError: true`) and no request is made.
- The result is one `text` content of compact JSON, never indented (a test checks every read tool). capped at `RESULT_MAX_CHARS` (50 000). A cut result
  ends with `"truncated": true` and a hint to narrow the call. TOON was benchmarked on the list tools and saved under 15 %, so no tool uses it ([plans/agent-wire-format.md](plans/agent-wire-format.md)).
- A 4xx or 5xx is an error result with the status and the route's `error` text; there is no retry. A
  `401` says that the API is guarded and the chat has no token. A network error names the URL tried.
- Each request times out after `REQUEST_TIMEOUT_MS` (15 s).

## Write tools

`packages/mcp/src/write-tools.ts`, listed after the read tools (24 in all). Each calls one route that
already exists, with the chat's bearer token, resolves a key such as `AGN-12` through
`GET /work-items/by-key/:key`, and returns only the key, id, status and run or chat id. The input schema
stays strict and now accepts lists and nested objects (labels, criteria).

| Tool | Route |
|---|---|
| `create_work_item` | `POST /projects/:id/work-items` (backlog unless a status other than done is given) |
| `update_work_item` | `PATCH /work-items/:id` |
| `move_work_item` | `POST /work-items/:id/move`; refuses `done` before any request |
| `comment_work_item` | `POST /work-items/:id/comments` |
| `retry_flow_run` | `POST /flow-runs/:id/retry` |
| `retry_orchestration_task` | `POST /orchestrations/:id/tasks/:taskId/retry` |
| `start_chat` | `POST /chats` with only `prompt`, `cwd` (the project's path) and `model` |
| `accept_assistant_proposal`, `discard_assistant_proposal` | `POST /assistant/proposals/:id/accept` and `/discard` |

None deletes, stops, skips or restores, and none can widen a chat. The write names are in `names.ts`
(`isClaudioMcpWriteTool`) and are never in `--allowedTools`: the CLI asks the person before each call,
and Claudio shows no "always allow" for them ([claudio-assistant.md](claudio-assistant.md#writes-confirmed-one-by-one-option-a)).

## Teammates' shared copies

`packages/mcp/src/collab-tools.ts` (R13, [plans/collaborators-agent-access.md](plans/collaborators-agent-access.md)):
`collab_list_shared`, `collab_read_chats`, `collab_read_transcript`, `collab_read_memory`,
`collab_read_documents`, `collab_read_board` and `collab_read_journal`. They read the copies of
[Collaborators](collaborators.md#agents-that-read-what-teammates-share) this install holds, with the
chat's own token, and send their name as `x-claudio-tool`, which the API's audit records.

- **Toolsets.** A process offers what `CLAUDIO_MCP_TOOLSETS` (comma separated) names: `claudio`, the
  read and write tools above, and `collab`, these. Unset or empty is `claudio`, as before; an unknown
  name is dropped, so a value naming nothing known offers nothing. The assistant's file names
  `claudio,collab` while it may read; a project chat that opted in gets a file with `collab` alone
  (`collabMcpSync` in `packages/core/src/claudio-mcp.ts`), added to the servers it loads, or merged
  under the name `claudio` into the strict file of the servers it chose.
- **Fenced.** A result is already text (`TextResult`, `packages/mcp/src/untrusted.ts`): a header naming
  the teammate, install, project and share key, when the copy was last synced, and that the content is
  third-party, not instructions; then the content as compact JSON inside a fence longer than any
  backtick run in it. The server sends it as it is, so its own cut cannot drop the closing fence; the
  body is cut at 45,000 characters instead, with a line saying so.
- **No blob.** Documents and uploads are listed by name and size, never their bytes or hash.

## Environment

The server needs `CLAUDIO_API_URL`. When it is unset, empty or not an `http(s)` URL it writes
`claudio-mcp: CLAUDIO_API_URL is not set; this server only talks to the Claudio that started the chat`
to stderr and exits with 1, before it reads anything. There is no default URL and no port in the
package; a test checks it.

- `CLAUDIO_API_TOKEN`, when set, goes out as `Authorization: Bearer …`: it is the chat's own token
  ([chat-environment.md](chat-environment.md)).
- `CLAUDIO_CHAT_ID`, when set, goes out as `X-Claudio-Chat`. It is informational and grants nothing.
- `CLAUDIO_VERSION` is the `serverInfo.version`.

**What the config file holds.** The same file serves every chat. It has `CLAUDIO_API_URL` and
`CLAUDIO_VERSION` as literals and `CLAUDIO_CHAT_ID` and `CLAUDIO_API_TOKEN` as `${…}` references,
because the chat id and the per-process token only exist when a process spawns. The CLI expands them
from the chat's environment, so the secret never reaches the file. The file is written to
`<dataDir>/mcp/` (directory 0700, file 0600) by the same writer as the MCP servers a person picks
(`writeMcpConfig` in `packages/core/src/chat-tools.ts`).

## How it starts, in the three runtimes

The helper `claudioMcp({ dataDir, apiUrl, version })` (`packages/core/src/claudio-mcp.ts`, also
`Core.claudioMcp()`) builds the `command` of the file. **The choice is one environment variable,
`CLAUDIO_MCP_ENTRY`**, the absolute path of a bundled `mcp.mjs`:

| Runtime | What runs |
|---|---|
| Source (`pnpm dev`) | no variable: `node --import <tsx loader> packages/mcp/src/main.ts`, with tsx resolved from the mcp package because a chat's directory is not where tsx lives |
| API bundle, container | `startServer` (`apps/api/src/server.ts`) sets `CLAUDIO_MCP_ENTRY` to the `mcp.mjs` beside its own bundle; the helper runs `process.execPath` on it. `pnpm build` writes `apps/api/dist/mcp.mjs` as a third esbuild entry |
| Desktop app | `electron-builder.yml` ships `mcp.mjs` next to `server.mjs`, so the same rule finds it; under Electron the helper adds `ELECTRON_RUN_AS_NODE=1` to the server's `env`, as `server-process.ts` does for `server.mjs` |

It was picked over a runtime field because it is a single string that works everywhere and needs no
change in `apps/desktop`. When `apiUrl` is null (the API is not listening) or no entry resolves, the
helper throws and writes no file: it never hands over a config the CLI cannot start.

## What a confined chat gets

The helper returns what a caller spreads into `runtime.start`:

| Flag | Value |
|---|---|
| `--mcp-config` + `--strict-mcp-config` | a file with only the `claudio` server |
| `--tools=` | empty: no built-in tool |
| `--setting-sources=` | empty: no user, project or local settings, rules, hooks or servers |
| `--allowedTools` | the read tools by name, and nothing else |
| `--permission-mode` | `dontAsk`: what is not allowed is denied, not prompted. The helper's default; the assistant chat overrides it with the CLI's default mode and host prompts so a write can be confirmed |
| `--add-dir` | none |

**Checked with the real CLI (2.1.286):**

- It passes its whole environment to a stdio MCP server, and it expands `${NAME}` in the `env` of a
  config file from that environment.
- `--tools=` (empty) hides the built-in tools but **not** the tools of `--mcp-config`: a tool named in
  `--allowedTools` is called under `dontAsk`. So the MCP names stay out of `--tools`.

## How to try it

- Tests: `pnpm --filter @claudio/mcp test` (the server, in process and over stdio),
  `packages/core/test/claudio-mcp.test.ts` (the helper) and `apps/api/test/claudio-mcp-chat.test.ts` (a
  confined chat that asks about AGN-12, through the fake CLI's `FAKE-MCP-CALL <server> <tool> <json>`
  keyword).
- By hand, against a running wrapper:

  ```bash
  CLAUDIO_API_URL=http://127.0.0.1:8797/api pnpm --filter @claudio/mcp exec tsx src/main.ts   # or, after pnpm build: node apps/api/dist/mcp.mjs
  ```

  then type `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` and press Enter.

## Not here

Stop, skip, rerun and delete tools, moving a card to Done, and listing `claudio` in the person's MCP
settings: it is internal and given only to chats Claudio confines.

Related: [[plans/claudio-mcp-server.md]], [[plans/claudio-assistant.md]], [[claudio-assistant.md]], [[chat-environment.md]], [[assistant.md]], [[desktop.md]]
