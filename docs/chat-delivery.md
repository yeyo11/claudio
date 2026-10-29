---
created_at: 2026-10-08T18:00:00Z
updated_at: 2026-10-30T09:00:00Z
tags:
    - chats
    - providers
    - api
    - decision
---
# Chat delivery: every message tracked by id

How a message a person, Claudio or its Supervisor sends to a chat is identified, sent, held,
delivered or reported undelivered, and what the page offers while it waits. Built for CW-37 from the
fix plan of the chat message audit ([reports/chat-audit/README.md](reports/chat-audit/README.md)),
and moved to its present design by the regression fixes of 2026-10-29
([plans/regression-fixes-2026-10-29.md](plans/regression-fixes-2026-10-29.md), D3, D4 and C2;
[reports/regression-audit-2026-10-29.md](reports/regression-audit-2026-10-29.md) §1). Before CW-37,
nothing said which message the agent had read, so the page guessed from the words and a clock.

## The id

- Every message has an id, a UUID. The page chooses it (`POST /chats/:id/messages` with `id`) and
  sends it again unchanged when it retries the same words and files after a failure, so a send that
  timed out after the server took it reaches the agent once: a second request with an id already
  taken writes nothing and answers as the first did (`message.duplicate: true`). Without one the
  server picks an id. The page builds it with `crypto.getRandomValues`, since `randomUUID` exists only
  in a secure context and the app is often opened over plain http on the local network.
- The id is the message's everywhere: the `uuid` of the entry the server streams for it, the id the
  agent is given, and the id its transcript keeps.

## Who a message comes from

Every message carries a `source` (`ChatMessageSource`): `person` (typed in the composer, or a hint
from the page), `supervisor` (a hint the Supervisor sent on its own) or `claudio` (a note Claudio
wrote, such as the notice that a command was cancelled). Rows stored before the field existed read
as `person`.

- A person's hint (`POST /chats/:id/hint`, or a Supervisor proposal a person pressed Send on) is
  framed for the agent as `A hint from the person following this chat:`; one the Supervisor sends on
  its own as `An automatic hint from Claudio, not from the person following this chat:`
  (`AUTO_HINT_PREFIX`). The lessons' signals read only the person's prefix, so an automatic hint is
  never counted as the person's correction. A command cancelled on Claudio's own initiative is told
  to the agent as `Claudio cancelled the command on its own`, not as a person's cancel.
- `pending[].text` is the words without that framing; the agent gets the framed text.
- A hint and a notice go through the chat's sends in order (`ChatService.inOrder`), like a person's
  message: two quick writes reach the agent in the order they were made, whoever made them.

## Sending, per provider

- **Claude Code.** The id goes as the stream-json `uuid` of the stdin line, and the CLI runs with
  `--replay-user-messages`. The CLI reads each message back (`isReplay: true`, same `uuid`) the moment
  it takes it: when its turn starts, or right after the tool result at which it absorbs it into the
  running turn. The transcript keeps the id: the message's `user` line has it, and a message read
  mid-turn, which the CLI writes only as an `attachment` line of type `queued_command`, carries it as
  `source_uuid`; the transcript reader turns that line into the person's entry under that id. When an
  interrupt merges several queued messages into one prompt, each is read back, and the merged line
  takes the last one's id. All of it was confirmed on CLI 2.1.288
  ([reports/chat-audit/server.md](reports/chat-audit/server.md), "Confirmed on the CLI").
- **Whether a process reads back is known from its handshake.** The driver answers it from the
  version the `init` reports (`ProviderDriver.readsBack`, `claudeReadsBack`): every CLI in the
  driver's range reads back. Only a CLI that names no version is still judged at its first result: a
  first turn that ends with nothing read back means it does not, and what is written to it is
  followed no further. Before, a first turn that was a local command switched following off for the
  life of the process.
- A driver that queues turns itself reports a message taken when it starts its turn, and while it
  holds one the chat's input is not ended, even for a `keepAlive: false` chat
  (`DriverSession.holdsTurns`). Claude Code's driver does not queue, so this stays a property of the
  interface.

