---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-16T12:00:00Z
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
| 4 | Fair queue with priority for interactive chats | **Not built**: refusals are polled every 3 s |
| 4 | Async `git` on request paths | **Not built**: `git.ts` still uses `execFileSync` |
| 4 | Less of `/proc` read per request | **Not built**: `processTable()` reads everything on each call |
| 4 | Random E2E port by default | **Not built**: `e2e/run.mjs` keeps 8799 |
| 4 | Log and artefact budget | **Not measured** |
| 5 | Limit for heavy commands (builds, Chromium) | **Not built**: needs a cgroup or a change in how the CLI runs its tools |
| 6 | Dashboard | **Waiting for a choice**, below |

## Why some items are not built

**The heavy-command limit.** An agent's `npm`, Vitest or Chromium runs inside the CLI's own shell, and
Claudio does not start it, so a limit in code would reach only Claudio's own verification commands.
The real guard is a systemd slice around the service: `MemoryHigh` slows the group, `MemoryMax`
ends it. That belongs in the deployment, and the numbers come from the benchmark phases, not from
this plan.

**The fair queue.** A queue that prioritises interactive chats changes how a refused start is
reported to the person and to the orchestrator. That is worth doing after the benchmark shows how
often a refusal happens; until then the polling does its job.

## The dashboard: options to choose from

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
