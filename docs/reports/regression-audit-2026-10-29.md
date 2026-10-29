---
created_at: 2026-10-29T18:30:00Z
updated_at: 2026-10-29T18:30:00Z
tags:
    - audit
    - regression
    - accounts
    - guards
    - supervisor
    - mcp
    - chats
    - collaborators
    - tunnel
    - work-items
    - performance
---
# Regression audit of 2026-10-29 (origin/main af869016b, 0.11.0)

An end-to-end code audit asked for by the owner after the large changes of 0.9–0.11, driven by the
bugs they reported. Eleven auditors (Opus 5.5 on delivery, accounts, MCP, guards/Supervisor and
core; Sonnet 5.5 on the rest) each read one area of a clean worktree at `origin/main`; the
coordinator verified every finding marked **verified** by reading the cited lines itself, and
collected live evidence from the owner's running install. Nothing was run through the test suites
and nothing was changed.

Severity: **critical** loses data or takes the server down; **high** a reported bug or a
user-visible failure with a clear path; **medium** a wrong behaviour that needs a specific situation;
**low** hygiene, dead code, drift.

## 0. Facts about the owner's install that frame every reported bug

- **The desktop app on this machine is 0.8.1** (`dpkg -l claudio`, server `/opt/Claudio/resources/server/server.mjs`),
  installed 2026-10-20. The auto-updater fails on this machine: `desktop.log` records
  `updater error: pkexec must be setuid root` / `Command pkexec exited with code 127` on 10-18
  and 10-20 and the update state stays `error`. So every symptom the owner saw came from 0.8.1,
  reached at `192.168.0.30:8791` through `socat`. Where this matters, each finding says whether
  main still has it. The accounts, rotation and guard code paths are the same in 0.8.1 and main.
- **`feat/assistant-everything` is a plan only.** The branch holds one commit, the 577-line
  `docs/plans/assistant-everything.md` (2026-10-25). None of its MCP fixes, server-side approvals,
  LAN listener, preferred account or handoff was built; every bug its §1 and §4 list is still on
  main (section 4 below).
- **Guards on the install:** `data/guards.json` is `mode: observe`, `automated: false`, every rule
  `false` (changed 10-28); 310 per-chat files under `data/guards/` all carry `mode: enforce` and
  `rules: ["integrity"]`; 157 `guard_events`, all from 10-17 to 10-20, almost all
  `integrity.too-deep` / `integrity.unknown-target`.
- **Decisions:** provider `jev`, `supervisor.intervene` active at threshold 0.85, CLI cap raised to
  $5. 92 of 92 Supervisor proposals were sent; the pipeline itself works (section 3).
- **Server crash in the log:** 2026-10-25 07:22:56 `The Claudio server stopped unexpectedly: The
  server exited with code 1`, with the stack `Error: account acc-79ffec12 not found` at
  `AccountStore.get` ← `_ChatManager.observeSignIn` ← `foldResult` ← stream line handler
  (finding 2.1).
- **Latency of the API** (from `server.log` and `server.log.1`, ~81 000 requests, desktop 0.8.1):

  | Route | n | p50 ms | p95 ms | max ms |
  |---|---|---|---|---|
  | `GET /api/overview` | 12 402 | 690–860 | 2 550–2 860 | 40 326 |
  | `GET /api/projects` | 4 571 | 1 116–1 762 | 3 462–3 788 | 41 743 |
  | `GET /api/usage` | 4 560 | 913–1 359 | 2 417–2 822 | 23 759 |
  | `GET /api/chats` | 12 706 | 230–274 | 1 745–2 054 | 23 053 |
  | `GET /api/chats/:id` | 9 887 | 54–123 | 590–703 | 24 128 |
  | `GET /api/chats/:id/mcp` | 5 637 | 7–17 | 214–329 | 15 140 |
  | `POST /api/accounts/refresh` | 12 | 27 027–28 313 | — | 83 888 |

  282 requests took more than 10 s. The desktop tray's live monitor (10 s timeout on `/overview`)
  logged `live state: The operation was aborted due to timeout` 2 555 times, 86 of them today. 939
  streams were `closed prematurely`, mostly `/overview`, `/chats`, `/usage`. `GET /chats/:id?limit=20`
  on a 3 000-message chat answered 99 KB in 35 s during the MCP live check. This is the backdrop
  of several "out of sync" symptoms and is treated in section 9.
- **`server.log` stopped on 2026-10-26 23:09** while the same server process (pid 2286209) kept
  serving; the desktop main process holds no file descriptor to `server.log` any more, only to
  `desktop.log`. Cause not found (low; `apps/desktop/src/log.ts`, `main.ts:881`).

## 1. Chat delivery, "Send now", hints to subagents

The delivery auditor read Claudio's path end to end and, for what the CLI does, the 2.1.312 bundle
at `~/.local/share/claude/versions/2.1.312` (bounded `grep -b`/`dd`) and the Agent SDK typings
shipped with the VS Code extension (`@anthropic-ai/claude-agent-sdk` 0.3.156 `sdk.d.ts`). The
id/replay design of `docs/chat-delivery.md` works on the happy path (this session showed a hint go
`written` → `delivered`). "Pending and never sent" has three causes, and "Send now" is the wrong
tool for the job.

