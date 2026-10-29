---
created_at: 2026-10-29T12:00:00Z
updated_at: 2026-10-29T12:00:00Z
tags:
    - decision
    - security
    - api
    - guards
    - headless
---
# Decision: a chat a program starts is a confined API chat

Taken by the owner on 2026-10-28, as D14 of [the headless plan](../plans/headless-image.md), after an
independent review of the plan's first draft; built on 2026-10-29.

## Context

Two of the owner's projects use Claudio as their AI backend: they start chats over the REST API or
`/v1`, and shipcast's chats read repositories it did not write. The review checked against the code
what such a chat could do, and found that an API chat was not confined at all:

- it loaded the settings of its working directory (`--setting-sources` was passed only to Claudio's
  own confined runs), so a repository's `.claude/settings.json` hooks would run before any guard saw
  a tool call;
- it received `CLAUDIO_API_URL` and a token of its own, with which it could start further chats;
- `POST /api/chats` took any `cwd` and `bypassPermissions`, which was also the image's default, and
  `PATCH /api/chats/:id` changed the mode of a live chat;
- its declared tool rules were narrower than what ran: under `dontAsk`, Claude Code runs a built-in,
  non-configurable set of read-only commands (`ls`, `cat`, `head`, `find`, `grep`, read-only `git`…)
  in every mode, and lets them read outside the working directory
  ([permissions](https://code.claude.com/docs/en/permissions)). Shipcast's transcripts showed
  `ls && cat package.json && head -150 README.md` running with only `Bash(ls:*)` and git rules
  allowed. Next to `/data`, that is a credential read away.

D12, the first answer ("the declared tool policy is the effective policy"), was enforced by a guard
on otherwise unconfined chats. The review showed that the repository's hooks run before the guard,
and that the first form broke attachments and the full profile's chats.

## Decision

**Every chat of a headless Claudio and every chat in a workspace in any profile is a confined API
chat.** There is no other kind in headless. In the full profile, a person's chats, orchestrations,
flows and the assistant are unchanged, and so is a `/v1` chat without a workspace (the first build
confined it too, which broke the app; brought back on 2026-10-29). A confined API chat:

1. **Starts confined**, through the confinement Claudio already had for its own runs:
   `--restricted`, `--tools=` the declared tools only (plus `StructuredOutput` for a schema),
   `--setting-sources=` empty, `--strict-mcp-config` with no server but the `/v1` client-tool stub,
   and the guard's settings file with `permissions.blockReadsOutsideWorkingDirectories`.
2. **Runs in `dontAsk`.** Another mode is a `400`, and a headless server refuses to start with
   another default.
3. **Has no way back into Claudio**: no `CLAUDIO_API_URL`, no token; `claudioMcp` or `mcp` is a `400`.
4. **Has its policy fixed at creation and stored with it** (workspace, declared tools, turns, budget,
   schema). Resume over REST, fork, `PATCH` and the MCP switches are refused; a `/v1` continuation
   with another policy is `409 policy_mismatch`; one in an expired workspace is `410`.
5. **Is guarded by `declared-tools`**, a new rule of Claudio's `PreToolUse` guard, as defence in depth
   behind the confinement: only declared tools, every Bash subcommand under a declared rule and in
   its read-only form, every path inside the working directory or the chat's own attachments, and
   no variable or substitution ([guards.md](../guards.md#declared-tools-the-confined-api-chat)). It
   cannot be switched off by any setting or by the chat's token.
6. **Reads its attachments by path**, through one added directory per upload and the guard, never the
   uploads folder.
7. **Runs git safely**: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and
   `GIT_CEILING_DIRECTORIES` at the workspaces root.
8. **Defaults to no tools.** With none declared and no preset it can only answer; on `/v1` in headless
   this replaces the app's default preset.

## Rejected

- **The guard alone on unconfined chats** (D12's first form): a repository's hooks and settings run
  before any guard sees a tool call, and the chat's own token reached back into Claudio.
- **Documenting the CLI's semantics and leaving the rest to consumers**: the CLI's read-only set is
  not configurable, so a consumer could not get an exact policy any other way, and headless chats read
  untrusted repositories next to `/data`.
- **The confinement alone, without the guard**: `--restricted` keeps the file tools in the working
  directory, but the built-in read-only Bash commands still run whatever the rules say.

## As built (2026-10-29)

- `packages/core/src/confined-chat.ts` (the policy, its refusals, the flags, the git environment),
  `ChatService.createConfined` and the confined resume in `chat-service.ts`, and
  `packages/core/src/guards/declared.ts` with `guards/rules/declared-tools.ts`.
- **One difference from point 2**: a `/v1` chat with client tools runs in `manual`, with its
  client-tool session as the permission host. Under `dontAsk` the CLI never asks, so the client's own
  calls would be denied before the session could hold them; the session denies everything else at
  once, so the effective policy is the same. The `review` task was asked to validate it.
- A chat with no process can still be continued from core (`ChatService.resume`, which `/v1` uses):
  it re-arms the guard from the stored policy and answers `410` when the workspace is gone.
- `CLAUDIO_CHAT_ID` stays in the chat's environment, to find stray processes; it is an id, not a
  credential.
- Not yet checked with the real CLI (the owner's, by hand): whether `--tools` accepts
  `StructuredOutput`, a hostile workspace (a `SessionStart` and a `PreToolUse` hook, a
  `permissions.allow` and a `.mcp.json`) of which nothing must apply, and the `/v1` client-tool flow
  in a confined chat. The unit tests cover the arguments and the refusals.

## Related

[[plans/headless-image.md]] · [[security-model.md]] · [[guards.md]] · [[workspaces.md]] · [[openai-compatible-api.md]] · [[lessons.md]]
