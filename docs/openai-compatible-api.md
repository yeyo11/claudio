---
created_at: 2026-10-25T16:00:00Z
updated_at: 2026-10-26T23:00:00Z
tags:
    - api
    - openai
    - chats
    - how-to
---
# The OpenAI-compatible surface

Clients that speak OpenAI's Chat Completions or Responses format reach Claudio under `/api/v1`, and
each request becomes a real Claudio chat ([the plan](plans/openai-compatible-api.md)). This page
describes what is built: **phases 1 to 5**. Phase 1 is the pure translators and the conversation table in
`packages/core/src/openai/`. Phase 2 serves them: `GET /v1/models`, `GET /v1/models/:id` and
`POST /v1/chat/completions`, whole and streamed, in `apps/api/src/routes/openai.ts`. Phase 3 adds
`response_format` (structured output); images were built in phase 2. Phase 4 adds client tools
(function calling): the client's `tools` are served to the CLI by a stub MCP server, and each call
is held at `can_use_tool` until the client sends its result. Phase 5 adds `POST /v1/responses`
(OpenAI's Responses API) on the same machinery, with stored responses for `previous_response_id`,
`GET` and `DELETE /v1/responses/:id` and `GET /v1/responses/:id/input_items`.

**This surface is for local use with the owner's own login.** It drives the unmodified Claude Code
CLI on the owner's machine, under the account signed in there. Anthropic's terms do not cover
serving other people or services with a Pro or Max subscription through it
([the plan](plans/openai-compatible-api.md), risk 1). Keep it on loopback, or behind the same guard
as the rest of the API, and do not hand the token to anyone else.

Everything here stays inside Claudio: it translates between two shapes and stores rows. It reaches
no agent, calls no SDK and adds no dependency.

## What phase 1 provides

| File | What it does |
|---|---|
| `wire.ts` | OpenAI's wire types: the validated request, messages, tools, tool calls and their stream deltas, the whole response, the chunk, the usage, the error body and the `[DONE]` sentinel. Kept in core, not in `packages/shared`: they are somebody else's protocol, and the web never reads them. |
| `request.ts` | `parseChatCompletionRequest` (unknown body to a typed request or an OpenAI-shaped 400, never a throw), `translateRequest` / `chatTurnOf` (request to `ChatTurn`, what a chat start needs), `renderCold` / `renderDelta`, and `uploadImages` with the upload step injected. |
| `events.ts` | `ChatCompletionTranslator`: a turn's `RunEvent`s to chunks and to the whole response; `tokenUsageOf`, `completionUsage`, `finishReasonOf`. |
| `errors.ts` | `openAiError`: a Claudio failure to `{ error: { message, type, param, code } }`, its status and a `retryAfterSeconds`; `failureOfThrown` and `failureOfSpendCap` for the errors core already raises. |
| `conversation-key.ts` | The hash chain that finds a chat again from a resent history. |
| `conversations.ts` | `OpenAiConversationStore` over the `openai_conversations` table; `Core.openaiConversations`. |

### The request

- `system` and `developer` messages, wherever they stand, are joined by a blank line into
  `appendSystemPrompt`. They never appear in the prompt.
- String content and an array of text parts are the same thing. Text parts are joined by a newline.
- Image parts (`image_url` as a `data:` URL or an `http(s)` URL) become `ImageRef`s in prompt order, and
  the prompt names each one `[image N]`. A data URL must be base64 PNG, JPEG, GIF or WebP, and its
  decoded size is checked against the cap (the upload store's 5 MB image limit) before it is decoded.
  Any other scheme is a 400 `unsupported_parameter`. `uploadImages(refs, { fetch, save })` turns
  them into upload ids. The caller supplies `fetch` (which must enforce the cap and refuse private
  addresses) and `save` (`UploadStore.save` fits). The bytes decide whether a file is an image, not
  its label.
- `reasoning_effort` becomes `effort`. `none` and `minimal` map to `low`, and Claudio's own `max` is
  accepted. Any other value is a 400.
- `response_format: json_schema` becomes `jsonSchema`. `json_object` becomes `{ type: 'object' }`.
- `n > 1` is a 400. `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `stop`,
  `logprobs`, `top_logprobs`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`,
  `service_tier`, `store`, `metadata` and `prediction` are collected in `ignored` when present and
  not `null`/`false`, for `x-claudio-ignored`. Audio output is a 400.
- `user` is kept for the conversation row.
- `tools`, the legacy `functions`, `tool_choice` and `function_call` are validated (names
  `[A-Za-z0-9_-]{1,64}`, no duplicates, a named choice must exist, `required` needs tools) and carried
  in `ChatTurn`. Phase 4 acts on `tools` and `tool_choice`; `functions` stay refused.
- The last non-system message must come from the user or a tool. The CLI cannot continue a reply
  the client started.

**Cold and delta.** `cold` is a new chat's first prompt. A history with no assistant message is just
the new messages. Otherwise it is a short preamble, then the turns up to the last assistant message
inside `<earlier-turns>` (`<user>`, `<assistant>` with its `<tool-call>`s, `<tool-result>`), then the
new messages. `delta` is a resumed chat's prompt: only the messages after the last assistant
message. Images are numbered per prompt.

### The events

The translator is fed one turn's events in order. `push` returns what to write, and `end()` returns
the whole response or the error once the turn is over.

- Only `partial` events with `block: 'text'` become content, and `thinking` is dropped. A `partial`
  with `text` starts a block. One with `append` and `at` continues it, and only the part past what is
  already held goes out.
- Partials are throttled, so the end of a block may never be sent as one. Each main-agent assistant
  `message` (not a sidechain or subagent) is compared with what was streamed for it, and only the
  remainder goes out. A message with no partials goes out whole. Separate stretches of text (text
  before and after a tool ran) are joined by a blank line.
- The first chunk carries `role: 'assistant'`. Every chunk has `usage: null`. The final chunk has an
  empty delta and the `finish_reason`. When `stream_options.include_usage` is set and token counts
  are known, a usage chunk with `choices: []` follows. The stream ends with `STREAM_DONE`.
- `finish_reason`: `tool_calls` when client calls streamed, `length` for `stopReason: max_tokens`
  or an exhausted budget (the answer was cut short, so it is not reported as an error), and
  `content_filter` for `stopReason: refusal`. Everything else is `stop`.
- A failed `result` (other than a budget), or `failWith(failure)` for a failure outside the events,
  becomes an error chunk and then `[DONE]`. A stream never just stops.
- `toolCallDelta({ id, name, argumentsAppend })` writes a client's call. The first fragment of a
  call carries `index`, `id`, `type` and the name, and later fragments only `index` and arguments.
  `content` is `null` in those chunks. Phase 4 feeds it from the main agent's `tool_use` blocks
  (option `clientTools`) and ends the turn with `handOff()`.
- Usage: `prompt_tokens` = input + cache read + cache creation, with `prompt_tokens_details.cached_tokens`
  = cache read. `completion_tokens` = output. `costUsd` is returned beside the body for
  `x-claudio-cost-usd` and never placed in it.

**Where the tokens come from.** `RunOutcome` carries no token counts, only `costUsd`. The CLI reports
them per model on its `result` (`modelUsage`, which reaches `ChatManager` as the driver's `ModelUsage[]`),
not on the `RunEvent`. So `push(resultEvent, { usage })` takes the counts from the caller. When none
are given, the body has no `usage` and no usage chunk is sent. Nothing is estimated. Phase 2 decided
which counts the caller passes (below, "The tokens of one turn").

### Errors

| Failure | Status | `type` | `code` |
|---|---|---|---|
| no or bad credential | 401 | `invalid_request_error` | `invalid_api_key` |
| a chat's token refused | 403 | `invalid_request_error` | `permission_denied` |
| unknown model | 404 | `invalid_request_error` | `model_not_found` (`param: model`) |
| other not found | 404 | `invalid_request_error` | `not_found` |
| bad request | 400 | `invalid_request_error` | `invalid_request_error` |
| unsupported parameter or part | 400 | `invalid_request_error` | `unsupported_parameter` |
| conflict (`ChatConflictError`) | 409 | `invalid_request_error` | `conflict` |
| daily spend cap, usage limit | 429 | `rate_limit_error` | `rate_limit_exceeded` |
| no account can run (`ChatRefusal` 503) | 503 | `server_error` | `service_unavailable` |
| anything else | 500 | `server_error` | `server_error` |

The spend gate answers `409 { code: 'spend-cap', spend }` today. Under `/v1` that becomes a 429
whose `retryAfterSeconds` counts to `spend.resetsAt`. The usage limit takes its reset as ISO text or
epoch seconds. `Retry-After` is at least 1. A 5xx shows its message only when the error is marked
`expose`, which is the API handler's own rule.

### The conversation key

The key is a SHA-256 hash chain. The seed is `["claudio-openai-conversation/1", model, systemPrompt,
user]`. Each non-system message then extends it with its canonical JSON:
`["user", ...text | ["image", digest]]` (`imageDigest`: the SHA-256 of a data URL's decoded bytes,
so the same image matches however it was base64-encoded, or of an http(s) URL), `["assistant", text, [[id, name, args]...]]`,
or `["tool", toolCallId, text]`. The lookup key is the chain through the last assistant message.
`keyAfterAnswer` gives the key the client's next request will carry, so phase 2 stores that one
after answering.

Normalised, because clients vary there without meaning anything: CRLF becomes LF, each message's
text is trimmed at both ends, string content equals one text part, `null` assistant content equals
`""`, and tool-call arguments that parse as JSON are compared with their keys sorted. Not
normalised: whitespace inside a message, letter case, and the model id (an alias is a different
conversation). The OpenAI `user` is part of the seed, so two end users with identical histories
never share a chat.

### The table

`openai_conversations (hash PRIMARY KEY, chat_id, client_user, created_at, updated_at)`, indexed on
`chat_id` and `updated_at`. The column is `client_user` rather than `user`, which would read as
SQL's keyword. `remember` is a single `INSERT … ON CONFLICT (hash) DO UPDATE`, so concurrent writers
on one key leave one whole row, and `created_at` stays the first writer's. `forgetChat(chatId)`
drops a chat's keys, and `Db.deleteChat` does the same inside its own transaction, like the other
chat-keyed tables. `expire(olderThan)` drops keys not answered since then; phase 2's sweep calls it (below). Chats pruned by `saveChats(keep)` keep their rows until they expire, and
a lookup must check that the chat still exists.

## Phase 2: the routes

| File | What it does |
|---|---|
| `apps/api/src/routes/openai.ts` | The three routes, registered under `/api` with the prefix `/v1` in their own Fastify context: OpenAI's error shape, a `/v1` 404, the per-conversation queue, the turn runner and the hourly sweep. |
| `apps/api/src/security.ts` | The rule that `/api/v1/*` needs a credential under `mode: none` too. |
| `apps/api/src/sse.ts` | `openStream` takes extra headers and announced trailers, writes a raw `data:` line (for `[DONE]`) and ends the reply. The stream tracks whether it is closed (ended, or the connection gone): a late write or a second `end()` does nothing. |
| `packages/core/src/openai/fetch-image.ts` | `fetchImage` and `isPublicAddress`: the image fetcher phase 1 left to the caller. |
| `packages/core/src/openai/sweep.ts` | `sweepOpenAiChats` and `OPENAI_CONVERSATION_TTL_MS`. |
| `packages/core/src/usage.ts` | `turnTokens`, a turn's tokens from the cumulative figures. |

### The tokens of one turn

**Decision.** The CLI reports `modelUsage` (and `total_cost_usd`) **cumulative over its process**, as
recorded in `packages/core/test/fixtures/recordings/c0-NOTES.md` (F12) and as `foldResult` already
treats the cost. An API chat keeps its process between turns, so reading the figure as the turn's
own would bill the second turn for the first one too. The route needs this turn alone.

The smallest sound option is a per-turn delta computed where the cost delta already is, with no
change to the API contract:

- `LiveChat.lastReportedModelUsage` is the process's last `modelUsage`, reset at every spawn like
  `lastReportedCostUsd`. Both baselines move on every `result`, whether or not an execution is open,
  so the cost and the tokens of a turn always describe the same turn.
- `foldResult` sets `LiveChat.lastTurn = { tokens, costUsd }` **before** it pushes the `result`
  event: `tokens` is `turnTokens(previous, current)`, the growth per model (a model seen for the first
  time counts whole, a count that went down counts from zero), and `costUsd` is the growth of
  `total_cost_usd`.
- `ChatManager.lastTurn(id)` reads it. The route reads it in its listener of the `result` event, which
  runs synchronously inside the push, so it is always that turn's figure.

Rejected: a `tokens` field on `RunOutcome`. It is the cleaner contract for the web too, but it changes
`packages/shared/src/types.ts` and every consumer for something only this route reads today. If the
web ever shows per-turn tokens, move `lastTurn` onto the outcome then. `x-claudio-cost-usd` uses the
same delta, so the second turn of a process reports its own cost, not the process's total.

### A request, step by step

1. The body is read (`parseChatCompletionRequest`). What this surface cannot do is refused with
   `400 unsupported_parameter`: the legacy `functions`, and client `tools` together with
   `response_format`. Tool names the stub cannot serve are `400 invalid_request_error` (phase 4,
   below). `tools` with `tool_choice: "none"` are left out and named in `x-claudio-ignored`. Trailing
   `tool` messages must answer every call of the last assistant message, and nothing else. Then the
   model must be in the catalogue (`404 model_not_found`), `X-Claudio-Cwd` must be valid and
   `X-Claudio-Tool-Preset` must name a stored preset.
2. **Serialised per conversation.** Requests wait in a queue keyed by the conversation key (or by
   `chat:<id>` with `X-Claudio-Chat-Id`), then also on `chat:<id>` once the chat is known, so a
   request that names the chat and one that finds it by history wait for each other. A queue rather
   than a 409: the SDKs retry a 409 anyway, and the queue answers without the round trip. Two clients
   continuing the same point of one conversation therefore run in turn in one chat, and the second
   sees the first's exchange in the chat's context.
3. **The chat.** `X-Claudio-Chat-Id` names it. Otherwise the history key is looked up; a row whose
   chat no longer exists is forgotten and counts as a miss. Either way **only a chat with origin
   `api` is continued**: a person's chat, an orchestration's or the assistant's is answered `404`
   by id, like an unknown id so the answer does not tell which chats exist, and a key that leads to
   one is a miss. Without this, any holder of a token could write into those chats and run them
   with this surface's rules. A miss starts a
   new chat with the cold prompt, a hit continues with the delta.
4. **Images** of the chosen prompt are uploaded (`uploadOpenAiImages`, with `fetchImage` and
   `core.uploads.save`) and attached to the message.
5. **The turn.** A new chat is created with `permissionPrompts: 'none'` (`'host'` when it has client
   tools: phase 4), the default tool preset (or
   the header's), the app's default permission mode, except that `bypassPermissions` becomes `manual`,
   and origin `api`. A chat with a live idle process gets the turn as a message
   (`chats.send`), after its live process is set to the same rules: prompts denied
   (`ChatManager.setPermissionPrompts`) and the same permission mode (`bypassPermissions` becomes
   `manual`). A live chat that is busy is `409 conflict`. A chat nobody holds is resumed
   (`chats.resume`) with the same mode and prompt settings. The runner subscribes to the chat **before** the turn is sent (inside
   `create`'s `onStart` for a new chat) and asks `ChatManager.nextResult` when the turn is over, so a
   process that dies without a result, or a stop, ends the answer as an error and a limit replay
   that changes accounts does not. Once the turn is sent, the chat's buffer is read from the last
   event before the turn (recorded when the runner attached), never from the start, so an earlier
   execution's `result` cannot answer this turn.
   **The idle limit.** A turn that shows no sign of life (no event, no CLI heartbeat for a command
   it runs) for `CLAUDIO_OPENAI_TURN_IDLE_MS`, **10 minutes** by default, is interrupted and answered
   `500 server_error` ("showed no activity"). It is what ends a turn stuck on a prompt nobody can
   answer, or a process that stopped talking; the 10 minutes match the chat idle timeout, and a long
   build keeps the turn alive through its heartbeats.
6. **The answer.** Whole: the completion, or the error with its status. Streamed: the SSE reply is
   opened only once the chat started, so everything before is a proper HTTP error; after that a
   failure is an error chunk and `[DONE]`. After a completed turn, `keyAfterAnswer` is remembered for
   the chat, so the client's next request finds it.
7. **A client that disconnects** (the response closes before it finished) interrupts the chat with
   `chats.interrupt`; writing stops, and the request keeps its place in the queue until the turn ends
   or 30 s pass, so the next request on the conversation does not find the chat busy.

### Headers

| Header | Direction | Meaning |
|---|---|---|
| `Authorization: Bearer <token>` | in | The owner's API token, or a chat's own `CLAUDIO_API_TOKEN` from this machine |
| `X-Claudio-Chat-Id` | in | Continue this chat |
| `X-Claudio-Cwd` | in | Where a new chat runs: an absolute, existing directory inside the workspace or an imported project. Stricter than `cwd` on `POST /chats`, which only checks the type and creates the directory. **It applies only when a chat is created**: on a chat that exists it is ignored, and named in `x-claudio-ignored` when it differs from the chat's directory. It is not part of the conversation key (the key's seed is phase 1's `model`, system prompt and `user`), so the same history from two directories continues one chat. UTF-8 bytes are read as UTF-8 |
| `X-Claudio-Tool-Preset` | in | A stored tool preset id instead of the default preset |
| `X-Claudio-Spend-Override: 1` | in | Past the daily spend cap, as on `POST /chats` |
| `X-Claudio-Chat-Id` | out | The chat, on every answer once it is known, errors after the start included |
| `X-Claudio-Cost-Usd` | out | This turn's cost; an HTTP trailer on a streamed answer, since it is known only at the end |
| `X-Claudio-Ignored` | out | Parameters the CLI cannot honour (`temperature`, `max_tokens`…), `tools` sent with `tool_choice: "none"`, `tools` that differ from those a live process holding calls already serves, `x-claudio-cwd` on a chat in another directory, and `reasoning_effort` sent to a chat whose process is up (the effort of a live process cannot change) |
| `X-Claudio-Resume: cold` | out | The client's tool results reached a chat whose process was gone (a restart, the idle expiry, a crash): the chat was resumed and the results went in as a message |
| `Retry-After` | out | On every 429 |

### The request body

`POST /v1/chat/completions` accepts bodies up to `COMPLETION_BODY_LIMIT`, about 27 MB: four images at
the 5 MB upload cap as base64 data URLs (4/3 of their bytes) and 1 MiB for the text. Fastify's
default of 1 MiB would answer `413` to a single 2 MB photo before the parser could say which image
is too big; with the larger limit an image over the cap gets the parser's `400` naming its size.

### Errors under /v1

The routes live in their own Fastify context with their own error handler and 404, so everything
under `/api/v1` answers `{ error: { message, type, param, code } }` and the rest of the API keeps
`{ error: string }`. A failure is classified by its type and declared status, never by its wording:
core throws `ChatNotFoundError` (404) for a chat it does not know and `RunSlotRefusal` for a start
with every run slot taken (both in `packages/core/src/chat-errors.ts`, beside `ChatRefusal`), and
the route keeps the status of any error that declares one (`ChatConflictError` 409…). A plain
hand-thrown `Error` from core is a refusal of the request, so a 400, whatever it says. What
answers before a handler runs (the guard's 401, 421 and 429, read-only's 405, the spend gate's 409)
is rewritten by an `onSend` hook of the context: the status stays, except the spend cap, whose 409
becomes `429 rate_limit_exceeded` with `Retry-After` to local midnight. A start refused for lack of
a run slot (`RunSlotRefusal`, still a 400 on the rest of the API) is `429` with `Retry-After: 5`, so
SDKs retry by themselves.

### Authentication

The plan asks for a credential even where `/chats` needs none, because a request here starts a chat
that may run Bash. Under `mode: token` and `oidc` the guard already asks for one. Under `mode: none`
the guard now asks `/api/v1/*` for the owner's API token (checked against the stored hash whatever
the mode) or a chat's own token from this machine (the same loopback check the guarded modes use);
anything else is a 401. The check is the guarded modes' own flow (`authenticate` in `security.ts`,
one copy for both): a request with no credential is refused without being counted or made to wait,
an address in its back-off waits (`429`), a wrong credential counts toward the back-off, and a right
one clears it. With no token
set, the 401 says how to set one (Settings → Access & safety, or `POST /api/security/token`). Not
built: the plan's rule that a collaborator's token calls these routes only with what its share
grants; collaborators reach Claudio over iroh, not with API tokens, so there is no such token today.

### API chats and their expiry

A chat started here has origin `api` (`ChatOrigin`, so `openapi:schemas` was regenerated). Like
`internal`, it is left out of `GET /chats` unless `?origin=api` asks for it, and the web's list never
shows it; its badge reads "API". It runs with the purpose `person` for the spend ledger and the
admission queue. Every hour the route plugin runs `sweepOpenAiChats`: conversation keys not answered
for **7 days** (`OPENAI_CONVERSATION_TTL_MS`) are dropped, then every `api` chat with no key left, no
process and no change in those 7 days is deleted (transcript and record). A person's chat a client
continued by id only loses its keys.

Its title is the first line of the request's first user message with text (system messages, image
parts and the cold start's rendered history left out), cut to 100 characters, as a transcript's
title is, one shorter when the cut would split an emoji or another character outside the BMP. It is passed to the CLI as `--name` when the chat starts, so a resume never changes it.

Each chat keeps its process up between turns, as a person's does, so follow-ups are fast; idle
processes count toward `maxConcurrentRuns` until the idle timeout lets them go.

### The image fetcher

`fetchImage(url, maxBytes)` fetches only `http` and `https` URLs without credentials, at most 3
redirects, within 15 s overall, and stops reading past the cap (5 MB, the upload store's image limit;
a larger `Content-Length` is refused before reading). It refuses every address that is not public:
loopback, private, link-local (the cloud metadata address), CGNAT, multicast, documentation and the
IPv6 equivalents, with IPv4-mapped, NAT64 and 6to4 addresses judged by what they carry. A literal
address is checked before connecting; a name is checked in the connection's own `lookup`, every
address it resolves to, so a name that answers differently the second time (DNS rebinding) is caught
too. Every redirect is checked again.

### Known gaps

- Client tools together with `response_format` are refused (phase 4).
- A structured answer is not streamed as it is written: it arrives as one chunk at the end (phase 3).
- A chat continued by `X-Claudio-Chat-Id` keeps its live process's effort for that turn (named in
  `x-claudio-ignored`); its model does change. Its system prompt follows phase 5's rule ("The system
  prompt"): system messages in the body replace the chat's, a body without any keeps them, and a
  live idle process started with another effective prompt is ended and the chat resumed with the new
  one, as a schema change does (phase 3).
- `created` in a model object is 0: the catalogue has no date.
- A run refused for memory pressure (not for the run count) is still a 409.

## Phase 3: `response_format`

| File | What it does |
|---|---|
| `packages/core/src/openai/events.ts` | `ChatCompletionTranslator` takes `structured: true`: the content is the result's `structured_output` as JSON text, and `structuredFailure` is the error when it is missing. |
| `packages/core/src/openai/request.ts` | `ChatTurn.schemaStrict` records `json_schema.strict`; `sameJsonSchema` compares two schemas with their keys sorted. |
| `packages/core/src/chats.ts` | `ChatManager.jsonSchemaOf(id)`, the schema a live process was started with, and `endBetweenTurns(id)`, which ends an idle process the way its idle timeout does. |
| `apps/api/src/routes/openai.ts` | Passes the schema to a new chat, to a resume, and restarts a live process whose schema differs. |

**How the CLI delivers it.** A chat started with `--json-schema` gets one extra tool,
`StructuredOutput`, whose input is the answer. The model calls it, and the CLI's `result` line
carries the object as `structured_output` (core keeps it as `RunOutcome.structuredOutput` and
`RunResult.structuredOutput`). The model may write prose before the call: in the smoke test below it
answered "Paris." as text first, the CLI added a `[structured-output-enforce]` user message, and only
then the model called the tool. So the prose is never the answer.

**The answer.**

- `json_schema` passes its `schema` as the chat's `jsonSchema`. `json_object` passes
  `{ type: 'object' }`. `text`, or no `response_format`, passes none.
- In a structured turn the translator ignores every text partial and assistant text block. At the
  `result` it writes `JSON.stringify(structured_output)` as the content, whole or as one content
  chunk followed by the finish chunk, the usage chunk and `[DONE]`. `finish_reason` is `stop`: the
  CLI's `stop_reason` (`tool_use`, from the output call) is not the client's business.
- **Streaming is one chunk at the end.** Core does see the output call's arguments as they stream
  (`structured-delta`, `LiveChat.structured`). It does not forward them, because the CLI validates the
  output against the schema and makes the model call the tool again when it fails: JSON already sent
  for a rejected attempt could not be taken back. Only the `result` carries the output that passed.
- `strict` is recorded on the turn (`schemaStrict`) and nothing more. The CLI holds every output to
  the schema, so a strict request is met and a non-strict one gets a stricter answer than it asked for.
- The conversation key is that JSON text. A client that resends the assistant message as it got it
  finds the same chat.

**When there is no output.** A model that gives up on the schema ends with `subtype: success`, prose
and no `structured_output` (recorded in `packages/core/test/fixtures/replay/review-schema-fail.jsonl`).
That is a `500 server_error` "The model did not produce output matching `response_format`; it said:
…", whole, or an error chunk and `[DONE]` when streamed. A budget that cut the turn first is the same
error with its own message. A failed result (`error_max_structured_output_retries`, say) is the usual
failed-run error. Never an empty 200.

**A schema change on one conversation.** `--json-schema` is a launch flag, fixed while the process
lives. On a chat whose process is up and idle, the route compares the turn's schema with
`jsonSchemaOf` (`sameJsonSchema`: keys sorted, and no schema equals only no schema):

- equal: the turn goes to the live process as a message, as before;
- different, including a schema after none and none after a schema: `endBetweenTurns` closes the
  process's input, as the idle timeout does, and waits for it to exit (5 s, then SIGTERM). Then the
  chat is resumed (`chats.resume`) with the turn's prompt and `jsonSchema` (or `null`, which drops
  the chat's schema). The resumed process has the whole session, so only the new messages are sent.

**What the key depends on.** The schema is not part of the conversation key. It is a per-turn option,
like `stream`: a client that asks for JSON on one turn and text on the next is still in the same
conversation, and keying on it would start a new chat, with the history pasted in cold, on every
change. The cost is one process restart when the schema changes.

**At a usage limit.** `ChatManager.heldToSchema` made a chat with a schema count as automated work
for the rotation, which does not replay a turn nobody waits for. An `api` chat's turn has a request
waiting for it, so `heldToSchema` is false for `api` chats: at a limit they are handled as a person's
chat, with or without a schema.

**Smoke test** (2026-10-25, real CLI, `claude -p --model haiku --max-budget-usd 0.5 --output-format
stream-json --verbose --include-partial-messages --tools= --json-schema
'{"type":"object","properties":{"capital":{"type":"string"}},"required":["capital"]}'`, "What is the
capital of France? Answer briefly.", 0.0074 USD). The stream had a text block "Paris." (`end_turn`),
the CLI's `[structured-output-enforce]` user message, then a `StructuredOutput` call whose
`input_json_delta`s were `{"capital": "Paris` and `"}`, and the `result`: `subtype: success`,
`stop_reason: tool_use`, `structured_output: {"capital":"Paris"}`, with `result` holding the same JSON
as text. Fed through the driver, the fold and the translator, it gave exactly one content chunk
`{"capital":"Paris"}`, then the finish chunk (`stop`), the usage chunk and `[DONE]`, and the same
content whole. The prose "Paris." did not reach the client.

## Phase 4: client tools

A request's `tools` (type `function`: `name`, `description`, JSON-schema `parameters`) are the
client's own functions. Claude calls them, Claudio hands the calls back as OpenAI does
(`finish_reason: "tool_calls"`), and the client's next request brings the results. The CLI is never
told it is talking to a remote client: it sees an MCP server whose calls need permission, and the
permission is what Claudio holds. The design and the real-CLI evidence are in
[the plan](plans/openai-compatible-api.md) (decision 2) and [the spike](plans/openai-compatible-api-spike.md).

| File | What it does |
|---|---|
| `packages/core/src/openai/client-tools.ts` | `ClientToolSession` (one chat's tools, held requests, handed-over calls and results), `clientToolsProblem` (names the stub cannot serve), `trailingResults` / `resultsProblem` (the results a request ends with), `toolChoiceInstruction`, `clientToolsServerEntry` and `answerStub` (the stub's JSON-RPC) |
| `apps/api/src/routes/openai-tools.ts` | `ClientToolRegistry` (sessions by chat and by stub id) and the stub route `/api/openai/client-tools/:id/mcp` |
| `apps/api/src/routes/openai.ts` | The handoff in the turn runner, the continuation, the timeout and the cold resume |
| `packages/core/src/live-chat.ts`, `chat-fold.ts`, `chats.ts` | `PermissionHost`: a program answers a chat's permission requests instead of a person; `extraMcpServers`: servers core's callers add to a chat's `--mcp-config` |

### The stub server

Each chat with client tools gets a session with a random id and a stub MCP server at
`/api/openai/client-tools/<id>/mcp`, passed to the CLI with `--mcp-config` beside the servers the
chat loads anyway (the file adds to them, so `--strict-mcp-config` stays off). The entry is
`{ type: "http", url, headers: { Authorization: "Bearer ${CLAUDIO_API_TOKEN}" }, alwaysLoad: true }`:
the CLI expands the chat's own per-process token from its environment, so no secret is written to
the file, and the stub accepts only that token, for the chat the session is bound to (`401`
otherwise, the same for an unknown id). `alwaysLoad` saves a `ToolSearch` round trip and makes
`tool_choice` instructions work (spike). `tools/list` lists the client's tools with
`readOnlyHint: true`, so the CLI asks for every call of a message at once and runs them together.
The stub changes nothing itself; the client acts on its own side.

The stub **never waits**. `tools/call` returns the result the client already sent: the one under
`_meta["claudecode/toolUseId"]`, else the oldest result for a call of that name **with the same
arguments** (compared without key order or spacing), else an error result at once, never the result
of another call. **`_meta["claudecode/toolUseId"]` is the one soft spot:** it is on the wire (spike
question 3) but not documented, so the fallback keeps the stub correct if a CLI release drops it.
Two parallel calls with different arguments (`get_weather(Paris)`, `get_weather(Rome)`) cannot swap
results; only identical calls share the first-in-first-out order, where swapping changes nothing a
client could tell apart. A result whose request the CLI took back (an interrupt) is not kept, and a
new hand-off clears what the previous message left, so neither can answer a later call. The answers are plain JSON (no SSE), notifications get `202`, `GET` and `DELETE`
get `405`, and an unknown method gets `-32601` (the CLI's `server/discover` among them; it falls back
to `initialize`). The session lives in memory and goes with the chat: removing the chat (the sweep,
`DELETE /chats/:id`, the history trim) drops it, and its URL stops answering. A request whose new
chat fails to start after the session was bound drops the session too.

**The config file.** Core writes the stub's entry, joined to the servers the chat chose, to
`<data>/mcp/extra-<chat id>-<hash>.json` (`writeChatExtrasConfigSync`), one per chat: writing it
deletes the chat's earlier ones, removing the chat deletes it, and a restart of the wrapper deletes
every such file of a chat with no process (its stub URL died with the old server). Only names of that
shape are touched; the shared, content-named config files in the same folder never are. When the
config the stub joins is gone, unreadable or not a config, the process starts with the stub only and
the chat gets a notice that says which (gone, cannot be read with the error code, not valid JSON, no
`mcpServers`). When that config is the chat's own choice the notice asks to pick the servers again;
when it is Claudio's own file (its server joined to the chat's choice), which nobody picked, it says
Claudio's server is missing and that the next process writes it again. A chat is told once per
problem, not on each of the respawns an API chat goes through. A chat without added servers is
given its own config path exactly as before.

A development install that ran pre-release phase 4 builds may have stale `<hash>.json` files in
`<data>/mcp/` whose `mcpServers.client` points at `/api/openai/client-tools/`: those builds wrote the
stub's config under the same content-hashed names as the shared configs, so the wrapper cannot tell
them apart by name and does not delete them. They are safe to delete by hand when no chat references
them.

Names: the CLI shows the tools to the model as `mcp__client__<name>`, and the client gets its own
names back. Names longer than 51 characters (the model's 64 minus the prefix), names of Claude
Code's own tools (`Bash`, `Read`, `Task`…, compared without case) and names that differ only by case
are `400 invalid_request_error`. The parser already refuses names outside `[A-Za-z0-9_-]` and exact
duplicates.

### Who answers the permission requests

A chat with client tools runs with `permissionPrompts: 'host'` (never `bypassPermissions`), and its
session is the chat's `PermissionHost` (`ChatManager.setPermissionHost`). Every `can_use_tool` the
CLI sends goes to it, before Claudio's tool policy, and **none reaches `PermissionBroker`**: its
10-minute deny and the panel's buttons cannot answer a client's call, `pendingPrompts` stays 0, and
the chat's permission list and notices show nothing. The session holds a request for one of the
client's tools in its own map only when the turn being read has **claimed** that call: the
translator tells the session each main-agent `mcp__client__*` block it streams to the client, as the
block's message arrives, and the CLI writes that message before it asks. A request for a call nobody
claimed (a subagent's call, one `parallel_tool_calls: false` or a named `tool_choice` left out, a late
ask) is denied at once with "This call was not handed to the client." rather than held until a
watchdog. A built-in tool is denied at once with the message `permissionPrompts: 'none'` gives. Built-in tools that the chat's tool preset and permission mode
allow without asking still run in the same turn, as in any API chat: a preset reaches the CLI as its
own `--allowedTools` and `--disallowedTools`, which it applies before it would send `can_use_tool`,
so nothing Claudio answers can take them away. This surface gives its chats no Claudio tool policy
(`toolConfig.policy` comes only from automated work), so there is no policy verdict for the host to
skip. An `api` chat whose host is not attached (after a restart) denies every request rather than
asking a person.

### A turn that calls tools

1. The model writes one API message with `tool_use` blocks for `mcp__client__*`, maybe after some
   text. The translator streams the text as content and each call as two `tool_calls` fragments on a
   stable `index`: the first with `id`, `type: "function"` and the name with empty `arguments`, the
   second with the arguments whole. The calls come from the blocks, not from the permission
   requests: with a tool that is not read-only the CLI asks for call *n+1* only after call *n* ran,
   so waiting for one request per call would deadlock (spike change 2).
2. At the end of that API message (`stop_reason: tool_use`), the HTTP turn ends:
   `finish_reason: "tool_calls"`, `message.tool_calls[]` whole, or the finish chunk and `[DONE]`
   when streaming. No `usage` and no `X-Claudio-Cost-Usd`: the CLI reports them with its turn's
   `result`, which comes once the results are in. The process stays up, silent, holding the
   requests, and the session starts the wait.
3. The client runs its functions and sends the history again with the assistant message (its
   `tool_calls` as received) and one `tool` message per call. The conversation key after a
   `tool_calls` answer covers the calls, so this request finds the chat; `X-Claudio-Chat-Id` works
   too. Each held request is allowed with its **original input**, in any order; the CLI calls the
   stub, gets each result as the tool's output, and the same CLI turn goes on. This request streams
   it and ends with the next calls or the final answer, whose usage and cost are those of the whole
   CLI turn. No message is sent to the CLI.

The first request's place in the conversation's queue is released when it ends with the calls, so
the result request never waits behind it. The idle limit (`CLAUDIO_OPENAI_TURN_IDLE_MS`) belongs to
a turn being read, so it does not run while the calls are with the client; the wait has its own
limit.

**What the results must be.** A `tool` message for every call of the last assistant message, and
none for anything else: an unknown `tool_call_id`, results for some calls but not all, or two
results for one call are `400 invalid_request_error`, naming the ids ("… have no result: send a
`tool` message for each of them, or none and a new `user` message to drop them"; the same words
whether the history or the live process is short of them). While the CLI is holding the calls, the
results must also be the ones it waits for, and a `user` message after a full set of results is a
`400` (the CLI is in the middle of its turn; send the results, then the message).

**A call the CLI withdrew** (`control_cancel_request`, after an interrupt) is no longer owed: the
session stops waiting on it (and stops its wait when nothing else is owed), a result the client
sends for it anyway is accepted and ignored, and a result is demanded only for the calls the CLI
still holds.

**Dropping the calls.** A request with **no** result for the calls and a new `user` message (after
the assistant message with the calls, or alone on a chat named by `X-Claudio-Chat-Id`) drops them:
the turn holding them is interrupted (the CLI withdraws its requests, a held one still left gets the
error result "the client sent a new message instead of a result for this call"), and the message
then goes to the idle process as an ordinary turn. What would refuse that message (no such chat, a
process that would have to start again with the stub while the API's address is unknown) is
checked **before** the interrupt, so a refused request leaves the calls held and the turn as it was.
If the interrupt does not land within 30 s (`CLAUDIO_OPENAI_INTERRUPT_GRACE_MS` overrides it, for
tests) the request is a `409` and nothing else is sent; the wait for the interrupt and its timer are
taken down whichever ends first. Only a
refusal that cannot be known before the turn ends comes after the calls were dropped: the chat not
idle once the interrupt landed, or its process gone by then with no run slot free to start another.
Its message then begins "The held tool calls were dropped, but the new message was not sent", so
the client does not send their results again.

**Every refusal comes first.** The checks on a request (its results against the held calls, the
target chat, a conflict, the images) all run before the session is touched, with the one exception
named under "Dropping the calls": the session's
`tool_choice` and `parallel_tool_calls` change as the last step before the turn runs, and go back to
what they were if starting it fails, so a refused request never changes what another client's held
calls get.

**The wait.** `openaiToolCallTimeoutMinutes` (`GET`/`PUT /api/settings/app`, 1 to 1440, **10** by
default, `null` resets it; `CLAUDIO_OPENAI_TOOL_CALL_TIMEOUT_MINUTES` fixes it), read when each wait
starts. `CLAUDIO_OPENAI_TOOL_CALL_WAIT_MS` overrides it in milliseconds, for tests that cannot wait a
minute. A call still owed then is answered to the CLI with an error result ("the client did not
return a result for this call in time") and the chat is stopped. A result that arrives later is a
`400` that says the call expired. It has no control in the web yet; it is set through the API or the
environment.

**A client that disconnects** while a call is held and its answer still open is the usual
disconnect: the chat is interrupted, and the CLI withdraws the held requests
(`control_cancel_request`) and ends its turn (spike).

**Cold resume.** The results go to the held requests only when the chat's live process is the one
the calls were handed over from (`ClientToolSession.holderPid`), is still in that turn, and still
holds at least one call the CLI has not withdrawn (`ClientToolSession.holds`). When the CLI withdrew
every one (a person stopped the turn in the web while the client was computing), the idle process
holds nothing: results go in as a cold resume to it, and a new `user` message is an ordinary turn,
with nothing to interrupt. When that process is gone (a
restart, the idle expiry, a crash), the session forgets its calls as the process ends, and results
that no live process holds go in as a cold resume, even when another process of the chat is up by
then (a person's resume, an earlier request's turn): the new process never asked for them. A chat
without a live process is resumed with `--resume`; one with an idle process that serves the stub gets
the message on that process. The CLI writes its own "tool call interrupted" error for
each call that was dangling (spike question 6), and the results go in as a user message that says
the session restarted. The answer carries `X-Claudio-Resume: cold`.

### `tool_choice` and `parallel_tool_calls`

The CLI's flags are fixed when its process starts, and the process outlives a request, so each
request's choice is enforced where it can be: in the answer to each permission request.

| Value | What happens |
|---|---|
| `auto` (default) | Nothing |
| `none` | On a new chat the tools are left out (no stub) and named in `x-claudio-ignored`. On a chat whose process already serves the stub, every client call is denied with a message naming the rule |
| `{ type: "function", function: { name } }` | Calls of other client tools are denied with a message naming the required one, and the turn's prompt carries a line asking for it |
| `required` | Only a line in the turn's prompt; not guaranteed |
| `parallel_tool_calls: false` | Only the first call of a message is handed to the client; the others are denied |

Built-in tools the preset allows can still run in the same turn whatever `tool_choice` says (spike
question 7).

### Limits

- Client tools together with `response_format` are refused (`unsupported_parameter`, not supported yet).
- A live process serves the tool list it started with. A turn that names different tools (a name,
  compared with its case, a description or the parameters; not the order) restarts an idle process
  with the new list; a request that brings results to a process holding calls keeps
  the old list and names `tools` in `x-claudio-ignored`.
- A chat holding calls keeps its process, and its run slot, for up to the wait.
- Held requests live in memory: a restart loses them, and the results resume the chat cold.
- Never allow-list `mcp__client__*` tools in a preset or the CLI's settings: a call the CLI runs
  without asking finds no result in the stub and gets an error result.

### Evidence from the real CLI

Two smoke runs on Claude Code 2.1.310, `haiku`, each spawn capped with `--max-budget-usd 0.5`,
through the real routes, core and stub (2026-10-26):

- One tool, whole: the first answer was `finish_reason: "tool_calls"` with
  `get_secret {"key":"alpha"}` (id `toolu_0146…`), the process up and `core.permissions.list()` empty.
  The second request, with the `tool` message `ZEBRA-4471-KUMQUAT`, answered
  `content: "ZEBRA-4471-KUMQUAT"`, `finish_reason: "stop"`, in the same chat. $0.0069.
- Two tools, streamed: `get_weather` on index 0 and `get_time` on index 1, each as a name fragment
  and an arguments fragment, then `finish_reason: "tool_calls"` and `[DONE]`. The second stream
  quoted both results ("17 C, light rain", "14:05 CEST") and ended with a usage chunk. $0.0071.

After the review fixes, one more run on the same CLI and model (2026-10-26), $0.0143 for both:

- A client tool and a preset-allowed built-in in one chat (`X-Claudio-Tool-Preset: read-only`): one
  message called `mcp__client__get_weather` and `Bash` (`git status`). The client got only
  `get_weather`; `Bash` ran under the preset's `Bash(git status:*)` without a permission request (git
  itself failed: the workspace is not a repository). The answer quoted both, the panel stayed empty,
  and the client call was held: the CLI writes a block's message before it asks for it, so the claim
  came first.
- Two parallel calls of one tool (`get_weather` Paris and Rome), results sent in reverse order: each
  `tool_result` carried its own city's result, and the answer paired them right.

## Phase 5: the Responses API

`POST /v1/responses` is OpenAI's Responses API over the same machinery as `/v1/chat/completions`:
the request is read into the same Chat Completions request and `ChatTurn`, the turn runs through
the same runner (queue, target chat, client-tool hold, images, start or continuation, idle
watchdog, disconnect), and only the reading of the body and the writing of the answer differ.

**Sources.** The wire format was read on 2026-10-26 from OpenAI's official reference, in the
Markdown form the site serves (the HTML URL `developers.openai.com/api/reference/responses` answers
404; the index `developers.openai.com/api/reference/llms.txt` lists the pages):

- create: `https://developers.openai.com/api/reference/resources/responses/methods/create.md`
  (request body, the Response object, input and output items, the examples, the streaming example)
- retrieve, delete and input items: `…/responses/methods/retrieve.md`, `…/responses/methods/delete.md`,
  `…/responses/subresources/input_items/methods/list.md`
- streaming events: `https://developers.openai.com/api/reference/resources/responses/streaming-events.md`
- guides: `https://developers.openai.com/api/docs/guides/migrate-to-responses.md`,
  `…/guides/conversation-state.md`, `…/guides/function-calling.md`

The official `openai` SDKs were not checked against the routes: the package is not in this
repository's `node_modules`, and no dependency was added for it.

| File | What it does |
|---|---|
| `packages/core/src/openai/responses-wire.ts` | The Responses wire types: output and input items, the response object, the delete answer, the stream events |
| `packages/core/src/openai/responses-request.ts` | `parseResponsesRequest` (a body to the Chat Completions request plus what only Responses has, or an OpenAI-shaped 400), `responsesTurnOf`, `withPreviousOutput` and `keyAfterPrevious` |
| `packages/core/src/openai/responses-events.ts` | `ResponsesTranslator`: a turn as output items and semantic events, built on `ChatCompletionTranslator` |
| `packages/core/src/openai/responses-store.ts` | `OpenAiResponseStore` over the `openai_responses` table; `Core.openaiResponses` |
| `packages/core/src/openai/system-prompt.ts` | The system prompt's two parts (`systemPromptParts`, `effectiveSystemPrompt`) and `OpenAiChatPromptStore` over `openai_chat_prompts`; `Core.openaiChatPrompts` |
| `apps/api/src/routes/openai.ts` | The four routes; `runTurn`, the turn both POST routes share, driven by a `TurnPlan` |

### The request

| Responses | What Claudio does |
|---|---|
| `input` as a string | One user message |
| `message` items, roles `user`, `system`, `developer`, `assistant` (with or without `type`) | Messages, as in Chat Completions. Parts: `input_text`; `input_image` with `image_url` (data URL or http(s), the phase 2 fetcher and its 5 MB cap); `output_text` and `refusal` in an assistant's. `file_id` images, `input_file` and audio are `400 unsupported_parameter` |
| `function_call` items | Tool calls of the assistant message right before them (an output's message and its calls are one assistant turn), or an assistant message of their own |
| Assistant `message` items | An assistant message each; one right after a `function_call` joins that call's message instead (an output resent: text, calls and the text after them are one turn, as `assistantOfOutput` reads it). Any other item between, a system or developer message included, ends the assistant message, so back-to-back few-shot answers stay two |
| `function_call_output` items | `tool` messages, matched by `call_id`; text output only (image and file parts are refused) |
| `reasoning` items | Dropped: Claudio never returns them and the CLI keeps its own thinking |
| `item_reference`, items of hosted tools | `400 unsupported_parameter`; any other type is `400 invalid_request_error` |
| `instructions` | The system prompt's per-request part, before the conversation's system and developer messages ("The system prompt" below); **not** part of the conversation key |
| `model` | As on Chat Completions; unknown is `404 model_not_found` |
| `reasoning.effort` | `effort`, with the same map as `reasoning_effort` |
| `text.format` `json_schema` (flat: `name`, `schema`, `strict`) / `json_object` / `text` | Phase 3's structured output |
| `tools` of type `function` (flat: `name`, `description`, `parameters`, `strict`) | Phase 4's client tools; `strict` is true unless `false` is sent, as the migration guide says Responses does |
| `tool_choice` `auto` / `none` / `required` / `{ type: "function", name }` | As phase 4 enforces them |
| `parallel_tool_calls` | As phase 4 |
| `previous_response_id`, `store`, `metadata` | Below |
| `user` | Kept for the conversation key, as on Chat Completions |
| `max_output_tokens`, `max_tool_calls`, `temperature`, `top_p`, `top_logprobs`, `service_tier`, `truncation: "auto"`, a non-empty `include`, `safety_identifier`, `prompt_cache_*`, `context_management`, `moderation`, `access_programs`, `text.verbosity`, `reasoning.summary` (and its other fields) | Named in `x-claudio-ignored` |
| `background: true`, `conversation`, `prompt`, hosted tools (`web_search*`, `file_search`, `code_interpreter`, `computer*`, `image_generation`, `mcp`, `shell`, `apply_patch`, `custom`…), `tool_choice` `allowed_tools` or a hosted type | `400 unsupported_parameter` with a message saying what to do instead |
| `tools` together with a JSON `text.format` | `400 unsupported_parameter` (`param: text.format`), the same rule as Chat Completions |

The last item must be a user message or a `function_call_output`, for the same reason as on Chat
Completions. Everything else is phase 2: the credential rule, the per-conversation queue, the body
limit, the headers in and out, the title from the first user text (`titleOf`).

**Why `instructions` stay out of the key.** The reference says they are not carried from one
response to the next, so a client may change them on each request, and its own function-calling
example does: the second request has `instructions` the first did not. With them in the key, that
request would miss the chat that holds the calls. The cost: two clients with the same model, `user`
and resent history, differing only in `instructions`, share a chat. The history includes the
model's own answers, so that takes resending them word for word.

### The system prompt

One rule for both APIs, in `packages/core/src/openai/system-prompt.ts` and `runTurn`. OpenAI's own:
under `previous_response_id`, earlier input messages, system and developer ones included, stay in the
model's context; only `instructions` are not carried over to the next response (the Responses
reference and the conversation-state guide). So an API chat's prompt is kept in two parts
(`SystemPromptParts`):

- **the conversation part**, from system and developer messages (`systemPromptParts`, by what the
  request builds on, `ConversationBase`):
  - a request that is the whole history (a new chat, or one found by its conversation key, whose
    seed already holds the same system messages): its own system and developer messages;
  - `previous_response_id`: the part the stored response's chain reached (`conversation_system` on
    its row), with the new items' system and developer messages added after it;
  - `X-Claudio-Chat-Id` without `previous_response_id`, both APIs: the body may be only the new
    messages, so system messages in it replace the chat's part, and a body with none keeps it. An
    empty system message is one: it clears the part;
- **the per-request part**: Responses' `instructions`, replaced by each request and cleared by one
  without them. Chat Completions has none.

The **effective prompt** is `instructions`, a blank line, then the conversation part; that is what
`--append-system-prompt` carries. `openai_chat_prompts (chat_id PRIMARY KEY, instructions,
conversation, updated_at)` holds, per chat, the parts its process runs with: what a named request
without system messages keeps, across a server restart too, and what says which part a turn could
not take. It is written when a turn starts with the effective prompt; a write that fails is logged
and the turn goes on. The row goes with the chat (`Db.deleteChat`).

`--append-system-prompt` is fixed when the CLI starts, so:

- **The idle process restarts only when the effective prompt changes**: it is ended between turns
  and the chat resumed with the new prompt (`endBetweenTurns`, then `--resume`), as phase 3 does for
  a schema. The session continues; only the warm process and its prompt cache are lost. A request
  that changes nothing, a follow-up that does not resend its developer message say, keeps the process.
- **A cold resume always runs with the effective prompt**: a request without system messages never
  writes an empty one over the conversation's. The prompt is empty only when the conversation has no
  system message and the request no `instructions`.
- **When the restart cannot happen, the live process keeps its prompt** and answers the turn, and
  `x-claudio-ignored` names what it could not take: `instructions` when they changed, `system` when
  the system and developer messages did. Two cases: a held turn (function outputs go on in the
  process that holds the calls; the reference's own function-calling example has `instructions` only
  on its second request), and a chat with client tools while the API's own address is not known yet
  (a restart could not load the stub). Never a 503 for a prompt alone; a schema or tool change still
  is one there, since the answer would be wrong without it. The chat's row keeps the parts the
  process runs with, so a chain (`previous_response_id`, or the resent history) applies the new
  prompt on its next turn; a named delta without system messages keeps the old one.

| The request | Live idle process | No process (cold) | Held turn | Client tools, address unknown |
|---|---|---|---|---|
| Carries the same effective prompt | kept | resumed with it | goes on, nothing named | kept |
| Omits system messages (`previous_response_id`, or `X-Claudio-Chat-Id`) | kept: the chain's or the chat's part stays | resumed with it | goes on, nothing named | kept |
| Changes `instructions` or system messages | restarted with the new prompt | resumed with the new prompt | goes on with the old one, named | kept with the old one, named |
| Drops `instructions` | restarted without them | resumed without them | goes on, `instructions` named | kept, `instructions` named |

### State: `previous_response_id` and `store`

`openai_responses (id PRIMARY KEY, chat_id, conversation_key, response, input_items, created_at, conversation_system)`,
indexed on `chat_id` and `created_at`: one row per response the client asked to keep, written once.
`response` is the object as it was served (its `output` items are what a follow-up continues from),
`input_items` the request's input with ids, `conversation_key` the key after this response, and
`conversation_system` the conversation part of the system prompt its chain reached ("The system
prompt"), as the client sent it even when a held turn could not take it.
`find` reads every column but `input_items`, which only the input-items route reads (`inputItems`).

**Images in the stored input are references, read back on the way out** (`stored-images.ts`). A row
never holds an image's bytes: copying up to 5 MB of base64 into every row, and parsing it on each
lookup, would buy nothing. It holds where they are:

- a data URL: its media type, size, `imageDigest` and the upload holding the bytes. That is the
  upload this turn saved; else one an earlier row of the chat names for the same digest
  (`uploadsOfImage`; a resent history carries its earlier images again, and a warm turn only
  uploads the new ones); else, for a history no row of the chat stored yet (one from Chat
  Completions, say), the bytes are saved as an upload of the chat now, once;
- an http(s) URL: the URL itself, up to 32 KiB (`STORED_IMAGE_URL_MAX`); a longer one, its origin,
  its length and the upload the turn fetched it into.

`GET /v1/responses/:id/input_items` reads each image of the page back from its upload as a data URL,
so a client that rebuilds its history from the list and sends it again sends the same image, and
reaches the same chat (the digest of the bytes does not change with the encoding). When the upload is
gone, the image is listed as a marker: a data URL with the type and size and no payload,
`data:image/png;claudio-omitted-bytes=48213,`, or for a long link `<origin>/?claudio-omitted-chars=<length>`.
Sending a marker back is refused (it is not base64) or fetches the origin, and misses the key; so
does a long link read back as a data URL, whose key was its URL's. `detail` is kept.

- **Stored when** `store` is not false and the turn answered: `completed` (with text or with
  `function_call` items) or `incomplete`. A failed response is not stored. The row is written
  before the stream's last event goes out, so a client that sends its follow-up the moment it reads
  `response.completed` finds it.
- **A write that fails** (`SQLITE_BUSY` from a second process on the data dir, a full disk), of
  the stored response or of the conversation key (on both routes), is logged and the answer is
  still served: `completed` whole, and the stream's last event (`response.completed`, or `[DONE]`)
  still goes out. The turn ran, cost money and may have changed files; a failed answer would make
  the client run it again. What is lost is the way back: the response is not found later (404),
  and a resent history without its key starts the chat again cold. The turn always settles and
  releases its conversation's queue, and the chat's event emitter never sees the throw: a throw
  from the writer is caught and logged where the turn feeds it (`TurnRun.deliver`).
- **A stream item that cannot be written** (a throw from the writer) is logged and skipped alone:
  each item is written on its own, so the ones after it still go out, the stream's last event
  (`response.completed`, `[DONE]`) above all. An item of the turn's end (the finish chunk, the
  error chunk, `[DONE]`, `response.completed` or `response.failed`) is tried once more, then left
  out, so the stream may end plainly, without its last event. It never ends with a failure the turn
  did not have: the stored response and the conversation key already say the turn completed, and a
  client told it failed would run it again. Only a turn that failed streams `response.failed` or an
  error chunk, and nothing but `[DONE]` ever follows a finish chunk. The stored row is the truth.
- **`store: false` writes nothing.** The response still has an id, but `GET` answers 404 and
  `previous_response_id` answers 404. The plan asked for a `stored` column; with nothing to keep for
  such a response, writing no row is the smaller and stricter choice.
- **`previous_response_id`** finds the row, and the request continues that chat with only its new
  items: the stored output is put before them as the assistant message it was, so its calls are
  checked against the `function_call_output` items exactly as a resent history's are, and the delta
  is just the new items. The queue key is `chat:<id>`. An unknown, deleted or never-stored id, an
  expired one and one whose chat is gone or is not an `api` chat are all `404 not_found` with
  `param: previous_response_id`, worded the same. With `X-Claudio-Chat-Id` naming another chat it is
  a 400.
- **The key after a `previous_response_id` turn** is the stored key extended by the new items and
  the answer, so a client that later resends the whole history (same model and `user`, its system
  messages as the first request had them) finds the same chat. It is remembered in
  `openai_conversations` as on Chat Completions, so a request with the whole history and no id finds
  the chat too, with `store` true or false.
- **Forks.** A chat is one line. `previous_response_id` naming an older response of the chain
  continues the chat as it is now, not as it was then: the model sees the later turns too. It is
  the same rule as a resent history that leads to a chat that moved on (phase 2, "two clients
  continuing the same point").
- **Lifetime.** Rows go with their chat (`Db.deleteChat`, inside its transaction, like the other
  chat-keyed rows). The hourly sweep drops rows older than 7 days (`OPENAI_CONVERSATION_TTL_MS`),
  and an `api` chat a stored response still leads to is not deleted. OpenAI keeps responses 30 days.
  `DELETE /v1/responses/:id` removes the row and answers `{ id, object: "response.deleted",
  deleted: true }`. The chat stays, and a resent history still finds it.
- `GET /v1/responses/:id` returns the stored object. `GET /v1/responses/:id/input_items` lists the
  stored input in OpenAI's list shape (`data`, `first_id`, `last_id`, `has_more`), newest first unless
  `order=asc`, with `limit` (1 to 100, 20 by default) and `after`. Only this request's input is listed,
  not the chain before it.

### The response object

`id` (`resp_` and 32 hex characters), `object: "response"`, `created_at`, `completed_at`, `status`,
`error`, `incomplete_details`, `instructions`, `max_output_tokens`, `model` (as asked), `output`,
`parallel_tool_calls`, `previous_response_id`, `reasoning: { effort, summary: null }`, `store`,
`temperature`, `text`, `tool_choice`, `tools` (the function tools as resolved, `strict` included),
`top_p`, `truncation`, `usage`, `user`, `metadata`, `background: false`. No `output_text`: the
reference calls it an SDK-only convenience the Python and JavaScript SDKs compute themselves.

- `output` is a `message` item (`msg_…`, one `output_text` part with `annotations: []` and
  `logprobs: []`) for a stretch of text, and a `function_call` item (`fc_…`, `call_id` the CLI's
  `toolu_…` id, `name`, `arguments` as a JSON string, `status`) per client call, in the order the
  model wrote them.
- `status`: `completed`, including a response that hands calls over (the reference's own example);
  `incomplete` with `incomplete_details.reason: "max_output_tokens"` when a budget or the token limit
  cut the answer (`content_filter` for a refusal), the unfinished item `incomplete`; `failed` with
  `error: { code, message }` (`rate_limit_exceeded` for a usage limit, `server_error` otherwise).
- `usage`: `input_tokens` = input + cache read + cache creation, `input_tokens_details` with
  `cached_tokens` (read) and `cache_write_tokens` (creation), `output_tokens`,
  `output_tokens_details.reasoning_tokens: 0` (the CLI does not report them apart), `total_tokens`;
  phase 2's per-turn figures, null when the CLI reported none, and null on a response that handed
  calls over (the CLI reports usage with the turn's result). The cost stays in `X-Claudio-Cost-Usd`.
- A whole answer that failed is an HTTP error in OpenAI's error shape, as on Chat Completions; an
  `incomplete` one is a 200.

### Streaming

`stream: true` answers `text/event-stream`, each event as `event: <type>` and `data: <json>`, every
event with a `sequence_number` one above the last, from 0. No `[DONE]`: the stream ends after the
last event, as the reference's example does. `X-Claudio-Cost-Usd` is a trailer. The events, in
order:

```text
response.created              (status in_progress, empty output)
response.in_progress
  for a stretch of text:
response.output_item.added    (message, in_progress, content [])
response.content_part.added   (output_text, text "")
response.output_text.delta    … one per piece
response.output_text.done
response.content_part.done
response.output_item.done     (message, completed)
  for each client call:
response.output_item.added    (function_call, in_progress, arguments "")
response.function_call_arguments.delta   (the arguments whole, as the CLI writes the block)
response.function_call_arguments.done
response.output_item.done     (function_call, completed)
response.completed | response.incomplete | response.failed   (the whole response)
```

A failure after `response.created` (a failed result, the process dying, the idle watchdog, a usage
limit) ends with `response.failed` carrying the response and its `error`; the item being written
stays in its output as `incomplete`, with no `.done` events. No `error` event is sent: the reference
defines `error` with only a code and a message, while `response.failed` carries the response with
its `error`, its id and what it wrote before failing, which is what a failed response is. Whether
an SDK raises on `response.failed` was not checked (no SDK in the repository). Structured output streams as one
`output_text.delta` holding the JSON at the end (phase 3).

### Function tools

Phase 4's whole hold, unchanged: the stub MCP server, `can_use_tool` held in the session's own
pending map, the claimed-calls rule, withdrawn calls, the timeout setting, the cold resume with
`X-Claudio-Resume: cold`, and a new user message dropping the held calls. In this shape:

1. The response ends `completed` with its `function_call` items while the CLI holds the calls.
2. The client runs them and sends one `function_call_output` per `call_id`, with
   `previous_response_id` (the usual way) or after the whole history (`…input, …response.output`,
   as the function-calling guide builds it). The held calls take the results and the same CLI turn
   goes on.
3. A user message and no output for the calls drops them, as on Chat Completions. Outputs for some
   calls but not all, or for a call that was never made, are a 400 naming them.

Every refusal is in this shape's words: `param: "input"`, and messages about `function_call_output`
items and their `call_id`, never Chat Completions' `tool` messages and `tool_calls` (a
`ResultsVocabulary` per API, `RESPONSES_RESULTS` and `CHAT_COMPLETION_RESULTS` in `client-tools.ts`).
The same goes for `x-claudio-ignored`: an effort a live process cannot take is `reasoning.effort`
here, `reasoning_effort` on Chat Completions; images that fail point at `input`.

**Text after a call.** One API message can hold text, a client call and more text. The text after
the call is a `message` item of its own, and it does not start with the `\n\n` that joins two text
blocks: an item never inherits the separator, while two text blocks with no call between stay one
item joined by it. The rule is `ResponsesTranslator`'s alone: it strips the separator from the
chunk that opens a new message item once some text went out, and Chat Completions' translator
streams the text as it always did. The answer's text for the conversation key keeps the separator, which is how
`assistantOfOutput` joins a stored output's message items, and a resent output reads back the same
way: an assistant `message` item right after a `function_call` joins that call's assistant message
(texts joined by a blank line), so `[…input, …response.output]` hits the same key as
`previous_response_id` does. Any other item ends the assistant message.

### Evidence from the real CLI

Two smoke runs on Claude Code 2.1.310, `haiku`, every spawn capped with `--max-budget-usd 0.5`,
in process through the real routes, core and stub (no dev server), 2026-10-26, 0.0109 USD for both:

- Streamed text, then `previous_response_id`: the stream was exactly `0 response.created`,
  `1 response.in_progress`, `2 output_item.added`, `3 content_part.added`, `4`-`5 output_text.delta`,
  `6 output_text.done`, `7 content_part.done`, `8 output_item.done`, `9 response.completed`, with
  usage (27,448 input of which 11,344 cached and 16,102 written, 106 output) and 0.0034 USD. The
  follow-up with `previous_response_id` ran in the same chat on the same process, answered
  "The Loire. France's longest river." with 27,446 of its 28,577 input tokens cached, and cost
  0.0005 USD.
- A function call round trip: the first response was `completed` with one `function_call`
  (`get_secret`, `{"key":"alpha"}`, `call_id` `toolu_01WB…`), no usage and no cost header. The
  `function_call_output` with `previous_response_id` answered `ZEBRA-4471-KUMQUAT` in the same chat,
  with the CLI turn's usage, 0.0070 USD.

### Limits

- `background`, `conversation` objects, stored prompts, hosted tools and `item_reference` are not
  supported (400).
- `GET /v1/responses/:id` does not stream (`stream=true` on the retrieve route is ignored), and
  there is no `cancel` (it only applies to background responses).
- `previous_response_id` to an older response of a chain continues the chat as it is now (Forks,
  above).
- Stored responses live 7 days, not 30.
- `input_items` lists the request's own input, not the chain's, and an image as a reference, not
  its data (above).
- The SDK parse check was not run (the package is not in the repository).

## Using it

The base URL is `http://127.0.0.1:<port>/api/v1` (the dev server's port is 8797; the desktop app
shows its own). Set an API token first if none is set (Settings → Access & safety, or
`POST /api/security/token`, which shows it once).

```bash
TOKEN=...   # the API token
curl -s http://127.0.0.1:8797/api/v1/models -H "Authorization: Bearer $TOKEN"

curl -s http://127.0.0.1:8797/api/v1/chat/completions -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Say hi in one word"}]}' -D -

curl -N http://127.0.0.1:8797/api/v1/chat/completions -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'X-Claudio-Cwd: /home/me/code/my-project' \
  -d '{"model":"sonnet","stream":true,"stream_options":{"include_usage":true},
       "messages":[{"role":"user","content":"What does this repo do?"}]}'
```

With the `openai` SDK (Python; the Node SDK takes the same `baseURL` and `apiKey`):

```python
import json

from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8797/api/v1", api_key=TOKEN)
reply = client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "Say hi"}])
print(reply.choices[0].message.content, reply.usage)

# The same conversation continues: resend the history with the answer and a new message
history = [{"role": "user", "content": "Say hi"}, {"role": "assistant", "content": reply.choices[0].message.content},
           {"role": "user", "content": "Now in Spanish"}]
for chunk in client.chat.completions.create(model="sonnet", messages=history, stream=True):
    print(chunk.choices[0].delta.content or "", end="")

# Claudio's own parameters are headers
raw = client.chat.completions.with_raw_response.create(
    model="sonnet", messages=[{"role": "user", "content": "hi"}], extra_headers={"X-Claudio-Tool-Preset": "read-only"})
print(raw.headers["x-claudio-chat-id"], raw.headers.get("x-claudio-cost-usd"))

# A structured answer: the content is JSON that matches the schema
city = client.chat.completions.create(
    model="haiku", messages=[{"role": "user", "content": "The capital of France?"}],
    response_format={"type": "json_schema", "json_schema": {"name": "city", "schema": {
        "type": "object", "properties": {"capital": {"type": "string"}}, "required": ["capital"]}}})
print(json.loads(city.choices[0].message.content)["capital"])

# Client tools: the turn ends with the calls, the next request brings the results
tools = [{"type": "function", "function": {"name": "get_weather", "description": "Current weather in a city",
          "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
messages = [{"role": "user", "content": "What's the weather in Madrid?"}]
first = client.chat.completions.create(model="sonnet", messages=messages, tools=tools)
assert first.choices[0].finish_reason == "tool_calls"
messages.append(first.choices[0].message)          # the assistant message with its tool_calls
for call in first.choices[0].message.tool_calls:
    args = json.loads(call.function.arguments)
    messages.append({"role": "tool", "tool_call_id": call.id, "content": f"21 C and sunny in {args['city']}"})
final = client.chat.completions.create(model="sonnet", messages=messages, tools=tools)
print(final.choices[0].message.content)
```

The Responses API, with the same client (Python; the Node SDK is the same shape):

```python
# One turn, then a follow-up that continues the same chat from the stored response
first = client.responses.create(model="sonnet", instructions="Be brief.", input="Name a river in Spain")
print(first.output_text)
second = client.responses.create(model="sonnet", previous_response_id=first.id, input="And one in France?")
print(second.output_text)

# Streamed: the semantic events, from response.created to response.completed
for event in client.responses.create(model="sonnet", input="Count to three", stream=True):
    if event.type == "response.output_text.delta":
        print(event.delta, end="")

# A function tool round trip: the response hands the call over, function_call_output answers it
tools = [{"type": "function", "name": "get_weather", "description": "Current weather in a city",
          "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
asked = client.responses.create(model="sonnet", input="What's the weather in Madrid?", tools=tools)
results = [{"type": "function_call_output", "call_id": item.call_id,
            "output": f"21 C and sunny in {json.loads(item.arguments)['city']}"}
           for item in asked.output if item.type == "function_call"]
final = client.responses.create(model="sonnet", previous_response_id=asked.id, input=results, tools=tools)
print(final.output_text)
```

With curl:

```bash
curl -s http://127.0.0.1:8797/api/v1/responses -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","input":"Weather in Madrid?",
       "tools":[{"type":"function","name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}]}'
# → "id":"resp_…", "status":"completed",
#   "output":[{"type":"function_call","id":"fc_…","call_id":"toolu_01…","name":"get_weather","arguments":"{\"city\":\"Madrid\"}","status":"completed"}]

curl -s http://127.0.0.1:8797/api/v1/responses -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","previous_response_id":"resp_…",
       "input":[{"type":"function_call_output","call_id":"toolu_01…","output":"21 C and sunny"}],
       "tools":[{"type":"function","name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}]}'
# → the final answer as a message item, in the same chat

curl -N http://127.0.0.1:8797/api/v1/responses -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"model":"sonnet","input":"Say hi","stream":true}'
# → event: response.created / data: {…,"sequence_number":0} … event: response.completed

curl -s http://127.0.0.1:8797/api/v1/responses/resp_… -H "Authorization: Bearer $TOKEN"            # the stored response
curl -s -X DELETE http://127.0.0.1:8797/api/v1/responses/resp_… -H "Authorization: Bearer $TOKEN"  # {"id":…,"object":"response.deleted","deleted":true}
```

The Chat Completions round trip with curl (the ids come from the first answer):

```bash
curl -s http://127.0.0.1:8797/api/v1/chat/completions -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"model":"sonnet",
    "messages":[{"role":"user","content":"Weather in Madrid?"}],
    "tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}'
# → "finish_reason":"tool_calls", "tool_calls":[{"id":"toolu_01…","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Madrid\"}"}}]

curl -s http://127.0.0.1:8797/api/v1/chat/completions -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"model":"sonnet",
    "messages":[{"role":"user","content":"Weather in Madrid?"},
      {"role":"assistant","content":null,"tool_calls":[{"id":"toolu_01…","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Madrid\"}"}}]},
      {"role":"tool","tool_call_id":"toolu_01…","content":"21 C and sunny"}],
    "tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}'
# → the final answer, in the same chat
```

## Related

[[plans/openai-compatible-api.md]] · [[plans/openai-compatible-api-spike.md]] · [[rest-api.md]] · [[cli-surfaces.md]] · [[securing.md]] · [[security-model.md]]
