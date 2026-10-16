# c0 recording: context control (task x0 of docs/plans/context-control.md)

Recorded 2026-10-16, 03:16-03:39 UTC, with **Claude Code 2.1.300** (`claude --version` →
`2.1.300 (Claude Code)`). Published SDK read: `@anthropic-ai/claude-agent-sdk@0.3.301` (npm tarball,
read only).

**Total spend: 0.049 US$** (0.049254), under the 0.50 US$ cap. Each process's last `result` carries
its own cumulative `total_cost_usd`. Per process: s1 0.013361, s2 0, s3 0, s3b 0, s3c 0.013626, s4
0.014138, s5 0.001479, s6 0.003067, s7 0.003583.

## One-rule check (F19): what is documented and what is not

Every surface the plan builds on has a published type or doc page: the `get_context_usage` control
request and its answer, `/compact` sent as a user turn, the `system/status` event with
`'compacting'`, and the `system/compact_boundary` event. Details are in [F19](#f19-documentation-status).
The check still has these gaps, and the code must treat each item as optional:

- **Wire fields with no published type and no doc.** The CLI sent them, but neither the SDK types
  nor the docs name them:
  - `compact_metadata.cumulative_dropped_tokens`, `.pre_compact_discovered_tools` and
    `.preserved_messages.all_uuids`;
  - the top-level `logical_parent_uuid` of the boundary;
  - `compact_output_chars` on an automatic `status` event;
  - `autocompactSource` in the `get_context_usage` answer.
- **Typed but not on the doc pages.** `compact_result`, `compact_error` and the `'requesting'`
  status are in the published `sdk.d.ts`, but the doc page shows `status: "compacting" | null` only.
  The page's `SDKCompactBoundaryMessage` lists `trigger` and `pre_tokens` only. `post_tokens`,
  `duration_ms`, `preserved_segment` and `preserved_messages` are in `sdk.d.ts` only.
- **Transcript file fields with no published schema.**
  - `isCompactSummary`, `isVisibleInTranscriptOnly`, `compactMetadata` (camelCase),
    `logicalParentUuid`, and the `system/local_command` line.
  - The one rule allows "the files the CLI writes", so reading them stays within the rule. No
    published schema describes them, so they are leads, not a contract.
  - On stdout the same summary is a typed `SDKUserMessage` with `isSynthetic: true`.

## Setup

- **Working directories.** Throwaway directories from `mktemp -d` under `/tmp`, scrubbed to
  `/home/user/probe`.
  - Each has a four-line `CLAUDE.md`.
  - The directory of s2 and s6 also has `.claude/agents/probe-reviewer.md`, so the breakdown lists a
    custom agent.
- **Driver.** A Node script outside the repository (`drive.mjs`) spawns one process per session and
  writes the stdin lines itself. Every stdout line is logged with a millisecond timestamp. Argv on
  every process:

  ```text
  claude -p --input-format stream-json --output-format stream-json --verbose --model haiku
    --max-budget-usd 0.50 --mcp-config mcp.json --strict-mcp-config --setting-sources project,local
    --allowedTools mcp__alpha__slow_echo [--resume … | --fork-session | --resume-session-at …]
  ```

  `--model haiku` resolved to `claude-haiku-5-5`, with a 1,000,000-token window.
- **MCP servers.** Two local stdio servers written for this recording, both in `--mcp-config`:
  - `alpha` has ten tools: `slow_echo`, which waits 4 s, and `tool_1` … `tool_9`;
  - `beta` has one tool, also named `slow_echo`.
- **Sessions.**
  - s1 is the main session: breakdowns, an invented subtype, `/compact` ×5, an interrupt and a
    queued message.
  - s2: `/compact` on a fresh session.
  - s3, s3b and s3c: `--resume-session-at`.
  - s4: `--fork-session`.
  - s5: `DISABLE_COMPACT=1`.
  - s6: a long `/compact`.
  - s7: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`, for an automatic compaction.
- **Scrub.**
  - Home and temporary paths become `/home/user/...`, and emails become `<email>`.
  - Session ids become fixed uuids `00000000-0000-4000-8000-00000000000N`: N=1 s1, 2 the s4 fork,
    3 s2, 4 s5, 5 s7, 6 s6.
  - Thinking signatures become `<signature>`.
  - A summary keeps the CLI's fixed lead sentence and replaces the model-written rest with
    `<summary: N chars>`, where N is the original length of the whole content.
  - Attachments that carry the account or the whole prompt are left out of `compacted.jsonl`:
    `credential_org`, `remote_session_change`, `prompt_snapshot` and `skill_listing`.
    `session_context` is kept as `{ userEmail: '<email>' }`.
  - Message uuids are the real, random ones, so the links between lines still hold.

## Fixtures

| File | What it holds |
| --- | --- |
| `recordings/claude/context-usage-full.json` | s1, idle after the `slow_echo` turn, `detail: 'full'`: the inner `response` object |
| `recordings/claude/context-usage-summary.json` | the same moment, `detail: 'summary'` |
| `recordings/claude/context-usage-agent.json` | s2, fresh, `full`, with a project custom agent and **no** MCP rows (servers not connected yet, see F1) |
| `recordings/claude/context-usage-errors.json` | the two error answers: a bad `detail`, and an invented subtype |
| `recordings/claude/compacted.jsonl` | session-file lines: a manual boundary and what follows it, a boundary after a multi-line argument, a cancelled `/compact`, an automatic boundary inside a live turn |
| `replay/compact-manual.jsonl` | stdout of a bare `/compact` turn |
| `replay/compact-focus.jsonl` | stdout of `/compact Keep the codeword BADGER and write it as CODEWORD-BADGER in the summary.` |
| `replay/compact-multiline.jsonl` | stdout of `/compact Line one: …\nLine two: …` |
| `replay/compact-failed.jsonl` | stdout of a `/compact` interrupted while compacting (`compact_result: 'failed'`) |
| `replay/compact-empty.jsonl` | stdout of `/compact` on a session with no messages |
| `replay/compact-queued.jsonl` | stdout of `/compact` with a user message written during it: the compaction's result, then the queued turn |
| `replay/compact-disabled.jsonl` | stdout of a whole `DISABLE_COMPACT=1` session: one turn, then `/compact` |
| `replay/compact-auto.jsonl` | stdout of two turns of s7: a failed automatic attempt (`too_few_groups`), then one that compacts and goes on |

The replay files start at the first stdout line after the `/compact` was written. They hold stdout
only, as the other files in `replay/` do. A `control_response` to Claudio's own request is kept
where it fell (`compact-failed.jsonl` line 2).

## F1 — the request, `detail`, timings

- **Command.** s1 sends `{ type: 'control_request', request_id, request: { subtype:
  'get_context_usage' [, detail] } }`. The order: idle on a fresh process (no detail, `summary`,
  `full`, `bogus`), then mid-turn, then idle after the turn.
- **Seen.**
  - **The default is `full`.** With no `detail` the answer equals the `full` answer field for field
    (13,736 tokens, the same rows).
  - **An unknown `detail` is refused.**
    `{ subtype: 'error', error: "get_context_usage: detail must be 'summary' or 'full'" }`, in 1 ms.

  Latency of each request:

  | Moment | Request | Latency |
  | --- | --- | --- |
  | Idle, fresh process, first request | no detail | 1,701 ms (process start and MCP connect) |
  | Idle, fresh process | `summary` | 32 ms |
  | Idle, fresh process | `full` | 211 ms |
  | Mid-turn | `summary` | 14 ms |
  | Mid-turn | `full` | 205 ms |
  | Idle after a turn | `summary` | 8 ms |
  | Idle after a turn | `full` | 8 ms (answered from the response just received) |
  | Fresh process in s2, first request | `full` | 5,030 ms |
  | Fresh process in s4 | `summary`, then `full` | 2,568 ms, then 694 ms |

  - The first request of a process waits for start-up.
  - **`summary` and `full` disagree**, as documented.
    - `summary` estimates high: System tools 12,603 against 8,247, and MCP tools 113 against 71.
    - Before the first response, `summary` reports no "Messages" row, or only 2-18 tokens, even on
      a resumed session where `full` reports 3,477.
  - **Breakdown before the first turn.** On the fresh s2 process the `full` answer has **no MCP
    rows and an empty `mcpTools`**: the servers had not connected yet. In s1 the first answer
    already listed them as deferred.
- **Fixture.** `context-usage-full.json`, `context-usage-summary.json`, `context-usage-agent.json`,
  `context-usage-errors.json` (`invalidDetail`).

## F2 — the response

- **Seen.**
  - Top-level keys, in order: `categories`, `totalTokens`, `maxTokens`, `rawMaxTokens`,
    `autocompactSource`, `percentage`, `gridRows`, `model`, `memoryFiles`, `mcpTools`, `agents`,
    `slashCommands`, `skills`, `autoCompactThreshold`, `isAutoCompactEnabled`, `messageBreakdown`,
    `apiUsage`.
  - `deferredBuiltinTools`, `systemTools` and `systemPromptSections` were **absent** in every answer.
  - `autocompactSource` (`'model-default'`) is not in the published type.
  - Each category row is `{ name, tokens, color, kind }`, plus `isDeferred: true` on deferred rows.
    `color` is a terminal theme key, such as `promptBorder` or `cyan_FOR_SUBAGENTS_ONLY`.
- **The figures, for haiku.**
  - `maxTokens` and `rawMaxTokens` are both 1,000,000.
  - `autoCompactThreshold` is 967,000, and the "Autocompact buffer" row is 33,000.
  - `percentage` is 1-2.
  - `gridRows` is 10 × 20 cells.
- **`mcpTools`.**
  - Each entry is `{ name: 'mcp__alpha__tool_1', serverName: 'alpha', tokens, isLoaded }`.
  - Every tool is listed, loaded or not. `isLoaded` was `true` only for `mcp__alpha__slow_echo`,
    after ToolSearch loaded it.
- **Other fields.**
  - `memoryFiles` is `[{ path: '…/CLAUDE.md', type: 'Project', tokens }]`.
  - `agents` is `[{ agentType: 'probe-reviewer', source: 'projectSettings', tokens: 39 }]`.
    Built-in agents are not listed.
  - `skills.skillFrontmatter` is `[{ name, source, tokens }]`.
  - `apiUsage` is `null` until the first response, then that response's usage.
- **Fixture.** `context-usage-full.json`, `context-usage-summary.json`.

## F3 — category names and kinds

- **Seen.** Every name met in nine answers, with its `kind`:

  | name | kind |
  | --- | --- |
  | `System prompt` | used |
  | `System tools` | used |
  | `System tools (deferred)` | deferred |
  | `MCP tools` | used (only once an MCP tool was loaded) |
  | `MCP tools (deferred)` | deferred |
  | `Custom agents` | used (only with a project agent, s2) |
  | `Memory files` | used |
  | `Skills` | used |
  | `Messages` | used |
  | `Autocompact buffer` | buffer |
  | `Free space` | free |

- **Not seen.** There is no `Slash commands` row: `slashCommands` is reported as an object
  (`{ totalCommands: 14, includedCommands: 14, tokens: 919 }`) but has no category row. No row with
  zero tokens was seen.
- **MCP tools are deferred by default.** All eleven MCP tools started under "MCP tools (deferred)".
  Loading one through ToolSearch moved it to "MCP tools" (`isLoaded: true`).
- **Fixture.** `context-usage-full.json`, `context-usage-agent.json`.

## F4 — an unknown control subtype

- **Command.** `{ subtype: 'x0_invented_subtype' }`.
- **Seen.** `{ type: 'control_response', response: { subtype: 'error', request_id, error:
  'Unsupported control request subtype: x0_invented_subtype' } }`, in 1 ms. The core fake's text is
  the same.
- **Fixture.** `context-usage-errors.json` (`unknownSubtype`).

## F5 — the live `compact_boundary` event

- **Command.** `/compact` written as a user message (`{ type: 'user', message: { role: 'user',
  content: '/compact' }, parent_tool_use_id: null, session_id: '' }`).
- **Seen.**

  ```json
  { "type": "system", "subtype": "compact_boundary", "session_id": "…", "uuid": "…",
    "compact_metadata": { "trigger": "manual", "pre_tokens": 18517, "post_tokens": 1655,
      "cumulative_dropped_tokens": 16862, "duration_ms": 7063,
      "pre_compact_discovered_tools": ["mcp__alpha__slow_echo"],
      "preserved_segment": { "head_uuid": "…", "anchor_uuid": "<summary uuid>", "tail_uuid": "…" },
      "preserved_messages": { "anchor_uuid": "<summary uuid>", "uuids": ["…"], "all_uuids": ["…"] } },
    "logical_parent_uuid": "…" }
  ```

  - `pre_tokens` and `post_tokens` of the five manual compactions: 18,517 → 1,655; 16,941 → 1,767;
    17,185 → 1,850; 17,566 → 1,821; and 17,997 → 1,526 in s6.
  - `duration_ms` ranged from 4,453 to 10,105.
  - s6, whose session had one exchange, carried **no** `preserved_segment`, `preserved_messages` or
    `pre_compact_discovered_tools`.
  - Automatic compactions carry `trigger: 'auto'` (F20).
- **Fixture.** `replay/compact-manual.jsonl` (line 4), `compact-focus.jsonl`,
  `compact-multiline.jsonl`.

## F6 — the boundary line in the session file

- **Seen.**

  ```json
  { "parentUuid": null, "logicalParentUuid": "…", "isSidechain": false, "type": "system",
    "subtype": "compact_boundary", "content": "Conversation compacted", "isMeta": false,
    "timestamp": "…", "uuid": "<same uuid as stdout>", "level": "info",
    "compactMetadata": { "trigger": "manual", "preTokens": 18517, "durationMs": 7063,
      "preCompactDiscoveredTools": […], "preservedSegment": { "headUuid", "anchorUuid", "tailUuid" },
      "preservedMessages": { "anchorUuid", "uuids", "allUuids" }, "postTokens": 1655,
      "cumulativeDroppedTokens": 16862 },
    "userType": "external", "entrypoint": "sdk-cli", "cwd": "…", "sessionId": "…",
    "version": "2.1.300", "gitBranch": "HEAD", "slug": "…" }
  ```

  - camelCase in the file, snake_case on stdout, as the plan says.
  - The **uuid is the same** in both places.
- **Fixture.** `recordings/claude/compacted.jsonl` lines 2, 11 (manual) and 23 (auto).

## F7 — what follows the boundary in the file

- **Seen, manual (`/compact`).**
  1. The boundary.
  2. The `user` summary line: `isCompactSummary: true`, `isVisibleInTranscriptOnly: true`, string
     content, `parentUuid` = the boundary.
  3. `user` `isMeta: true` `<local-command-caveat>…`.
  4. `user` `<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>…</command-args>`.
  5. `user` `<local-command-stdout>Compacted </local-command-stdout>`.
  6. Attachments `deferred_tools_delta`, `agent_listing_delta`, `environment`, `model`.
- **Seen, automatic.**
  1. The boundary.
  2. Attachments `instructions`, `session_context`, `date`.
  3. The summary, with array content `[{ type: 'text', text }]`.
  4. Attachments `deferred_tools_delta`, `agent_listing_delta`, `environment`, `model`, …
  5. The turn's assistant lines.
- **The summary text.**
  - It is 3,387-4,167 characters in these short sessions.
  - It starts with the fixed sentence "This session is being continued from a previous
    conversation that ran out of context. The summary below covers the earlier portion of the
    conversation.\n\nSummary:\n1. Primary Request and Intent: …".
  - It ends with the full path of the session's JSONL file and two fixed paragraphs ("Continue the
    conversation from where it left off …", "The messages after this summary are the most recent
    messages from before compaction, kept verbatim. …").
  - So the summary carries a home path: anything showing or exporting it should expect one.
- **The file is not append-only per uuid.** From the second compaction on, the CLI **re-appends the
  earlier chain** before writing the new boundary. The same uuids are written again, and a few
  `parentUuid`s differ from the first copy.
  - s1 lines 93-121 repeat lines 3-53.
  - Lines 154-202 and 254-322 repeat again.
  - A reader must deduplicate by `uuid`. This recording did not check how Claudio's readers handle
    the copies today.
- **Fixture.** `recordings/claude/compacted.jsonl` lines 1-10 (manual) and 19-33 (automatic). The
  re-appended copies are not in the fixture: they repeat lines already shown.

## F8 — `system/status` around a compaction

- **Seen.** No status carried `permissionMode`. `'requesting'` was never seen. The sequences:

  | Case | Status events | Other lines |
  | --- | --- | --- |
  | Manual | `{status:'compacting'}`, then `{status:null, compact_result:'success'}` | then `system/init`, the boundary, the summary, the `Compacted` replay and the `result` |
  | Automatic | `{status:'compacting', compact_output_chars:0}`, then `{status:null, compact_result:'success'}` | at the start of the turn, after its `init`; then the boundary and the turn's model call |
  | Failed, interrupt | `{status:null, compact_result:'failed', compact_error:'API Error: Request was aborted.'}` | |
  | Failed, automatic | `{status:null, compact_result:'failed', compact_error:'too_few_groups'}` | 9 ms after `compacting`; the turn went on uncompacted |
  | `/compact` with nothing to compact (F13) | none | |
  | `DISABLE_COMPACT` (F9) | none | |

  For the timings, the manual case gave each event's offset from the write: `compacting` at
  7-27 ms, and the closing status 7-10 s later.
- **Fixture.** `replay/compact-manual.jsonl`, `compact-failed.jsonl`, `compact-auto.jsonl`.

## F9 — `/compact` is listed, takes its argument whole, and goes away under `DISABLE_COMPACT`

- **Seen.**
  - **Listing.** `init.slash_commands` lists `compact` in every session.
    - The `init` also carries `terminal_slash_commands: ['doctor', 'color', 'focus',
      'reload-plugins']`, without `compact`.
    - **With `DISABLE_COMPACT=1`**, `compact` is not listed.
    - `/compact` then answers with an assistant text and a `result` `{ subtype: 'success',
      is_error: false, result: "/compact isn't available in this environment.", num_turns: 0 }`.
      There is no `local_command` field, no status and no cost. That is the documented wording for
      a built-in command that is not available.
  - **The argument.**
    - A one-line argument is honoured: the next answer recalled "CODEWORD-BADGER".
    - A **multi-line argument reaches the summariser whole**. The file's `<command-args>` holds
      both lines, and the summary contains both marker words, `PELICAN-LINE-ONE` and
      `GIRAFFE-LINE-TWO`. A newline in `compactText` is therefore safe.
  - **Confined chat (E28): not reproduced.** Every session ran with `--setting-sources
    project,local`; none ran with no setting sources.
- **Fixture.** `replay/compact-disabled.jsonl`, `replay/compact-multiline.jsonl`,
  `recordings/claude/compacted.jsonl` line 14.

## F10 — the `compacting` heartbeat

- **Not reproduced live.** Every compaction ended before 30 s: 4.5-10.1 s, and even s6, which asked
  for a 5,000-word summary, took 8.2 s. Exactly one `status: 'compacting'` was seen per compaction.
- **Shipped code.** `var SBr=30000; function lK(e){let n=setInterval(bBr,SBr,e);…}
  function bBr(e){…e?.({type:"sdk_status",status:"compacting"})}`. The heartbeat repeats every
  **30 s** while a compaction runs. A longer compaction would cost more than this recording's budget
  allowed.
- **For the code.** A compaction of under 30 s emits a single `compacting` status. Refresh the lease
  on that status, and treat the silence signal as covered by the 3-minute window.
- **Fixture.** None (no live repeat).

## F11 — is the summary streamed?

- **Seen: yes.** On stdout, right after the boundary, comes a `user` line with the **same uuid** as
  the file's summary line. It has no `isCompactSummary`:
  - manual: `{ type: 'user', message: { role: 'user', content: '<summary string>' }, isReplay:
    false, isSynthetic: true, uuid, timestamp, parent_tool_use_id: null }`;
  - automatic: the same with array content and no `isReplay`.
- **Manual only.** A second line follows: `{ type: 'user', … content: '<local-command-stdout>Compacted
  </local-command-stdout>', isReplay: true }`.
- **Telling it apart.**
  - On stdout, recognise the summary as `isSynthetic: true` with the content's fixed lead sentence,
    or as the `user` line right after a `compact_boundary` whose uuid is
    `compact_metadata.preserved_segment.anchor_uuid` when that is present.
  - In the file, use `isCompactSummary`.
  - A fresh `system/init` comes between the closing status and the boundary.
- **Fixture.** `replay/compact-manual.jsonl` lines 5-6, `compact-auto.jsonl` line 10.

## F12 — the `result` of a `/compact` turn

- **Seen.**

  ```text
  { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0,
    local_command: 'compact', duration_ms: <compaction>, duration_api_ms: 0, usage: <all zeros>,
    total_cost_usd, modelUsage, queued_turn_count: 0, … }
  ```

  - **`total_cost_usd` and `modelUsage` are cumulative for the process**, as on every result of a
    stream-json process. They include the summarising call.
  - The compaction's own cost is the **difference** from the previous result: 0.004093 − 0.002939 =
    0.001154 US$ for the first one. In s6 it was 0.003067 − 0.001488 = 0.001579.
  - `result.result` is the empty string. The words "Compacted" arrive only as the `isReplay` user
    line.
- **Fixture.** `replay/compact-manual.jsonl` last line.

## F13 — `/compact` with nothing to compact

- **Command.** s2: a fresh session, `/compact` as its first message.
- **Seen.**
  - There is **no `status` event and no `compact_result: 'failed'`**.
  - The lines, in order: `system/init`, then an assistant text `Error: No messages to compact`,
    then a `result` with `{ subtype: 'success', is_error: false, result: '', num_turns: 0,
    local_command: 'compact', total_cost_usd: 0 }`.
  - The SDK docs mention a sibling text, "Not enough messages to compact.", for a session with a
    prompt and no reply. It was not reproduced.
- **For the code.** The real `compact_result: 'failed'` paths seen are an interrupt (F14) and an
  automatic attempt (`too_few_groups`, F20). A `/compact` whose `result` arrives with no boundary
  and no `failed` status has failed too. Its text is in the assistant message, not in `result`.
- **Fixture.** `replay/compact-empty.jsonl`, `replay/compact-failed.jsonl` (the interrupt).

## F14 — `interrupt` during a compaction

- **Command.** `/compact`, then `{ subtype: 'interrupt' }` 300 ms after `status: 'compacting'`.
- **Seen on stdout.**
  1. The interrupt is answered at once: `{ subtype: 'success', response: { still_queued: [] } }`.
  2. `status` `{ status: null, compact_result: 'failed', compact_error: 'API Error: Request was
     aborted.' }`.
  3. `system/init`.
  4. An assistant text `Compaction canceled.`.
  5. A `result` with `{ subtype: 'success', is_error: false, result: '', num_turns: 0 }`, with no
     `local_command` and the cost unchanged.
- **Seen in the file.** The caveat and command lines, then `{ type: 'system', subtype:
  'local_command', content: '<local-command-stdout>Compaction canceled.</local-command-stdout>',
  level: 'info' }`, and **no boundary**.
- **The session is left uncompacted.** The next turn still knew DOLPHIN. The next compaction's
  `pre_tokens` (17,566) counted the uncompacted history.
- **Fixture.** `replay/compact-failed.jsonl`, `recordings/claude/compacted.jsonl` lines 16-18.

## F15 — a user message written during a compaction

- **Command.** `/compact`, then a user message 300 ms after `status: 'compacting'`.
- **Seen.**
  - Nothing on stdout acknowledged it: no `queued_command` line and no refusal. In the file it is a
    `queue-operation` `enqueue` line.
  - The compaction finished normally, ending in `result` (`num_turns: 0`, `queued_turn_count: 0`).
  - The queued message then **ran as its own turn**, with a new `init` and its own `result`, after
    the compaction. Its answer recalled every codeword, so it ran on the compacted context.
- **Fixture.** `replay/compact-queued.jsonl`.

## F16 — `--resume-session-at` a uuid before the boundary

- **Command.** `--resume <s1> --resume-session-at <uuid>`, with three uuids:
  - s3: an assistant reply before the first boundary;
  - s3b: one between the first and the second boundary;
  - s3c, as a control: the last message, after the latest boundary.
- **Seen.**
  - **Both uuids before the latest boundary are refused.**
    - stderr: `No message found with message.uuid of: <uuid>`.
    - stdout: a single `result` with `{ subtype: 'error_during_execution', is_error: true,
      num_turns: 0, total_cost_usd: 0, errors: ['No message found with message.uuid of: <uuid>'] }`.
    - The process exited with code 1, with no `init`. The session file was unchanged (354 lines
      before and after).
  - The control uuid after the boundary resumed normally.
  - The CLI only knows the chain from the latest boundary on, so a rewind across a boundary is not
    possible.
- **Fixture.** None (the refusal is the single `result` line above; s3 kept no session lines).

## F17 — `--fork-session` of the compacted session

- **Command.** `--resume <s1> --fork-session`, then a `summary` and a `full` breakdown and one
  question.
- **Seen.**
  - **The fork's file holds only the latest boundary onward.** It contains:
    1. the latest boundary, with its uuid unchanged;
    2. its `isCompactSummary` line;
    3. the preserved reply;
    4. the command lines and attachments;
    5. the later turns and the new turn.
  - Every line has the new `sessionId`. The earlier boundaries and the history before them are
    gone.
  - The first `get_context_usage` gave `summary` total 18,258 ("Messages" 18) and `full` total
    17,268 ("Messages" 3,477).
  - The fork answered with every codeword, from the summary.
- **Fixture.** None separately (same line shapes as `compacted.jsonl` lines 11-15).

## F18 — `get_context_usage` while a turn runs

- **Seen.** It is answered at once, not held until the turn ends.
  - `summary` took 14 ms and `full` 205 ms, both sent 2.5 s into a turn that held a 4 s MCP call.
  - Both answers came well before the turn's `result`, and they already counted the turn's
    in-flight messages.
- **Not reproduced: latency at ~100k tokens.** The sessions stayed near 18k tokens. Filling a
  1M-window haiku session to 100k would have cost more than the rest of the recording together.
  `full` stayed at about 200 ms whatever the size seen.
- **Fixture.** None separately (timings above).

## F19 — documentation status

Published TypeScript types, `@anthropic-ai/claude-agent-sdk@0.3.301`, `sdk.d.ts`:

| Surface | Type | Doc |
| --- | --- | --- |
| the request | `SDKControlGetContextUsageRequest` (`subtype: 'get_context_usage'`, `detail?: 'summary' \| 'full'`, "Defaults to 'full'"), declared but not exported; member of `SDKControlRequestInner` | `Query.getContextUsage(opts?: { detail?: 'summary' \| 'full' }): Promise<SDKControlGetContextUsageResponse>`, <https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolgetcontextusageresponse> |
| its answer | `SDKControlGetContextUsageResponse` (exported; every field of F2 except `autocompactSource`) | same page |
| the categories | `SDKContextUsage` and `SDKContextUsageCategory`: the snake_case twin carried by the `/context` result's `context_usage`, which states the `kind` meanings and "Use `kind` (not this name) to classify the row" | same page |
| the boundary event | `SDKCompactBoundaryMessage`: `trigger`, `pre_tokens`, `post_tokens?`, `duration_ms?`, `preserved_segment?`, `preserved_messages?` | <https://code.claude.com/docs/en/agent-sdk/typescript#sdkcompactboundarymessage> (shows `trigger` and `pre_tokens` only) |
| the status event | `SDKStatus = 'compacting' \| 'requesting' \| null`; `SDKStatusMessage`: `status`, `permissionMode?`, `compact_result?: 'success' \| 'failed'`, `compact_error?` | <https://code.claude.com/docs/en/agent-sdk/typescript#sdkstatusmessage> (shows `status: "compacting" \| null` and `permissionMode?` only) |
| the summary on stdout | `SDKUserMessage` / `SDKUserMessageReplay` (`isSynthetic?`) | same page |
| the `/compact` result | `SDKResultMessage.local_command?` | same page |
| `/compact` | `slash_commands: string[]` on `system/init` | <https://code.claude.com/docs/en/agent-sdk/slash-commands>, now served under the title "Extend agents with skills". Its section "Compact history with `/compact`" sends `/compact` as a prompt and reads `compact_boundary`. It also says "Commands that act on conversation history, such as `/compact`, need prior messages to work with", and gives the "isn't available in this environment" wording |

**Not documented anywhere:** the fields listed at the top of this file, and the transcript file's
compaction fields. The rule's "files the CLI writes" covers reading the file, but no schema is
published for it.

## F20 — an automatic compaction during a live turn

- **Command.** s7 with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1` (an environment variable read by the
  shipped CLI) and three short turns.
- **Seen.**
  - **The breakdown ignored the override.** It still reported `autoCompactThreshold: 967000`,
    `autocompactSource: 'model-default'`, while compaction fired at about 18k tokens. The tick
    drawn from `autoCompactThreshold` (resolved question 1) can therefore be wrong when that
    variable is set.
  - **Turn 2.** `init`, then `status` `{ compacting, compact_output_chars: 0 }`, then
    `{ null, compact_result: 'failed', compact_error: 'too_few_groups' }` 9 ms later. The turn went
    on and answered, with `result` `num_turns: 1`.
  - **Turn 3.**
    1. `init`.
    2. `status` `compacting`, then 4.5 s later `{ null, compact_result: 'success' }`.
    3. `compact_boundary` with `trigger: 'auto'`, 18,095 → 1,094.
    4. The streamed summary (`isSynthetic: true`).
    5. The model's answer, then the real `result` (`num_turns: 2`, `result: 'noted'`, the
       turn's cumulative cost).
  - **The automatic compaction runs at the start of the turn,** before the model call, and the turn
    goes on.
  - In the file, the person's message of that turn sits **before** the boundary and is kept through
    `preserved_segment` (head = the previous reply, tail = the turn's last attachment).
- **Fixture.** `replay/compact-auto.jsonl`, `recordings/claude/compacted.jsonl` lines 19-33.
