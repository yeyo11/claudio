# g0 recording: the CLI's hook contract (task g0 of docs/plans/guards.md, facts F1-F21)

Recorded 2026-10-16 with **Claude Code 2.1.300** (the installed CLI) and **2.1.278** (the Docker pin,
`npm i @anthropic-ai/claude-code@2.1.278`, platform binary). `--model haiku`, token account in a
scratch `CLAUDE_CONFIG_DIR` and scratch `HOME`, one throwaway repo plus a local bare remote under
`/tmp` per run (nothing was pushed anywhere; no remote but the bare one exists). **Spend: about 3.7 US$**,
of which about 0.6 is one run that pushed a 200 KB hook stderr into the model (`a-bigblock`).

## Facts that change this plan

Each line names the D or section it confirms (✔) or breaks (✘). A ✘ stops the graph until the architect updates the plan.

- ✘ **D2 / O4 (fail closed): every failure of the hook except exit 2 lets the tool run.** Exit 1, exit 3, a
  signal (SIGKILL → 137, SIGTERM → 143), an interpreter crash, a missing interpreter (127), a missing script
  (1), a timeout (`outcome: "cancelled"`) and **malformed or plain stdout on exit 0** are all `outcome: "error"`
  or `"cancelled"` with the tool result *not* an error. The guard must catch everything itself and exit 2 on
  any internal error; only D6 (liveness) covers a guard that never ran.
- ✘ **D4: `disableAllHooks: false` in the `--settings` file is mandatory, not conditional.** `disableAllHooks: true`
  in user, project or local settings, or in the `--settings` file itself, turns off *every* hook, including the
  `--settings` ones. A `false` in the `--settings` file wins over a `true` in user, project or local settings, also
  when the `true` is written **during** the session (F13). Both versions.
- ✘ **D8 (integrity): `.claude/settings.json`, `.claude/settings.local.json` and the user settings are re-read
  during a session** (hooks added or `disableAllHooks` set mid-session take effect after about a second). The
  `--settings` file is not (read once at start). The integrity rule must therefore block writes to the project and
  local settings files too, and the `false` above stays as the backstop.
- ✔ **D6 (arming) works, and better than assumed.** `SessionStart` runs at process start (about 0.7 s) *before any
  stdin message*, its `hook_started`/`hook_response` come before `system/init`, and `system/init` is only
  emitted after the first user message. Claudio can hold the first message until the `SessionStart`
  `hook_response` (`hook_name: "SessionStart:startup"`, `":resume"` on resume). A failing or timed-out
  `SessionStart` hook does **not** stop the session. Without `--include-hook-events` the `SessionStart` events are
  still emitted, the `PreToolUse` ones are not (F2): the per-call liveness check needs the flag.
- ✔ **D2 route choice.** Exit 2 blocks in every permission mode and with both `--permission-prompts` targets; a JSON
  `permissionDecision: "allow"` skips `can_use_tool` and approves by itself (so a guard must never print it); a pass
  is exit 0 with empty stdout. Exit-0 **stderr** is not shown to the model but is in `hook_response.stderr`: a
  usable liveness marker that leaves the permission flow alone.
- ✔ **Resolved question 2 does not trigger.** Subagent (`Agent`, `Task` is listed in `init.tools` but the tool call
  is named `Agent`) and Workflow-agent tool calls **are hooked**, with `agent_id` and `agent_type` in the stdin.
  No need to disallow them.
- ✘ **D3 / g3 block text: a block shows the model the full hook command line.** On exit 2 the `tool_result` is
  `PreToolUse:<Tool> hook error: [<command as written in settings>]: <stderr, whole>`. The guard's path and argv
  (rules file path and hash) are in the model's context, and stderr is never cut (200 KB went through intact and
  cost real money). Keep the reason short, and do not put anything in the argv that the agent must not see.
- ✔ **D5 (matcher `"*"`)**: `"*"`, `""` and an absent matcher match every tool, including `mcp__*`, `ToolSearch`,
  `Read`, `Skill`, `Workflow`. **Latency (F20)**: node p50 33-36 ms, Electron-as-node p50 60-66 ms per call: no
  need for the fallback matcher.
