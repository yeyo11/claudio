---
created_at: 2026-11-14T18:00:00Z
updated_at: 2026-11-15T12:00:00Z
tags:
    - report
    - supervisor
    - health
    - subagents
    - orchestration
    - decision-engine
---
# Supervisor routing in a chat that orchestrates subagents (2026-11-14)

An analysis of one real 36-hour session in which a lead chat delegated its work to subagents, read
against the code at `fa4d3f763`, and what changed because of it. The Supervisor
([decision engine](../decision-engine.md#the-supervisor)) was on, under Active for `hung-command`.

## What reached the lead

30 Supervisor messages reached the lead (orchestrator) chat:

| | Messages |
|---|---|
| Misrouted: about a subagent, delivered to the lead | 15 |
| False alarms: the lead or its subagent was not stuck | 13 |
| Marginal | 2 |
| Clearly useful | 0 |

All 12 cancel notices forced the lead to relay to the subagent by hand. One hung subagent command
produced a cancel, then a no-progress hint, then a silence hint, all to the lead, within 17 minutes;
one subagent got three cancels in 12 minutes. One hint queued while the lead sat inside a long tool
call was read 47 minutes later, about something long over.

## Causes, and what changed

1. **The cancel's words went to the lead.** `ChatService.cancelCommand` sent its notice as the lead's
   user turn whatever agent ran the command, quoting a hint written for the subagent ("Your
   `until grep` loop…"); the subagent saw only `Exit code 144`. Now `cancelCommand` reads whose call
   it was from the trace (`parentToolUseId`): a subagent's notice goes to the subagent, straight
   through the bridge (`messageAgent`) when it can carry it, else to the lead framed by
   `relayToSubagent` as a message to pass on. The lead keeps only the passive notice row. Test:
   `stuck-signals.test.ts`, "a subagent's hung command names the agent, and cancelling it reaches the
   subagent's process tree (C3)".
2. **Silence was chat-level, and only a foreground shell command counted as in flight.** A lead waiting
   on its subagents, a background task, a Monitor, an MCP call (a Sluice `verify` queued for 20 minutes)
   or a CI watch in the background read as silent. Now any open tool call, and a lead's running
   subagents, background tasks and workflows, are in flight (`quietParty` in `health.ts`); silence is
   judged per agent on its own last event, fires only when the whole chat is quiet, and names the
   subagent that is silent. Tests: `supervisor-routing.test.ts`, the four "is not silent" cases and
   "silence fires for the chat only when everything is quiet, and names the agent that is silent".
3. **No-progress fingerprinted only the lead's checkout.** A lead whose subagents work in
   `.claude/worktrees/*` never progressed there, so `no-progress` turned bad every 45 minutes and its
   draft blamed the lead for a subagent's uncommitted tree. Now it is not raised while a subagent runs,
   and progress anywhere in the family counts: a file written, a commit or a push by any agent
   (`lastRecordAt`), a change in any checkout its subagents work in (`familyDirs`: their `cwd`, the
   worktrees their calls name, the directories their commands `cd` into; six at most). Tests: "a lead
   is not asked for progress while a subagent it delegated to is running", "a subagent's commit
   counts as the lead's progress once the subagent is done", and the two `familyDirs`/`lastRecordAt`
   cases.
4. **Commands that bounded themselves were cancelled on elapsed time.** `gh pr checks --watch` under
   its own `timeout 2700` was cancelled at minute ten. Now a command that wraps itself in `timeout N`
   (`selfBoundMs` in `commands.ts`) is not `bad` before N plus a minute, for `hung-command` and for
   the running call of a `repeat-stall`; the other rules stand. Tests: "a command under its own
   timeout is not a problem before its bound, only a warning", "a repeated stall whose running
   command is inside its own bound stays a warning", and `commands.test.ts`.
5. **Drafts that said nothing was wrong were sent, and drafts invented facts** ("nothing is stalled",
   "silence is expected"; a "$0.25 budget", a commit co-author rule). Now a `stuck: true` whose own
   text says nothing is wrong is read as not stuck (`saysNothingWrong`), and the prompt forbids
   asserting a number, limit, budget, cost, duration, rule or convention it was not given. No
   fact-checker was added. Tests: `supervisor.test.ts`, "a draft whose own words say nothing is wrong
   is not stuck, whatever its flag says" and "the prompt forbids facts it was not given".
6. **No de-duplication across kinds.** The key was chat, kind and occurrence. Now a message to an
   agent (cancel, hint or relay, by the Supervisor or a person) holds every other signal about the
   same agent of the same chat for 30 minutes (`SAME_TARGET_WINDOW_MS`), across a restart. Test: "one
   message per agent per event: a cancel holds a later silence or no-progress about the same agent".
7. **Stale hints.** A hint the Supervisor queued for a lead is now watched on each monitor pass and
   taken back (`cancelMessage`) when its signal clears before the lead reads it, and a draft whose
   signal cleared while it was drafted is not sent on its own. Tests: "a hint queued for the lead is
   taken back when its signal clears before the lead reads it", "a hint whose signal cleared while it
   was drafted is not sent on its own", "a person's Send is never taken back…".

The decision engine's evidence and standing logic did not change; the one rule holds (the withdrawal
is the CLI's documented `cancel_async_message` control request, the subagent message the existing
`claudio-bridge` mod).

## Left for the owner

- **The window's length.** 30 minutes is a default chosen from the session's spacing (three messages
  in 17 minutes, three cancels in 12); it is a constant, not a setting.
- **A setting for any of this.** None was added: the safe defaults are built in.
- **A lead that waits on a background task for ever** is no longer flagged as silent; nothing else
  watches a background task's duration yet.

## Related

[[decision-engine.md]] · [[plans/decision-engine-v2.md]] · [[plans/agent-observability.md]] ·
[[agent-messages.md]] · [[plans/regression-fixes-2026-10-29.md]]
