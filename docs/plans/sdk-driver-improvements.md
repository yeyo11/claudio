---
created_at: 2026-10-15T12:00:00Z
updated_at: 2026-10-15T13:00:00Z
tags:
    - plan
    - providers
    - claude-code
    - limits
    - connectors
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
regenerating the OpenAPI schemas (`pnpm --filter @claudio/api openapi:schemas`).

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

9. **MCP lifecycle control, and sturdier connectors.** _(mcp_status/mcp_toggle BUILT in the rich composer, feat/rich-composer; connectors-from-mcp_status BUILT (part A); in-app authorise still pending.)_ The subtypes `mcp_status`, `mcp_reconnect`
   and `mcp_toggle` surface server health and reconnect a dropped server without respawning the
   chat. Add `mcpStatus()`, `mcpReconnect(server)` and `mcpToggle(server, on)` to
   `ClaudeCodeSession` (`driver.ts`), a read and an action on the chat, and keep MCP configured by
   file (`--mcp-config`), never in-process. Test: the fake answers `mcp_status`; a reconnect
   round-trips.

   **Why this matters for connectors.** The connectors panel (`packages/core/src/connectors.ts`)
   reads `claude mcp list` and scrapes its human-readable lines (`parseMcpHealth` in
   `config/mcp.ts`), because `claude mcp list` has **no `--json`** (verified on CLI 2.1.295). It
   depends on the `claude.ai ` name prefix and on the words "Connected / needs auth / pending", so a
   change to the CLI's output format silently empties the panel, and the per-server health check
   runs under a 90 s timeout (the slowness and the flaky `connectors.spec.mjs`). The structured
   `mcp_status` is a sturdier source for the same information: read it from a short-lived session
   (or a session Claudio already has open) and fold it into `ConnectorsOverview`, keeping the
   `claude mcp list` scrape only as a fallback until the CLI ships `--json`.

   **A connector that needs authorisation can be invisible today.** On the owner's machine
   `claude mcp list` printed only the connected servers, while a claude.ai connector pending auth
   (`claude.ai AgentMail`, found in `~/.claude/mcp-needs-auth-cache.json`) did not appear at all, so
   the panel could neither show it nor offer to authorise it. claude.ai connectors are pulled by the
   CLI from the signed-in account (feature-flagged), not from local config — the account's enabled
   set is what decides whether Gmail or Calendar ever show, which is the person's to change on
   claude.ai. `mcp_status` reports servers with their auth state, so it surfaces the pending ones the
   scrape misses, and the authorise path below acts on them.

   **Authorising a connector in the app.** The control subtypes `mcp_authenticate` and
   `mcp_oauth_callback_url` let a session start a connector's OAuth sign-in from inside Claudio,
   instead of only telling the person to run `/mcp` in a terminal (today's `CONNECTOR_GUIDE` in
   `connectors.ts`). Add an `authorise(connector)` path on the driver and a connectors route/action,
   opening the returned URL the way the setup flow's device sign-ins do. This stays within the one
   rule: the sign-in is the CLI's own OAuth, driven over the control protocol, not a login of
   Claudio's.

   **Facts (CLI 2.1.300, 2026-10-15).** `mcp_status` needs no prompt: sent on a `claude -p` stream-json
   process it answers `{ mcpServers: [{ name, status, serverInfo?, scope, source, tools? }] }`
   (`config` dropped by `liveMcpServers`, as the composer already does). Servers load after start:
   asked at once a server reads `pending`, about ten seconds later `connected` with its tools, so the
   probe polls until nothing is `pending` or a ceiling passes. claude.ai connectors come with
   `source: 'claudeai'` and only for an account that has them enabled (the CLI login at the time of
   writing has none; `claude mcp list` shows the same). `mcp_authenticate` (`{ serverName,
   redirectUri? }`) is accepted on stdin in this mode (an unknown server answers `Server not found`);
   its answer for a real connector pending authorisation is still to record (part B).

   **Built in two parts.** A: the connectors overview from a short-lived probe session reading
   `mcp_status` (default account's environment, polled until settled, cached a minute as today), with
   the `claude mcp list` scrape as the fallback, so connectors pending authorisation appear with their
   state and tool count. B: authorising from the app with `mcp_authenticate`, once its answer is
   recorded with an account that has a connector pending authorisation.

   **Out of reach either way, and left documented:** claude.ai web artifacts and claude.ai memory
   have no public API and no CLI command, so they stay in `CONNECTOR_LIMITS`; the Claude Docs
   connector (`api.anthropic.com/v1/pages/mcp`) already reaches docs through the CLI's MCP. Gmail and
   Calendar appear only when the signed-in claude.ai account has enabled and authorised them, which
   is the person's to do on claude.ai; the panel's job is to report the state, not to widen it.

## Order and checks

D1 first (it improves the accounts and limit feature the fork rebuilds), then D2, then D3; they are
independent and could also run in parallel, each owning its files. Every task runs `pnpm typecheck`,
the tests of the packages it touches, and — when it changes a shared type —
`pnpm --filter @claudio/api openapi:schemas` with no drift. A task that adds a flag adds its
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