### 1.1 High · verified · a message the CLI takes without a read-back pins the chat `busy` for ever, keeps its card, and holds a run slot
`chat-fold.ts:362-366`: after a result, `else if (chat.written().length > 0)` clears the idle
timer and sets no idle state; the only things that clear a `written` entry are a `delivered`
read-back (`foldDelivered`, `:272-284`) or the process ending (`finalize`, `chats.ts:2143`).
`evictable` (`chats.ts:872-876`) needs `status === 'idle'` and `pending.size === 0`, so such a
chat is never evicted and never idle-ended. A path with no read-back was found in the CLI: when
the mid-turn fold runs `UserPromptSubmit` hooks and a hook ends the prompt, the message's fate is
`dropped` and the CLI emits only `command_lifecycle` started/completed, which Claudio ignores on
purpose (`docs/reports/chat-audit/server.md`); this repository itself installs a
`UserPromptSubmit` hook (`.claude/settings.json:3`). How often it happens in practice is not
measured. **Fix:** bound `written`: after a result, treat ids the CLI's queue no longer holds
(the interrupt receipt's `still_queued`) as stale, settle them `undelivered` with a reason, and
never let them block `idle` past one result.

### 1.2 High · verified · Claudio ends the CLI's input while background work runs; later messages are `held` for up to 10 minutes and the CLI then kills that work
After the lead's result the chat goes `idle` even with background tasks or subagents running;
the idle timer (`chat-fold.ts:367-380`) calls `endInput()` after `idleTimeoutMs()` (10 minutes,
up to 60 while viewed), `evictable` returns true past the timeout whatever `runsInBackground`
says, and a person's account switch goes through `endProcessBetweenTurns` (`chats.ts:2341`). Once
stdin is ended, `leaving()` (`chats.ts:1117-1119`, `stdin.writableEnded`) makes every later
message `held` until the old process closes. CLI 2.1.312 after stdin closes in print mode keeps
the process alive while background work runs up to `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`
(default 600 000) and then kills it ("Background tasks still running … stopping them", "print
wind-down: killing background shell / killing background task"). This matches both owner
reports: messages pending for minutes, and background agents killed. The only guard is a
sidechain assistant message flipping the chat back to `busy` (`chat-fold.ts:187-191`), which
protects chatty agents but not background `Bash` tasks. **Fix:** no idle timer, eviction or
between-turns end while `runsInBackground(chat.branches)`; on a person's account switch wait or
warn.

### 1.3 Medium–high · plausible · a process that exits without closing its pipes leaves the chat "leaving" for good
`chats.ts:1118-1119` `leaving()` is true while `proc !== null && !procClosed`; `procClosed`,
`finalize` and `drainQueue` wait for `'close'`, which needs every stdio stream to end; a grandchild
that inherited the CLI's stdout/stderr (an orphaned stdio MCP server, a daemonised command) keeps
it from firing and there is no timer after `exit`. **Fix:** a short timer after `exit` that
destroys `stdout`/`stderr` and runs the close path.

### 1.4 High · owner bug · "Send now" is a plain `interrupt`, which cuts more than the message needs
Claudio sends only `{subtype:'interrupt'}` (`chats.ts:1214-1236`,
`providers/claude-code/driver.ts:63-65`); it kills no process tree and cancels no task itself
(`branches.endForeground` is bookkeeping). In the CLI bundle the plain interrupt aborts the turn's
`abortController` (every in-flight foreground call, a foreground `Agent` call included, which is
the subagent) and then runs `stopUnabortedWork` → `stopRunning()`, cancelling every "detached
tool call" with `user-cancel`. The CLI's own send-now path (`interrupt` with `send_now: true,
message_uuid`) aborts only while the named message is still queued and skips that cleanup,
answering `delivering`/`nothing_waiting` otherwise, but it is not in the SDK typings
(`SDKControlInterruptRequest = { subtype: 'interrupt' }`), so using it bends the one rule. The 409
guard (`chats.ts:1219`) reads `pending.get(messageId)?.state` while a read-back may still sit in
the stdout pipe, so it can cut the turn that just absorbed the message; only the CLI-side check
is atomic. "Send now" only helps when no tool boundary is coming, which is exactly when the long
call is a foreground subagent or a detached call. Documented alternatives in `sdk.d.ts`:
`SDKUserMessage.priority: 'now'|'next'|'later'`, `cancel_async_message {message_uuid}` (drop a
queued message: a "Cancel"/"Edit" for a card), `stop_task {task_id}`, `background_tasks
{tool_use_id}` (send a foreground call to the background, Ctrl+B). Not confirmed: whether the
plain path also ends `run_in_background` agents or Bash tasks; the wind-down of 1.2 kills them
either way. **Fix:** before interrupting, warn when the turn has a foreground `Agent` or a running
command and offer "Send to background"; offer card cancellation; ask the owner whether `priority`
and `send_now` count as documented.

### 1.5 High · verified · hints: no agent attribution, the wrong transcript, always the lead's stdin
`trace()` (`chats.ts:619-645`) collects `tool_use` blocks from every event, sidechain ones
included (`normalize.ts:219` sets `isSidechain`/`parentToolUseId`), and drops the attribution;
`ToolCall` (`health.ts:15-26`) and `HealthSignal` (`types.ts:1081-1106`) carry `toolUseId` but no
owner; the Supervisor's `steps` are `sessions.getSession(chatId, {limit:60})`, the lead's own
transcript; `deps.hint` → `ChatService.hint` → `runtime.send` writes to the lead's stdin, and in
the bundle stdin messages enter the queue with the main thread's `agentId`, so only the lead can
ever get them. If the lead is idle and only a subagent works, the hint starts a new lead turn.
Live proof: this session (the coordinator's subagent ran a `grep`; the hint landed in the lead,
`queued_command` with `source_uuid cb16fba5…`). There is no documented way to address a subagent
from stdin (`parent_tool_use_id` on `SDKUserMessage` is for messages a subagent produces). A
documented channel exists: hooks carry `agent_id` when they fire inside a subagent
(`sdk.d.ts:164-166`), and Claudio already installs `PreToolUse`/`SessionStart` hooks for guards
(`guards/files.ts:54-55`). **Fix:** keep `parentToolUseId` on `ToolCall` and `HealthSignal` and
give the Supervisor that subagent's steps; for a running command deliver as `cancelCommand` (its
failed result reaches the subagent) plus a `PostToolUse` `additionalContext` hook keyed by
`agent_id`; otherwise send the lead an explicit "relay to agent X" hint (see 3.3–3.4).

### 1.6 Medium · verified · a Supervisor hint is labelled as the person's, shows as the person's queued card with "Send now", and skips the send chain
`chat-service.ts:107,977`, `supervisor.ts:165` (the prompt asks for "the hint a person following
it would send"); `reconcileCards` (`chat-ui/src/composer/queued.ts:83-88`) adds a card for every
`chat.pending` entry the page did not send, so a hint (or a `cancelCommand` notice,
`chat-service.ts:993`) shows as the person's waiting message with "Send now", which interrupts
(1.4); `hint()` uses `runtime.send` and skips the per-chat `sending` chain
(`chat-service.ts:1105-1124`), so ordering against the person's sends is not kept. **Fix:** a
distinct prefix, a `source` field on `pending` so the page draws hints differently without "Send
now", and hints through `send()`'s chain.

### 1.7 Medium · verified · a stale `interruptRequested` mislabels the next result and hides `guard-missing`
`chats.ts:1227-1228` sets it when `status === 'busy'`, which a background subagent's sidechain
message can cause while the lead is idle; the CLI answers harmlessly, no result comes, the flag
survives; on the next real turn it suppresses `guard-missing` (`chat-fold.ts:248`), labels an
error result `cause: 'stopped'` and skips `chat.error` (`:331-339`). **Fix:** clear it when the
control receipt says no turn was under way.

### 1.8 Medium · plausible · `reportsDelivery` is decided once per process from its first result
`chat-fold.ts:351-356`, `chats.ts:1105`: a first turn that ends before any read-back (a local
command with no replay) sets it `false` for the life of the process; from then on
`writeUserMessage` records no `pending` (`chats.ts:2043`), the status goes `idle` with messages
queued, and cards clear 3 s after the next read with no `delivered`.

### 1.9 Low–medium · verified · `carried` is never emitted and `replayWith` contradicts its own comment
Nothing in core emits `{state:'carried'}` (only the client reads it, `queued.ts:64`);
`docs/chat-delivery.md` promises it. `replayLastTurn` (`chats.ts:2392-2420`) keeps waiting ids;
`replayWith` (`:2426-2447`) says "what was still queued goes with it" but `stop()` runs with
`carrying=false`, so held and written messages are reported lost, then `pending.clear()`.

### 1.10 Low · an absorbed message is dated when it was queued (`normalize.ts:299-310` uses the `queued_command` line's enqueue timestamp), so after a reload it reads as sent minutes before the agent took it.

Where the state changes (for the owner's own audit): `pending.set` held `chats.ts:1084`, written
`:2043`; `pending.delete` `chat-fold.ts:276` (delivered), `:355` (no read-back at first result),
`chats.ts:1129` (drain), `:1181` (stop: held), `:2144` (finalize: written); `pending.clear`
`:2415`, `:2445`; `lose()` `:1142`, `:1182`, `:2145` (defined `live-chat.ts:847-851`);
`undelivered` reset `:1069`, restored as RESTARTED `live-chat.ts:673`, appended `:849`;
`limitReplays` init `live-chat.ts:582`, reset `chats.ts:770`, `:2270`, incremented `:2399`,
`:2435`, read `:2168`, `:2230`, `:2242`, `:2398`, `:2434`; `carrying` reset `:1918`, set `:2411`;
`reportsDelivery` reset `:1917`, set `chat-fold.ts:273`/`:354`.

Sound: the id travels as the stdin `uuid` and the bundle reads it back in three places (turn start,
`queued_command` with `source_uuid`, merged prompt); a uuid the CLI already saw is deduplicated
and still acknowledged, so a resend after a respawn cannot hang; `stream.ts:188-191` matches every
`isReplay` line whatever its `parent_tool_use_id`; a held message is marked `written` again on the
replacement process (`drainQueue` `:1129` → `writeUserMessage` `:2043`), which refutes a
suspicion raised by the chat-ui auditor; `stop()` reports held messages lost and `finalize`
written ones; cards never expire on a clock. Open: why the CLI skipped four tool boundaries before
absorbing a hint in this session (the `UserPromptSubmit` hook's `waits` fate or
`isMidTurnFoldSuspended`; needs `--debug`).

## 2. Accounts, rotation, limits and the status bar

### 2.1 Critical · verified · removing an account a live chat runs on takes the server down
`packages/core/src/chats.ts:1813` `const account = authFailed ? null : store.get(id);` inside
`observeSignIn`, which `chat-fold.ts` calls for every successful result. `AccountStore.get`
throws for an unknown id; `observeSignIn` has no `try` (compare `observeLimit` just above it at
`chats.ts:312-316`); the stream line handler `chats.ts:1988-1992` calls `session.readLine(line)`
unguarded; neither `apps/api` nor `apps/desktop` installs an `uncaughtException` handler. The
owner's log shows exactly this crash on 10-25. `AccountStore.remove` (`packages/accounts/src/store.ts`)
does not check for chats on the account and re-points nothing, and idle chats keep their process
between turns, so the next successful turn after a removal kills the server. Same code in 0.8.1 and
main. **Fix:** nullable lookup in `observeSignIn`; `try/catch` around `readLine` recording a
protocol failure; `remove` refuses (409) or re-points live chats; `Readings.observe` ignores ids
not in the store.

### 2.2 High · verified · after one wait-replay without an account a chat never rotates again
`chats.ts:123` `MAX_LIMIT_REPLAYS = 1`; `maybeLimit` (`:2168`) returns before emitting
`limit-hit` once `chat.limitReplays >= 1`; the counter goes up in `replayLastTurn`/`replayWith`
(`:2398-2399`, `:2434-2435`) whenever they run without an account, and is reset only in
`resume()` (`:770`) and at `:2270`, never when a turn completes. A wait that ends at the reset
replays without an account (`roomFor` keeps the account the turn died on in `failedOn` unless a
reading newer than the wait says otherwise, and nothing takes one at a reset), so the counter hits
1; the chat's next limit shows the banner "Esperar al reinicio" with the composer blocked while
other accounts have room. This is the owner's symptom. **Fix:** reset `limitReplays` when a turn
completes without error (next to `limitedAccounts.clear()` in `chat-fold.ts`) and let the counter
only stop same-account loops, never a move to another account.

### 2.3 High · verified · rotation filters accounts by the model the CLI resolved, not the one asked
`chats.ts:1747`, `:1834`, `:1862` pass `model: chat.model` to `store.pick`; `chat-fold.ts:62-65`
overwrites `chat.model` with the init event's resolved model (`default` → `claude-opus-…`).
`choose.ts:105` (`canRun`) then drops accounts whose cached model list lacks it and
`choose.ts:63-72` drops accounts whose Opus scoped limit is spent, so a chat started on
"default" waits with "No other account can run claude-opus-…". **Fix:** pass `chat.opts.model`
and skip the filter when unset or `default`.

### 2.4 High · verified · the limit banner can block a chat that never hit a limit
`apps/web/src/pages/chat/LimitBanner.tsx:34-44` falls back to the provider-wide reading
(`status.limit`, the last `rate_limit_event` from any chat on any account, `providers/limits.ts:105`)
when `chat.atLimit` is false; any execution that ended other than `completed`/`stopped` after that
reading shows "reached its limit" and `BlockedComposer` (`ChatView.tsx:530-536`). The banner has
no "Switch account" or "Run now" (`runNow` is wired only in `OrchestrationBoard.tsx:189`).
**Fix:** rely on `chat.atLimit` and the open wait only; add both actions to the banner.

### 2.5 Medium · plausible · a rejected stream event marks the whole account exhausted
`chats.ts:1772-1779` drops `isUsingOverage`/`overageStatus`; `usage.ts` `fold` turns any
`rejected` into `exhausted` for the account, and `readingFromEvent:201` stores scoped types
(`seven_day_opus`, `overage`) as account windows, against `docs/accounts.md` ("scoped limits never
in windows"). Needs a captured event to settle.

### 2.6 Medium · verified · a `get_usage` with `rate_limits_available: false` erases an exhausted state
`packages/accounts/src/cli-usage.ts:77-101` returns `windows: {}` stamped now; `Readings.observe`
replaces the windows, so Refresh (or opening Accounts after 10 minutes) turns a known exhausted
account into `unknown` and `choose` moves chats onto it. The decision doc says this answer also
comes for a network that is down. **Fix:** when `!cli.available` update only `cli`.

### 2.7 Medium · waits take the provider-wide reset
`rotation.ts:279` (`waitFor`) takes `resetsAt` from `runtime.limits`, possibly another account's
`seven_day`; `rotation.ts:379-388` resumes as soon as any chat on any account reports "not
exhausted", which replays without an account and feeds 2.2.

### 2.8 Low–medium · `cooldownSeconds` is not what the docs and the UI say
`choose.ts:123` uses it only as a gap between switches from one shared `lastSwitchAt`; a rejection
without a reset produces no reading (`readingFromEvent:204-205`), so the account is picked again
at once. Docs, type comment and the `es` hint describe a per-account cooldown.

### 2.9 Low · the credential-less default account is excluded only for "in use"
`index.ts:3773-3777` passes `failedOn: [DEFAULT_ID]` only in `accountInUse`; `chooseAccount`,
`chooseNext`, `roomFor` and `accountsAtLimit` can still pick the ghost (rank 0.5).

### 2.10 Missing · no way to choose the account new work starts on
Today: per-chat pin (New chat picker, composer "+" switch) and the global `strategy`/policies.
`AccountsSettings` has no `preferred` and no reorderable global `order`; `AccountCard.tsx` has no
"Use this account". The plan's preferred account (D14–D17) is unbuilt; the list of missing pieces
is in the accounts auditor's report (settings field, `choose` step, `accountInUse`, settings
registry, MCP tool, card action, terminal `CLAUDE_CONFIG_DIR`, `limitReadings()` per account).

### 2.11 The status bar: one fact, several paths (the owner asked for this map)

| Data | Producers | Consumers | Where they disagree |
|---|---|---|---|
| Account in use | `accountInUse()` = `pick({current:null})`, no policy/pin/model (`index.ts:3773`) → `GET /auth.inUse`, overview `accounts.current`, `system.auth.inUse` | `useConnection` (`StatusBar.tsx:56`), `AccountChip`, `CurrentAccountCard`, `SignInSection`, Accounts "In use" badge | Ignores policies and pins; under `least-used` it changes with every reading; a running chat's real account is shown nowhere in the bar; the detail line mixes the default dir's `auth.subscriptionType` with another account's label (`StatusBar.tsx:69`) |
| Usage per window | **Account:** `limits.json` via `Readings` (stream, `get_usage`, CLI cache) → `GET /accounts`. **Provider:** `ProviderLimits`, the last `rate_limit_event` of any chat on any account (`providers/limits.ts:105`) → `overview.limits`, `GET /providers[].limit` | Account: chip, current-account card, Accounts cards. Provider: `ProviderDots`, phone `ProviderCard`, chat `LimitBanner` | The dot shows whichever account ran last; the chip shows the account in use. `/accounts` is refetched only on `run.rateLimited`, `run.accountRotated`, `account.switched` or a page action (`AccountStore.onChange` emits no event); the overview on most run events |
| Near / exhausted | Account `fold`: near ≥ 0.75. Provider `limitFromInfo`: near ≥ 0.6, or `allowed_warning`, or overage; exhausted on any `rejected` (`limits.ts:5,57-58`). Rotation threshold 90, pool ≤ 80. Bars: warn 60, bad 75 | `connectionOf` → "Near the limit"/"Limit reached" (`lib/accounts.ts:156`), `ProviderDot` red on any exhausted reading, `LimitBanner` | "acc-B · Cerca del límite" because A reached 60 % while B's chip shows 10 %; the dot says "limit reached" while the detector says ready; an account at 70 % is `ok` by its own state but `warn` in the bar |
| Reset time | provider `resetsAt`; account `limits.resetsAt`; wait row (from the provider) | `useConnection` "back at" (`StatusBar.tsx:71`), `ProviderDot`, `LimitBanner` | account-specific and provider-wide resets get mixed |
| Signed in / expired | `signInState` (`authFailedAt` + credentials file); detector `knownSignedIn` from `claude auth status` of the default dir → `/health.loggedIn` | `connectionOf`, phone `AccountCard`, `SignInSection`, `/health` | `/health` follows the default dir, which says logged in for a dead session |
| "Out" | `accountsAtLimit` (`resetsAt` null counts as out) vs `choose.exhaustedUntil` (needs a `resetsAt`) | detector, decision route | two definitions |
| Dead | `ProviderLimits.observeProbe`, `HandshakeLimits`, the TTL re-read in `detector.ts:561-574`: the driver's handshake never returns `rateLimits` | — | remove or wire to `get_usage` |

**Proposed single source of truth:** the account reading. One `Core.accountView()` returning
`{ inUse: { id, label, kind, signInState, limit }, accounts, atLimit, nextReset }` computed once,
with the ghost exclusion and the thresholds (near 0.6 to match the bars; exhausted; rotation
threshold from settings) in one constants module of `@claudio/accounts`; `limitReadings()` and the
detector derive the provider limit from `inUse.limit`; `AccountStore.onChange` emits a debounced
`accounts.changed` event that invalidates `accounts`, `auth`, `overview`, `providers`; `StatusBar`,
`AccountChip`, `ProviderDot`, the phone cards and `LimitBanner` all read `overview.accounts.inUse`
(the banner reads only `chat.atLimit` and the wait); delete the provider-wide `near` path,
`observeProbe` and `accountsAtLimit`.

Smaller: `AccountStore.list()` does `statSync`/`readFileSync` per account on every `pick()`, which
runs on every launch, wait recheck and overview; `reload()` on `GET /accounts` does not call
`changed()`, so an account added from the terminal does not wake the waits. No test covers a second
limit after a wait-replay, the resolved-model filter, removing an account under a live chat, a
`get_usage` `available:false` after a rejection, or the status bar against a reading from another
account.

## 3. Guards, decision engine, Supervisor hints

### 3.1 High · verified · the `integrity` rule is armed whenever the guard runs, whatever the switches say
`packages/core/src/guards/resolve.ts:80`
`GUARD_RULE_IDS.filter((id) => id === 'integrity' || switches[id] === true)` and
`guards/decide.ts:52-53` `enabled.add('integrity')`. Switching every rule off in Settings does not
switch the guard off: only `automated: false` does for automated runs, and only an unset
`project.guards.chats` for chats. `integrity` blocks lines the shell reader cannot parse, nesting
too deep and writes with an unknown target, which is what the owner's 157 blocks are. The Settings
header still tags the guard "Active" with everything off (`apps/web/src/pages/config/GuardsCard.tsx:113`).
**Fix:** `integrity` follows the guard's on/off (no rule on → no guard), and the tag follows it.

### 3.2 High · verified · a respawned process keeps the guard plan it was started with
The plan lives in `chat.opts.guards` and is only replaced when a caller passes `guards`
(`chats.ts:1000-1003`). `resume`, `fork` (`chat-service.ts:1032`, `:1080`) and the orchestrator
(`orchestrator.ts:1364-1375`) re-derive it; `replayLastTurn` (limit wait, account move,
`chats.ts:2392-2420`), `drainQueue` (`:1137`) and `sendMessage` after a process death
(`:1086-1091`) spawn on the stale `chat.opts`, and `spawnProcess` reads it (`:1924`, `:1945`,
`:1979`). So the old rules file and hooks come back after the switch was turned off, until a
server restart (`opts.guards` is not persisted). Owner evidence that fits: chat `e719c604` blocked
at 10:24 inside an orchestration and again at 10:45 with `orchestration_id: null`.

### 3.3 High · verified · a hint about a subagent's command is pinned on the lead and sent to the lead
`chats.ts:619-645` (`trace()`) gathers every `tool_use` block of the stream, subagent ones
included, and never reads `isSidechain`/`parentToolUseId` (`shared/types.ts:541-543`); the
`hung-command`/`repeat-stall` signal (`health.ts:77`, `chat-model.ts:207-229`) therefore names a
subagent's command, while the housekeeping prompt's `lastSteps` and `callsOf`
(`supervisor.ts:108`, `:136`) skip sidechain entries, so the drafting model sees a signal about a
command its steps never show and writes a hint "to the agent", which `chats.hint` writes to the
lead's stdin. Owner evidence: proposal `cce51d4b`, signal `repeat-stall` with detail
`timeout 590 tail --pid=2775283 …`, sent to lead chat `7d778da2`; and the same thing happened to
this audit session (a hint about a subagent's `grep` on the CLI binary reached the coordinator).
**Fix:** carry `parentToolUseId` on `ToolCall` and the signal; name the subagent (its `Agent` call
id, description, its own steps); word the hint for the lead ("your background agent X is blocked
on …; tell it with SendMessage or stop it"). Claudio has no documented CLI surface to write to one
subagent; the CLI's channels for that are the lead's own `SendMessage`/`ListAgents`, so asking the
lead to relay is the compliant route.

### 3.4 High · verified · a hint cannot help an agent blocked inside the hung command
A hint is a user message; the CLI reads it only after the foreground call returns, when the problem
is over. Claudio already has the right action, `cancelCommand` (`chat-service.ts:970`,
`chats.ts:655`), which kills the command's process tree and gives the agent a failed result. Most of
the owner's 92 hints are `hung-command`/`repeat-stall` saying "Stop the …". **Fix:** for these two
signals in Active mode cancel the command by its `toolUseId` with the hint as the reason. Open:
whether `cancelCommand` finds a subagent's process tree (`commandRoots` walks the tree under the
CLI pid; it refuses when a background command started beside it, `chats.ts` "cannot tell this
command's process from a background command's").

### 3.5 High · verified · one hint per chat per signal kind, forever
`db.ts:195` `CREATE UNIQUE INDEX supervisor_proposals_signal ON supervisor_proposals (chat_id, signal)`
with `INSERT OR IGNORE` (`:2817`), and `supervisor.ts:221-225` skips any signal kind already
`answered`, `asking` or in the in-memory `failed` set, which is never cleared. A long lead chat gets
one `hung-command` hint in its life; one failure, or one Jev decline (`:232-234`), silences the kind
until restart. On the owner's install each long lead chat has exactly one proposal per kind. This is
the likeliest meaning of "mostly fails". **Fix:** key proposals on the occurrence (`toolUseId` or
`since`) and expire `failed`.

### 3.6 Medium · verified · the hint says it comes from a person
`chat-service.ts:107` `CHAT_HINT_PREFIX = 'A hint from the person following this chat:'` and
`orchestrator.ts:118`; the Supervisor's automatic hints use the same prefix, so the agent takes a
model's guess as the person's instruction. **Fix:** a separate prefix for automatic hints.

### 3.7 Medium · the Supervisor's housekeeping chat fails silently when slots or memory are short
`index.ts:2407-2425` → `runtime.start` throws `RunSlotRefusal` or the memory refusal; `wake`
catches it, adds the signal to `failed` and says nothing (`supervisor.ts:274-276`). This is
typical while an orchestration runs at full concurrency. **Fix:** retry like the review gate
(`review-gate.ts:438-444`), never count a refusal as a failure.

### 3.8 Medium · plausible · the default $0.02 cap is too small for the Supervisor's chat
Unlike the confined decision one-shot (`one-shot.ts:58`), the Supervisor's chat runs with full
settings sources and the CLI's own MCP servers in the worker's directory (`index.ts:2407-2422`);
a haiku turn that needs one Read likely exceeds $0.02 (`decisions/settings.ts:68`) and ends
`error_max_budget_usd`, counted as failed. The owner's cap of $5 hides it.

### 3.9 Medium · verified · the assistant chat and assistant runs get a guard in opted-in projects
`index.ts:2234` and `:3019` call `chats.create` without `guards`, so `chat-service.ts:824` falls
back to `guardsForChat` (`index.ts:3165-3170`), which passes neither `policy` nor `confined`;
`docs/guards.md` says the guard never runs on the assistant.

### 3.10 Low
- `startGuardSweep` (`guards/files.ts:113-152`) is exported and never called: the guard folder
  grows without limit (310 files on the install).
- The review gate retries a full slot but not a memory refusal (`review-gate.ts:438-444`
  matches the message text `Concurrent run limit` only).
- `policy-judge.ts` `judge()` runs only when a driver lists a policy part as `host`
  (`chat-fold.ts:406-433`); Claude Code's translation never sets it, so it is dead on the only
  provider. `commandSegments`/`runsGitPush` and `evals/matchers.ts:195` duplicate the stricter
  reader in `guards/shell.ts`.
- The reviewer sends nothing to a person's chat on its own; its silent failure modes all surface as
  an `incomplete` round with a reason.

Sound: `resolveGuards` reads settings fresh and `GuardSettingsStore` has no stale cache; there is
no `guards.*` decision point; `guardsWeakened` refuses a chat's token; the `supervisor.json`
migration runs before the point is first read (`index.ts:968`).

## 4. Claudio's MCP server and the assistant

Live check (read-only, the worktree's `packages/mcp/src/main.ts` over stdio against the running
API): `initialize` and `tools/list` answer 25 tools; `list_chats {}` (1 438 chats), `get_chat` on a
78-message chat, on 3 128- and 6 192-message chats, and `read_document docs/design-system.md` all
return exactly 50 102 characters, cut mid-JSON and unparseable; `get_chat` on a 3 016-message chat
and `list_documents` on the claudio project time out at 15 s; `get_usage {}` answers
`from: null, to: null` and all history ($32 801 instead of today's $3 244). `curl` of
`GET /chats/:id?limit=20` answers 58 KB in 10.6 s for this chat (20 entries are 43 KB; environment
6.6 KB; children 6.4 KB) and 99 KB in 35.4 s for the 3 016-message chat.

### 4.1 High · verified · `render()` cuts JSON mid-value at a cap the CLI cannot take
`packages/mcp/src/server.ts:10` `RESULT_MAX_CHARS = 50_000`; `:33-37`
`${json.slice(0, RESULT_MAX_CHARS)}…\n{"truncated":true,…}`: broken JSON with a second document
appended. The only test checks for the marker, not validity (`packages/mcp/test/tools.test.ts:109-111`).
The confined assistant has no `Read` (`claudio-mcp.ts:86`), so a result the CLI spills to a file is
unreachable. **Fix:** structural cut (shrink arrays and long strings, keep JSON valid) at a budget
well under 25k tokens; real paging for `get_chat` and `read_document`.

### 4.2 High · verified · `get_chat` is unusable on any real chat ("error al obtener chats")
`tools.ts:380-390` asks `GET /chats/:id?limit=20` and returns the whole `ChatDetail` (full
`executions`, `children`, `environment`, 20 entries with complete tool results); it overflows on a
78-message chat, has no `before`/`limit` arguments, makes two sequential requests at 15 s each
(`client.ts:98`), and the route itself takes 10–35 s. **Fix:** project the detail like `chatRows`
does, clip tool results, add `before`/`limit`.

### 4.3 High · verified · `start_chat` with `projectId` always fails
`write-tools.ts:144` calls `GET /projects/:id`, which does not exist (`routes/projects.ts` has
`PATCH` and `DELETE` only); the unit test stubs the route (`write-tools.test.ts:52`), which is why
it passes. **Fix:** take `path` from `GET /projects`, or add the route.

### 4.4 High · verified · Claudio's server switched on from the "+" pre-allows nothing
`packages/core/src/claudio-mcp.ts:162-163` `allowedTools: toolsets.includes('collab') ? [...COLLAB] : []`,
and the live push (`dynamicClaudioServer`, `chats.ts:1363-1399`) changes nothing. In a `dontAsk`
chat, or with `permissionPrompts: 'none'` (the default from `NewChat.tsx:84` unless "ask here" is
on), every `mcp__claudio__*` read is denied; in `bypassPermissions` every write runs with nobody
asked. **Fix:** pre-allow `CLAUDIO_MCP_READ_TOOLS` with the `claudio` toolset, in the file and the
live push; decide writes under bypass (plan D2/D4).

### 4.5 High (security) · verified · a chat's token can answer any chat's permission prompts
`POST /chats/:id/permissions/:requestId` (`apps/api/src/routes/chats.ts:308-314`) is in no
`CHAT_FORBIDDEN*` set (`security.ts:240-551`; it appears only in `READ_ONLY_ALLOWED`, `:738`);
`permissions.ts:75-82` ties the request to the chat id in the path, which the caller picks. A chat
with a shell can `curl` another chat's pending prompts and allow them, or approve its own. Enforced
only under guarded auth; under `none` nothing is enforced for anyone. **Fix:** forbid it to chat
tokens (the plan's `person` class).

### 4.6 Medium · verified · `get_usage` without dates returns all history while its description says today
`tools.ts:393`, `:399`; `routes/chats.ts:63-68`, `usage-report.ts:80` treat missing bounds as
unbounded.

### 4.7 Medium · verified · `update_work_item` with `acceptanceCriteria` wipes ids and checks
`write-tools.ts:17-21` schema has only `text` (`additionalProperties: false`, so an `id` from
`get_work_item` is refused); `replaceCriteria` (`work-items.ts:1385-1416`) reinserts with new ids.
`PATCH /work-items/:itemId/criteria/:criterionId` exists and no tool uses it.

### 4.8 Medium · verified · no safe defaults: `list_chats` has no default `limit` (1 438 rows), `read_document` no range, `list_documents` walks a whole folder under a 15 s timeout.

### 4.9 Medium · verified · "no puede crear orquestaciones": there is no tool, and the gap is wide
The only orchestration tools are `list_orchestrations`, `get_orchestration`,
`retry_orchestration_task` (`names.ts:8-63`); `retry` on a stopped graph answers "resume it
instead" and nothing resumes. The API does not forbid chat tokens from `POST /orchestrations`,
`/plan`, `/plan/start`, `/:id/resume`, `/:id/stop`, `/templates/:id/launch` (only `spend-pass`
is forbidden), so tools are feasible. Against ~484 `ROUTE_DOCS` entries (~300 writes) the MCP
covers 16 reads and 9 writes; whole domains have none: orchestration writes (26, one has a tool),
chat writes (resume, fork, follow-up message, stop, interrupt, hint, account, wait, compact, notes,
rename, delete, MCP toggles, permissions), chat reads (search, changes, subagents, tasks,
workflows, context, export), work-item writes (delete, relations, links, `/work`, pull-request,
triage, milestones, criterion check; no milestone read, so `epicId`/`milestoneId` cannot be
found: the board gives `epic` as a key), assistant proposals (no list, so `accept/discard` need an
id nothing returns), team/flow writes, project writes, schedules, decisions, evals, accounts and
providers writes, configuration, integrations, plugins, memory, security, webhooks, push, remote
access, terminal, workspaces, setup, uploads. The plan's D1 (curated tools plus a generic
`call_api` over OpenAPI) is the intended answer.

### 4.10 Medium · verified · the system prompt promises what the tools cannot do
`claudio-assistant-prompt.ts:47` "start a chat" (fails with a project), "accept or discard a
proposal" (no list), `:38` chat states `done`/`failed` that the API does not have, `:48` says
nothing about orchestrations. A test tying each capability claim to a tool name would catch drift.

### 4.11 Medium · verified · `get_chat.environment` is keyed by cwd
`chats.ts:250,296`, `chat-fold.ts:72-73` `host.environments.set(chat.cwd, …)`,
`chat-service.ts:560` `environmentOf(runtime?.cwd ?? summary.cwd)`, `db.ts` table keyed by cwd:
two chats on one folder show each other's tools, MCP servers, slash commands and model; the
composer's slash menu reads it too. **Fix:** key by chat id, cwd only as a labelled fallback.

### 4.12 Medium · verified · a fork does not keep the account
`chats.ts:791-821` copies model, effort, mode and the assistant marker, not `account`/`opts.account`;
`chooseAccount` picks again with `current: null`, against `types.ts:1654`.

### 4.13 Low–medium · no model check on `POST /chats` (`routes/chats.ts:74-86`); a `<synthetic>` "model not found" answer raises no error (`chat-fold.ts:196-197`), so the chat ends idle and healthy.

### 4.14 Low · the web polling of `GET /chats/:id/mcp` on dead chats is mostly fixed on main
(`chat.execution` is only the live execution; `mcpServers` answers `live:false`; `chatScope`
invalidation is narrowed). Residual: `useLiveServers` is enabled for every live chat with
`staleTime: 0` (`Composer.tsx:73`, `ServersPanel.tsx:53-62`), its key sits under `chatScope`, and
`chatOf` (`events.ts:187-190`) still invalidates the scope on branch events, so every subagent or
task event costs an `mcp_status` control request to the CLI (`chats.ts:1320-1326`
`session.mcpStatus()`), which is where the 15 s maxima of `/mcp` come from.

### 4.15 Low
- `main.ts:21-28` `queue = queue.then(…)` with no `.catch`: a throw outside `call()`'s try or an
  `EPIPE` on stdout ends the server on an unhandled rejection.
- `client.ts:207` 401 message "this chat has no token" is wrong (the token is always minted).
- `tools.ts:387` turns any error of `GET /chats/:id/permissions` into `[]`.
- Dead: `client.ts` `request()` (test only), the `x-claudio-chat` header (never read by the API);
  the real-API test fixture drops request bodies (`test/fixture.ts:30`), so every write tool is
  tested only against a stub, which is how 4.3 got through.

Sound: catalogue equals docs (16/9/7); every other route the tools call exists and the query
names match `ROUTE_DOCS`; strict schemas; ids encoded with `seg()`; collab fence; the token is
minted per process and an inherited one dropped; `CLAUDIO_MCP_ENTRY` wiring in the three runtimes;
`confineAssistant` reapplies at every process.

## 5. Collaborators and the tunnel

### 5.1 Medium · verified · a request during the host's restart backoff leaves the endpoint unbound for good
`packages/core/src/collab/host-client.ts`: after a host crash `lost()` (`:305-325`) arms a restart
timer and leaves `this.options` set; `request()` (`:193-205`) only checks `!this.options || this.failure`,
and `post()` (`:232`) does `if (!this.child && !this.spawn()) return;`, so a request in the window
forks a child that never receives `{type:'start'}`; when the timer fires `if (this.options && !this.child)`
is false and `start` is never sent. `hostStatus` stays null and the page reads "starting" forever.
`GET …/blobs/:sha256` (`service.ts:1426`), a sync timer or `client.pull` trigger it. **Fix:** refuse
or queue while `restartTimer` is pending; on every spawn with options set, enqueue `start` first.

### 5.2 Medium · verified · host bind failure is only logged
`host-client.ts:326-328` / `host.ts:144-176` `start-error` → `service.ts:262` `this.log` only;
`connection()` (`service.ts:362-369`) returns `starting` while `hostStatus` is null, `SyncClient`
never starts and every copy reads `paused`; no retry; only toggling Collaborators recovers.

### 5.3 Medium · verified · the endpoint coming back online does not poke the peers
`service.ts:445-455` runs `refreshPeers`, `pokeAll`, `retryPending` only on the first status; a
later `no-relay` → `online` transition only emits `changed('settings')`, so after an outage every
peer waits its own timer (30 s doubling to 10 min).

### 5.4 Medium · verified · `retryPending` is not re-entrant and runs longer than its interval
`service.ts:886-929` (`PENDING_MS` 30 s) plus `onStatus`: each waiting join dials the owner and up
to three relays at 20 s each, twice (`fetchJoinAnswer`, `sendJoin`); runs overlap and the
read-modify-write cycles on `pending-joins.json` (`:911`, `:870-873`) can overwrite each other
(a `relayedBy` update over an `endJoin('denied')`); joins are sent twice.

### 5.5 Medium–low · routes block for a long time on an offline peer, with no UI feedback
`DIAL_TIMEOUT_MS` 20 s (`host.ts:56`), failed dials not cached. `POST /collaborators/join` up to
~80 s while the web aborts at 60 s (`apps/web/src/lib/api/collaborators.ts:69`) and the server goes
on, so the UI shows an error for a join that then completes; `DELETE /collaborators/groups/:id`
awaits `sendLeave` to every member before deleting locally (`service.ts:716-742`), ≥ 20 s per
offline member with the page disabled and no spinner, and a leave is never retried
(`client.ts:1073`), so an offline owner keeps the install in the roster and its syncs get
`forbidden` with up to 24 h backoff; `announce` holds the peer lock for two sequential dials;
`?refresh=1` (`client.pull`) does not short-circuit on `peer.online === false` (and the web never
sends it: dead on the UI side).

### 5.6 Low · plausible · a dial that times out and completes later leaks an unadopted connection
`host.ts:57-71` (`within`), `:372-376`: the late `Connection` is never adopted nor closed; the peer
routes requests onto it and they hang until the 30 s idle timer.

### 5.7 Low · a `watch` ended with an error frame restarts the peer at once with no backoff (`client.ts:~920-935`); `serve.ts` `watch` refuses `not-found` for a share key still in the cached catalog, so a hot loop is possible.

### 5.8 Low · `lastSyncedAt` falls back to the catalog read time and then `lastSeenAt` (`client.ts:~988-993`), shown as "last synced" after a restart for copies never pulled.

### 5.9 Low · `lost()` does not clear `outbox` (`host-client.ts:277`), so a crash before `ready` replays stale messages plus a second `start`.

### 5.10 Tunnel · medium · verified · two concurrent `start()` calls fail the tunnel and remove the rule just added
`packages/core/src/tunnel.ts:437-467`: `if (this.wanted) return this.status()` runs before
`await this.probe()` and `this.wanted = true` after it, so a second `start` (UI click racing
`attach()`'s "start with Claudio") passes the check, both `open()`, the second sees the first's
rule as `portTaken` and `giveUp` removes the rule; a `stop()` in the window returns early
(`!wanted && !opening && !stopping`) and is lost. **Fix:** set `wanted` and `opening`
synchronously before the first await, or share an in-flight promise.

### 5.11 Tunnel · the owner's "collision with other tunnels": what Claudio actually runs, and the way out that is missing
Claudio runs only `tailscale version`, `tailscale status --json`, `tailscale serve status --json`,
`tailscale serve --bg --yes --https=<port> http://127.0.0.1:<port>` and
`tailscale serve --yes --https=<port> off`, never `serve reset`, `funnel`, `set-path` or
`tailscale set`; it adds one rule on **8444** (`DEFAULT_TUNNEL_PORT`) and removes it only when the
port holds exactly its own rule (`servePortUse === 'match'`). So it does not wipe the person's
other serves; a busy port gives `tunnel.portTaken` and leaves everything untouched. The missing
part is the way out: the only override is the env var `CLAUDIO_TUNNEL_PORT`, which the desktop app
cannot set, Helm exposes only `CLAUDIO_TUNNEL` on/off (`deployment.yaml:64`), `RemoteAccessTab.tsx`
has no port input and its reason text is a generic "Free it". Two Claudios on one node (desktop +
dev server, which the docs call common) always collide on 8444; this machine currently serves
`https://pcpersonal.tail7b1190.ts.net:8444` → `127.0.0.1:41985`. **Fix:** pick the next free port
(the record already stores the port) or add a port setting in `tunnel-settings.json` and the tab,
and show what holds the port.

### 5.12 Tunnel · low
- `serveConfig()` collapses every failure (timeout, permission, bad JSON) into null, which `open()`
  reports as "could not reach tailscaled" (`tunnel.ts:~528-552`); `firstLine` keeps 200 chars of the
  first stderr line, dropping the URL of "Serve is not enabled on your tailnet".
- `shutdown()` uses `spawnSync` up to 10 s twice and runs first in `Core.shutdown()` (`index.ts:3864`);
  the desktop SIGKILLs after 5 s (`server-process.ts:9`), so the DB close waits behind it.
- Three copies of the `serve status --json` parser (`serveConfig`, `reading()`, `shutdown()`).

Sound: the rule cannot be left behind (record written before the rule, removal gated on exact
match, `reconcile` at the next start), the monitor backs off, `stop` withdraws the host from the
allowlist first; the host child guards unhandled rejections, restarts with a budget and ends in
`unavailable`; replies are bounded by a 30 s idle timer; refused peers back off up to 24 h; agent
and MCP reads serve the local copy and never dial. Offline cases with no test: 5.1–5.4, 5.6, leave
and join with an unreachable member; `collab-sync.test.ts` is skipped without the native binding.

## 6. The work-item board (drag and drop, moves)

### 6.1 High · verified · in All projects a move fails with 400 or lands in the wrong place
`packages/core/src/work-items.ts:621-624` refuses an `afterId` from another project or status
(`afterId must name an item in the target column`), and `afterId: null` puts the card first in its
own project's group (`ORDER BY project_id, rank`); the web (`apps/web/src/pages/tasks/board/model.ts:74-78`
`afterIdFor`, `BoardColumns.tsx:105-110`, `PhoneBoard.tsx:81-99`) names the card drawn above the
drop whatever its project, and `Board.tsx` passes no `moving`, so dragging stays enabled with
All projects (`projectNames` only hides limits and "+"). Drop at the end of a column whose last
card is another project's → 400, rollback, toast; drop at the top → saved at the top of its own
group and jumps after the refetch; on a phone "Move to X" for non-adjacent columns uses the column's
last card. No test covers a cross-project move. **Fix:** compute `afterId` among the item's own
project's cards (and draw the indicator within the group), or accept a foreign `afterId` on the
server and rank within the item's project, or disable reordering in All projects.

### 6.2 Medium · plausible · the optimistic move is overwritten by refetches in flight
`useMoveWorkItem.ts:34-51` cancels queries once in `onMutate`; any `workitem.*` event or poll that
starts a board refetch before the POST lands returns the old order and the card flickers back then
forward at `onSettled`; `onError` restores a whole snapshot (a second quick move is wiped if the
first fails); `onSettled` invalidates the whole `['work-items']` prefix (including `chat` and
`key` caches) and the server's `workitem.moved` invalidates the same views, two refetches per move.
**Fix:** write `MoveWorkItemResult` into the cache on success, scope the mutation, apply the
inverse patch on failure.

### 6.3 Medium · verified · a keyboard grab can get stuck and disables drag for the whole board
`BoardColumns.tsx:129-147`, `:249`: `grab` ends only on Space/Enter/Escape/Tab from the card, no
`onBlur`, no cleanup when the card disappears (`drawn()` ignores it), and
`draggable={moving && !selection && !grab}` turns pointer drag off everywhere while it is set.

### 6.4 Medium · plausible · touch devices wider than the phone breakpoint get native HTML5 DnD with no move menu.

### 6.5 Low · verified · `dragId` is cleared only in `onDragEnd`/`onDrop` (`BoardColumns.tsx:259-262`): a card unmounted mid-drag leaves `is-dragging` and the drop slots on.
### 6.6 Low · verified · the optimistic update skips the list's `InfiniteData` pages (`useMoveWorkItem.ts:36-45`), against `docs/work-items.md` "every cached board and list".
### 6.7 Low · the item panel has its own move mutation (`item/hooks.ts:33-39`) with no board update and no `afterId`.
### 6.8 Dead/duplicated · `moving` prop of `BoardColumns` is never passed (always true; its comment contradicts itself); `byRank` (`board/model.ts`) is test-only and never returns 0; `newestDoneFirst` duplicates the server's `newestDone`; `dropIndex` (DOM) and `afterIdFor`/`keyboardDrop` (data) agree by convention with no test tying them.

Sound: same-column up/down and self-drop (`afterIdFor`, `isSamePlace`); server semantics (null
first, absent last, foreign id 400, unchanged position `moved:false` with no event); the rank
algorithm respreads inside the write transaction; cursor paging; Done ordered by `closed_at`;
events refetch rather than trust payloads; announcements and focus. e2e covers one keyboard move,
one synthetic upward drag, reload persistence and an API move; nothing covers a downward drag, the
last position, an empty column, a cross-column pointer drag, filters, All projects, refusal and
rollback, two quick moves, the stuck grab, the phone menu, the list view, touch.

## 7. The chat screen (chat-ui, ChatView, transcript read side)

### 7.1 Medium · verified · "Restore" text and files from chat A are pasted into chat B
`apps/web/src/pages/ChatView.tsx:113` keeps `restore` in state; the route `/chats/:id`
(`App.tsx:411`) has no `key`, so the component survives a chat switch; the reset effect
(`:135-138`) resets only `follow` and `forking`; `<Composer key={chat.id}>` remounts with
`restoredAt = 0`, so `Composer.tsx:313-322` inserts A's lost words and files into B's box.
**Fix:** `setRestore(null)` on `id`, or key `ChatView` by id.

### 7.2 Low · plausible · the live-servers query is always on for a live chat (see 4.14).
### 7.3 Low · plausible · a dismissed lost card comes back after a reload (`queued.ts:97,107-108`: `dismissed` is a ref; the server keeps `undelivered` until the next send), so the message can be sent twice.
### 7.4 Low · plausible · unknown content blocks (`redacted_thinking`, `server_tool_use`, `web_search_tool_result`, `mcp_tool_use`) produce no entry (`shared/src/normalize.ts:140-188` `default: break`, null on zero blocks) and their usage is not folded (`core/usage.ts:121-125`).
### 7.5 Low · plausible · forks may double-count tokens: `UsageFold` dedupes by message id within one file only; `usageSeries`/`usageBreakdown` sum chats with no cross-chat dedupe (`usage-series.ts:76,128`, `usage-report.ts:93`).
### 7.6 Low · plausible · replay protection relies on a 50-entry uuid window and on timestamps that may be null (`chat-stream.ts:90,114-121`).
### 7.7 Low · verified · dead: `FindButton` (`TranscriptSearch.tsx`), `guardEventNotice`, `unconfirmedTail`, `isOptimistic` (test-only).
### 7.8 Nit · permission-question answers keyed by question text (`PermissionPrompts.tsx:152-176`).

Sound: stream opening with `since`/`Last-Event-ID` and the server subscribing before replay;
delivery events stored and replayed; cards keyed by chat; card clearing on `delivered`/`carried`,
on a `written` entry with the id (`source_uuid` of `queued_command` lines), or on a read that no
longer lists it after 3 s; send path (id from `getRandomValues`, retry keeps the id, only what was
sent is cleared); cost baselines reset on spawn; Markdown renders raw HTML as text and refuses
`javascript:`/`data:` links; no `dangerouslySetInnerHTML`; hooks clean up.

## 8. The API, security and contract

### 8.1 Critical · verified (reproduced on this repo's Fastify 5.12.7) · the auth guard is bypassed by an alternate spelling of the path
`apps/api/src/security.ts:744` `isGuarded(path)` and `:895-897` decide from `pathOf(req.url)`,
the raw request target, while Fastify routes on the decoded, normalised path. Reproduced with
`app.inject` on `apps/api/node_modules/fastify`: `/%61pi/chats` → hook sees `req.url =
/%61pi/chats`, route `/api/chats`, 200; `GET http://evil/api/chats` (absolute form) → route
`/api/chats`, 200; `/api/../api/chats` → 200. `isGuarded` returns false for all of them, so in
token or OIDC mode neither the bearer check nor the host allowlist runs and the request ends as
`req.actor ??= 'local'` (`:1054`): full API, terminals (the gate treats the actor as local),
credentials. Read-only mode (`:1093`), the audit trail (`onResponse` needs `path.startsWith('/api/')`),
DNS-rebinding protection and `/openapi.json`/`/docs` are bypassed the same way; headless keeps its
route allowlist but not the token. No `rewriteUrl`/`routerOptions` in `apps/api/src`; no test with
an encoded path. **Fix:** decide on the matched route (`req.routeOptions.url`, set by `onRequest`),
guard everything that is not the SPA fallback when no route matched, and refuse any `req.url` that
does not start with `/` or where `decodeURI(path) !== path`; add tests for `/%61pi/health` and
absolute-form targets. Under `mode: none` (the desktop default) nothing is guarded anyway.

### 8.2 High · verified · a chat's token can answer any chat's permission prompts (= 4.5)

### 8.3 High · verified · the chat-token denylist leaves 133 mutating routes open, several of which undo the rules it enforces
Applies with auth on. Escalation: `PATCH /chats/:id` (`routes/chats.ts:287`) lets a chat set its
own `permissionMode` to `bypassPermissions`; `POST /chats` with arbitrary mode, tools, cwd, MCP
starts a stronger sibling (the MCP's `start_chat` narrows the fields; the route does not);
`PUT /chats/:id/mcp/:name`, `PUT /chats/:id/claudio-mcp`. Standing instructions and code:
`PUT /config/instructions` (CLAUDE.md), `PUT /config/resources/:kind/:name` (agents, skills,
rules), `PUT /config/files/content` with `executable`, `PUT /config/settings` (hooks),
`PUT/DELETE /config/mcp/:name`, `PUT /memory/:project/:name` (while `CHAT_FORBIDDEN_MEMORY`
forbids approving a proposal for that reason), `POST /projects/:id/journal`,
`POST /plugins/install|marketplaces`. Credentials: `PUT`/`DELETE /auth/credentials`
(`system.ts:88-89`), so a chat can replace the key with an attacker's. Settings: `PUT /settings/app`
blocks a chat only for `dailySpendCapUsd` and `evalsPhase2` (`app-settings.ts:13-16`) and leaves
`allowedHosts`, `defaultPermissionMode`, `maxConcurrentRuns`; `PUT /config/tool-presets/*`;
`POST /schedules`, `/schedules/:id/run`; `POST /push/subscriptions` (an attacker endpoint receives
chat titles and notification text). Lesser: PR creation and `integrate` on orchestrations and
work items, Supervisor send/dismiss, `DELETE /projects/:id`, `DELETE /projects/:id/state`.
**Fix:** the plan's deny-by-default: a class per route in `ROUTE_DOCS`, writes refused to `chat:*`
unless allow-listed, a test that forces classification.

### 8.4 Medium–high · verified by reading · sign-in device codes and Tailscale login URLs reach chat tokens through `/events`
`GET /setup/logins/:id` is forbidden to chats so a chat cannot read a sign-in code, but
`packages/core/src/setup/logins.ts:246` publishes the whole session (`url`, `code`) as
`login.updated` on the global bus; `routes/events.ts` filters nothing per actor and a chat token
may subscribe, and the ring buffer replays it via `Last-Event-ID`. A prompt-injected chat can
approve a `gh`/`glab` device sign-in with its own account, and for Tailscale the URL is the
sign-in. **Fix:** strip `url`/`code` for non-owner streams.

### 8.5 Medium · verified by reading · one shared failed-auth bucket can lock the owner out behind socat
`security.ts:154-166`, `:866-886`: `backoffKey` is `req.ip` for a host not in `runtimeHosts`;
behind `socat` every LAN client and the desktop's own loopback traffic share `127.0.0.1`;
`authenticate()` checks `retryAfter` before resolving the credential, so a valid token gets 429
while the bucket waits (60 s after 10 failures), failures during the wait do not refresh `at`,
and an expired chat token also counts. One wrong credential per minute from any LAN device keeps
everyone, desktop included, at 429. Same shape behind Docker published ports. **Fix:** key by IP
plus dialled `Host`, let a credential that previously succeeded bypass the wait, or trust a
configured proxy header. Related: a LAN client through socat that sends `Host: localhost` looks
loopback to `fromLocalMachine*`, so under `none` it satisfies the terminal gate's local check.

### 8.6 Medium · verified by reading · any unauthenticated client can flush the audit log
`security.ts:1112-1126` appends a row for every mutating request under `/api/`, refused ones
included (`anonymous`, 401/421/429), uncounted and unlimited; retention is the newest 50 000 rows
(`db.ts:1604-1606`, `:2146`), so ~50 000 anonymous `POST /api/x` evict the history, including
evidence of a compromise; the raw path is stored unbounded.

### 8.7 Medium–low · concrete route bugs
- `POST /orchestrations/:id/pull-request` answers 500 `internal error` where it should be 4xx:
  `OrchestrationPullRequestError` (`orchestrator.ts:3172` → `pullRequests.open`) has no
  `statusCode` and `deliberate()` is false; the message ("cli-missing", "nothing-to-propose") is
  lost; the work-item route maps `ChangeRequestError` and is tested, the orchestration one is not.
  Other `Error` subclasses without `statusCode` (`MergeError`, `HostBusyError`,
  `ItemDocumentsError`, `PolicyUnsupportedError`) are worth the same check.
- Uploading a file named `meta.json` corrupts it: `packages/core/src/uploads.ts:71` writes the
  bytes to `<id>/<safeName>` and `:73` writes the metadata to `<id>/meta.json`, the same file;
  `attachment.path` then reads the metadata. **Fix:** fixed payload name or reject the name.
- `app.ts:166` maps any `Error` whose message contains "not found" to 404 (a binary not found
  becomes 404).

### 8.8 Low
- SSE backpressure: `sse.ts:92` ignores `reply.raw.write`'s return, no cap on concurrent streams;
  `SseStream.onClose` never runs a cleanup registered after the close (latent).
- CSRF under `none`: no `Origin`/`Sec-Fetch-Site` check on non-GET; body-less simple POSTs
  (`/api/tunnel/stop`, `/api/accounts/refresh`, `/push/test`) can be issued cross-site.
- Push endpoint SSRF: `push.ts:186-198` accepts any `https:` URL with no public-address check
  (blind POST of ciphertext to an internal address), reachable by a chat token (8.3).
- Uploads use sync 50 MB reads/writes on the event loop with no quota.
- OIDC: any valid token for the audience is the owner (no `sub`/group allowlist); before the first
  key fetch or while the issuer is down, every well-formed forged JWT costs two outbound fetches.
- `CHAT_FORBIDDEN_REVIEW_GATE` is tested twice.
- Dead surface: `GET /chats/:id/logs` and `GET /orchestrations/templates/:templateId` have no
  caller; `GET/PUT /settings/supervisor` are deprecated and used only by an e2e spec; the tag
  `Projects & sessions` is unused; `Account`/`Accounts` are near-duplicate tags.

Sound: 481 registrations match `ROUTE_DOCS` one to one (the `/v1` prefix and the plugin action
loop explained); every `ref()`/`list()` exists in `schemas.json` (909 definitions, no drift
against `types.ts`); all 414 web `request()` calls resolve to real routes (the only broken caller
in the repo is the MCP's `GET /projects/:id`); all 162 denylist entries name real routes; the 37
`HEADLESS_ROUTES` exist and are enforced at `onRoute`; webhook receivers verify over raw bytes
with a size cap; SSRF guards in `fetch-image.ts` and `workspaces/download.ts` (block list with
IPv4-mapped IPv6, connect-time check, every redirect re-judged); document/path routes refuse
`..`, hidden, backslash, NUL and symlinks; uploads never inline SVG/HTML; secrets are kept out of
answers, MCP configs redacted, `?token=` redacted in logs; terminal tickets single-use, hashed,
origin-bound; the error handler hides non-deliberate 5xx text. Modes: under `none` every request
is `local` and only the review-gate, collaborators and terminal chat sets apply; `/v1` demands a
credential in every mode.

## 9. Core engine, storage, events and performance

### 9.1 High · verified · why `/overview`, `/projects`, `/usage` and `/chats` are slow
Every one of these routes re-lists and re-checks **every Claude transcript on the machine** on
every call, once or twice, and in-flight listings are never shared. On the owner's machine that
is 662 project dirs and 1 439 transcripts (3.5 GB).
- `listSessions()` (`sessions.ts:563-579`): one `readdir` per project dir, then `open`+`fstat`+`close`
  per `.jsonl` (`readTranscript`, `:494-499`) even when nothing changed: ~5 000 threadpool
  operations per listing on a pool of 4 threads (nothing sets `UV_THREADPOOL_SIZE`); concurrent
  callers queue behind each other per file (`:487-491`) instead of sharing a result; after a
  restart the first listing `JSON.parse`s all 3.5 GB on the main thread in 1 MB chunks
  (`transcript-index.ts:4,48-69`), which is the 23–41 s maxima.
- `cliSessions()` (`chat-service.ts:308-345`, `cli.ts:10` `execCli(['agents','--json'])`): a
  full CLI start, fresh 1.5 s, stale up to 10 s (`CLI_FRESH_MS`/`CLI_STALE_MS`, `:110-111`); while
  anything polls, a `claude` process starts every 1.5–10 s.
- `GET /overview` (`system.ts:85` → `index.ts:3700`): `chats.list()` → `facts()` (`:390`,
  `listSessions` + `cliSessions`), then per chat a process-table scan (`standing`, `:406`) and
  `place(dir)`; then `allActivity()` → `activityChats()` calls `cliSessions()` and `listSessions()`
  **again** (`:1339`) and `entriesOf()` calls `facts()` again (`:1303`), reading subagent, task and
  workflow files per chat, only to **count** running tasks/subagents/workflows
  (`index.ts:3716-3718`); then `accountsSnapshot()` + `limitReadings()` run `AccountStore.list()`
  3–4 times with sync reads per account (`store.ts:249-317`). The desktop tray refreshes it on
  every `run.*` event (`live-monitor.ts:162`) with a 10 s timeout: the 2 555 aborts.
- `GET /chats`: same `facts()`; `project` is filtered **after** `assemble`/`place` (`:495`), so a
  project page places all ~1 400 chats; no default `limit`, every `ChatSummary` serialised.
- `GET /usage`: `spends()` does a full listing plus `place()` per chat; the Usage page fires
  `/usage`, `/usage/series` and `/usage/breakdown`, three listings per load.
- `GET /projects` (`index.ts:2443-2547`): `listSessions()` plus `chats.list()` (a second listing
  plus `claude agents`), and synchronous work on the main thread: `realpathSync` per worktree chat
  and creator path (`:2451-2462`, `:2497`), `projectSettingsStore.readAll` reading and parsing
  every project's JSON per call (`project-settings.ts:598-604`), `existsSync` per project,
  `repos.worktreesOf` sync reads (`repos.ts:253-300`, 30 s cache), `coreConfigOf` reading
  `.git/config` per project uncached (`index.ts:2558`); and the placement cache expires every 60 s
  (`repos.ts:539,609`), after which the first list re-resolves every distinct chat dir
  synchronously, falling back to **`execFileSync git rev-parse` with a 10 s timeout**
  (`repos.ts:203-213`): the likely source of the periodic multi-second spikes.

Event-loop blockers that stall every live chat's stdout reader, SSE and SQLite:

| Where | What | Cadence |
|---|---|---|
| `health-service.ts:68-81` `fingerprint()` | `isGitRepo` + `headCommit` + `git status --porcelain` + `git diff HEAD --numstat`, all `execFileSync` (`git.ts:18`), 10 s TTL | every 15 s per working chat (`HealthMonitor.check`, `:265-290`) and on every `GET /chats/:id` (`chat-service.ts:562`) |
| `orchestrator.ts:1917-1950`, `1329-1352` | `commitTask`, `addWorktree`, `merge` (120 s timeout), `contains`, `branchExists`, all sync git; `retryIntegration` runs inside an HTTP request | per integration and per dependent task launch |
| `repos.ts:203-213` | sync `git rev-parse`, 10 s timeout | at each placement expiry (60 s) |
| `sessions.ts` cold scan | 3.5 GB of `JSON.parse` | every restart |
| `chats.ts:394-429` `persist()` | `JSON.stringify` of every in-memory chat's record and executions, to diff | every turn of every chat |
| `orchestrator.ts:748-755` `persist()` | re-serialises and upserts every orchestration, ~48 call sites | after each verification command, among others |

**Cheapest fixes, in order:** (1) reuse the last `listSessions()` while the existing
`SessionsWatcher` (`event-sources.ts`, recursive `fs.watch`) reported no change, re-check only the
files it named, share the in-flight promise, and persist each file's fold (ino, size, mtime,
offset, summary) in SQLite so a restart does not re-parse 3.5 GB; (2) `/overview` counts from
`runtime.list()` (running chats already carry `backgroundTasks`/`subagents`/`workflows`) and a
2 s cache invalidated by bus events; (3) `cliSessions()` from the `/proc` scan already in
`processes.ts` on Linux, `claude agents --json` only elsewhere, or a 30 s TTL invalidated on
`forgetHolders()`; (4) `/chats`: filter `project` before `assemble`, default `limit`; (5)
`/usage`: cache `spends()` per listing generation; (6) `/projects`: cache `readAll` and
`coreConfigOf`, memoise `realpathSync`, make `repoFromGit` an async background refresh serving
the stored `repo_places` row meanwhile; (7) health `fingerprint` through `gitRawAsync` or
`probeChanges` (`git.ts:613`, already async); (8) `UV_THREADPOOL_SIZE=16` in the launcher, API
and desktop entry points meanwhile. The split of the 700 ms p50 between threadpool queueing, the
`claude agents` spawn and main-thread assembly needs a `--cpu-prof` on the owner's machine.

### 9.2 High · verified · an unhandled rejection when resuming a workflow crashes the API process
`orchestrator.ts:3612-3622`: `void this.runs.exited(previous.id).then(async () => { … this.runs.send(previous.id, prompt); … }).finally(…)`
with no `.catch`; the lead's process has exited, so `send` → `sendMessage` → `admit` →
`spawnProcess` throws on `RunSlotRefusal`, the memory refusal, a missing cwd (D9) or "session
still running in process" (`chats.ts:922-953`, `1885-1895`); no `unhandledRejection` handler
exists in `apps/api` or the launcher (only `guards/main.ts` and `collab/host/main.ts`), so Node
ends the process. Reproduce: fill every slot, resume a workflow orchestration. **Fix:** `.catch`
that reschedules on transient refusals and fails the graph otherwise; a logging
`unhandledRejection` handler in `apps/api/src/server.ts`.

### 9.3 Medium · verified · `checkBranch` can leave `verifying` set for ever
`orchestrator.ts:2188-2190`: `this.verifying.set(orch.id, control); const startHead = headCommit(root);`
sit before the `try/finally`; a sync git failure leaves the orchestration refusing verify, resume,
remove and retry with "checks are running" until restart, and the rejection reaches `void`
callers (same crash as 9.2).

### 9.4 Medium · verified · a dependency-merge conflict is forgotten after a slot refusal
`orchestrator.ts:1313-1358`, `1389-1398`, `1488-1494`: the first `prepareWorktree` records
`pendingMerge`; if `runs.start` is refused for a slot, the retry finds the worktree
(`existsSync`) and `pendingMerge` stays null; the worker runs in a tree with conflict markers
untold, and `commitTask` later refuses to commit a tree with a merge in progress.

### 9.5 Medium · plausible · Resume within 5 s of Stop fails the resumed task
(`orchestrator.ts:1428`, `1467`, `1537`, `1551`): result listeners carry no attempt identity, so
the old attempt's close resolves `ended(chat,'stopped')` after `continueChat` set the task back
to `running`, and `settle` marks it `failed`. **Fix:** stamp each attempt.

### 9.6 Medium · verified · verification commands leave background children alive after a normal exit
`verification.ts:380-412` signals the process group only on timeout or cancel; a dev server or
watcher started by a check outlives it, once per check pass and per fixer re-run.

### 9.7 Medium · verified · chats are never dropped from memory and `persist()` is O(all chats) per turn
`chats.ts:394-429`, `live-chat.ts:42,884-887`: `this.chats` loses entries only through
`remove()` (API chats have a sweep; workers, flow runs and person chats stay until restart), each
with up to 5 000 events and its executions; `persist()` serialises every chat and execution on
every turn to diff; `restore()` replays every stored chat's whole transcript at start
(`chats.ts:469-470`, sequential). `event-sources.ts:163,255-273` per-subagent maps are pruned
only on `forget`. **Fix:** evict ended, non-live chats after N hours; a dirty set in `persist()`.

### 9.8 Medium · verified · the chat trim leaves orphan rows
`db.ts:2201` `DELETE FROM chats WHERE id NOT IN (… LIMIT 200)` cascades only to `executions`
(the one FK, `:1635`); `chat_entries` (`:640`), `chat_compactions`, `chat_notes` (`:929-971`),
`chat_uploads`, `chat_upload_scans` (`:1332-1341`) keep a trimmed chat's rows for ever
(`deleteChat`, `:2205-2216`, cleans them; the trim does not). The owner's `wrapper.db` is 94 MB.

### 9.9 Low–medium
- A transient slot refusal fails the integrator, synthesis and fixer (`orchestrator.ts:1966`,
  `2035`, ~`2539`; the fixer attempt is still counted, `:2411`); `review-gate.ts:439` already
  has the wait-for-slot loop to reuse.
- A synchronous `spawn` throw (ENOMEM, E2BIG) leaves the chat `starting` with an execution that
  never ends (`chats.ts:1919-1956`: state reset and `beginExecution()` before `mkdirSync`/`spawn`,
  the catch only revokes the token).
- Past `idleTimeoutMs()` `evictable` ignores `runsInBackground` (`chats.ts:872-875`), so admission
  over-subscribes while the old process keeps running (ties in with 1.2).
- `stopAll()` arms `unref`'d 5 s SIGKILL timers that never fire before exit (`chats.ts:1195-1206`
  via `index.ts:3893`); a child ignoring SIGTERM survives the server; the root gets SIGTERM twice.
- `Core.shutdown()` closes the DB under `void this.evals.close()`, `void this.terminals.shutdown()`,
  `void this.collaborators.dispose()` (`index.ts:3876`, `:3889-3895`); and `tunnel.shutdown()`
  blocks first (5.12).
- The time-limit reason is overwritten by "The process ended (stopped) without a result"
  (`orchestrator.ts:828-835`, `1805-1836`).
- Orchestrator leaks: `remove()` (`:3346`) never clears `workflowBaseline`, `journalFrom`,
  `journalTasks`, `workflowGrowth`, `journalBytes`, `followedAt`, `recordEnded`, `lateArrivals`;
  `warned` (`:838`) never pruned; the `chat-result` listener (`:607`) not removed in `close()`;
  the workflow watcher re-reads the whole `journal.jsonl` every second
  (`workflow-journal.ts:64-71`, `workflows.ts:373-392`).
- Flow and schedules: `flow.ts` ~1500-1582 awaited work between `claim()` and the `try` around
  `launch` can leave a row `running` with `chat_id NULL`, holding `maxParallel` until restart; a
  scheduled chat refused for a slot fails for good while orchestration targets queue
  (`schedules.ts:667-683`); `tick()`/`drain()` swallow every error silently (`:527-534`);
  `SessionsWatcher.watchHolders` (`event-sources.ts:661-674`) has no in-flight guard on its 4 s
  interval.
- Silent persistence failures: `chats.ts:426` and `orchestrator.ts:752` swallow `saveChats`/
  `saveOrchestrations` errors; the legacy imports (`chats.ts:436`, `orchestrator.ts:733`) rename a
  corrupt file to `.migrated` without saying so.
- `orchestrator.ts:1492` matches `message.includes('Concurrent run limit')` although
  `RunSlotRefusal` exists; `processes.ts:241` `descendantsOf` is O(n²) (array copies); `db.ts`
  prepares every statement per call (`node:sqlite` has no cache; hot in `storedChats`/`saveChats`);
  `tx()` uses a deferred `BEGIN` (`:1940-1949`) where read-then-write transactions want
  `BEGIN IMMEDIATE`; `usage_history.account` is declared `INTEGER` (`:169-178`, a claude-swap
  leftover; ids are strings); `'__review__'` is defined three times (`orchestration-timings.ts:33`,
  `orchestrator.ts:128`, `chat-service.ts:193`).
- Legacy paths still live: the `runs.json` import (`chats.ts:432`), the `orchestrations.json`
  import (`orchestrator.ts:729`), the `runs`→`chats` migration (`db.ts:1625`), the
  `supervisor.json` read (`decisions/settings.ts:244`), 19 "agentry" names
  (`tunnel.ts:257 startWithAgentry`); `LEGACY_PROVIDER = 'claude-code'` (`chat-records.ts:6`) is
  live, only misnamed.
- Dead in core, no reference anywhere: `assistant.ts:263 DENIED_READS`, `collab/roster.ts:209 renameGroup`,
  `collab/wire.ts:72 WireRequestType`, `db.ts:1549 EVALS_V2_SCHEMA_VERSION`,
  `decisions/providers/cli.ts:19 DECISION_POLICY`, `git.ts:502/515/590`, `guards/git.ts:104`,
  `lessons/signals.ts:313`, `openai/responses-wire.ts:56 InputContent`,
  `orchestration-timings.ts:33`, `processes.ts:93 agentRunProcesses` (duplicated inline in
  `terminals/peer.ts:34`), `terminals/settings.ts:32 TERMINAL_DEFAULTS`; re-exported from
  `index.ts` and consumed nowhere: 137, among them `READ_ONLY_TOOLS`, `DENIED_TOOLS`,
  `readDataDirLock`, `testCommandRules`, `startGuardSweep`, `guardFailure`, `hasRedacted`,
  `foldUsage`; test-only: `hosts/redact.ts:30 redactHostObject` (worth checking that no host
  store saves raw host JSON), `git.ts` `commitsBetween`/`parentOf`/`fileDiff`/`untrackedDiff`,
  `processes.ts:192`, `handshake.ts:52`, `trackers/adapters.ts:22`. 834 catch blocks, 225 empty
  or comment-only, 147 `.catch(() => {})`; 130 `as unknown as`, ~120 of them `node:sqlite` row
  casts; 0 TODO/`any`/`@ts-ignore`.

Sound: spawn handlers keyed on `chat.proc === proc` (`chats.ts:1973`), `close` decides the
outcome, `finalize` idempotent; admission defers eviction until a successful spawn, `slotReserved`
carries across a replacement, `InteractiveHold` gives people priority; `terminateTree` re-checks
pid and start time; migrations run one `BEGIN IMMEDIATE` each with `user_version` inside; WAL,
`busy_timeout`, `foreign_keys=ON`; `JsonlCache`, `EventBus` (1 000, contiguous replay),
`LiveChat.events` (5 000), receipts and undelivered are bounded; `cron.ts` handles DST; restart
recovery ends running verification/review/integration; `continueChat` waits for `exited()`;
`close()` clears the orchestrator's timers; `chat-retention.ts` never overlaps nor deletes a live
chat; all 72 bus event types and 11 `RunEventKind`s have a producer and a consumer (no orphans).

## 10. The web app's data wiring

### 10.1 High · verified · a TypeError in the orchestration cache patchers aborts the rest of the event handler
`apps/web/src/api.ts:1369` `keys.orchestrations = ['orchestrations']`; `OrchestrationDetail.tsx:243`
and `:394` put `['orchestrations', id, 'workflow']` (`{ path, script }`) and
`['orchestrations', id, 'workflow-run', runId]` (a `ChatDetail`) under that prefix; `events.ts:538`
and `:572-574` call `setQueriesData({ queryKey: keys.orchestrations }, list => list?.map(…))` /
`list?.some(…)`, which runs on those objects and throws `list.some is not a function`. The throw
happens in `onEvent` after `lastId = event.id` (`:684`) and before `invalidations.schedule`
(`:693`) and `dispatchEvent` (`:694`), so for that event the list, the detail, the chat lists and
every `useClaudioEvents` listener miss it. Live whenever a workflow-engine orchestration's page is
open or was open in the last 5 minutes. **Fix:** move those keys under `['orchestration', id, …]`,
guard the updaters with `Array.isArray` (as `patchSubagentActivity` does), and schedule
invalidations and dispatch before the patchers or wrap each in `try/catch`.

### 10.2 Medium · verified · `GET /chats/:id/mcp` is a live control request re-sent on almost every chat event (= 4.14)
`useLiveServers` is mounted all the time by the status-line chip (`Composer.tsx:73`,
`Controls.tsx:89`) with `staleTime: 0` and the default `retry: 1`; its key sits under
`chatScope`, which is invalidated on every status-changing `run.updated`, `task.*`, `subagent.*`,
`workflow.progress` (`events.ts:189`), `run.ended` (`:276`) and `sessions.changed` (every chat).
Each refetch is `session.mcpStatus()` to the CLI. A second private copy of the query lives in
`ContextPanel.tsx:133`. **Fix:** key it outside `chatScope`, refresh on `health.changed`, panel
open and toggles, `retry: false`.

### 10.3 Medium · verified · notifications are never reconciled after the feed resyncs
`Notifications.tsx` runs `seedWaiting` once per load; `events.ts` `resync()` (boot-id change,
`stream.resync`, a parked tab back after a buffer overflow) only invalidates queries, so a
`run.waiting` raised in the gap is never notified and a prompt answered elsewhere keeps a stale
"waiting" toast. `settleJoinRequests` has the same shape.

### 10.4 Medium–low · plausible · "Today" in the status bar and the spend meter use different days
`lib/usage-now.ts:5-21` asks `/usage` for the browser's local day; the server buckets by its own
local day (`core/usage.ts:82`) and the spend cap uses the server's (`SpendState.day`/`timezone`
already carry it); a browser in another zone (LAN phone, tunnel, container in UTC) shows "no cost"
for hours or yesterday's figure next to the meter; `['usage']` is not invalidated on
`spend.changed`, so during a long turn the meter moves and "Today" does not.

