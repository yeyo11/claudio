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
