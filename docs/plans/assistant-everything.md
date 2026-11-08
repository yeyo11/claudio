---
created_at: 2026-10-25T09:00:00Z
updated_at: 2026-11-08T12:00:00Z
tags:
    - plan
    - assistant
    - mcp
    - security
    - permissions
    - lan
    - accounts
    - handoff
---
# Plan: the assistant does everything, Claudio on the LAN, a preferred account, and handoff

Status: **partly built; the rest waits for a design round** (2026-11-08). D10–D13 (Claudio on the LAN) landed in #77 as [lan-access.md](lan-access.md); D7 and D14–D18 (results that fit the CLI, the preferred account and the Accounts page) landed in #72 ([regression-fixes-2026-10-29.md](regression-fixes-2026-10-29.md)). D1–D6 and D9 (the server-side approval of writes) and D19–D21 (handoff) are not built: [decisions/mcp-writes-under-bypass.md](../decisions/mcp-writes-under-bypass.md) keeps them out until a design round of their own; D8 was not checked. This file came into `main` on 2026-11-08 from the branch `feat/assistant-everything`, where it was written. Was: **draft for the owner** (2026-10-25). The owner took decisions D1–D21 in the session of
2026-10-23 → 2026-10-25. The design sections marked **Owner check** need a look before the
orchestration starts. Everything ships as **one pull request** on `feat/assistant-everything`
(the owner's choice). Tasks run on `claude-sonnet-5-5`; `approvals`, `mcp-catalog`, `lan-core`,
`accounts-core`, `security-review` and `review` run on `claude-opus-5-5`. Never fable.

This plan is the source of truth for that orchestration, with CLAUDE.md and CONTRIBUTING.md. Where a
task prompt and this plan disagree, the plan wins. Workers start in fresh worktrees with none of the
session's context, so each section says what to build, where, and against which contract. Workers
verify through Sluice's `verify` tool (`lint`, `typecheck`, `test`; `e2e` with the spec prefixes in
`extra_args`, the `run-e2e` skill), never by running the commands themselves.

## Why

Users report many errors in the Claudio assistant's MCP calls, and the owner finds the assistant
offers far fewer options than the REST API. A live test of all 25 tools on 0.8.1 (2026-10-24)
confirmed it: two tools overflow the CLI's output limit, one never works with a project, one answers
the wrong range, and whole areas (deleting, stopping, resuming, settings, accounts) have no tool.
The owner's rule: **the assistant must be able to do everything in Claudio, deleting included,
otherwise it makes no sense** — with each change confirmed by the person, and that confirmation
enforced by the server.

The same session collected four more things the owner wants in the same pull request: reaching
Claudio from the LAN without `socat`, choosing the account Claudio uses (lost with claude-swap in
#188), the inconsistencies of the Accounts page a user reported, and handing a chat off to a fresh
one.

## Context

Facts re-read on 2026-10-24/25 at `ab4224941`–`146323bbc`. Line numbers help find the code; search
by name.

### 1. The MCP server and the assistant chat

- `packages/mcp`: 16 read tools (`tools.ts`), 9 write tools (`write-tools.ts`), 7 collab reads
  (`collab-tools.ts`); names in `names.ts:8-63`. Hand-written JSON-RPC over stdio (`server.ts`,
  `main.ts`). The client (`client.ts`) sends `authorization` and an informational `x-claudio-chat`,
  times out at 15 s, and **refuses anything but GET, POST and PATCH** (`client.ts:97-99`).
- `render()` cuts results at `RESULT_MAX_CHARS = 50_000` characters (`server.ts:13,36-40`) and
  appends `{"truncated":true,…}` **after a cut in the middle of the JSON**. The CLI's MCP output
  limit is about 25 000 tokens; id-dense JSON is under 2 characters per token, so 50 000 characters
  overflow it: `get_chat` on a 3016-message chat failed ("exceeds maximum allowed tokens"),
  `get_orchestration` and `read_document` on `docs/design-system.md` were spilled to a file. The
  confined assistant has no `Read` (`--tools=` empty), so it cannot open that file.
- The assistant chat: `assistantChatOptions` (`packages/core/src/claudio-mcp.ts:195-210`):
  `permissionMode: 'manual'`, `permissionPrompts: 'host'`, reads pre-allowed, writes never; applied
  at every spawn by `ChatManager.confineAssistant` (`chats.ts:1357-1367`).
- An ordinary chat with Claudio's server switched on from the "+" (`PUT /chats/:id/claudio-mcp`,
  `ChatManager.setClaudioMcp`, `chats.ts:1201-1238`; pushed with `mcp_set_servers`): **no Claudio
  tool is pre-allowed** (`collabMcpSync`, `claudio-mcp.ts:163` pre-allows only collab reads), so in
  a `dontAsk` chat every read is denied, and in a `bypassPermissions` chat every write runs with
  nobody asked.
- `PermissionBroker` (`packages/core/src/permissions.ts`): `ask` / `answer` / events `requested`,
  `resolved`; a request carries `runId` (= chat id), `toolName`, `toolUseId`, `input`
  (`types.ts:4748-4763`); the decision may carry `updatedInput`, and an allow answers with
  `updatedInput ?? input` (`control.ts:8-12`). Entries are deleted when settled: nothing records
  what was approved. Writes of Claudio's own tools get no "always allow" (`chat-fold.ts:414-440`).
- The MCP server never sees a tool-use id (`server.ts:52` reads only `name` and `arguments`).

### 2. The chat token

- Minted per process (`chats.ts:1654-1684`), hashed in memory (`security/chat-tokens.ts`), turned
  into the actor `chat:<id>` (`security/auth.ts:367-371`; only when the request is strictly local).