### 10.5 Low–medium · verified · no error boundary and no `errorElement` (`main.tsx:50-68`; the only boundary is the dashboard widget's): a render exception shows React Router's developer page in place of the shell.
### 10.6 Low–medium · plausible · `first-run.ts:35-37` hides the setup wizard on `settings.isError || setup.isError`, which in react-query v5 includes a failed background refetch while data is held; `SetupAssistant.tsx:297` invalidates `keys.setup` after saving and `GET /setup` probes every tool, so one transient failure drops the person into the main app mid-wizard.
### 10.7 Low
- `ReloadOffer.tsx` `lazyPage`: `React.lazy` caches the fallback, so one transient chunk failure
  pins the route on `StalePage` and the "stale" banner for the session.
- `lib/api/collaborators.ts:97`, `pages/project/shared-data.ts:74` and `uploadFile`
  (`api.ts:471`) call `fetch` directly and skip the 401/421 handling of `request()`.
- Fixed-interval polling that ignores the feed, against `docs/api-wire.md`: `Accounts.tsx:37`
  (10 s; rotation events invalidate `keys.accounts` only), `GuardsCard.tsx:403`,
  `AuditCard.tsx:72,320`, `MemoryOverview.tsx:9` (15 s), `Engine.tsx:251` (30 s), `Checklist.tsx`
  (10 s), `Activity.tsx` (5 s), `Changes.tsx:243-296` (8 s, one `git diff` per tick, whenever
  `chat.alive`, which includes chats held by a terminal); `LIVE_REFRESH_MS` defined twice.
