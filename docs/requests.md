---
created_at: 2026-10-16T12:30:00Z
updated_at: 2026-10-17T14:00:00Z
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
| R6 | **Full redesign of the app with Stitch** ("rediseño completo… parece la típica app generada por IA"). Four screens follow the new frame in Stitch (Accounts, Usage, Chats, Settings); Home, Chat, Orchestration and New chat do not yet. Nothing is in code | 2026-10-15 20:37, chat e5fe37cb | Design in progress in Stitch; not implemented |
| R8 | **WebMCP** in Claudio: researched (what it is and where it could fit); no decision to build | 2026-10-15 17:37, chat ba0064f0 | Researched; waiting for a decision |

## Closed

| Request | Closed by |
| --- | --- |
| R10: a limit wait did not resume when another account got room first | #21 on 2026-10-17: every account reading or change makes each open wait ask the accounts again, and an account a turn failed on counts again once a newer reading says it has room ([accounts.md](accounts.md), [orchestrations.md](orchestrations.md)); tests in `accounts-rotation.test.ts` and `workflow-limits.test.ts` |
| R11: a stopped task had no way back | #21 on 2026-10-17: retry, retry-clean and skip accept a stopped task, resume accepts a waiting graph, and `POST /limits/waits/:id/run-now` (a "Run now" beside "Stop waiting") replays a waiting turn on an account with room; tests in `orchestration-limit-way-back.test.ts` and `provider-rotation.test.ts` |
| R9: update the desktop app on this machine once everything is in `main` | The owner installed the v0.2.0 `.deb` on 2026-10-17 (sha256 checked against the release asset); `dpkg` reports 0.2.0 |
| R1: switch a live chat to another account on demand | The owner chose the composer's "+" menu; built as [plans/chat-account-switch.md](plans/chat-account-switch.md) in `a4c345c55` (core), `56ca47b7c` (API) and `b465ed15d` (composer), all in `main`, with `chat-account-switch.test.ts` (core and API), `account-choice.test.ts` and `e2e/specs/chat-account-switch.spec.mjs`; the core tests' load flake was fixed in #18 |
| R2: a dead OAuth session read as signed in | `c3480b0e0` (the expired or incomplete sign-in is a state of the account) and `38810ccc6` (shown, with a way to sign in again), in `main`, with `packages/accounts/test/sign-in-state.test.ts` and `apps/web/test/accounts.test.ts` ([plans/rotation-auth-fixes.md](plans/rotation-auth-fixes.md)) |
| R3: an authentication failure did not rotate | `6597a0341` (a sign-in failure marks the account and moves the turn like a limit), in `main`, with `accounts-rotation.test.ts`, `driver-reads.test.ts` and the `auth-expired.jsonl` replay |
| R4: "Retry" kept the chat's account | Already true when checked: a retry chooses its account again; `c493a8be9` added `orchestration-retry-account.test.ts` to guard it |
| R5: a limit hit on a retry marked the task failed instead of rotating | Confirmed with the fake CLI and fixed in `c493a8be9`, with `orchestration-retry-account.test.ts` |
| R12: the collaborators follow-ups (frozen groups, names, quiet refusals, subagent transcripts, uploads per chat, the join-request notification, the read-only view of an uncloned project, iroh issue drafts) | Workflow `f33d7d0b`, merged in #7 on 2026-10-17 ([plans/collaborators.md](plans/collaborators.md#follow-ups-r12-2026-10-17)); the iroh issues wait in [reports/iroh-upstream-issues.md](reports/iroh-upstream-issues.md) for the owner to file |
| R13: agents read what teammates share (the assistant always, a project's chats when it opts in, never in `bypassPermissions`, the sharer's flag, an audit) | Orchestration `4bbd0902`, merged in #13 on 2026-10-17 ([plans/collaborators-agent-access.md](plans/collaborators-agent-access.md)) |
| R14: a denied join never reached the joiner; an expired invite stayed pending | Fixed in #7 on 2026-10-17 (`collab_join_denials`, a `denied` wire answer; [collaborators.md](collaborators.md)) |
| R15: the workflow engine neither saw nor rotated a usage limit | Orchestration `b679d27e`, merged in #10 on 2026-10-17 ([plans/workflow-engine-limits.md](plans/workflow-engine-limits.md)) |
| R16: dimmed streaming text, a gap above the composer, the assistant's own composer | Orchestration `c4d3807c`, merged in #9 on 2026-10-17 |
| R7: collaborators, a project shared between teammates' Claudio over iroh, P2P | Built by orchestration `623d02f4` from [plans/collaborators.md](plans/collaborators.md) and merged into `main` on 2026-10-16 ([collaborators.md](collaborators.md)); a run between two real machines is still to be done |
| Terminal only in the status bar, opening in the selected project's workspace, detachable and full screen | Merged into `main` on 2026-10-15/16 ([terminal.md](terminal.md)) |
| Readable tool rows; background tasks and subagents visible in the chat | `claudio-live-branches`, merged as `c607354f4` ([chat-tool-rows-and-branches.md](chat-tool-rows-and-branches.md)) |
| CHAT-19 reading typography | Dropped by the owner on 2026-10-16: kept at 14px / 1.65 |
| Claudio invented limit state after a failed turn; orchestration tasks stayed "running" after a limit | Orchestration `71057ae6` "Fix invented account limit state", merged into `main` as `1d2b21087`, `3ee906fb4`, `2d79a7daa`, `43611759d` (2026-10-16) |
| Move cswap's accounts into Claudio and remove cswap | 2026-10-16: current credentials copied into Claudio's account dirs, cswap purged and uninstalled |

## Related

[[status.md]] · [[accounts.md]] · [[plans/claude-only-fork.md]] · [[plans/models-per-account.md]] ·
[[reports/ecc.md]]
