---
created_at: 2026-10-25T12:00:00Z
updated_at: 2026-10-25T20:00:00Z
tags:
    - plan
    - api
    - openai
    - chats
    - design
---
# Plan: an OpenAI-compatible surface on Claudio's API

Status: **design settled, spike done (GO with changes); phase 1 (translators and the conversation table) built on branch `feat/openai-phase1`; phase 2 (`/v1/models`, `/v1/chat/completions` whole and streamed, the `/v1` error handler, the credential rule, image fetching, the conversation expiry) built on branch `feat/openai-phase2`; phases 3-6 not built (2026-10-25).** What is built is described in [openai-compatible-api.md](../openai-compatible-api.md). The owner chose: each
request is a real Claudio chat with tools, the routes live in `apps/api`, and the first version covers
`chat/completions` with streaming, `models`, tools / function calling, `/v1/responses` and images.
The research below found a terms-of-use constraint and several precedents that change the decisions
marked **(revised)**.

Owner answers, 2026-10-25: (1) the surface is for local use only, on the owner's own machine or lab
or on the machine of whoever runs Claudio with their own login, so the terms-of-use risk is accepted
and the docs say so instead of building account gates; it stays loopback-first and guarded like the
rest of the API. (3) `/v1/responses` stays in the first version: the surface ships complete. (4)
Client tool calls are held at `can_use_tool` with a stub MCP server; the spike
([openai-compatible-api-spike.md](openai-compatible-api-spike.md)) gave GO with changes, and they are
folded in below. (5) Claudio's own parameters travel as `X-Claudio-*` headers, never in the body. (6)
The wait for a held client tool call is a setting, 10 minutes by default.

## Why

Clients and SDKs that speak OpenAI's wire format (the `openai` SDKs, Open WebUI, Continue, LangChain,
LiteLLM) should be able to use Claudio as a server by changing a base URL. Claudio's own contract
(`POST /chats`, `GET /chats/:id/stream` with `RunEvent`) stays as it is; this is an adapter over it,
not a second engine.

## The one rule

The adapter stays inside Claudio: it translates between two HTTP shapes and drives chats through the
same `core` service the REST routes use. It adds no SDK, no call to Anthropic and no login.

## Prior art and risks found

Researched on 2026-10-25 in English, Chinese, Russian, French and Spanish sources. Closest projects:
`iavinas/claude-code-api-proxy` (Chat Completions over the CLI), `RichardAtCT/claude-code-openai-wrapper`
(Agent SDK), `i-am-logger/claude-code-proxy` (adds `/v1/responses`), `AntonioAEMartins/claude-code-proxy`,
`MehdiMohseni82/claude-code-proxy` (keys, rate limits), and the npm `claude-max-api-proxy`.

1. **Terms of use is the biggest risk.** Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance)
   says OAuth (Pro/Max) is for ordinary individual use of Claude Code; products built on the Agent SDK
   should use API keys; developers may not "route requests through Free, Pro, or Max plan credentials on
   behalf of their users" nor intermediate Claude.ai credentials; the binary must stay unmodified; and
   Anthropic may enforce without notice. It blocked harnesses spoofing Claude Code on 2026-01-09. The
   June 15 2026 billing split for `claude -p` / Agent SDK was **paused** (official help article, updated
   2026-10-07: Max and Team now include monthly API credits), so this can change again. A local, single
   owner using their own login through the unmodified CLI is the supported shape; **an endpoint other
   people or services call with the owner's subscription is the unsupported one.**
2. **Tool calling has a precedent, and it is not mine.** `iavinas` runs the CLI with no built-in tools
   and returns client tool calls through `--json-schema` (tool parameters embedded in one output
   schema), so the CLI never waits on the client. Known limits there: no `$ref`/`$defs`, arguments need
   validation, and streaming is buffered. Nobody has shipped built-in tools plus held client tools in
   one request; the held-MCP-call handoff below is untested territory.
3. **Sessions are the hard part everywhere.** Precedent: an episode key (model, system, first user turn),
   a hash chain over consumed messages, delta prompts on resume, serialized requests per key, a cold
   fallback when the resume fails, idle expiry, and an in-memory map lost on restart (which we avoid
   with SQLite). A per-conversation header is how multi-user safety is done.
4. **Clients create hidden traffic.** Chat front ends send extra requests (titles, tags, follow-ups)
   with different prompts; each would become a chat in Claudio's list (inferred from how those clients
   behave, to be checked with Open WebUI in the spike).
5. **Wire details that break clients.** The final usage chunk has `choices: []` and every other chunk
   `usage: null`; tool-call deltas need a stable `index` and are reassembled by clients; `content` is
   null while a tool call streams; a mid-stream error must be an error chunk, not a silent end;
   Responses streaming needs the `response.created` / `output_text.delta` / `completed` sequence and
   `previous_response_id` needs stored state; the `developer` role exists.