## What the server keeps

`LiveChat.pending` holds every message the agent has not taken, in the order sent:

- `written`: in the agent's own queue. It leaves the list when the agent reads it back (the
  `delivered` driver event), and it is bounded, so a message the agent never takes cannot keep a chat
  busy, its card waiting and its run slot held (report §1.1):
  - **The turn it opened.** A message written while no turn of the lead's was under way opens one;
    that turn's result says the agent took it, read back or not (a local command reads nothing back).
  - **The interrupt's receipt.** The CLI answers an interrupt with `still_queued`, the ids still in its
    queue, written before the interrupted turn's result. A message written before the interrupt that
    is neither listed there nor read back already was dropped on the way (a `UserPromptSubmit` hook
    can end a prompt, and the CLI says so on no documented channel): it is settled `undelivered` with
    `reason: 'not-read'` at once. An older CLI that answers without the field settles nothing.
  - **The result.** A message written into a turn is read back right after that turn's result, when
    the CLI starts its next turn on it. The chat stays `busy` for that moment
    (`CLAUDIO_READ_BACK_MS`, 5 s); one not read back by then, with no turn started, is settled
    `not-read` and the chat goes idle. A turn the CLI started meanwhile leaves what still waits to its
    own result.
  - A read-back that comes after a message was settled `not-read` still delivers it: it leaves the
    lost list and the page hears `delivered`.
- `held`: it arrived while the process was on its way out (stopped, its stdin closed, messages
  already held, or exited with its pipes still open). It is streamed at once, and the one process
  that replaces the old one gets every held message, in order. A send that has to start a process
  goes through admission (`ChatManager.admit()`): the concurrent-run limit, and the memory check,
  which refuses with 409 when the machine's memory is short ([resource-control.md](resource-control.md)).

The chat lists them as `pending` (`GET /chats/:id`), with the messages lost since (`undelivered`, with
a reason), until the person sends again. A `written` message the running turn cannot read before a
foreground call returns carries `blockedBy: { toolUseId, name, description? }`: a foreground `Agent`
or `Task` the turn waits on, or a `Bash` command not started in the background. They are written with
the chat's record (without `blockedBy`, which is the live process's), so a restart turns whatever was
pending into `undelivered` ("Claudio restarted before the agent read it").

## What the page hears

- The POST answers with the chat and `message: { id, taken }`. `taken` is `written` (into the running
  turn), `started` (it starts a turn now) or `held`.
- The chat's stream carries one `delivery` event per message, with its `source`:
  - `delivered` when the agent takes it, with `at`, when it took it. A merged prompt yields one
    `delivered` per id it holds.
  - `undelivered` with the message when it is lost (stop, crash, a refused respawn, `reason:
    'not-read'`), or withdrawn (`reason: 'cancelled'`).
  - `carried` with `chatId` when a limit replay sends it on: `replayLastTurn` sends the turn that died
    again with what waited, and `replayWith` sends the caller's turn and then what waited, each under
    the id the page knows it by. Nothing that waited is reported lost by the stop that precedes the
    replay.
- The status stays `busy` while the agent has messages of ours to read, within the bounds above, so a
  chat working on a queued message never reads idle and one whose message was dropped does not read
  busy for ever.

## The page

- A message the server answered `written` or `held` is a card over the composer
  (`@claudio/chat-ui/composer/QueuedCards`), keyed by chat and id, with its files. It clears on
  `delivered` or `carried`, when the transcript holds an entry with its id, when it was withdrawn, or
  when a read made well after it no longer lists it as pending. It turns lost only on `undelivered`,
  and Restore hands back its words and its files. There is no clock.
- A reload rebuilds the cards from `chat.pending`. A card the person dismissed or took back is kept
  away for the tab's life, per chat, in `sessionStorage` (`claudio.queued.dismissed.<chatId>`), so a
  reload does not bring it back while the server still lists it.
