# l0 recording: CLI facts for lessons (lessons plan, F1–F6)

Recorded 2026-10-16, 09:40–09:50 UTC, by the orchestration's worker `l0`.

## Environment

- `claude 2.1.301 (Claude Code)`. The plan was written against `2.1.300`; nothing below differs
  between the two as far as the plan's flags go.
- Every call used `--model haiku` (resolves to `claude-haiku-5-5`), `CLAUDE_CONFIG_DIR` pointing to
  a scratch directory (`/tmp/l0/cfg`, holding only the transcripts these runs wrote), the account's
  OAuth token in `CLAUDE_CODE_OAUTH_TOKEN` (the same way the wrapper hands it to the CLI), and the
  scratch git repository `/tmp/l0/repo` (one empty commit) as the working directory. The
  `CLAUDE_CODE_*` variables of the orchestrating session were unset. Each call ran under
  `timeout 120`.
- Total spend: under 0.02 USD (haiku costs 0.0002–0.0017 USD a turn here), against the 0.50 USD cap.
- Streams were trimmed before committing (`system/thinking_tokens`, `rate_limit_event`, `usage`
  blocks, extended-thinking blocks, the long `slash_commands`/`skills`/`plugins` lists of `init`,
  `permission_suggestions` of a `can_use_tool` request, and for the transcript: `api-request*`,
  `attachment`, `queue-operation`, `cost-state` and `last-prompt` lines), then passed through
  `packages/core/scripts/redact-recordings.mjs` (it rewrote nothing: no e-mail, token or home path was
  ever in them; a grep of the replay files for a token prefix, an at-sign, a home path or the owner's name finds nothing). Session
  ids are random UUIDs of the scratch config. Transcript lines kept in `lesson-rewind.jsonl` are the
  CLI's own files (`projects/-tmp-l0-repo/<session>.jsonl`), fields untouched.

| file (`test/fixtures/replay/`) | what | source |
|---|---|---|
| `lesson-miner.jsonl` | F1: the miner schema on haiku (4 lines) | stdout of one `-p` run |
| `lesson-denied.jsonl` | F3: a host deny with a message, as streamed (15 lines) | stdout of a stream-json chat |
| `lesson-interrupt.jsonl` | F4: an interrupt during a tool call, as streamed (24 lines) | stdout of a stream-json chat |
| `lesson-rewind.jsonl` | F5: the session transcript after `--resume-session-at` (13 `user`/`assistant` lines) | the CLI's session file |
| `lesson-budget.jsonl` | F6: a run stopped by `--max-budget-usd` (3 lines) | stdout of one `-p` run |

The stream-json chats were driven by a small node script speaking the host side of the protocol,
the same one `providers/claude-code/control.ts` speaks: `user` messages in, `control_response` to each
`can_use_tool`, `control_request` `{subtype:'interrupt'}` for the interrupt.

## F1. The miner schema is honoured on haiku — as written

argv: `claude -p --model haiku --verbose --output-format stream-json --json-schema <MINER_SCHEMA, the
plan's exact text, on one line> --max-budget-usd 0.05 --no-session-persistence --restricted --tools=
--setting-sources= --permission-mode dontAsk <prompt>`. The prompt was the miner outline with three
scripted signals (a Spanish correction about `npm`, a denial about `CHANGELOG.md`, a one-off "call
the variable foo"), one existing lesson `L-3` and one instruction line. Exit 0.

- The only tool in `init` is `StructuredOutput`. The model called it once; the stream has the
  `tool_use` (`name: "StructuredOutput"`), a `tool_result` `"Structured output provided
  successfully"`, and the final `result` line carries `structured_output`.
- `structured_output` was `{"lessons":[…2 items…]}`, every item with all nine required keys, the right
  types: `signals` an array of strings, `confidence` a number (`0.8`, `0.7`), `mechanical` a boolean,
  `instructions` one of the enum values (`"none"`, `"restates"`), empty strings for `restates` /
  `contradicts` when there is none, `restates: "L-3"` when there is one. The third signal (the
  one-off) was correctly left out.
- Note the `result` line: `stop_reason` is `"tool_use"` (not `end_turn`), `total_cost_usd` 0.0015,
  `is_error: false`, `subtype: "success"`. The `result` line carries **both** `structured_output` (the
  object) and `result` (the same JSON as a string); read `structured_output`, as `structured.jsonl`
  does.
- The `quote` came back verbatim (`No uses npm, en este proyecto siempre pnpm`), in the person's
  language; `trigger` and `action` in English, as asked.
- Not exercised: `pattern`, `minLength`, `maxItems`, numeric bounds (the plan relies on none).
  The model did not follow the schema's `description` length hints exactly in every case, which is why
  code must enforce them (as the plan says).

## F2. A different `--append-system-prompt` on `--resume` is ignored with snapshot `on`

Session `--session-id 7d2f…` (haiku, `-p --output-format json`, default snapshot):

1. `--append-system-prompt "Appended instructions: the secret word is ALPHA."`, prompt "Reply with just OK." → `OK`.
2. `--resume 7d2f… --append-system-prompt "Appended instructions: the secret word is BRAVO."` and the
   prompt "Quote verbatim the line of your system prompt that starts with 'Appended instructions:'.
   Then say which secret word it names." → the model declined to quote verbatim but said the
   appended instruction names **ALPHA**. The new text was ignored.
3. The same resume with `--system-prompt-snapshot off` → the model answered **BRAVO** (and said its
   earlier answer was wrong). With snapshot `off`, the text of the resume is used.

So the plan's assumption holds: with the default `on`, interactive chats keep the lessons (appended
text) they started with. Caveat for the plan: the model refuses to *quote* its system prompt, so the
check has to ask for the secret word, not for the quote. No replay file (a plain JSON result).

## F3. A host deny with a message

Chat with `--permission-prompts host --permission-prompt-tool stdio --permission-mode default
--tools Bash,Edit,Write`, session `3b1c…`. The model asked for `npm install lodash`; the host
answered the `can_use_tool` request with
`{"behavior":"deny","message":"No uses npm, en este proyecto siempre pnpm"}`.

Stream (`lesson-denied.jsonl`): the `tool_result` the CLI feeds back is
`{"type":"tool_result","content":"No uses npm, en este proyecto siempre pnpm","is_error":true,"tool_use_id":"toolu_…"}`
— **the person's message verbatim as `content`, `is_error: true`**, with no prefix.

Transcript line (the CLI's session file, the line the correction fold would read):

```
{"parentUuid":"<assistant tool_use uuid>","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"No uses npm, en este proyecto siempre pnpm","is_error":true,"tool_use_id":"toolu_…"}]},"uuid":"…","toolUseResult":"Error: No uses npm, en este proyecto siempre pnpm","toolDenialKind":"permission-rule","sourceToolAssistantUUID":"<assistant uuid>","permissionDecision":{"decision":"reject","source":"user_reject"}, …}
```

- `toolUseResult` **is a string**, `"Error: " + message`; the prefix `Error: ` has to be removed to get the
  person's words. `content` has the bare message, so read `content`, not `toolUseResult`.
- `permissionDecision` is `{"decision":"reject","source":"user_reject"}` and `toolDenialKind` is
  `"permission-rule"` for a host deny. These two fields make a denial recognisable without parsing
  the text.
- The transcript lines are not in `lesson-denied.jsonl` (that file is the stream); the line above is the
  quoted, scrubbed one. `lesson-rewind.jsonl` shows the same file format.
- A deny **without** a message: the host driver's `toControlDecision` sends `"denied"`
  (`control.ts:9`) so the `content` is `denied`; not recorded separately (it is what the code sends).
- `result.permission_denials` stayed `[]` for a host-answered deny (the CLI counts only automatic
  denials there), so the correction fold must not rely on it.

## F4. An interrupt

Session `4c2d…`. A Bash call was started and, 8 s later, the host sent
`{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}`
(`lesson-interrupt.jsonl`).

- The CLI answered `{"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[]}}}`.
- The running task ends: a `system` line `{"subtype":"task_notification","status":"stopped",…}`.
- Two user lines are written to the transcript: the tool result
  `"The user doesn't want to proceed with this tool use. The tool use was rejected … STOP what you are doing and wait for the user to tell you how to proceed."`
  with `is_error: true`, and then
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`.
  **The marker is a user line whose content is a one-item `text` array**, not a string, and has no
  `toolUseResult`.
- Interrupting a turn that is only writing text (no tool) writes `[Request interrupted by user]`
  (without "for tool use"), same shape (checked in a separate run; its line is quoted here and
  not kept as a file):
  `{"parentUuid":"…","type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},…}`.
  The signal `interrupted` has to match both texts.
- The tool-result text above also appears for a *plain* decline of a tool, so it cannot be told apart
  from a host deny without a message by that text alone: the marker line that follows is what says
  "interrupt". A deny keeps `permissionDecision.source: "user_reject"` on the tool result in both cases.
- The turn ended with a `result` (`stop_reason: end_turn`, `terminal_reason: completed`, `is_error`
  absent), and the chat took the next prompt (`Reply with just OK.`) normally.

## F5. `--resume-session-at`

Session `4c2d…` (the F4 one, 51 lines before the rewind): `--resume 4c2d… --resume-session-at
<uuid of the first assistant message, "Hi">`, then the prompt "Reply with just the word REWOUND."
(`lesson-rewind.jsonl` is the whole transcript after it.)

- **The same session id and the same file**; nothing is truncated or rewritten, the new lines are
  appended (53 → 65 lines).
- The new `user` line has `parentUuid` = the uuid of the message resumed at (`0c9f…`, "Hi"), so the
  transcript is now a tree: from "Hi" one branch continues with the Bash attempt, the interrupt and
  `Reply with just OK.` (the abandoned branch) and another with `Reply with just the word REWOUND.`
  and its reply.
- **No marker line** is written for the rewind. It can only be recognised structurally: a `user`
  line whose `parentUuid` already has another child (here `0c9f…` has two: `64f9…` and `272b…`). The
  abandoned branch keeps all its lines, uuids and `parentUuid` chain intact, so the evidence of what
  was undone can be read from them.
- `last-prompt.leafUuid` (not kept) moves to the new branch's tip.
- Both in the stream (`init` again, `isReplay` user echo) and in the file, the new branch is
  continuous with the old prefix: the first assistant message is not repeated.

## F6. `--max-budget-usd`

argv: `claude -p --model haiku --verbose --output-format stream-json --max-budget-usd 0.001
--no-session-persistence "Write a 300 word essay about rivers."` → **exit code 1**.

- `result`: `subtype: "error_max_budget_usd"`, `is_error: true`, `terminal_reason: "budget_exhausted"`,
  `errors: ["Reached maximum budget ($0.001)"]`, `total_cost_usd: 0.0012020199999999998` (the cap
  is checked after the turn, so the cost is slightly above it), `num_turns: 1`, `stop_reason: "end_turn"`.
  There is **no `result` text field** on this line (the shape `budget.jsonl` shows has one; the real
  CLI uses `errors`).
- The assistant text of the turn was streamed and complete before the `result`, i.e. the cap did not
  cut the answer; it stops *further* turns.
- With the cap the plan names, `--max-budget-usd 0.01`, the same prompt on haiku is **not** stopped: it
  cost 0.0017 USD, `subtype: "success"`, exit 0 (not kept as a file). A haiku miner run with the
  planned `0.05` will not be capped in practice; only a long multi-turn run would.

## Changes for the plan

1. **F3**: read the person's message from the tool result's `content`; `toolUseResult` is
   `"Error: <message>"`, not the bare message. A host deny is recognised by `permissionDecision`
   `{decision: "reject", source: "user_reject"}` (and `toolDenialKind: "permission-rule"`), not by
   `result.permission_denials`, which stays empty.
2. **F4**: the interrupt marker has two texts: `[Request interrupted by user for tool use]` and
   `[Request interrupted by user]`. It is a `user` line with `content: [{type:"text",text}]`.
   A decline's tool result text ("The user doesn't want to proceed with this tool use…") is not
   proof of an interrupt.
3. **F5**: a rewind leaves no marker and truncates nothing. The signal `rewound` is derived from the
   tree (a `parentUuid` with more than one child), and the abandoned branch is the evidence.
4. **F6**: the budget stop is `error_max_budget_usd` with `errors[]` and no `result` string, exit 1, and the
   cost can exceed the cap by one turn. Haiku turns are so cheap that `0.01` does not trigger it.
   `replay/budget.jsonl` (hand-made) has a `result` string the real CLI does not send: nothing breaks,
   but the miner's handling of "capped" must read `subtype` and `errors`, not `result`.
5. **F1/F2**: confirmed as the plan assumed. F2 can only be verified by asking for the word the
   appended text names; the model won't quote its system prompt.
6. CLI version is `2.1.301`, not `2.1.300`.
