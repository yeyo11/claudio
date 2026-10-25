---
created_at: 2026-10-25T10:30:00Z
updated_at: 2026-10-25T10:30:00Z
tags:
    - plan
    - spike
    - api
    - openai
    - mcp
    - permissions
    - cli
---
# Spike: holding a client tool call across two HTTP requests

Status: **done, 2026-10-25, against Claude Code 2.1.310 with `haiku`.** It answers decision 2 of
[[plans/openai-compatible-api]]: can Claudio hand an OpenAI client's tool call back to the client,
keep the CLI process waiting, and feed the client's result in on the next request, using a stub MCP
server plus the CLI's `can_use_tool` control request?

**Verdict: GO WITH CHANGES.** The hold works end to end and has no CLI-side timeout: tested at
5 s, 60 s, 5 min and 30 min. Allowing the call makes the CLI call the stub, and the stub's return
value is the tool result Claude sees. What the plan must change is listed under
[Changes to the plan](#changes-to-the-plan). Most important: parallel calls are asked for **one after
the other** unless the stub marks its tools `readOnlyHint`, and decision 3's
`permissionPrompts: 'none'` makes the hold impossible.

Everything below went through the documented surfaces only: CLI flags, the stream-json control
protocol on stdin/stdout, an MCP server over HTTP loaded with `--mcp-config`, and the session
transcript the CLI writes.

## Setup

A throwaway Node harness (no dependencies) spawned the CLI with the flags `buildArgs` produces for
`permissionPrompts: 'host'` (`packages/core/src/providers/claude-code/args.ts`) and logged every line
in both directions with a timestamp:

```text
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --replay-user-messages
  --permission-mode default --allow-dangerously-skip-permissions
  --session-id <uuid> --model haiku
  --mcp-config=<file> --strict-mcp-config --max-budget-usd 0.5
  --permission-prompts host --permission-prompt-tool stdio
```

The MCP config pointed at a stub served by the harness itself over **Streamable HTTP**. HTTP is
accepted by `--mcp-config` and reported as `{"name":"client","status":"connected","source":"dynamic"}`
in `init`, so stdio was not needed:

```json
{ "mcpServers": { "client": { "type": "http", "url": "http://127.0.0.1:<port>/mcp", "alwaysLoad": true } } }
```

The stub answers JSON-RPC with plain `application/json` bodies (no SSE). The CLI first sends a
`server/discover` probe, and a `-32601` answer makes it fall back to `initialize`. A `GET /mcp`
answered 405 is accepted. This is the whole server:

```js
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(405).end();
  let body = ''; for await (const c of req) body += c;
  const msg = JSON.parse(body);
  if (msg.id === undefined) return res.writeHead(202).end();          // notifications
  let result;
  if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'claudio-client-tools', version: '0.0.1' } };
  else if (msg.method === 'tools/list') result = { tools: tools.map((t) => ({ name: t.name,
    description: t.description, inputSchema: t.parameters, annotations: { readOnlyHint: true } })) };
  else if (msg.method === 'tools/call') result = { content: [{ type: 'text',
    text: await onCall(msg.params.name, msg.params.arguments, msg.params._meta?.['claudecode/toolUseId']) }] };
  else if (msg.method === 'ping') result = {};
  else return reply(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
  reply(res, { jsonrpc: '2.0', id: msg.id, result });
});
```

The harness answered `can_use_tool` the way `ControlChannel.answer` does, after a configurable hold:

```js
// allow: the stub runs and its text becomes the tool_result
{ type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'allow', updatedInput: request.input } } }
// deny: the message becomes an is_error tool_result
{ type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'deny', message: '…' } } }
// client gone: interrupt the turn
{ type: 'control_request', request_id: 'spike-1', request: { subtype: 'interrupt' } }
```

Each run cost $0.001–0.005.

## The eight questions

| # | Question | Verdict | Evidence (lines the CLI wrote or read) |
|---|---|---|---|
| 1 | Does `can_use_tool` arrive for `mcp__<server>__<tool>` before it runs, with its input? | **Works** | Right after the `tool_use` block: `{"type":"control_request","request_id":"a138f0ee-…","request":{"subtype":"can_use_tool","tool_name":"mcp__client__get_secret","mcp_server":{"name":"client","source":"dynamic"},"display_name":"Get Secret","input":{"key":"alpha"},…,"tool_use_id":"toolu_01F5SfNCH8YxjxeDn2xffFdK"}}`. No `tools/call` reaches the stub until it is answered. Claudio's existing `host` flags are enough, with no `--allowedTools` for the tool. |
| 2 | Does a held request survive 60 s / 5 min / longer, with no CLI timeout? | **Works** | Held 60 s (`64.89 answering alive:true` → `tool_result … ZEBRA-4471-KUMQUAT`), 300 s (`305.78 answering` → same) and 1800 s (see [the 30-minute hold](#the-30-minute-hold)). The CLI writes **nothing** while it waits: no keepalive and no cancel. `MCP_TOOL_TIMEOUT` is irrelevant there: no `tools/call` is in flight until the allow. The only clock is Claudio's own `PermissionBroker` (10 min default). |
| 3 | After `allow`, does the stub run and does its value become the tool result? | **Works** | `cli<- …"behavior":"allow","updatedInput":{"key":"alpha"}` → `mcp<- {"method":"tools/call","params":{"name":"get_secret","arguments":{"key":"alpha"},"_meta":{"claudecode/toolUseId":"toolu_01F5…","progressToken":2}}}` → `user … tool_result toolu_01F5… [{"type":"text","text":"ZEBRA-4471-KUMQUAT"}]` → final text `ZEBRA-4471-KUMQUAT`. HTTP works and stdio was not needed. |
| 4 | Parallel calls: together or one after the other, ids, answer order? | **Works with caveat** | Without annotations, **serial**: both `tool_use` blocks stream (`toolu_01JF…` alpha, `toolu_01As…` beta) and the API message ends, but only the first `can_use_tool` arrives. The second (`21846a89-…`) arrives only after the first call has **run and returned** (`8.65 tool_result toolu_01JF…`, then `8.65 control_request … "tool_use_id":"toolu_01As…"`). Waiting for both asks before answering deadlocks. With `annotations: { readOnlyHint: true }`, both asks arrive together (`5.29` and `5.30`), can be answered in **any order** (answered beta first, then alpha, and both ran), and both `tools/call` run concurrently. |
| 5 | Hold at `can_use_tool`, or inside the stub handler too? | **Hold at `can_use_tool`**; handler hold works with caveat | A handler held for 150 s with defaults gets `tool_result … ERROR "The operation timed out."` at **60 s**, and the model **retries the call** (a second `can_use_tool`, which also times out at 60 s). That is the HTTP per-request timer, 60 s floor (MCP docs). The stub gets **no** `notifications/cancelled`. With `MCP_TOOL_TIMEOUT=200000` the same 150 s hold succeeds, and the CLI emits `{"type":"tool_progress","tool_use_id":"toolu_01Tah…-heartbeat-0",…,"elapsed_time_seconds":30,"heartbeat":true}` every 30 s. A handler that resolves a promise set by a later call works, but only within a timeout the CLI owns. |
| 6 | Process killed while held: does `--resume` start cleanly, and what does the transcript hold? | **Works** | After `SIGKILL`, the transcript ends on the assistant `tool_use toolu_0146…` with no result. `--resume <id>` starts cleanly. **The CLI itself** then appends `user tool_result toolu_0146… is_error:true "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. …]"` and an assistant `"No response requested."`, followed by our user message. A user message that carries the client's result was answered `ZEBRA-4471-KUMQUAT`. |
| 7 | `tool_choice` mapping | **Works with caveat** | `none`: `--disallowedTools=mcp__client__get_secret` removes it from `init.tools`, and Claude answered `NO_TOOL`. Named: disallowing the other client tools plus `--append-system-prompt` "must call get_weather" made it call `get_weather`, **but it also ran a built-in `Bash` first** (auto-allowed by this account's settings, so no `can_use_tool`). `required` via the system prompt alone was **ignored** with deferred tools ("I'm doing well…", no call), and **honoured** once the tools were loaded up front (`get_weather {"city":"Madrid"}`), one sample each. Flags are fixed at spawn, so on a live process the per-request lever is the `can_use_tool` answer. |
| 8 | Do partial messages stream text before the held call? | **Works** | `--include-partial-messages` gives `stream_event content_block_delta "I"`, `"'ll look that"`, `" up."` at 3.30–3.33 s, the `tool_use` block's `input_json_delta` (`{"key": "alpha` / `"}`) at 4.59–4.67 s, and `can_use_tool` at 4.69 s. Text and the call's argument deltas both stream live up to the hold. |

### The 30-minute hold

`can_use_tool` `7e176fac-…` arrived at 5.31 s. The CLI then wrote nothing at all (`ps` showed it
sleeping, state `S`) until the answer at 1805.32 s:

```text
1805.32 cli<- control_response 7e176fac-… allow {"key":"alpha"}
1805.33 mcp<- tools/call get_secret {"key":"alpha"} _meta.claudecode/toolUseId=toolu_0144VZ9qyg6n2Ts1rBk6Bgzq
1805.35 cli-> tool_result toolu_0144VZ9qyg6n2Ts1rBk6Bgzq "ZEBRA-4471-KUMQUAT"
1806.95 result success "The value for key \"alpha\" is: `ZEBRA-4471-KUMQUAT`"  cost 0.00093505
```

The MCP connection outlived the 30 minutes too: the stub got `tools/call` on the same server without
a reconnect. Holds longer than 30 minutes were not tested. Note that the CLI's 1-hour prompt-cache
writes (`ephemeral_1h_input_tokens` in `usage`) mean a hold longer than an hour likely pays a cache
re-write on resumption, which costs money but has no effect on correctness.

## Other findings that matter for the build

- **MCP tools are deferred behind `ToolSearch` by default.** The model's first move was always
  `ToolSearch {"query":"select:mcp__client__get_secret"}`, one extra API round trip, about 1 s.
  Setting `"alwaysLoad": true` on the stub's server entry (documented in Claude Code's MCP page)
  removed it: the call came in the first message, and `required` started being honoured. When
  built-in tools are narrowed with `--tools=Read` (as a preset or confine does), the CLI loads MCP
  tools up front by itself and the client tool still works.
- **`tools/call` carries `_meta["claudecode/toolUseId"]`**, the same id as the `tool_use` and the
  `can_use_tool` request. The stub can find the client's result by tool call id directly. It is
  observed on the wire but not documented, so the build needs a fallback (below).
- **Deny is a clean error result.** `behavior: 'deny', message: '…'` became
  `tool_result … ERROR "the client did not return a result for this call in time"`, and Claude
  reported it without retrying when told not to.
- **Interrupt while held is clean.** `interrupt` gave
  `{"type":"control_cancel_request","request_id":"ddb84e89-…"}` for the held ask, a rejected
  `tool_result`, and a `result` with `subtype:"error_during_execution"`,
  `terminal_reason:"aborted_tools"`. `stream.ts` already maps the cancel to `permission-withdrawn`.
- **The CLI echoes our `control_response` back on stdout** under the same `request_id`.
  `ControlChannel.settle` ignores ids it did not send, so this is harmless today.
- **Built-in tools still run inside a client turn.** With this account's settings, `Bash` (a
  read-only `grep`/`ls`) ran with no `can_use_tool`. What the client sees depends on the tool preset,
  as decision 3 says.

## The sequence that worked end to end

1. Spawn with Claudio's `host` flags plus `--mcp-config` for the per-chat stub (`alwaysLoad: true`;
   tools listed with `readOnlyHint: true`).
2. Send the user turn. Stream `stream_event` text deltas to the client as they come.
3. The assistant message streams one or more `tool_use` blocks for `mcp__<stub>__*` and ends with
   `message_stop`. Each `can_use_tool` for a stub tool is recorded and **not answered**. With
   `readOnlyHint` they all arrive within milliseconds of the block.
4. At `message_stop` of an API message that holds stub `tool_use` blocks, end the HTTP response:
   `finish_reason: "tool_calls"`, one `tool_calls[]` entry per block (`id` = `tool_use_id`, `name`
   with the `mcp__<stub>__` prefix stripped, `arguments` = the input). The process stays up and
   silent.
5. The next request has `role: "tool"` messages with `tool_call_id`s. Put each result in the stub's
   map under its `tool_use_id`, then answer each held ask with
   `{ behavior: 'allow', updatedInput: <original input> }`, in any order.
6. The CLI calls `tools/call` with `_meta["claudecode/toolUseId"]`. The stub returns the stored text
   at once. The `tool_result` follows, the turn continues and streams, and the next client call (or
   the final answer) ends the second HTTP response.

## Failure modes and fallbacks

| Failure | What the CLI does | Fallback |
|---|---|---|
| Client never sends the result | Waits forever, silently | Claudio's own timer answers `deny` with a message, giving the model an error `tool_result` |
| Client disconnects mid-turn | — | `interrupt`: the CLI sends `control_cancel_request` for held asks and ends the turn with `error_during_execution` |
| Process dies while held (restart, crash) | Transcript ends on a dangling `tool_use`; `--resume` inserts its own "Tool call interrupted" error result | Cold resume with the client's result as a user message, `x-claudio-resume: cold` (as planned) |
| Tool not `readOnlyHint` | Asks serially; ask *n+1* comes only after call *n* returns | Collect calls from the `tool_use` blocks, not the asks; on the next request answer ask 1, then each ask as it arrives, from the map |
| A stub tool runs without an ask (a mode or rule that auto-allows it) | `tools/call` arrives with nothing held | The stub holds in the handler, bounded by the 60 s floor unless the server entry sets `timeout`. This is the degraded path, so never allow-list stub tools |
| `_meta.claudecode/toolUseId` missing (CLI change) | — | Answer one held ask at a time and give the next `tools/call` that ask's result (FIFO), matching name and arguments |
| Model calls a client tool when `tool_choice` forbids it | Asks as usual | Deny with a message that names the rule |

## Changes to the plan

For decision 2 of [[plans/openai-compatible-api]]:

1. **Decision 3 conflicts with the hold.** `permissionPrompts: 'none'` makes the CLI deny every ask
   itself, so no `can_use_tool` ever reaches Claudio. A chat with client tools must run with
   `'host'`, and **the adapter is the host**: stub tools are held, and every other ask is denied at
   once with the message `'none'` would give, so built-in tools behave exactly as decision 3 intends.
2. **Calls come from the `tool_use` blocks, not from the asks.** End the HTTP turn at the
   `message_stop` of an API message that contains stub `tool_use`s. Never wait for one ask per call.
3. **List the client's tools with `readOnlyHint: true`** in the stub's `tools/list`, so every ask of
   a turn arrives together and the calls run concurrently. This is safe because the stub itself
   changes nothing; the client acts on its own side. Keep (2) anyway, because the hint is advisory.
4. **Set `alwaysLoad: true`** on the stub's `--mcp-config` entry. It saves a `ToolSearch` round trip
   per turn and makes `tool_choice` prompts work.
5. **Hold only at `can_use_tool`. The stub never waits** for a result; it answers from the map at
   once. A handler hold would sit under the CLI's 60 s HTTP timer and the model's retries.
6. **The stub keys results by `_meta["claudecode/toolUseId"]`**, with the FIFO fallback above.
7. **Held client calls are not person prompts.** They must not reach `PermissionBroker`, whose
   10-minute deny and the panel's buttons would let a person answer a client's call. The adapter
   needs its own pending map with the client-tool timeout from "Open for the owner".
8. **Name the stub server for the request** (for example `client`), with `--strict-mcp-config` off
   only if Claudio's usual servers must load too (`mcpConfigAdds`). Strip the
   `mcp__<server>__` prefix in `tool_calls[].function.name`, and refuse client tool names that
   collide after prefixing.
9. **`tool_choice`** (least bad option per value; the flags are fixed at spawn and the process
   outlives one request):
   - `none`: deny any stub ask with "tool_choice is none". On a cold spawn, `--disallowedTools`
     for the stub tools is cleaner and was shown to work.
   - `{type:"function", name}`: deny asks for other stub tools with a message that names the
     required one, and add the system-prompt line on spawn. Limit: built-in tools may still run first.
   - `required`: system-prompt line (honoured once tools load up front). If the turn ends with no
     stub call, send one nudge turn, then return what came. Limit: not guaranteed and costs a turn.
   - `auto`: nothing.
10. **Build order**: the spike's result is GO, so step 4 of the plan's build order is the MCP
    handoff, not the 400 fallback. Its first slice is the per-request stub route in `apps/api` and
    the adapter's host role (changes 1 and 7), because both touch the chat runner.

## Related

- [[plans/openai-compatible-api]]
- [[cli-surfaces]]
- [[api-wire]]
- [[claudio-mcp-server]]
- [[plans/chat-api-token]]
- [[rest-api]]