- `StatusBar.tsx:68` shows "live updates paused" in warn tone whenever the feed is `connecting`,
  including the first second after load.
- `claudio-assistant/Entry.tsx:35` reads the project scope without `settled`: a deep link plus a
  fast send starts the assistant with `projectId: null`.
- `terminal-connection.ts` has no connect timeout.
- A desktop port change (fallback when the remembered port is taken, `server-port.ts`) silently
  loses localStorage, the service worker and the push subscription; documented, but nothing warns.
- Notifications across tabs: each tab ingests every event and writes the whole state; two
  near-simultaneous events can lose a notification or a read flag (plausible).
- `MergeNotices.tsx:21` formats the time with the browser locale, not the app language.

### 10.8 Same fact, several paths (beyond accounts, see 2.11)

| Fact | Producers | Consumers | Disagreement |
|---|---|---|---|
| Chat state | `/chats` rows (server `chatState`), `patchRun` (`runState`, a client re-implementation), `patchActivity`, overview counts | Chats, Home, sidebar, top-bar chip, notifications | `runState` ignores foreign CLI state and `atLimit`; sidebar counts and the Live chip are not project-scoped while Chats/Orchestrations/Schedules are |
| Cost / spend | `chat.cost.usd` (patched from `run.updated`), `/usage` (transcripts, by server day), `/spend` (ledger) | chat header, "Today", `SpendItem`, Usage, `SpendWait` | three sources, three days or refresh triggers (10.4) |
| Provider readiness | `overview.system.cli`, `system.auth.inUse`, `useProviders()`, `useAccounts()`, `accountsSettings` | `useConnection`, Home `providerSetup` | `useConnection` fixes the provider to `CLAUDE_CODE_ID`; `accountsSettings` has no invalidating event |
| Selected project | `localStorage claudio:project`, `?project=`, `useProjects()` | top bar, lists, filters | no `storage` listener, so two tabs diverge; Orchestrations/Schedules filtered client-side (`inProject`), Chats server-side |
| Orchestration progress | list rows (status only), detail, board | list, Live strip, detail | brief windows, permanent under 10.1 |
| Unread / waiting | localStorage notifications vs `overview.counts.chatsWaiting` | bell, sidebar badge | 10.3 |
| Version / update | `stream.hello.version` vs `BUILD_VERSION`, `keys.release`, `['server-update']`, desktop bridge | banner, Settings dot, `UpdatesCard` | `keys.release` has no polling, stale with the feed down |

