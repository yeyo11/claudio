---
created_at: 2026-11-07T11:45:45.647555868Z
updated_at: 2026-11-07T11:45:45.647555868Z
tags:
    - decision
    - delivery
    - chats
    - claude-code
    - interrupt
---
# Decision: `still_queued` is read only when the CLI promises it

Taken by the owner on 2026-11-07 in [plans/ci-and-regression-open.md](../plans/ci-and-regression-open.md#22-settled-by-the-owner-on-2026-11-07) (R1). It closes the first open item of [plans/regression-fixes-2026-10-29.md](../plans/regression-fixes-2026-10-29.md#open), which asked whether the interrupt receipt was an exception to the one rule.

## Question

When Claudio interrupts a turn, which of the messages it wrote are still in the agent's queue? Claudio reads the answer from the interrupt response's `still_queued` list. The regression plan (C2) recorded that field as read from the CLI's protocol description (2.1.312) and absent from the Agent SDK's typings, so it might have been an undocumented interface, which [the one rule](../../CLAUDE.md#the-one-rule) forbids.

## Decision

Keep it, and keep it inside the rule.

- **It is a vendor interface.** `@anthropic-ai/claude-agent-sdk` 0.3.319 (2026-11-06) types `interrupt(): Promise<SDKControlInterruptResponse | undefined>`, whose `still_queued` lists the ids the agent has not read. The CLI advertises it in the `capabilities` of the `system/init` message as `interrupt_receipt_v1`. The citation sits in `packages/core/src/providers/claude-code/control.ts`.
- **It is read only when promised.** The stream parser keeps the `capabilities` of each `system/init` on the live chat (cleared at every spawn). The driver reads `still_queued` only from a process that announced `interrupt_receipt_v1`. From one that did not, a message the interrupt did not settle waits for the result of its turn, as before; it is never taken for lost on a missing field.
- **The fakes behave like the CLI.** The fake CLIs announce the capability, as the real one does from 2.1.278, and the queue fake can leave it out (`FAKE_NO_CAPABILITIES=1`) to test the other branch.

Built by the `delivery` task (`7ed0c0c05`).

## Rejected

- **Dropping the receipt.** `written` would then be bounded by the next result alone, and "Send now" could not tell a message the agent already read from one it never will.
- **Reading the field by shape, as before.** It works with a CLI that renames or removes it and gives a wrong answer without saying so.

## Consequence

A CLI older than 2.1.278 (no capability) loses the early settlement of interrupted messages and nothing else. A new capability version (`_v2`) is not read until Claudio is taught it.

## Related

[[chat-delivery.md]] · [[providers.md]] · [[plans/ci-and-regression-open.md]] · [[plans/regression-fixes-2026-10-29.md]]
