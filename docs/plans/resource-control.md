---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-18T12:00:00Z
tags:
    - chats
    - orchestration
    - system
    - plan
---
# Resource control: the audit's recommendations, and the dashboard still to choose

This plan takes the recommendations of the 2026-10-16 audit of how Claudio uses the machine, and
records what is built, what is left and why. What is built is described in
[docs/resource-control.md](../resource-control.md); this file is the status and the open decision.

## Status of each recommendation

| # | Recommendation | Status |
|---|---|---|
| 3.1 | System metrics in the API | **Built**: `GET /api/system/load` (`system-load.ts`) |
| 3.2 | Per-chat process metrics in the API | **Built**: `GET /api/system/processes` |
| 3.3 | Admission by memory, not only by count | **Built**: `admit()` refuses on `MemAvailable` and memory PSI |
| 3.4 | Stop ends the CLI's children | **Built** in `ChatManager.stop()`; no end-to-end test with a real child process |
| 3.5 | Default time limit for tasks without one | **Built**: 180 min, `CLAUDIO_TASK_MAX_MINUTES` |
| 4 | Fair queue with priority for interactive chats | **Partly built**: a person's refused start reserves the next place for 20 s (`InteractiveHold`); workers give way. No queue of requests: refusals are still answered at once and polled every 3 s, see the Outcome |
| 4 | Async `git` on request paths | **Built for the review endpoints** (`Changes` service, project overview); the rest is listed in `docs/resource-control.md` |
| 4 | Less of `/proc` read per request | **Built**: `/system/processes` reads the table through a 2 s cache (`recentProcessTable`) |
| 4 | Random E2E port by default | **Not built**: `e2e/run.mjs` keeps a fixed default, now 8809; since #29 the suite runs only on GitHub (`e2e/run.mjs` refuses elsewhere), so runs no longer share this machine |
| 4 | Log and artefact budget | **Not measured** |
| 5 | Limit for heavy commands (builds, Chromium) | **Not built**: needs a cgroup or a change in how the CLI runs its tools |
| 6 | Dashboard, option A | **Built**: the `machine` widget of the overview, see the Outcome |
| 6 | Dashboard, option B | **Built**: Settings → Runs & spend → Machine, with a week of stored readings (`GET /api/system/history`) |

## Why some items are not built

**The heavy-command limit.** An agent's `npm`, Vitest or Chromium runs inside the CLI's own shell, and
Claudio does not start it, so a limit in code would reach only Claudio's own verification commands.
The real guard is a systemd slice around the service: `MemoryHigh` slows the group, `MemoryMax`
ends it. That belongs in the deployment, and the numbers come from the benchmark phases, not from
this plan.

**The fair queue.** A queue that holds requests and prioritises interactive chats changes how a
refused start is reported to the person and to the orchestrator. Only the reservation of a place for a
person was built (see the Outcome); the queue itself is still open.

## The dashboard: the options, and the choice

**Chosen and built:** A and then B, which together make C: the Machine widget and Settings → Runs &
spend → Machine, merged in #38 and released in 0.5.0 (see the [Outcome](#outcome)). The options are
kept as they were weighed.

The memory of this project's UI work asks for the choice before any screen is built. These are the
three options, with the recommendation.

**A. A line in the existing overview (recommended).** The dashboard's overview already carries the
usage bars and the status bar. Add one row with memory (available MB, with the bar in the usage
colours: neutral below 60 %, warn from 60 %, bad from 75 %), the memory pressure as a word and a
figure, and the count of chats with their total RSS. Why: it is the smallest change, it reuses
the `StatusBadge` of `packages/ui` and the usage bar the overview already draws, and it answers the question the owner asks, whether the machine can take
another chat.

**B. A page under Config, "Machine".** A page with the full reading: load over 1, 5 and 15 minutes,
PSI for the three resources as small charts, and a table of chats by RSS and CPU. Why: it shows
history and the per-chat breakdown the audit asked for. Cost: the history has to be stored (a stream,
so SQLite, not a JSON file), and it is a page to build and to keep in both themes and on a phone.

**C. Both: the row in the overview, and a detail page behind it.** Why: the owner gets A now and B
when the benchmark needs the history. Cost: two surfaces to design and test.

**Recommendation: A now, B after the benchmark.** A is enough to see saturation while the benchmark
runs, and B is only worth its store once there is a history to show.

The chosen option goes into `docs/design-system.md` (a variant, if one is new) and the screen gets its
own design section here before code. The Night Shift rules apply: tokens only, both themes, the
status colours carry a word, and motion stays off in a hidden tab.

## Related

- [[resource-control]]
- [[orchestrations]]
- [[status]]

## Design of the machine widget (option A)

The owner chose option A. The figures are one widget of the overview, not a new screen, so it is a
new widget type in the grid. Investigation first: the overview is the widget grid in
`apps/web/src/pages/dashboard/` (`registry.ts` lists every widget type; `pulse.tsx` holds the
limits widget, which already draws a ring and usage text). The reference to match is
`docs/design-system/reference/DSTablero.html`.

