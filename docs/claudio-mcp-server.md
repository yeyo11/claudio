---
created_at: 2026-10-01T12:00:00Z
updated_at: 2026-10-30T12:00:00Z
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
`CLAUDIO_API_URL`. Its tools reach the CLI as `mcp__claudio__<tool>`: 19 read tools (CW-6), twenty
write tools (CW-17 and the regression fixes of 2026-10-29, [below](#write-tools)) and seven reads of
teammates' shared copies (R13, [below](#teammates-shared-copies)). What they answer, how a large
answer is cut and which routes they may call were set by
[plans/regression-fixes-2026-10-29.md](plans/regression-fixes-2026-10-29.md) (D7, C5, C6). The spec is [plans/claudio-mcp-server.md](plans/claudio-mcp-server.md) (CW-6, epic
[plans/claudio-assistant.md](plans/claudio-assistant.md)).

It adds no screen and no route. The Claudio assistant's chat ([claudio-assistant.md](claudio-assistant.md))
is what hands it to a chat, through the helper below; a chat of a project that lets its agents read
what teammates share gets it too, with only the `collab_*` tools ([below](#teammates-shared-copies)).

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
| `get_work_item` | one item by key (`AGN-12`, any case) or id, with its criteria (each with its id), children, comments, history, links and flow runs, in one call |
| `list_milestones` | a project's milestones, with their state and progress: the `milestoneId` the board and the item tools take |
| `list_orchestrations` | the orchestrations, newest first, 25 unless `limit` says otherwise |
| `get_orchestration` | one orchestration with its tasks, verification and final report |
| `get_orchestration_plan` | the draft a planner chat of `plan_orchestration` produced (`GET /orchestrations/plans/:runId`) |
| `list_assistant_proposals` | a project's assistant proposals, `pending` unless `status` says otherwise, by `kind`: the id the accept and discard tools take. Read from `GET /projects/:id/assistant/runs` and the detail of each run whose counts hold some, ten runs at most |
| `get_team` | a project's team |
| `list_flow_runs` | a project's flow runs, filtered by agent, role, status, item |
| `get_journal` | a project's journal |
| `list_documents` | a project's documents tree, two folder levels deep unless `depth` (1–16) says otherwise; a folder below it says `more: true` |
| `read_document` | one file, a page of lines at a time: `offset` (lines skipped) and `limit` (default 200, at most 2 000); the answer says `lines: { from, to, total }` and `nextOffset` while there is more |
| `list_chats` | the chats, filtered by project, state, origin; 25 unless `limit` (at most 50) says otherwise |
| `get_chat` | a projection of one chat ([below](#get_chat)): what it is, its children counted, its last three executions, the prompts it waits on and a page of its transcript; never the export or the stream |
| `get_usage` | usage and its breakdown for a date range; a bound left out is the server's day (`day` of `GET /spend`), never all of history |
| `list_providers` | the agent providers with their readiness, account and usage limit per window, as last detected (claude-swap's accounts are gone since providers phase 4) |
| `list_accounts` | the Claude accounts with their kind, plan, state and usage limit per account, from `GET /accounts` |

The names live in `packages/mcp/src/names.ts` (`CLAUDIO_MCP_SERVER`, `CLAUDIO_MCP_READ_TOOLS`); a test
keeps the catalogue in `tools.ts` equal to that list, and the allow list is built from it.

**Every tool declares its routes** (`routes`, as `METHOD /pattern` the way `ROUTE_DOCS` keys them). A
test holds each declared route to `ROUTE_DOCS` and to its access class (`work`: one a chat's own token
may call, [plans/regression-fixes-2026-10-29.md](plans/regression-fixes-2026-10-29.md), C1), and
another drives every write tool against the real API through the fake CLI, failing when a request
reaches no route or one the tool does not declare. That is how `start_chat` once called a
`GET /projects/:id` that does not exist and passed against a stub.

### get_chat

`get_chat { chatId, limit?, before?, entries? }` answers `id`, `title`, `state`, `model`, `origin`,
`alive`, `cwd`, `account`, `atLimit`, `control`, `activity`, `project`/`projectId`, `orchestration`,
`costUsd`, `health` (`level`, `reason`), `pendingMessages`, `children` (counts of subagents,
background tasks and workflows, and how many run), `executions` (`total` and the `last` three),
`permissions` (the prompts it waits on; a failure to read them is said as `{ error }`, never taken for
none) and `transcript`: `from`, `total`, `entries` and `olderBefore` (the `before` of the page above).
`limit` is 10 by default (at most 50), `before` an index as the route's `from`. With `entries:
summary` (the default) thinking is dropped and every string of a tool's input and every tool result is
cut at 500 characters; `full` keeps the blocks, and the budget below applies. The detail and the
prompts are read at once, not one after the other.

## Fields of the list tools

A list tool answers **only the fields a model needs to choose a row, and the id that fetches the rest**
(`packages/mcp/src/fields.ts`; the format plan is [plans/agent-wire-format.md](plans/agent-wire-format.md)). A
field that is null or absent is left out. The detail tools (`get_work_item`, `get_orchestration`, `get_orchestration_plan`,
`get_overview`) keep the route's shape; `get_chat` and `read_document` page it ([below](#get_chat)), and `get_usage` adds the `from` and `to` it read.

| Tool | Row |
|---|---|
| `list_projects` | `id`, `name`, `key`, `path`, `modules`, `chatCount`, `lastActivity`, `exists` |
| `get_board` | per column `status`, `count`, `limit`, `overLimit`, `more`; per card `key`, `id`, `type`, `title`, `status`, `priority`, `labels`, `hasDescription`, `waiting`, `assignee` (role or kind), `epic` (key) |
| `list_orchestrations` | `id`, `name`, `status`, `createdAt`, `endedAt`, `costUsd`, `cwd`, `error`, `tasks` (`total` and a count per status), `verification` (its status) |
| `get_team` | `projectId`, `enabled`; per member `agent`, `role`, `model`, `responsibility`, `columns`, `queued`, `running` (`run`, `item` key), `lastRun` (`run`, `item`, `outcome`) |
| `list_flow_runs` | `runs` of `id`, `role`, `agent`, `model`, `step`, `state`, `outcome`, `summary`, `error`, `chatId`, `queuedAt`, `endedAt`, `item` (key); then `total`, `nextCursor` |
| `get_journal` | `entries` of `id`, `kind`, `text`, `documentPath`, `createdAt`, `item` (key), `author` (role or kind); then `total`, `nextBefore` |
| `list_documents` | `root`, `exists`, `fileCount`; per node `path`, `type`, `title`, `fileCount`, and `children` above the depth or `more: true` at it |
| `list_milestones` | `id`, `name`, `state`, `progress`, `closedAt` |
| `list_assistant_proposals` | `id`, `kind`, `status`, `runId`, `reason`, `createdAt`, `subject` (the member's agent, the resource's name, the item's title or the case id) |
| `list_chats` | `id`, `title`, `state`, `origin`, `model`, `messageCount`, `updatedAt`, `atLimit`, `project` (name), `projectId`, `orchestration` (id), `costUsd` |
| `list_providers` | `id`, `label`, `state`, `reason`, `account`, `version`, `limit` (`state`, `window`, `utilization`, `resetsAt`) |
| `list_accounts` | `id`, `kind`, `alias`, `email`, `plan`, `enabled`, `signedIn`, `limit` (`state`, `window`, `utilization`, `resetsAt`, `observedAt`, `source`) |

Rules for every tool:

- The input schema is strict (`additionalProperties: false`). An input that fails it is answered as a
  tool error (`isError: true`) and no request is made.
- The result is one `text` content of compact JSON, never indented (a test checks every read tool).
  TOON was benchmarked on the list tools and saved under 15 %, so no tool uses it ([plans/agent-wire-format.md](plans/agent-wire-format.md)).
- **The budget.** A result whose compact JSON is over `RESULT_BUDGET_CHARS` (24 000, well under the
  CLI's 25 000-token limit, past which the CLI spills a result to a file the assistant cannot read) is
  cut by its structure, never mid-value (`packages/mcp/src/render.ts`): strings over 2 000 characters
  are cut with `…`, then the largest list is shortened from the end, about by what is over, again
  until it fits; only when no list is left are strings cut shorter and objects deeper than six
  levels folded into `{"…": true}`. A cut answer is `{ "result": …, "truncated": { "arrays": n,
  "strings": n, "objects"?: n }, "hint": "…" }`, valid JSON, and the hint names the tool's paging
  arguments (`before` and `limit` for `get_chat`, `offset` for `read_document`, `cursor` for
  `list_flow_runs`…). A 3 000-entry chat over stdio answers under the budget in every shape (a test).
- A 4xx or 5xx is an error result with the status and the route's `error` text; there is no retry. A
  `401` says whether the chat's token was refused or none was given. A network error names the URL tried.
- Each request times out after `REQUEST_TIMEOUT_MS` (15 s).

## Write tools

`packages/mcp/src/write-tools.ts`, listed after the read tools (39 in all). Each calls routes that
already exist and that a chat's own token may call (`work`), with that token, resolves a key such as
`AGN-12` through `GET /work-items/by-key/:key`, and returns only the key, id, status and run or chat
id. The input schema stays strict, with lists, nested objects and numbers (labels, criteria, tasks,
limits). A body carries only the fields named here: never a permission mode, a tool list, a server,
an account, guards or a verification, so a confirmed call starts work with the app's defaults.

| Tool | Route |
|---|---|
| `create_work_item` | `POST /projects/:id/work-items` (backlog unless a status other than done is given) |
| `update_work_item` | `PATCH /work-items/:id`; `acceptanceCriteria` is the whole checklist, and an entry with the `id` `get_work_item` gave keeps that criterion and its check (one without is new) |
| `check_criterion` | `PATCH /work-items/:id/criteria/:criterionId` with `{ checked }` |
| `move_work_item` | `POST /work-items/:id/move`; refuses `done` before any request |
| `comment_work_item` | `POST /work-items/:id/comments` |
| `retry_flow_run` | `POST /flow-runs/:id/retry` |
| `plan_orchestration` | `POST /orchestrations/plan/start` with `objective`, the project's path, `model`, `maxTasks`; answers the planner chat, whose draft `get_orchestration_plan` reads once it is idle |
| `launch_orchestration` | `POST /orchestrations` with the graph's own fields (`name`, `objective`, `engine`, `model`, `effort`, `concurrency`, `synthesize`, `worktree`, `maxAttempts`, `limits`) and tasks (`id`, `name`, `prompt`, `dependsOn`, `model`, `effort`), given or taken from a draft (`fromPlan`, which also sets `plannerRunId`); `cwd` is the project's path |
| `stop_orchestration`, `resume_orchestration` | `POST /orchestrations/:id/stop` and `/resume` (no body: a resume keeps the graph's settings) |
| `retry_orchestration_task` | `POST /orchestrations/:id/tasks/:taskId/retry` |
| `start_chat` | `POST /chats` with only `prompt`, `cwd` (the project's path, from `GET /projects`), `model` and `name` |
| `send_chat_message`, `hint_chat` | `POST /chats/:id/messages` with `{ text }` and `POST /chats/:id/hint` with `{ text }` |
| `interrupt_chat`, `stop_chat` | `POST /chats/:id/interrupt` and `/stop` |
| `resume_chat`, `fork_chat` | `POST /chats/:id/resume` and `/fork` with only `{ prompt }` |
| `accept_assistant_proposal`, `discard_assistant_proposal` | `POST /assistant/proposals/:id/accept` and `/discard` |

None deletes, restores, or touches a setting, an account, permissions or security: those wait for the
server-side approval of [plans/assistant-everything.md](plans/assistant-everything.md). The chat tools
refuse, before any request, to message, hint, interrupt or stop the chat the server runs for
(`CLAUDIO_CHAT_ID`). The write names are in `names.ts`
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
- `CLAUDIO_CHAT_ID` is the chat the server runs for; the chat tools refuse to act on it. Nothing
  sends it to the API (an `X-Claudio-Chat` header nobody read is gone).
- A `401` names what happened: the chat's token refused (its process outlived it), or no token given.

`main.ts` answers each line on its own: a line whose handling throws is answered with JSON-RPC's
`-32603` (internal error, with its id) and the next line is still read, and a closed stdout ends the
process quietly instead of an unhandled rejection.
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
| `--allowedTools` | the read tools by name (`allowedFor`, the same rule everywhere the server runs), and nothing else |
| `--permission-mode` | `dontAsk`: what is not allowed is denied, not prompted. The helper's default; the assistant chat overrides it with the CLI's default mode and host prompts so a write can be confirmed |
| `--add-dir` | none |

**Checked with the real CLI (2.1.286):**

- It passes its whole environment to a stdio MCP server, and it expands `${NAME}` in the `env` of a
  config file from that environment.
- `--tools=` (empty) hides the built-in tools but **not** the tools of `--mcp-config`: a tool named in
  `--allowedTools` is called under `dontAsk`. So the MCP names stay out of `--tools`.

## On demand in any chat

Since 2026-10-19 ([plans/owner-report-fixes.md](plans/owner-report-fixes.md), D6) any Claude Code
chat can have the server, with **all** its tools, from one switch: the first row of the composer's "+"
→ Servers panel, and the same switch in the start options of a resume, a fork or a new chat. Its
**reads are allowed ahead of time** wherever it is switched on (report §4.4): in the joined file's
`--allowedTools` for its next processes, and in the live process through the CLI's
`apply_flag_settings` control request (`permissions.allow`, merged into the session's flag layer; the
Agent SDK's `applyFlagSettings`, sdk.d.ts 0.3.312), sent right after a successful `mcp_set_servers`
and cleared when the switch goes off. Without them a read was denied in a chat whose prompts go
nowhere or under `dontAsk`. A CLI that refuses the request keeps the server, and the chat gets a
notice that its reads ask until its next process. The writes obey the chat's permission mode like any
other MCP tool, and with "Sin comprobar permisos" (bypass) a write runs without asking, which the row
says under the switch. The API's audit records every call by
`x-claudio-tool`, as for the assistant.

| Where | How the server reaches the process |
|---|---|
| A live chat | `PUT /chats/:id/claudio-mcp` sends the CLI's `mcp_set_servers` with the `claudio` server (toolsets `claudio`, plus `collab` when the chat's project may read teammates' copies, as `collabMcpSync` decides). Off sends the set without it, keeping the collab-only server when the scope gives one |
| Its next processes | The choice is stored on the chat as `tools.claudioMcp`. A resume, a fork, and Claudio's own respawns (account switch, rotation, limit resume) start with the server merged into their `--mcp-config` file, as the collab reads are; the file adds to the CLI's own servers when the chat chose none, and stays strict when it chose some |

**Checked with the real CLI (2.1.302, no turn sent), recorded in
`packages/core/test/fixtures/recordings/claude/mcp-set-servers.json`:**

- A pushed config is **not** expanded: `${CLAUDIO_CHAT_ID}` reaches the server as written. So the
  pushed entry carries the chat's id and the token minted for that process literally
  (`dynamicClaudioServer`). They travel over the process's stdin and are never written to disk; the
  file of a respawn keeps the `${NAME}` references.
- A server of `--mcp-config` is listed with the scope `dynamic` too, and a set leaves it alone until
  a set names it. Switching off a server the process was launched with therefore pushes it once
  (replacing it), then sends the set without it.
- A config the CLI cannot start comes back in the reply's `errors`, by name, and the server is listed
  `failed` with the same words. The row shows them in mono; `GET /chats/:id/mcp` carries them in
  `claudio.error`.

Not offered in the assistant chat (it already has the server, confined), in a chat of another agent,
or in housekeeping and confined chats. When the API's address is unknown the switch is disabled and
says why (`claudio.unavailable: 'no-api'`, a 503 from the route). A server of the person's already
named `claudio` (user, project or local scope, or one the chat chose) is reported as such
(`'clash'`, a 409) and never overwritten. A work item's chat (`WorkOn`) does not offer it at start:
the work links take no such choice; it can be switched on from the chat once it runs.

## How to try it

- Tests: `pnpm --filter @claudio/mcp test` (the server, in process and over stdio; `render.test.ts`
  the cut, `reads.test.ts` the defaults and paging, `write-tools-api.test.ts` every write tool against
  the real API, `stdio.test.ts` the 3 000-entry chat),
  `packages/core/test/claudio-mcp.test.ts` (the helper) and `apps/api/test/claudio-mcp-chat.test.ts` (a
  confined chat that asks about AGN-12, through the fake CLI's `FAKE-MCP-CALL <server> <tool> <json>`
  keyword). The switch: `apps/api/test/claudio-mcp-switch.test.ts`, through the e2e fake CLI, which
  answers `mcp_set_servers` as recorded.
- By hand, against a running wrapper:

  ```bash
  CLAUDIO_API_URL=http://127.0.0.1:8797/api pnpm --filter @claudio/mcp exec tsx src/main.ts   # or, after pnpm build: node apps/api/dist/mcp.mjs
  ```

  then type `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` and press Enter.

## Not here

Skip, rerun and delete tools, settings, accounts and security, moving a card to Done, and listing
`claudio` in the person's MCP settings: it is internal, given to the chats Claudio confines and to the
chats a person switches it on for. The chat-ui words a prompt for the first nine write tools only
(`packages/chat-ui/src/lib/write-prompts.ts`); the others show the CLI's own prompt.

Related: [[plans/regression-fixes-2026-10-29.md]], [[reports/regression-audit-2026-10-29.md]], [[plans/claudio-mcp-server.md]], [[plans/claudio-assistant.md]], [[claudio-assistant.md]], [[chat-environment.md]], [[assistant.md]], [[desktop.md]], [[collaborators.md]], [[plans/collaborators-agent-access.md]]
