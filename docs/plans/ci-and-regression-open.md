---
created_at: 2026-11-07T00:00:00Z
updated_at: 2026-11-07T00:00:00Z
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

Status: **proposed, waiting for the owner's approval** before the orchestration is launched. One
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
    runs on GitHub through `pnpm e2e:remote <specs>`.

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
| R15 | Polling and events | Open: `LIVE_REFRESH_MS = 8_000` (`changes/source.ts:37`). There are no `decision.*`/`audit.*` events. `workitem.moved` invalidates every item page although it carries `itemId` (`lib/events.ts:452`) | web, shared, core |
| R16 | Older web defects | Open: a 17 px link on Home, a clipped Tailscale row, and more than two gradient surfaces when signed out; 72 tap-target hits on the board's phone rows; column headings cut at 1280 px | web |
| R17 | Load-sensitive tests | Open. Wall-clock bounds in `collab-join-answer.test.ts:417,429-432,470`, `collab-quiet.test.ts:140-145`, `setup-logins.test.ts:170` and `tunnel.test.ts`; fixed waits in `apps/api/test/flow.test.ts:28-34` and `openai-tools.test.ts:381,397`; real spawns in `accounts-rotation` | tests |
| R18 | Unawaited `core.shutdown()` | Open: 94 calls in 65 API test files. `security.test.ts:719` reopens the same root, `security.test.ts:330-347` never shuts down, and `packaging.test.ts:257-291` keeps four Cores on one data dir. `teardown.test.ts:17` counts the calls but does not require `await` | `apps/api/test` |
| R19 | Fixture headers say "no task may update" | Open: every recent feature PR updates them | `apps/web/test/strings-snapshot.test.ts:1`, `class-inventory.test.ts:1` |
| R20 | `chat.api-write` cause text | Open: `CAUSE_KEY` lacks it, so it falls back to `cause.other` | `apps/web/src/pages/tasks/item/model.ts:189-205`, `workItem.json:151` |
| R21 | Review gate `secret` rule matches names | Open: it reuses the redaction masker's `SECRET_ASSIGNMENT` (`decisions/redact.ts:66`), on tests and fixtures too | `packages/core/src/review-scan.ts:111` |
| R22 | Review runs with no structured output; the fixer runs anyway | Open. No chunk is checked against `runCap` (`review-gate.ts:293,364,432`). A round where every run was invalid still calls `reviewFix` when the scan blocked (`orchestrator.ts:3061-3074`, `review-findings.ts:176`) | core |
| R23 | Desktop updater and `pkexec` | **Closed in the code.** No `pkexec` in `apps/desktop/src`, and a test forbids it (`updater.test.ts:142`). An install from the apt source updates through apt; a `.deb` without it offers one checked command | — |

## 2. Decisions

### 2.1 R6, MCP writes under bypass: **waiting for the owner**

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

**Proposed:** this PR records it as intended in a decision document: bypass delegates to the agent
what its token may already do. The approval ledger is built as its own piece, with its design
first. **The owner's answer is needed before launch.** The other choice was "an approval for every
MCP write in every chat", which leaves `curl` open.

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
  through the `e2e` gate with spec prefixes, or `pnpm e2e:remote <specs>` on GitHub.
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
| `docs` | — (sonnet) | Tick the regression plan's Open checklist with the PR's commits; record R5 and R23 as closed by evidence; `docs/decisions/still-queued.md`; `docs/decisions/chat-token-compact.md`; R6's decision once the owner answers; `status.md` (the headless image and the LAN listener are released; #84; this plan); `ROADMAP.md` (Done: the OpenAI-compatible API, the headless image, the LAN listener, the terminal menu; the apt repository moves out of "Decided against"; no `pkexec`); CLD-4 and its criteria | `docs/**`, `ROADMAP.md` | every task above | `kb` front matter, links |
| `review` | high | Check every task against this plan and §1.2, run the `review` gate on the integrated diff, and open the PR | — | all | `verify` with every gate, then `queue_enqueue` |

`ci-terminal`, `delivery`, `security` and `core-hygiene` start in parallel: they share no file.

## Related

[[plans/regression-fixes-2026-10-29.md]] · [[reports/regression-audit-2026-10-29.md]] · [[plans/terminal-menu-schedules-v1-tools.md]] · [[terminal.md]] · [[claudio-mcp-server.md]] · [[accounts.md]] · [[orchestrations.md]] · [[status.md]]
