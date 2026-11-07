---
created_at: 2026-11-07T00:00:00Z
updated_at: 2026-11-07T21:00:00Z
tags:
    - plan
    - ci
    - e2e
    - regression
    - security
    - delivery
    - accounts
    - review-gate
---
# CI back to green, and the regression's open checklist closed

Status: **built, not pushed** (orchestration `bee431cc`, 2026-11-07); see the [Outcome](#outcome). One
branch (`fix/ci-and-regression-open`, from `main` at `db94f2d97`, 0.14.0), one pull request.

This plan closes two things: the `main` CI that has been red since #84 (2026-11-04), and every item
of [regression-fixes-2026-10-29.md#open](regression-fixes-2026-10-29.md#open) that is still open. Each
item was checked on `db94f2d97` on 2026-11-07, with file and line. The facts are in §1, and §2
settles the owner's decisions.

## 1. Findings (verified on `db94f2d97`, 2026-11-07)

### 1.1 CI

- **`main` is red.** The daily `CI` runs of 2026-11-04, 05 and 06 on `db94f2d97` fail in
  `e2e (1/4)` on `terminal.spec.mjs`, step 5: `timed out waiting for: two tabs`, after the panel's
  "+". On 11-05, `e2e (4/4)` also failed, on `usage.spec.mjs`. The last green run was
  `e223c6bf` (2026-11-03 12:40). #84 was merged with `e2e (1/4)` and `test` failing.
- **It was already intermittent before #84.** A `workflow_dispatch` run on `e223c6bf` the same day
  (41679787439) failed at step 4 instead ("the earlier output after a reload"), while the scheduled
  run on that commit passed. Since #84 it fails on every run, at step 5.
- **What the failure report shows (run 42220246122):**
  - When it gives up, the server holds both shells: the first with `clients: 0` and the second with
    `clients: 1`.
  - The page sent one `POST /terminals`.
  - The page logged about 20 aborted `GET /api/terminals` / `GET /api/terminal` pairs
    (`net::ERR_ABORTED`) in the 20 s it waited.
- **Hypothesis to confirm, not to assume:** the tab list is never refreshed after the "+".
  - Aborts come in pairs, which is what `applyTerminalEvent` does
    (`apps/web/src/components/terminal/use-terminals.ts:25-37`): it invalidates the status and every
    list on each `terminal.changed`, and a refetch cancels the one in flight. An unmount cancels too.
  - The server emits `terminal.changed` on every attach and every detach
    (`packages/core/src/terminals/service.ts:452, 538`).
  - `TerminalView` reconnects only when its `id` changes (`TerminalView.tsx:412`). So a loop, if
    there is one, comes from something that mounts and unmounts the dock or the workspace, or keeps
    invalidating.
  - #84 changed `TerminalDock.tsx` (`onEmptied`, `before`), `TerminalWorkspace.tsx`
    (`announceEmptied`, `shown`), `TerminalView.tsx` (a fragment with `PasteSheet`, `onContextMenu`)
    and `TerminalPanel.tsx`.
- **Other red runs.**
  - Dependabot #86 and #87 are red: #87 on `terminal` and `mobile.spec.mjs`, #86 on `e2e (1/4)`.
  - The e2e suite cannot be reproduced from an agent on this machine: the terminal refuses anything
    that descends from a chat (`403 terminal.from-agent`), the Sluice daemon included (CLD-4). It
    runs in the pull request's CI.

### 1.2 The regression's open checklist

| # | Item | State on `db94f2d97` | Where |
|---|---|---|---|
| R1 | `still_queued` | **Confirmed public.** `@anthropic-ai/claude-agent-sdk` 0.3.319 (2026-11-06) types `interrupt(): Promise<SDKControlInterruptResponse \| undefined>` with `still_queued`, advertised by the `interrupt_receipt_v1` capability of `system/init`. Claudio reads it by shape only and never reads `capabilities` | `providers/claude-code/control.ts:42`, `stream.ts:223-243`, `chats.ts:1481` |
| R2 | Core imports `apps/web/.../es/team.json` | Open. Used only by `roleTitleIn` → `flowTitle` (`flow.ts:597`), the first line of a flow run's chat | `packages/core/src/team.ts:26,153` |
| R3 | Compact and notes from a chat's token | Open: both are `work` (`routes.ts:553,556`). **A loophole:** `POST /chats/:id/messages` with `/compact` reaches `context.sendTyped` (`index.ts:985`, `chat-service.ts:187`), so changing the two routes alone is not enough | `apps/api/src/openapi/routes.ts`, `chat-service.ts` |
| R4 | Supervisor cap shown while the Supervisor is off | Open: the field is outside any condition | `apps/web/src/pages/config/decisions/Engine.tsx:196-215` |
| R5 | Migrations on an older database | **Closed by evidence.** The owner's own `~/.config/Claudio/data/wrapper.db` (137 MB, data from before the branch) runs 0.14.0 at `user_version` 71 with `audit_refusals`, `transcript_folds` and `usage_history` | — |
| R6 | MCP writes under `bypassPermissions` | See §2.1 | `packages/mcp/src/names.ts` |
| R7 | The audit page lacks `audit_refusals` | Open: the route and its tests exist; the web never asks | `apps/web/src/api.ts:963`, `pages/config/security/AuditCard.tsx` |
| R8 | D3 for workers | Open: `keepAlive === false` ends the input at every result, background work or not. Recorded as a trade-off at the time (`regression-fixes-2026-10-29.md:541-543`) | `chat-fold.ts:393-397`, `orchestrator.ts:1518,2171,2240,~3167` |
| R9 | A resumed or forked chat on a rejected model looks healthy | Open: only `POST /chats` calls `checkModel`. The stream flags only 429 and 401. The CLI's shape for a rejected model has no fixture yet | `apps/api/src/routes/chats.ts:146,174,180`, `stream.ts:290`, `chat-fold.ts:203,~364` |
| R10 | `/ui-review` of the delivery cards, the board's "⋯" on coarse pointers and the render-error page | Never run | web |
| R11 | `rateLimited` after a switch; `limitedAccounts` after a wait-replay | Open. The web works around it at `LimitBanner.tsx:46` | `chats.ts:2745,2845-2860,2885`, `chat-fold.ts:353` |
| R12 | `AccountStore.list()` per account, twice per `accountView` | Open. `provider_limits` stays (§2.4) | `packages/accounts/src/store.ts:297-333,750`, `packages/core/src/index.ts:3768` |
| R13 | Tunnel port with no settings row | Open; `TunnelManager.resetSettings(['port'])` is ready | `settings-registry.ts:248`, `shared/src/setting-ids.ts:84`, `RemoteAccessTab.tsx` |
| R14 | Two collaborators clients in the web | Open | `apps/web/src/lib/api/collaborators.ts`, `pages/project/shared-data.ts` |
| R15 | Polling and events | Open: `LIVE_REFRESH_MS = 8_000` (`changes/source.ts:37`). There are no `decision.*`/`audit.*` events. `workitem.moved` invalidates every item page although it carries `itemId` (`lib/events.ts:452`). **Events half done (`core-hygiene`):** `workitem.moved` now reads its own page and, from the cache, only the pages that show it as a chip (its epic, its children, both ends of a relation; `itemsNaming` in `lib/events.ts`). **`decision.*`/`audit.*` not built, because they replace no poll:** while the stream is open the audit queries and `JevUnavailable` poll nothing (`useFallbackInterval` is `false`), and the decision history has no interval at all. The audit log is read again after any event at a 10 s pace (`ALWAYS`), and the decision lists on permission events. An event of their own would change freshness, not load. The gap that stays: a decision taken at a point that is not a permission (`orchestration.retry`, `flow.*`), or an audit row with no event (a refused request), shows on the next mount, focus or other event. **Polling half done (`web-hygiene`):** a task's and the integration branch's review (`ChangesReview.tsx`, `FileReview.tsx`) follow `changes.updated`, which the change watcher sends for exactly the window they are live, and poll only while the feed is down (`liveRefresh` in `changes/source.ts`). A chat's and a work item's keep the 8 s timer: no `changes.updated` names them, and a file written by a shell command announces nothing | web, shared, core |
| R16 | Older web defects | Open: a 17 px link on Home, a clipped Tailscale row, and more than two gradient surfaces when signed out; 72 tap-target hits on the board's phone rows; column headings cut at 1280 px | web |
| R17 | Load-sensitive tests | Open. Wall-clock bounds in `collab-join-answer.test.ts:417,429-432,470`, `collab-quiet.test.ts:140-145`, `setup-logins.test.ts:170` and `tunnel.test.ts`; fixed waits in `apps/api/test/flow.test.ts:28-34` and `openai-tools.test.ts:381,397`; real spawns in `accounts-rotation` | tests |
| R18 | Unawaited `core.shutdown()` | Open: 94 calls in 65 API test files. `security.test.ts:719` reopens the same root, `security.test.ts:330-347` never shuts down, and `packaging.test.ts:257-291` keeps four Cores on one data dir. `teardown.test.ts:17` counts the calls but does not require `await` | `apps/api/test` |
| R19 | Fixture headers say "no task may update" | Open: every recent feature PR updates them | `apps/web/test/strings-snapshot.test.ts:1`, `class-inventory.test.ts:1` |
| R20 | `chat.api-write` cause text | Open: `CAUSE_KEY` lacks it, so it falls back to `cause.other` | `apps/web/src/pages/tasks/item/model.ts:189-205`, `workItem.json:151` |
| R21 | Review gate `secret` rule matches names | Open: it reuses the redaction masker's `SECRET_ASSIGNMENT` (`decisions/redact.ts:66`), on tests and fixtures too | `packages/core/src/review-scan.ts:111` |
| R22 | Review runs with no structured output; the fixer runs anyway | Open. No chunk is checked against `runCap` (`review-gate.ts:293,364,432`). A round where every run was invalid still calls `reviewFix` when the scan blocked (`orchestrator.ts:3061-3074`, `review-findings.ts:176`) | core |
| R23 | Desktop updater and `pkexec` | **Closed in the code.** No `pkexec` in `apps/desktop/src`, and a test forbids it (`updater.test.ts:142`). An install from the apt source updates through apt; a `.deb` without it offers one checked command | — |

## 2. Decisions

### 2.1 R6, MCP writes under bypass: **documented and closed (owner, 2026-11-07)**

The facts:

- Every Claudio MCP write tool calls only `work` routes (`names.ts`, C1).
- A chat's token can already call those routes with `curl`, and the project's `CLAUDE.md` asks
  agents to.
- Under `bypassPermissions` the CLI asks nothing, so the tool runs unasked. That is the same thing
  the agent could do with its token.
- The server-side approval of [assistant-everything](https://github.com/yeyo11/claudio/blob/feat/assistant-everything/docs/plans/assistant-everything.md)
  (D2/D4, never built) would not change this for ordinary chats: its D4 keeps `work` free and
  requires an approval only for a new `confirm` class (the grave writes) and for the assistant.
- Under auth mode `none` none of it is enforced (its D6).

**Decided:** this PR records it as intended in a decision document
(`docs/decisions/mcp-writes-under-bypass.md`): bypass delegates to the agent what its token may
already do. The approval ledger is built later as its own piece, with its design first. Rejected:
"an approval for every MCP write in every chat", which leaves `curl` open, and building
assistant-everything inside this PR.

### 2.2 Settled by the owner on 2026-11-07

- **R1:** keep `still_queued`, now read only when `system/init` advertises
  `interrupt_receipt_v1`; written down as a vendor-documented interface.
- **R3:** `POST /chats/:id/compact` and `/notes` become `person`, and a typed `/compact` from a
  chat's token is refused the same way.
- **Execution:** an orchestration, with `claude-opus-5-5` for code and `claude-sonnet-5-5` for
  prose. Never fable.

### 2.3 Defaults taken in this plan (the owner may override)

- **R2:** the Spanish role titles move to `@claudio/shared` (`packages/shared/src/team.ts`), read
  by core and web. Core keeps writing the titled first line, because that line is the chat's listed
  title.
- **R4:** the cap shows only while the `supervisor.intervene` point is not `off`. Under Jev it stays,
  because the Supervisor's own chat is a CLI chat whose cost the cap bounds.
- **R12:** `provider_limits` stays (an older Claudio on the same data directory reads it). Only the
  cost is fixed.
- **R8:** a worker keeps its input open while background work runs, then ends it on the
  `chat-background-settled` event, as person chats do. The orchestrator accepts the later exit. If
  the task finds this breaks how the orchestrator continues a worker, it stops and reports rather
  than bending it.

### 2.4 Not in this PR

- The assistant-everything approval ledger (§2.1).
- Dropping `provider_limits`.
- A real iOS and Android keyboard on the paste sheet: the owner's check with a phone (CLD-4).

## 3. Tasks

Models: `claude-opus-5-5` for every code task and the review, `claude-sonnet-5-5` for `docs`. Effort
per task as given. Concurrency 4.

**Rules for every task:**

- Read this plan, `CONTRIBUTING.md` and `CLAUDE.md` first.
- Fix causes, not symptoms. No longer timeouts to make a test pass, unless the cause is written
  down and the wait is on an event.
- Every fix carries the test that would have caught it.
- Gates run only through Sluice's `verify` tool, never as raw commands. The browser suite runs only
  through the `e2e` gate with spec prefixes.
- UI work loads the `claudio-ui` skill and follows the design system.
- Every string goes through i18n with `en`/`es` parity.

| Id | Effort | Task | Owns | dependsOn | Checks |
|---|---|---|---|---|---|
| `ci-terminal` | xhigh | §1.1: find why the tab list never shows the second shell (step 5) and why the reload loses the screen (step 4). Prove it with the server log of a CI run before changing code: count `terminal.changed`, mounts and invalidations. Fix the cause in the web or the service, and write the cause in `docs/terminal.md`. Then see whether `usage.spec.mjs` and `mobile.spec.mjs` fail for a cause of their own, and fix them | `apps/web/src/components/terminal/*`, `packages/core/src/terminals/*`, `e2e/specs/terminal*.spec.mjs`, `usage`/`mobile` specs, `docs/terminal.md` | — | web and core tests, `e2e` gate on `terminal`; `pnpm e2e:remote terminal usage mobile` green three times in a row on the pushed branch |
| `delivery` | xhigh | R1 (parse `capabilities` in `system/init`, gate `stillQueuedOf` on `interrupt_receipt_v1`), R8 (D3 for workers, §2.3) and R9 (`checkModel` on resume and fork; capture the CLI's real answer to a rejected model as a fixture, then detect it in `stream.ts` and fail the execution) | `packages/core/src/providers/claude-code/*`, `chat-fold.ts`, `orchestrator.ts` (worker input only), `chat-service.ts` (resume/fork), `apps/api/src/routes/chats.ts` (resume/fork), tests | — | core and api tests, typecheck |
| `accounts` | high | R11 (clear `rateLimited` in `moveTo`; clear `limitedAccounts` on a wait-replay; drop `LimitBanner.tsx:46`) and R12 (`pick` takes the list; `cliLogin` cached by mtime) | `chats.ts` (account methods only), `packages/accounts/*`, `apps/web/src/pages/chat/LimitBanner.tsx`, tests | `delivery` (both touch `chats.ts` and `chat-fold.ts`) | core, accounts and web tests |
| `security` | high | R3 (two routes to `person`, the typed `/compact` refusal, `docs/rest-api.md`, schemas, flip the two `security.test.ts` cases) and R7 (refusals in `AuditCard`: client, key, list, empty state, phone rows) | `apps/api/src/openapi/routes.ts`, `apps/api/src/security.ts`, `chat-service.ts` (typed commands), `apps/web/src/api.ts` (audit), `pages/config/security/*`, tests | — | api and web tests, `openapi:schemas` with no drift, `e2e` gate on `security` |
| `review-gate` | high | R21 (a credential-shaped detector of its own; tests and fixtures advisory) and R22 (check each chunk against `runCap`, then split it or mark it `not-reviewable`; a round whose runs are all invalid ends without the fixer) | `packages/core/src/review-*.ts`, `orchestrator.ts` (review branch only, ~3040-3080), tests | `delivery` (`orchestrator.ts`) | core tests |
| `core-hygiene` | medium | R2 (titles to shared), R13 (tunnel port row, setting id, the web control), R15's event half (`workitem.moved` by `itemId`; `decision.*` and `audit.*` events only if they replace a poll, otherwise written down as not worth it) | `packages/shared/src/team.ts` (new), `packages/core/src/team.ts`, `settings-registry.ts`, `setting-ids.ts`, `RemoteAccessTab.tsx`, `apps/web/src/lib/events.ts`, tests | — | all tests, typecheck |
| `web-hygiene` | medium | R4, R14 (one collaborators client), R15's polling half (changes screens driven by `changes.updated`, if it carries what they need, otherwise say why the poll stays), R20, R16 (Home and board defects) | `pages/config/decisions/*`, `lib/api/collaborators.ts`, `pages/project/shared-data.ts` and its users, `components/changes/*`, `pages/tasks/item/model.ts`, `workItem.json`, Home and board CSS/TSX | `core-hygiene` (`events.ts`), `ci-terminal` (web fixtures) | web tests, token test, `e2e` gate on `home`, `tasks`, `changes` |
| `tests` | medium | R17 (each listed test waits on an event or a fake clock), R18 (await every `shutdown()`; `teardown.test.ts` requires `await`; the reopening tests shut down first), R19 (headers say what practice is) | the listed test files, `apps/api/test/*` shutdown lines | `security` (`security.test.ts`) | `test` gate twice in a row |
| `ui-review` | high | R10, and #84's terminal menu, paste sheet and schedule prompts (CLD-4): `/ui-review` in both themes and on a phone; fix what it finds, within design-system tokens | web files the review names | `ci-terminal`, `web-hygiene`, `security` | `/ui-review` SHIPPABLE, `e2e` gate on the touched specs |
| `docs` | — (sonnet) | Tick the regression plan's Open checklist with the PR's commits; record R5 and R23 as closed by evidence; `docs/decisions/still-queued.md`; `docs/decisions/chat-token-compact.md`; `docs/decisions/mcp-writes-under-bypass.md` (§2.1); `status.md` (the headless image and the LAN listener are released; #84; this plan); `ROADMAP.md` (Done: the OpenAI-compatible API, the headless image, the LAN listener, the terminal menu; the apt repository moves out of "Decided against"; no `pkexec`); CLD-4 and its criteria | `docs/**`, `ROADMAP.md` | every task above | `kb` front matter, links |
| `review` | high | Check every task against this plan and §1.2, run the `review` gate on the integrated diff, and open the PR | — | all | `verify` with every gate, then `queue_enqueue` |

`ci-terminal`, `delivery`, `security` and `core-hygiene` start in parallel: they share no file.

## Outcome

Written by the `docs` task from the other tasks' results and their branches as merged into
`worktree-bee431cc-docs`. Each task built on its own branch (`worktree-bee431cc-<task>`); the one
merge conflict (`apps/api/src/openapi/routes.ts`, the descriptions of resume and fork, where
`delivery` and `security` both wrote) was resolved by keeping both sentences. Lint and typecheck pass
on the merged tree. The whole test suite and the `e2e` gate ran once in the review. The `terminal*` specs run in
the pull request's CI.

### What each task built

| Task | Built | Commits |
|---|---|---|
| `ci-terminal` | The cause of `terminal.spec` step 5: `terminal-menu` and `terminal-paste` turned the feature off without dismissing their terminals, which stay listed for an hour, so a third tab appeared; the three specs now dismiss theirs and `terminal.spec` checks that none is left. Step 4 looked for the first output among rows that a taller prompt pushed out of view; it checks the last output and reports the screen before and after. `shareTerminalFeed` leaves one `terminal.changed` subscription per page (five components had one each; this is the only product change). `usage.spec` no longer depends on the date. Causes are in [terminal.md](../terminal.md) | `366486fd0`, `cccb2bf4a`, `0a113e39b`, `6661f0702` |
| `delivery` | R1, R8, R9: [decisions/still-queued.md](../decisions/still-queued.md); a one-turn chat keeps its input open while background work runs; resume and fork refuse an unknown model with `400 model-unknown`, and a model the CLI rejects fails the execution | `7ed0c0c05`, `e3a8bad43` |
| `accounts` | R11, R12, and a blocked composer that grows to its text and is 44 px tall on a phone | `5dd2c8393`, `9f192d04a`, `f647fe3f1`, `15d0242cd`, `f4430b6d9` |
| `security` | R3 ([decisions/chat-token-compact.md](../decisions/chat-token-compact.md)) and R7 | `faa996adf`, `1d443b547` |
| `review-gate` | R21 (a credential detector of its own) and R22 (per-run chunk sizing, `not-reviewable`, an `unreviewed` round without fixer) | `34890c245`, `7201b0759`, `858072b6a`, `94885ee26` |
| `core-hygiene` | R2, R13 and R15's event half (`workitem.moved` by item) | `a9f0d1811` |
| `web-hygiene` | R4, R14, R15's polling half, R16, R20 | `19ca63ea9`, `ae36b9f31`, `dbf99ea64`, `1a4b3803d`, `52106dfd3`, `f3471e311` |
| `tests` | R17, R18, R19 | `0e63d441c`, `d79790a9d`, `50b6ba07b` |
| `ui-review` | #84's schedule prompt and the delivery cards (answers stay put, the next fires on the schedule's clock, the queued card's contrast, a write's detail in prose), the reload offer and the stale page, the board's "⋯" on coarse pointers, and the paste sheet's spacing | `c4dc5401c`, `31eb5d8b1`, `f89ea3206`, `e7ded6b8f` |
| `docs` | Ticks the regression checklist; the three decision documents; status and roadmap | this branch |
| R6 | Decided, not built: [decisions/mcp-writes-under-bypass.md](../decisions/mcp-writes-under-bypass.md) | `12383a4ec`, `docs` |
| R5, R23 | Closed by evidence (§1.2) | none |

### What stayed open, and why

- **The terminal specs.** `ci-terminal` could not push (denied by the workers' guard), and
  `pnpm e2e:remote` was removed on 2026-11-07 (the owner: a bridge from before Sluice). The four
  `terminal*` specs therefore first run in the pull request's CI. On this machine the review's `e2e` gate passed `security`, `usage`, `schedule-prompt`,
  `home`, `tasks`, `changes` and `mobile`. The four `terminal*` specs are refused there with `403
  terminal.from-agent` (§1.1), so they only run on GitHub.
- **`mobile.spec` fails only on Dependabot #87**, probably `@tanstack/react-virtual` 3.14.26 with
  `VirtualList.tsx`. It is not touched: it depends on that lockfile.
- **R22 does not prevent the incident at the default cap.** At 1 USD no chunk is split: the
  estimate is about 0.29 USD for a 120 KB chunk, the real cost was about 0.6 USD per run.
  Recalibrating the estimate is a separate decision. Why a run gives "no structured output" is not
  proven; the stop reason now says.
- **The fixture of a rejected model is rebuilt from the CLI's code** (2.1.319), not recorded, because a
  recording costs a paid turn.
- **R10 has no written verdict from `ui-review`** beyond its commits' bodies; the board's "⋯" on
  coarse pointers was fixed in `f89ea3206`, which the `docs` task had not seen.
- **R15's gap:** decisions taken outside a permission (`orchestration.retry`, `flow.*`) and audit
  rows with no event (a refused request) show on the next mount, focus or event.
- **Fixed sleeps left on purpose** in `flow.test.ts`, `setup-logins.test.ts`,
  `collab-join-answer.test.ts` and `collab-quiet.test.ts` ("nothing happened" checks), and
  count-based waits in other core tests.
- **`provider_limits`, the approval ledger of assistant-everything, and a real phone's keyboard on
  the paste sheet** (§2.4), as planned.
- **CLD-4** is named by this plan but no document defines it; its criteria could not be written.

### Review (task `review`, on the integrated branch)

Each item of §1.2 checked against the code and tests of the merged tree:

- **Done:** R1, R2, R3, R4, R7, R8, R9, R12, R13, R14, R15 (both halves as its row says), R18,
  R19, R20, R21, R22; R5 and R23 by evidence; R6 by decision.
- **Partly:**
  - **R10:** fixed in code (`c4dc5401c`, `31eb5d8b1`, `f89ea3206`, `e7ded6b8f`). No written
    SHIPPABLE verdict, and the specs it touched have not run.
  - **R11:** `moveTo` clears the limit. `limitedAccounts` is not cleared on a wait-replay as the
    row says: a failure stops counting once a reading shows its reset passed, which covers the
    wait-replay and the saved runs (`accounts`' choice, in [accounts.md](../accounts.md)).
  - **R16:** the 72 tap-target hits were cleared in the checker (I9 measures a stretched link by
    its row), not the UI, because the rows already were 64 px targets. The gradient fix covers
    Home with nothing running; the agents-setup Home still has the head's gradient.
  - **R17:** `accounts-rotation` waits on the rotation's own calls now, but still spawns the fake
    CLI.
- **Fixed by the review:**
  - `collab-join-answer`'s denial test read the pending file and then looked for the event that
    `endJoin` sends only after writing it. That race failed the `test` gate on the integrated tree.
    The test now waits on the event; a 200 ms pause between the write and the event fails the old
    test and passes the new one.
  - `teardown.test.ts` took an `await` anywhere earlier on the line as the call's own.
  - A doc comment in `apps/api/src/security.ts` had slid onto the wrong function in the merge.
  - `openai-tools.test.ts`'s cold resume test timed out in two of the review's four full gates, never alone. It
    waited for two stub lines in the fake's log. The killed process writes its line in the tick
    after it hands its calls over, so under load the SIGKILL landed first, which the failure's own
    dump showed. The test now waits for the resumed process's line, which is what it means to check.
  - **A product race behind a test.** `collab-join-answer`'s "answered pending at once" test saw
    the join sent twice under load. `join()` wrote the waiting entry and marked the join as in
    flight only after that write's `await`, so a pass over the waiting joins that ran in between
    sent the join again beside the first attempt. The join is now marked before the write. A new
    test runs the pass in that window every time; it fails on the old code (the pass dials Ana)
    and passes on the new.
  - `chat-delivery-bounds`' two replay tests took the fake's `turn` line as "the first turn was
    taken". Under load Claudio had not read it yet, so the replay carried the first prompt as
    well, which is right for what Claudio knew. They now wait for its `delivered`.
- **Left as built:**
  - `roundStatus` reports a round whose reviewers all failed as `incomplete` even when the
    deterministic scan blocked. The fixer does not run either way, and the findings are listed.
  - `31eb5d8b1` is titled "ui-review", not a Conventional Commit; the squash merge replaces it.

### Defects seen outside the plan

- Switching off the terminal leaves its terminals listed as "Closed" on the next start, even those of
  deleted projects, and deleting a project does not close its terminals.
- The `DatePicker`'s previous-month button does nothing when that whole month is out of range.
- "Wait for the reset" shifts the layout 0.004 to 0.016, above I4's 0.001; it did on main.
- A pending account switch overrides the account the rotation chose at start (`chooseAccount`), and
  moving an exhausted chat with a wait open makes that wait resend the turn when it ends.
- `modelCache.read` reads the disk on every `cached()`.
- Searching settings for "Supervisor cap" opens Advanced with no row when the Supervisor is off.
- Home in the agents-setup state keeps the head's gradient "New chat", unlike the reference.
- The Access & safety summary does not mention refused requests.
- A `/compact` sent through `/v1/chat/completions` or `/v1/responses` is not refused to a chat's
  token. It can only reach chats the API caller started there, never a person's chat, so this is
  probably intended, but no document says so.
- `orchestrator.ts` says "work you delegated is still running" when it already finished.
- Many core tests leave directories in the temp dir, and the "saving the chats failed: statement has
  been finalized" warning shows in core tests.

## Related

[[plans/regression-fixes-2026-10-29.md]] · [[reports/regression-audit-2026-10-29.md]] · [[plans/terminal-menu-schedules-v1-tools.md]] · [[terminal.md]] · [[claudio-mcp-server.md]] · [[accounts.md]] · [[orchestrations.md]] · [[status.md]]
