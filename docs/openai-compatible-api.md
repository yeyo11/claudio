---
created_at: 2026-10-25T16:00:00Z
updated_at: 2026-10-25T20:00:00Z
tags:
    - api
    - openai
    - chats
    - how-to
---
# The OpenAI-compatible surface

Clients that speak OpenAI's Chat Completions format will reach Claudio under `/api/v1`, and each
request becomes a real Claudio chat ([the plan](plans/openai-compatible-api.md)). This page describes
what is built: **phases 1 and 2**. Phase 1 is the pure translators and the conversation table in
`packages/core/src/openai/`. Phase 2 serves them: `GET /v1/models`, `GET /v1/models/:id` and
`POST /v1/chat/completions`, whole and streamed, in `apps/api/src/routes/openai.ts`. Client tools
(phase 4), `response_format` (phase 3) and `/v1/responses` (phase 5) are not built yet.

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
  in `ChatTurn`. Nothing acts on them until phase 4.
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
- `toolCallDelta({ id, name, argumentsAppend })` is phase 4's entry point. The first fragment of a
  call carries `index`, `id`, `type` and the name, and later fragments only `index` and arguments.
  `content` is `null` in those chunks.
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
`["user", ...text | ["image", sha256(url or data)]]`, `["assistant", text, [[id, name, args]...]]`,
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
| `apps/api/src/sse.ts` | `openStream` takes extra headers and announced trailers, writes a raw `data:` line (for `[DONE]`) and ends the reply. |
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
  `lastReportedCostUsd`.
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

1. The body is read (`parseChatCompletionRequest`). What phase 2 cannot do is refused with
   `400 unsupported_parameter`: client `tools` / `functions`, a `tool_choice` / `function_call` that
   needs them (`required` or a named function; `auto` and `none` pass), and `response_format` other
   than `text`. The message says they arrive in a later version. Then the model must be in the
   catalogue (`404 model_not_found`), `X-Claudio-Cwd` must be valid and `X-Claudio-Tool-Preset` must
   name a stored preset.
2. **Serialised per conversation.** Requests wait in a queue keyed by the conversation key (or by
   `chat:<id>` with `X-Claudio-Chat-Id`), then also on `chat:<id>` once the chat is known, so a
   request that names the chat and one that finds it by history wait for each other. A queue rather
   than a 409: the SDKs retry a 409 anyway, and the queue answers without the round trip. Two clients
   continuing the same point of one conversation therefore run in turn in one chat, and the second
   sees the first's exchange in the chat's context.
3. **The chat.** `X-Claudio-Chat-Id` names it (unknown is `404 not_found`). Otherwise the history key
   is looked up; a row whose chat no longer exists is forgotten and counts as a miss. A miss starts a
   new chat with the cold prompt, a hit continues with the delta.
4. **Images** of the chosen prompt are uploaded (`uploadOpenAiImages`, with `fetchImage` and
   `core.uploads.save`) and attached to the message.
5. **The turn.** A new chat is created with `permissionPrompts: 'none'`, the default tool preset (or
   the header's), the app's default permission mode, except that `bypassPermissions` becomes `manual`,
   and origin `api`. A chat with a live idle process gets the turn as a message
   (`chats.send`); a live chat that is busy is `409 conflict`, and one running with
   `bypassPermissions` is refused too. A chat nobody holds is resumed (`chats.resume`) with the same
   mode and prompt settings. The runner subscribes to the chat **before** the turn is sent (inside
   `create`'s `onStart` for a new chat) and asks `ChatManager.nextResult` when the turn is over, so a
   process that dies without a result, or a stop, ends the answer as an error and a limit replay
   that changes accounts does not.
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
| `X-Claudio-Cwd` | in | Where a new chat runs: an absolute, existing directory inside the workspace or an imported project. Stricter than `cwd` on `POST /chats`, which only checks the type and creates the directory. Ignored for a chat that exists. UTF-8 bytes are read as UTF-8 |
| `X-Claudio-Tool-Preset` | in | A stored tool preset id instead of the default preset |
| `X-Claudio-Spend-Override: 1` | in | Past the daily spend cap, as on `POST /chats` |
| `X-Claudio-Chat-Id` | out | The chat, on every answer once it is known, errors after the start included |
| `X-Claudio-Cost-Usd` | out | This turn's cost; an HTTP trailer on a streamed answer, since it is known only at the end |
| `X-Claudio-Ignored` | out | Parameters the CLI cannot honour (`temperature`, `max_tokens`…), and `reasoning_effort` sent to a chat whose process is up (the effort of a live process cannot change) |
| `Retry-After` | out | On every 429 |

### Errors under /v1

The routes live in their own Fastify context with their own error handler and 404, so everything
under `/api/v1` answers `{ error: { message, type, param, code } }` and the rest of the API keeps
`{ error: string }`. Core's plain `Error`s keep the 400 or 404 the main handler gives them. What
answers before a handler runs (the guard's 401, 421 and 429, read-only's 405, the spend gate's 409)
is rewritten by an `onSend` hook of the context: the status stays, except the spend cap, whose 409
becomes `429 rate_limit_exceeded` with `Retry-After` to local midnight. A start refused for lack of
a run slot (`Concurrent run limit reached`) is `429` with `Retry-After: 5` instead of a 400, so SDKs
retry by themselves.

### Authentication

The plan asks for a credential even where `/chats` needs none, because a request here starts a chat
that may run Bash. Under `mode: token` and `oidc` the guard already asks for one. Under `mode: none`
the guard now asks `/api/v1/*` for the owner's API token (checked against the stored hash whatever
the mode) or a chat's own token from this machine (the same loopback check the guarded modes use);
anything else is a 401, and a wrong credential counts toward the failure back-off. With no token
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

- Client tools (phase 4) and `response_format` (phase 3: the answer must come from the result's
  `structuredOutput`, and a live process cannot change its schema) are refused.
- A chat continued by `X-Claudio-Chat-Id` keeps its live process's settings: its system prompt and
  effort do not change for that turn (effort is named in `x-claudio-ignored`); its model does change.
- `created` in a model object is 0: the catalogue has no date.
- A run refused for memory pressure (not for the run count) is still a 409.

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
```

## Related

[[plans/openai-compatible-api.md]] · [[plans/openai-compatible-api-spike.md]] · [[rest-api.md]] · [[cli-surfaces.md]] · [[securing.md]] · [[security-model.md]]
