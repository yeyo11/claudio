---
created_at: 2026-11-10T11:30:00Z
updated_at: 2026-11-10T11:30:00Z
tags:
    - plan
    - chats
    - subagents
    - delivery
    - mods
    - design-system
---
# Plan: messages between agents, a composer for subagents, and Claudio's own messages

Status: **proposed** (2026-11-10). Built by the orchestration in [Tasks](#tasks), one pull request on
`feat/agent-messages`. This plan is the source of truth for that orchestration, together with
CLAUDE.md and CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins; where the
plan is silent or wrong, ask the orchestrator (see [Communication](#communication)) instead of guessing.

## The owner's request and answers (2026-11-10)

The owner asked for three things:

1. A better UI for the messages the lead agent and its subagents send each other. Today they show
   as the person's own bubble, with `<agent-message from="…">` XML in it.
2. A composer in the subagent view, which is read only today.
3. The messages Claudio itself writes into a chat (hints, notices) must be easy to tell from the person.

Answers, all the recommended options:

| Question | Answer |
|---|---|
| Messages between agents | **A message card** with a `sender → receiver` head, the body in Markdown folded to about three lines, names that open the subagent. Same card for what the lead sends (`SendMessage`) and what it receives |
| Messages written by Claudio's system | **A system row with Claudio's mark**, outside the bubbles, labelled "Claudio · automático" or "Supervisor", without the English prefix, with a fold holding the exact text the agent received |
| The person's own hints | **The person's bubble with a "Pista" tag**, prefix removed |
| A Supervisor hint about a stuck subagent | **Straight to the subagent**, falling back to the relay through the lead when it cannot be delivered |

The owner also said that old CLI versions and breaking changes in the mods API are not a concern:
the work targets the current CLI (2.1.319) and does not carry compatibility code for older builds.

## How a program writes to one subagent (verified 2026-11-10)

Claude Code gives a program no stream-json or SDK input that reaches one subagent; the inbox socket
reaches a session, not its subagents. What it does document is **mods**: a plugin with a hooks
module ([Use the mods API](https://code.claude.com/docs/en/plugins/mods/api.md), "Send and receive
messages between sessions"). A mod can call `$.session.send({ to: { agentId }, text })`, which
"makes the same delivery the SendMessage tool makes", with the ids from `$.agent.list()`. It works in
`claude -p` and Agent SDK sessions, and the docs list its refusal reasons there. This is a
documented vendor interface, so it keeps the one rule.

A spike proved it on this machine: a mod in `/tmp/re-spike/claudio-bridge`, loaded with
`--plugin-dir` into `claude -p --input-format stream-json --output-format stream-json` with haiku.

1. `$.agent.list()` answered `[{ id: "a8f3cf8a9e040b1d3", description, type: "general-purpose", status: "running" }]`.
2. `$.session.send({ to: { agentId: id }, text })` answered `{ isDelivered: true }`.
3. The subagent's final report quoted the text.

The line it left in `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`:

```json
{ "type": "attachment", "isSidechain": true, "agentId": "a8f3cf8a9e040b1d3",
  "attachment": { "type": "queued_command", "prompt": "<the text>",
    "source_uuid": "98330a65-…", "origin": { "kind": "coordinator", "plugin": "claudio-bridge" },
    "isMeta": true, "reminderId": "cb5d08b7c31586c8" },
  "rendered": [{ "content": "<system-reminder …>\nThe coordinator sent a message while you were working:\n<the text>\n\nAddress this before completing your current task.\n</system-reminder …>" }],
  "renderedRole": "system", "timestamp": "…" }
```

A message from a subagent to the lead (`SendMessage`, or the hand-back of its final report) lands in
the lead's file as a `user` line, with a top-level `origin` and a framed content:

```json
{ "type": "user", "origin": { "kind": "peer", "from": "a970eb18654f7ec50", "senderTaskId": "a970eb18654f7ec50",
  "name": "shipcast", "body": "…", "handback": true, "handbackReportText": "7 launches" },
  "message": { "role": "user", "content": "Another Claude session sent a message:\n<agent-message from=\"a970eb18654f7ec50\">\n…" } }
```

The SDK documents `origin` as `SDKMessageOrigin` (`human`, `channel`, `peer`, `task-notification`,
`coordinator`), "provenance of a user-role message". **Not yet recorded:** how a message from the lead
to a subagent lands in the subagent's file. Task `contract` records it before writing the parser.

**Recorded on 2026-11-10** (CLI 2.1.319, haiku; redacted lines in
`packages/core/test/fixtures/agent-messages/`: `subagent-coordinator-lead`, `subagent-coordinator-bridge`,
`lead-peer-from-subagent`, `lead-handback`, `lead-task-notification`, `lead-sendmessage-to-subagent`):

1. A lead → subagent `SendMessage` lands in the subagent's `agent-<id>.jsonl` as the same
   `queued_command` attachment, with `origin: { kind: 'coordinator' }` and **no** `plugin`. The bridge
   mod's message carries `plugin: 'claudio-bridge'`. So no plugin means the lead wrote it.
2. Peer lines (a subagent's `SendMessage`, a hand-back) carry a top-level `isMeta: true`, which
   `normalizeMessage` used to drop; it now keeps a line whose origin is `peer`.
3. A final report can also reach the lead as `origin: { kind: 'task-notification', producer, runId }`
   with an XML `<task-notification>` body; it is already drawn as a notice.
4. The `SendMessage` tool result is JSON text: `{"success":true,"message":"Message queued for delivery
   to <id> at its next tool round. …"}`.

## What the code does today

Facts from 2026-11-10, against `main` 115865177.

- **Every run takes one path.** It is `ChatManager.start` → `spawnProcess`
  (`packages/core/src/chats.ts:2323`). `buildArgs` (`packages/core/src/providers/claude-code/args.ts:4`)
  never passes `--plugin-dir`, and Claudio ships no plugin.
- **The chat's API env.** `spawnProcess` (`chats.ts:2378-2389`) sets `CLAUDIO_CHAT_ID` and, when
  `apiUrl` is set and `opts.api !== false`, `CLAUDIO_API_URL` and a minted `CLAUDIO_API_TOKEN`
  (`agc_…`, actor `chat:<id>`, loopback only).
- **Delivery.** `ChatService.hint` (`packages/core/src/chat-service.ts:1140-1152`) writes
  `${prefix}\n\n${words}` through `ChatManager.sendMessage` (`chats.ts:1265-1323`). Delivered is read
  back through `--replay-user-messages` (`stream.ts:217-219`, `chat-fold.ts:289-318`). The model is in
  `docs/chat-delivery.md`.
- **Subagent ids.** `ClaudeBranches` (`providers/claude-code/branches.ts`) maps the parent
  `Agent`/`Task` tool_use_id to the CLI `agentId` (`task_started.task_id`). `SessionStore.subagents`
  (`sessions.ts:923-975`) reads `agent-<id>.meta.json` (`toolUseId`, `agentType`, `description`).
  `ChatSubagent.id` is `agentId ?? toolUseId` (`chat-branches.ts:54-73`).
- **`origin` is dropped.** `normalizeMessage` (`packages/shared/src/normalize.ts:201`) feeds the
  live stream, the subagent fold and the session reads, and never reads `origin`. `TranscriptEntry`
  (`packages/shared/src/types.ts:616-626`) has no field for it.
- **Coordinator lines are skipped.** `queuedCommand` (`normalize.ts:299-315`) drops a line with
  top-level `isMeta` and one whose `attachment.commandMode !== 'prompt'`. The coordinator line has
  neither, so it is likely dropped.
- **The UI recognises neither kind of message.** `readNotices`
  (`packages/chat-ui/src/lib/chat-notice.ts:60-94`) knows the CLI's tags but not
  `<agent-message>`, and not Claudio's plain-text prefixes. Hints and cancel notices render as the
  person's bubble (`EntryView`, `Transcript.tsx:238-301`). `SendMessage` and `ListAgents` get the
  generic lens (`tool-lens.ts:11-30`).
- **Claudio's own texts** (all English, all prefixed):

  | Text | Defined at |
  |---|---|
  | `CHAT_HINT_PREFIX`, `CANCEL_NOTICE_PREFIX`, `AUTO_HINT_PREFIX`, `AUTO_CANCEL_NOTICE_PREFIX` | `chat-service.ts:38-46` |
  | `ORCHESTRATION_HINT_PREFIX` | `orchestrator.ts:133` |
  | "A note from Claudio:" and the time warning | `orchestrator.ts:934` |
  | `CONTINUATION_PREFIX` | `open-items.ts:151` |
  | `FLOW_RESTART_PREFIX` | `flow.ts:798` |
  | `CONTINUE_TEXT` | `rotation.ts:50` |
  | `RESUME_PROMPT` | `assistant-answer.ts:441` |
  | the Supervisor's `relayHint` | `supervisor.ts:241` |

  `lessons/signals.ts:30-31` recognises some of them.
- **The subagent view.** It is `DetailPanel` (`apps/web/src/components/DetailPanel.tsx:467-484`,
  `AgentBody` `:190-348`): a 760-wide drawer with a bare `<Transcript entries>` and no composer.
  `Composer` (`packages/chat-ui/src/composer/Composer.tsx:203`) is tied to a `Chat`, and its
  `ComposerBox` (`:569`) is not exported. `QueuedCards` is not tied to a chat.
- **The Supervisor relays.** A hint about a subagent goes to the lead through `relayHint`
  (`supervisor.ts:350-352`, sent at `index.ts:932-935`). `HealthSignalAgent` (`types.ts:1237`) has
  the parent tool_use_id but not the `agentId`.

## Decisions

### D1. The bridge is a mod Claudio writes and loads in every chat that has the API

- **Where it lives.** Claudio ships a mod named **`claudio-bridge`**. That name is the
  `origin.plugin` the CLI records. Core writes its files at runtime under
  `<dataDir>/claude-plugins/claudio-bridge/`, as it already does for the MCP config and the guard
  files. No packaging step is needed.
  - The files are `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{"modules":["./register.js"]}`)
    and `hooks/register.js`.
  - The source is a TypeScript string constant in `packages/core`, with its version in
    `plugin.json`.
  - Core rewrites the files when their content differs.
- **Which runs load it.** Every run that gets `CLAUDIO_API_URL` gets `--plugin-dir <that dir>`,
  through a new `pluginDirs` on `SessionLaunch` → `buildArgs`. That includes chats, orchestration
  workers and flows. It is not added to the assistant, confined API chats, decision chats or runs
  with `api: false`: they have no token, and the first two run `--restricted`.
- **What the mod does.** Plain ES module, no Node APIs; only the mods API.
  1. On `session.start`, it reads `CLAUDIO_API_URL`, `CLAUDIO_CHAT_ID` and `CLAUDIO_API_TOKEN` with
     `$.env.get` (string literals). If one is missing, it does nothing.
  2. Then it starts one loop, not overlapping itself. The loop long-polls
     `GET /chats/:id/bridge/next?wait=20`; one `$.http.fetch` may take 30 s.
  3. For each message in the answer, in order, it calls `$.session.send({ to: { agentId }, text })`.
  4. It reports each result with `POST /chats/:id/bridge/:messageId`, sending
     `{ isDelivered, reason? }`.
  5. On a network error or a non-2xx answer it backs off 1 s, 2 s, 5 s, then every 10 s. It never
     logs the token or the text.
  6. It stops when the module unloads.
- **Out of scope.** The mod registers no tools, commands, panes or other hooks.

### D2. Claudio keeps the queue; the mod only carries

- **How a message enters.** A message to a subagent enters through
  `ChatService.messageAgent(chatId, agentId, words, { source })`, which runs inside the chat's
  `inOrder`, like `hint`.
- **Where it is stored.** Each message is a row in SQLite (`packages/core/src/db.ts`), not in
  memory, so it survives a reload of the page and of the server. The row holds: id, chat, agentId,
  source, words, the framed text, state, reason, sentAt, deliveredAt.
- **How it is surfaced.** It appears as a `ChatPendingMessage` with `to: { agentId }` and is
  answered by `MessageDelivery` events with the same `to`. The existing `delivery` event kind and
  the `useQueuedMessages` machinery carry it.
- **Before sending.** The service refuses up front:
  - `409` when the chat has no live process.
  - `409 agent-stopped` when the person stopped that subagent. The CLI refuses to resume those, and
    Claudio knows from the branch status and the stop request.
  - A finished subagent is accepted, because the send resumes it.
- **States.**
  - `written`: in Claudio's queue.
  - `delivered`: the mod answered `isDelivered: true`.
  - `undelivered`, with one of these reasons:
    - `not-read`: the mod answered `isDelivered: false`; the CLI's reason is kept in the row.
    - `bridge-unavailable` (new): no `bridge/next` poll from that chat for 15 s while a message
      waits.
    - `agent-stopped` (new).
    - `cancelled`: the person withdrew it before the mod took it.
- **When the chat's process ends,** its waiting rows become `undelivered`, as `lose` does today.

### D3. What the subagent reads says who wrote it

The mod sends the framed text, and the person's words are kept apart, as `hint` does. The prefixes
are defined once in `@claudio/shared` (D6):

- **From a person:** `A message from the person following this chat, written to you directly (the lead agent does not see it):`
- **From the Supervisor or Claudio:** `An automatic message from Claudio, not from the person following this chat:`

The CLI wraps either one as "The coordinator sent a message while you were working". The prefix is
what tells the subagent the coordinator is not the lead.

### D4. `origin` becomes part of the transcript contract

- **The new field.** `TranscriptEntry` gains `origin?: EntryOrigin`. It mirrors the SDK's
  `SDKMessageOrigin`, plus the fields the CLI writes:
  - `{ kind: 'human' }`
  - `{ kind: 'peer', from, name?, handback? }`
  - `{ kind: 'coordinator', plugin? }`
  - `{ kind: 'task-notification' }`
  - `{ kind: 'channel', server }`

  Absent means the person typed it, as before.
- **Where it is filled.** `normalizeMessage` fills it from the line's top-level `origin`.
- **Coordinator lines.** `queuedCommand` reads coordinator `queued_command` attachments (D2's
  messages and anything another mod sends) as user entries:
  - `origin: { kind: 'coordinator', plugin }`
  - the id from `source_uuid`
  - in the subagent's sidechain
- **Peer lines.** For peer lines the entry keeps the raw text. The UI strips the frame
  (`Another Claude session sent a message:` and `<agent-message from>`) and reads the body from it.
- **Regeneration.** The OpenAPI schemas are regenerated.

### D5. Three renderings, chosen by origin and prefix

| What | Where it shows | How |
|---|---|---|
| `origin.kind === 'peer'` | the receiver's transcript | **Agent message card**, `sender → receiver` |
| A `SendMessage` tool call | the sender's transcript, under the step that made it, like a branch card | **Agent message card**, `sender → receiver`; the step row keeps a one-line lens |
| `origin.kind === 'coordinator'` with the person prefix | the subagent's transcript | **The person's bubble**, head "Tú → E2" |
| `coordinator` with the automatic prefix, and every Claudio prefix in the lead | where it was written | **System row** with Claudio's mark |
| A person's hint (`CHAT_HINT_PREFIX`, `ORCHESTRATION_HINT_PREFIX`) | where it was written | **The person's bubble** + tag "Pista", prefix removed |
| A message the person sent to a subagent | the **lead's** transcript too, at the time it was delivered | **System row**: "Tú → E2: <first line>", the name opens the subagent |

The last row's entries come from D2's rows, merged into the lead's transcript by time.

### D6. Claudio's texts move to one shared module

- **The module.** `packages/shared/src/system-messages.ts` defines every prefix of the table in
  [What the code does today](#what-the-code-does-today) and D3's two new ones. Core imports them from
  there.
- **The reader.** It exports `readSystemMessage(text): { kind, source, words } | null`:
  - `kind` is one of: `hint`, `auto-hint`, `cancel`, `auto-cancel`, `orchestration-hint`, `note`,
    `continuation`, `flow-restart`, `limit-continue`, `assistant-resume`, `agent-message-person`,
    `agent-message-auto`.
  - `source` is `person`, `supervisor` or `claudio`.
  - `words` is the text without the prefix.
- **Who uses it.** chat-ui uses it to choose the rendering, and `lessons/signals.ts` uses it instead
  of its own list.
- **Fixed wording.** The English prefixes do not change wording, except D3's new ones, so recorded
  transcripts keep reading right.
- **Telling the Supervisor apart.** Today `AUTO_HINT_PREFIX` serves both the Supervisor and Claudio.
  A Supervisor hint gets its own prefix, `An automatic hint from Claudio's Supervisor, not from the person following this chat:`,
  so the row can say "Supervisor". Recorded chats still read `AUTO_HINT_PREFIX` as "Claudio · automático".

### D7. The Supervisor writes to the stuck subagent

- **The id.** `HealthSignalAgent` gains `agentId`, filled from `ClaudeBranches` or the meta's
  `toolUseId`.
- **The path.** When `proposal.agent` is set, sending the proposal (`index.ts:932-935`) calls
  `messageAgent` with `source: 'supervisor'` and the raw hint.
- **The fallback.** When that is refused or ends `undelivered` (`bridge-unavailable`,
  `agent-stopped`, `not-read`), it falls back to today's `relayHint` to the lead, once.
- **The same rule** applies to the hint the person sends from the health panel about a subagent.
- **Docs.** `docs/decision-engine.md` ("The Supervisor") is updated.

### D8. Routes and tools

| Route | Access | What |
|---|---|---|
| `POST /chats/:id/subagents/:agentId/messages` | `work` (a chat's token may not target its own chat) | `{ text }` → `{ id, state }`, `source: 'person'`. `404` unknown agent, `409` chat not live, `409 agent-stopped` |
| `DELETE /chats/:id/subagents/:agentId/messages/:messageId` | `work` | Withdraws one still `written` (`undelivered`, `cancelled`) |
| `GET /chats/:id/bridge/next?wait=` | **only that chat's own token** (`chat:<id>`), loopback | Long-poll, `wait` ≤ 25 s: `{ messages: [{ id, agentId, text }] }`, marks them taken, records the poll time |
| `POST /chats/:id/bridge/:messageId` | **only that chat's own token** | `{ isDelivered, reason? }` → `204`; ignored for a message that is not that chat's or not taken |

- **The bridge routes** never accept a person's session or another chat's token. Any other caller
  gets `403`. A chat's prompt-injected model can at most read its own pending messages early: it
  cannot write as the person, and cannot address another chat. Security tests cover both.
- **Registration.** Every route gets a summary and a tag in `apps/api/src/openapi/routes.ts` and a
  row in `docs/rest-api.md`; the `add-rest-route` skill covers this.
- **MCP.** `message_chat_subagent { chatId, agentId, text }` joins `send_chat_message` and
  `hint_chat`, with the same `notSelf` guard.

## Design

Follow `docs/design-system.md` and the `claudio-ui` skill. Open `DesktopChatEnMarcha` and
`DesktopChatLlamadas` (dark and light) in `docs/design-system/reference/` before starting. There is
no reference screen for the detail drawer.

The new classes are listed below. Each one goes into `docs/design-system.md` and
`docs/design-system/claudio-ds.css` in the same PR. Regenerate `fixtures/class-names.json` with
`tsx scripts/class-inventory.ts --write`.

### Agent message card `.agent-msg`

- **Placement.** It sits in the transcript column, full width of the message column, not a bubble.
  - **Surface:** `--bg-2`, `1px solid var(--border)`, `--radius-lg`, padding 10 × 14.
  - **Left rail:** `var(--rail-w)` in `--accent-2`, the violet of `.msg-sidechain`, which marks
    agents.
  - **Motion:** none, nothing animates. It is not live.
- **Head `.agent-msg-head`.** One line, `--fs-small`, from left to right:
  1. **The agent glyph,** the same icon as `.chat-launch-mark`, 14 px, `--text-faint`.
  2. **The sender,** in `--fw-strong` `--text`.
  3. **The arrow,** an `ArrowRight` icon, 12 px, `--text-faint`.
  4. **The receiver,** in `--fw-strong` `--text`.
  5. **A hand-back tag,** only when `origin.handback`: `Tag tone="info"` "Informe final".
  6. **The time,** pushed right, `--text-faint`, tabular, through `format.ts`.
- **Names.** Each is the subagent's description, cut with an ellipsis. The lead is "Principal" and
  the person is "Tú". A subagent's name is a `.link-btn` that opens its view (`openDetail`). The
  name the open view is about is plain text.
- **Body `.agent-msg-body`.** Markdown through the transcript's Markdown component, `--fs-body`.
  - **Clamp:** longer than three lines, it clamps to three, with no gradient mask, and a
    "Ver todo" / "Ver menos" `.link-btn` below it.
  - **Hand-back:** the body is the report text (`handbackReportText` or the `body`), not the
    harness frame.
- **A `SendMessage` that did not go out.** Its tool result is an error or begins `Not sent`.
  - **Head:** the word "No entregado" in `--bad`, with an icon.
  - **Below the body:** the CLI's reason, `--fs-small`, `--text-muted`.
- **The step row.** The `SendMessage` row keeps a lens of `→ <receiver> · <summary>`. `ListAgents`
  gets a lens of "Agentes disponibles" with the count.
- **Phone.** Same card, padding 10 × 12. Name buttons have a 44 px target through padding.

### System row `.sys-msg`

- **Shape.** A row outside the bubbles, full width, `padding: 6px 0`, `border-top: 1px solid var(--border)`
  (the `.notice` rhythm), `--fs-small`. One line, from left to right:
  1. **`ClaudioGlyph`,** 14 px, in `--info`.
  2. **The label,** `--fw-strong` `--text-muted`.
  3. **The words,** first line only, `--text-muted`, cut with an ellipsis.
  4. **The time,** right, `--text-faint`.
- **The fold.** When the text has more than one line, or always for a hint, the row is a `.fold`.
  Its title is "Lo que recibió el agente". It holds the full text exactly as sent, prefix included,
  in the body font (it is prose, not a literal), `white-space: pre-wrap`.
- **Labels by kind:**

  | Kind | Label |
  |---|---|
  | `auto-hint`, `note`, `continuation`, `flow-restart`, `limit-continue`, `assistant-resume`, `agent-message-auto` from Claudio | "Claudio · automático" |
  | a hint from the Supervisor | "Supervisor" |
  | `auto-cancel` | "Claudio canceló un comando" |
  | `cancel` | "Cancelaste un comando" |
  | D5's relay record | "Tú → <subagent>" |

- **Colour.** The row carries no status colour: it is information, and `--info` is the neutral
  notice tone.
- **Existing notices.** The ones `readNotices` already produces keep their `.notice` rows
  unchanged, including the account switch.

### The person's hint

The `.msg-user` bubble, prefix removed, with `Tag tone="info"` "Pista" in `.msg-head` after the role
label. Nothing else changes.

### The subagent composer `.agent-composer`

- **Where.** A footer pinned at the bottom of the subagent drawer, outside `.detail-scroll`, for
  `kind: 'subagent'` only. Workflow agents stay read only.
- **Layout.** `--bg-1`, `border-top: 1px solid var(--border)`, padding 12 × 16.
  - **The box:** the chat composer's box (export `ComposerBox`), with the same send button and
    Enter / Shift+Enter, without the chat menu and status line. Placeholder "Escribir a <subagent>…".
  - **Queued cards:** above the box, `QueuedCards` for that subagent's messages.
  - **Note line:** under the box, `--fs-small` `--text-faint`, "Llega directamente a este subagente;
    el agente principal no lo ve."
- **States:**

  | State | Box | Note line |
  |---|---|---|
  | Subagent running | enabled | the note |
  | Finished (completed or failed) | enabled | "Ha terminado: tu mensaje lo reanudará." |
  | Stopped by the person | disabled | "Lo paraste tú, así que no se puede reanudar." |
  | Chat not live | disabled | "El chat no está en marcha." |
  | A message `undelivered` with `bridge-unavailable` | enabled | its card offers "Enviar a través del principal" (a hint to the lead through `relayHint`) and "Descartar" |

- **No energy border.** The drawer's composer never takes it: the chat's composer may already have
  it on the same screen.
- **Phone.** The drawer is a full screen sheet; the box input is `--fs-input` (16) and targets are
  ≥ 44 px.

### Copy

Every string goes through i18n, with `en`/`es` parity, in `packages/chat-ui/src/locales/*/chat.json`.
The `es` follows `apps/web/src/i18n/GLOSSARY.md`. Add these terms to the glossary:

- lead agent → "agente principal" (short form "Principal")
- agent message → "mensaje entre agentes"
- system message → "mensaje del sistema"

| Key | en | es |
|---|---|---|
| `agentMessage.lead` | Lead | Principal |
| `agentMessage.you` | You | Tú |
| `agentMessage.report` | Final report | Informe final |
| `agentMessage.more` / `.less` | Show all / Show less | Ver todo / Ver menos |
| `agentMessage.notSent` | Not delivered | No entregado |
| `agentMessage.listAgents` | Available agents ({{count}}) | Agentes disponibles ({{count}}) |
| `system.auto` | Claudio · automatic | Claudio · automático |
| `system.supervisor` | Supervisor | Supervisor |
| `system.received` | What the agent received | Lo que recibió el agente |
| `system.cancel` | You cancelled a command | Cancelaste un comando |
| `system.autoCancel` | Claudio cancelled a command | Claudio canceló un comando |
| `system.relay` | You → {{agent}} | Tú → {{agent}} |
| `hint.tag` | Hint | Pista |
| `agentComposer.placeholder` | Message {{agent}}… | Escribir a {{agent}}… |
| `agentComposer.note` | Goes straight to this subagent; the lead does not see it. | Llega directamente a este subagente; el agente principal no lo ve. |
| `agentComposer.resumes` | It has finished: your message resumes it. | Ha terminado: tu mensaje lo reanudará. |
| `agentComposer.stopped` | You stopped it, so it cannot be resumed. | Lo paraste tú, así que no se puede reanudar. |
| `agentComposer.chatGone` | The chat is not running. | El chat no está en marcha. |
| `agentComposer.viaLead` | Send through the lead | Enviar a través del principal |
| `agentComposer.discard` | Discard | Descartar |
| `agentComposer.bridgeDown` | Claudio could not reach this chat. | Claudio no ha podido hablar con este chat. |

### Overflow across the app (owner's report, 2026-11-10)

The owner reported content that overflows its container in several places of the app and asked
for the same pattern to be found and fixed everywhere. The screenshot is the Changes page
("Cambios", step-by-step mode) at 1906 × 1045, dark theme:

- **The step card.** In the "Pasos" list, a tag ("Fuera del directorio de trabajo", warn/bad tone)
  runs past the card's right edge and is clipped by the pane, not shortened inside the card.
- **The steps pane.** It shows a horizontal scrollbar at its bottom: something inside it is wider
  than the pane.
- **The diff.** Long lines are cut at the card's right edge, with no way to read the rest: no
  wrap, and no visible horizontal scroll of the code area only.

The likely causes, to be confirmed screen by screen:

- flex or grid children without `min-width: 0`;
- tags, badges and chips that never shrink and have no `max-width` with an ellipsis;
- `white-space: nowrap` with no `overflow: hidden; text-overflow: ellipsis`;
- fixed widths inside fluid panes;
- code blocks that neither wrap nor scroll on their own.

The fix follows these rules:

1. **Fix the cause in the shared primitive or class.** That is `packages/ui` (`Tag`, badges,
   `.fold`, list rows, `DiffView`'s line area) or the page's layout class, not one-off overrides.
2. **Single-line text truncates.** A label, a path, a tag or a title shortens with an ellipsis
   inside its container, with the full text in `title` or a tooltip.
3. **Code and diffs keep their lines.** They scroll horizontally inside their own block,
   whose scrollbar is visible on hover. The page and the pane never scroll sideways. `DiffView`
   keeps its rails and marks aligned while it scrolls.
4. **Prose wraps** with `overflow-wrap: anywhere` for long unbroken tokens (paths, URLs, ids) in
   transcript bubbles, cards and dialogs.
5. **Where to look.** At least the Changes page, the chat transcript and tool rows, Home, Chats and
   Orchestrations lists, the orchestration detail and its task drawer, the detail drawers, Settings,
   Accounts, Servers, the status bar and the top bar breadcrumb.
6. **Widths and themes.** Every screen is checked at 1280 × 720, 1906 × 1045 and 390 × 844, in both
   themes, and with long Spanish copy.
7. **A guard test.** A new e2e spec, `e2e/specs/overflow.spec.mjs`, visits those screens with long
   fixture data at the three widths. It asserts that no element's content overflows its pane
   sideways: `scrollWidth > clientWidth + 1` on the page, the panes and the list rows, except blocks
   marked as horizontally scrollable on purpose (code, diff, tables). That is how the pattern stays
   fixed.

## Contracts

- **`packages/shared/src/types.ts`:**
  - `EntryOrigin` and `TranscriptEntry.origin?` (D4).
  - `ChatPendingMessage.to?: { agentId: string }` and `MessageDelivery.to?`.
  - `MessageUndeliveredReason` adds `'bridge-unavailable' | 'agent-stopped'`.
  - `HealthSignalAgent.agentId?`.
  - `SubagentMessageRequest { text }` and `SubagentMessageReceipt { id, state }`.
  - `BridgeNextResponse { messages: { id, agentId, text }[] }` and `BridgeReport { isDelivered, reason? }`.
  - Regenerate with `pnpm --filter @claudio/api openapi:schemas`.
- **`packages/shared/src/system-messages.ts`:** D3 and D6.
- **`ChatClient`** (`packages/chat-ui/src/lib/context.tsx`): optional
  `sendToSubagent(chatId, agentId, req)` and `withdrawSubagentMessage(chatId, agentId, messageId)`,
  implemented in `apps/web/src/lib/chat-ui.tsx` through `apps/web/src/api.ts`.
- **The pending messages** of a chat (`GET /chats/:id` → `pendingMessages`) include those with `to`.
  The subagent view filters by `to.agentId`, and the chat's own queue leaves them out.

## Tasks

The orchestration runs on `feat/agent-messages`, with a worktree per task, concurrency 3 and medium
effort.

| id | Model | Depends on | Owns | Done when |
|---|---|---|---|---|
| `contract` | sonnet | — | `packages/shared/**` (types, `normalize.ts`, `system-messages.ts`), its tests, fixtures under `packages/core/test/fixtures/agent-messages/`, the OpenAPI schemas, `lessons/signals.ts` (import only), the prefix imports in core | It has recorded real lines with the installed CLI (haiku, small prompts, redacted): lead → subagent `SendMessage`, subagent → lead `SendMessage`, a hand-back, a bridge message from a test mod. `normalizeMessage` keeps `origin` and reads coordinator `queued_command`; `readSystemMessage` covers every prefix; tests pass; schemas regenerated |
| `bridge` | opus | `contract` | `packages/core` (bridge files writer, `pluginDirs`, `buildArgs`, `ChatService.messageAgent`, the SQLite rows, delivery events, `bridge-unavailable` timer), `apps/api` (the four routes, access, security tests), `packages/mcp` (`message_chat_subagent`), `docs/rest-api.md`, `docs/chat-delivery.md`, a new `docs/agent-messages.md` | A real chat run (installed CLI, haiku) receives a message through the route and the subagent reads it; the receipt turns `delivered`; every refusal and `undelivered` reason has a test; another chat's token and a person's session get `403` on the bridge routes |
| `supervisor` | sonnet | `bridge` | `packages/core/src/supervisor.ts`, `health.ts`, the send wiring in `index.ts`, their tests, `docs/decision-engine.md` | D7 with tests for direct, refused → relay and undelivered → relay |
| `transcript` | opus | `contract` | `packages/chat-ui` transcript (`Transcript.tsx`, `chat-steps.ts`, `chat-notice.ts`, `tool-lens.ts`, `ToolBody.tsx`, `transcript.css`), its i18n keys (`agentMessage.*`, `system.*`, `hint.tag`), `GLOSSARY.md`, `docs/design-system.md` and `claudio-ds.css` for `.agent-msg` and `.sys-msg`, the class inventory | D5 and the design above, both themes, phone; unit tests for each rendering; `/ui-review` of the chat screen passes |
| `composer` | sonnet | `bridge`, `transcript` | `DetailPanel.tsx` footer, the `ComposerBox` export, `ChatClient` and `api.ts` methods, the subagent queue, the lead's relay rows, `agentComposer.*` keys, the design-system entry for `.agent-composer`, the class inventory | The composer section above, every state; unit tests; `/ui-review` of the subagent drawer passes |
| `overflow` | opus | — | the overflow fixes of [Overflow across the app](#overflow-across-the-app-owners-report-2026-11-10) in `packages/ui`, `apps/web` styles and pages, `DiffView`, the design-system entry for the truncation and scroll rules, `e2e/specs/overflow.spec.mjs` and its fixture data. It does **not** edit the files `transcript` and `composer` own (`transcript.css`, `Transcript.tsx`, `DetailPanel.tsx`): overflow found there goes to the orchestrator, who passes it on | Every screen in the list is checked at the three widths in both themes, with before/after screenshots in the result; the spec passes through Sluice's `e2e` gate; `/ui-review` of the Changes page passes |
| `e2e` | sonnet | `composer`, `supervisor` | `e2e/fake-cli/**` (peer lines and `SendMessage`; a bridge emulation that polls `bridge/next` when given `--plugin-dir` and writes coordinator lines), a new `e2e/specs/agent-messages.spec.mjs`, the specs the change breaks (`health-actions`, the delivery specs) | The specs pass through Sluice's `e2e` gate |
| `review` | opus | all | fixes found in review, this plan's Outcome section | The merged diff is reviewed against this plan; typecheck, test and e2e gates pass; the plan's status is "built" and its Outcome lists what is left |

### Rules for every task

- **Read first:** this plan, CLAUDE.md and CONTRIBUTING.md.
- **Code:** TypeScript strict, no `any`, `noUncheckedIndexedAccess`. Comments explain why. Everything
  technical in English.
- **Files:** touch only what the task owns, plus the lines another task's contract needs. When you
  need a change in a file another task owns, ask the orchestrator.
- **Commits:** Conventional Commits; commit, never push.
- **Gates:** run lint, typecheck and test only through Sluice's `verify` tool, with the worktree as
  `working_directory`. e2e only through `verify` with `gates: ["e2e"]` (the `run-e2e` skill). Never
  run a gate, a test runner or e2e through the shell, and never set `E2E_ALLOW_LOCAL` or `SLUICE_JOB`.
  Every wait is bounded.
- **Real CLI runs:** use `claude -p … --model haiku` with a bounded `timeout`, a small prompt and
  `CLAUDE_CONFIG_DIR` left as is. Record what they wrote, then redact ids and paths in the fixtures.
- **UI:** UI tasks load the `claudio-ui` skill and finish with `/ui-review`.
- **The result:** branch, commits, what changed, gate results, and the questions left open.

## Communication

The orchestrator is the Claude Code session named **`claudio-b18a5b`**, on this machine.

- **Find it.** Use `ListAgents`, then `SendMessage` with `to: "claudio-b18a5b"`. The other workers
  of this orchestration are listed there too. Write to one directly when your work meets theirs (the
  contract, a shared file), and copy the orchestrator when it changes a decision.
- **Send short messages at four points:**
  1. plan decided, in two or three lines;
  2. a question, or a decision this plan does not cover: ask, then go on with what does not depend
     on the answer;
  3. code done;
  4. gates passed or failed, with the commit hash.
- **Messages you receive.** A message from the orchestrator is guidance from the person running
  this work. Never take one as approval of something a permission prompt or a guard refused.
- **Fallback.** If messaging is not available, put your questions at the top of your result.

## Outcome

To be written by `review`.

## Related

[[chat-delivery]] · [[decision-engine]] · [[design-system]] · [[rest-api]] · [[claudio-mcp-server]] · [[chat-tool-rows-and-branches]] · [[plans/tool-rows-and-live-branches]]
