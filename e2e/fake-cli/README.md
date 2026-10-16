# The fake `claude`

An executable named `claude` that speaks just enough of the Claude Code CLI to give the wrapper a
live process: the e2e sandbox has no login and must not spend tokens, and some features (the health
actions: cancel a command, send a hint, interrupt a turn) only exist while a process is working.
It calls no model and no network. Its own test: `node --test e2e/fake-cli/claude.test.mjs`.

## Using it

- **In a spec:** `export const fakeCli = true;`. `e2e/run.mjs` runs those specs after every other
  one, on a server restarted with `e2e/fake-cli` first on `PATH` and `CLAUDE_BIN` set to its
  `claude` (the API puts the login shell's `PATH` first, so `PATH` alone can find the real CLI), the
  sandbox's config directory and `CLAUDIO_HEALTH_INTERVAL_MS=500`. The spec's context gains
  `fakeCli: { bin, log, scripts }`, and `dirs.configDir` is always the sandbox's. `scripts` is the
  path `CLAUDIO_FAKE_CLI_SCRIPTS` names: write it to script a turn whose prompt the spec does not
  type, such as an assistant run's. Specs without the marker keep the real CLI.
- **Elsewhere** (a recorder, a demo instance): put this directory first on `PATH` of the wrapper, or
  set `CLAUDE_BIN` to `e2e/fake-cli/claude`. `scripts/record-media.mjs` (`pnpm media`) does the
  first, and plays its chats and workers from a scripts file.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDIO_FAKE_CLI_LOG` | none | A file the fake appends JSON lines to (see below) |
| `CLAUDIO_FAKE_CLI_HEARTBEAT_MS` | `30000` (the CLI's own pace) | How often a running command sends `tool_progress`; `0` sends none. The sandbox sets `500` |
| `CLAUDIO_FAKE_CLI_ELAPSED_S` | `0` | Seconds added to every heartbeat's `elapsed_time_seconds` |
| `CLAUDIO_FAKE_CLI_TURN_COST_USD` | `0` | Added to `total_cost_usd` per turn (the CLI's total is per process) |
| `CLAUDIO_FAKE_CLI_SCRIPTS` | none | A JSON object `{ "<text>": "<script>" }`: a message containing one of the texts is played as its script instead (see below) |
| `CLAUDIO_FAKE_CLI_VERSION` | `2.1.1-fake` | The version it reports, for a recording that should not say "fake" in its footer |
| `CLAUDIO_FAKE_CLI_AUTH` | none | A JSON object merged into what `auth status` answers (`email`, `subscriptionType`…) |
| `CLAUDIO_FAKE_CLI_TRANSCRIPT` | none | `1` writes a transcript (see below); so does `"@transcript": true` in the scripts file, for a spec, which cannot set the server's environment |
| `CLAUDIO_FAKE_CLI_NO_HOOKS` | none | `1` never runs the `PreToolUse` hook of `--settings`: a guard that is not there, which Claudio's liveness check must notice |
| `CLAUDIO_FAKE_CLI_NO_ARM` | none | `1` never runs the `SessionStart` hook: a guard that cannot arm |

## Subcommands

| Invocation | Output |
| --- | --- |
| `--version`, `-v` | `2.1.1-fake (Claude Code)`, or `CLAUDIO_FAKE_CLI_VERSION` |
| `auth status [--json]` | `{"loggedIn":true,"authMethod":"fake","apiProvider":"firstParty"}` |
| `agents [--json]` | `[]` |
| `mcp list` | `No MCP servers configured. …` |
| `plugin list --json`, `plugin marketplace list --json` | `[]` |
| anything else without `-p` | exit 1, `fake claude: … is not part of the fake` on stderr |

## A chat: `-p --input-format stream-json --output-format stream-json`

Other flags are accepted and ignored, except `--session-id` / `--resume` (the `session_id` of every
event), `--model` (`sonnet` → `claude-sonnet-5`; a full name is kept), `--permission-mode` and
`--worktree <name>`: inside a git repository, as the CLI does, it adds a worktree at
`<repo>/.claude/worktrees/<name>` on a branch `worktree-<name>` (or reuses it) and works there, which
is the `cwd` of its `init`; outside one it says so on stderr and works in place.

**On start:** `{"type":"system","subtype":"init", cwd, model, permissionMode, tools:["Agent","Bash"], mcp_servers:[], claude_code_version, …}`.
No transcript is written to the config directory, unless `CLAUDIO_FAKE_CLI_TRANSCRIPT=1` or the
scripts file has `"@transcript": true` (read when the process starts) and `CLAUDE_CONFIG_DIR` is set:
then it appends to `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl`
what CLI 2.1 writes there: a `user` line per prompt a turn starts with, the `assistant` and
`tool_result` lines with the uuids it streamed, and `queue-operation` lines (`enqueue`, `dequeue`,
`remove` with `reason: "absorbed_mid_turn"`). A result line has the tool's `toolUseResult`. A subagent
writes to its own `<session>/subagents/agent-<agentId>.jsonl` (its prompt, then its sidechain, each
line with `isSidechain: true`, `agentId` and `parentToolUseID`), beside an `agent-<agentId>.meta.json`
(`agentType`, `description`, `toolUseId`, `requestShape: "background"` for a background one); its lines
never go into the session's file. A branch that ends leaves the `<task-notification>` the CLI queues
for the model, as a `queue-operation` `enqueue` line, which is what a reload reads its end from. A message read in the middle of a turn gets an
`attachment` line of type `queued_command` and no `user` line, as the real CLI records it
(docs/reports/chat-audit/repro.md).

**A message's id.** The `uuid` a stdin `user` line carries is the message's: its `user` line in the
transcript has it, and a message read mid-turn carries it as the attachment's `source_uuid` (and the
`remove` line's `commandUuid`). With `--replay-user-messages`, which the wrapper always passes, each
message is read back as `{"type":"user","isReplay":true,"uuid":…}` the moment a turn takes it: when
its turn starts, or right after the tool result it was absorbed at. That is how CLI 2.1.288 behaves
(docs/reports/chat-audit/server.md, "Confirmed on the CLI"). The log's `stdin` event carries the `uuid`.

**A user message** (`{"type":"user","message":{"content": string | blocks}}`) starts a turn when none
is running. When `CLAUDIO_FAKE_CLI_SCRIPTS` has a key the text contains, the script under that key is
read instead, so a page shows the prompt a person would have written (a worker's prompt is its task
inside the orchestrator's own words, hence "contains"). The text is read line by line:

- `run: <command>` — one Bash call per line, in order. Each emits an `assistant` event with a
  `tool_use` block (`name: "Bash"`, `input: { command, description }`), runs `sh -c <command>` as a
  direct child of the fake in its working directory (so the command's processes are a tree under
  the CLI's pid, as the wrapper expects), sends `tool_progress` every heartbeat (`tool_use_id`,
  `tool_name`, `elapsed_time_seconds`), and ends with a `user` event holding the `tool_result`:
  the output (or `Exit code N` / the signal), `is_error` when it did not exit 0.
- `say: <text>` — one assistant text block, in its place among the calls.
- `read: <path>` — one `Read` call (`input: { file_path }`, the path resolved against the working
  directory), held open for `CLAUDIO_FAKE_CLI_READ_MS` (default 400) and answered with the file's
  first 4000 characters, or `(file not found)`. It is what makes a page say "Reading <path>".
- `agent: <description> | <sidechain script>` — one subagent: an `Agent` call (`input: { description,
  subagent_type: "Explore", prompt: "Look around" }`), a `system` `task_started` (`task_type:
  "local_agent"`, `task_id` the agent id, `tool_use_id` the call's, `is_backgrounded: false`), then its
  sidechain: each `;`-separated step (`read: <path>` or `run: <command>`, played as the main ones) is an
  `assistant` call and a `user` result with `parent_tool_use_id` the `Agent` call's id and
  `isSidechain: true`, then a closing text. A `hold: <path>` in the sidechain keeps the call before it
  open until `<path>` exists, so a page reads what the subagent is doing for as long as a spec needs.
  Then the `Agent` call's `tool_result` (`tool_use_result: { agentId, description, prompt,
  resolvedModel, status: "completed", content }`) and a `task_notification` (`status: "completed"`,
  `summary`). With `background: ` as the first word of the description the call answers at once
  (`status: "async_launched"`, `isAsync: true`; `is_backgrounded: true`), and the sidechain and the
  notification follow the next step of the turn, outliving it if they have to. A command in the
  sidechain cannot hold a `;`.
- `background: <command>` — a `Bash` call with `run_in_background: true` (`description: "Run <command>"`),
  answered at once (`tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId }`),
  then a `task_started` (`task_type: "local_bash"`, `is_backgrounded: true`). The command runs for
  real beside the turn, as a child of the fake, and its end is a `task_notification` (`completed`, or
  `failed` when it did not exit 0), whether or not the turn is still running.
- `json: <JSON on one line>` — the turn's `structured_output`, what `--json-schema` makes the CLI
  return beside its text: an assistant run's answer. A turn with a `json:` line and no `say:` ends
  with an empty `result` text.
- `stream: <JSON on one line>` — the same `structured_output`, streamed first as the CLI hands a
  `--json-schema` result over: a `StructuredOutput` tool call whose input arrives as
  `stream_event` / `input_json_delta` events. The first half goes out at once, the rest before the
  next step (so a `hold:` right after it keeps the file half-written).
- `FAKE-LIMIT` (a line of its own) — the account's usage limit: a `rate_limit_event` with status
  `rejected` and `resetsAt` an hour ahead, then a failed `result` with `api_error_status: 429`. It
  fails every time it is sent.
- `FAKE-LIMIT-ACCOUNT` (a line of its own) — the same limit, but only on the account whose
  `CLAUDE_CODE_OAUTH_TOKEN` starts with `fake-limited`; on any other account it is an ordinary prompt.
  It is how a spec sees a chat leave a limited account and replay on another.
- `hold: <path>` — waits until `<path>` (against the working directory) exists before the next step.
- `ask: <command>` — a Bash call the CLI asks permission for: the `tool_use`, then a `can_use_tool`
  control request; the turn waits for the `control_response`. Allowed, the call answers
  `Allowed: <command>` (the command is not run); denied, `Permission denied` with `is_error`. Then the
  turn reads what was said meanwhile, as after a command. An interrupt while it waits withdraws the
  question with a `control_cancel_request` and ends the turn.
- `elapsed: <seconds>` — sets the heartbeat offset for this process from now on: a command then
  reports it has run that long, which is how a spec makes `hung-command` fire at once.
- **What a result records beside it.** Every `tool_result` carries `tool_use_result` in the shape
  the real tool gives (plans/tool-rows-and-live-branches.md §2): a `Read` `{ type: "text", file:
  { filePath, content, numLines, startLine, totalLines } }`, a `Bash` `{ stdout, stderr, interrupted:
  false, isImage, noOutputExpected }`, and a call that failed (or a path not found) the error as a string.
- A turn with `run:` lines and no `say:` line starts with the text `Running N commands.` and ends
  with `All done.`; a turn with a `say:` line has only its own words, and its `result` is the last of
  them. One with neither answers `Heard: <its first line>`. Every turn ends with a `result` event
  (`subtype: "success"`, `is_error: false`, `num_turns: 1`, `total_cost_usd`, `result`).

**`/compact`** — a user message that starts with `/compact` (a button's, with its focus text and the
note instructions, or a typed one) is not a model turn. It plays `replay/compact-manual.jsonl`:
`system/status` `compacting`, `CLAUDIO_FAKE_CLI_COMPACT_MS` later (1500) the status that ends it
(`compact_result: success`), `system/compact_boundary` (`trigger: manual`, `pre_tokens`, the recorded
`post_tokens` 1655), the summary (the recording's, as a `user` line), the
`<local-command-stdout>Compacted </local-command-stdout>` line, and a `result`. With a transcript on,
the session file gets the boundary (camelCase, the same uuid), the summary with `isCompactSummary`, the
command and its output. A text with `FAKE-COMPACT-FAIL` fails as `replay/compact-failed.jsonl`: the
status with `compact_result: failed` and `compact_error`, a new `init`, the synthetic "Compaction
canceled." line, a `result`. `FAKE-COMPACT-SLOW` waits 30 s, for an `interrupt` to cut, which fails the
compaction the same way. A message sent meanwhile is answered after it, like any queued one.

`"@context": <tokens>` in the scripts file (read when the process starts) is what the assistant
lines' `usage.input_tokens` report, which is what the chat's meter reads from the transcript (10 by
default). A compaction brings it down to the recorded `post_tokens`.

**A `review.triage` question** (a prompt with lines `<thread id>: Who should take this review comment…`)
is answered with no script: the structured output marks the first thread `agent` and the others
`person`, so a spec turns the point on and sees the marks in the address dialog.

**An `issue.triage` question** (lines `<key>: Can an agent start on issue <key> …`) is answered the same way: the
structured output marks the issues `ready`, `needs-refining` and `not-for-agents` in the order asked, then
round again, so a spec turns the point on and sees all three marks in the import dialog.

**Hooks (`--settings`)** are run as the CLI does (recorded in `packages/core/test/fixtures/recordings/claude-hooks`):
the first command of `hooks.SessionStart` runs at the process's start, before `init` and before any message,
and the first command of `hooks.PreToolUse` runs for each `run:` step of the main agent, after the call is
announced, with the hook input on stdin (`sh -c`). With `--include-hook-events` each one streams a
`system`/`hook_started` and a `hook_response` (`hook_name`, `hook_event`, `stdout`, `stderr`, `exit_code`,
`outcome`). Only exit 2 blocks: the command never runs and its `tool_result` is an error reading
`PreToolUse:Bash hook error: [<hook command>]: <stderr>` (g0's F5); any other code lets it run. This is how
the real bundled `guard.mjs` runs in `e2e/specs/guard-hooks.spec.mjs`. Subagent steps and the other tools are
not hooked.

**A `lesson.mine` question** (a line `mine: Do these signals show…`) is answered `{"mine": true}` with no
script, so a chat a spec corrected goes on to the miner.

**The lesson miner's prompt** (it starts `You review part of a chat between a person and a coding agent…`) is
answered with the scripts file's `"@lesson-miner"` entry, a `json: {"lessons":[…]}` line a spec writes
with the quote it typed; without the entry the answer is `{"lessons":[]}`. Whatever the miner returns still
goes through the validator, so a scripted lesson must pass it.

**A message that arrives during a turn** is logged at once, and answered at the turn's next step
(300 ms after a command ends) with one assistant text `Heard: <first line>` per message, before
the next `run:` command starts. What is still waiting when the turn ends starts a turn of its own.

**Control requests** (`{"type":"control_request","request_id","request":{subtype}}`) are answered
with a `control_response`:

- `interrupt` — the running command's tree gets SIGTERM, its `tool_result` is
  `The user interrupted this command.` (`is_error: true`), and the turn ends with a `result` of
  `subtype: "error_during_execution"`, `is_error: true`. The process stays up for the next message.
- `set_permission_mode` (also emits `system`/`status` with the mode) and `set_model` — success.
- `get_context_usage` (`detail`: `summary` or `full`, `full` when absent; anything else is the recorded
  error `get_context_usage: detail must be 'summary' or 'full'`) — the answer recorded in
  `packages/core/test/fixtures/recordings/claude/context-usage-<detail>.json`, read from there on
  each request, with 93 MCP tools on two servers (`alpha` 47, `beta` 46, all loaded) so the panel's
  warning shows. After a `/compact` the total is the boundary's `post_tokens`.
- `mcp_status` — `{ mcpServers }`: a local server `docs` (connected, two tools) and a connector
  `claude.ai Calendar` (scope `claudeai`, `needs-auth`), or the list in `CLAUDIO_FAKE_CLI_MCP` (JSON).
- `mcp_toggle` (`serverName`, `enabled`) — success, and the server reads `disabled` (or its old status
  again) in the next `mcp_status`, for this process only; an unknown name is an error.
- anything else — `subtype: "error"`, never silence.

**stdin closing** ends a running turn (its command is killed, a `result` with `is_error: true` is
emitted) and exits 0. SIGTERM, SIGINT and SIGHUP kill the running command's tree and exit 0.

## The log

With `CLAUDIO_FAKE_CLI_LOG` set, one JSON object per line, each with `at`, `pid` (the fake's) and
`event`:

| `event` | Fields |
| --- | --- |
| `started` | `argv`, `cwd` |
| `stdin` | `text` — every user message, as it arrives |
| `turn` | `text`, `commands` |
| `command` | `toolUseId`, `command`, `commandPid` — logged before the `tool_use` is emitted |
| `command-ended` | `toolUseId`, `command`, `code`, `signal`, `interrupted` |
| `command-blocked` | `toolUseId`, `command` — a `run:` step the `PreToolUse` hook refused with exit 2; it never ran |
| `control` | `subtype` |
| `absorbed` | `texts` — messages read inside the running turn, at its next step |
| `asked` | `requestId`, `command` — an `ask:` step's permission request |
| `answered` | `requestId`, `allowed` |
| `agent` | `toolUseId`, `agentId`, `description`, `background` — an `agent:` step's subagent |
| `agent-ended` | `toolUseId`, `agentId` |
| `background` | `toolUseId`, `taskId`, `command`, `commandPid` — a `background:` step's command |
| `background-ended` | `toolUseId`, `taskId`, `code`, `signal` |
| `result` | `error`, `turns` |
| `exit` | — |
