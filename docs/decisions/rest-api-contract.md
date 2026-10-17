---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
tags:
    - decision
    - rest-api
    - docs
    - readme
    - convention
---
# The route list lives in docs/rest-api.md, and a test keeps it whole

**Decided on 2026-10-17**, with the README's rewrite as a landing page: the table row every REST
route needs moves from the README to [rest-api.md](../rest-api.md), and a test now checks it.

## What it was

The README carried the REST API as 31 tables, about 850 of its 1,684 lines, and the rule "a new
route gets a row in the README's REST tables" was stated in CLAUDE.md, CONTRIBUTING.md, the
`add-rest-route` skill, the agent files and [status.md](../status.md). Nothing checked it: a test
enforced the OpenAPI summary and tag, and the rows were kept by hand. Two of them had drifted into
shorthand (`/plugins/install` · `/uninstall` · …, `/collaborators/shared/:owner/:shareId/{chats,…}`),
which hid nine routes from any reader looking for one.

## What it is now

- **The contract** is [rest-api.md](../rest-api.md): one row per route, the method in the first
  cell and the route in backticks in the second, grouped under the route's OpenAPI tag.
- **The check** is `apps/api/test/rest-api-doc.test.ts`. Every key of `ROUTE_DOCS`
  (`apps/api/src/openapi/routes.ts`) must have a row, every row must name a key, and no route may
  have two rows. `apps/api/test/api.test.ts` already checks that every registered route is in
  `ROUTE_DOCS` with a summary and a tag, so the two together tie the page to the server.
- **The README** says what Claudio is and links to the page. It lists no routes.

## Why

- A landing page of 1,684 lines buried what Claudio is under what it serves; a reader looking for a
  route searches the docs anyway, where the knowledge base indexes them.
- Moving the rows without a test would have moved the drift with them. With the test, the rule
  stated in five places is enforced in one.

## Rejected

- **Generating the page from `ROUTE_DOCS`.** The rows carry more than the summaries do (status
  codes, who may call a route, what it emits), written for a person; generating them would mean
  moving that prose into `routes.ts` first.
- **Keeping the tables in the README** and only adding the test: the README stays the size it was.

## Related

[[rest-api.md]] · [[knowledge-base.md]] · [[status.md]] · [[api-wire.md]] · [[development.md]]
