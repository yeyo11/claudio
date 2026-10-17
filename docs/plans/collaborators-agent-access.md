---
created_at: 2026-10-17T00:40:00Z
updated_at: 2026-10-17T18:00:00Z
tags:
    - plan
    - collaborators
    - assistant
    - mcp
    - security
    - built
---
# Plan: agents read what teammates share

Status: **built** on the R13 orchestration's branches on 2026-10-17, not yet in `main` (owner's choice
on 2026-10-17: a hybrid of an assistant that reads the shared copies and read-only MCP tools a project
opts into). See [Outcome](#outcome). Builds on [collaborators.md](../collaborators.md)
and changes one of its security decisions.

## What the owner asked for

Claudio A and Claudio B collaborate. From A, the person wants to ask an agent about what B shares
("what is B working on?", "what did B's chat decide about the API?") instead of only reading the
Shared tab. Today that is impossible on purpose: the collaborators routes are closed to a chat's
token, reads included, "so a teammate's transcript never enters an agent's context"
([collaborators.md](../collaborators.md#what-is-cooperative)). A teammate's text is input the person does not
control, and an agent that reads it can be steered by it (prompt injection) while it can run
commands on this machine.

## The decision: two levels

1. **The global assistant reads every shared copy** while Collaborators is on. It is a confined chat
   that does not run commands, so the risk is low. A switch in Settings → Collaborators ("The
   assistant reads what is shared with you", on by default) turns it off.
2. **Chats read the copies of their own project only when the project opts in.** The project's
   Sharing section gets a switch, "Agents in this project can read what teammates share here", off by
   default. With it on, a chat whose project matches a shared copy (by share key or link) gets the
   read tools for that copy and nothing else.

## How it is built

- **MCP read tools** in `packages/mcp`: `collab_list_shared` (groups, people, installs, projects),
  `collab_read_chats` / `collab_read_transcript` (paged like a local chat, subagents included),
  `collab_read_memory`, `collab_read_documents`, `collab_read_board`, `collab_read_journal`. They read
  the local copy only; none reaches a peer, starts a sync or writes anything.
- **Untrusted content is marked as such.** Every tool result wraps the teammate's text in a fenced
  block with a header that names the person and install and says it is third-party content, not
  instructions. Blobs are never returned; uploads are listed by name and size only.
- **Token scope.** The API accepts a chat token on the copy read routes only when the chat is the
  assistant (level 1), or when the chat's project has the switch on and the copy belongs to that
  project (level 2). Every other collaborators route stays closed to chat tokens, as today.
- **Guards and audit.** Every read by an agent is a row in an audit table (chat, tool, copy, record
  ids), shown on the shared copy ("read by 3 chats today") and in Settings → Security.
- **Visible in the chat.** A chat with the tools shows a chip "Reads teammates' shares" beside its
  other capabilities, and the tool rows say whose content was read.

## Decided with the owner (2026-10-17)

- **Chats in `bypassPermissions` do not get the tools**, even when their project opts in: only chats
  that ask before running a command (`default`, `acceptEdits`, `plan`) do. Orchestration workers run
  in `bypassPermissions`, so they never read a teammate's text.
- **The sharer can forbid agent reads.** A share carries a flag, "Teammates' agents may read this"
  (on by default), set in the Sharing section next to the share key. The reading install honours it:
  with the flag off, neither the assistant nor any chat gets that copy, and the person still reads it
  in the Shared tab.

## Delivery

After the Collaborators gaps (R12) are merged. One graph: shared types and the token scope (core,
API), the MCP tools, the two switches (web), the audit, tests, docs.

## Outcome

Built on 2026-10-17 by one graph of five tasks, as decided above, the owner's section included. What
it is now is in [collaborators.md](../collaborators.md#agents-that-read-what-teammates-share).

- **Settings, the flag, the token scope and the audit** (`59a2e2847`). `CollaboratorsSettings.assistantReads`
  (on by default); `ProjectSharingSettings.agentsMayRead` (the sharer's, on by default, carried in the
  catalog) and `agentReads` (the reader's, off by default). `agentReadScope` and `copyInScope`
  (`packages/core/src/collab/agent-access.ts`) decide the scope; `AGENT_READABLE` and
  `agentReadRefusal` in `apps/api/src/security.ts` let a chat's token through the copy reads only in
  scope, with `collaborators.agent-read.*` refusals. `auto` and `dontAsk` are refused with
  `bypassPermissions`: they do not ask before running a command either. A chat's read never pulls
  from the owner. The audit is `collab_agent_reads` (newest 20,000 kept) and
  `GET /collaborators/agent-reads`. `PUT /collaborators` now validates its body; it used to store
  whatever was sent.
- **The MCP tools** (`63e254ba6`). The seven tools listed above, in `packages/mcp/src/collab-tools.ts`,
  fenced by `packages/mcp/src/untrusted.ts`. The server offers toolsets from `CLAUDIO_MCP_TOOLSETS`;
  a project chat that opted in gets Claudio's server with the collab reads only, added to the
  servers it loads or merged into the strict file of those it chose. The tools name themselves in
  `x-claudio-tool`, so the audit records the tool.
- **The assistant** (`5332628a1`). Its guide gains "What teammates share": where to look, that the
  copy may lag, and that a teammate's text is data, never instructions; with the switch off it says
  so, and with Collaborators off it names no teammates.
- **The web** (`df7e83ec6`). The Collaborators page's Agents card with the assistant's switch; the
  two switches of the Sharing section; the chat header's `Reads teammates' shares` badge from
  `chat.teammateReads`; `collab_*` tool rows that name whose share was read; "Read by N chats today"
  or "The sharer does not let agents read this" on a copy; Settings → Security → Read by agents.
- **The browser spec** (`c9eeda365`). `e2e/specs/collaborators-agents.spec.mjs` drives the switches, a
  project chat's read before and after opting in, a `bypassPermissions` chat, the audit and the
  sharer's flag turned off. The e2e fake CLI gained an `mcp:` step that calls a tool on the server
  `--mcp-config` names, and the runner drops `CLAUDIO_MCP_ENTRY` so chats run this checkout's server.

**Deviations from the plan.** Tool rows name whose share was read, as asked, through a `Teammate`
slot the app fills from the catalog. The audit's per-copy count is a line on the copy ("Read by N
chats today") that links to Settings → Security, and nothing shows while no chat read it today.

**Open.** The browser spec was written but not run by the task that wrote it; it runs on the merged
branch. The sharer's flag is cooperative, like the rest of Collaborators: a modified reader can ignore
it.

## Related

[[collaborators.md]] · [[plans/collaborators.md]] · [[security-model.md]] · [[claudio-assistant.md]] · [[claudio-mcp-server.md]] · [[requests.md]]