Sound: one `EventSource` per `Shell`, backoff capped at 15 s, resume by id, boot-id and
`stream.resync` full invalidation, replays dropped, hidden tabs parked after 30 s, bfcache and
`visibilitychange` handled, listeners removed; chat stream likewise; `request()` maps 401 → sign
in, 421 → host refused; module-level listeners are singletons; `useEffect` fetches guarded;
i18n `en`/`es` key sets identical across 38 namespaces; every file under `apps/web/src` is
imported; no native controls, no `any`, three justified `eslint-disable`, no raw colour/px/ms
outside `tokens.css`. Candidates: 5 orphan i18n keys (`components:palette.userScope`,
`orchestrationDetail:elapsedLabel`, `workItem:pr.readyBadge`, `evals:editor.promptHint`,
`work:projects.lastActivity`), 21 dead exports (`review-model.ts:matchesFilter`,
`observe/Work.tsx:ChatActivityCard/ChatChangesCard`, `lib/trackers.ts` ×4,
`lib/change-requests.ts` ×2, `lib/theme.tsx:useThemeChanged`, `lib/webhooks.ts:publicOrigin`,
`lib/work-items.ts:groupByStatus`, `decisions/model.ts:isLimited`, `dashboard/layout.ts:SIZE_SPANS`,
`projects/model.ts:FOLDER_NAME`, `tasks/board/model.ts:byRank`, `team/RoleAvatar.tsx:ModelName`,
`team/evals/Start.tsx:StartPanel`, `lib/api/collaborators.ts:useProjectSharing`, `lib/reviews.ts:threadPlace`,
`i18n/resources.ts:SpanishHasNoExtraKeys`), `lib/legacy-storage*.ts` (its header says it can go),
127 CSS classes never referenced (`account-config*` ×11, `account-row*`, `chip-toggle`,
`today-limits`, `overlay-drawer`, `team-live-spin`, `rg-actions-note`, `home-hero-icon`,
`obs-subhead`, `usage-series-0`, `rt-edit`, `combobox-input`, `project-form`, …; check e2e
selectors first). The scripts are in the web auditor's appendix (reproduced in the session
transcript).