- ✘ **E3/f project hooks: project settings load from the session's cwd only.** With the session started in
  `sub/deeper` the `.claude/settings.json` at the git root did not load. Project hooks run in `-p` with no trust
  prompt (F14), so the "folder is not trusted" text of multi-provider.md was not reproduced.
- ✔ **D11/D1 `--worktree`**: with `--worktree <name>` the hook's stdin `cwd` is `<repo>/.claude/worktrees/<name>`,
  also when the session started in a subfolder.
- ✔ **F21 / E10**: 2.1.278 has `--settings` and `--include-hook-events`. **No change to `docker/Dockerfile:101`.**
  2.1.278 has no `--safe-mode` (only `--bare`). On 2.1.278 `--permission-mode auto` degrades to `default`
  (`init.permissionMode`).
- ✘ **F12 managed settings: not recorded.** `managed-settings.json` lives in `/etc/claude-code` (root).
  `CLAUDE_CODE_MANAGED_SETTINGS_PATH=<dir>` was set to a directory holding `managed-settings.json` and its hooks never
  ran (not loaded in a `-p` run), so `disableAllHooks` / `allowManagedHooksOnly` in managed settings stay
  unverified. D6 is the backstop: a guard that does not run is detected and the run stops.
- ✔ **F17**: aliases and exports from the person's shell rc are in the Bash tool (snapshot), so an alias can rewrite
  a command the hook saw; `export` does not persist between calls; `cd` does (inside the project), and the stdin
  `cwd` follows it.

## How it was recorded

`argv.json`, `stdout.jsonl`, `stderr.txt`, `exit.json`, `timeline.jsonl` (the millisecond each stream line was seen,
`in`/`out`, and its type), `probe.jsonl` (what each probe hook saw: stdin JSON, cwd, env key names, parent
command line) and, where the CLI's own session file matters (F5), `transcript-*.jsonl` reduced to its `user` and
`assistant` lines, per run folder `<version>/<scenario>/`. Probe hooks are `node hook.mjs <log> <label> <mode>`
scripts written outside the repository; they are not the guard. Probe hook modes are named in the scenario
(`cli` is a hook, `u/p/l/s` are the user, project, local and `--settings` sources).

Redactions: paths are `/tmp/g0/<scenario>/…`, the node binary `/usr/bin/node`, the CLI `/opt/claude/<ver>/claude`,
home `/home/user`; runs of 40 or more `x` (the 200 KB filler of `a-big`/`a-bigblock`) are `<N x>`. The rest went
through `packages/core/scripts/redact-recordings.mjs`. The two `l-big-*` runs keep only `timeline.jsonl`. Only
`a-block`, `a-err`, `a-jsondeny`, `a-stderrpass`, `a-bigblock`, `a-write-block` and `d-agent-block` keep a transcript.
Argv also shows the scratch `--settings` path under `/tmp/g0/<scenario>/settings.json`, which is not kept.
Rerun with the probe prompt `Use the Bash tool exactly once, with exactly this command and nothing else, then reply
with the single word DONE: echo mode-<name>`; the probe picks its behaviour from `mode-<name>` in the command.

## F1-F21

Folder names are scenarios; both versions behaved the same unless a line says otherwise.

**F1: hook events** (`a-pass`, `a-block`, `a-err`, `a-exit3`, `a-signal`, `a-term`, `a-crash`, `a-timeout`, `a-big`, `a-bigblock`, `a-stderrpass`).
Three subtypes in practice: `hook_started` is `{type:"system", subtype, hook_id, hook_name, hook_event, uuid, session_id}`;
`hook_response` adds `output, stdout, stderr, exit_code, outcome`. **`hook_progress` was never emitted** for these hooks.
`hook_name` is `<Event>:<Tool>` (`PreToolUse:Bash`, `PreToolUse:mcp__probe__probe_echo`, `SessionStart:startup`).
`outcome`: `success` (exit 0), `error` (any other exit, 127, signals; `exit_code` 137 for SIGKILL, 143 for SIGTERM),
`cancelled` (timeout, `exit_code: 1`). `output` is `stdout+stderr` joined. **stdout and stderr are whole, not cut**
(200018 characters each, `output` 400036). The probe also saw `exit_code: 2` as `error`, never `blocked`.

