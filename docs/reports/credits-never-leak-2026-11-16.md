---
created_at: 2026-11-16T21:00:00Z
updated_at: 2026-11-16T21:00:00Z
tags:
    - report
    - incident
    - accounts
    - credits
    - rate-limit
    - rotation
---
# Incident: a chat ran on usage credits under `never`, then read as stopped at a limit it had not reached (2026-11-16)

On a second machine of the owner, running Claudio **0.18.0** from apt, a person's chat on the default
account (a Team plan) went past its five-hour window and kept working with the account's usage
credits switched on, although the account's credits setting was the default `never` (D3 and D4 of
[the limit plan](../plans/limit-resume-and-credits.md): credits are never spent by default, and a turn
that crosses into them is stopped at once). Nothing stopped it and nothing marked it paid.

## What the records say

All read-only, on that machine.

- **Settings.** `accounts.json`'s settings have no `credits` key (the store writes only keys a person
  set), so the setting was `never` throughout; `rotateOnLimit` is off.
- **The crossing.** `usage_history` for the default account's `five_hour`: 95 at 16:43:42Z, 98 at
  16:44:26, 99 at 16:44:58, **100 at 16:45:41, 101 at 16:46:41**, then nothing until the window reset
  at 17:10 (0 at 17:10:45). The seven-day window stayed at 62 from 16:46:31 to 17:17:39.
- **Work went on.** The CLI's own transcript of the chat shows ~600 requests between 16:45 and 17:10,
  almost all from background subagents (Sonnet and Opus), and the lead's turns: the one open at the
  crossing had ended at **16:45:04**, before either reading of 100 or more; the next three were opened
  by **task notifications** (16:52:56, 16:56:24, 17:02:20), not by a message of the person (the server
  log has no `POST /messages` between 16:01 and 17:56).
- **Neither plan window moved** while those requests ran (five-hour stuck at 101, seven-day at 62),
  which is what requests paid from extra usage look like: the plan was not counting them.