## 11. Dead code, duplication, conventions, docs drift

### 11.1 Medium · verified · `@claudio/accounts` tests never run
`package.json:19` (root `test`) filters shared, core, api, mcp, web, ui, chat-ui and desktop, not
`@claudio/accounts`; `.sluice.toml:41-44` and `.github/workflows/ci.yml:100` call `pnpm test`, so
`accounts.test.ts`, `cli-usage.test.ts`, `key-check.test.ts`, `sign-in-state.test.ts` (the
`get_usage` parser among them) never run in CI. **Fix:** add the filter.

### 11.2 Medium · verified · the fake-CLI self-tests are run by nothing
`e2e/fake-cli/claude.test.mjs`, `mcp.test.mjs`; `ci.yml:107` runs only `shards`, `remote`,
`harness`. The fake `claude` drives every `fakeCli` spec.

### 11.3 Medium · docs drift
Broken wiki links: `[[plans/terminal-persistence]]` (`docs/updates.md:227`,
`plans/unified-updates.md:315,1342`, `decisions/shell-payload-updates.md:100`),
`[[reports/release-e2e.md]]` (`reports/release-readiness.md:72`, plain links at 9 and 55),
`[[reports/cw-14-qa.md]]`, `[[research/terminal.md]]`, `[[qa/cw-21-verification.md]]`,
`[[rest-api-contract.md]]` (`plans/openai-compatible-api.md:221`), `[[lessons-from-corrections]]`,
`[[guard-hooks]]` (`reports/ecc.md:479`). Wrong relative links in `plans/projects-as-repositories.md:713-714`,
`plans/english-records-rule.md:92,102`, `plans/assistant-mascot.md:490`. Stale paths in live
docs: `docs/slash-commands.md:35-36` (moved to `packages/chat-ui`), `docs/code-hosts.md:934`
(`packages/core/scripts/redact-recordings.mjs`), `docs/team-and-flow.md:944`
(`packages/core/src/models.ts` does not exist) and `:263` (`docs/plans/x.md`). `docs/status.md:18-27`
counts are stale (types.ts 9 606 → 10 052 lines; route files 39 → 44; e2e specs 90 → 92; test
files 557 → 626; tracked ts/tsx 1 578 → 1 721), `assistant-mascot` still "pending" though shipped
in 0.8.0, 20 plans missing from the table, the `/v1` API absent from `README.md`, `ROADMAP.md`,
`docs/features.md`. `docs/known-limitations.md:59` gives a reason the desktop no longer has.
`CLAUDE.md` Layout omits `packages/accounts` and `packages/mcp`; `package.json` `lint` covers
only `packages/core/src/collab`.

