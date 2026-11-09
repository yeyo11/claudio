---
created_at: 2026-11-09T16:56:49.621632091Z
updated_at: 2026-11-09T16:56:49.621632091Z
tags:
    - decision
    - openapi
    - rest-api
    - performance
    - tests
---
# The OpenAPI components are served as generated, not resolved by the plugin

**Decided on 2026-11-09**, in task `flaky-security` of
[the CI's flaky tests](../plans/ci-flaky-tests-2026-11-09.md). Concerns
[`apps/api/src/openapi/plugin.ts`](../../apps/api/src/openapi/plugin.ts) and the generated
[`apps/api/src/openapi/schemas.json`](../../apps/api/src/openapi/schemas.json).

## What it was

`registerOpenApi` handed the 956 component schemas to `@fastify/swagger` as `openapi.components`.
On the first `GET /openapi.json` the plugin runs `prepareOpenapiSchemas` over them, and that function
resolves each component with `json-schema-resolver` against an external schema holding all the
others. The work grows with the square of the number of components. Measured:

| Where | First `GET /openapi.json` |
| --- | --- |
| Workstation, idle | 10 s |
| CI runner (2 vCPU), whole suite running | 20–29 s |
| Workstation, load average 40–50 | 35 s |

All of it is synchronous CPU, so the wrapper's event loop is blocked for that time: no other
request, SSE heartbeat or chat stream is served. The document is cached afterwards, so this
happened once per process. In the tests it happened in every file that reads the document, and it
helped push `apps/api/test/security.test.ts` past its 240 s per-file limit on CI.

## What it is now

- The components join the finished document through the plugin's `transformObject`, after
  everything the plugin resolves. The plugin's own components (schemas with an `$id` nested in a
  route schema, `def-N`) come after the generated ones. Today there are none.
- The document is built in under half a second.
- `apps/api/test/api.test.ts` asserts that every component served is equal to its schema in
  `schemas.json`.

## What changed in the document

`paths`, `info`, `servers` and `tags` are byte-identical to before. The components are now exactly
`schemas.json`, which differs from what the plugin used to emit in two ways:

- **167 `description`s beside a `$ref` are kept.** The plugin dropped every sibling of a `$ref`,
  which OpenAPI 3.0 required and 3.1 does not.
- **187 `const`s stay `const`.** The plugin rewrote them as `enum: [value]` for Swagger UI. The
  reference here is Scalar, which reads 3.1's `const`.

Both are valid OpenAPI 3.1, the version the document declares. The plugin's comment already said
the components were "injected verbatim"; now they are.

## Rejected

- **Leaving the plugin alone and making the tests avoid `/openapi.json`.** The cost would still hit
  every running wrapper on its first `/docs` visit, and the test that proves the guard serves the
  reference to a token holder would no longer check it.
- **Reimplementing the plugin's conversion for our components.** It would copy internals of
  `@fastify/swagger` that it does not export, to keep two rewrites that 3.1 does not need.
- **Emitting the converted form from `openapi:schemas`.** It changes the generator and the
  committed schemas for the same two rewrites.

## Related

[[plans/ci-flaky-tests-2026-11-09.md]] · [[rest-api.md]] · [[decisions/rest-api-contract.md]]
