# instruction-evals e0: CLI facts F1–F12 (partial)

Recorded 2026-10-16 (about 12:40 CEST) with `claude` 2.1.301 (the plan says 2.1.300), model
`haiku`, in a throwaway git repo under `/tmp`, removed afterwards. Command shape for every run:

```
printf '{"type":"user","message":{"role":"user","content":"<prompt>"}}\n' |
  claude -p --input-format stream-json --output-format stream-json --verbose \
         --model haiku --max-budget-usd 0.10 [extra flags]
```

**Total spent: 0.0021 USD.** Status: **incomplete**. F1 (default case) and F12 are answered. The
rest was blocked: after the first call every further call returned `api_error_status` 429,
`api_error` `usage_limit_reached`, "You've hit your session limit · resets 4pm (Europe/Madrid)"
(the account is shared by the whole orchestration). F2–F11, and the `--setting-sources` half of F1,
must be recorded after the reset (16:00 CEST on 2026-10-16) by re-running task e0. Nothing was
guessed for them.

Note for the runner: on this machine `CLAUDE_CONFIG_DIR` points at a Claudio account directory
that is not logged in; the logged-in account is `CLAUDE_CONFIG_DIR=$HOME/.claude`.
`~/.claude/CLAUDE.md` does not exist, so the user-memory half of F1 needs a throwaway user file.

## F1 (partly): ancestors' memory files

Repo: `<tmp>/CLAUDE.md` (marker `PARENT-MARK-A`) above `<tmp>/repo/` (git root, `CLAUDE.md` with
`REPO-MARK-B`, `CLAUDE.local.md` with `LOCAL-MARK-C`), cwd = `<tmp>/repo`, default flags.
Prompt: "List every distinct word matching *-MARK-* that appears anywhere in your instructions or
memory, comma separated, nothing else. Do not use tools."

Answer: **yes, `-p` loads `CLAUDE.md` from an ancestor above the git root, plus the repo's
`CLAUDE.md` and `CLAUDE.local.md`**. Result: `PARENT-MARK-A, REPO-MARK-B, LOCAL-MARK-C`.
Fixture: `packages/core/test/fixtures/recordings/evals/f1-default.jsonl`.
This confirms decision 7 (lanes outside the repo, and the root check stays). Not yet answered:
what `--setting-sources user|project|local` change.

## F12: replay of an `internal` chat (code reading; no fake-CLI run)

- `isAutomated` (`packages/core/src/rotation.ts:139-144`) returns true for any chat with `work`
  **before** it checks `origin === 'internal'`. An internal chat without work is not automated,
  but `onLimitHit` still goes on to `moveToAccount` when `rotatesOnLimit()` is on
  (`rotation.ts:152`).
- `moveToAccount` calls `replayLastTurn` (`chats.ts:1564`), which stops the process and calls
  `sendMessage`; the respawn uses `--resume` (comment at `chats.ts:1562`).
- An internal chat runs with `--no-session-persistence` (`args.ts:68`), so there is no session to
  resume.

Answer: **yes, the replay can send its turn into a process that cannot resume** (an internal chat
with `work`, or any internal chat when rotate-on-limit is on). The `e6` guard is needed; its test
is "an `internal` chat that hits a limit is neither moved nor replayed". The fake-CLI run was not
done; `e6` should exercise it.

## F2–F11: not recorded

Blocked by the usage limit above. The plan table is unchanged for them.
