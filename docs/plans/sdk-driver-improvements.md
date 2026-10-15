---
created_at: 2026-10-15T12:00:00Z
updated_at: 2026-10-15T12:00:00Z
tags:
    - plan
    - providers
    - claude-code
    - limits
---
# Driver improvements learned from the Agent SDK

The Claude Agent SDK for TypeScript is, mechanically, a subprocess driver for the `claude` binary:
it spawns `node <cli.js> --output-format stream-json --input-format stream-json …` and speaks the
same control protocol Claudio speaks. So it is a **reference for the CLI surface**, not a dependency
to adopt. Reading it showed nine things the CLI supports that Claudio does not yet use, every one of
them reachable through the CLI, the stream-json output and the control protocol.

This plan builds those nine. It does **not** touch the boundary the one rule draws (decision 2 of
[plans/multi-provider.md](multi-provider.md)): no Agent SDK dependency, no direct call to
`api.anthropic.com`, no login or token-refresh of our own. The SDK's bundled HTTP client, its OAuth
and `create_api_key` machinery, and its in-process MCP servers and hooks are **out of scope** for
exactly that reason; Claudio reaches all of it through the signed-in CLI.

It lands **after the fork stages** (S, A, R of [plans/claude-only-fork.md](claude-only-fork.md)), on
the Claude driver, which the fork keeps. Nothing here conflicts with stage S, which only removes the
other vendors.

## Where Claudio stands today

- Control subtypes it drives: `interrupt`, `set_permission_mode`, `set_model`
  (`packages/core/src/providers/claude-code/driver.ts:61,65`, `control.ts:19`). Inbound it handles
  `can_use_tool` and refuses every other subtype (`stream.ts:262`, `control.ts`), which is the right
  boundary and stays.
- It already parses the rich `unifiedWindows` map of a `rate_limit_event`
  (`stream.ts:201` into `RateLimitInfo.windows`, `packages/shared/src/types.ts:148`), ahead of the
  SDK's flattened type. `limitFromInfo` and `bindingWindow` (`providers/limits.ts:27,39`) fold it
  into `ProviderLimit`.
- Per-model usage it keeps only cost and context window (`modelUsageOf`, `stream.ts:56`;
  `ModelUsage`, `driver.ts:214`).
- Flags it passes include `--effort` and `--max-budget-usd` (`args.ts:31,50`) and several the SDK
  does not (`--replay-user-messages`, `--permission-prompts`, `--restricted`, `--worktree`).

## The nine improvements

Grouped into three stages. Every field added to a neutral type (`ModelUsage`, `RunOutcome`,
`RateLimitInfo`, `ProviderLimit`) goes through `packages/shared/src/types.ts`, which means
regenerating the OpenAPI schemas (`pnpm --filter @agentry/api openapi:schemas`).

### D1 · Richer reads of data already on the stream

The highest value: the data is already on the wire, only the parser drops it.

1. **Per-model token usage.** The CLI's `modelUsage` entry carries `inputTokens`, `outputTokens`,
   `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests` and `maxOutputTokens`
   beside `costUSD` and `contextWindow`; the result also has a top-level `usage` object. Read them.
   - `packages/core/src/providers/claude-code/stream.ts:56` (`modelUsageOf`), and the result parse
     at `stream.ts:219`.
   - `ModelUsage` in `packages/core/src/providers/driver.ts:214` gains the token fields (all
     optional, all guarded as numbers like the two it has).
   - Surfaced wherever cost is today (the chat inspector, usage widgets); no new route needed if it
     rides the existing execution/usage payload.
   - Test: a `result` fixture with a `modelUsage` map asserts every field; a missing field is
     absent, not zero.

2. **Overage and utilization on the limit reading.** A `rate_limit_event` carries, beside the
   windows, `utilization`, `overageStatus`, `isUsingOverage`, `overageResetsAt`,
   `overageDisabledReason` and `surpassedThreshold`. Claudio reads only the windows.
   - `packages/core/src/providers/claude-code/stream.ts:196-206`: pass the fields through into
     `RateLimitInfo`.
   - `RateLimitInfo` (`packages/shared/src/types.ts:148`) gains them, optional.
   - `limitFromInfo` (`providers/limits.ts:39`) uses `surpassedThreshold`/`utilization` for a graded
     `near`, and `ProviderLimit` carries the overage state so the accounts and limit UI can show
     "using overage" and the overage reset, not only the binding window.
   - Test: an event with `isUsingOverage` and an `overageResetsAt` yields a `ProviderLimit` that says
     so; an event without them reads as today.

