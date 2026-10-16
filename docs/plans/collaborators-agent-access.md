---
created_at: 2026-10-17T00:40:00Z
updated_at: 2026-10-17T00:40:00Z
tags:
    - plan
    - collaborators
    - assistant
    - mcp
    - security
    - proposed
---
# Plan: agents read what teammates share

Status: **proposed** (owner's choice on 2026-10-17: a hybrid of an assistant that reads the shared
copies and read-only MCP tools a project opts into). Builds on [collaborators.md](../collaborators.md)
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

## Open questions

- Whether a chat in `bypassPermissions` (orchestration workers) gets the tools when its project opts
  in. Proposed default: no, only chats that ask before running a command; the owner decides.
- Whether the owner of a copy (B) can forbid agent reads of what they share, per project. Proposed:
  yes, a flag in the share that A's install honours.

## Delivery

After the Collaborators gaps (R12) are merged. One graph: shared types and the token scope (core,
API), the MCP tools, the two switches (web), the audit, tests, docs.

## Related

[[collaborators.md]] · [[plans/collaborators.md]] · [[security-model.md]] · [[claudio-assistant.md]]