### 11.4 Medium · verified · duplicated `ContextRing`
`packages/chat-ui/src/components/ContextRing.tsx:13` is exported from the package and imported by
nothing; `apps/web/src/pages/dashboard/widgets/live.tsx:67` re-implements it with a different
share formula (`contextShare` vs `used/window`).

### 11.5 Low–medium · duplicated helpers
~35 record guards (`isObject`/`isRecord`/`asRecord`, 27 in core, with differing semantics);
`hourMinute` twice (`changes/review-model.ts:155`, `home/memory/model.ts:33`) beside
`ui/lib/format.ts:104` `formatHour`; ad-hoc time formatting in `spend-cap.ts:112-114` and
`MergeNotices.tsx:21`; error-to-message in 8 places (`messageOf` ×5, `errorText`, `errorMessage`)
plus 92 inline `instanceof Error ? .message : String(e)`; `sleep` ×4 in core (`review-gate.ts:213`,
`data-dir-lock.ts:156`, `launcher/main.ts:28`, `updates/download.ts:76`) and ~20 in e2e;
`readJson` twice (`workflows.ts:65` returns `null`, `config/files.ts:8` returns `{}`); two
`formatPercent` with different signatures (`ui/lib/format.ts:207`, `chat-ui/lib/chat-model.ts:32`);
three `serve status --json` parsers in `tunnel.ts` (5.12); `commandSegments` ×3 (3.10).