- Enforcement is a **denylist**: twenty `CHAT_FORBIDDEN*` sets in `apps/api/src/security.ts`
  (210-551, enforced 884-1028) plus per-route `fromChat` refusals (`routes/spend.ts:11`,
  `app-settings.ts:13-16`, `flow.ts:28`, `orchestrations.ts:110,132`, `assistant.ts:16`,
  `guards.ts:43,57,73,140`, `projects.ts:79`). 467 routes, 266 of them writes; a new route is open
  to chats unless someone remembers to list it.
- **Hole:** `POST /chats/:id/permissions/:requestId` is in no set (`routes/chats.ts:304-310`): a
  chat with a shell can answer its own pending permission prompts.
- **Under auth mode `none`** (the default) the sets inside `if (guarded && mode !== 'none')` do not
  apply (only review-gate, collaborators and terminal do), and any request without a token is let
  in. A server-side guarantee about chats therefore only holds with auth on.
- Nothing Claudio builds calls the API with the token except its MCP server: decision chats,
  one-shots, the reviewer, Project Docs and evals get no token; project assistant runs have no shell.
  Agents in a person's chats call it with `curl` (CLAUDE.md asks them to).

### 3. OpenAPI

`GET /openapi.json` (`apps/api/src/openapi/plugin.ts:57`), outside the `/api` prefix, guarded like
the API, with tags, summaries and descriptions, **no operationIds**. `ROUTE_DOCS`
(`apps/api/src/openapi/routes.ts:160-842`, helper `d(tag, summary, rest)` at 157) is the runtime map
`"METHOD /path"` → doc; `rest-api-doc.test.ts` and `api.test.ts` keep it whole.

### 4. Bugs found by the live test

| Bug | Cause |
|---|---|
| `start_chat` with `projectId` always `404: route not found` | it calls `GET /projects/:id`, which does not exist (`write-tools.ts:144`); `GET /projects` rows carry `path` |
| `get_usage` without dates returns all history (its description says today) | missing `from`/`to` are unbounded (`routes/chats.ts:63-68`, `usage-report.ts:80`) |
| `update_work_item` with criteria loses ids and checks | the MCP schema has no `id` (`write-tools.ts:17-21`); `replaceCriteria` deletes and reinserts (`work-items.ts:1385-1416`); `PATCH /work-items/:itemId/criteria/:criterionId` exists but no tool uses it |
| `get_chat.environment` shows another chat's model | the environment cache is keyed by **cwd** (`chats.ts:239`, `chat-fold.ts:71-74`, `db.ts:2667-2674`, read at `chat-service.ts:547`) |
| The web polls `GET /chats/:id/mcp` on dead chats (hundreds of 400s) | `useLiveServers` is enabled on `Boolean(chat.execution)` (`Controls.tsx:89`, `Composer.tsx:73`), and `mcpKey` sits under `chatScope`, invalidated on every chat event (`lib/events.ts:189,276`); a 400 comes from a failing `mcp_status` control request |
| `start_chat` accepts any model; the chat ends idle with health ok | no model check on `POST /chats` (`routes/chats.ts:74-86`, `chat-service.ts:730-771`); the CLI's answer is a `<synthetic>` assistant entry (`normalize.ts:333-335`) that sets no error |
| A fork does not keep the account | `LiveChat.account` starts `null` and `chooseAccount` picks again (`chats.ts:765-793`, `1459-1478`), against the doc comment at `types.ts:1543-1547` |
| No tool lists assistant proposals | only `GET /projects/:id/assistant/runs` and `GET /assistant/runs/:runId` |
| `retry_orchestration_task` on a stopped or completed graph says "resume it instead" | and no tool resumes |

### 5. LAN

- The desktop forces `HOST: '127.0.0.1'` after the person's environment (`apps/desktop/src/server-process.ts:58`)
  on a remembered random port (`server-port.ts`). The owner runs
  `socat TCP-LISTEN:8791,bind=192.168.0.30,reuseaddr,fork TCP:127.0.0.1:41985`, which makes every
  LAN device reach the API from `127.0.0.1` (one shared sign-in back-off bucket, no real client in
  the audit) over plain HTTP.
- Fastify 5.12.7: `app.routing(req, res)` is public; `@fastify/websocket` listens for upgrades on
  `fastify.server` only (`@fastify/websocket/index.js:47`), so a second `http.Server` must forward
  `request` to `app.routing` and `upgrade` to `app.server.emit('upgrade', …)`.
- Host allowlist: env + file + `RuntimeHosts` (`packages/core/src/app-settings.ts:124-152`);
  `EXACT_HOST` accepts `192.168.0.30` and `pc.local`, not single labels or IPv6. A runtime host
  without `clientIpHeader` keys the back-off as `runtime:<name>` (`security.ts:124-133`): **every LAN
  client would share one bucket**.
- The Tailscale tunnel is the pattern to copy (`packages/core/src/tunnel.ts`, `routes/tunnel.ts`,
  `RemoteAccessTab.tsx`, `QrCode.tsx`, `docs/tunnel.md`): refused under mode `none` (439), closed by
  `security.beforeUnguarded` before the mode switches (`index.ts:769-771`, a single slot), env
  `CLAUDIO_TUNNEL`/`CLAUDIO_TUNNEL_PORT` (`paths.ts:131-161`), Helm `values.tunnel.enabled`.
- The terminal over a non-tunnel remote peer is refused `needs-tunnel` by default
  (`terminal-gate.ts:70-77`, `terminals/settings.ts:14`).

### 6. Accounts

- `AccountsSettings` (`types.ts:6297-6307`): `rotateOnLimit`, `threshold` 90, `hysteresis` 10,
  `cooldownSeconds` 300, `strategy` `'order' | 'least-used'`. **No preferred account, no order:**
  `list()` is `[default, ...added]` (`packages/accounts/src/store.ts:280-283`) and nothing reorders it.
