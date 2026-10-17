---
created_at: 2026-10-16T14:00:00Z
updated_at: 2026-10-16T14:00:00Z
tags:
    - chat
    - transcript
    - tool-calls
    - subagents
    - background-tasks
    - design-system
    - claudio
---
# Tool rows that read as what happened, and what is running at a glance

Two things on the chat page. An opened tool call shows what it did (a diff, a file with line numbers,
a command and its output) instead of its input as JSON and its result as a wall of text. And a thin
strip above the composer says which subagents, background commands and workflows are running right
now, what each subagent is doing, and a card under the step that launched each one keeps the record.
The plan, with the design the owner settled before any code, is
[plans/tool-rows-and-live-branches.md](plans/tool-rows-and-live-branches.md); this is the feature as
built. The rules of the screens are in [design-system.md](design-system.md#tool-rows-and-live-branches).

## The one rule

Everything is read from what the Claude Code CLI already ships for programs:

- `tool_use_result` on the `user` events of its stream-json, and `toolUseResult` on the lines of its
  transcript file;
- the sidechain `assistant`/`user` events it streams with `parent_tool_use_id`;
- its `task_started`, `task_updated`, `task_progress`, `task_notification` and
  `background_tasks_changed` system events, folded by `packages/core/src/providers/claude-code/branches.ts`.

No second process, no scraping, no new flag.

## What a reader sees

**The folded row is unchanged**: the tool's icon, its name in mono, a hint, "failed" when it failed,
and the rail coloured by outcome. Only the opened body changed, and nothing opens by itself.

**The strip** is one line between the conversation and the composer, drawn only while a branch runs
or ended less than 5 s ago. Folded (the default), it reads like
`⠋ 2 agents · 1 background task    Explore · reading packages/core/src/chats.ts · 0:42   ⌄`:
the braille spinner, the count per kind (only kinds that are not zero), and the newest activity in
mono. Opened, one row per branch: its state, its kind as a badge, its description, the subagent's own
activity and its clock. A row is a button that opens the branch's panel. A branch a subagent launched
sits under it, indented. A finished row shows its icon and word ("done", "failed", "stopped") for 5 s
and leaves. On a phone the bar is 44 px and the list is a `Sheet` titled "En marcha" / "Running now".

**The cards** (`.chat-launch`) sit under the step whose call started a branch: `.is-agent`,
`.is-task`, `.is-workflow`. A running card carries the live rail; no card takes a gradient, the
workflow card included. A card stays after its branch ended, with its final word and duration: it is
the conversation's record. A subagent that is running reads its own activity in the strip, the
inspector's Branches card and the subagent panel's status line.

## The lenses

`lensOf(name)` in `packages/chat-ui/src/lib/tool-lens.ts` picks the lens from the tool's name;
`components/ToolBody.tsx` draws it. Every lens has the same frame: one or two zones headed by a mono
section label ("Call" / "Result", or "Change"), and a `Raw` / `Readable` toggle that swaps to the JSON
of the input and the raw text of the result.

| Tool | Call zone | Result zone |
|---|---|---|
| `Bash` | the command as shell code; `timeout` and "in the background" as a mono meta line | stdout as a terminal block; stderr under it as "Errors"; a warn tag "interrupted"; a backgrounded call reads "Launched in the background" |
| `Read`, `NotebookRead` | none (the hint carries the path) | numbered, highlighted code from `startLine`, the `N\t` / `N→` prefixes stripped; 120 lines, then "Show all" |
| `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | the unified diff the CLI recorded, through the app's diff slot (zone "Change") | the error text when the call failed |
| `Grep`, `Glob` | the pattern and the options that were set | files mode a list of relative paths, content mode the matching lines, count mode "N matches" |
| `WebFetch` | URL and prompt | the answer as Markdown, with status and bytes when the detail has them |
| `WebSearch` | the query | the answer as Markdown |
| `Agent`, `Task` | kind and model as tags, "in the background", the prompt behind a closed fold | the report as Markdown; a background one "Launched in the background" |
| `TodoWrite`, `Task*` planning tools | a checklist, one row per item with its status word | the raw toggle only |
| everything else, `mcp__*` included | the input as a field list, two levels deep | the text read for what it is: a JSON tree, Markdown, or preformatted text, capped at 6 000 characters |

Details that are not obvious from the table:

- Paths are shown relative to the chat's folder (`useRiskContext().cwd`).
- An `Edit` with no recorded patch (a transcript older than the CLI field) falls back to the generic
  lens rather than a diff guessed in the browser.
- A failed call keeps its Call zone and shows the error as the Result.
- A Read draws its own numbered code. Line numbers come from a CSS counter (`.call-lines`), so copying
  the text leaves them out.
- The diff slot (`slots.Diff` in `packages/chat-ui/src/lib/context.tsx`) is provided by
  `apps/web/src/components/changes/DiffSlot.tsx` over `DiffView`: unified, `trimEdges`, wrapped on a
  phone, held to 360 px with "Show all". The chat package never imports the comparator.
- The sentence "This tool result is internal metadata…" of an `Agent` result is never shown.

## The rules of the strip

`packages/chat-ui/src/lib/chat-branches.ts` is a pure model (the unit tests are in
`packages/chat-ui/test/chat-branches.test.ts`):

- **Shown**: a branch that is running, or ended less than `BRANCH_GRACE_MS` (5 000 ms) ago, oldest
  first so rows do not jump.
- **Nesting**: a task a subagent launched sits under it; once that subagent has left, it stands alone.
- **The bar** counts the running agents, tasks and workflows and shows the newest subagent activity,
  else the newest branch's description and clock.
- **Matching a step's calls to its branches** (`branchesOfStep`): an `Agent` call by
  `detail.agentId`, or by its call id while the subagent still carries it; a background `Bash` by
  `detail.backgroundTaskId`, or by its command when only one task fits; a workflow by time. The
  description fallback is used only where no id was recorded.
- **Storage**: the fold is remembered under `claudio-chat-branches` in `localStorage` (`'open'` or
  `'closed'`, default closed). A phone's `Sheet` is not remembered. With nothing to show the strip is
  not in the DOM.
- **Screen readers**: the bar is `role="status"`, announced at most once every 5 s; the list is
  labelled "Running now".

## The protocol fields read

- `ToolResultDetail` (`packages/shared/src/types.ts`) rides on `tool_result.detail`. `toolResultDetail`
  in `packages/shared/src/normalize.ts` decides its kind from the **shape** of the CLI's object:
  `file` (Read), `patch` (Edit/Write, as unified text through `packages/shared/src/patch.ts`),
  `command` (stdout/stderr/interrupted/`backgroundTaskId`), `matches` (Grep/Glob), `fetch`,
  `agent` (`agentId`, background, model) and `data` for any other object under 8 000 characters. It
  is carried by `GET /chats/:id`, the `message` events, the subagent endpoint and the JSON export, and
  read in `partsOf` (`chat-steps.ts`) as `StepCall.result.detail`. The result text stays the record.
- `ChatSubagent.activity` and the `subagent.activity` event. Core keeps one `ChatActivityTracker`
  per running sidechain, keyed by the launching call's id (`live-chat.ts`, `chat-fold.ts`); a
  `tool_result` of the launching call or the agent's `task_notification` clears it. The publisher
  (`event-sources.ts`) emits at most one event per subagent per second and never repeats an unchanged
  activity. A subagent's activity comes from its calls only, since the stream drops its text deltas.
- On the web, `patchSubagentActivity` (`apps/web/src/lib/events.ts`) writes the activity into both
  chat-detail caches and the subagents lists, matching by call id or agent id, and refetches nothing.

## Whether it is still going on

One fact decides it: `Chat.alive`, true while a process holds the chat (an execution of Claudio's, or
a terminal's or another program's), computed in `chat-service.ts` from the same sources the branch
reader uses. A branch is running only in a chat that is alive.

- **Core settles what nothing holds.** `toChildren(facts, id, settleAt)` (`chat-branches.ts`) turns every
  `running` child of a chat that is not alive into `stopped` with an `endedAt` (the last execution's
  end, else the session's last write). A workflow's agent that never reported is clamped to its
  workflow's status. Every producer goes through it: the chat, the lists, and the subagent panel
  (`agentTranscript` takes its status from the same branch facts, so the panel and the strip agree).
- **The disk fold** counts a foreground `Agent` call's own result (`toolUseResult.status` is
  `completed`) as the agent's stop; a background launch (`async_launched`) is ended by its
  notification. A task stopped because its session ended gets the session's last write as `endedAt`,
  so clocks stop.
- **The stream** closes a foreground agent at the end of a turn (`endForeground`), as `trace()` closes
  open calls; a process that ends marks what it took down `stopped`, the word screens use.
- **A workflow** is running only with a matching active run on the stream (`mergeLiveWorkflows`).
- **A terminal session that lets go** writes no file, so `SessionsWatcher` also compares who holds
  which session every few seconds while someone follows the feed, and emits `sessions.changed`.
- **The client** asks `packages/chat-ui/src/lib/liveness.ts`: `chatAlive`, `branchLive`,
  `effectiveBranch` (a running branch of a chat nothing holds reads stopped), `workflowAgentLive`,
  `chatBusy` (for lists and the shell) and `openCallInTurn` (the call in flight, looking only after
  the last message a person sent). The strip, the cards and the polling intervals read through it.

## Copy

Strings are under `transcript.call.*` (the lenses) and `branches.*` (the strip and cards) in
`packages/chat-ui/src/locales/{en,es}/chat.json`. The transcript's old `launch.*` keys became
`branches.*`. `showAll`, `matches` and `items` take `_one` / `_other` forms.

## Related

[[plans/tool-rows-and-live-branches.md]] · [[design-system.md]] · [[plans/chat-experience.md]] ·
[[context-control.md]] · [[chat-delivery.md]] · [[providers.md]] · [[status.md]]