6. **Operational.** The CLI starts per request (tools off is 5-10x faster in the wrapper's own words);
   long runs hit idle and request timeouts; a client that disconnects must stop the chat; a wrapper
   that tested against one CLI version (2.1.267) drifts; cost must come from the `result`, never a
   flat per-token guess; the Agent SDK wrapper shipped with auth off and `CORS: *`.

## Shape

Routes registered in `apps/api` under the existing `/api` prefix, so the base URL a client sets is
`http://<host>:<port>/api/v1` and every request already passes the guard in `security.ts`
(`Authorization: Bearer`, the same tokens, the same audit actor).

| Route | What it does |
|---|---|
| `GET /v1/models` | The models of the providers that can run chats (`driver.models()`), in OpenAI's `{ object: 'list', data: [{ id, object: 'model', created, owned_by }] }` |
| `GET /v1/models/:id` | One of them, 404 in OpenAI's error shape |
| `POST /v1/chat/completions` | A turn, answered whole or as `data:` chunks ending in `data: [DONE]` |
| `POST /v1/responses` | The same turn in the Responses API's shape (`input`, `output[]`, semantic events when streaming) |

Code lives in a new `apps/api/src/routes/openai.ts` plus pure translators in
`packages/core/src/openai/` (request to `NewChatRequest`, `RunEvent` to chunk, usage and errors), so
the mapping is tested without a server.

## Decisions

### 1. A request is a chat, and the conversation is found again

OpenAI is stateless: the client resends the whole history. Claudio's chat is a session that holds it.

- **Identity.** A client may name the chat with the `X-Claudio-Chat-Id` header. Every answer returns
  the id in the same header, so an aware client resumes by id. All of Claudio's own parameters are
  `X-Claudio-*` headers (`Chat-Id`, `Cwd`, `Tool-Preset`, `Show-Tools`) because they pass through
  every SDK, while strict ones reject unknown body fields.
- **No id.** The adapter hashes the history up to and including the last assistant message and looks
  it up in a small SQLite table (`openai_conversations`: hash, chat id, updated at). A hit resumes
  that chat with only the new user turn; a miss starts a new chat whose first prompt carries the
  history rendered as a transcript. Rows expire with the chat.
- A resume of a chat nobody holds uses `chats.resume`; one with a live execution uses `chats.send`.

### 2. Tools: Claude's own run server-side, the client's are handed back

- **Claude Code's built-in tools** (Read, Edit, Bash, …) run on the machine and are not part of the
  OpenAI response. Their activity is optional: `reasoning_content` is not used; the answer is the
  assistant's text. A request can ask to see them with `x-claudio-show-tools: 1`, which streams them
  as commentary, off by default.
- **The client's `tools` / `functions`** (**revised, chosen by the owner 2026-10-25, confirmed by the
  spike**) become a stub MCP server for that request, served by the API and passed with `--mcp-config`
  next to Claudio's usual servers (HTTP works; stdio is not needed). The hold is on the CLI's
  `can_use_tool` control request for a stub tool, which stays pending for 30 minutes and more with no
  CLI timeout. Holding inside the stub's handler does not work: it times out at 60 s and the model
  retries the call. The stub itself never waits.
- **The protocol, as the spike found it.**
  1. The chat runs with `permissionPrompts: 'host'`; with `'none'` the CLI denies every request by
     itself and nothing is held. The adapter, not a person, answers each request: client tools are
     held, everything else is denied at once.
  2. The client's calls are read from the `tool_use` blocks, not from the control requests. The HTTP
     turn ends at `message_stop` with `finish_reason: "tool_calls"` and the call ids, and the process
     stays alive. Waiting for one request per call deadlocks, because a second request arrives only
     after the first call has run.
  3. The stub lists its tools with `readOnlyHint: true`, so a parallel turn raises all its requests
     together and they run at once, and with `alwaysLoad: true` on the server, or Claude first spends
     a round trip on a tool search and ignores a "you must call a tool" instruction.
  4. The next request, whose trailing messages have `role: "tool"`, finds the chat by the
     conversation key, allows each held request with its original input, and the stub returns the
     client's result already known, matched by `_meta["claudecode/toolUseId"]` (undocumented, seen on
     the wire; first in, first out is the fallback).
  5. The held requests live in the adapter's own pending map, **not in `PermissionBroker`**, or its
     10-minute deny and the panel's buttons would let a person answer a client's call.
  6. `tool_choice` is applied when each request is answered on a live process, since launch flags are
     fixed at start: `none` and a named function are enforced (deny the others), `required` is a prompt
     instruction only, and built-in tools can still run in the same turn.
