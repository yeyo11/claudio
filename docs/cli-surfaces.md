---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-11-21T00:00:00Z
tags:
    - cli
    - one-rule
    - providers
    - reference
---
# How Claudio talks to Claude Code

Every surface of the Claude Code CLI that Claudio uses, one row per need. This is the table the one
rule ([CONTRIBUTING.md](../CONTRIBUTING.md#the-one-rule)) is checked against: a design that needs
something not expressible as a row here does not belong in Claudio yet. What a provider is in general
is in [providers.md](providers.md). Until 2026-10-17 this table was the README's "How it talks to
Claude".

The wrapper drives Claude Code through its CLI, the interface Anthropic ships for programs — no terminal scraping, no undocumented endpoints:

| Need | CLI surface used |
| --- | --- |
| Detect installation | `claude --version` |
| Auth status | `claude auth status --json` |
| Run / continue a conversation | `claude -p --input-format stream-json --output-format stream-json` (one long-lived process per run, multi-turn over stdin; `--resume` when the process is gone) |
| Keep a CLI running while the server restarts (on under the desktop daemon, off elsewhere unless `CLAUDIO_PARKED_PROCESSES`) | The same `-p --input-format stream-json` process, with its stdin a FIFO and its stdout an append-only file instead of pipes ([plans/survive-restarts.md](plans/survive-restarts.md), layer 2): the protocol does not care what carries its bytes, and the Agent SDK's `spawnClaudeCodeProcess` exists to run the CLI "in VMs, containers, or remote environments". When nobody has held the process's lease for the hand-over window and a turn is open, the wrapper sends **SIGINT**, which the [headless](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm) page documents as the way "to end the turn instead" of SIGTERM; never to an idle process, which SIGINT ends (spike S2). A restarted server re-attaches by re-sending `initialize` "after a transport gap" and reading `response.pending_permission_requests` (t4, spike S3 on a real CLI). D10: the vendor's `--bg` supervisor cannot be combined with `-p` and its job files are "not a stable interface"; re-read [agent view](https://code.claude.com/docs/en/agent-view) at each minor version |
| Continue a turn a restart cut | `--resume <id>` with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS` (an hour plus five minutes) and `CLAUDE_CODE_RESUME_PROMPT` (Claudio's `RESTART_CONTINUE_TEXT`), and nothing written to stdin: the CLI continues the turn the previous process did not finish, or starts idle when the transcript's last message is older than the bound. Documented in [env-vars](https://code.claude.com/docs/en/env-vars) ("Used in SDK mode so the model continues without requiring the SDK to re-send the prompt"; the bound needs CLI 2.1.211 or later), read 2026-11-15 against CLI 2.1.322. Set only for that process (`resumeEnv` in `providers/claude-code/args.ts`), and stripped from every other one so an inherited value never replays a turn beside a new prompt ([plans/survive-restarts.md](plans/survive-restarts.md), layer 3) |
| Background tasks & subagents | `system/task_*` events and `Task` tool calls in the stream |
| Live CLI sessions | on Linux, the record each CLI process writes for itself (`$CLAUDE_CONFIG_DIR/sessions/<pid>.json`), kept while `/proc/<pid>/stat` shows the start time it recorded (`procStart`) in the same pid namespace (`pidDomain`): what `claude agents --json` itself reads; elsewhere, or with a CLI that writes no such records, `claude agents --json` ([transcript-listing.md](transcript-listing.md)) |
| Session history & projects | transcripts in `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl` |
| MCP servers | `claude mcp add-json` / `claude mcp remove` (user scope) |
| Context breakdown | the `get_context_usage` control request (`detail: summary` unless asked) |
| Compaction | `/compact` sent as a user turn over stream-json; the `system/status` (`compacting`) and `system/compact_boundary` events; the boundary and `isCompactSummary` lines of the transcript |
| Orchestration planner | `--json-schema` structured output |
| Review gate | `--json-schema` findings under `--restricted --tools=Read,Grep,Glob`, `--max-budget-usd`, `--max-turns`, `--agents` and `--agent` for the role |
| Decision engine, `cli` provider | one housekeeping chat per batch of typed questions: `--json-schema` for the answers, `--effort`, `--max-budget-usd`, and no tools, settings or API token in it ([docs/decision-engine.md](decision-engine.md)) |
| Lessons from corrections | one confined one-shot chat per mined stretch: `--json-schema`, `--max-budget-usd`, `--restricted --tools= --setting-sources=`, `--no-session-persistence`, and no API token in it ([docs/lessons.md](lessons.md)) |
| Usage limit | `rate_limit_event` messages in the stream (the window, its use and when it resets), and a 429 result when a turn dies on it |
| Several accounts | one `CLAUDE_CONFIG_DIR` per account, with `claude auth login` and `claude auth status --json` run in it; `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the environment of a token or key account. Usage per account from `get_usage` (below), the `rate_limit_event` of the stream, and the CLI's own `cachedUsageUtilization` for an account that has not run yet ([accounts.md](accounts.md)) |
| Signing in to Claude | `claude auth login`, relayed through pipes (open the link, paste the code the page shows) in the account's own `CLAUDE_CONFIG_DIR`; on the **default** account that is the CLI's own dir (`POST /accounts/default/login`), so the `claude` in the terminal is signed in too. `get_usage` confirms a login or token but cannot refuse one (CLI 2.1.302); an API key is checked with the SDK's free `models.list`; and `claude setup-token` is no longer offered ([accounts.md](accounts.md#checking-a-credential), [decisions/claude-sign-in-paste-code.md](decisions/claude-sign-in-paste-code.md)) |
| Real usage of an account | the `get_usage` control request of the stream-json protocol (the sibling of `initialize` and `get_context_usage`): no prompt, no turn, no tokens, in the account's own `CLAUDE_CONFIG_DIR` or token environment. It answers the plan, the session and weekly windows, the weekly limits scoped to one model and the credits ([accounts.md](accounts.md#usage), [decisions/get-usage-control-request.md](decisions/get-usage-control-request.md)) |
| Tool presets and per-chat MCP servers | `--allowedTools` / `--disallowedTools`, and `--mcp-config` with `--strict-mcp-config` over a file holding only the chosen servers |
| Spending and time limits | `--max-budget-usd` for a cost limit; the time limit is Claudio's own clock. The daily spend cap sums what each `result` message in the stream adds to its session's `total_cost_usd` (the CLI's own figure, cumulative over the session: see [below](#how-a-resumed-or-forked-session-is-billed); Claudio prices nothing from tokens), kept as rows in SQLite, and only holds back work that has not started |
| Instruction evals | one housekeeping chat per sample (`claude -p --input-format stream-json --output-format stream-json`, no API token, no journal) in a detached `git worktree` outside the repository, with `--max-budget-usd` as the per-sample cap. The tool calls are read from the stream and the files from the worktree, and nothing is judged by a model, except a judged expectation behind `evalsPhase2`: a schema-bound judge chat with no tools ([docs/plans/instruction-evals.md](plans/instruction-evals.md)) |
| Path-scoped rules | `.claude/rules/*.md` files with a `paths:` list in their front matter, which the CLI loads as project memory; Claudio writes them when a person approves a `rule` proposal ([docs/team-and-flow.md](team-and-flow.md)) |
| Model list | the `models[]` of the `initialize` control response, the only source: no prompt, no turn, no tokens, in each account's own `CLAUDE_CONFIG_DIR` or token environment. Read in the background at boot for every enabled, signed-in account, and again when the cached entry's CLI version differs from the running one. Until it arrives the list is empty, and Claudio invents no entries ([accounts.md](accounts.md#models), [plans/owner-report-fixes.md](plans/owner-report-fixes.md)) |
| The shell's working directory notice | the `Shell cwd was reset to <dir>` line the CLI appends to a Bash call's `stderr` (the `tool_use_result` of the stream; `is_error` stays false). Claudio lifts it out of stderr into the call's `cwdReset` and draws it as a note; if the CLI rewords it, nothing matches and stderr shows as it is |
| Claudio's own MCP server in a live chat | the `mcp_set_servers` control request with the `claudio` server (replaces the set of servers pushed at run time; `{ added, removed, errors }` by name), then `apply_flag_settings` with `permissions.allow` set to the server's reads (the session's flag layer; a second request replaces the list, `--allowedTools` is left alone; recorded on 2.1.312 in `apply-flag-settings.json`), and `--mcp-config` with the reads in `--allowedTools` for the chat's next processes ([claudio-mcp-server.md](claudio-mcp-server.md#on-demand-in-any-chat)) |
| claude.ai connectors | the CLI's `mcp_status` (servers of scope `claudeai`, those pending authorisation included), read from a short-lived process; `claude mcp list` as the fallback |
| A shared account's configuration | the default account's files, linked into the account's `CLAUDE_CONFIG_DIR`; and, at spawn, `--mcp-config=<file>` (never `--strict-mcp-config`) with the servers the default's state file and the project's `.mcp.json` give, and the `.mcp.json` approval keys (`enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers`, documented settings) in the one `--settings` file. Read from the state file the CLI writes, whose keys are **not documented** ([below](#the-state-file-keys-the-overlay-reads), [accounts.md](accounts.md#an-account)) |
| Plugins of a shared account | `claude plugin marketplace add <source>`, `marketplace update <name>`, `plugin install <id> --scope user`, `plugin update <id> --scope user` and `plugin uninstall <id> --scope user`, each run with the account's own `CLAUDE_CONFIG_DIR`, closed stdin, a timeout and no credential in the environment, to bring the account's `plugins/` to the default's. The default's state is only read: `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` and `settings.json` (`enabledPlugins`, `extraKnownMarketplaces`). Interface checked on 2.1.322 (`claude plugin --help` and each subcommand's), and run end to end in a scratch config dir. Claudio never passes `-y` (it would accept a marketplace-declared install command for a person) and never edits an install record ([accounts.md](accounts.md#plugins-of-a-shared-account)) |
| MCP sign-ins of a shared account | the default account's `.credentials.json` `mcpOAuth` is read, and the same key is written into each shared account's file (the value only, in the file's text, through a 0600 temp file and a rename; `claudeAiOauth` untouched), plus the lines of the account's `mcp-needs-auth-cache.json`. The keys are **not documented**: the entry key is `name\|sha256({type,url,headers})[:16]`, as CLI 2.1.325 writes it (spike S6). Guarded by the canary check `s6` (a local bearer-only server accepts the copied entry), which stops the copies when it fails. Claudio makes no OAuth request: it copies entries the CLI wrote, and never one whose refresh token rotates ([accounts.md](accounts.md#sign-ins-of-a-shared-account)) |
| Guards on tool calls | `--settings <file>` with only Claudio's own hooks (a content-addressed file under `<data>/guards/`) and `--include-hook-events`, read for the guard's marker lines only ([docs/guards.md](guards.md)) |
| What an agent changed on disk | `git` in the task's worktree, and the `Write`/`Edit` calls in the transcript |
| Where a chat ran, in which worktree | The `worktree-state` record the CLI writes into a transcript when it runs in a worktree it created (`--worktree`): `originalCwd`, `worktreePath`, `worktreeName`, `worktreeBranch`. `originalCwd` is where the person started, often a sibling or nested worktree, so it only names a repository through its own placement; the CLI's `<main checkout>/.claude/worktrees/<name>` layout is the fallback for a removed worktree. The rest is git's: `git rev-parse`, `git worktree list --porcelain`, `git config --file … remote.origin.url`, and the files `gitrepository-layout(5)` documents ([projects.md](projects.md#where-a-directory-belongs)) |
| Stopping one command | The process tree under the CLI's own pid; the CLI writes the failed tool result itself |

Two things Claudio reads about Claude Code are not the CLI, and both are the vendor's documented
package on the npm registry. The first is the metadata of `@anthropic-ai/claude-code`, to tell you
when a newer version exists: a plain metadata read (no Anthropic API), done on demand and once a day,
and `CLAUDIO_CLI_UPDATE_CHECK=off` stops the daily one. The second, in a container only, is the
install of a newer CLI from the app: the native platform package
`@anthropic-ai/claude-code-linux-x64`, downloaded from the registry (or `CLAUDIO_CLI_REGISTRY_URL`),
checked against its `dist.integrity` (SHA-512), with only `package/claude` extracted and no lifecycle
script run, then confirmed by `claude --version`. It lands in `/data/cli/<version>/` and
`/data/cli/current` is switched with a rename ([updates.md](updates.md#claude-code)). It is the same
binary the image's installer puts in `~/.local`, from the package the vendor publishes for programs.
Claudio asks GitHub the same way about its own releases (`CLAUDIO_UPDATE_CHECK=off` stops that one).

## The state file keys the overlay reads

The overlay of a shared account ([accounts.md](accounts.md#an-account)) reads the default account's
state file (`~/.claude.json`, or `.claude.json` in a `CLAUDE_CONFIG_DIR` other than `~/.claude`). It
is a file the CLI writes, so reading it is within the one rule, but **none of these keys is
documented**: they are what CLI 2.1.322 writes, and a release may rename them.

| Key | Used for |
| --- | --- |
| `mcpServers` | the user-scope servers |
| `projects[<key>]` | the project's entry; `<key>` is the main checkout of the working folder's repository (a linked worktree's too), else the folder (spike S3d) |
| `projects[<key>].hasTrustDialogAccepted` | whether the project's `.mcp.json` servers ride along |
| `projects[<key>].mcpServers` | the local-scope servers |
| `projects[<key>].disabledMcpServers` | servers of any scope turned off with `/mcp` for the project |
| `projects[<key>].enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers` | `.mcp.json` approvals, passed on as the settings keys of the same names |
| `projects[<key>].hasClaudeMdExternalIncludesApproved` | read only to log that no flag carries it (S7) |

Nothing else of the file is read, identity included, and Claudio never writes it. A key whose shape
changed gives no overlay and one log line, and `packages/accounts/test/overlay.test.ts` pins the
shapes. The canary ([accounts.md](accounts.md#the-cli-canary)) re-runs the trust check (S3c) per CLI
version, not these key names.

## How a resumed or forked session is billed

The CLI's `total_cost_usd` and `modelUsage` on a `result` are cumulative over the **session**, not
over the process. `--resume` restores them from the transcript, so the first result after a resume
reports the session's earlier turns again, and `--resume --fork-session` starts the copy from its
parent's totals under the new session id (observed on Claude Code 2.1.322; the plan's spike S1 is in
[plans/decision-engine-v2.md](plans/decision-engine-v2.md#m1-cost-on-a-resumed-session)).

So Claudio bills a turn the growth since the session's last report, whichever process made it:

- The last report is kept on the chat's record (`reported`), so it survives a spawn and a restart of
  Claudio. A spawn that resumes a session goes on from it, a fork starts from its source's, and only a
  session that starts new starts from zero. A total that comes back lower than the last report is
  treated as a session that started again and counts whole.
- An execution's `costUsd` is what its own turns cost, so a chat's executions add up to the
  session's total; per-model costs and tokens (`modelUsage`) follow the same growth. The spend
  ledger, the graph's and the task's cost and the Usage figures read that growth.
- A session that was born outside Claudio (a chat started from a terminal and then resumed here) has
  no recorded last report, so the first turn Claudio bills carries the session's earlier history:
  the CLI writes a `cost-state` line into the transcript that Claudio does not read yet.

**What the fix did to stored figures.** Before 2026-11-13 Claudio took the total to restart with every
process and billed each resumed execution the session's history again, so costs recorded before the
fix are **overstated for resumed sessions** (63 multi-execution tasks of one install summed 1,473 USD
where their last execution reported 476). A migration recomputed the stored executions of every chat
whose executions' costs only grow, oldest first, the mark the old billing left: each is now billed its
own turns, and the chat's record got the totals it last reported. A chat whose costs ever go down is
left as it is. The **spend ledger is left alone**: its rows are what the daily cap decided with at
the time. The `cost_corrections` table has one row with the date the migration ran and how many chats
and executions it mended, so a reader can tell which figures are from before.

## Related

[[providers.md]] · [[accounts.md]] · [[guards.md]] · [[decision-engine.md]] · [[lessons.md]] · [[evals.md]] · [[context-control.md]] · [[plans/claude-only-fork.md]] · [[transcript-listing.md]]
