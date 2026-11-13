---
created_at: 2026-11-08T12:00:00Z
updated_at: 2026-11-13T15:00:00Z
tags:
    - plan
    - mcp
    - chats
    - agents
    - security
    - built
---
# Plan: start a chat as an agent, by name, without widening it (CLD-3)

Status: **landed** in #96 (merged 2026-11-08, released in 0.15.0). Was: "built on `feat/start-chat-agent`,
not merged yet". Closes the known gap of
[claudio-assistant.md](../claudio-assistant.md): `start_chat` had no `agent` input.

## The need

A Claude Code session delegated a Shipcast task by opening a chat in the project with `start_chat`.
It could not say which agent the chat starts as; the only workaround, "use the X agent" in the prompt,
does not give the chat the agent's system prompt or tools. `claude --agent <name>` does.

## What it is

- **`POST /chats` takes `agent`**, a name: a user agent (`shipcast`), a plugin agent (`brand:lead`) or a
  project agent (`.claude/agents/`). It is checked against the agents of the chat's folder (`cwd`, the
  workspace when none): an unknown name is `400` with `code: agent-unknown` and the valid names in the
  message. No `agent` is today's start, byte for byte.
- **`GET /projects/:id/agents`** lists them: `name`, `description`, `source` (`project`, `user`,
  `plugin`), `plugin`, `tools`. The MCP read tool `list_agents { projectId }` is that route, and
  `start_chat` gains `agent` (a name, never a definition).
- **Discovery reads the files the CLI reads** (`packages/core/src/agent-catalog.ts`): the folder's
  `.claude/agents/*.md`, the account's `agents/*.md`, and the `agents/` of every enabled plugin from
  `claude plugin list --json`, named `plugin:name`. The name is the file's `name:` frontmatter, or the
  file name. A project agent wins over a user agent of its name, as in the CLI. No CLI call lists agent
  definitions (`claude agents` manages background sessions), so reading the files is the documented
  route, as the Team module already does.

## The constraint, and how it is kept

A confirmed `start_chat` must not start a chat with more than the app's defaults
([assistant-write-tools.md](assistant-write-tools.md)). An agent file can say a lot: `permissionMode:
bypassPermissions`, `mcpServers`, `hooks`, `tools`. Decisions:

1. **The chat's own flags win and stay.** The argv carries `--permission-mode <app default>`,
   the default tool preset and permission prompts exactly as for a chat without an agent. Nothing the
   agent says changes them.
2. **A user or project agent runs from a definition Claudio rewrites**, not from the file. Claudio
   builds `--agents <file>` with `description`, `prompt` (the body), `model` (unless `inherit`),
   `tools` and `disallowedTools`, and starts the CLI with `--agent <name>`. A definition given by the
   command line outranks the file of the same name, so `permissionMode`, `mcpServers`, `hooks`,
   `skills`, `memory` and everything else in the frontmatter are **dropped, not refused**. Refusing would
   make most real agents unusable for a rule the app enforces anyway, and the caller sees the agent's
   own `description` and `tools` in `list_agents`. The file is written to `<dataDir>/flow-agents/` named by
   its content, the only place `ChatService.create` accepts an `--agents` file from; an `agentsFile` in
   a request body is dropped when an agent is named.
3. **A plugin agent starts by name alone.** Claude Code documents `permissionMode`, `mcpServers` and
   `hooks` as ignored for plugin agents, so there is nothing to strip.
4. **`tools` can only narrow.** They are the agent's availability list. Approvals still come from the
   app's preset and prompts, so naming `Bash` in `tools` makes it available, never pre-approved; an
   agent that lists fewer tools than the preset leaves the chat with fewer.
5. **`agent` joins the chat token's `workFields`** for `POST /chats`, as the one new field a chat's
   token may send. It is only a name, so a prompt-injected chat gains an agent's prompt, not a
   permission.

### Collaborators (R13)

The agent does not change who may read what teammates share
([collaborators-agent-access.md](collaborators-agent-access.md)). The scope of a chat's reads comes
from its project's opt-in and its permission mode (`bypassPermissions`, `auto` and `dontAsk` never get
the tools), both the app's. The agent's `mcpServers` is dropped, so it cannot add the collab tools or
any server; its `tools` can remove the `mcp__claudio__collab_*` tools the chat was given but never add
them. A chat started as an agent is therefore audited and scoped like any chat of that project.

## Known limits

- **Resume.** Claudio passes no `--agent` when a chat is continued, as before for any chat
  (`ChatService.resume`): the next process runs as the default. A new process keeps the app's flags
  whatever the CLI restores.
- **Plugin manifests that move `agents/`** to another directory are not followed; the default directory
  is read.
- **Confined API chats** (headless, workspaces) still refuse an agent (`400`), as they always did.

## The optional criterion: the chat's SendMessage address

Not done. `start_chat` already returns the chat `id`, which is what `send_chat_message { chatId }` takes.
"SendMessage" in the item is the calling session's own tool for agents it spawned; a chat started by
Claudio is a separate `claude -p` process Claudio holds, not a teammate of the caller's session, and
the CLI documents no address a foreign session could send to. Inventing one would reach into
undocumented behaviour (the one rule). The caller talks to the chat through `send_chat_message`.

## Tests

`packages/core/test/agent-catalog.test.ts` (listing, precedence, the rewritten definition),
`apps/api/test/chat-agent.test.ts` (the route, `--agent` and `--agents` in the argv a fake CLI records,
a permissive frontmatter not changing the mode or loading its servers, the unknown-name refusal),
`packages/mcp/test/write-tools.test.ts` and `write-tools-api.test.ts` (the tool, against a stub and the
real API), `tools.test.ts` (`list_agents`).

## Related

[[claudio-assistant.md]] · [[claudio-mcp-server.md]] · [[plans/assistant-write-tools.md]] · [[plans/collaborators-agent-access.md]] · [[team-and-flow.md]] · [[rest-api.md]]
