---
created_at: 2026-10-29T19:30:00Z
updated_at: 2026-10-29T19:30:00Z
tags:
    - plan
    - regression
    - security
    - accounts
    - chats
    - guards
    - supervisor
    - mcp
    - collaborators
    - tunnel
    - work-items
    - performance
---
# Plan: the regression fixes of 2026-10-29

Status: **launched as one orchestration** on `fix/regression-2026-10-29` (base `origin/main`
af869016b, 0.11.0). The owner asked for professional fixes of everything the audit found, not
patches: every section below states the end state the code is moved to, and a task builds it.

This plan is the source of truth for the orchestration, with `CLAUDE.md` and `CONTRIBUTING.md`.
Where a task prompt and this plan disagree, the plan wins. The findings themselves, with the
evidence and the line numbers, are in [reports/regression-audit-2026-10-29.md](../reports/regression-audit-2026-10-29.md)
(the **report** below); a task reads its sections before it reads any code. Workers start in fresh
worktrees with none of the audit's context, so each section says what to build, where, and against
which contract.

## Why

The owner reported ten bugs after the large changes of 0.9–0.11 (pending messages, "Send now"
killing background work, rotation stuck at "wait until the reset" with free accounts, guards
firing while off, hints to the wrong session, the MCP failing, collaborators offline, the tunnel's
port collision, the board's drag and drop, the status bar out of sync). The audit found their root
causes and ~90 more defects, among them a critical authentication bypass and a server crash. The
owner's rule: **no band-aids; each area is moved to its proper design.**

## Decisions

- **D1 · Security first and by construction.** The auth guard decides on the matched route, never
  on the raw URL. Every mutating route carries an access class in `ROUTE_DOCS`; a chat's own token
  may call `work` routes and never `person` routes; a test enumerates every registered mutating
  route and fails when a class is missing. The twenty `CHAT_FORBIDDEN*` sets are replaced by the
  classes (the review-gate, collaborators and terminal sets stay as the exceptions under `none`).
- **D2 · One source of truth for the account in use and its limits**: the account reading. The
  provider-wide reading, the second "in use" rule and the three thresholds go. The web reads one
  view.
- **D3 · A chat with background work is never idle-ended.** No idle timer, no eviction and no
  between-turns process end while `runsInBackground(chat.branches)`; a person's account switch waits
  for that work and says so.
- **D4 · "Send now" is never a blind interrupt.** The card offers what the CLI documents: send the
  blocking call to the background (`background_tasks`), cancel a queued message
  (`cancel_async_message`), or interrupt the turn, and says which foreground work an interrupt
  would end. The SDK typings (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts`) are the vendor's
  documented surface; `send_now`/`message_uuid` on `interrupt` are not in them and are not used.
- **D5 · Hints know their author and their addressee.** A health signal carries the agent that made
  the call; the Supervisor reads that agent's steps; an automatic hint says it is automatic; a hint
  about a hung command is a `cancelCommand` with the hint as the reason; one proposal per
  occurrence, never one per kind for ever.
- **D6 · Guards obey the switch.** `integrity` is a rule like the others: no rule on means no guard;
  the plan is re-derived from the current settings at every spawn; the guard folder is swept.
- **D7 · The MCP server answers what the CLI can take and covers the work.** Structural truncation
  that keeps JSON valid under a token budget, paging on every list and detail, reads pre-allowed
  wherever the server is switched on, and curated tools for the orchestration and chat lifecycle,
  proposals, criteria and milestones, all on `work` routes. Deletes, settings, security and
  accounts stay out until the server-side approval of
  [assistant-everything](assistant-everything.md) is built; the assistant's prompt promises only what
  a tool does.
- **D8 · Listings are incremental.** `listSessions()` keeps the last listing, re-checks only what
  the watcher reported, shares its in-flight promise and persists each transcript's fold in SQLite;
  the overview counts from the runtime; nothing on a request path runs synchronous git.
- **D9 · Every task writes the tests the report says are missing** for its area, and no task runs
  the browser suite outside Sluice's `e2e` gate (`verify` tool, `gates: ["e2e"]`, spec prefixes in
  `extra_args`).

## Contracts

Parallel tasks build against these; the task that owns a contract may refine a name and says so in
its result, and the `docs` task records the refinement.

### C1 · Route access classes (owner: `security`)

```ts
// apps/api/src/openapi/routes.ts
type RouteAccess = 'open' | 'person' | 'work';
// d(tag, summary, { access, ... })
```

- `open`: no credential (the existing `OPEN` set). `person`: an owner credential only; a chat
  token answers `403 chat-forbidden`. `work`: an owner credential or the chat's own token.
- Every write route (`POST`, `PUT`, `PATCH`, `DELETE`) must declare `access`; `GET` defaults to
  `work` and may declare `person`. `apps/api/test/route-access.test.ts` enumerates
  `app.printRoutes()` and fails on a write without a class.
- `person`: everything under `/auth`, `/security`, `/accounts`, `/settings`, `/config`, `/memory`,
  `/plugins`, `/push`, `/schedules`, `/tunnel`, `/decisions` (except `POST /decisions/:id/feedback`),
  every `DELETE`, `PATCH /chats/:id` fields `permissionMode`/`allowedTools`/`mcp`, `POST /chats`
  fields beyond `prompt`/`cwd`/`model`/`name`/`projectId` (refused with `403` naming the field),
  `POST /chats/:id/permissions/:requestId`, `PUT /chats/:id/mcp/:name`, `PUT /chats/:id/claudio-mcp`,
  `POST /projects/:id/journal`, pull-request and integrate routes, Supervisor send/dismiss,
  review accept, spend-pass, `POST /uploads` stays `work`.
- `work`: chat and orchestration lifecycle (`POST /chats`, messages, resume, fork, stop, interrupt,
  hint, compact, notes; orchestrations create/plan/stop/resume/retry/skip/hint/verify/review-retry),
  work items create/update/move/comment/links/criteria/milestones read, assistant proposals
  accept/discard, flow-run retry, journal read, documents read.
- The guard: `isGuarded` takes `req.routeOptions.url` (the matched pattern); an unmatched request
  is guarded unless it is the SPA fallback; a `req.url` that does not start with `/`, or whose
  `decodeURI` differs from itself, is `400`. Tests: `/%61pi/health`, `GET http://x/api/health`,
  `/api/../api/health` under token mode.
- Events: `login.updated` carries `url` and `code` only on a stream opened with an owner
  credential; a chat token's stream gets the session without them.
- Back-off: keyed by `${ip}|${host}`, and a credential whose hash last succeeded skips the wait.
- Audit: anonymous refusals go to a separate ring of 1 000 rows (`audit_refusals`), never into the
  50 000-row log; the stored path is cut at 512 chars.

### C2 · Pending messages carry their source (owner: `delivery`)

```ts
// packages/shared/src/types.ts
export type ChatMessageSource = 'person' | 'supervisor' | 'claudio';
export interface ChatPendingMessage { …; source: ChatMessageSource }   // `person` when absent in stored rows
export interface MessageDelivery { …; source?: ChatMessageSource }
// packages/core/src/chat-service.ts
hint(id: string, text: string, opts?: { source?: ChatMessageSource }): Promise<ChatRuntime>
// prefixes: CHAT_HINT_PREFIX (person) · AUTO_HINT_PREFIX = 'An automatic hint from Claudio, not from the person following this chat:'
```

- `hint()` goes through the chat's `sending` chain like `send()`.
- The page draws a `supervisor`/`claudio` card as a notice (no "Send now", a "Dismiss" that calls
  `DELETE /chats/:id/messages/:messageId`).
- `POST /chats/:id/interrupt` keeps `{ messageId? }`. New:
  - `POST /chats/:id/commands/:toolUseId/background` → the CLI's `background_tasks { tool_use_id }`
    control request; `409 not-running` when the call is not a running foreground call.
  - `DELETE /chats/:id/messages/:messageId` → `cancel_async_message { message_uuid }`; `409` once
    the agent took it. Removes the pending entry and streams `delivery: { state: 'undelivered', reason: 'cancelled' }`.
  - `GET /chats/:id` `pending[]` entries gain `blockedBy?: { toolUseId, name, description? }` when
    the turn is inside a foreground call (an `Agent`/`Task` or a command).
- `written` is bounded: after a result, ids the interrupt receipt's `still_queued` does not hold are
  settled `undelivered` with `reason: 'not-read'`; a `written` entry never keeps a chat `busy`
  past one result.
- A process that `exit`ed without `close` is closed by a 3 s timer that destroys its pipes.
- `carried` is emitted where the doc promises it (limit replay, move); `replayWith` keeps the
  waiting ids.

### C3 · Health signals name their agent (owner: `guards-supervisor`)

```ts
// packages/core/src/health.ts
export interface ToolCall { …; parentToolUseId?: string }
// packages/shared/src/types.ts
export interface HealthSignal { …; agent?: { parentToolUseId: string; description?: string; subagentType?: string } }
```

- `trace()` keeps `parentToolUseId` from the sidechain entries; a signal built from a subagent's
  call carries `agent`; the Supervisor's prompt gets that agent's steps (its transcript branch), and
  the hint it sends to the lead starts "Your background agent `<description>` …" and asks the lead
  to relay or stop it.
- `hung-command` and `repeat-stall` in Active mode: `cancelCommand(toolUseId)` with the hint as the
  reason, then the hint as a `supervisor` message (C2) only when the cancel was refused.
- `supervisor_proposals`: the unique index becomes `(chat_id, signal, occurrence)` where
  `occurrence` is the signal's `toolUseId` or `since`; a migration rebuilds it; `failed` entries
  expire after 15 minutes; a slot or memory refusal is retried, not counted as failed.
- The Supervisor's housekeeping chat is confined like the decision one-shot (`settingSources: []`,
  no MCP) with its own cap `decisions.cli.supervisorMaxCostUsd` (default 0.25).

### C4 · Accounts (owner: `accounts-core`; `accounts-web` builds against it)

```ts
// packages/shared/src/types.ts
export interface AccountsSettings { …; preferred: string | null; order: string[] }
export interface AccountInUse { id; label; kind; signInState; checkedAt; limit: AccountLimit | null; plan: string | null }
export interface AccountView { inUse: AccountInUse | null; inUseReason: string | null; accounts: Account[]; atLimit: boolean; nextReset: string | null; settings: AccountsSettings }
// Core.accountView(): AccountView   · overview.accounts: AccountView   · GET /auth.inUse = accountView().inUse
// event: { type: 'accounts.changed' } (debounced 250 ms from AccountStore.onChange; invalidates accounts, auth, overview, providers)
// packages/accounts/src/thresholds.ts: NEAR = 0.6, EXHAUSTED = 1, bars WARN = 0.6, BAD = 0.75; the rotation threshold comes from settings
```

- `PUT /accounts/settings` accepts `preferred` (an enabled account id or `null`) and `order`
  (every enabled account id once; the `order` strategy follows it). `choose`: a pin wins; then the
  preferred account while it has room and the chat's policy allows it; then the strategy. A project
  policy wins over the global preference. `rotateOnLimit` off still means a person's chat waits.
- `accountInUse()` = `accountView().inUse`; the ghost default (no credential) is excluded inside
  `AccountStore.list()` for every caller.
- `limitReadings()` and the detector derive Claude's `ProviderLimit` from `inUse.limit`;
  `ProviderLimits.observeProbe`, `HandshakeLimits`, the detector's TTL re-read and
  `accountsAtLimit` are removed; the stream's `rate_limit_event` feeds only the account it ran on.
- `limitReplays` resets when a turn completes without error and never blocks a move to another
  account; `pick` gets `chat.opts.model` (none or `default` → no model filter); a `rejected` event
  with `isUsingOverage` or a scoped `rateLimitType` goes to `cli.scoped`, never to `windows`; a
  `get_usage` with `rate_limits_available: false` updates only `cli`; a wait's `resetsAt` comes
  from `chooseNext(...).waitUntil`; `cooldownSeconds` records a per-account `outUntil` for a
  rejection without a reset; a fork keeps `account` and `opts.account`.
- `AccountStore.remove` answers `409 account-in-use` with the chat ids while a live chat runs on the
  account; `observeSignIn` and every fold path use a nullable `find`; the stream line handler
  catches and records a protocol failure; `apps/api/src/server.ts` and `packages/core/src/launcher`
  install `unhandledRejection`/`uncaughtException` handlers that log and keep the process up.
- `GET /accounts` and `/accounts/settings` document the new fields; schemas regenerated.

### C5 · The environment is the chat's (owner: `mcp`)

`environments` is keyed by chat id (`chat_id` column, migration copies the cwd rows under the
chats that last used them); `GET /chats/:id.environment` is the chat's own, with
`environment.source: 'chat' | 'folder'` when it falls back to the folder's last.

### C6 · MCP results and catalogue (owner: `mcp`)

- `render(value, budget)` cuts structurally: arrays are shortened from the end, strings over 2 000
  chars cut with `…`, nested objects beyond depth 6 replaced by `{"…": true}`, until the compact
  JSON is under `RESULT_BUDGET_CHARS = 24_000`; the result stays valid JSON and carries
  `truncated: { arrays: n, strings: n }` and a `hint` naming the paging arguments.
- `get_chat { id, limit? (default 10), before?, entries?: 'summary' | 'full' (default summary) }`
  answers a projection: id, title, state, model, cost, control, counts of children, executions
  (last 3), and entries with tool results cut at 500 chars in `summary`. `list_chats` defaults
  `limit` 25; `read_document { path, offset?, limit? }` pages by line; `list_documents { depth? }`.
  `get_usage` defaults `from`/`to` to the server's local day. `update_work_item` criteria accept
  `id`; new `check_criterion`, `list_milestones`, `list_assistant_proposals`,
  `launch_orchestration` (`POST /orchestrations` with a spec), `plan_orchestration`,
  `stop_orchestration`, `resume_orchestration`, `send_chat_message`, `stop_chat`, `resume_chat`,
  `fork_chat`, `interrupt_chat`, `hint_chat`, `retry_flow_run` kept. `start_chat` resolves the
  project's path from `GET /projects`.
- `claudio-mcp.ts` pre-allows `CLAUDIO_MCP_READ_TOOLS` whenever the `claudio` toolset is on, in the
  file and in the live `mcp_set_servers` push; `POST /chats` refuses an unknown model (`400
  model-unknown`, from the provider's model list and the aliases); `main.ts` catches per line and
  answers `-32603`.
- `claudio-assistant-prompt.ts` is generated from the catalogue's descriptions (a test asserts every
  capability sentence names a tool).

### C7 · Transcript listing (owner: `perf-listing`)

- `transcript_folds (path PRIMARY KEY, ino, size, mtime_ms, end_offset, summary_json, updated_at)`
  in `db.ts`; `listSessions()` reads it, re-reads only files whose stat changed or that
  `SessionsWatcher` reported, shares one in-flight promise, and never parses a transcript on the
  main thread beyond its unread tail.
- `cliSessions()` comes from the `/proc` scan (`processes.ts`) on Linux and from `claude agents
  --json` elsewhere, with a 30 s TTL invalidated by `forgetHolders()`.
- `GET /overview` counts background tasks, subagents and workflows from the runtime; cached 2 s and
  invalidated by bus events. `GET /chats` filters `project` before `assemble` and takes `limit`
  (default 200; the web pages). `GET /usage*` share one `spends()` per listing generation.
  `GET /projects`: `readAll` and `coreConfigOf` cached and invalidated on write; `repoFromGit`
  async, serving the stored placement meanwhile. The health monitor's `fingerprint` is async.
  `UV_THREADPOOL_SIZE=16` set by the launcher, the API entry and the desktop's `server-process.ts`
  unless already set.

### C8 · Tunnel port (owner: `collab-tunnel`)

`tunnel-settings.json` gains `port` (default 8444); `GET/PUT /tunnel/settings` (added if absent)
read and change it (`1024–65535`, refused while the tunnel runs); `tunnel.portTaken` answers with
`holder` (the `serve status` summary of what holds the port) and the tab offers the port field and
"Use the next free port"; Helm exposes `tunnel.port`.

### C9 · Board moves (owner: `board`)

In All projects the client computes `afterId` among the cards of the moved item's project only, and
draws the drop indicator inside that group; the server keeps its rule. `useMoveWorkItem` writes
`MoveWorkItemResult` into the cache on success, scopes moves serially, and applies the inverse
patch on failure.

## Design notes per area

### Delivery (report §1, D3, D4)

- `chat-fold.ts`: after a result, `written` ids are reconciled against the CLI's queue; the idle
  path checks `runsInBackground`; `reportsDelivery` comes from the handshake (`--replay-user-messages`
  known for the CLI version), not from the first result.
- `chats.ts`: `interrupt` clears `interruptRequested` when the receipt says no turn was under way;
  the 409 guard reads the state after draining the stdout buffer (await a `setImmediate`);
  `endProcessBetweenTurns` for a person's account switch waits for background work with a notice;
  `exit` without `close` → 3 s timer destroys pipes.
- Driver (`providers/claude-code`): `backgroundTask(toolUseId)` and `cancelMessage(uuid)` control
  requests, typed from `sdk.d.ts`, with tests on the fake CLI.
- `chat-ui`: cards by `source`; a card whose message is `blockedBy` a foreground call shows "Send
  to background and deliver" and "Interrupt the turn (ends: <name>)"; `dismissed` persisted per
  chat in `sessionStorage`; the `queued_command` timestamp shows the absorb time (the `delivered`
  event's).

### Accounts (report §2, D2)

The web (`accounts-web`): `StatusBar`, `AccountChip`, `ProviderDot`, the phone cards and
`LimitBanner` read `overview.accounts`; `LimitBanner` shows "Switch account" (the composer's picker)
and "Run now"; `AccountCard` gets "Use this account" (sets `preferred`) and the `Preferred` tag;
`RotationCard` gets the reorderable `order` (reuse `PoliciesCard`'s list) and disables the fields
while the switch is off; the org and the kind get a separator; "hoy, sin coste" only when the day
has no cost reported; `Accounts.tsx` drops its 10 s poll in favour of `accounts.changed`.

### Guards and Supervisor (report §3, D5, D6)

`resolve.ts` treats `integrity` as a switchable rule in `GUARD_RULE_IDS` with its own setting
(default on while the guard is on); `GuardsCard` tags "Active" only when a rule is on; `spawnProcess`
takes the plan from `guardsForChat(current settings)` unless the caller passes one; `guardsForChat`
takes `policy` and `confined` (assistant runs get `null`); `startGuardSweep` runs from the `Core`
constructor and stops in `shutdown()`; the review gate retries memory refusals by error class.

### MCP (report §4, D7, C5, C6)

The test fixture carries request bodies; every write tool is tested against the real route table
(`ROUTE_DOCS` keys), so a tool calling a route that does not exist fails the suite.

### Collaborators and tunnel (report §5, C8)

`host-client.ts`: `post()` refuses while `restartTimer` is pending (the request fails
`unreachable`) and every spawn with options set enqueues `start` first; `outbox` cleared in
`lost()`; `start-error` becomes `connection: { state: 'error', message }` with a retry backoff;
`onStatus` pokes peers and retries pending joins on every transition to `online`; `retryPending`
has an in-flight guard and serialises the file updates under the roster lock; a dial that times
out closes the late connection; `watch` errors go through `schedule(peer, false)`; `lastSyncedAt`
is persisted per share; join and leave: `sendLeave` is fire-and-forget with a retry queue, `join`
answers `202` when the owner is unreachable and the UI shows the pending state; `?refresh=1`
short-circuits on an offline peer. `tunnel.ts`: `wanted`/`opening` set before the first await;
`serveConfig()` returns `{ config } | { error }` and the reason carries tailscale's first URL line;
one parser for `serve status --json`; `shutdown()` async with a 4 s bound.

### Board (report §6, C9)

`BoardColumns`: `grab` cleared on blur and when the card leaves `columns`; `draggable` not tied to
`grab`; a document-level `dragend` resets `dragId`; coarse pointers get the move menu; the item
panel's move uses `useMoveWorkItem`; the `InfiniteData` pages get the optimistic update; `moving`
and `byRank` removed; e2e specs for a downward drag, the last position, an empty column, a
cross-column drag, All projects, refusal and rollback.

### Web wiring (report §10, §7.1, §7.3)

`events.ts`: the orchestration detail's sub-queries move to `['orchestration', id, …]`; patchers
guard `Array.isArray`; invalidations and `dispatchEvent` run before the patchers and each patcher is
isolated; `mcpKey` moves out of `chatScope` with `retry: false`, refreshed on `health.changed` and
the panel; `Notifications` re-seeds after a resync (`onResync` hook from `events.ts`); "Today" uses
`spend.data.day` and `['usage']` invalidates on `spend.changed`; the root route gets an
`errorElement` with a localised `Empty`; `first-run.ts` hides the wizard only with no data;
`lazyPage` retries a failed chunk once; the direct `fetch` callers go through `request()`;
`ChatView` resets `restore` on id; the fixed-interval polls listed in the report follow the feed;
the dead exports, orphan i18n keys and unreferenced CSS of §10.8 and §7.7 are removed (keep the
e2e selectors); `ContextRing` lives once, in `chat-ui`.

### Hygiene (report §8.7, §11)

`@claudio/accounts` and `e2e/fake-cli/*.test.mjs` in `pnpm test` and CI; `isRecord`, `errorMessage`,
`sleep`, `readJson`, `hourMinute` consolidated in `@claudio/shared` / `@claudio/ui` and every copy
replaced; `ROLE_TITLES_ES` moved to the web's i18n; the uploads payload stored under a fixed name;
`OrchestrationPullRequestError` and the other `Error` subclasses without `statusCode` mapped to 4xx
in their routes; the `not found` regex in `app.ts` removed in favour of typed errors; the dead
exports of §9.9 and §11.6 removed; the docs drift of §11.3 repointed; `docs/status.md` counts
generated by a script; `CLAUDE.md` Layout lists `packages/accounts` and `packages/mcp`;
`package.json` `lint` covers every package that has an eslint config.

## Tasks

One orchestration, two stages in series: eleven implementation tasks → `{hygiene, docs, review}`.
Each task in its own worktree; `limits` unset (no ceiling, the owner's choice). Models and efforts
as the table says (`opus` = `claude-opus-5-5`, `sonnet` = `claude-sonnet-5-5`).

| Task | Model · effort | Builds | Owns (others touch these only where named) |
|---|---|---|---|
| `security` | opus · high | D1, C1 (classes, guard on the matched route, login events, back-off key, audit ring), report §8.1–8.6, §8.8 CSRF `Origin` check under `none` for non-GET, push endpoint public-address check | `apps/api/src/security.ts`, `apps/api/src/openapi/routes.ts` (the `access` field and every write's value), `apps/api/src/routes/events.ts`, `apps/api/src/routes/chats.ts` (permissions route and the `POST /chats` field refusal only), `packages/core/src/setup/logins.ts`, `packages/core/src/push.ts` (endpoint check), `packages/core/src/db.ts` (`audit_refusals`), `apps/api/test/route-access.test.ts`, `apps/api/test/security.test.ts`, `docs/security-model.md` section "Chat tokens" |
| `accounts-core` | opus · high | C4 (core side), report §2.1–2.9, §4.12, D2 | `packages/accounts/src/*`, `packages/accounts/test/*`, `packages/core/src/rotation.ts`, `accounts-at-limit.ts`, `providers/limits.ts`, `providers/detector.ts`, the account parts of `packages/core/src/chats.ts` (`observeSignIn`, `observeAccount`, `chooseAccount`, `chooseNext`, `roomFor`, `limitReplays`, `maybeLimit`, `fork`'s account, the stream line handler's try/catch), `packages/core/src/index.ts` accounts section (`accountView`, `accountInUse`, `limitReadings`), `apps/api/src/routes/accounts.ts`, `apps/api/src/server.ts` and `packages/core/src/launcher` process handlers, `packages/shared/src/types.ts` accounts section, schemas, `packages/core/test/*rotation*`, `*limit*`, `*account*` |
| `accounts-web` | opus · medium | C4 (web side), report §2.4, §2.10–2.11 web, the Accounts page items of the plan `assistant-everything.md` §6 (separator, "hoy, sin coste", rotation fields, duplicate "Apartar", "read 7 s ago") | `apps/web/src/components/shell/StatusBar.tsx`, `ProviderDots.tsx`, `ProviderRow.tsx`, `apps/web/src/lib/accounts.ts`, `apps/web/src/pages/accounts/**`, `apps/web/src/pages/Accounts.tsx`, `apps/web/src/pages/chat/LimitBanner.tsx`, `apps/web/src/lib/events.ts` (the `accounts.changed` entry only), i18n `en`/`es` for these, `e2e/specs/accounts*`, `status-bar*` |
| `delivery` | opus · xhigh | C2, D3, D4, report §1.1–1.4, §1.6–1.10, §9.9's `evictable` background check | `packages/core/src/chat-fold.ts`, `live-chat.ts`, `packages/core/src/chats.ts` (pending, idle, interrupt, `drainQueue`, `leaving`, `endProcessBetweenTurns`, `spawnProcess`'s exit/close handling, `replayWith`), `chat-service.ts` (`hint`, `send`, `cancelCommand`'s reason), `packages/core/src/providers/claude-code/*` (the two control requests), `apps/api/src/routes/chats.ts` (interrupt body, the two new routes), `packages/shared/src/types.ts` chat delivery section, `packages/chat-ui/src/composer/**` (`queued.ts`, `Composer.tsx`, the cards), `apps/web/src/pages/ChatView.tsx` send-now wiring, `docs/chat-delivery.md`, tests in `packages/core/test/chat-delivery*`, `apps/api/test/chats*`, `packages/chat-ui/test/*queued*`, e2e `chat-delivery*` |
| `guards-supervisor` | opus · high | C3, D5, D6, report §3.1–3.10, §1.5 attribution, §1.7 (`interruptRequested` and `guard-missing`) | `packages/core/src/guards/**`, `packages/core/src/health.ts`, `health-service.ts` signal attribution (not the git fingerprint, which `perf-listing` owns), `chat-model.ts`, `supervisor.ts`, `packages/core/src/decisions/settings.ts`, `db.ts` (`supervisor_proposals` migration), `index.ts` (`guardsForChat`, `askSupervisor`, the sweep), `chats.ts` `trace()` and the guard plan at spawn, `review-gate.ts` refusal retry, `apps/web/src/pages/config/GuardsCard.tsx`, `packages/shared/src/types.ts` health section, `docs/guards.md`, `docs/decision-engine.md`, tests `packages/core/test/guards-*`, `supervisor*`, `stuck-signals*`, `health*` |
| `mcp` | opus · high | C5, C6, D7, report §4 whole | `packages/mcp/**`, `packages/core/src/claudio-mcp.ts`, `claudio-assistant-prompt.ts`, the `environments` map and table (`chats.ts` `environments`, `chat-fold.ts` the one `host.environments.set` line, `chat-service.ts` `environmentOf`, `db.ts` migration), `chats.ts` `setClaudioMcp`/`dynamicClaudioServer`, `apps/api/src/routes/chats.ts` model check on `POST /chats` (`chat-service.ts` `start`), `docs/claudio-mcp-server.md`, `docs/claudio-assistant.md`, new routes' docs rows |
| `perf-listing` | opus · xhigh | C7, D8, report §9.1, §10.2 server side (`mcpServers` answers `{live:false}` without a control request when the session is busy longer than 2 s) | `packages/core/src/sessions.ts`, `transcript-index.ts`, `jsonl-cache.ts`, `event-sources.ts`, `chat-service.ts` (`facts`, `list`, `allActivity`, `activityChats`, `entriesOf`, `spends`, `cliSessions`, `mcpServers`), `cli.ts`, `processes.ts`, `index.ts` (`overview`, `projects`, `usageReport`), `repos.ts`, `project-settings.ts` (`readAll` cache), `health-service.ts` `fingerprint` only, `git.ts` (async helpers), `usage-report.ts`, `usage-series.ts`, `db.ts` (`transcript_folds`), `apps/api/src/routes/system.ts`, `routes/chats.ts` `limit` on the list, `apps/desktop/src/server-process.ts` and the launcher's env for `UV_THREADPOOL_SIZE`, `apps/web/src/api.ts` chats paging, a benchmark script `scripts/listing-bench.mjs` with before/after numbers in its result, tests |
| `orchestrator-core` | opus · high | report §9.2–9.8, §9.9 (except `evictable`, which `delivery` owns), async git in integration | `packages/core/src/orchestrator.ts`, `verification.ts`, `workflow-journal.ts`, `workflows.ts`, `flow.ts` (the claim/try), `schedules.ts`, `db.ts` (chat trim orphan rows, statement cache helper), `chats.ts` (`spawnProcess` sync failure, `stopAll` grace), `index.ts` `shutdown()` ordering, tests `packages/core/test/orchestrat*`, `verification*`, `flow*`, `schedules*`, `db*` |
| `collab-tunnel` | opus · medium | C8, report §5 whole | `packages/core/src/collab/**`, `packages/core/src/tunnel.ts`, `apps/api/src/routes/collaborators.ts`, `routes/tunnel.ts`, `apps/web/src/pages/collaborators/**`, `apps/web/src/pages/config/RemoteAccessTab.tsx`, `apps/web/src/lib/api/collaborators.ts`, `deploy/helm/**` tunnel values, `docs/collaborators.md`, `docs/tunnel.md`, tests `packages/core/test/collab-*`, `tunnel*` |
| `board` | opus · medium | C9, report §6 whole | `apps/web/src/pages/tasks/**`, `apps/web/src/lib/work-items.ts` move hook, `apps/web/test/tasks-board*`, `e2e/specs/tasks-board*`, `docs/work-items.md` board section |
| `web-wiring` | opus · medium | report §10.1, §10.3–10.8, §7.1, §7.3, §7.7, §11.4; `mcpKey` out of `chatScope` (client side) | `apps/web/src/lib/**` (except the `accounts.changed` entry), `apps/web/src/main.tsx`, `App.tsx`, `components/**` (except the shell's account items and `GuardsCard`), `pages/OrchestrationDetail.tsx`, `pages/ChatView.tsx` (`restore` only), `packages/chat-ui/src/composer/ServersPanel.tsx` (the key), `packages/chat-ui/src/components/{ContextRing,TranscriptSearch}.tsx`, `packages/chat-ui/src/lib/{chat-notice,chat-stream}.ts` dead code, `apps/web/src/styles/*.css` dead classes, i18n orphan keys, tests |
| `hygiene` | opus · medium · depends on every task above | the Hygiene design note, report §8.7, §11.1–11.3, §11.5–11.7, §9.9 dead exports | `package.json`, `.github/workflows/ci.yml`, `packages/shared/src/{guards,errors,time}.ts` (new shared helpers), every file that holds a consolidated copy, `packages/core/src/uploads.ts`, `apps/api/src/app.ts` error mapping, `apps/api/src/routes/orchestrations.ts` PR error, `docs/status.md`, `scripts/docs-status.mjs`, `CLAUDE.md`, `e2e/timings.json`, the broken links of §11.3 |
| `docs` | sonnet · medium · depends on every implementation task | every doc an implementation task names, `docs/accounts.md`, `docs/chat-delivery.md`, `docs/guards.md`, `docs/claudio-mcp-server.md`, `docs/collaborators.md`, `docs/tunnel.md`, `docs/work-items.md`, `docs/security-model.md`, `docs/rest-api.md` rows, a decision record `docs/decisions/route-access-classes.md`, this plan's Outcome and the contract refinements | `docs/**` |
| `review` | opus · high · depends on every implementation task | reviews the merged design against this plan and the report: every decision D1–D9 present, every contract as written or refined with a note, no `CHAT_FORBIDDEN*` set left behind, no provider-wide limit path left, no sync git on a request path; small fixes only, findings in its result | findings and small fixes only |

**Patterns to follow** (read at these places by the plan's author; open the file and find them by
name, the line is a pointer):

- The raw-URL guard to replace: `apps/api/src/security.ts:744` (`isGuarded`) and `:895` (where it
  is called); the matched route is on `req.routeOptions.url` in any `onRequest` hook.
- A route doc entry: `d(tag, summary, { description, params, ok })`, `apps/api/src/openapi/routes.ts:218`.
- The fold path that throws: `observeSignIn`, `packages/core/src/chats.ts:1813`; the line handler
  with no guard, `chats.ts:1988`; a guarded sibling, `observeLimit`, `chats.ts:312`.
- The replay counter: `MAX_LIMIT_REPLAYS`, `chats.ts:123`, read at `:2168`, reset at `:770`.
- The resolved model overwriting the asked one: `chat-fold.ts:62`; what was asked: `modelOf`,
  `chats.ts:2199`.
- The idle path after a result: `chat-fold.ts:358-382`; `evictable`, `chats.ts:872`; `leaving`,
  `chats.ts:1117`; `interrupt`, `chats.ts:1214`; `cancelCommand`, `chats.ts:655`.
- Guard rules resolved: `packages/core/src/guards/resolve.ts:80`; armed again in
  `guards/decide.ts:52`; the once-per-signal index, `db.ts:195`; the Supervisor's pick,
  `supervisor.ts:221`.
- The MCP cut: `packages/mcp/src/server.ts:33` (`render`); the pre-allow list,
  `packages/core/src/claudio-mcp.ts:162`; the missing route, `packages/mcp/src/write-tools.ts:144`.
- The collab restart race: `packages/core/src/collab/host-client.ts:232` (`post`), `:305` (`lost`);
  the tunnel start race: `packages/core/src/tunnel.ts:437-467`.
- The server's move rule: `packages/core/src/work-items.ts:621`; the client's `afterIdFor`,
  `apps/web/src/pages/tasks/board/model.ts:74`.
- The cache patchers: `apps/web/src/lib/events.ts:538` and `:572`; the keys they hit,
  `apps/web/src/pages/OrchestrationDetail.tsx:243` and `:394`; the handler order, `events.ts:684-694`.
- The double listing: `chat-service.ts:390` (`facts`) and `:1339` (`activityChats`); the CLI spawn,
  `cli.ts:10`; sync git on the request path, `health-service.ts:68-81` and `git.ts:18`.
- The unhandled resume: `orchestrator.ts:3612-3622`.
- A SQLite table added by migration: `openai_conversations`, `packages/core/src/db.ts` (find by
  name); every migration runs in its own `BEGIN IMMEDIATE`.
- The restore state that leaks: `apps/web/src/pages/ChatView.tsx:113`, `:135`, `:501`; the route
  without a key, `App.tsx:411`.
- Tests: `packages/core/test/accounts-rotation.test.ts`, `orchestration-limit-account-switch.test.ts`,
  `supervisor.test.ts`, `stuck-signals.test.ts`, `collab-host.test.ts`, `apps/api/test/security.test.ts`,
  `packages/mcp/test/write-tools.test.ts` (its stub of `GET /projects/:id` is the anti-pattern),
  `apps/web/test/tasks-board.test.ts`, `e2e/specs/tasks-board.spec.mjs`.

**Rules for every task.**

- Read this plan whole first, then the report's sections your row names, then `CLAUDE.md` and
  `CONTRIBUTING.md`. Do exactly your task, touching only what its row owns; the plan wins over
  older docs. Re-verify every cited line in the code before relying on it.
- No band-aids: when a finding's "Fix" line and this plan's design differ, build the design. A
  defect you find on the way that is outside your row goes into your result under "For the
  review", not into your diff.
- TypeScript strict, no `any`, `noUncheckedIndexedAccess`; English for code, comments, docs and
  commits; Conventional Commits with a body saying why; never push.
- Verify through Sluice's `verify` tool with your worktree as `working_directory` (`lint`,
  `typecheck`, `test`; `e2e` with the spec prefixes you touched in `extra_args`), never by running
  the gate commands through the shell. A `KILLED for lack of memory` result is not a flake: lower
  the footprint or say so. Never run `pnpm e2e` yourself and never set `E2E_ALLOW_LOCAL` or
  `SLUICE_JOB`.
- After changing `packages/shared/src/types.ts` run `pnpm --filter @claudio/api openapi:schemas`
  and commit the result. Every new or changed route: summary, tag and `access` in
  `apps/api/src/openapi/routes.ts` and a row in `docs/rest-api.md`.
- Never start a Claudio server with the inherited environment (it is the owner's live app:
  `CLAUDIO_DATA_DIR`, `PORT`); if one is needed, start it isolated with
  `env -u CLAUDIO_DATA_DIR -u PORT -u CLAUDIO_WEB_DIST -u CLAUDIO_API_URL -u CLAUDIO_API_TOKEN`, a
  temp data dir and free ports, and kill its process group after. Never spend tokens on a real
  Claude turn: tests drive the fake CLI. Never read or write `/home/yeyo/.config/Claudio`.
- Never touch `/home/yeyo/Escritorio/shipcast`, `/home/yeyo/Escritorio/trading-bot` or any other
  project of the owner.
- Wrap every long command in `timeout`; never wait on a process with an unbounded loop.
- End with a short result: what you built, each contract you refined and how, the tests you added,
  what you could not do and why, and "For the review" items.

### Checklist (what the tasks above cover)

1. `/%61pi/health`, absolute-form and `/api/../` requests are guarded; a write route without
   `access` fails the suite; a chat token gets `403` on every `person` route and `200` on `work`.
2. A chat token's event stream never sees a sign-in code; the back-off never locks a valid
   credential out; 60 000 anonymous refusals leave the audit log intact.
3. Removing an account under a live chat answers `409`; a fold on an unknown account logs and goes
   on; the process survives an unhandled rejection with a log line.
4. A second limit after a wait-replay rotates; a chat started on `default` never waits on the
   resolved model; the banner never shows on a chat that did not hit a limit; `get_usage
   available:false` keeps the exhausted state; a fork keeps its account; `preferred` and `order`
   drive the choice under the rules of C4; the status bar and the cards agree.
5. A message taken without a read-back settles within one result; nothing idle-ends a chat with
   background work; "Send now" on a turn inside a foreground `Agent` offers the background route;
   a Supervisor card has no "Send now"; `carried` is emitted; an exited-not-closed process is closed.
6. Every rule off means no guard file is written and no hook installed; a respawn after the switch
   goes off carries no guard; the guard folder is swept; the assistant gets no guard.
7. A signal from a subagent's command names the agent; the hint tells the lead to relay; a hung
   command is cancelled; a second occurrence of the same signal kind gets a proposal; a slot
   refusal is retried.
8. `get_chat` on a 3 000-message chat answers valid JSON under the budget; `list_chats {}` too;
   `start_chat` with a project works; reads are allowed when switched on from "+"; every write tool's
   route exists in `ROUTE_DOCS`; an orchestration can be launched, stopped and resumed from the
   assistant; the prompt test passes.
9. `GET /overview` on 1 400 transcripts answers under 150 ms warm (the benchmark script's number in
   the task result); no `execFileSync` of git remains on `GET /chats/:id`, `/overview`, `/projects`
   or in the health monitor; a restart does not re-parse unchanged transcripts.
10. A request during the collab host's restart backoff fails fast and the host still binds; a bind
    error is shown and retried; coming back online pokes peers; two tunnel starts leave one rule;
    the tunnel's port is a setting.
11. All-projects moves land where dropped; a stuck grab cannot disable drag; a refused move rolls
    back once; the e2e specs of C9 pass through Sluice.
12. A workflow-engine orchestration's page open does not break the event handler; notifications
    re-seed after a resync; "Today" uses the server's day; a render error shows a localised page.
13. `pnpm test` runs `@claudio/accounts` and the fake-CLI self-tests; the shared helpers have one
    copy; `docs/status.md` counts are generated; no broken wiki link under `docs/`.

## Measures

The benchmark script's before/after for `/overview`, `/chats`, `/projects`, `/usage` on the owner's
data, the tray's timeout count after a day on the new build, and the count of `CHAT_FORBIDDEN*`
sets left (zero).

## Risks

- Several tasks touch `packages/core/src/chats.ts`; each row names the functions it owns and the
  integration merges the branches. A conflict is the integrator's, resolved by hand if needed.
- The owner runs 0.8.1 on this machine; the orchestration runs on that server. Its guards are off
  for automated work, so §3 does not bite the workers.
- `UV_THREADPOOL_SIZE` and the listing cache change behaviour on every install; the benchmark and
  the tests are the evidence.

## Outcome

*(written by the `docs` task)*

## Related

[[reports/regression-audit-2026-10-29.md]] · [[plans/assistant-everything.md]] · [[accounts.md]] ·
[[chat-delivery.md]] · [[guards.md]] · [[decision-engine.md]] · [[claudio-mcp-server.md]] ·
[[collaborators.md]] · [[tunnel.md]] · [[work-items.md]] · [[security-model.md]] ·
[[orchestrations.md]] · [[status.md]]
