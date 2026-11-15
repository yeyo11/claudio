---
created_at: 2026-11-15T20:00:00Z
updated_at: 2026-11-15T20:00:00Z
tags:
    - report
    - spike
    - accounts
    - mcp
    - claude-code
---
# Account configuration spikes: S4, S5 and S7 on signed-in accounts

T0 of [plans/account-configuration-and-project-rules.md](../plans/account-configuration-and-project-rules.md),
the part that needs a signed-in account. **CLI: `claude --version` = 2.1.322 (Claude Code)**, 2026-11-15.
S2b and S6 are not here: S2b is free and not run yet, S6 needs an OAuth server sign-in. S3 of
[plans/survive-restarts.md](../plans/survive-restarts.md) ran in the same session and is written up in
[decisions/parked-cli-processes.md](../decisions/parked-cli-processes.md#s3-a-pending-prompt-across-the-gap).

**Setup.** Two scratch config directories the owner signed in to for this purpose (account A and
account B, both claude.ai, Max plan), always as `CLAUDE_CONFIG_DIR`, with `HOME` and every working
directory under a fresh `mktemp -d`. The owner's `~/.claude`, `~/.config/Claudio` and account dirs
were not touched. Credentials, tokens, emails and ids were never read or recorded; state files were
inspected key by key. Models: Haiku, `--max-budget-usd 0.05` per turn. Confidence marks as in the
plan: **verified** (measured here) or **inferred**.

## S4. Name collision and strict mode

**Question.** If `.mcp.json` and `--mcp-config` declare the same server name, which wins and is it
listed twice? Does `--strict-mcp-config` drop the claude.ai connectors?

**How run.** `claude -p --input-format stream-json` on account A, with `initialize` and an
`mcp_status` control request (no turn). A stdio server (a 20-line script whose `serverInfo.name` is
its label) named `dup` was declared as `FROM_MCPJSON` in the project's `.mcp.json` and as
`FROM_FLAG` in a file given with `--mcp-config`. The project had no trust entry in the state file.

| Variant | `mcp_status` |
|---|---|
| `.mcp.json` only | `dup` (`FROM_MCPJSON`, scope `project`, connected) and the account's claude.ai connector (scope `claudeai`) |
| `.mcp.json` + `--mcp-config` | **one** `dup`, `FROM_FLAG`, scope `dynamic`; the connector is still listed |
| `--strict-mcp-config` alone | **empty list**: the connector and the `.mcp.json` server are both gone |
| `--strict-mcp-config` + `--mcp-config` | only `dup` (`FROM_FLAG`) |

**Result (verified, one run each).** The flag's definition replaces the project's, with no duplicate
entry, so an overlay entry that shares a name with a project server shadows the project's definition.
Strict mode drops the claude.ai connectors **and** the project's `.mcp.json`. Also: a stdio server
from an untrusted project's `.mcp.json` connected in `-p` mode, so trust matters for the
`headersHelper` of remote servers (plan S3b/S3c), not for stdio ones.

**Cost.** 0 turns, 0 USD.

**Means for.**
- **T3.** Never use `--strict-mcp-config` in the overlay: it would remove the account's own
  connectors, which are the identity the plan says to keep. The overlay should leave a project
  server out of the file when the project's `.mcp.json` is going to be read anyway, or accept that
  the overlay's copy wins; it cannot produce two entries, so no de-duplication code is needed.
  Because the flag wins, an overlay that carries a stale copy of a project server would override a
  newer `.mcp.json`: carry project servers only when trusted, as section 6.4 says, and rebuild on
  every change.
- **T5.** The canary can check both facts in a temp dir: same-name flag wins, and strict yields an
  empty list with no flag servers.
- **T2.** None.

## S5. What a session resumed on another account loses

**Question.** With two accounts of the same person and only `projects/` linked, what does a session
resumed with `--resume` on the other account keep: the file edit's rewind, the task list, plans,
agent memory?

**How run.** Account B's `projects/` was a symlink to account A's. Turn 1 on A (stream-json,
`--session-id` fixed, `CLAUDE_CODE_ENABLE_TASKS=true`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`,
`acceptEdits`): edit `notes.txt` with Edit, create two tasks with TaskCreate, then enter plan mode
and write a plan. Turn 2 on B: `--resume` the same session, TaskList, read the file, plus a
`rewind_files` control request (a dry run, then a real one in a process with no turn).

**Results.**
- **Transcript and conversation (verified).** B resumed the session from the shared `projects/` and
  answered about the file (`line two`).
- **Tasks (verified).** A wrote `tasks/<session>/1.json` and `2.json` in its own dir. B's TaskList
  said "No tasks found", though the resumed conversation showed the two TaskCreate results; B's
  `tasks/` stayed empty.
- **Rewind (verified).** A held `file-history/<session>/<hash>@v1`. The dry-run `rewind_files` on B
  said `canRewind: true` (the snapshot metadata lives in the transcript), but the real one failed:
  "No files were restored: 1 file failed (backup missing…)". The edited file was left unchanged.
- **Plans (not exercised).** Haiku could not use plan mode in `-p` (the turn reported it blocked), so
  `plans/` stayed empty on both. By the same keying (a slug stored in the transcript, a file in the
  account's `plans/`), a plan is **inferred** to be lost the same way.
- **Agent memory (not exercised).** No agent with memory ran. **Inferred** like plans.

**Confidence.** Verified for tasks and rewind; inferred for plans and agent memory.

**Cost.** Two Haiku turns: 0.00587433 and 0.00791322 USD.

**Means for.** This is B11 and B9 confirmed with a real CLI: linking `projects/` alone gives a
resumed session its words but not its task list or its rewind, and a dry-run rewind lies. Keep all
five history items linked (`HISTORY_ITEMS` in `packages/accounts/src/dirs.ts` already does, so T1
covers it); a conformance test could be added to the canary (T5): write a task and a checkpoint on
one account, resume on the other. A rewind check in the UI should use the real result, not the dry
run. T2 and T3 are not affected.

## S7. External `@imports` in CLAUDE.md

**Question.** Is a CLAUDE.md `@import` of a file outside the project followed in `-p`, with and
without `hasClaudeMdExternalIncludesApproved`?

**How run.** A project whose `CLAUDE.md` is `@<scratch>/outside/rule.md`, the imported file saying
"The marker word is PINEAPPLE-7."; `claude -p --model haiku --output-format json`, "Without using
any tools: what marker word do your instructions give you? Answer NONE if you have none." The
CLI's own code reads the key from the **current project's entry** (`projects[<path>]`), so the
variant with the key set that entry in account A's state file with `jq`.

| Variant | Answer |
|---|---|
| no key | NONE (the model saw the project CLAUDE.md and said the import was not read) |
| `projects[<project>].hasClaudeMdExternalIncludesApproved: true` | PINEAPPLE-7 |

**Result (verified).** Without the approval an external import is silently skipped in `-p`; with it
the file is read. It is stored per project, per state file, so account B would skip it until its
own file says so.

**Cost.** Three Haiku turns: 0.00247572 and 0.00182782 USD for the two valid variants, and
0.00225702 USD for a first run started from the wrong directory (no CLAUDE.md in reach, so it
proved nothing and was discarded): 0.00656056 USD in all, one turn over the "at most two" of the task.

**Means for.** One more per-project approval, like trust (plan section 2.3), that a shared-config
account does not inherit. External imports are rare and the CLI documents no flag for it. T2/T3:
list it among the items the reconciler reports as "differs, cannot be supplied", and never write
it into another process's state file. Nothing for T5.

## Cost of every turn

| Spike | Turn | `total_cost_usd` |
|---|---|---|
| S4 | none (control requests only) | 0 |
| S5 | turn 1 on A | 0.00587433 |
| S5 | turn 2 on B | 0.00791322 |
| S7 | first run, wrong directory (discarded) | 0.00225702 |
| S7 | without the key | 0.00247572 |
| S7 | with the key | 0.00182782 |
| S3 | the one turn | 0.00122627 |
| | **Total** | **0.02157438** |

## Related

[[plans/account-configuration-and-project-rules.md]] · [[plans/survive-restarts.md]] ·
[[decisions/parked-cli-processes.md]] · [[accounts.md]] · [[reports/accounts-a0.md]] ·
[[cli-surfaces.md]]
