---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
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
| Background tasks & subagents | `system/task_*` events and `Task` tool calls in the stream |
| Live CLI sessions | `claude agents --json` |
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
| Signing in to Claude | `claude auth login`, relayed through pipes (open the link, paste the code the page shows) in the account's own `CLAUDE_CONFIG_DIR`; on the **default** account that is the CLI's own dir (`POST /accounts/default/login`), so the `claude` in the terminal is signed in too. `get_usage` confirms a credential but cannot refuse one (CLI 2.1.302), and `claude setup-token` is no longer offered ([accounts.md](accounts.md#checking-a-credential), [decisions/claude-sign-in-paste-code.md](decisions/claude-sign-in-paste-code.md)) |
| Real usage of an account | the `get_usage` control request of the stream-json protocol (the sibling of `initialize` and `get_context_usage`): no prompt, no turn, no tokens, in the account's own `CLAUDE_CONFIG_DIR` or token environment. It answers the plan, the session and weekly windows, the weekly limits scoped to one model and the credits ([accounts.md](accounts.md#usage), [decisions/get-usage-control-request.md](decisions/get-usage-control-request.md)) |
| Tool presets and per-chat MCP servers | `--allowedTools` / `--disallowedTools`, and `--mcp-config` with `--strict-mcp-config` over a file holding only the chosen servers |
| Spending and time limits | `--max-budget-usd` for a cost limit; the time limit is Claudio's own clock. The daily spend cap sums the `total_cost_usd` of each `result` message in the stream (the CLI's own figure; Claudio prices nothing from tokens), kept as rows in SQLite, and only holds back work that has not started |
| Instruction evals | one housekeeping chat per sample (`claude -p --input-format stream-json --output-format stream-json`, no API token, no journal) in a detached `git worktree` outside the repository, with `--max-budget-usd` as the per-sample cap. The tool calls are read from the stream and the files from the worktree, and nothing is judged by a model, except a judged expectation behind `evalsPhase2`: a schema-bound judge chat with no tools ([docs/plans/instruction-evals.md](plans/instruction-evals.md)) |
| Path-scoped rules | `.claude/rules/*.md` files with a `paths:` list in their front matter, which the CLI loads as project memory; Claudio writes them when a person approves a `rule` proposal ([docs/team-and-flow.md](team-and-flow.md)) |
| claude.ai connectors | the CLI's `mcp_status` (servers of scope `claudeai`, those pending authorisation included), read from a short-lived process; `claude mcp list` as the fallback |
| Guards on tool calls | `--settings <file>` with only Claudio's own hooks (a content-addressed file under `<data>/guards/`) and `--include-hook-events`, read for the guard's marker lines only ([docs/guards.md](guards.md)) |
| What an agent changed on disk | `git` in the task's worktree, and the `Write`/`Edit` calls in the transcript |
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

## Related

[[providers.md]] · [[accounts.md]] · [[guards.md]] · [[decision-engine.md]] · [[lessons.md]] · [[evals.md]] · [[context-control.md]] · [[plans/claude-only-fork.md]]
