---
created_at: 2026-11-10T14:00:00Z
updated_at: 2026-11-10T19:10:00Z
tags:
    - chats
    - subagents
    - delivery
    - mods
    - api
---
# Messages to one subagent: the `claudio-bridge` mod

How a person (or Claudio's Supervisor) writes straight to one subagent of a running chat, without
the lead agent seeing it. Built on 2026-11-10 from D1, D2, D3 and D8 of
[plans/agent-messages.md](plans/agent-messages.md).

## Why a mod

Claude Code gives a program no stream-json or SDK input that reaches one subagent: the inbox socket
reaches a session, not its subagents. What it documents is **mods** ("Send and receive messages
between sessions" in the mods API): a mod may call `$.session.send({ to: { agentId }, text })`,
which makes the same delivery the `SendMessage` tool makes, with the ids `$.agent.list()` gives, and
it works in `claude -p`. A documented vendor interface, so it keeps the one rule (CONTRIBUTING).

Rejected: writing to the lead and asking it to relay (the lead reads and rewrites the words, which is
what the Supervisor's relay already does and what the owner wanted to avoid); scraping or a second
session (both break the one rule).

## The mod

- **Files.** `packages/core/src/bridge-mod.ts` holds the mod as string constants and writes them at
  every spawn that loads it, only where they differ, under `<dataDir>/claude-plugins/claudio-bridge/`:
  `.claude-plugin/plugin.json` (name `claudio-bridge`, its version), `hooks/hooks.json`
  (`{"modules":["./register.js"]}`) and `hooks/register.js`. No packaging and no install: the
  directory is passed with `--plugin-dir` (`SessionLaunch.pluginDirs` → `buildArgs`), for that
  process only.
- **Which runs load it.** Every run handed a chat token (`CLAUDIO_API_URL` and `CLAUDIO_API_TOKEN`):
  chats, orchestration workers, flows. Never the Claudio assistant or a confined API chat (they run
  `--restricted` and hold no token), nor a run with `api: false` (decisions, the Supervisor's
  questions, evals, one-shots). `ChatManager.loadsBridge` decides.
- **What it does.** On `session.start` it reads the three variables with `$.env.get`; with one
  missing it does nothing. Then one loop that never overlaps itself: poll
  `GET /chats/:id/bridge/next?wait=0` once a second (at once again after a poll that found messages),
  `$.session.send` each message in order, report each answer
  with `POST /chats/:id/bridge/:messageId` (`{ isDelivered, reason? }`). On a network error or a
  non-2xx it backs off 1 s, 2 s, 5 s, then every 10 s. It never logs the token or a text, registers
  nothing else (no tool, command, pane or other hook), and its timers stop when the module unloads. It never long-polls: the CLI waits for a
  `$.http.fetch` in flight before its process exits, and that call takes no abort signal, so a held
  poll kept every run alive for up to its wait after its last turn (a re-run of an orchestration task
  found the old process still up).
- **Its name** is what the CLI records as `origin.plugin` on the line the subagent receives, so the
  page can tell a bridge message from the lead's `SendMessage` (which has no plugin).

## Claudio keeps the queue

`packages/core/src/agent-messages.ts` (`AgentMessages`, on `ChatManager.agentMessages`):

- **Rows.** Table `agent_messages` (`db.ts`): id, chat, agent id, source, the words, the framed text,
  state, reason code, reason, sent, taken and delivered times, and `dismissed`. Rows, so a reload of
  the page or of the server still finds each message; they go with their chat (`CHAT_ROW_TABLES`).
- **Entry.** `ChatService.messageAgent(chatId, agentId, words, { source })`, inside the chat's
  `inOrder` like `hint`. It refuses up front: `409` when the chat has no live process, `404` for an
  unknown subagent (or one whose CLI agent id is not known yet), `409 agent-stopped` when the
  subagent was stopped (the CLI does not resume those). A finished subagent is accepted: the send
  resumes it. The id may be the CLI agent id or the launching tool call's id.
- **The frame.** The subagent reads who wrote it, since the CLI calls every such message the
  coordinator's (D3; prefixes in `@claudio/shared`'s `system-messages.ts`): a person's words begin
  with `AGENT_MESSAGE_PERSON_PREFIX`, the Supervisor's or Claudio's with `AGENT_MESSAGE_AUTO_PREFIX`.
- **States.** `written` (in Claudio's queue), `taken` (handed to the mod, its answer not in),
  `delivered`, `undelivered` with a reason:

  | Reason | When |
  |---|---|
  | `not-read` | the mod answered `isDelivered: false`; the CLI's sentence is kept as `reason` |
  | `bridge-unavailable` | no `bridge/next` poll from the chat for 15 s while the message waited; a poll held open counts as present |
  | `agent-stopped` | the subagent was stopped after the message was written; it is settled instead of handed out |
  | `cancelled` | the person withdrew it before the mod took it |
  | (none) | the chat's process ended first, with the sentence `lose` uses for the lead's messages |

- **What the page sees.** `GET /chats/:id` lists them in `pending` with `to: { agentId }` (the words,
  never the frame; `taken` reads as `written`), plus the newest 20 lost ones until dismissed or until
  the person writes to the same subagent again. The chat's stream carries `delivery` events with the
  same `to`. The chat's own queue must leave out the ones with `to`.
- **Record.** `AgentMessages.history(chatId)` returns every row, for the lead's transcript to merge
  ("Tú → E2" relay rows, D5).

## Routes and access

| Route | Who |
|---|---|
| `POST /chats/:id/subagents/:agentId/messages` | `work`; a chat's token may not target its own chat (`403 chat-not-self`) and sends only `text` |
| `DELETE /chats/:id/subagents/:agentId/messages/:messageId` | `person` (every DELETE is the person's in this API, `route-access.test.ts`): withdraws a `written` one (`cancelled`) or dismisses a lost one; `409 taken` once taken |
| `GET /chats/:id/bridge/next?wait=` | **only that chat's own token, from this machine**: long poll, `wait` ≤ 25 s |
| `POST /chats/:id/bridge/:messageId` | **only that chat's own token, from this machine**: `204`; ignored for a message not taken from this chat |

The bridge routes refuse a person's session, the owner's token and another chat's token with
`403 bridge.own-chat-only`, in every auth mode (`CHAT_OWN_BRIDGE` in `apps/api/src/security.ts`). A
chat's prompt-injected model can at most take its own pending messages early: it cannot write as the
person, report for another chat or read another chat's queue. Claudio's MCP server has
`message_chat_subagent { chatId, agentId, text }`, refused for the chat it runs in (`notSelf`).

## What the CLI writes (recorded 2026-11-10, CLI 2.1.319)

The message reaches the subagent's `agent-<id>.jsonl` in one of two shapes, both with
`origin: { kind: 'coordinator', plugin: 'claudio-bridge' }`:

- while the subagent waits: a `queued_command` attachment whose `prompt` is the framed text;
- while it is busy in a tool round: a meta `user` line whose content is
  `The coordinator sent a message while you were working:\n<framed text>\n\nAddress this before completing your current task.`

`normalizeMessage` keeps both as user entries in the sidechain (fixtures
`subagent-coordinator-bridge` and `subagent-coordinator-bridge-busy` in
`packages/core/test/fixtures/agent-messages/`); a reader strips the CLI's frame before
`readSystemMessage`.

**Proved end to end** with the installed CLI and haiku: a chat whose lead launched a background
subagent took a person's message through `POST /chats/:id/subagents/:agentId/messages`, the row
turned `delivered` within two seconds, the subagent's transcript showed the coordinator entry, and the
subagent quoted the words in its answer.

## Related

[[plans/agent-messages]] · [[chat-delivery]] · [[rest-api]] · [[claudio-mcp-server]] · [[security-model]]
