---
created_at: 2026-11-13T18:00:00Z
updated_at: 2026-11-14T12:00:00Z
tags:
    - plan
    - study
    - accounts
    - rotation
    - rate-limit
    - credits
    - orchestration
---
# Study: work that does not resume after a usage limit, and the credits Claudio ignores

Status: **proposed**; `t1` is built on `fix/chat-waits-at-limit` and `t2` on `fix/limit-survives-restart` (see [Outcome](#outcome)). Was: **proposed** for every task.

On 2026-11-13 the owner reported two problems:

1. Claudio treats an account whose plan quota is spent as stopped, even when the account has credits (extra usage) that would let it keep working.
2. After the quota came back, several chats and orchestrations did not continue by themselves.

This study does four things:

- It maps the limit machinery as the code has it on `main` (`9cff2ae3d`).
- It reads the owner's install read-only to find the real cases.
- It establishes what credits are and what the CLI does with them.
- It proposes the end state and the tasks that lead there.

Its order follows the owner's way of working for studies: stop the bleeding, measure, design the end state with today's behaviour as its degenerate case, prefer what the vendor ships, and name the spikes.

**Confidence.** Every claim is marked:

- **verified**: read in the code at the cited line, or in the owner's data.
- **inferred**: deduced from the order of events, not reproduced.
- **not determined**: the evidence is missing.

## Summary

- **Most stranded work is a person's chat that never waits by itself.** When no account has room, the rotation records a `wait` in `rotation_events` and does nothing else (`packages/core/src/rotation.ts:212`). The design calls this "a person's chat is left alone: it gets a banner" (`rotation.ts:24`). The owner's install has 11 such chats.
  - Not one resumed by itself.
  - Three resumed when the person came back and clicked **Wait for the reset**, which resumed them at once: 56 min, 1 h 40 min and 13.5 h after the reset.
  - One never resumed.
  - The rest were deleted before anyone can tell.
- **Automated work** (graph tasks, flow runs, workflow leads) waits and resumes. In the data it did so every time: four task waits resumed 5 s after their reset on 2026-10-29, and 40 limits in orchestrations moved to another account at once. The code still has six ways to strand it. None was observed in this install, and each is listed under [Causes](#causes) with its line.
- **Credits are read, shown on the account card, and used by nothing that decides.** Anthropic documents that with usage credits on, "requests switch to pay-as-you-go pricing on usage credits and keep working".
  - Claudio shows nothing when that happens.
  - It keeps no record that the turn is being paid for.
  - It counts the account as exhausted, so new work avoids it.
  - Meanwhile, a chat already running on it keeps spending.
- **The design is the problem, not one transition.** Five mechanisms each believe another one will wake the work:
  - the rotation's per-wait timers, which are memory only;
  - the banner's button;
  - the orchestrator's `limitHeld` pause;
  - the flow's hold;
  - the review gate's `nextResult` loop.

  The end state has one owner, the wait row. That row has one time to look again, kept in the database, and a sweeper that a restart cannot lose.

## Evidence from the owner's install

Read on 2026-11-13 from `~/.config/Claudio/data/wrapper.db` (`node:sqlite`, `readOnly: true`), `accounts.json`, `accounts/limits.json` and `~/.config/Claudio/logs/server.log*`. Only ids, times, states, causes and counts were read. Times are UTC; Madrid is UTC+1.

### What the data covers

- `executions`: 468 rows from 2026-10-30. Older ones are trimmed with their chats (chat retention).
- `chats`: 200 rows.
- `orchestrations`: 35, from 2026-10-16.
- `provider_moves`: 35.
- `rotation_events`: 142, from 2026-10-16.
- `usage_history`: 10 538.
- `flow_runs`: 0.
- `schedule_runs`: 10, one daily schedule.
- `spend_alerts`: 0.
- Server logs: from 2026-11-10 21:08 only.

Accounts in this document:

| Alias | Account | Plan |
|---|---|---|
| A1 | `acc-a6b9…` | Team |
| A2 | `default` | Max |
| A3 | `acc-0d90…` | Pro |

Rotation settings: on at the limit, threshold 95, hysteresis 5, cooldown 60 s, strategy `order` (A3, A1, A2).

### Executions that ended at a limit

46 executions have `cause: rate-limit`. Each error is the CLI's text, for example "You've hit your 5-hour limit · resets 6pm (Europe/Madrid)".

| What followed | Count | Path |
|---|---|---|
| Next execution of the same chat began on another account within 1 s | 40 | `moveToAccount` (works) |
| Housekeeping chat moved, and the replay failed in 2–4 s with `error_during_execution` | 4 | case C7 |
| Person's chat, no account left, no wait opened | 2 | cases C1, C2 |

### Waits (`provider_moves`)

| Decided by | Count | Outcome |
|---|---|---|
| `setting` (tasks) | 20 | 7 `resumed` at the reset, 13 `cancelled` |
| `person` | 15 | 4 `resumed`, 10 `cancelled`, 1 `failed` |

The 13 cancelled task waits are the 2026-10-16 R10 incident: a person stopped the graphs before the 13:10 reset, while the CLI's own login had already restarted a window. It is fixed and documented in [accounts.md](../accounts.md#choosing-and-switching). There have been no `provider_moves` rows since 2026-11-06.

### Cases where the automatic resume failed

| Case | Chat (kind) | What happened | State at the reset | Transition that did not fire |
|---|---|---|---|---|
| C1 | `7888dc7c` (person's) | 2026-11-05 15:17: A2 out for the week, A1 out until 17:00, A3 out for the week. `rotation_events` `wait`, `waitUntil` 17:00; no `provider_moves` row. The process ended at 15:30. A1 reset at 17:00 and nothing happened. The person clicked Wait on 11-06 at 06:32:51; the row was `resumed` 2 s later on A1. **13.5 h stranded.** At 06:43 A1 was out again (`waitUntil` null), no wait opened, and the person switched account by hand at 07:49 (66 min). | No wait row; `atLimit` in memory only | person's chat at limit, no account → wait (`rotation.ts:212`) |
| C2 | `a34ac390` (person's, pinned to A1) | 2026-11-12 15:25:50: A1 at 100 % of five hours. `wait` event, `waitUntil` 16:20, although the CLI's text said 18:00 Madrid (17:00 UTC). No row. The process ended at 15:56. The desktop server exited at 16:00:23 and restarted at 16:40:29 (logs). A1 reset at 17:00 and was used by another chat from 19:08. **This chat never continued** (no execution after it as of 11-13 18:00). | No wait row; `atLimit` lost in the restart | as C1, plus restore of `atLimit` (`live-chat.ts:704-760`) |
| C3 | `3127e5ac` (person's) | 2026-10-20: `wait` events at 14:37 (until 15:10) and 18:02 (until 20:20); no row either time. The person clicked Wait at 19:07 and stopped it 2 s later. They clicked Wait again at 22:00:27 and it resumed in 1 s, **1 h 40 min after the reset.** | No wait row | as C1 |
| C4 | `cf89e687` (person's) | 2026-10-25: `wait` event at 16:59 (until 17:49), no row. The person clicked Wait at 18:45 and it resumed after 65 s, **56 min late.** A second `wait` event at 20:54 (until 22:49) opened no row either. The chat was later deleted. | No wait row | as C1 |
| C5 | `5315660b` (person's) | 2026-10-25 20:54: `wait` event (until 22:49), no row. Next morning at 06:31–06:32 the person opened three waits; each said `resets_at` 10-31 06:00 (a weekly reset) and each was stopped within 3 s. Deleted since. | No wait row | as C1. The 5-day `resets_at` the person was offered is not determined: it may be a weekly window, or the `resetSince` defect (cause 9) |
| C6 | `322e7d5d`, `a1b8997b`, `227aaba5` (10-20), `f86784b4`, `8794e65b` (10-25), `14a6109b` (10-27) (person's) | A `wait` event and never a row. The chats are deleted. | No wait row | as C1; outcome not determined |
| C7 | `e3207231` (Supervisor, 10-31), `5c1cbcdf` (lessons ledger, 11-01), `8892489f` (Supervisor, 11-02), `6b0e105f` (Supervisor, 11-07) | A3 at its limit. The rotation moved each chat to A1 and replayed the turn with `--resume`. Every replay failed in 2–4 s with `error_during_execution`. | Turn lost | an `internal` chat runs with `--no-session-persistence` (`providers/claude-code/args.ts:83`), so it has no session to resume. `isAutomated` returns false for it (`rotation.ts:180`), and with `rotateOnLimit` on it is replayed like a person's chat (`rotation.ts:196,211`) |
| C8 | `06c990c1` (person's, 2026-10-16) | A person's wait reached the 13:10 reset and ended `failed`: "its turn could not be resumed: Concurrent run limit reached (8)". | Wait ended `failed`, chat stranded | a transient admission refusal ends the wait instead of re-arming it (`rotation.ts:488-498`). The version is older; the code path is unchanged |

### What the data does not show

**Orchestrations.** All 35 orchestrations in this install ended `completed` (32) or `stopped` (3, all by a person). None is left `running` or `waiting`. Every orchestration limit since 2026-10-30 moved to another account within a second.

The owner's report of orchestrations that did not continue **could not be confirmed** from this data dir. Three places it could come from:

- the remote Claudio server the desktop drives (`/api/servers/2b57bfed0850/…` in the logs), whose database was not read;
- executions trimmed before 2026-10-30;
- the code paths under [Causes](#causes) that strand automated work.

**Schedules.** No schedule run hit a limit (10 runs: 9 `started`, 1 `skipped` because Claudio was not running).

## The machinery today

This is how a limit is learnt, what it sets, and who reads it (all **verified**).

| Source | Where | Sets | Read by |
|---|---|---|---|
| `rate_limit_event` `rejected` | `stream.ts:276-297` → `chat-fold.ts:229` → `ChatManager.observeAccount` (`chats.ts:2233`) | `chat.rateLimited` (memory); `limitedAccounts` (memory); `refusedUntil` (memory WeakMap); a reading through `readingFromEvent` (`accounts/src/usage.ts:65`): `rejected` window, or `outUntil` for overage or no window | `fold` → `isOut` (`thresholds.ts:31`) → `choose`, `chooseNext`, `roomFor`, the account view |
| `rate_limit_event` `allowed`/`allowed_warning` | same | windows only. `isUsingOverage` and `overageStatus` are passed in but dropped unless the event is a rejection (`usage.ts:103`) | same |
| result with `api_error_status` 429 | `stream.ts:318` → `chat-fold.ts:353` | `rateLimited`, `limitedAccounts`, execution `cause: rate-limit`; **no reading** (`chats.ts:2241`) | `limitedTail` after a restart; `stillFailed` |
| The CLI's text "resets 6pm (Europe/Madrid)" | **nowhere** (on purpose, `stream.ts:317`) | — | — |
| `get_usage` | `refreshAccountUsage` (`index.ts:3918`), only from `POST /accounts/refresh` and `/accounts/:id/refresh` (a person's Refresh) | windows, plan, scoped limits, `cli.credits` | the card; windows → `isOut` |
| `cachedUsageUtilization` | `watchAccounts` every 5 min (`index.ts:3966`) | windows, only when newer than the kept reading (`usage.ts:288`) | same |
| A workflow subagent's 429 in the journal | `ChatManager.limitReached` (`chats.ts:2809`) | a synthetic rejected reading | same |

### What happens at a limit

| # | State → trigger → next state | File and function | Test |
|---|---|---|---|
| 1 | Turn running → rejected event or 429 → `rateLimited`; `limit-hit` fires once at the end of the turn | `chats.ts` `maybeLimit` 2710-2721 | `accounts-rotation.test.ts` |
| 2 | `limit-hit`, eval sample → nothing | `rotation.ts:192` | `rotation.test.ts` |
| 3 | `limit-hit`, person's chat, `rotateOnLimit` off → banner only | `rotation.ts:196-199` | `accounts-rotation.test.ts` |
| 4 | `limit-hit`, person's chat, `rotateOnLimit` on, another account has room → replay there | `rotation.ts:211`, `moveToAccount` 242 | e2e `accounts.spec.mjs` |
| 5 | **`limit-hit`, person's chat, `rotateOnLimit` on, no account → `wait` event, banner only, no row** | `rotation.ts:212` | **none** |
| 6 | `limit-hit`, schedule's or `/v1` chat → treated as a person's (rows 3–5) | `isAutomated` 178-183 | `rotation.test.ts` (schedule) |
| 7 | **`limit-hit`, `internal` chat, `rotateOnLimit` on → replayed with `--resume` on another account; fails** | `rotation.ts:180,196,211` | **none** (the existing test is for `rotateOnLimit` off) |
| 8 | **`limit-hit`, orchestration chat that is no task (planner, integrator, synthesis, fixer, reviewer) → "this turn is not replayed"** | `rotation.ts:204-208` | **none** |
| 9 | `limit-hit`, automated, no account → `startWait` inserts a `provider_moves` row `waiting` | `rotation.ts:216,288` | `rotation.test.ts` |
| 10 | Person clicks Wait → `POST /chats/:id/wait` (409 unless `atLimit`) → row | `apps/api/src/routes/chats.ts:218`, `rotation.ts:278` | `provider-rotation.test.ts` |
| 11 | `waiting` → per-wait `setTimeout` at `min(reset + 5 s, now + 5 min, cap)`; `AccountStore.onChange` → `goOnIfRoom` → `roomFor` finds an account → `resume` | `arm` 343, `tick` 364, `recheck` 419 | `accounts-rotation.test.ts` R10 |
| 12 | `waiting`, reset + 5 s passed → `resume` on the same account | `tick` 376-377 | `rotation.test.ts` |
| 13 | **`waiting`, no reset known, 6 h passed → `failed` `limit-wait-expired`** | `tick` 384; default `maxWaitHours` 6 (`providers/settings.ts:16`) | `rotation.test.ts` |
| 14 | **`waiting`, reset later than `at + maxWaitHours` (a weekly limit) → once the cap passes, `due < now`: `setTimeout(0)` each tick, a hot loop until the reset** | `arm` 348-351 | **none** |
| 15 | `resume` → claim (`resuming`, 2 min) → `replayLastTurn`, else `send(LIMIT_CONTINUE_TEXT)` → `resumed` | `resume` 460-499 | `rotation.test.ts` |
| 16 | **`resume` throws (run slots full, memory refusal) → `failed`; flags already cleared, so the banner is gone and Wait answers 409** | `resume` 488-498; `chats.ts:2995` | **none** |
| 17 | Restart → `rotation.recover` re-arms `waiting` rows and expired `resuming` claims, only for chats this process restored | `rotation.ts:523-530`; `db.ts:2709` | `rotation.test.ts` "a wait survives a restart" |
| 18 | **Restart → a person's chat at a limit with no row loses `rateLimited` and `lastUserTurn`; no banner, Wait answers 409** | `LiveChat.restore`, `live-chat.ts:704-760` | **none** |
| 19 | **Restart inside a claim's 2 min → the `resuming` row is left out of `openProviderMoves` and `recover` runs once; the task or flow run stays `running` behind it for ever** (inferred) | `db.ts:2711`, `rotation.ts:523` | **none** |
| 20 | **A row whose chat is not restored stays open, and the unique index refuses any later wait for that chat** (inferred) | `rotation.ts:526`, `db.ts:867` | **none** |
| 21 | Graph task: a held `rate-limit` result is no failure and no attempt; the task follows the replay | `orchestrator.ts` `settle` 1720, `waitEnded` 1906 | `orchestrator.test.ts` (fake `limitHeld`) |
| 22 | Graph task wait `cancelled`/`failed` → task `stopped`/`failed` → graph `waiting` | `waitEnded` 1921-1929 | `orchestrator.test.ts` |
| 23 | Graph restart → a task with an open row back to `running` | `recover` 794-808 | `orchestrator.test.ts` (row inserted by hand) |
| 24 | **Review run at a limit: `awaitReviewRun` waits on `nextResult` with no timer while `limitHeld`; row 8 means no replay comes** (inferred) | `review-gate.ts:187-190` | `review-gate.test.ts` (fake host only) |
| 25 | `schedule()` starts ready tasks on a pool with no room; each opens its own wait | `orchestrator.ts:1388-1397` | none |
| 26 | Workflow lead → move and `replayWorkflow`, or wait; a stall cannot fail it while `limitHeld` | `orchestrator.ts:1895`, 4009 | `workflow-limits.test.ts`, `workflow-watchdog.test.ts` |
| 27 | Workflow wait not resumed → graph `failed`/`stopped` with `orch.error` | `workflowWaitEnded` 1937-1958 | `workflow-limits.test.ts` |
| 28 | Flow run at a limit → waits; cancelled, expired or not resumable → `failed` with a cause; a restart keeps it | `flow.ts:1605,1632-1644,2020` | `flow.test.ts`, `flow-rotation.test.ts` |
| 29 | `/v1` at a limit → HTTP 429 `rate_limit_exceeded`, `resetsAt: null`, no `Retry-After`; with `rotateOnLimit` on, the turn may then be replayed for nobody (inferred) | `apps/api/src/routes/openai.ts:593-601` | `openai-errors.test.ts` (mapper only) |
| 30 | Decision engine with every account out → `unavailable: rate-limited`; Supervisor ask fails with no hint | `decisions/providers/cli.ts:43`, `index.ts:2430` | `rotation.test.ts` |

Rows in **bold** have no test.

### What wakes a wait, and what each event does

- **Timers.** Each wait has its own `setTimeout`, which lives only in memory. The longest one is 5 min, so the machine sleeping or the clock jumping costs at most one 5-min look (**verified**). The timers are lost on a restart; `recover()` runs once at start.
- **A new reading.** Readings come from stream events and the person's Refresh. Nothing asks `get_usage` when a reset passes or while every account is out. So a wait with no known reset, or one held on an account that died on a bare 429, can end only through:
  - another chat's reading;
  - a person's Refresh;
  - the 6 h expiry.
- **The CLI's reset text.** It is never parsed, which is right: it is wording. Its time zone is the person's, and the structured `resetsAt` is epoch seconds, so the zone plays no part. In C2, though, the wait's `waitUntil` (16:20) is neither the text's 17:00 nor A1's reset. `chooseNext` gave the earliest reset among the accounts, while a pinned chat can only use its own. The pin rules in `choose` for a wait were not traced, so this is **not determined**.
- **A reset earlier than announced.** It is seen only when a reading arrives (R10).
- **A reset later than announced.** The replay dies again. A move is not counted, and a second wait-replay on the same account falls back to `LIMIT_CONTINUE_TEXT` (`rotation.ts:484`). A workflow lead's `replayWith` returns false there, and its wait ends `failed` (`chats.ts:3035`).
- **The pending turn.** `lastUserTurn`, `turnMessages` and `pending` live in memory. After a restart only the nudge `LIMIT_CONTINUE_TEXT` is left, and the person's last message is not re-sent. The CLI's transcript still has it, so `--resume` keeps the context.

## Causes

Ordered by how much work they strand.

| # | Cause | Line | Seen | Fix | Test that would have caught it | Patch or design |
|---|---|---|---|---|---|---|
| 1 | A person's chat (and a schedule's, and a `/v1` one) with no account left never waits by itself, even with `rotateOnLimit` on | `rotation.ts:212` (and 24-25, 196) | C1–C6, 11 chats | When `rotateOnLimit` is on (or under a new setting, D1), open the wait for every chat that is not internal or an eval sample. A schedule's chat counts as automated | "a person's chat with rotation on waits for the reset when every account is out, and goes on by itself" | Design: the owner's answer of 2026-09-30 ("wait and resume by itself") was applied only to automated work |
| 2 | A restart forgets a person's chat at a limit: `rateLimited`, the turn and the account are memory | `live-chat.ts:704-760` | C2 | Persist the hold. Solved by the end state, where every limit opens a row (cause 1). Until then, restore `atLimit` from the last execution's `cause` | "a chat at its limit is still at its limit after a restart, and its wait can be opened" | Design |
| 3 | A transient refusal at resume (run slots, memory) ends the wait `failed` after the flags were cleared | `rotation.ts:488-498`, `chats.ts:2995` | C8 | Catch `RunSlotRefusal` / `MemoryRefusal` (`isTransientRefusal`) and re-arm with back-off instead of ending. Clear the flags only once the replay was admitted | "a wait whose resume is refused for a full runtime looks again and goes on" | Patch |
| 4 | Orchestration chats that are no task (planner, integrator, synthesis, fixer, reviewer) are never moved nor waited, and the review gate can hang | `rotation.ts:204-208`, `review-gate.ts:187-190`, `orchestrator.ts:1893` | not in this install (inferred) | `Orchestrator.workOf` answers a `ChatWork` for those chats (`<orch>:__integrator__` and so on) so they take the task path. The review gate leaves the hold when `ended` comes without a wait | "an integrator that hits the limit moves or waits and the graph finishes"; "a review run at its limit does not hang the gate" | Design (one more consumer with its own belief) |
| 5 | A wait with no known reset depends on a reading nobody takes, and expires at 6 h | `rotation.ts:384`, `chats.ts:2241` | not observed (10-17 `e9e90c8a` had `waitUntil` null and was cancelled by a person) | Ask `get_usage` (free: no turn, no tokens) for the candidate accounts when a wait is due and has no fresh reading. Keep `maxWaitHours` only as the limit for probes that answer nothing | "a wait with no reset ends when `get_usage` says the account is back" | Design: one source of truth for when to look again |
| 6 | A wait past `maxWaitHours` with a known later reset spins `setTimeout(0)` | `rotation.ts:348-351` | not observed (inferred from the arithmetic) | Cap only unknown resets; for a known one, `due = min(reset + slack, now + poll)` | "a wait for a weekly reset days away arms one timer per poll" | Patch |
| 7 | Housekeeping (`internal`) chats are replayed with `--resume` though they run with `--no-session-persistence` | `rotation.ts:180,196,211`; `args.ts:83` | C7, 4 of 4 | Never replay an internal chat: end it with cause `rate-limit`, and let its owner (Supervisor, decisions, lessons) run it again fresh when an account has room, or skip that pass | "a housekeeping chat at a limit is not resumed on another account" | Patch |
| 8 | A restart within the 2 min of a claim leaves a `resuming` row unarmed for ever, and a row whose chat is gone blocks future waits | `db.ts:2711`, `rotation.ts:523-530`, `db.ts:867` | not observed (inferred) | The sweeper of the end state re-reads due rows on every pass. Until then, close rows whose chat no longer exists | "a wait claimed just before a restart is taken again after the claim expires" | Design |
| 9 | `resetSince` folds the account's current reading at the time of the failure, so a reading taken after the reset can make the failure count until a turn goes through | `chats.ts:102-104`, `store.ts:386` | possibly C5 (not determined) | Keep the out-until of each failure (`limitedAccounts` → `{ at, until }`) and compare with now | "an account the turn died on is a candidate again once its recorded reset passed" | Patch |
| 10 | A `seven_day_overage_included` window is read as a model "Overage_included" | `accounts/src/usage.ts:50-53` | `limits.json` of A2 (**verified**) | Treat `*overage*` keys as overage, not a model | "an overage window is not a scoped model limit" | Patch |
| 11 | `/v1` gives no `Retry-After`, and may replay a turn nobody waits for | `apps/api/src/routes/openai.ts:593-601` | — | `Retry-After` from `limitResetOf`; an API client's chat is never replayed | "a `/v1` limit answers 429 with Retry-After and leaves no wait" | Patch |

**The design reading.** Causes 1, 2, 4, 5 and 8 share one shape: whoever starts a wait or watches it believes someone else will wake the work.

- The banner believes the person will click.
- The orchestrator believes the rotation will replay.
- The review gate believes `nextResult` will come.
- A wait with no reset believes a reading will come.
- `recover` believes every open wait has its chat restored.

Patching each transition fixes the cases seen but keeps the shape. The end state below removes it.

## Credits

### What they are

**Documented.** [Manage usage credits for paid Claude plans](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans):

- Usage credits (formerly "extra usage") let a paid plan keep working past its included limits, "billed at standard API rates".
- The person turns them on in Settings → Usage, with a payment method and an optional monthly spending cap or auto-reload.
- At a 5-hour or weekly limit with credits on, "requests switch to pay-as-you-go pricing on usage credits and keep working". They stop "until you reach your monthly spend limit, or your balance runs out with auto-reload off".
- With credits off, "you'll only have access to your plan's included usage".
- They "apply to both Claude conversations and Claude Code terminal usage".

[Claude Code costs](https://code.claude.com/docs/en/costs):

- `/usage-credits` opens that page.
- At the spend limit, Claude Code prompts in the terminal to raise it.
- There is a documented `autoContinueAtUsageLimit` setting for waiting and continuing at a usage limit.

The Agent SDK reference documents `rate_limit_event` with `status` (`allowed`, `allowed_warning`, `rejected`), `resetsAt`, `utilization`, `errorCode: "credits_required"` and `overageEnabled`.

**What `get_usage` answers** (decision [get-usage-control-request](../decisions/get-usage-control-request.md)), and Claudio keeps as `limits.cli.credits`:

- `enabled` (`is_enabled`: whether credits can cover sends now);
- `usedMinor`, `limitMinor`, `currency`, `exponent`: the month's spend and cap in minor units;
- `limitReached`;
- `disabledReason`;
- `everEnabled`.

On the owner's install on 2026-11-13 (**verified**):

| Account | Credits |
|---|---|
| A2 (Max) | Set up once, now off: `disabledReason: out_of_credits`, cap 40.00 USD |
| A1 (Team) | Never set up |
| A3 (Pro) | Set up once, now off, no reason |

So today none of the owner's accounts would keep working past its plan. The owner's premise holds for an account with credits on, which he can turn on at any time.

**Inferred, from one CLI version (2.1.322), not a documented surface.** The CLI's own schema descriptions, read in the binary:

- `overageStatus` `allowed` / `allowed_warning` "means paid extra usage covers the overflow (nothing will be cut off)".
- `isUsingOverage` "stays true at hard exhaustion (status rejected)".
- `overageDisabledReason` takes values such as `out_of_credits`, `org_level_disabled`, `member_level_disabled` and `overage_not_provisioned`.

Claudio must not depend on these until the SDK reference documents them or a spike confirms them. Claudio's stream parser already reads these fields when present (`stream.ts:288-291`). The legacy `provider_limits` row of 2026-10-30 holds `overage: {status: rejected, using: false, disabledReason: out_of_credits}`.

### What the CLI does at a plan limit

| Credits | What the CLI does | Source |
|---|---|---|
| On, under the cap | Goes on, billing credits, with no question | Documented (support article); the `-p` stream shape (`allowed` + overage fields) is from the binary, **inferred** |
| Off | The request is refused: a rejected `rate_limit_event`, then a result with `api_error_status` 429 and the "You've hit your … limit · resets …" text | **Verified** in 46 executions |
| At their cap (`limitReached`) or out of balance | Refused as when off. Interactively the CLI offers to raise the cap; in `-p` it cannot ask. The documented `errorCode: credits_required` is likely here | Documented in part; the `-p` behaviour is **not determined** (spike S2) |

### What Claudio does with credits today (verified)

- **Choice and rotation.** `choose`, `isOut`, `fold` and the rotation never read `credits`. The only reader is the account card (`AccountCard.tsx`, "Credits · 12.30 of 50.00 € this month").
- **A running chat that crosses into credits.** The CLI keeps going, so there is no `limit-hit`, no rotation and no notice. Its windows read ≥ 100 %, so the account's `state` becomes `exhausted` (`usage.ts:229`). The bars turn bad, the status bar says "limit reached", and new work avoids the account. All the while the running chat spends real money that Claudio neither records nor shows. `isUsingOverage` is dropped from an `allowed` event (`usage.ts:103`).
- **A rejection while using overage.** It becomes `outUntil`, on no window (`usage.ts:104`), so "at limit" carries no reason that says credits ran out.
- **Spend.** The CLI's `costUsd` is summed by the spend cap whoever pays. Nothing tells a plan-covered turn from a credit-paid one.

### What Claudio should do

1. **One more account state.**
   - **Covered by credits** (`overage`): the plan window is spent and the stream says overage covers it (`isUsingOverage` with `overageStatus` allowed), or `get_usage` says credits are `enabled` and not at their limit.
   - It is not `exhausted`. Its tone is warn, its word is "Using credits", and it always shows the month's amount ("Using credits · 3.20 of 40.00 USD this month").
   - `exhausted` stays for a plan spent with no credit that covers it.
2. **A credits setting**, per account, in the rotation settings (D3):
   - `never` (the default): an account in `overage` counts as out for choosing and moving work, as today. The difference is that a chat already running there is stopped at once, and its turn is moved or waits like any limit (D4). This is the safe default: Claudio never lets a turn spend credits the person did not opt into here, even when they turned credits on at claude.ai for their own use.
   - `last-resort`: an account in `overage` is usable only when no account has plan quota, and only while the month's credits are under a cap the person sets in Claudio (D5).
   - `allow`: the account is used as if it had quota until its credits reach their limit.
3. **Rotation.**
   - The choice gains one step after the threshold: with every account out of plan quota, an account under `last-resort` or `allow` with credits left is taken before waiting.
   - A move onto credits is recorded as a rotation event with `reason: 'credits'`, and the chat gets a notice: "Account A2 has no plan quota left; this turn is paid from its credits (3.20 of 40.00 USD this month)."
4. **The wait.** "No room" means no plan quota and no credits the setting allows. The wait's reset is the earliest of the plan resets. A credit cap that is reached (`limitReached`) resets monthly, and is never waited for by itself.
5. **What a person sees.** Money is never a surprise:
   - the state on the card, the status bar and the account chip;
   - a notice in every chat whose turn starts or goes on paying;
   - the paid turns marked in the spend ledger;
   - a warn toast the first time in a day that an account starts using credits.

## End state

- **One owner.** Every turn that dies at a limit opens a hold, a `provider_moves` row, whatever its origin. The exceptions are:
  - an eval sample, which its runner reruns;
  - an internal chat, ended and rerun by its owner;
  - a `/v1` chat, answered 429 with `Retry-After`;
  - a person's chat whose person chose otherwise (D1).

  Consumers keep no wait state of their own: graph tasks, the planner, integrator, synthesis, fixer and review gate, flow runs, workflow leads and schedules. They read the row (`openWaitOf`) and hear its end (`ended`).
- **The turn is in the row.** The row records what to send at resume: the message ids of the turn that died, since the transcript and the chat's records have the text, or the workflow resume prompt. A restart therefore replays the person's turn, not only the nudge.
- **One source of truth for when to look again.**
  - The row carries `next_look_at`, the earliest of:
    - the known reset + 5 s;
    - the next probe of an unknown reset (back-off 5, 15, 30, 60 min);
    - now, whenever a reading changes.
  - At a due row with no reading newer than the wait, Claudio asks `get_usage` for the candidate accounts. It is the vendor's documented protocol, free, and in the account's own environment.
  - `maxWaitHours` applies only after probes that answer nothing.
- **A resume that survives restarts.**
  - One sweeper per process runs every 30 s on wall-clock time, plus on `accounts.changed`.
  - It claims due rows with the guarded update that exists today (`claimProviderMove`) under `BEGIN IMMEDIATE`, so two processes on one data dir replay once.
  - A transient refusal moves `next_look_at` on and never ends the row.
  - A row whose chat is gone is closed `failed` with that reason.
  - There are no per-row timers to lose, and sleep or clock jumps cost at most one pass.
- **What a person sees.**
  - While work waits: one line wherever it is shown (chat banner, task foot, graph line, flow card), in warn, with "Waiting for the limit · goes on at 17:00" or "· looking again at 17:15", plus **Run now** and **Stop waiting**.
  - When it goes on: a notice in the chat saying on which account and, if so, from credits.
  - Home lists the open waits.
- **Today's behaviour is the degenerate case.**
  - A person who keeps today's setting (D1 = banner) gets today's banner.
  - A wait with a known reset resumes at that reset, as today.
  - The sweeper with one due row is today's timer.

## Decisions for the owner

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | A person's chat at its limit with no account left | (a) waits and goes on by itself whenever rotation is on; (b) only with a new switch "Wait for the reset by itself"; (c) banner only (today) | **(a)**: it is what the 2026-09-30 answer meant, and what the owner expected in C1–C6 |
| D2 | Waits for a known reset days away (weekly) | (a) wait for it whatever the distance; (b) stop for a decision beyond N h | **(a)**, with the reset shown; `maxWaitHours` only for unknown resets |
| D3 | Credits per account | `never` / `last-resort` / `allow` | **`never` by default**; the owner sets `last-resort` on accounts he wants to spend on |
| D4 | Under `never`, a running turn that crosses into credits | (a) stop it at once and move or wait; (b) let the turn finish, then move | **(a)**: (b) spends an unbounded amount on a long turn |
| D5 | A Claudio-side cap on credits | (a) a monthly cap per account in Claudio, in addition to claude.ai's; (b) claude.ai's cap only | **(a)**, defaulting to claude.ai's when one is set |
| D6 | Housekeeping chats at a limit | (a) end; the owner reruns later on an account with room; (b) skip the pass | **(a)** for Supervisor and lessons; decisions already answer `rate-limited` |
| D7 | Graph steps that are no task (integrator, synthesis, fixer, reviewer, planner) | (a) wait or move like tasks; (b) fail for a person (today) | **(a)** |

## Spikes

| Spike | Settles | Cost | Who runs it |
|---|---|---|---|
| S1 | Whether the published `@anthropic-ai/claude-agent-sdk` typings (`sdk.d.ts`) document `isUsingOverage`, `overageStatus` and `overageDisabledReason`, and what `errorCode: credits_required` looks like | Free: read the package | A developer, now |
| S2 | What a `-p` stream-json turn emits at a plan limit with credits **on** (events, result, cost), and at the credits cap | Paid: credits up to a cap the owner sets (for example 2 USD on a Pro account near its five-hour limit), plus the plan quota it spends to get there | **The owner must authorise it; not run** |
| S3 | Whether `autoContinueAtUsageLimit` applies to `-p` stream-json, and how it shows in the stream. It would be a vendor-shipped wait inside the CLI that the end state should prefer or turn off | Needs a real limit: plan quota spent | **The owner must authorise it; not run** |
| S4 | `get_usage` on an account at its limit: does it answer the reset and `is_enabled` reliably, and how long does it take? | Free: no turn, no tokens | A developer, on an account already at its limit |
| S5 | The remote server's history: whether the orchestrations the owner remembers are there | Free, read-only | The owner, or an agent he points at that data dir |

## Risks

- **Probing `get_usage` at every due wait** starts a CLI process each time. Probe only rows with no fresh reading, at most once per account per pass.
- **Opening waits for people's chats** keeps chats live that a person meant to leave. **Stop waiting** must be one click on the banner and the chat list, and a new message from the person ends the wait (today it does not).
- **Many waits resuming at the same reset** fill the run slots. The sweeper resumes in order, as slots allow (cause 3).
- **Credits fields the CLI does not document** may change. Keep them optional, and treat their absence as "no credits".
- **Stopping a turn that crossed into credits** cuts it mid-step. The turn replays from the transcript on another account, as a limit already does.

## Tasks

Each task owns its files; a task that needs another's file depends on it. Models: **Opus** for the design-bearing ones, **Sonnet** for patches with a clear test.

| Id | What it does | Depends on | Files it owns | Model |
|---|---|---|---|---|
| `t1` | **Stop the bleeding.** In the rotation:<br>- open the wait for a person's and a schedule's chat when rotation is on and no account has room (cause 1, D1 a);<br>- re-arm on a transient refusal at resume (cause 3);<br>- arm a known reset beyond `maxWaitHours` with a normal timer (cause 6);<br>- never replay an `internal` chat (cause 7);<br>- close a row whose chat is gone (cause 8, the second part);<br>- end a person's wait when they send a message.<br>Tests named in the causes table | D1, D6 | `packages/core/src/rotation.ts`, `packages/core/test/rotation.test.ts`, `packages/core/test/rotation-person-wait.test.ts` (new) | Sonnet |
| `t2` | A chat at its limit survives a restart: restore `atLimit` and the account it died on from the last execution's cause; fix `resetSince` to compare with the recorded reset (cause 9) | — | `packages/core/src/live-chat.ts`, `packages/core/src/chats.ts`, `packages/core/src/chat-fold.ts`, `packages/core/test/accounts-rotation.test.ts` | Sonnet |
| `t3` | Graph steps that are no task take the task path: `workOf` for planner, integrator, synthesis, fixer and reviewer; the review gate leaves the hold when the chat ends with no wait (cause 4, D7) | `t1` | `packages/core/src/orchestrator.ts`, `packages/core/src/review-gate.ts`, `packages/core/test/orchestration-limit-steps.test.ts` (new) | Opus |
| `t4` | `/v1` at a limit: `Retry-After`, and no replay for an API client's chat (cause 11) | `t1` | `apps/api/src/routes/openai.ts`, `packages/core/src/openai/events.ts`, `apps/api/test/openai-limit.test.ts` (new) | Sonnet |
| `t5` | Spikes S1 and S4, written up as a decision under `docs/decisions/` | — | `docs/decisions/credits-in-the-stream.md` (new) | Sonnet |
| `t6` | The `overage` state and the credits facts in the reading: keep `isUsingOverage`/`overageStatus`, the new state, the overage window parse (cause 10); `choose` honours the credits setting | `t5`, D3 | `packages/shared/src/types.ts` (+ OpenAPI schemas), `packages/accounts/src/usage.ts`, `thresholds.ts`, `choose.ts`, `store.ts`, `packages/accounts/test/*` | Opus |
| `t7` | The credits setting, the notice and rotation reason `credits`, stopping a turn that crosses into credits under `never` (D4), the paid-turn mark in the spend ledger, and the Accounts card, rotation card and status bar states. The UI work goes through `claudio-ui` and `/ui-review` | `t6`, D4, D5 | `packages/core/src/chats.ts` (stop on overage), `packages/core/src/spend*.ts`, `apps/web/src/pages/accounts/*`, `apps/web/src/components/StatusBar*`, i18n `accountsConfig`, `e2e/specs/accounts.spec.mjs` | Opus |
| `t8` | **The end state.** The hold sweeper:<br>- a migration adding `next_look_at`, `turn` and `probe_count` to `provider_moves`;<br>- the sweeper replacing the per-row timers;<br>- `get_usage` probes for due rows with no fresh reading;<br>- `recover` folded into the sweeper (cause 5, cause 8 fully);<br>- the turn replayed from the row after a restart | `t1`, `t2`, `t3` | `packages/core/src/db.ts`, `packages/core/src/rotation.ts`, `packages/core/src/index.ts` (wiring), `packages/core/test/limit-holds.test.ts` (new) | Opus |
| `t9` | One wait line everywhere and Home's list of open waits; `docs/accounts.md`, `docs/orchestrations.md`, `docs/team-and-flow.md` (its stale `awaitsRotation` line), and this plan's Outcome | `t7`, `t8` | `apps/web/src/pages/chat/LimitBanner.tsx`, `apps/web/src/components/WaitLine.tsx`, Home widget, the docs named | Sonnet |

`t1` is the smallest change that stops work from being stranded. With D1 (a) it covers every observed case except C2's restart (`t2`). `t1` and `t2` are independent and can run in parallel.

## What was verified, inferred and not determined

- **Verified:**
  - every case C1–C8 in the data;
  - the lines of causes 1, 3, 6, 7 and 10 and the restore gap of cause 2, read in the code;
  - that nothing that decides reads `credits`;
  - the owner's credit facts;
  - the documented behaviour of usage credits.
- **Inferred:**
  - causes 4 (review gate hang), 8 and 9, and the `/v1` replay of cause 11 (from the order of events, not run);
  - the `-p` stream shape of a turn paid from credits (one CLI version's binary).
- **Not determined:**
  - the orchestrations the owner remembers as not resuming (not in this data dir; S5);
  - what happened to the deleted chats of C4–C6;
  - why C2's wait named 16:20;
  - what `-p` does at the credits cap, and whether `autoContinueAtUsageLimit` reaches `-p` (S2, S3).

## Outcome

### t1, stop the bleeding (branch `fix/chat-waits-at-limit`)

Built in `packages/core/src/rotation.ts`; tests in `packages/core/test/rotation.test.ts` and `rotation-person-wait.test.ts`.

- **Cause 1, D1.** With `rotateOnLimit` on and no account with room, a person's chat and a schedule's chat open a wait (`decidedBy: 'setting'`) like automated work, and the rotation resumes it. With `rotateOnLimit` off the banner stays, as today.
- **Cause 3.** A resume refused for run slots, memory or a queue yield (`isTransientRefusal`) keeps the wait. The claim it took is the back-off (`claimMs`, 2 min): the wait looks again when the claim lapses. It ends `failed` only after the refusals last `maxWaitHours`. A person's Run now gets the refusal back as the error, and the wait stays.
- **Cause 6, D2.** `maxWaitHours` bounds a wait with no known reset, and a refused resume. A known reset gets a normal timer, at most one poll away.
- **Cause 7, D6.** An `internal` chat is announced (`run.rateLimited`) and never moved, replayed or waited, whether or not it has work.
- **Cause 8, second part.** `recover()` and `resume()` close a row whose chat is not stored by any process as `failed` ("its chat is gone"), through `storedChats`. A chat another process has stored but this one has not restored is left to that process.
- **A person took over.** A person's wait ends `cancelled` when the chat has run a turn or started working since the wait began (checked at every look, and before every replay). The next limit of that chat opens a fresh wait.
- **Shutdown.** `close()` returns a promise that settles when what the timers started has; `Core.shutdown` awaits it with the other closers (one line in `index.ts`).

What differs from the plan:

- A `/v1` client's chat (`origin: 'api'`) opens no wait; it is still moved when an account has room. t4 settles it.
- "A person took over" is found by looking (the chat's executions and turns, the poll and every account change), not by an event on `send`: `chats.ts` is not this task's. A wait can outlive a person's message by up to one poll, and never causes a replay over it.
- After a refused resume the runtime has cleared the chat's limit flags (`replayLastTurn` does it before it sends), so the banner is gone while the wait row stays; the retry sends the nudge, because that replay already counted. Moving the clearing after admission is `t2`'s file.

Still open: a `resuming` row whose claim is live at a restart (`t8`), a wait with no known reset and no reading (cause 5, `t8`). The restart (`t2`), the refused resume's flags and the person's take-over by event were t1's open items; `t2`, below, closes them.

### t2, a limit survives a restart (branch `fix/limit-survives-restart`)

Built in `packages/core/src/chats.ts`, `live-chat.ts` and `rotation.ts` (the take-over call); tests in `packages/core/test/limit-restart.test.ts` and `accounts-rotation.test.ts`.

- **Cause 2.** An execution that dies on a limit records the reset the chat knew (`Execution.limitResetsAt`, an optional field on the execution's JSON row: no migration). `LiveChat.restore` puts a chat back at its limit when its last execution died on one (`rate-limit`, or `auth`) on the account the record still names, so the banner shows and `POST /chats/:id/wait` opens a wait that knows the recorded reset. `ChatManager.restore` no longer retires such a chat to its summary (`retirable` already kept it awake in a live process). The turn that died is not stored, so a wait after a restart replays with the nudge, as one open at a restart already did.
- **Cause 9.** `limitedAccounts` keeps `{ at, until }`, and `resetSince` counts a failure as over once its recorded `until` has passed (only a reset after the failure is evidence), besides the earlier reading comparison (R10). The refusal's reset (`refusedUntil`) is now kept with the account that gave it, so a chat moved to another account no longer waits on the first account's reset.
- **A refused resume.** `replayLastTurn` and `replayWith` put the limit flags, the replay count, the forced account and the unread messages back when `sendMessage` throws (run slots, memory, queue yield), so the chat stays at its limit and the retry replays the turn it was, not the nudge.
- **A person took over.** `ChatManager.sendMessage` emits `person-message` for a person's message (not a housekeeping turn, not the limit's own replay); the rotation ends that chat's wait `cancelled` at once. Automated work's waits ignore it, and so does a wait whose claim is being replayed (the person's message queues behind the replay).

What differs from the plan:

- It touches `packages/shared/src/types.ts` (the `Execution.limitResetsAt` field, with the regenerated `schemas.json`): the persistence rule puts what a chat needs to restore itself on its executions, and the recorded reset had nowhere else to live.
- A restart does not open a wait for a chat that is at its limit and has none: the wait opens when `limit-hit` fires (now the rotation does it with `rotateOnLimit` on) or a person clicks Wait. Opening them for every restored chat would resume turns that ended days ago.
- The poll in t1 stays as the second way to find a take-over (a message that reached the chat by another path).

Still open: the turn that died is not replayed after a restart, only the nudge (the row holds it in t8); `limitResetsAt` is absent on executions recorded before this, which keep the reading comparison.

## The owner's decisions (2026-11-13)

Taken the day the study was written, each the recommended option unless said otherwise.

- **What "credits" means.** The owner means the usage credits of a Claude account (promotional ones spent before purchased ones), as this study does. He confirmed that none of his three accounts shows available credits today, which agrees with what the CLI reports, so the readings are taken as reliable for whether an account has credits to spend. The CLI still gives no balance.
- **D1.** A person's chat waits and resumes by itself.
- **D2.** A wait for a known reset holds however far away the reset is.
- **D3.** Credits: never by default. An account's credits are spent only where the person switched that on for the account.
- **D4.** Under "never", a turn that crosses into credits is stopped at once, and the chat waits or moves to another account.
- **D5.** A credits cap inside Claudio.
- **D6.** Housekeeping chats end at a limit; they are not replayed.
- **D7.** Graph steps that are not tasks wait like tasks.
- **Spikes.** S3 (whether the CLI's own continuation at a usage limit applies to the mode Claudio runs it in) is authorised. S2 (a paid turn on credits) is not, for now.
- **Order.** The first task of this plan and the first task of [account-configuration-and-project-rules.md](account-configuration-and-project-rules.md) are built at the same time, after the decision engine's pull request; the rest follows in each plan's order.
- **Also in this batch of work:** each subagent's card in a chat shows the model it runs on and its reasoning effort (the owner's request of the same day; a small change of the web through the design system).
- The plan stays on its branch until it is built; it travels with the pull request that implements it.

## Related

[[accounts.md]] · [[orchestrations.md]] · [[pinned-chat-rotation.md]] · [[cli-surfaces.md]] · [[decisions/get-usage-control-request.md]] · [[plans/limit-resume.md]] · [[plans/workflow-engine-limits.md]] · [[plans/rotation-auth-fixes.md]] · [[plans/regression-fixes-2026-10-29.md]] · [[plans/ci-and-regression-open.md]] · [[team-and-flow.md]]