### 11.6 Low · unused exports and contract drift
`packages/shared`: `StreamControlEventType` (`types.ts:9502`) referenced nowhere; 29 `valuesOf(…)`
lists never read (`assistant.ts:22-51` ×7, `work-items.ts:58-298` ×19 such as `FLOW_STAGES`,
`FLOW_RUN_STATES`, `JOURNAL_ENTRY_KINDS`, `MEMORY_PROPOSAL_ACTIONS`; `evals.ts:32`
`EVAL_FILE_VERSION`); 90 more types used only inside `types.ts` (event-union members, fine).
Dead everywhere: `ui/components/motion.tsx:105` `ThinkingDots`; `chat-ui` `FindButton`;
`desktop/switch.ts:75` `DEB_REMOVE_COMMAND`; `dashboard/widgets/QuickStart.tsx:21`
`QuickStartWidget`; core `git.ts:502,515,590` `isAncestor`/`resolveCommit`/`isUntracked`,
`guards/git.ts:104` `gitDirectory`, `collab/roster.ts:209` `renameGroup`,
`lessons/signals.ts:313` `correctionsFromEntries`, `processes.ts:93` `agentRunProcesses`.
Across `packages/*/src` and `apps/*/src`: 7 062 exports, 1 026 unused outside their file, 59
unused anywhere, 597 used only by tests. `chat-ui` package `exports` with no external importer:
`ContextRing`, `MediaViewer`, `SlashMenu`, `lib/tool-lens`, `composer/drafts`,
`composer/editor/text`, `chats.css`. Illustration `quota` unused (documented as reserved).

### 11.7 Low
- `packages/core/src/team.ts:146-155` `ROLE_TITLES_ES`: Spanish UI copy in core, outside i18n.
- Five specs missing from `e2e/timings.json` (`chat`, `machine`, `projects-repositories`,
  `settings-reset`, `ui-overlays`), which skews shard splitting.
- The Sluice merge queue lands `Merge …` commits on `main` (3040f2753, e240bf472) while
  CLAUDE.md says pull requests are squash-merged; release-please ignores them.

Sound: the one rule holds (the only Anthropic HTTP call is the SDK `models.list` key check,
`cli-usage.ts:139`; no pty/`script`/`expect` against `claude`); no `any`, `@ts-ignore`,
`@ts-expect-error`; no native controls; no raw colour/px/ms outside `tokens.css` (the three `#fff`
are on the gradient); Conventional Commits in recent history; `CHANGELOG.md` touched only by the
release bot (and the 0.1.0 restart); desktop assets in `electron-builder.yml` all exist; IPC
channels all consumed; workflows, Dockerfile, deploy and packaging reference no missing path; every
`scripts/*.mjs` is referenced; no skipped or `.only` e2e specs.

## 12. The owner's list, answered

| Reported | Root cause found | Where |
|---|---|---|
| Claudio MCP fails to get chats, cannot create orchestrations; "a refactor is missing from main" | The refactor is a plan only (`feat/assistant-everything`). `get_chat` overflows on every real chat and the cut breaks the JSON; reads are not pre-allowed when the server is switched on from "+"; no orchestration tool exists; `start_chat` with a project always 404s | 0, 4.1–4.4, 4.9 |
| Messages sent while the agent works stay pending; "Send now" interrupts background tasks and agents | A message taken without read-back pins the chat busy; Claudio ends stdin while background work runs, holds later messages up to 10 minutes and the CLI then kills the work; "Send now" is a plain `interrupt`, which aborts foreground subagents and detached calls | 1.1, 1.2, 1.4 |
| Collaborators bugs with a peer offline | A request during the host's restart backoff unbinds the endpoint; bind errors only logged; no re-poke when back online; `retryPending` overlaps; 20–80 s blocking routes with a 60 s web timeout | 5.1–5.5 |
| Tailscale collision with other tunnels, no way out | Claudio never wipes other serves; it needs 8444 free and the only override is an env var the desktop cannot set; a concurrent-start race can also remove its own rule | 5.10–5.11 |
| Board drag and drop | Cross-project `afterId` in All projects (400 or wrong place); optimistic update lost to refetches; stuck keyboard grab disables drag | 6.1–6.3 |
| Guards fire although disabled | `integrity` is armed whenever the guard runs, whatever the rule switches; a respawned process keeps the plan it started with | 3.1, 3.2 |
| Rotation: cannot pick the account in use; "Wait until the reset" with free accounts | No preferred account exists (unbuilt); one wait-replay without an account disables rotation for the chat; the resolved model filters accounts; the banner falls back to a provider-wide reading; removing an account under a live chat crashes the server | 2.1–2.4, 2.10 |
| Status bar out of sync with the account in use and the warnings | Two readings (account vs provider-wide), two "in use" rules, three thresholds; the map and the single source of truth are in 2.11 | 2.11 |
| Hints/alerts from the reviewer or decision model fail and go to the current session | No agent attribution in signals, the Supervisor reads the lead's steps and writes to the lead's stdin; one hint per chat per signal kind for ever; a hint cannot reach an agent blocked in a tool call; it claims to come from a person | 3.3–3.6, 1.5–1.6 |

## 13. What to do first

1. **Security, before anything else:** 8.1 (guard decided on the matched route), 4.5/8.2 (permission
   answers forbidden to chat tokens), 8.4 (sign-in codes off the chat-readable feed), then 8.3 as
   the plan's deny-by-default.
2. **Stability:** 2.1 (nullable account lookup, guarded line handler, `unhandledRejection`
   handlers in `apps/api` and the launcher), 9.2 (`.catch` on the workflow resume), 10.1 (the
   orchestration cache patchers).
3. **The owner's daily pain, in one PR per area:**
   - Delivery: 1.2 (no idle end while background work runs), 1.1 (bound `written`), 1.4 ("Send to
     background" instead of a blind interrupt), 1.6 (hints drawn as hints).
   - Accounts: 2.2 (reset `limitReplays` on a completed turn), 2.3 (`opts.model`), 2.4 (banner
     from `chat.atLimit` only, with Switch account / Run now), 2.6, then the single source of
     truth of 2.11 and the preferred account of 2.10.
   - Guards: 3.1 (`integrity` under the switch) and 3.2 (re-derive the plan on every spawn).
   - Supervisor: 3.3/1.5 (attribution and the subagent's steps), 3.5 (per occurrence), 3.4
     (`cancelCommand` for hung commands), 3.6 (a prefix of its own).
   - MCP: 4.1–4.4, 4.6–4.8, then the catalogue of 4.9 with the assistant-everything plan.
   - Board: 6.1, 6.3, 6.2. Collaborators: 5.1–5.4. Tunnel: 5.11 (a port setting) and 5.10.
4. **Performance (section 9.1):** shared, watcher-driven `listSessions()` with a persisted fold,
   `/overview` from runtime counts, async git in the health monitor and the orchestrator; this
   removes most of the "out of sync" feel and the tray timeouts.
5. **Hygiene:** `@claudio/accounts` and the fake-CLI tests into `pnpm test` and CI (11.1, 11.2),
   the guard-file sweep started (3.10), the chat trim's orphan rows (9.8), the docs drift (11.3),
   then the dead code lists of 7.7, 9.9, 10.8, 11.6.
6. **The desktop on this machine:** the updater's `pkexec` failure (section 0) keeps the owner
   on 0.8.1; until it is fixed the owner should install the 0.11.0 `.deb` by hand to test any of
   the above.

## Related

[[accounts.md]] · [[guards.md]] · [[decision-engine.md]] · [[claudio-mcp-server.md]] ·
[[claudio-assistant.md]] · [[chat-delivery.md]] · [[collaborators.md]] · [[tunnel.md]] ·
[[work-items.md]] · [[plans/assistant-everything.md]] · [[reports/chat-audit/README.md]] ·
[[status.md]]
