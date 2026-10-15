---
created_at: 2026-10-15T13:00:00Z
updated_at: 2026-10-15T13:00:00Z
tags:
    - plan
    - connectors
    - docs
    - projects
---
# Claude Docs per project

A project in Claudio gets a **Documents** section: the Claude Docs a project owns, read, created and
edited from Claudio, and opened in claude.ai. It is built on the Claude Docs connector, reached the
way Claudio reaches everything else — **through the CLI**, never by a call of Claudio's own to
`api.anthropic.com`.

## What this is, and what it is not

The Claude Docs connector is an MCP server (`api.anthropic.com/v1/pages/mcp`) the CLI connects to
with the account it is signed in with. Through it a document can be **read, created, updated,
exported and commented on** — but there is **no "list my documents" tool**: the MCP looks a document
up by its id or link, and the account-wide roster the claude.ai web app shows is not exposed to a
program (what the CLI caches locally, `cachedArtifactRoster`, is capabilities, not a document list).

So Claudio cannot enumerate the account's documents, and this plan does not try to. It keeps a
**per-project registry** of the documents a project knows: the ones Claudio creates (it gets the id
and link back) and the ones the person pastes in. The registry is the list; the connector is how
each entry is read and written.

**claude.ai conversation artifacts and claude.ai memory stay out of reach** (no API, no CLI
command); they remain in `connectors.ts`'s `CONNECTOR_LIMITS`. "Documents" here means Claude Docs
(the `pages` surface), not those.

## The one rule

Claudio does not open its own socket to `v1/pages/mcp`, and does not hold or send the account's
OAuth token: that would be the impersonation the fork forbids
([plans/claude-only-fork.md](claude-only-fork.md) decision 7). Every document operation runs inside
a **confined `claude` session** that has the Docs connector and only its MCP tools allowed, which
Claudio drives over the CLI and the control protocol. The CLI owns the auth; Claudio owns the
prompt and reads the structured result.

## How it works

- **The registry.** A project's documents are a settings-shaped list in the project's data:
  `{ id, url, title, kind: 'doc', createdBy: 'claudio' | 'person', addedAt }`. It is the source of
  truth for the section; the connector is never asked to enumerate.
- **Reading and listing the section.** The section shows the registry. "Refresh" reads each
  document's current title (and tab list) through a confined session asking the Docs connector to
  read it by id; a document that no longer resolves is marked `unavailable`, not dropped.
- **Creating.** "New document" starts a confined session that creates the doc through the connector
  with a title and a first body, captures the returned id and link, and adds it to the registry. The
  objective is written in the language of `Accept-Language`.
- **Editing.** An "Ask Claude about this document" action opens a normal chat with the Docs
  connector available and the document's link in the prompt, so the person drives the change in a
  chat they can watch — nothing more magic than the connector actions already are.
- **Opening.** The title links to the document on claude.ai; Claudio opens it, it does not try to
  render it.
- **Read-only by default.** The confined session's prompt says read unless the action is a create or
  the person asked for a change, the way the existing connector action prompts do.

## Persistence and API

- **JSON:** the registry is a document in the project's settings directory (settings-shaped, one
  file), not a SQLite table — it is a small list a person edits, like the project's other settings.
- **Routes** (each with a summary and a tag, and a README row; a chat's own token is refused on the
  writes):
  - `GET /projects/:id/docs` — the registry, with each entry's last-read title and status.
  - `POST /projects/:id/docs` — add by link (the person pastes one), or create a new document
    (`{ create: { title, body } }`); returns the entry.
  - `DELETE /projects/:id/docs/:docId` — remove from the registry (never deletes the document on
    claude.ai).
  - `POST /projects/:id/docs/:docId/ask` — open a chat about the document (returns the chat), the
    way "Work on it" opens one.
- **Shared types:** `ProjectDoc`, `ProjectDocsOverview`, `AddProjectDocRequest`; then
  `pnpm --filter @agentry/api openapi:schemas`.

## Web

- A **Documents** card on the project page (Night Shift: tokens only, both themes, phone layout, en
  and es parity), listing the registry with each document's title in Geist, its id in mono, its
  status, and actions Add / New / Open / Ask. Empty state uses an `Empty` illustration.
- The section is hidden, or shows a "connect Claude Docs" note, when the connectors overview reports
  the Docs connector is not connected — read from the existing `GET /connectors`, not a new probe.

## Depends on, and order

- Depends on the fork being done (the Claude driver and the connectors code the fork keeps), and on
  the confined-session helper the assistant already uses to run a `claude` with a fixed tool set.
- Independent of the accounts work; can run after stage R as its own small orchestration.

## Risks

| Risk | What holds it |
|---|---|
| Claudio ends up holding the account's OAuth token | Every operation goes through a confined CLI session; Claudio never reads the connector's stored auth |
| The registry drifts from claude.ai (a document deleted there) | "Refresh" marks an entry `unavailable` rather than dropping it; the person removes it |
| A confined session is talked into writing when asked to read | The prompt is read-only unless the action is create/change; the session's allowed tools are the Docs connector's only |
| The MCP gains or loses a tool between CLI versions | The feature reads and writes one document at a time by id, the stable part of the surface; no enumeration is assumed |

## Related

[[plans/claude-only-fork.md]] · [[plans/sdk-driver-improvements.md]] · [[providers.md]] · [[status.md]]
