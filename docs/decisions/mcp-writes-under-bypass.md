---
created_at: 2026-11-07T11:45:35.197856101Z
updated_at: 2026-11-07T11:45:35.197856101Z
tags:
    - decision
    - security
    - mcp
    - permissions
---
# Decision: Claudio's MCP writes run unasked under `bypassPermissions`

Taken by the owner on 2026-11-07 in [plans/ci-and-regression-open.md](../plans/ci-and-regression-open.md#21-r6-mcp-writes-under-bypass-documented-and-closed-owner-2026-11-07) (R6). It closes the "MCP writes under bypass" item of [plans/regression-fixes-2026-10-29.md](../plans/regression-fixes-2026-10-29.md#open).

## Question

With permission checks off (`bypassPermissions`), the CLI asks nothing, so a write tool of Claudio's MCP server, once the server is switched on for a chat, runs without a prompt. Is that a hole?

## Decision

It is intended, and recorded here: bypass delegates to the agent what its token may already do.

- Every Claudio MCP write tool calls only `work` routes (`packages/mcp/src/names.ts`, contract C1).
- A chat's token can already call those routes with `curl`, and the project's `CLAUDE.md` asks agents to. The MCP tool adds no reach.
- The grave writes (compact, notes, tunnel, settings, deletions) are `person` routes and no MCP tool calls them ([chat-token-compact.md](chat-token-compact.md)).
- Under auth mode `none` none of it is enforced.
- The server-side approval of [assistant-everything](https://github.com/yeyo11/claudio/blob/feat/assistant-everything/docs/plans/assistant-everything.md) (D2/D4, never built) would not change this for ordinary chats: D4 keeps `work` free and asks approval only for a new `confirm` class and for the assistant.

## Rejected

- **An approval for every MCP write in every chat.** It leaves `curl` open, so it adds friction without a boundary.
- **Building assistant-everything inside the regression PR.** It is a design of its own and goes first through a design round.

## Consequence

Someone who turns bypass on for a chat has handed it the `work` class, through MCP or `curl`. The approval ledger is a later piece, designed first. The assistant (a confined chat) is unaffected: each of its writes is confirmed by the person.

## Related

[[security-model.md]] · [[claudio-mcp-server.md]] · [[claudio-assistant.md]] · [[route-access-classes.md]] · [[plans/ci-and-regression-open.md]]