- **The wait is a setting**, `openaiToolCallTimeoutMinutes`, 10 by default (a settings-shaped
  document, so JSON, with a reset like every setting). A held call nobody resolves in that time is
  answered with an error result and the chat stops. A client disconnect interrupts the chat, which
  cancels the held call cleanly.
- **Fallbacks, in order.** If the process is gone when the result arrives (restart, idle expiry), the
  chat resumes cold with `--resume`: the CLI records its own "tool call interrupted" error for the
  dangling call and the client's result goes in as a user message, and the response says
  `x-claudio-resume: cold`. A hold past about an hour probably pays to rebuild the prompt cache, which
  costs money and changes no answer (not measured past 30 minutes). Rejected: the `--json-schema`
  channel (no real streaming, no `$ref`, no mixing with built-in tools), deny-and-resume (not a native
  tool result) and replaying injected `tool_use` blocks (the CLI fixed a bug there in 2.1.251).

### 3. Permissions and working directory

The API is unattended: nobody can answer a permission prompt. A chat with no client tools runs with
`permissionPrompts: 'none'`; a chat with client tools runs with `'host'` and the adapter answers for
it (decision 2). Either way it uses the default tool preset (`GET /config/tool-presets`), never
`bypassPermissions`.
`X-Claudio-Cwd` (a project path Claudio already knows, checked like `cwd` in `POST /chats`) and
`X-Claudio-Tool-Preset` select the rest. Without them the chat has the wrapper workspace and the default
preset. **A request that can run Bash is remote code execution**: the routes require a credential
even in modes where `/chats` would not, and a collaborator's token may call them only with the
permissions its share grants.

### 4. Parameter mapping

| OpenAI | Claudio |
|---|---|
| `model` | `model`; an unknown id is a 404 `model_not_found` |
| `messages[].role` `system` / `developer` | `appendSystemPrompt` |
| `messages[].content` text | the prompt |
| `messages[].content` image parts (`image_url`, data URL or http) | an upload (`POST /uploads` service) attached to the message; an http URL is fetched with a size cap |
| `reasoning_effort` | `effort` |
| `max_tokens` / `max_completion_tokens`, `temperature`, `top_p`, `stop`, `n > 1`, `logprobs` | not supported by the CLI; ignored with a header `x-claudio-ignored` naming them, except `n > 1`, which is a 400 |
| `response_format: json_schema` | `jsonSchema` |
| `stream: true`, `stream_options.include_usage` | SSE chunks from `partial` events (`append`) and a final usage chunk |
| `user` | stored with the conversation row, nothing else |

`usage` comes from the `result` event's outcome (input, output and cache tokens); cost goes in a
`x-claudio-cost-usd` header, not in the body.

### 5. Errors follow OpenAI's shape

`{ error: { message, type, param, code } }` for everything under `/v1`, built in a dedicated error
handler for that scope so the rest of the API keeps `{ error: string }`. Status mapping: 401
`invalid_api_key`, 404 `model_not_found`, 400 `invalid_request_error`, 429 `rate_limit_exceeded`
(the usage limit and the spend gate, with `Retry-After` from the reset time), 500 `server_error`.

## Rejected

- **A separate proxy process.** Another port, another token and no access to `core`; the owner chose
  routes in the API.
- **One-shot chats with no tools.** Safer, but not what the owner asked for; the confined mode stays
  possible later as a model id suffix.
- **Sampling parameters faked client-side.** `temperature` and the like cannot be honoured by the CLI;
  pretending to would be wrong answers with no signal.

## Build order

1. Translators and the conversation table, with unit tests (no server).
2. `GET /v1/models`, `POST /v1/chat/completions` whole, then streaming; error handler.
3. Images and `response_format`.
4. The client-tool handoff (the spike is done): first the adapter answering `can_use_tool` itself and
   its own pending map, which touch the chat runner, then the stub MCP server, the `tool_calls`
   turn end, result matching, `tool_choice`, the cold resume and the timeout setting.
5. `POST /v1/responses` on top of the same translators.
6. Docs: a row per route in `docs/rest-api.md`, `ROUTE_DOCS` entries with summary and tag, a how-to
   with `curl` and the `openai` SDK, and the shared types if any move (`openapi:schemas`).

## Open for the owner

Nothing: every decision is settled. The one thing not measured is a hold longer than 30 minutes.

## Related

[[openai-compatible-api-spike.md]] · [[openai-compatible-api.md]] · [[rest-api.md]] · [[rest-api-contract.md]] · [[chat-api-token.md]] · [[cli-surfaces.md]] · [[chat-environment.md]]
