# Recordings

Scrubbed copies of what the `gh`, `glab` and YouTrack tools sent and answered. The fakes in
`packages/core/test/fixtures/` replay these shapes and invent no event. The `gh` and `glab` folders
belong to the code hosts and have their own notes, and `youtrack-app` to the YouTrack tracker, with
its own `NOTES.md`.

`claude` holds what Claude Code 2.1.300 answered to `get_context_usage` and the session-file lines
it wrote around a compaction. Their stdout counterparts are `../replay/compact-*.jsonl`, and
[c0-NOTES.md](c0-NOTES.md) says how each was recorded and what it showed (context control, plan
`docs/plans/context-control.md`, facts F1-F20). In those files a compaction summary keeps only the
CLI's fixed lead sentence, followed by `<summary: N chars>`.

`claude-hooks` holds what Claude Code 2.1.300 and 2.1.278 did with `PreToolUse` and `SessionStart` command hooks loaded through
`--settings`: stream events, hook stdin, outcomes, precedence and latency, one folder per scenario and version.
[claude-hooks/g0-NOTES.md](claude-hooks/g0-NOTES.md) opens with the facts that change `docs/plans/guards.md` (facts F1-F21).

`../replay/model-not-found.jsonl` is **not recorded**: no turn was spent on it. It is what Claude Code
2.1.319 writes when the API refuses the model a session runs on, read from the CLI's own code and the
Agent SDK 0.3.319's `sdk.d.ts` (2026-11-07). On a 404 the CLI makes a synthetic answer (`model:
"<synthetic>"`, the text "There's an issue with the selected model (X). It may not exist or you may not
have access to it.", followed by a hint to `/model` when the session offers one), puts `error:
"model_not_found"` on it (`SDKAssistantMessage.error`, typed as `SDKAssistantMessageError`) beside its
internal `is_api_error_message` and `api_error_status: 404`, and ends the turn with a `success` result
whose `is_error` is true, `api_error_status` 404 and `result` the same text. Claudio reads only the
typed `error`. A recording from a real session should replace it the next time one is made.