- **Credits.** `get_usage` at 17:56:55 (a Refresh driven from the owner's main machine) says
  `extra_usage` on, 39.71 of 100.00 EUR used this month, cap not reached. The previous answer was a
  Refresh at 15:18:24; what it said is gone (the store keeps the latest answer only). The stream's
  overage fields last stored (18:18:02) are `overageStatus: allowed`, `isUsingOverage: false`.
- **Claudio's view.** `spend_ledger` rows of the chat all have `credits = 0`; the three results inside
  the spent window (16:54:08, 16:56:51, 17:02:31) are 24.61 USD at API prices (the CLI's estimate, not
  a bill). `rotation_events` has nothing for the day after 15:00: no stop, no move. The chat's single
  execution recorded no limit.
- **Not recoverable.** The `rate_limit_event`s themselves: Claudio's server log holds requests only, the
  CLI's transcript does not keep them, and `chat_entries` holds the transcript.

How much was charged to credits is not known: the month's figure before the incident was not kept.
The upper bound is the work done between 16:45:41 and 17:10:00, whose API-price estimate is in the
order of 25 USD.

## Cause

Three defects in the check that `t7` built (`ChatManager.checkCredits`), each enough to miss this
case:

1. **The check looked only at an open turn of the lead** (`chat.turnOpen`). The readings that crossed
   the limit came while the lead's turn was closed and its background subagents worked, so the hint
   (`overageStatus: allowed` beside a five-hour window at 1.00) and the reading that followed were
   both looked at and dropped.
2. **A turn the agent opens itself was never checked.** Only `deliver` (a message of Claudio's) looked
   at credits when a turn opened; the turns a task notification opens go through the fold's message
   path, which did not.
3. **The check is edge-triggered and the stream goes quiet.** Once the window stood at 1.01 the CLI
   reported nothing new, so no further reading came to look again; and the `overage` state stands on a
   `get_usage` answer that only a person's Refresh or a wait asks for, 88 minutes old here.

Refuted: the absent `credits` key is read as `never` (`parseSettings`, `creditsSettingOf`); the
stream's `isUsingOverage: false` did not matter, since the check's hint needs either field and the
`overage` state needs neither; the Team plan does nothing different on Claudio's side.

## The second symptom: stopped at a limit that was not reached (19:05Z)

The same chat, two hours later. After the owner installed 0.19.0 on that machine, the chat showed
"stopped: it reached its limit", the five-hour banner with a reset at 23:10 local and a Wait button,
while the status bar said 83 % and the account chip "near the limit".

- **No limit happened.** The CLI's transcript has no API error and no synthetic message anywhere in
  the session; the last lead turn ended normally (`end_turn`) at 19:03:42, with a background shell
  still running. `usage_history`: five-hour 83 at 19:03:26, 84 at 19:08:41.
- **The process ended for the update.** The desktop log says `quitting` at 19:05:20.192 and the old
  server `exited with code 0` at 19:05:21; the 0.19.0 daemon started the new server at 19:05:55. The
  chat's execution (open since 15:06) was closed at 19:05:20.971 with `outcome: stopped`,
  **`cause: rate-limit`** and no `limitResetsAt`.
- **Why `rate-limit`.** 0.18.0 writes that cause when `chat.rateLimited` is set as the process ends.
  With no failed result in the session, the only writer left is a **`rejected` rate-limit event the CLI
  sent and then went on past**: the fold marked the chat on any rejected event, and only a new process
  cleared the mark, so it stayed for the four hours this process lived. The missing `limitResetsAt`
  says that event carried no reset of its own. The event is not kept anywhere, so its exact fields
  are inferred: at a plan limit with credits on, a rejection with `overageStatus: allowed` is what the
  typings name for "the plan refused, credits cover it".
- **What 0.19.0 did with it.** A restart reads a last execution with `cause: rate-limit` as a chat
  still at its limit (`LiveChat` restore), so the chat came back stopped and waiting, and the page
  drew the account's five-hour reset.

Two more rules would stop a chat on room left: `overageHint` read any rejection of a plan window
beside a covering `overageStatus` as a turn on credits, whatever use the event reported for that
window, so under `never` it would stop a turn at 83 %; and `readingFromEvent` read such a rejection
as the account out until its reset, which `isOut` and the banner then believe.

## Fix

- `creditsMayPay` (`packages/accounts/src/thresholds.ts`): work on an account may be paid from its
  credits when it reads `overage`, or when one of the plan's windows reads at or past 1 (from any
  source: the stream, `get_usage`, the CLI's cache) and the latest word on its credits says they are
  on (`get_usage`'s `extra_usage`, or the stream's overage fields, whichever came last). It does not
  read `isUsingOverage` as required.
- `checkCredits` acts while the CLI spends: the lead's turn is open **or** background work runs; it
  uses `creditsMayPay`, so it is level-triggered on the account's reading, not only on a hint.
- A turn the agent opens itself (the fold's `turnOpenedByAgent`) is checked as one Claudio opens.
- With only background work running, a refused account stops the process (no turn to replay), says
  so in a notice and records a `stopped` rotation row with reason `credits`.
- When a plan reads spent under running work and the last `get_usage` answer is older than five
  minutes, Claudio asks `get_usage` once (no turn, no token; at most once per account in five
  minutes; never for a chat the CLI refused, nor for an account whose credits were never set up),
  and the answer comes back as any reading.
- The paid-turn mark uses the same predicate.
- A successful result clears the chat's limit mark (unless Claudio itself stopped the turn), so a
  rejection the CLI went past is never written as `cause: rate-limit`; a rejected event whose
  `overageStatus` says credits cover it does not mark the chat at all (a 429 result still does).
- `overageHint` reads a rejection of a plan window as a turn on credits only when that window's
  reported use is at or past 1 (or not reported).
- `readingFromEvent` reads a plan rejection that `overageStatus` says credits cover as no refusal:
  the windows decide the state, so the account reads near, not out. A rejection while
  `isUsingOverage` is still the overage refused, as before.

Tests: `packages/accounts/test/credits-turn.test.ts` (the sequence of readings above, the hint and
the reading at 83 %) and `packages/core/test/credits-leak.test.ts` (background work on a crossing, a
crossing with no overage fields that a probe settles, a turn opened by the agent; a rejection at 83 %
under `never`, and a turn that went through after a rejection, ended as the update ended it), over
the fake CLI's new `FAKE_CLAUDE_BG_RATE_LIMITS`, `FAKE_CLAUDE_SELF_TURN_MS` and
`FAKE_CLAUDE_TURN_RATE_LIMITS`. Each failed before the fix. The readings are built in the shapes
that machine stored (`limits.json`, `usage_history`, the execution row); Claudio was not run there,
since that machine is read-only for this work.

## For the owner

Until a release with the fix is on that machine, switch extra usage off for that account on
claude.ai, or keep it off while Claudio runs unattended there. The chat that read as stopped was
resumed by hand at 19:06 and runs; nothing else on that machine carries the false mark.

## Related

[[plans/limit-resume-and-credits.md]] · [[decisions/credits-in-the-stream.md]] · [[accounts.md]]