**F2: with and without `--include-hook-events`** (`b-noflag-*`, `b-flag-*`). Without the flag: `SessionStart`
`hook_started`/`hook_response` are emitted (also for failures); `PreToolUse` ones are not, whatever the outcome.
With it: both. A person's own hook output shows in the stream only with the flag (F19).

**F3: order on stdout** (`a-pass`, `a-block`, `a-write-*`). `assistant(tool_use)` → `hook_started` → (`rate_limit_event`) →
`hook_response` → `user(tool_result)`. Pass and block are the same order. With four hooks, four `started`/`response`
pairs sit between the `tool_use` and the result, in no fixed source order.

**F4: stdin** (`t-tools`). Common keys: `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name,
tool_name, tool_input, tool_use_id`; 2.1.300 adds `effort`; subagent and workflow-agent calls add `agent_id`,
`agent_type`; MCP tools add `mcp_server`. Inputs: Bash `command, description`; Write `file_path, content`; Edit
`file_path, old_string, new_string, replace_all`; Read `file_path`; NotebookEdit `notebook_path, cell_id, new_source`;
WebFetch `url, prompt`; Agent `description, prompt, subagent_type[, run_in_background]`; WebSearch `query[, mode]`;
Skill `skill`; Workflow `script`; ToolSearch `query, max_results`; CronList `{}`; MCP the server's arguments
(2.1.278 also `TaskCreate subject, description`). Not in `init.tools` of either build: MultiEdit, TodoWrite, Glob,
Grep (not applicable: they cannot be called). `init.tools` lists `Task` but the call is named `Agent`.

**F5: what the model gets** (`a-block`, `a-jsondeny`, `a-stderrpass`, transcripts). Exit 2:
`is_error: true`, content `PreToolUse:Bash hook error: [<hook command>]: <stderr>` (see above). JSON deny: 2.1.300
`PreToolUse:Bash hook error: <reason>`, 2.1.278 the reason alone, `is_error: true`. Exit 0 with stderr: the tool result
is untouched; the stderr is only in `hook_response`. The model sees the text and answers about it, it does not retry
by itself within a turn.

**F6: permission modes** (`c-*`). With a hook that exits 2, the Bash call is blocked in `acceptEdits`, `auto`
(2.1.278: runs as `default`), `bypassPermissions` (as started and after `set_permission_mode`), `manual`, `dontAsk`
and `plan` (2.1.278 `plan`: the model never called Bash, nothing to block), with `--permission-prompts host` and
`none`. **No `can_use_tool` request is sent for a blocked call.** For a command that needs approval
(`c-ask-*`, `touch`): no hook → `can_use_tool` (host) or denial (none); exit-0 hook → same; **hook `allow` → runs,
no `can_use_tool`**; hook `ask` → `can_use_tool` (host) or denial (none). `--disallowedTools Bash` removes the tool,
the hook never runs (`c-denyrule-allowhook`).

**F7: JSON** (`a-jsondeny`, `a-jsonallow`, `a-jsonask`, `a-badjson`, `a-badjson2`). `deny` blocks like exit 2 with
the reason as text; `ask` asks; `allow` approves. Truncated JSON, or plain text, on exit 0 is a **pass**, no error
(`outcome: success`).

**F8: timeout and failures** (`a-timeout`, `a-timeout-default`, `a-missing`, `a-missing-script`, `a-crash`, `s-slowstart`).
`timeout` is **seconds**: 2 → cancelled after 2.0 s (`outcome: cancelled`, `exit_code: 1`) and the tool **runs**. A
hook without `timeout` ran 75 s to the end: the default is above 75 s (not measured further). Missing interpreter
→ `exit_code: 127`, missing script → 1, crash → 1: all `error`, tool runs. A `SessionStart` timeout is cancelled the
same way and the session goes on.

**F9: SessionStart** (`s-idle`, `s-immediate`, `s-slowstart`, `s-resume-a`, `s-resume-b`). Described above.
stdin: `session_id, transcript_path, cwd, hook_event_name, source`; `source` is `startup` or `resume`; on resume
2.1.300 and 2.1.278 add `seconds_since_last_response, context_tokens, prompt_cache_likely_expired,
estimated_cache_write_usd`. Output `additionalContext` is accepted (`b-flag-ssctx`).

