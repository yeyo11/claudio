---
created_at: 2026-10-16T12:30:00Z
updated_at: 2026-10-17T09:00:00Z
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
| R6 | **Full redesign of the app with Stitch** ("rediseño completo… parece la típica app generada por IA"). Four screens follow the new frame in Stitch (Accounts, Usage, Chats, Settings); Home, Chat, Orchestration and New chat do not yet. Nothing is in code | 2026-10-15 20:37, chat e5fe37cb | Design in progress in Stitch; not implemented |
| R8 | **WebMCP** in Claudio: researched (what it is and where it could fit); no decision to build | 2026-10-15 17:37, chat ba0064f0 | Researched; waiting for a decision |
| R9 | **Update the desktop app on this machine once everything is in `main`** | 2026-10-16 09:25, chat 3ef3eec0 | After the ECC orchestration lands |
| R12 | **Collaborators follow-ups** (what orchestration `623d02f4` left open, [plans/collaborators.md](plans/collaborators.md#outcome)). **Built** on `feat/collaborators-gaps` ([plans/collaborators.md](plans/collaborators.md#follow-ups-r12-2026-10-17)): the read-only view of a shared project not cloned here (`13f544e56`); subagent transcripts pulled with their chat (`687dee387`); which uploads belong to a chat kept as rows (`555d1dab5`); `frozen` reported by the install that owned the group (`1f4a31ccd`); members, joins and relays shown by name with the short endpoint id (`a3b05178a`); quiet `forbidden` sync logs (`c9faf0c49`); the owner's decision that `collaborators.join-request` notifies, built (`a969482ae`); browser specs and `e2e/timings.json` entries (`3935df03a`); both iroh issues rechecked against 1.1.0 and drafted in [reports/iroh-upstream-issues.md](reports/iroh-upstream-issues.md) (`7e6715ec4`). **Still open:** a run between two real machines (only loopback on the minimal preset was tested; the Docker image reaches n0's relay, checked 2026-10-16), and filing the two iroh issues (the `watch*` calls panic in 1.1.0; streams and `sign` reject `Buffer`) | 2026-10-16, synthesis of orchestration 623d02f4 | Built on `feat/collaborators-gaps`, not yet in `main`; open: the two-machine run, and the owner to file the iroh issues |
| R13 | **Agents read what teammates share** (hybrid chosen by the owner): the global assistant reads every shared copy; a project's chats get read-only MCP tools for its copies when the project opts in. Plan: [plans/collaborators-agent-access.md](plans/collaborators-agent-access.md) | 2026-10-17 00:35, chat 3e4665d9 | Planned and decided; build after R12 |
| R14 | **Collaborators bug: a denied join never reaches the joiner.** `denyJoin` deletes the request on the owner and clears the bell, but neither the joiner nor the member that relayed it hears of it; the joiner's `retryPending` keeps asking for a chain it is not in, so its page says pending forever. An expired invite also stays pending. Found by the owner's three-install LAN test | 2026-10-17 00:20, chat 3e4665d9 | **Fixed on `feat/collaborators-merge` (PR #7):** the owner keeps each denial (`collab_join_denials`) until the invite expires and answers a joiner that asks with its invite's tag `denied`; members learn the group's denials on each sync (`joinAnswers`) and answer for an owner who is away; the joiner's page turns the join into a dismissable *Denied* or *Expired* card, live (`collaborators.join-ended`). See [collaborators.md](collaborators.md) |
| R15 | **Orchestration bug: the workflow engine neither sees nor rotates a usage limit.** On 2026-10-17 orchestration `f33d7d0b` (engine `workflow`) ran on `acc-a6b913cd` until its five-hour window ran out at 00:07: the `g8` subagent and then the synthesis ended with "You've hit your session limit", the workflow journal recorded both as `failed`, yet Claudio kept the graph `running`, showed `g8` as `pending`, did not fail the task and did not rotate; the driving session sat in an unbounded `sleep 30` loop over its own journal. Task states come only from the script's final result (`readCompiledResult`, `packages/core/src/workflow-engine.ts`). Fix: follow the workflow journal live (started, result, failed per task) into task states; read a subagent's or the session's limit message as a rate limit, so the run waits or rotates like a graph task (resume from cache on the next account); never leave the graph `running` with no live work. Worked around with stop + resume, which rotated to `acc-79ffec12` | 2026-10-17 00:35, chat 3e4665d9 (owner: "habría que arreglarlo") | To plan and build after PR #7 |

## Closed

| Request | Closed by |
| --- | --- |
| R7: collaborators, a project shared between teammates' Claudio over iroh, P2P | Built by orchestration `623d02f4` from [plans/collaborators.md](plans/collaborators.md) and merged into `main` on 2026-10-16 ([collaborators.md](collaborators.md)); a run between two real machines is still to be done |
| Terminal only in the status bar, opening in the selected project's workspace, detachable and full screen | Merged into `main` on 2026-10-15/16 ([terminal.md](terminal.md)) |
| Readable tool rows; background tasks and subagents visible in the chat | `claudio-live-branches`, merged as `c607354f4` ([chat-tool-rows-and-branches.md](chat-tool-rows-and-branches.md)) |
| CHAT-19 reading typography | Dropped by the owner on 2026-10-16: kept at 14px / 1.65 |
| Claudio invented limit state after a failed turn; orchestration tasks stayed "running" after a limit | Orchestration `71057ae6` "Fix invented account limit state", merged into `main` as `1d2b21087`, `3ee906fb4`, `2d79a7daa`, `43611759d` (2026-10-16) |
| Move cswap's accounts into Claudio and remove cswap | 2026-10-16: current credentials copied into Claudio's account dirs, cswap purged and uninstalled |

## Related

[[status.md]] · [[accounts.md]] · [[plans/claude-only-fork.md]] · [[plans/models-per-account.md]] ·
[[reports/ecc.md]]