- **A person's waiting message.** "Send now" is `POST /chats/:id/interrupt` with the `messageId` of the
  oldest card still waiting: the server reads what the agent has written so far before deciding, and
  answers 409 once the agent has read the message, so it never cuts the turn answering it. It is one
  button in the card's foot rather than one per card: ending the turn has the agent read everything
  that waits. Each waiting row can be taken back (`DELETE /chats/:id/messages/:messageId`, the CLI's
  `cancel_async_message`), which puts its words and files back in the box; 409 once the agent took it.
- **Held behind a foreground call** (`blockedBy`): "Send now" would end that subagent or command with
  the turn, so the foot names it and offers "Send to background and deliver" first
  (`POST /chats/:id/commands/:toolUseId/background`, the CLI's `background_tasks`: the call returns at
  once, the work keeps running in the background, and the agent reads the message at that tool
  boundary), then "Interrupt the turn".
- **A notice** (`source` is `supervisor` or `claudio`) is drawn as one: who wrote it leads the row, and
  its only action is Dismiss, which withdraws it before the agent reads it. It never gets "Send now".
- A message the agent took into a running turn is dated when it took it (the `delivered` event's
  `at`), not when it was queued.
- The streamed copy of a message is confirmed by id, or by its words against the part of a read the
  page had not confirmed yet, once (a merged prompt confirms the run of messages it was made of). An
  unconfirmed message keeps its place in the conversation instead of sinking under the answers, and
  is never dropped by a clock.
- The composer clears only the words and files that were sent: what was typed or attached while the
  request was out stays in the box.

## What the CLI documents, and what Claudio uses of it

The Agent SDK typings (`@anthropic-ai/claude-agent-sdk` 0.3.156, `sdk.d.ts`) are the vendor's
documented control protocol, and the requests are typed from them (`providers/claude-code/control.ts`):
`interrupt` (nothing else on it), `background_tasks { tool_use_id }` (the SDK reads `backgrounded`,
true when missing) and `cancel_async_message { message_uuid }` (the SDK reads `cancelled`). The
interrupt's `send_now` and `message_uuid` members are not in the typings and are not used. The
interrupt's answer is an open record in the SDK; `still_queued` is read from it as the CLI's own
protocol schema describes it (2.1.312), and only when present.

## Background work is never idle-ended

A CLI whose input ends while work of its own runs in the background (a background command, agent or
workflow) waits for it up to `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (ten minutes) and then kills it.
So while `runsInBackground(chat.branches)`:

- the idle timeout does not end the chat's input (it is armed again until the work is over);
- the chat is never evicted for a run slot, past the idle timeout too;
- a one-turn chat (`keepAlive: false`) keeps its input open at its result, and it ends once the work
  is over and no turn of the lead's is under way;
- `endBetweenTurns` refuses with 409;
- a person's account switch waits: it is answered `pending`, the chat gets a notice saying why, and
  the move happens once the work is over.

## Edge cases the server handles

- `interrupt` reaches the CLI whenever a process is up, whatever the status says, and answers at once
  when the process's input is already closed. Only a turn of the lead's marks the interrupt as the
  cause of the next result: a background agent's lines make the chat busy with no result to come, and
  when the receipt arrives with no turn under way the mark is cleared, so the next real turn is not
  labelled stopped nor its `guard-missing` hidden.
- A process that exited while a child holds its stdout or stderr (a stdio MCP server left behind, a
  daemonised command) would never close: 3 s after the exit (`CLAUDIO_CLOSE_AFTER_EXIT_MS`) its pipes
  are destroyed, which closes it, and the chat stops being "on its way out".
- An ACP interrupt that times out fails the turn, and the next prompt waits for the agent's late reply
  instead of running beside it; each prompt is numbered, so a reply ends only its own turn.
- A limit replay sends the turn that died again: its first message and every message written during
  it, the ones still pending under their own ids.
- Sends to one chat are serialized, hints and notices included, so they reach the agent in the order
  sent.

Related: [[providers.md]], [[reports/chat-audit/README.md]], [[reports/chat-audit/server.md]],
[[reports/chat-audit/client.md]], [[design-system.md]], [[plans/regression-fixes-2026-10-29.md]],
[[reports/regression-audit-2026-10-29.md]], [[resource-control.md]]
