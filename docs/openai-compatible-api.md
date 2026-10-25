---
created_at: 2026-10-25T16:00:00Z
updated_at: 2026-10-25T16:00:00Z
tags:
    - api
    - openai
    - chats
---
# The OpenAI-compatible surface

Clients that speak OpenAI's Chat Completions format will reach Claudio under `/api/v1`, and each
request becomes a real Claudio chat ([the plan](plans/openai-compatible-api.md)). This page describes
what is built. Today that is **phase 1 only**: the pure translators and the conversation table in
`packages/core/src/openai/`, with unit tests. No route serves them yet; phase 2 adds the routes.

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
not on the `RunEvent`. So `push(resultEvent, { usage })` takes the counts from the caller, and
`tokenUsageOf(modelUsage)` sums them. When none are given, the body has no `usage` and no usage
chunk is sent. Nothing is estimated.

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
chat-keyed tables. `expire(olderThan)` drops keys not answered since then. Nothing calls it yet:
phase 2 decides the period. Chats pruned by `saveChats(keep)` keep their rows until they expire, and
a lookup must check that the chat still exists.

## Related

[[plans/openai-compatible-api.md]] · [[plans/openai-compatible-api-spike.md]] · [[rest-api.md]] · [[cli-surfaces.md]]
