---
created_at: 2026-10-16T16:30:00Z
updated_at: 2026-10-16T16:30:00Z
tags:
    - status
    - checkpoint
    - release
    - claudio
---
# Checkpoint, 2026-10-16: everything is in `main`

Claudio forked from Agentry 0.37.1 (`d1ee00514`) on 2026-10-15. On 2026-10-16 every stream built since
then is merged into `main` (`2096cb628`): about 500 commits, local only, not pushed. This page is the
checkpoint: what was built, how it was checked, what was cleaned, and what is next. The live list of
open requests is [requests.md](../requests.md); the release report is
[release-readiness.md](release-readiness.md).

## What was built

| Area | What it gives | Merged |
| --- | --- | --- |
| Stage S, the strip | Claude Code only: the other providers, ~500 recordings and their screens removed | 2026-10-15 |
| Stage A, accounts | `@claudio/accounts`: several Claude accounts (one `CLAUDE_CONFIG_DIR` each, or a token), chosen per process, switched at a limit, then wait; no claude-swap | 2026-10-15 |
| Stage A2, models per account | The full model list per account from the CLI's `initialize`; `account.model-fallback` (ships off) | 2026-10-15 |
| Rebrand | Night Shift in Claudio's colours, logo, illustrations | 2026-10-15 |
| Chat experience | CHAT-1 … CHAT-18 (optimistic message, streaming fade, question to the top, drafts, history, markdown repair, …) and the ProseMirror composer; CHAT-19 kept as is | 2026-10-15 |
| SDK driver improvements | D1–D3 and point 9; connectors from `mcp_status` (A) and authorise from Claudio (B) | 2026-10-15 |
| Project docs | Claude Docs per project, through the connector | 2026-10-15 |
| Stage R, the rename | Claudio as a product of its own; the leftovers (`claudioAssistant`, storage keys, `window.claudioDesktop`) with migrations, [rename-compatibility.md](../rename-compatibility.md) | 2026-10-15/16 |
| Terminal | The person's own shell, only in the status bar, opening in the selected project, detachable into a window, full screen; audited (T8-1 accepted and warned) | 2026-10-15/16 |
| Security fixes | Workers can never push; diffs never run a repository's drivers; only the person approves memory proposals | 2026-10-15 |
| ECC ★4 context control | Context breakdown, Compact now, compaction dividers, session notes | 2026-10-16 |
| ECC 6–15 agent-run improvements | Prompt rules, fixer stop rules, plateau, tool risk, daily spend cap, optional roles, path-scoped rules | 2026-10-16 |
| Tool rows and live branches | Tool calls readable as what happened; running subagents, background tasks and workflows at a glance | 2026-10-16 |
| Limit fixes | Limit state only from the CLI's data; tasks follow a replayed turn; a chat goes on with any account with room | 2026-10-16 |
| Rotation auth fixes | An expired or incomplete sign-in is out of rotation and shown; a sign-in failure rotates; a retry chooses its account again (R2–R5) | 2026-10-16 |
| Chat account switch | Switch a chat's account on demand from the composer's "+" menu (R1) | 2026-10-16 |
| ECC ★3 guards | Hooks through `--settings` that block `--no-verify`, pushes, destructive commands and secrets, even in bypass mode | 2026-10-16 |
| ECC ★1 review gate | Reviewers and a verifier on the integrated diff before verification can pass (opt-in per graph) | 2026-10-16 |
| ECC ★2 lessons | Lessons proposed from the person's corrections, approved, delivered to later agents | 2026-10-16 |
| ECC ★5 instruction evals | Phase 1 and phase 2 (behind `evalsPhase2`, off) | 2026-10-16 |

## How it was checked (2026-10-16, on `2096cb628`)

- `pnpm typecheck` and `pnpm build`: clean.
- Unit tests, one package at a time, with the orchestrating chat's `CLAUDIO_*` variables unset: shared
  292, accounts 47, mcp 29, ui 23, chat-ui 71, desktop 58, api 435, web 1,596, core 3,240 (120 `todo`
  rows of the guard audit, 5 skipped). One core test (`chat-account-switch.test.ts`, the queued switch)
  failed in the full run and passes alone (9/9): load.
- **e2e: not run on this commit.** The owner chose to merge without it and repair e2e on `main` next.
  The new specs of guards, review gate, lessons and evals were written without running.

## What was cleaned

- 71 worktrees of the ECC orchestration, 15 of the rotation and account-switch orchestrations, 7 of the
  live-branches orchestration and the stray integration worktrees; 22 GB free on the disk after.
- 180 local branches already merged into `main` (task, integration and fix branches).
- claude-swap purged and uninstalled (its accounts' current credentials moved into Claudio first,
  backed up in `~/.local/share/claudio-cred-backup-20261016`).
- The npm and uv caches and old desktop builds.

Left on purpose: `claudio-fixrot` (an abandoned draft superseded by the rotation auth fixes),
`bdab32b6-c1/c2/d1` (a stopped run of the live-branches orchestration whose rerun was merged),
`claudio-collab` (the Collaborators plan, R7), `claudio-resource-control` (`feat/resource-control`,
another chat's work in progress) and `claudio-preview`.

## What is next

1. **Repair e2e on `main`**, run outside any Claudio chat (inside one, the terminal's peer check rightly
   treats the test browser as an agent).
2. **R9:** build and install the desktop app from `main`.
3. Open requests ([requests.md](../requests.md)): R10 (a limit wait ignores an account that got room)
   and R11 (a stopped task has no way back); R6 (the Stitch redesign), R7 (Collaborators), R8 (WebMCP).
4. The first release: the owner's steps in [release-readiness.md](release-readiness.md), then push the
   repository (the owner's).

## Related

[[status.md]] · [[requests.md]] · [[reports/release-readiness.md]] · [[reports/ecc.md]] ·
[[plans/claude-only-fork.md]]