**F10: delegation** (`d-agent-pass`, `d-agent-block`, `d-background`, `d-workflow`, `t-tools`). The `Agent` call and the
subagent's own Bash are both hooked; stdin of the latter has `agent_id`, `agent_type`; a block applies inside the
subagent too, and the stream marks the subagent's assistant and user lines with `parent_tool_use_id`.
Workflow: the `Workflow` call is hooked, and the agent's tool calls in it are hooked with `agent_id`. A background
Bash is one hooked call (`run_in_background`); what it later runs inside the shell is not hooked.

**F11: sources and precedence** (`m-*`). User, project, local and `--settings` hooks all run, in no fixed order,
as separate `hook_started`/`hook_response` pairs. Deny (exit 2 or JSON deny) beats allow and ask whatever the
source; ask beats allow (a prompt is still sent); allow plus nothing approves.

**F12: disableAllHooks** (`x-*`). Described above; per source: user, project, local and `--settings` `true` each turn
off every hook; `false` in `--settings` beats `true` in user or project (`x-false-in-settings*`, `r-disable2-*`).
Managed settings: not recorded (see above). `--setting-sources=` (empty) loads only the `--settings` file;
`--setting-sources=user` loads user and `--settings` (`r-sources-*`).

**F13: edits during a session** (`r-reload-*`, `r-corrupt-settings`, `r-delete-settings`, `r-disable*`). Edits to user,
project and local settings (also a new local file) are picked up by the next tool call; the `--settings` file is read
once: rewriting or corrupting it later changes nothing. The CLI reports none of this on the stream. A `--settings`
file emptied before the CLI read it gives no hooks, no error (`r-delete-settings`).

**F14: trust** (`u-untrusted`, `u-untrusted-settings-too`, `u-trusted`). A project hook ran in a never-trusted folder under
`-p`, same as in a folder marked trusted; stderr was empty.

**F15: shell, env, cwd** (`e-shell`, `e-shell-root`). A hook `command` runs as `/bin/sh -c '<command>'` (dash here), cwd
is the session cwd (`CLAUDE_PROJECT_DIR` is set to it), the parent is the CLI. The environment is the CLI's own,
without the OAuth token, plus the `env` keys of the user and `--settings` files (and of project settings when
they load): a project's `.claude/settings.json` `env` does reach the hook. `NODE_OPTIONS`-type variables would
too, hence D7.

**F16: matchers** (`k-matchers`). `"*"`, `""`, no matcher: every tool. A plain name or `A|B` list is an exact,
case-sensitive match (`Bash` matches Bash only; `bash` and `Ba` match nothing). Anything else is a regex that is
*searched*, not anchored: `^(?!Bash$).*` excludes Bash, but `(?!Bash).*` still matches `Bash`. `mcp__.*`,
`mcp__probe__.*` and the exact MCP name match the MCP tool.

**F17: Bash state** (`b-state`). See above; `cd /tmp` (outside the project) is reset after the call ("Shell cwd was reset").

**F18: worktree** (`w-worktree`, `w-nested`). See above.

**F19: person's own hooks** (`m-user-noisy`, `m-user-noisy-noflag`, `m-all-pass`). With the flag the user hook's stdout and
stderr are in `hook_response` (`stdout`, `stderr`, `output`); without it, nothing. They need dropping or redaction in
the stream.

**F20: latency** (`scripts/guard-bench.mjs`, `l-big-node`, `l-big-electron`). Spawn of a no-op hook as
`/usr/bin/env -i PATH=… LANG=C.UTF-8 [ELECTRON_RUN_AS_NODE=1] <exec> noop.mjs`, 200 spawns after 20 warm-up, on
this machine: **node p50 35.7 / p95 55.7 / p99 66.6 ms; Electron-as-node (installed app) p50 66.4 / p95 98.8 / p99
106.9 ms.** In the CLI (2.1.300, 216 real tool calls each, `hook_started`→`hook_response` as seen on the stream):
**node p50 33 / p95 43 / p99 51 ms; Electron p50 61 / p95 101 / p99 115 ms.** Not repeated in the CLI on 2.1.278 (the
spawn cost does not depend on the CLI).

**F21**: both flags exist in 2.1.278 (`claude --help` of the npm build, and every scenario above ran on it).
No pin bump.
