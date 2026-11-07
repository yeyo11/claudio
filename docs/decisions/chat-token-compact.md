---
created_at: 2026-11-07T11:45:15.729710739Z
updated_at: 2026-11-07T11:45:15.729710739Z
tags:
    - decision
    - security
    - chats
    - route-access
---
# Decision: compacting and session notes belong to the person

Taken by the owner on 2026-11-07 in [plans/ci-and-regression-open.md](../plans/ci-and-regression-open.md#22-settled-by-the-owner-on-2026-11-07) (R3). It reverses a line of C1 in [plans/regression-fixes-2026-10-29.md](../plans/regression-fixes-2026-10-29.md#contract-refinements) and amends [route-access-classes.md](route-access-classes.md).

## Question

The regression's security task made `compact`, `notes` and a typed `/compact` `work` routes, so a chat's token could call them, while the whole tunnel (`/tunnel/stop` included) became `person`. Should an agent be able to compact its own chat or write the notes that are handed back to it?

## Decision

No. `POST /chats/:id/compact` and `POST /chats/:id/notes` are `person`. A chat's token is refused with `403 chat-forbidden`.

- **Closing the loophole.** Text that starts with `/compact` compacts the chat whichever route carries it (`context.sendTyped`). The guard (`apps/api/src/security.ts`) therefore refuses it from a chat's token on `POST /chats/:id/messages` (`text`) and on resume and fork (`prompt`), with the same `403 chat-forbidden`. Changing the two routes alone would have left it open.
- **What still passes.** Hints reach the agent behind a prefix, so the CLI never reads them as a command. `POST /chats` has nothing to compact. Text that merely mentions `/compact`, `/compacting` or `/clear` passes. A person's typed `/compact` works as before. With authentication off nothing is enforced, as for every `person` route.
- **Why.** Compacting rewrites what the agent and the person will read of the conversation, and session notes are context the next turn is handed. Both change the record the person judges the agent by, so the agent does not hold them.

Built by the `security` task (`faa996adf`). The route table is in [rest-api.md](../rest-api.md) and the classes in [security-model.md](../security-model.md).

## Consequence

The route totals of C1 move by two (`work` writes down, `person` up); `apps/api/test/route-access.test.ts` states the new counts. On the `/v1` routes a `/compact` can only reach chats that the API caller itself started there.

## Related

[[route-access-classes.md]] · [[security-model.md]] · [[context-control.md]] · [[plans/ci-and-regression-open.md]]
