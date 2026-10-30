---
created_at: 2026-10-30T12:00:00Z
updated_at: 2026-10-30T12:00:00Z
tags:
    - decision
    - security
    - authentication
    - api
    - chat-token
---
# Decision: every route declares who may call it, and the guard reads the matched route

Decided by the owner on 2026-10-29 as D1 of [the regression fixes](../plans/regression-fixes-2026-10-29.md),
after the audit found an authentication bypass and a chat token that could do the person's work.
Built by the `security` task; the model it produced is in [security-model.md](../security-model.md#chat-tokens).

## What happened

Two defects met in `apps/api/src/security.ts` (the audit's §8.1–8.6):

1. **The guard decided on the raw URL.** `isGuarded` tested `req.url` against `/api`. A path the
   router normalises but the test did not (`/%61pi/health`, `GET http://x/api/health`,
   `/api/../api/health`) reached a route that was never guarded. Under `token` mode, that is a
   request with no credential doing whatever the route does.
2. **What a chat's token may not do was twenty hand-written sets.** `CHAT_FORBIDDEN`,
   `CHAT_FORBIDDEN_COMPACT_TEXT`, `CHAT_FORBIDDEN_SYSTEM` and sixteen more were regexes and path lists
   in the guard, one per area, written when the area was. A route added later was allowed by
   default, so every new write was one the author had to remember to forbid. The audit (§8.3)
   counted 133 mutating routes left open, several of which undid the rules the sets enforced: a
   chat could set its own `permissionMode` to `bypassPermissions` with `PATCH /chats/:id`, start a
   stronger sibling with `POST /chats` and arbitrary mode, tools and MCP servers, answer any
   chat's permission prompt (§8.2), replace the stored credential, write standing instructions and
   hooks, register a push endpoint of an attacker's, and read a sign-in's device code from the
   event stream (§8.4).

## The rule

- **The guard decides on the matched route**, `req.routeOptions.url`, never on the raw URL. A request
  no route took is guarded under `/api`, `/docs` and `/openapi.json`, and is the web app's own
  anywhere else. Before any other check, a request target that is not a plain path answers
  `400 request-target`: absolute form, `.` and `..` segments, broken escapes and percent-encoded
  unreserved characters. The two layers work independently; each alone stops the three spellings
  above.
- **Every route has an access class** in `ROUTE_DOCS` (`d(tag, summary, { access, … })`):
  - `open`: no credential. The probes and the receivers that check their own proof.
  - `person`: an owner credential only. A chat's token answers `403 chat-forbidden`.
  - `work`: an owner credential or the chat's own token, for what an agent does as part of its work.
- **Deny by default.** Every write (`POST`, `PUT`, `PATCH`, `DELETE`) must declare a class, and
  `apps/api/test/route-access.test.ts` enumerates the registered routes and fails on a write without
  one. A read is `work` unless it says `person` (three reads are: a sign-in's session, an account's
  sign-in and the YouTrack credentials).
- **A `work` write that can widen the chat lists the fields its token may send** (`workFields`). Any
  other field answers `403 chat-forbidden-field` naming it, so a field added to a body tomorrow is
  the person's until someone lists it.
- The 19 `CHAT_FORBIDDEN*` sets are deleted. The review gate's, Collaborators' and the terminal's
  checks stay, because they also apply under `mode: none`, where the class is not consulted.

## Why this and not another

- **Keep the sets and add the missing routes.** It fixes today's list and leaves the next route
  allowed by default. The audit's whole finding is that the list drifted.
- **A prefix deny-list (`/settings`, `/accounts`, …) with allow exceptions.** Shorter, and it fails
  the other way round: `POST /chats/:id/permissions/:requestId` lives under `/chats`, the area most of
  the work happens in, so a prefix cannot separate it from `POST /chats/:id/messages`. The class
  belongs to the route, next to its summary and its description, where the person who adds the route
  is already writing.
- **A flag on the handler.** The OpenAPI table already holds a row for every route, a test already
  checks the table against the registered routes, and the documentation is generated from it. A
  second place to keep in step is what the sets were.

## What changed, and what it loosened

- `POST /chats/:id/compact`, `POST /chats/:id/notes` and a typed `/compact` are `work`. A chat may
  ask for its own housekeeping now, as C1 says; deleting a note stays `person` like every `DELETE`.
- `POST /tunnel/stop` is `person`, like all of `/tunnel`; the old rule let a chat close the tunnel.
- `DELETE /v1/responses/:id` is `person` under "every `DELETE`".
- `attachments` is a field of `POST /chats`, since `POST /uploads` stays `work`; resume and fork take
  `prompt`, `attachments` and `model` for the same reason. `PATCH /chats/:id` allows `model` only.
- **C1's literal request-target rule was refined.** The plan said a `req.url` whose `decodeURI` differs
  from itself is `400`. That would refuse a legitimate name containing `%20` or an encoded accent.
  The guard refuses what changes *which route matches*: encoded unreserved characters, dot segments,
  absolute form and malformed escapes.

## Around it, in the same change

- A chat's event stream no longer sees a sign-in: `login.updated` keeps `url` and `code` only on a
  stream opened with an owner credential (or on an open install).
- The failure back-off is keyed by address and the name the client dialled (`${ip}|${host}`), and a
  credential whose hash last succeeded skips the wait; a success does not wipe the address's
  failure count, or a guesser sharing the owner's key would get a fresh allowance at every poll of
  the owner's.
- Refusals before a caller was identified go to a ring of their own (`audit_refusals`, 1 000 rows,
  paths cut at 512 characters, readable at `GET /audit/refusals`), so 60 000 anonymous requests no
  longer push the 50 000-row audit of what identified callers did out of the log.
- Under `mode: none`, a write whose `Origin` is not the request's own authority answers
  `403 cross-site`, so a page in the person's browser cannot drive an open install.
- A push endpoint on this machine or its network is refused at registration and again at send
  time, when a name resolves to a private address.

## How to add a route

Give `d()` its `access`. If the route is `work` and takes a body that could widen a chat, give it
`workFields`. Add the row to [rest-api.md](../rest-api.md). A test fails until you have.

## Related

[[security-model.md]] · [[plans/regression-fixes-2026-10-29.md]] · [[reports/regression-audit-2026-10-29.md]] · [[decisions/requests-without-credential.md]] · [[decisions/confined-api-chat.md]] · [[rest-api.md]] · [[chat-environment.md]]
