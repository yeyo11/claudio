---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-30T12:00:00Z
tags:
    - guards
    - hooks
    - security
    - orchestration
    - flow
    - claudio
---
# Guards: deterministic PreToolUse hooks for Claude Code runs

Guards are a small set of rules that hold whatever the permission mode is, including
`bypassPermissions`. Prompts are forgotten some of the time; a hook runs on every tool call. They are
**defence in depth against mistakes and prompt pressure, not a sandbox**
([what is not guaranteed](#what-is-not-guaranteed)). The plan is [plans/guards.md](plans/guards.md);
the idea comes from [the ECC report](reports/ecc.md#3-guard-hooks-through---settings), and no ECC
code is used.

## What they block

| Rule | Default | Switchable | Blocks |
| --- | --- | --- | --- |
| `integrity` | on | yes | Anything that would weaken the guard itself: writes to its folder, its settings and rules files, `GIT_EXEC_PATH`, an unknown git verb or alias; and a command line the shell reader cannot parse, nests too deeply or writes to a target it cannot name |
| `no-verify` | on | yes | Skipping git hooks: `--no-verify`, `-n` on commit, `-c core.hooksPath=…`, the variables that disable hooks, and writes to a hook script |
| `push` | on | yes | Any `git push`, in any spelling the shell reader recognises (agents never push; see [security-model.md](security-model.md#agents-never-push)) |
| `destructive` | on | yes | Force push, `git reset --hard`, and recursive deletion outside the worktree. Scratch files go in `$TMPDIR`: each guarded run has its own folder, `<data>/tmp/<id>`, removed when the run ends |
| `secrets` | on | yes | Writing a secret into a file, through `Write`, `Edit`, a shell redirect or here-document, or a content field of an MCP tool |
| `protect-configs` | off | yes | Edits to **existing** lint, format and CI configs, from a list of globs the person can edit |
| `declared-tools` | on every confined API chat, and only there | no | Any tool, Bash subcommand or path the chat did not declare ([below](#declared-tools-the-confined-api-chat)) |

**With no rule on there is no guard** (D6 of [the regression fixes](plans/regression-fixes-2026-10-29.md)):
no rules file, no settings file, no hook. `integrity` is a rule like the others: before 0.12 it was
armed whenever the guard ran, so switching every rule off still blocked lines the shell reader could
not parse.

A command is read by a shell reader (`packages/core/src/guards/shell.ts`) that follows wrappers,
`cd`, `env`, `sudo`, `xargs`, `bash -c` and the like. While `integrity` is on, a line it cannot read
is blocked and the reason asks for a script file; with `integrity` off, the other rules judge what
they can read of it. Every call the rules do not look at passes with exit 0 and no
decision, so the CLI's normal permission flow still decides.

## Where they run

- **On by default:** orchestration workers (launch and resume), the integration, the synthesis, the
  verification fixer, the checks fix, the workflow engine, and flow runs.
- **Opt in per project:** a person's interactive chats, with the project setting *Guards in this
  project's chats*.
- **Always, with `integrity` and `declared-tools` only:** every confined API chat (every chat of a
  headless Claudio, every chat in a workspace in any profile), whatever the settings say
  ([security-model.md](security-model.md#the-confined-api-chat)).
- **Never:** the planner, the Supervisor and other internal runs, the other confined runs (the
  lesson miner, for one), a run whose policy can neither run commands nor write files, and the Claudio
  assistant: its chat and its runs pass `null` outright, so a project that opted its chats in does not
  reach them (`guardsForChat` takes the run's `policy` and whether it is `confined`).

A graph or a flow stage can switch guards off or switch rules off for its own runs
(`guards: { enabled?, rules? }`), `integrity` included. A chat's own token cannot
weaken any of these (it gets `403`; see [security-model.md](security-model.md#guards)). The launch form warns that workers
will run without the guards you switch off.

## How it works

1. At launch Claudio resolves the rules for the run, checks that the guard can run (preflight), and
   writes two files under `<data>/guards/`, named by content hash, mode 0600 in a 0700 folder: a
   settings file holding only Claudio's own hooks, and a rules file.
2. It starts `claude` with `--settings <file> --include-hook-events`. On every `PreToolUse` the CLI
   runs `claudio-guard` (`guard.mjs`, bundled beside the server like `mcp.mjs`), which reads the
   hook's JSON on stdin, checks the rules file's SHA-256 against the hash in its own arguments, and
   answers **exit 0** (pass, no decision) or **exit 2** with the reason on stderr (block).
3. Every answer carries a `claudio-guard/1` marker that Claudio reads back from the stream's
   `hook_response` events. A `SessionStart` marker proves the guard is armed; a tool call with no
   marker means the guard did not run, and the run is stopped (liveness).
4. A block is a row in `guard_events`, a line in the transcript, and a signal in the run's health.

**Every process derives its plan again.** A chat's later processes (a respawn after a limit wait or an
account move, a message queued while the process ended, a message to a chat whose process is gone)
are not handed a plan by anyone, so `ChatManager.spawnProcess` asks Core for one
(`guardPlanner`, `Core.guardsAtSpawn`): from the request the chat's last plan was derived from
(`ChatGuardPlan.request`), with the global settings and the project's settings as they are now, or,
for a person's chat that ran unguarded, from its project's opt-in. A switch turned off reaches the
next process of a running chat, not only new chats. A plan a caller hands over (a start, a resume, the
orchestrator's launches) stands for that spawn.

**The folder is swept.** `startGuardSweep` runs from the `Core` constructor (subsystem `guardSweep`,
both profiles) and every 6 hours, and stops in `shutdown()`: a rules or settings file older than a
week that no chat's plan names is removed.

**An interrupt excuses only its own calls.** The CLI answers the calls an interrupt cuts short with
results of its own, which carry no marker. The stream's guard watcher excuses the calls that were
awaiting a marker when the interrupt was asked for, or that streamed before the CLI answered it, and
no other: an interrupt that ended no turn leaves nothing behind that could hide a real
`guard-missing` later (report §1.7).

The guard fails closed: bad input, oversized input, a tampered or missing rules file, an exception
and the deadline (3 s) all block. The launch fails when the guard cannot be armed.

## `declared-tools`: the confined API chat

A confined API chat runs with a tool policy fixed at its creation (`allowedTools`, a list of Claude
Code permission rules; [workspaces.md](workspaces.md), [D14 of the headless
plan](plans/headless-image.md)). The CLI is confined first (`--restricted`, `--tools=` the declared
tools, no settings sources), but under `dontAsk` Claude Code still runs its built-in read-only
commands (`cat`, `head`, `find`, `grep`…) whatever the rules say, and lets them read outside the
working directory ([permissions](https://code.claude.com/docs/en/permissions)). `declared-tools`
(`packages/core/src/guards/rules/declared-tools.ts`) closes that gap. A call passes only when:

- **its tool is declared.** `StructuredOutput` and the `/v1` client-tool stub's `mcp__client__*`
  tools always pass; WebFetch, WebSearch, Task, any other `mcp__*` and the rest are blocked unless
  declared;
- **every Bash subcommand matches a declared `Bash(...)` rule**, with Claude Code's own wildcard
  matching (a trailing ` *` or `:*` also matches the bare command). The shell reader follows pipes,
  `&&`, `||`, `;`, wrappers, `bash -c`, `env -S` and `watch`. The wrappers Claude Code strips itself
  (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`) need no rule; `cd`,
  `pushd` and `popd` need none either, since they read nothing, but their target is checked as a path;
- **every path it names resolves inside the working directory or one of the chat's own attachment
  files**, after `~`, `..` and symlinks. Option values count (`grep -f FILE`, `--file=FILE`,
  `find -newer FILE`, `git -C DIR`, `--output=FILE`), and a glob is checked through its expansions.
  The file tools (`Read`, `Grep`, `Glob` and the others) are confined the same way, an absolute or
  `..` Glob pattern included.

Whatever the declared rules say, these are blocked, since what they read or run cannot be known in
advance:

- a variable (`$X`, `${X}`), a command substitution or a process substitution anywhere in the line;
- a leading variable assignment, except `LANG`, `LC_*`, `TZ`, `NO_COLOR`, `TERM` and `COLUMNS`;
- a here-document, `xargs`, and output redirection to anything but `/dev/null`;
- `sed` except `-n` with a script of addresses and `p` (no `w`, `W`, `r`, `R`, `e`, no `-i`, `-f`,
  `--in-place`);
- `find` with `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf`,
  `-fls`, `-files0-from`, `-follow` or `-L`;
- `git -c`, `--config-env` and `--exec-path`, and `rg --pre` and `--pre-glob`;
- an interpreter or a script (`awk`, `python`, `node`…), even when declared: the guard cannot read
  the code it would run.

A line the shell reader cannot parse is blocked by `integrity`, as on every guarded run.

**It cannot be switched off.** The policy itself arms the rule: no setting, override or rule list
drops it, it is not a switchable rule (the settings API refuses its name), it always enforces
(observe mode and "Allow once" do not apply), and a tampered rules file blocks every call. A bare
`Bash`, `Bash()`, `Bash(*)` or `Bash(:*)` is refused when the chat is created (`400`), since it would
declare every command.

**A block** is a `guard_events` row and a transcript line naming the subcommand or path and what was
missing. On `/v1`, a turn that ends without its answer after a block is `422 tool_blocked`, naming
the last one ([openai-compatible-api.md](openai-compatible-api.md)). The fix is a declared rule; a
command that needs a variable or a substitution has to be written another way.

**Its corpus** is `DECLARED_CORPUS` in `packages/core/test/guards-corpus.ts`: the plan's cases
(shipcast's transcript commands with and without their rules, reads of credentials, `/proc`, `/data`
and `..`, `$HOME`, substitutions, WebFetch and `mcp__*`, trading-bot's request) and about 60 more.
Under rules such as `Read`, `Grep`, `Glob`, `Bash(ls *)`, `Bash(cat *)`, `Bash(head *)`,
`Bash(sed -n *)` and `Bash(grep *)`, `grep -n x f | head -40`, `ls && cat package.json` and
`sed -n '1,20p' README.md` pass; `sed -n '1w /tmp/x' f`, `find . -exec cat {} +`, `cat f > out`,
`ls | xargs cat` and `grep -f /data/auth.json x` are blocked. A pipeline that lists tracked files
and filters them needs a rule for each part: `Bash(git ls-files *)` as well as `Bash(grep *)` and
`Bash(head *)`.

## Settings

**Settings → Access & safety → Guards** (`#guards`), or `GET`/`PUT /settings/guards`, stored in `guards.json`
in the data directory:

- **Automated runs:** a switch for workers and the flow.
- **Rules:** one switch per rule, `integrity` first. The card's tag says "Active" (or "observe")
  only while a rule is on; with none it says "off" and that no run is guarded.
- **Mode:** `enforce`, or `observe`, which records "would block" rows and passes, for rolling back
  after a false positive.
- **Protected files:** the globs `protect-configs` uses, with *Restore defaults*.
- **Extra roots:** more folders where recursive deletes are allowed.
- **Try a command:** runs the decision engine on a tool call and shows the verdict; nothing runs or is
  recorded (`POST /guards/check`).
- **Recent blocks:** the last events, each linking to its chat.

A change applies to the **next process Claudio spawns**, a running chat's next process included; a
running CLI keeps the hooks it started with. The card says so. If `guards.json` is corrupt, the defaults (on) apply and writes are refused.

## Where they show

- **Transcript:** a "Guard blocked" line with the rule and the reason.
- **Chat header:** a tag: neutral "Guards" when armed, warn "Observe", bad "Guards not running".
- **Task cards and flow run rows:** an "N blocked" chip that opens the chat at the first notice.
- **Health:** the signals `guard-blocked` and `guard-missing`.
- **Launch form, relaunch panel, flow settings and project settings:** the per-graph, per-stage and
  per-project switches.

## What is not guaranteed

Guards are **not a sandbox**. An agent that can run arbitrary code can, with enough effort, do what
they block: a compiled or opaque program, a Makefile, a script fetched from the network, a secret
encoded or assembled at runtime, the person's shell aliases, a repository whose own hooks lie.

What they do guarantee is narrower: every documented form in the plan's bypass corpus is blocked,
every block is visible, and the guard cannot be switched off from inside the run without the run
being stopped. Real isolation is the container, the user account and the worktree.

## Troubleshooting

When a guard cannot run, a run fails before any CLI starts, with `guard-unavailable (<problem>)` (a
flow run ends `failed`, cause `not-started`), and Settings shows the same problem. While the first
self-test is still running (no pass and no failure yet), an orchestration task is not failed: it
stays pending and the scheduler tries again every 3 s (`GuardSelfTestPending` in
`packages/core/src/guards/preflight.ts`, handled by `Orchestrator.refuse()`).

| Problem | Meaning | What to do |
| --- | --- | --- |
| `entry-missing` | `guard.mjs` is not beside the server and `CLAUDIO_GUARD_ENTRY` does not point at one | Reinstall, or set `CLAUDIO_GUARD_ENTRY` to a file |
| `entry-untrusted` | The entry is under a project, a root or a plugin cache, or is group- or world-writable | Use the bundled file; in Docker it is root-owned 0444 |
| `self-test-failed` | The guard did not block the self-test call on this machine | Check the Node build and the data folder's permissions |
| `cli-unsupported` | The installed CLI lacks `--settings` or `--include-hook-events` | Update Claude Code |
| `hooks-disabled` | A user, project or local settings file sets `disableAllHooks: true` (the message names it) | Remove the setting, or switch guards off for that run |
| `managed-hooks-only` | An organisation policy sets `allowManagedHooksOnly` | Guards cannot run under that policy |
| `hooks-conflict` | One of the person's own hooks answers `allow` in a way that would override a block | Change that hook |
| `bad-path` | A guard path or root cannot be resolved | Fix the root in Settings |

A run that stalls with every call blocked and health "bad" usually means the rules file changed
under the guard (`rules-unavailable`); relaunch it.

## Related

[[plans/guards.md]] · [[reports/ecc.md]] · [[security-model.md]] · [[orchestrations.md]] · [[team-and-flow.md]] · [[chat-environment.md]] · [[deploy.md]] · [[desktop.md]] · [[design-system.md]] · [[workspaces.md]] · [[decisions/confined-api-chat.md]] · [[plans/headless-image.md]] · [[status.md]]