3. **Live context-window usage between turns.** The control subtype `get_context_usage` returns the
   context-window usage without waiting for a result message.
   - `packages/core/src/providers/claude-code/driver.ts`: a `contextUsage()` method issuing
     `control.request({ subtype: 'get_context_usage' })`, beside `interrupt()`/`setOption()`.
   - `control.ts:19`: add it to the comment of subtypes Claudio drives; the channel already carries
     any request shape.
   - Exposed as a read on the live chat (a gauge the chat page can poll between turns). A small API
     read if the UI needs it; otherwise it rides the chat's live state.
   - Test: a fake CLI that answers `get_context_usage` returns the parsed usage; a CLI that errors
     the subtype surfaces the error without killing the chat.

### D2 · Supported flags Claudio does not pass

Each is one line in `buildArgs` (`packages/core/src/providers/claude-code/args.ts`) plus a field on
the launch spec in `packages/shared/src/types.ts` and its validation, and a control option where it
can change mid-chat.

4. **`--max-turns <n>`.** A turn ceiling the CLI enforces itself, beside `--max-budget-usd`
   (`args.ts:50`). Field on the chat/task spec; the orchestrator and flow may set it per task.
   Test: a golden-args case; the spec validates `n >= 1`.

5. **`--fallback-model <m>`.** The chat degrades to a second model on a capacity error, near
   `--model` (`args.ts:30`). Field on the spec. Test: golden-args case.

6. **Explicit thinking budget.** `--thinking adaptive|disabled`, `--max-thinking-tokens <n>` and
   `--thinking-display <d>`, today only reachable through `--effort` (`args.ts:31`). Add the flags,
   and a runtime `setOption({ maxThinkingTokens })` via the `set_max_thinking_tokens` control
   subtype in `driver.ts:65`. Test: golden-args case; the control request round-trips on the fake.

7. **`--resume-session-at <id>`.** Resume at a specific message (a rewind), complementing the
   whole-session `--resume` (`args.ts:22-24`). Field on the resume request. Test: golden-args case;
   the resume route accepts the message id.

### D3 · Control-protocol surface

8. **Richer `can_use_tool` fields.** The request also carries `blocked_path`, `decision_reason`,
   `title`, `display_name` and `agent_id`; Claudio reads only `description`, `suggestions` and
   `requires_user_interaction` (`stream.ts:262-281`). Read them into the neutral
   `PermissionQuestion` (`driver.ts:200-210`) so the permission prompt can say which path was
   blocked, why, and which subagent asked. Test: a `can_use_tool` fixture with the extra fields
   reaches the prompt; one without them is unchanged.

9. **MCP lifecycle control.** The subtypes `mcp_status`, `mcp_reconnect` and `mcp_toggle` surface
   server health and reconnect a dropped server without respawning the chat. Add `mcpStatus()` and
   `mcpReconnect(server)` to `ClaudeCodeSession` (`driver.ts`), a read and an action on the chat, and
   keep MCP configured by file (`--mcp-config`), never in-process. Test: the fake answers
   `mcp_status`; a reconnect round-trips.

## Order and checks

D1 first (it improves the accounts and limit feature the fork rebuilds), then D2, then D3; they are
independent and could also run in parallel, each owning its files. Every task runs `pnpm typecheck`,
the tests of the packages it touches, and — when it changes a shared type —
`pnpm --filter @agentry/api openapi:schemas` with no drift. A task that adds a flag adds its
golden-args case so the Claude argument contract stays pinned.

## Out of scope (the one rule)

- The SDK's bundled `@anthropic-ai/sdk` HTTP client and any direct `api.anthropic.com` call.
- `claude_authenticate`, `oauth_token_refresh`, `create_api_key` and the login/subscription
  machinery: Claudio leaves auth to the signed-in CLI.
- In-process SDK MCP servers (`sdkMcpServers`) and SDK-registered hooks; MCP stays on
  `--mcp-config` files and hooks on `--setting-sources` on disk, which is Claudio's refuse-the-rest
  boundary (`control.ts`, `stream.ts:262`).

## Related

[[plans/claude-only-fork.md]] · [[plans/multi-provider.md]] · [[providers.md]] · [[decision-engine.md]] · [[status.md]]