**Placement.** A new widget type `machine` in `packages/shared/src/dashboard-layout.ts` and
`WIDGET_RULES`, area `top` (the strip of figures under the hero), scope `both`, sizes `s` only, default
`s`. It reads no project module, so it shows on every project and on All projects.

**Content, from `GET /api/system/load` and `GET /api/system/processes`:**

- Memory: the available part in MB over the total, as a usage bar. The bar takes the usage colours of
  the design system: neutral below 60 %, warn from 60 %, bad from 75 % of memory used.
- Pressure: a word and a figure. `ok` below 10 % of `some10`, `warn` from 10 % up to the admission
  threshold, `bad` at the threshold (the point where no chat starts). The word is always shown next
  to the colour.
- Admission: "Admite chats" in ok, or the refusal in bad, with the reason from `refusal` shortened to
  its figure. Always a word, never colour alone.
- Chats: the count of live chats and their total resident memory in MB, in mono (counts and figures
  are Geist Mono).

**States.**

- Loading: the card's skeleton, as the limits widget does.
- No figures (a machine without `/proc`): the card says the machine does not expose them, in the
  secondary text colour. No bar, no colour, no status word.
- A figure that is null inside a reading: that figure alone reads as a dash.
- Refused: the admission line is bad and the card keeps the memory bar visible, so the cause is in view.

**Classes.** The card is `card kpi` with the same heading and figure pattern as the limits widget
(`kpi-label`, `kpi-sub mono`, `gauge-value`), styled in the file that defines those selectors. No new
colour, radius or duration: tokens only.

**Motion.** None. Nothing here is a live agent, so it does not carry the energy border, the live rail
or a spinner. It refetches on the overview's own interval and stops in a hidden tab, like the others.

**Copy.** `home` namespace, `widgets.machine.title`, with `en` and `es` in parity, following
`apps/web/src/i18n/GLOSSARY.md`. Proposed title: "Machine" / "Máquina". The admission words are
decided with the glossary, not invented here.

**Phone.** The same card, full width in the top strip. Nothing in it is a control, so there is no
touch target to size. Its figures wrap, they do not truncate.

**Checks before it is done.** The night-shift UI checklist (tokens, both themes, contrast ≥ 4.5 : 1
for text, phone width, motion levels, a11y), the layout tests for the new type, and a screenshot in
dark and light compared against `DSTablero.html`.

**Not decided here.** The implementation goes through the owner's orchestration path (design first,
then agents on opus or sonnet, never fable), so it is a separate change after this design is merged.

## Outcome

Merged into `main` in #38 and released in 0.5.0 (2026-10-18). Built on `feat/machine-widget`, one
commit per item.

1. **Machine widget (option A).** `machine` is a widget type of both Homes (area top, size s). It reads
   `GET /api/system/load` and `/api/system/processes` every 10 s and says memory (a bar in the usage
   colours), pressure (a word and a figure, calm below 10, rising to the admission limit, high from it),
   admission (a word, with the figure that refused) and the chats with their resident memory.
   `SystemLoad` now carries the admission `limits` in force so the pressure verdict follows
   `CLAUDIO_ADMIT_MEMORY_PRESSURE`. A stored layout keeps what it lists; Machine can be added from the
   picker. Deviation from the design above: counts and figures are sans with tabular numbers, not mono,
   because the designer's typographic voice (mono only for literals the machine reads) supersedes the
   older line in this plan.
2. **Less `/proc` per request.** `/system/processes` reads the process table through a 2 s cache
   (`recentProcessTable`): 8.8 ms per call with 417 processes became 0.04 ms amortised. Stopping a chat and
   cancelling a command still read it fresh.
3. **Async `git`.** Converted: the review endpoints (the `Changes` service: chat, task, integration and
   work-item changes and diffs), the flow's `workDone` hook and a project's overview commit count.
   Left sync, because they run in a background step or are one short call: the orchestrator's worktree
   and merge steps, verification, pull-request preparation, `review-diff.ts`, the health poll, the
   guards (which must answer a hook call before the CLI goes on) and the evals' lanes.
4. **Figures history (option B).** A sampler reads the machine every **60 seconds** and keeps **7 days**
   (about 10,080 rows of `system_samples`), pruned at each sample; both are environment variables.
   `GET /api/system/history` serves them (bucketed on request); Settings → Runs & spend → Machine draws
   them. Why 60 s: a chat's cost is visible at that grain and a week stays small. Why 7 days: enough to
   see a benchmark run and the days around it; the data is a convenience, not a record.
5. **Fair queue, partly.** Priority is built as a reservation (see `docs/resource-control.md`); the queue
   of requests is not, because holding or deferring a person's start changes how a refusal is reported
   to them, and nothing emits an event when memory frees up, so the worker's retry would remain a poll.
