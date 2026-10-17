---
created_at: 2026-10-16T12:30:00Z
updated_at: 2026-10-17T02:30:00Z
tags:
    - status
    - requests
    - backlog
    - claudio
---
# The owner's open requests

Every request the owner made that is not built yet, with where it was asked, so none is lost again.
The on-demand account switch was asked on 2026-10-15 and dropped while the fork plan was written
(see below); this list exists so that does not happen twice.

A request leaves this list only when it is built and merged into `main` (with the commit or plan
that built it) or when the owner drops it.

## Open

| # | Request | Asked | Status |
| --- | --- | --- | --- |
| R1 | **Switch a live chat to another account on demand** ("cambiar de cuenta en caliente, automáticamente y a demanda del usuario"). The automatic half is built (at a limit, the turn is replayed on another account); the on-demand half was never planned. Options offered: a "Switch account" action in the chat header that ends the process between turns and resumes the same session on the chosen account (recommended), an account picker in the composer's "+" menu, or a "Continue on another account" prompt near a limit. `--resume` across accounts was confirmed in stage A (reports/accounts-a0.md) | 2026-10-15 10:30, chat fd906f33; again 2026-10-16 | **Closed 2026-10-16**: the owner chose the composer's "+" menu; built as [plans/chat-account-switch.md](plans/chat-account-switch.md) in `a4c345c55` (core), `56ca47b7c` (API) and `b465ed15d` (composer), with `e2e/specs/chat-account-switch.spec.mjs` |
| R2 | **Rotation bug: a dead OAuth session reads as signed in.** `signedIn` comes from `claude auth status` (`packages/accounts/src/identify.ts:17`), which is true while the credentials file exists; an unread account is assumed signed in (`store.ts:42`). Mark the account "session expired" on an authentication failure and exclude it until it is signed in again; warn when the file has no `refreshToken` | Found 2026-10-16 (ECC orchestration stall) | **Closed 2026-10-16** by `c3480b0e0` (the state), `38810ccc6` (shown, sign in again), [plans/rotation-auth-fixes.md](plans/rotation-auth-fixes.md) |
| R3 | **Rotation bug: an authentication failure does not rotate.** Only limits do (`RATE_LIMIT_RE`, `stream.ts:9`); "Failed to authenticate / OAuth session expired" is a generic task failure retried on the same account | Found 2026-10-16 | **Closed 2026-10-16** by `6597a0341`, [plans/rotation-auth-fixes.md](plans/rotation-auth-fixes.md) |
| R4 | **Rotation bug: "Retry" keeps the chat's account.** `retryTask` (`orchestrator.ts:2555`) resumes the same chat on the same account, even one at its limit; only "Start over" rotates | Found 2026-10-16 | **Closed 2026-10-16** by `c493a8be9` (already true: a retry chooses its account again; a test guards it), [plans/rotation-auth-fixes.md](plans/rotation-auth-fixes.md) |
| R5 | **Rotation bug (to confirm): a limit hit on a retry marks the task failed instead of rotating.** Likely the CLI answers the limit as an error result at start, before any `rate_limit_event`, and that path does not reach the rotation | Found 2026-10-16 | **Closed 2026-10-16** by `c493a8be9` (confirmed with the fake CLI), [plans/rotation-auth-fixes.md](plans/rotation-auth-fixes.md) |
| R10 | **Rotation bug: a limit wait does not resume when another account gets room first.** On 2026-10-16 every account was out at 12:44 UTC; the waits took 13:10/14:00 UTC as their reset, the default account's window restarted around 12:50 UTC with 0 % used, and twelve tasks kept waiting. A wait must re-check every usable account when any account's reading changes (a new `rate_limit_event`, a reset passing) and resume on the first one with room | Found 2026-10-16 | Open; with R2–R5 |
| R11 | **Orchestration bug: a stopped task has no way back.** After "Stop waiting" a task ends `stopped`; `retry` and `retry-clean` accept only `failed`, and `resume` refuses a graph that is `waiting` for a decision. The only way out on 2026-10-16 was to stop the whole graph and resume it (which interrupts its running tasks). A stopped task must be retryable, and "Stop waiting" on a task should offer "run it now on an account with room" | Found 2026-10-16 | Open; with R2–R5 and R10 |
| R15 | **Workflow engine: a usage limit is neither seen nor rotated.** On 2026-10-16 orchestration f33d7d0b (engine `workflow`) ran out of its account's five-hour window: a subagent and then the synthesis ended with "You've hit your session limit", the CLI's workflow journal recorded both as `failed`, yet the graph stayed `running`, the task `pending`, nothing rotated, and the lead session sat in a `sleep 30` loop over its own journal until a person stopped and resumed it | Found 2026-10-17 | Built 2026-10-17 on the R15 orchestration's branches (`761bfef30`, `474953963`, `896f471da`, `ba8a3c869`, docs), not yet in `main`: the journal drives task states, a limit holds or rotates the lead and resumes from the cache, a watchdog ends a run left unwatched, the lead no longer polls. [plans/workflow-engine-limits.md](plans/workflow-engine-limits.md#outcome) · [orchestrations.md](orchestrations.md#the-workflow-engine) |
| R6 | **Full redesign of the app with Stitch** ("rediseño completo… parece la típica app generada por IA"). Four screens follow the new frame in Stitch (Accounts, Usage, Chats, Settings); Home, Chat, Orchestration and New chat do not yet. Nothing is in code | 2026-10-15 20:37, chat e5fe37cb | Design in progress in Stitch; not implemented |
| R7 | **Collaborators: share a project between teammates' Claudio over iroh, P2P** (live synced copy, sharing chosen per project, optional team management). The plan is written but **uncommitted** in `~/Escritorio/claudio-collab` (branch `docs/collaborators-plan`) and waits for an adversarial review | 2026-10-16 08:33–08:57, chat 2cc1e276 | Plan written, review pending |
| R8 | **WebMCP** in Claudio: researched (what it is and where it could fit); no decision to build | 2026-10-15 17:37, chat ba0064f0 | Researched; waiting for a decision |
| R9 | **Update the desktop app on this machine once everything is in `main`** | 2026-10-16 09:25, chat 3ef3eec0 | After the ECC orchestration lands |

## Closed

| Request | Closed by |
| --- | --- |
| Terminal only in the status bar, opening in the selected project's workspace, detachable and full screen | Merged into `main` on 2026-10-15/16 ([terminal.md](terminal.md)) |
| Readable tool rows; background tasks and subagents visible in the chat | `claudio-live-branches`, merged as `c607354f4` ([chat-tool-rows-and-branches.md](chat-tool-rows-and-branches.md)) |
| CHAT-19 reading typography | Dropped by the owner on 2026-10-16: kept at 14px / 1.65 |
| Claudio invented limit state after a failed turn; orchestration tasks stayed "running" after a limit | Orchestration `71057ae6` "Fix invented account limit state", merged into `main` as `1d2b21087`, `3ee906fb4`, `2d79a7daa`, `43611759d` (2026-10-16) |
| Move cswap's accounts into Claudio and remove cswap | 2026-10-16: current credentials copied into Claudio's account dirs, cswap purged and uninstalled |

## Related

[[status.md]] · [[accounts.md]] · [[plans/claude-only-fork.md]] · [[plans/models-per-account.md]] ·
[[reports/ecc.md]]