- `choose` (`packages/accounts/src/choose.ts:84-152`): a pin wins; the current account is kept under
  the threshold; the pool is the usable accounts under `threshold − hysteresis`, by strategy; a
  policy's order is also an allow-list (`:94-97`). `rotateOnLimit` only gates a person's chat moving
  at a limit (`chats.ts:1604-1606`).
- "In use" is `pick({ current: null })` with no policy (`index.ts:3647-3654`).
- Before #188 a card had **Use this account** (`cswap switch`) and a strategy "Drain the current one".
- Two usage sources: the account's reading (`packages/accounts/src/usage.ts`, `get_usage`, stream,
  CLI cache) and the provider's (`packages/core/src/providers/limits.ts`, fed by any chat's
  `rate_limit_event` whatever its account, and by the handshake probe of the default login; binding
  window chosen over expired windows too; near at 0.6). The status bar's dot reads the provider's
  (`ProviderDots.tsx`); the card reads the account's. That is the 74 % vs 80 % of the screenshot.
- Accounts page: no prefer action (`AccountCard.tsx:62-77`); the org and the kind are two spans with
  no separator ("Digio Inicio de sesión", `AccountCard.tsx:84,121`, `accounts.css:96-98`); the top
  bar puts the project selector in the crumb of every page (`TopBar.tsx:56-57`); "hoy, sin coste"
  is shown when today's cost is unknown (`StatusBar.tsx:351-354`); `PoliciesCard` already has a
  reorderable list (`move`, 69-77, 140-170).
- The terminal's shell inherits the server's `CLAUDE_CONFIG_DIR` (`terminals/env.ts:56-83`);
  `envFor` (`packages/accounts/src/env.ts:41-50`) knows an account's dir.

### 7. Handoff

- Session notes exist (`packages/core/src/context-notes.ts`, table `chat_notes`, routes
  `GET/POST /chats/:id/notes`): a paid housekeeping turn writes Goal, Done, Failed, Not tried yet,
  Files in flight, Next step; masked on read; **never handed to a run** today (D9 of
  `docs/plans/context-control.md`); a chat token gets 403 on `POST` and `DELETE`.
- Fork: `POST /chats/:id/fork` (`chat-service.ts:870-886`, `chats.ts:765-793`); `Chat.derivedFrom:
  ChatFork | null` (`types.ts:1147-1151,1337`), shown in the inspector (`Side.tsx:439-447`).
- Context fullness: `ChatContext { used, window }`, warn 0.6, full 0.75 (`types.ts:782-793`).
- A code-built handoff existed for provider moves: `packages/core/src/handoff.ts` (12 KiB, five
  sections, transcript text wrapped in `pasted()`), deleted by the Claude-only fork in `b4423a49e`;
  recover it with `git show b4423a49e^:packages/core/src/handoff.ts` and its test.

## Decisions

The owner's, 2026-10-23 → 2026-10-25.

**The assistant and the token**

- **D1. The assistant can do everything in Claudio**, deleting and security administration
  included. Hybrid coverage: curated tools for what is frequent, plus a generic `call_api` with
  `list_routes` and `describe_route` over the server's OpenAPI for everything else.
- **D2. Every write the assistant makes is confirmed by the person, and the server enforces it.**
  When the person allows a write of a Claudio tool, the core records a single-use approval bound to
  the chat, the tool and the exact arguments; the API accepts that write from the chat's token only
  against an unused approval. A changed argument, a replay, a leaked token or a bypass-mode chat
  gets nothing.
- **D3. Grave actions get a stronger prompt** (deleting, security, accounts, updates, settings): the
  prompt says what will be lost, in `--bad`, and never offers "always allow".
- **D4. Ordinary chats: work is free, grave writes need an approval.** A chat's token keeps doing
  today's work without asking (start, stop, resume and message chats; launch, stop, resume and retry
  orchestrations; work items, comments, criteria, journal entries, flow retries, proposals). Grave
  writes (the `confirm` class below) need an approval, which only a Claudio MCP tool call confirmed
  in the chat's prompt can give. In a `bypassPermissions` chat there is no prompt, so they are
  refused with a message that names the assistant.
- **D5. Every route is classified, and a new route is born unclassified and fails a test.** The
  denylist sets become one class per route in `ROUTE_DOCS`. A chat can never answer permission
  prompts (`person` class): that closes the hole in Context §2.
- **D6. With auth mode `none` the server cannot tell a chat from anyone else**, so D2 and D4 are
  enforced only with auth on. The assistant's page and Settings → Access say so; nothing else
  changes for an unguarded install.

**The MCP server**

- **D7. Results fit the CLI.** The cap is measured for the CLI's limit with a margin, the cut keeps
  valid JSON (lists are trimmed and say how many items were left out), and the long reads take
  paging parameters.
- **D8. The bugs of Context §4 are fixed**, each with a test that would have caught it.
- **D9. Claudio's server switched on in an ordinary chat pre-allows the read tools**; writes follow
  D4.

**LAN**

- **D10. Claudio listens on the LAN itself**, through a second listener inside the server, on a
  fixed port (8791 by default), on all interfaces or the ones chosen.
- **D11. On by default on the desktop when auth is `token` or `oidc`** (the owner's option A);
  refused under `none` and closed when the mode becomes `none`, like the tunnel. In the container
  and Helm it is off unless `CLAUDIO_LAN=on`.
- **D12. Its hosts join the allowlist while it listens, and each LAN client is its own back-off
  bucket.** The terminal stays refused over the LAN unless its remote setting says otherwise.
- **D13. The screen says it is plain HTTP**: the token travels unencrypted on the LAN, and a phone
  gets no installable app or push there; Tailscale is recommended for the phone.

**Accounts**

- **D14. "Use this account" comes back as a preferred account.** New work starts on it.
- **D15. The preference lives inside the rotation settings:**
  - `rotateOnLimit` off → nothing moves at a limit;
  - threshold, hysteresis and cooldown apply to it;
  - the strategy picks where work goes when the preferred account is full;
  - a project's policy wins over the global preference.
- **D16. The `order` strategy gets a reorderable list.**
- **D17. One source of truth for usage:** the status bar reads the account in use, the same reading
  as its card.
- **D18. The page's inconsistencies are fixed** (list under Design › Accounts).

**Handoff**

- **D19. A chat can continue in a fresh chat** with a handoff: a note plus facts gathered by code,
  same project, worktree, account, model and tools, linked to the original both ways.
- **D20. An agent may hand itself off without a click**, once per chat, and the original says
  "Continued in …". Handing off another chat (from the assistant) needs the person's click.
- **D21. A note is handed to a run only through a handoff the person or the agent asked for.** This
  revises D9 of `docs/plans/context-control.md`: notes are still never put in a prompt by Claudio on
  its own, and what travels is wrapped as untrusted text.

Dropped by the owner: the flaky core tests under load (handled by Sluice's one-package-at-a-time
gate, 2026-10-24).

## Design

Load the `claudio-ui` skill for every screen. Every string goes through i18n with `en`/`es` parity;
`es` follows `apps/web/src/i18n/GLOSSARY.md`.

### The permission prompt of a Claudio tool (D2, D3)

`packages/chat-ui/src/components/PermissionPrompts.tsx` draws a prompt per pending request. For a
tool named `mcp__claudio__*` it draws a **sentence first**, then the details:

```
┌─────────────────────────────────────────────────────────────────┐
│ Claudio wants to move CLD-2 to In progress                      │  --fs-body, --fw-strong
│ claudio · move_work_item                                        │  mono, --fg-3, --fs-small
│ ▸ Details  (item: CLD-2, status: in_progress)                   │  folded; JSON in mono
│                                         [Deny]  [Allow once]    │  no "Always allow"
└─────────────────────────────────────────────────────────────────┘
```

- The sentence comes from the tool's `summary` key in a new `claudioTools.json` namespace, with the
  arguments interpolated (`"Claudio wants to delete the project {{name}}"`); `call_api` reads
  `"Claudio wants to {{method}} {{path}}"` and shows the body in Details, unfolded.
- **Grave tools** (`kind: 'destructive'` in the catalogue, D3): the card takes the `bad` tone (a
  2 px `--bad` rail and the `TriangleAlert` icon beside the sentence), a second line says what is
  lost (`claudioTools.json` `lost.*`, e.g. "Its chats, board and settings stay on disk; Claudio forgets
  the project"), and the allow button reads **Delete** / **Change** with `btn-danger`.
- Never "Always allow" for any Claudio write (already true); keyboard: Enter is never Allow on a
  grave prompt.
- Phone: the card is full width, buttons 44 px, Details opens in a `Sheet`.

### LAN access (D10–D13) — Owner check

In Settings → Access & safety → **Remote access**, above the Tailscale card, a card **On the local
network** built like `TunnelCard` (`RemoteAccessTab.tsx:73-138`):

```
On the local network                                    [switch] ● Listening
Devices on your network open Claudio at:
  http://192.168.0.30:8791     [Copy] [QR]
  http://yeyo-pc.local:8791    [Copy] [QR]
Port [ 8791 ]   Interfaces (•) All  ( ) Choose…  [192.168.0.30 ✓] [10.0.0.4]
⚠ Plain HTTP: your token travels unencrypted on this network, and a phone
  gets no app or notifications here. For the phone, use Tailscale below.
                                                            Changed · Reset
```

- States: Listening (ok + word), Off, **Needs a sign-in method** (warn; mode `none`; the switch is
  disabled and links to Security, as `TunnelPanel` does at 251-263), **Port in use** (bad; "Another
  program holds port 8791", with the port field focused), Failed (bad, the error in mono).
- One QR at a time (the one opened), drawn with `QrCode`. The URL list is mono; the rest is sans.
- `Changed · Reset` slot per setting (`lan.enabled`, `lan.port`, `lan.bind`), as every row.
- Phone: the card stacks; URLs wrap; QR in a `Sheet`.
- The assistant's page and the Access header show the D6 note when the mode is `none`.

### Accounts (D14–D18) — Owner check

- **Card:** a new action **Use this account** (`btn btn-small`), hidden on the preferred one, which
  shows the tag **Preferred** (neutral `Tag`) beside the plan. "In use" stays as today (the account
  new work would start on now), so both can show: the preferred one at its limit is "Preferred",
  another is "In use". Holding out the preferred account asks to confirm ("It is your preferred
  account: new work will start on another one") and clears the preference; holding out the **only**
  usable account asks to confirm ("Claudio will have no account to start work on").
- **Rotation card:** strategy becomes "Where work goes when the preferred account is full"
  (`Segmented`: In order · Least used). With **In order**, the list of accounts under it with
  up/down buttons, reusing `PoliciesCard`'s order list (`move`, its classes and its keyboard).
  With one account, the card collapses to one line: "With one account there is nothing to rotate.
  Add an account to rotate at a limit." and the policies card hides its empty state.
- **Switch off → fields read-only:** when "Switch at the limit" is off, threshold, hysteresis and
  cooldown are disabled with the hint "Applies when switching at the limit is on".
- **Copy and colour fixes:**
  - "near the limit" tag in `warn`, never `bad` (the bar keeps `bad` from 75 %);
  - "Digio · Login": a separator between organisation and kind, and the `es` kind reads "Cuenta de
    Claude" instead of "Inicio de sesión";
  - "read 7 s ago" once (the page subtitle), not again on each card;
  - "hoy, sin coste" → "hoy, coste sin datos" when today's cost is unknown (`null`), "hoy, 0 €" only
    when it is zero;
  - the usage history's threshold fallback follows the rotation default (90), not 85.
- **Top bar:** on global pages (Accounts, Settings, Usage) the crumb has no project selector.
  *Owner check:* confirm the selector should leave those pages.

### Handoff (D19–D21) — Owner check

- **Where:** the inspector's Summary tab, `UsageCard` actions row (`Side.tsx:75-80`), beside
  Compact: **Continue in a new chat**; the same item in the header's chat menu (`Header.tsx:204-224`).
  When the context reaches `CONTEXT_FULL` (0.75), the usage card adds one line under the gauge:
  "Context nearly full · Continue in a new chat" (a link, no colour beyond the existing warn word).
- **Dialog** (`Dialog`, desktop 640 px; a `Sheet` on a phone):
  1. *What the new chat gets* — a note: **Write a note now** (a paid turn, the existing note
     request, with its spinner) or **Use the note from …** (a list of the chat's ready notes); the
     note is editable (`Textarea`, the six headings).
  2. *Facts Claudio adds* (read-only, folded): branch, files in flight, open checklist, last
     command, gathered by code.
  3. *Anything else to tell it* (optional `Textarea`).
  4. Footer: the new chat's model, account and worktree in one muted line; **Continue** (primary,
     `--grad`) and Cancel.
- **After:** the new chat opens; the original gets a divider entry "Continued in <new chat title>"
  (link) and its composer says "This chat continued in …" with the link (it can still be resumed);
  the new chat's inspector shows "Continued from <title>" where "Forked from" shows today.
- A self-handoff by an agent (D20) shows the same divider, with "by the agent".

### What goes into the design system

`docs/design-system.md` and `claudio-ds.css`: the grave permission card, the LAN card, the preferred
tag and the order list on the rotation card, the handoff dialog and the "Continued in" divider —
each a short subsection in the same pull request.

## Contracts

### Route classes (D4, D5)

`RouteDoc` (`apps/api/src/openapi/routes.ts`) gains `chat: 'read' | 'work' | 'confirm' | 'person'`.

| Class | Meaning | Default |
|---|---|---|
| `read` | a chat's token may call it | every `GET` not listed otherwise |
| `work` | ordinary chats freely; the **assistant** only with an approval | listed explicitly |
| `confirm` | any chat only with an approval | every write not listed as `work` or `person` |
| `person` | never a chat's token | `POST /chats/:id/permissions/:requestId`, `POST /security/allowed-hosts/claim`, and the approval routes if any |

- Today's `CHAT_FORBIDDEN*` reads that hide secrets (the YouTrack credentials, a sign-in's page)
  become `person`. Their writes become `confirm`.
- The per-route `fromChat` refusals stay where they protect a field inside a body (spend cap, evals
  phase 2, weaker guard overrides), and gain the approval as a way through.
- `apps/api/test/route-classes.test.ts`: every route has a class, every `GET` that is not `read` is
  justified in a comment, and the table in `docs/rest-api.md` gains a "Chat" column checked by
  `rest-api-doc.test.ts`.
- The `work` list starts as: `POST /chats`, `/chats/:id/messages`, `/chats/:id/stop`,
  `/chats/:id/resume`, `/chats/:id/fork`, `/chats/:id/handoff` (own chat only, D20),
  `PUT /chats/:id/claudio-mcp`; `POST /orchestrations`, `/orchestrations/:id/stop`, `/resume`,
  `/tasks/:taskId/retry`; `POST /projects/:id/work-items`, `PATCH /work-items/:id`,
  `POST /work-items/:id/move`, `/comments`, `PATCH /work-items/:itemId/criteria/:criterionId`;
  `POST /projects/:id/journal`; `POST /flow-runs/:runId/retry`;
  `POST /assistant/proposals/:id/accept`, `/discard`; `POST /schedules/:id/run`. The `approvals`
  task completes it from the routes these flows use and lists it in the decision doc.

### Approvals (D2, D4)

- **Core** `packages/core/src/approvals.ts`, `ApprovalLedger` (in memory, like chat tokens):
  `record({ chatId, tool, argsHash, kind })`, `take(chatId, tool, argsHash): boolean` (single use),
  entries expire after 120 s.
- Fed by the broker: on `resolved` with `behavior: 'allow'` for a tool named `mcp__claudio__<tool>`
  whose catalogue kind is `write` or `destructive`, record `argsHash = claudioArgsHash(tool,
  decision.updatedInput ?? request.input)`.
- **Hash** `claudioArgsHash(tool, args)` in `packages/mcp/src/call-hash.ts`: SHA-256 of
  `tool + '\n' + canonical JSON` (keys sorted at every depth, no whitespace). The core imports it
  from `@claudio/mcp` (it already depends on it); the MCP server computes the same on the arguments
  it received.
- **Header** `x-claudio-call: <tool>.<hex hash>` on every write request the MCP server sends.
- **API** (`apps/api/src/security.ts`): for a request carrying a chat actor, after the class check —
  `confirm` (any chat) and `work` (the assistant chat): parse `x-claudio-call`; `take` an approval
  for that chat, tool and hash; otherwise **403** `{ code: 'approval-required', error: "…confirm
  it in the chat's prompt, or do it from the Claudio assistant" }`. The approval covers one write
  request; a tool makes at most one write per call (`call_api` exactly one).
- The ledger never answers a prompt; nothing a chat can call records an approval.

### The MCP catalogue (D1, D7, D8)

- `names.ts` exports `CLAUDIO_TOOL_CATALOGUE: { name, kind: 'read' | 'write' | 'destructive',
  toolset }[]`, read by the core (allowed lists, the ledger) and by chat-ui (the prompt).
- `client.ts` allows `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.
- `render()`: `RESULT_MAX_CHARS = 30_000`; past it, arrays are trimmed from the end (newest first
  lists keep their head) with `{"omitted": N, "hint": …}` in place, until the JSON fits; a string
  field over 4 000 characters is cut with `…[cut N chars]`. The result is always valid JSON.
- Paging: `get_chat { limit (≤ 50, default 10), before? }` and no `environment` unless
  `withEnvironment: true`; `get_orchestration { withResults?: false }` (task results replaced by
  their first 300 characters); `read_document { offset?, limit? }` in characters; `get_overview
  { compact?: true }`; `get_usage` defaults to today (local day).
- **New read tools:** `list_proposals { projectId? }` (pending proposals across the latest runs),
  `get_chat_context { chatId }`, `list_routes { tag? }`, `describe_route { method, path }` (both
  from `/openapi.json`, fetched once from the API base without `/api` and cached for the process).
- **New write tools** (`write`): `send_message`, `stop_chat`, `resume_chat`, `fork_chat`,
  `handoff_chat` (D19–D20), `start_orchestration` (a template or a graph), `stop_orchestration`,
  `resume_orchestration`, `check_criterion`, `add_journal_entry`, `run_schedule`,
  `set_preferred_account`, `refresh_accounts`.
- **New grave tools** (`destructive`): `delete_chat`, `delete_orchestration`, `delete_work_item`,
  `delete_project`, `call_api` (any method other than `GET`; a `GET` through `call_api` is `read`
  and needs no approval — the tool splits on the method before asking: two tool names,
  `call_api_read` and `call_api`).
- `start_chat` resolves the project through `GET /projects`, validates the model (below), and keeps
  its narrow body; `update_work_item` accepts `{ id?, text }` criteria and keeps ids; criteria
  checks go through `check_criterion`.

### Chat fixes (D8, D9)

- Environment keyed by chat: `chat_environments` gets a `chat_id` key (migration), read by chat id,
  falling back to the cwd's last one only for a chat that never started a process.
- `useLiveServers` enabled on `chat.alive`, and `mcpKey` out of `chatScope`'s blanket invalidation
  (invalidated on `chat.process` events only).
- `POST /chats` (and resume, fork, handoff) check a given model against the chosen account's model
  list when that list is known (`AccountStore.models`): unknown → **400** `{ code: 'unknown-model',
  models: [...] }`. A `<synthetic>` assistant entry that ends a turn sets the execution's `error` and
  a `bad` health signal.
- Fork and handoff keep the source's account (fix of `chats.ts:765-793`).
- `collabMcpSync` / `setClaudioMcp`: the read tools of `CLAUDIO_TOOL_CATALOGUE` go into
  `--allowedTools` when the `claudio` toolset is on.

### LAN (D10–D13)

- **Types** (`packages/shared/src/types.ts`): `LanSettings { enabled: boolean | null; port: number;
  bind: 'all' | string[] }` (`enabled: null` = the launcher's default, D11);
  `LanStatus { state: 'off' | 'listening' | 'refused' | 'port-in-use' | 'failed'; reason: { code,
  text } | null; port; addresses: { ip: string; host: string | null; url: string }[]; settings:
  LanSettings; available: boolean }` (`available` false where the environment turns it off).
- **Core** `packages/core/src/lan.ts`, `LanListener` (shape of `TunnelManager`): `attach(app
  handler, upgrade forwarder)` from `startServer`; `start()` refuses mode `none`; `stop('request' |
  'unguarded')`; settings in `<dataDir>/lan-settings.json`; chained into `security.beforeUnguarded`
  with the tunnel (the slot becomes a list).
- **Server** (`apps/api/src/server.ts`): a second `http.createServer((req, res) =>
  app.routing(req, res))`, `on('upgrade', (req, socket, head) => app.server.emit('upgrade', req,
  socket, head))`, listening on each bound address; closed in `close()`.
- **Hosts:** every listening address's IP (and the machine's `<hostname>.local` when it resolves)
  is added as a runtime host with a new option `{ peerIsClient: true }`, so the back-off keys by the
  socket's address (`security.ts:124-133`).
- **Routes:** `GET /lan`, `PUT /lan/settings`, `POST /lan/start`, `POST /lan/stop`; tag `Remote
  access`; class `confirm` for the writes; rows in `docs/rest-api.md`.
- **Environment:** `CLAUDIO_LAN` (`on` | `off` | `auto`; `auto` = on with a credential),
  `CLAUDIO_LAN_PORT` (8791), `CLAUDIO_LAN_BIND` (comma-separated IPs). The desktop's `serverEnv`
  sets `CLAUDIO_LAN=auto` unless the person's environment sets it; the image and Helm default to
  `off`; Helm gains `values.lan.enabled` (false) and `values.lan.port`.
- Setting ids `lan.enabled`, `lan.port`, `lan.bind` in `setting-ids.ts` and the settings registry.

### Accounts (D14–D17)

- `AccountsSettings` gains `preferred: string | null` (default `null`) and `order: string[]`
  (default `[]` = list order); validated against known ids; `remove` drops the id from both.
- `choose()` (`packages/accounts/src/choose.ts`), in this order:
  1. a pin wins (unchanged);
  2. the candidate order is `policy?.order ?? settings.order ∪ list order`;
  3. **the preferred account** (when no policy, or the policy lists it) is chosen when usable and
     under the threshold; when work is on another account, it comes back once the preferred one is
     under `threshold − hysteresis` and the cooldown has passed;
  4. otherwise today's logic, the strategy choosing among the rest.
- `accountInUse()` uses the same rules (no project).
- Set through `PUT /accounts/settings` (no new route); the MCP's `set_preferred_account` calls it.
- **One usage source** (D17): `Core.limitReadings()` answers, for a provider with accounts, the
  reading of the account in use (state, window, utilization, reset from `account.limits`); the
  provider's own reading stays for providers without accounts and for the handshake.
- The terminal's environment (`buildTerminalEnv`) sets `CLAUDE_CONFIG_DIR` to the preferred login
  account's directory (never a token or key), so `claude` in Claudio's terminal runs on it.

### Handoff (D19–D21)

- **Route** `POST /chats/:id/handoff` `{ note?: { id: string } | { text: string }; instructions?:
  string; model?: string }` → `201 { chat: ChatSummary, from: string }`. Without a note it requests
  one first (a paid note turn) and answers `202 { pending: true }`, finishing on the note's
  `result`; the client follows `chat.handoff` events.
- **Core** `packages/core/src/handoff.ts`, recovered from `b4423a49e^` and adapted:
  `buildHandoff(input): { text, bytes, sections }`, 12 KiB cap, the note and transcript-derived text
  inside `pasted()` with `PASTED_NOTE`; facts from git (`status --porcelain`, `diff --stat`, branch),
  the open checklist, the last commands; then the person's instructions in their own words.
- The new chat: same cwd (the worktree path when there is one), account, model (or the request's),
  effort, permission mode, tool config, MCP servers and `claudioMcp`; `derivedFrom: { chatId, at,
  kind: 'handoff' }` (`ChatFork.kind?: 'fork' | 'handoff'`); the source gains `continuedIn: { chatId,
  at, by: 'person' | 'agent' | 'assistant' }` and a notice entry.
- **Chat token:** a chat may hand off itself once (`409 { code: 'already-handed-off' }` after);
  handing off another chat is `confirm`.

## Tasks

The integrator launches one graph on `feat/assistant-everything`:

```
approvals (opus) ──────┬─ mcp-catalog (opus) ──┬─ prompt-ui ─────────┐
                       │                       │                     │
chat-fixes ────────────┤                       │                     ├─ security-review (opus)
handoff-core ──────────┘                       │                     │
lan-core (opus) ── lan-web ────────────────────┤                     ├─ review (opus) ── docs
accounts-core (opus) ── accounts-web ──────────┤                     │
handoff-core ── handoff-web ───────────────────┘                     │
```

| Id | Model | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- | --- |
| `approvals` | claude-opus-5-5 | D2, D4, D5, D6 server side | – | `RouteDoc.chat` and every entry's class in `routes.ts`; `apps/api/src/security.ts` (class enforcement replaces the `CHAT_FORBIDDEN*` sets, the `x-claudio-call` check, the `person` routes); `packages/core/src/approvals.ts` and its wiring in `index.ts` (broker `resolved`); `packages/mcp/src/call-hash.ts`; `CLAUDIO_TOOL_CATALOGUE` in `names.ts` (the type and the existing 25 tools; `mcp-catalog` adds the new ones); `apps/api/test/route-classes.test.ts`; the "Chat" column of `docs/rest-api.md` and its test; `docs/decisions/chat-writes-need-approval.md` | `verify` lint, typecheck, test |
| `mcp-catalog` | claude-opus-5-5 | D1, D7, D8 (MCP side) | `approvals` | `packages/mcp/src/**` (client methods, `render`, paging, the new tools, `call_api`/`list_routes`/`describe_route`, the `x-claudio-call` header, `start_chat`/`update_work_item`/`get_usage` fixes, catalogue entries); `packages/mcp/test/**`; `apps/api/test/claudio-mcp-chat.test.ts` (a confined chat deleting a work item: refused without approval, done with one) | `verify` lint, typecheck, test |
| `chat-fixes` | claude-sonnet-5-5 | D8 (core and web), D9 | – | the environment migration in `db.ts` and its readers; `useLiveServers` and `mcpKey` (`ServersPanel.tsx`, `Controls.tsx`, `Composer.tsx`, `lib/events.ts`); model validation in `routes/chats.ts` / `chat-service.ts`; synthetic-error handling in `chat-fold.ts`; fork keeping the account (`chats.ts`); pre-allowed reads in `claudio-mcp.ts` / `setClaudioMcp`; tests | `verify` lint, typecheck, test |
| `prompt-ui` | claude-sonnet-5-5 | Design › permission prompt | `mcp-catalog` | `PermissionPrompts.tsx` and its styles; `claudioTools.json` (en, es) for every catalogue tool; tests; `e2e/specs/assistant-approvals.spec.mjs` (fake CLI: a grave prompt drawn in `bad`, Allow once, the write lands; Deny, nothing lands) | `verify` lint, typecheck, test, e2e `assistant` |
| `lan-core` | claude-opus-5-5 | D10–D12 server | – | `packages/core/src/lan.ts`; `LanSettings`/`LanStatus`; `apps/api/src/server.ts` (second listener); `RuntimeHosts` `peerIsClient`; `beforeUnguarded` as a list; `routes/lan.ts` and its OpenAPI entries; `paths.ts` env parsing; `apps/desktop/src/server-process.ts` (`CLAUDIO_LAN=auto`); `docker/`, `docker-compose.yml` comment, Helm values and deployment; setting ids and registry; tests (core: refused under none, closed on unguard, port in use; api: a request on the LAN port reaches a route and an upgrade reaches the terminal socket, back-off per peer) | `verify` lint, typecheck, test |
| `lan-web` | claude-sonnet-5-5 | D13, Design › LAN | `lan-core` | `RemoteAccessTab.tsx` (the new card above `TunnelCard`); `api.ts` client methods; events `lan.changed`; `remoteAccess.json` (en, es); its subsection in `design-system.md` and `claudio-ds.css`; tests; `e2e/specs/remote-access.spec.mjs` (the card's states) | `verify` lint, typecheck, test, e2e `remote-access` |
| `accounts-core` | claude-opus-5-5 | D14–D17 server | – | `packages/accounts/src/{store,choose,types}.ts` and `AccountsSettings`; `accountInUse`; `Core.limitReadings`; `terminals/env.ts`; settings registry ids `accounts.preferred`, `accounts.order`; tests (choose: preferred under/over threshold, hysteresis return, cooldown, policy wins, rotateOnLimit off) | `verify` lint, typecheck, test |
| `accounts-web` | claude-sonnet-5-5 | D18, Design › Accounts | `accounts-core` | `AccountCard.tsx`, `RotationCard.tsx` (order list), `PoliciesCard.tsx` (one-account state), `Accounts.tsx`, `StatusBar.tsx` (today's cost word), `TopBar.tsx` (global pages), `accounts.css`, `accountsConfig.json`/`shell.json` (en, es); tests; `e2e/specs/accounts.spec.mjs` | `verify` lint, typecheck, test, e2e `accounts` |
| `handoff-core` | claude-sonnet-5-5 | D19–D21 server | – | `packages/core/src/handoff.ts` (recovered) and its test; `POST /chats/:id/handoff` (route, service, OpenAPI, `docs/rest-api.md` row); `ChatFork.kind`, `continuedIn`; the notice entry; chat-token rules (own chat once) | `verify` lint, typecheck, test |
| `handoff-web` | claude-sonnet-5-5 | Design › Handoff | `handoff-core` | `Side.tsx` (`UsageCard` action and the full-context line), `Header.tsx` (menu item), a new `HandoffDialog.tsx`, the divider and composer line in chat-ui, `chat.json`/`context.json` (en, es); its subsection in the design system; tests; `e2e/specs/handoff.spec.mjs` | `verify` lint, typecheck, test, e2e `handoff` |
| `security-review` | claude-opus-5-5 | adversarial review of the approval path, the route classes, the LAN listener and self-handoff | `approvals`, `mcp-catalog`, `chat-fixes`, `lan-core`, `handoff-core`, `prompt-ui` | a report in `docs/reports/assistant-everything-security.md`; fixes only for findings it can prove with a test | `verify` test |
| `review` | claude-opus-5-5 | conventions, design, copy, the one rule, cross-task consistency; `openapi:schemas` once on the merged tree | all above | findings and one-line fixes nobody owns | `verify` lint, typecheck, test, e2e (the six specs) |
| `docs` | claude-sonnet-5-5 | `docs/claudio-mcp-server.md`, `docs/claudio-assistant.md`, `docs/security-model.md`, `docs/securing.md` (approvals; mode `none`), `docs/lan-access.md` (new), `docs/configuration.md` (`CLAUDIO_LAN*`), `docs/accounts.md` (preferred, order, one source), `docs/handoff.md` (new), `docs/context-control.md` (D21), `docs/status.md`, this plan's Outcome | `review` | the listed docs | prose only: every path and link exists |

Files several tasks touch:

- `types.ts`: each task adds only its own types.
- `routes.ts` and `docs/rest-api.md`: `approvals` adds the class to every entry first; `lan-core` and
  `handoff-core` add their routes with a class.
- `names.ts`: `approvals` adds the catalogue type and the existing tools; `mcp-catalog` adds the new.
- `chats.ts`: `chat-fixes` (fork account, MCP reads) and `handoff-core` (the handoff launch) in
  separate functions.
- `design-system.md` and `claudio-ds.css`: each UI task adds its own subsection.

### Rules for every task

1. Work only in your worktree, on your branch. Conventional Commits in English, a body saying why,
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or Sonnet 5.5 for a Sonnet task).
2. Verify through Sluice's `verify` tool with an absolute `working_directory`: `lint`, `typecheck`,
   `test`; for a UI task also `e2e` with your spec prefixes in `extra_args`, once the `e2e` gate is
   on `main` (branch `build/e2e-through-sluice`, `docs/decisions/e2e-through-sluice.md`); until
   then, push and run `pnpm e2e:remote <prefixes>`. Never run a gate's command yourself, never set
   `E2E_ALLOW_LOCAL` or `SLUICE_JOB`.
3. Never start a Claudio server with the inherited environment (the owner's live app). To look at a
   screen, isolate it (`env -u CLAUDIO_DATA_DIR -u PORT -u CLAUDIO_WEB_DIST -u CLAUDIO_API_URL -u
   CLAUDIO_API_TOKEN -u CLAUDIO_CHAT_ID`, a temporary data dir, free ports) and stop its process
   groups after.
4. After changing `types.ts`, regenerate the schemas only if you are `review`; others note it.
5. UI tasks load the `claudio-ui` skill and follow `docs/design-system.md`; the hooks lint every
   UI file.
6. Run long commands under `timeout`; never wait in an unbounded loop.
7. Reply with your commit hashes, one line per decision you built, what you could not finish or
   verify, and the `verify` result.

## Out of scope

- A squash option for Sluice's merge queue, and Sluice's own issues (josegarridodigio/sluice#3, #4).
- TLS on the LAN listener (Tailscale covers the encrypted case).
- Any change to how Claudio reaches Claude Code: still the CLI and its documented controls only.

## Related

[[claudio-mcp-server.md]] · [[claudio-assistant.md]] · [[plans/claudio-mcp-server.md]] ·
[[plans/assistant-write-tools.md]] · [[plans/chat-api-token.md]] · [[security-model.md]] ·
[[securing.md]] · [[tunnel.md]] · [[accounts.md]] · [[context-control.md]] ·
[[plans/context-control.md]] · [[plans/multi-provider.md]] · [[plans/claude-only-fork.md]] ·
[[plans/owner-report-fixes.md]]
