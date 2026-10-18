---
created_at: 2026-10-16T12:00:00Z
updated_at: 2026-10-16T12:00:00Z
tags:
    - chats
    - orchestration
    - api
    - system
    - decision
---
# Resource control: what the machine has, and what Claudio starts

Claudio starts one process per chat (the Claude Code CLI), and each one may start its own children:
a build, Vitest, Chromium. Until now the only limit was a count of chats (`maxConcurrentRuns`), and
Claudio measured nothing about the machine. This document is what the server does about it now, and
what it still does not do.

## What the server does

**It reads the machine from `/proc` on each request** (`packages/core/src/system-load.ts`):
the load average, `MemTotal` and `MemAvailable`, and the pressure stall information (PSI) of the
CPU, memory and I/O. PSI is the kernel's own measure of how long work waited for the resource in the
last 10 seconds, so it reads the same whether one process or fifty are the cause.

**It refuses a new chat when memory is short.** Before a chat starts, `ChatManager.admit()`
(`packages/core/src/chats.ts`) refuses with HTTP 409 when:

- `MemAvailable` is below `CLAUDIO_ADMIT_MEMORY_FLOOR_MB` (default 2048), or
- the memory pressure `some10` is at or above `CLAUDIO_ADMIT_MEMORY_PRESSURE` (default 20 %).

CPU pressure never refuses: a busy CPU slows the work down, and memory exhaustion kills it. A
machine that exposes none of this (no `/proc`) admits chats as it did before.

**An orchestration task waits for that memory instead of failing.** `Orchestrator.refuse()` treats
the memory refusal like the count refusal: the task stays pending and the scheduler looks again in
three seconds. The refusal's words start with `RESOURCE_REFUSAL_PREFIX`, and that prefix is what the
orchestrator matches, so the two must change together.

**Stopping a chat ends its children too.** `ChatManager.stop()` walks the process table from the
CLI's pid and signals the descendants first, then the CLI, and escalates to SIGKILL after five
seconds for what is still the same process (`terminateTree` in `processes.ts`). Before this, only
the CLI received the signal.

**A task with no time limit gets the server's default.** `effectiveLimits()` in
`packages/core/src/task-limits.ts` falls back to `DEFAULT_TASK_MAX_MINUTES` (180) when neither the
graph nor the task names one. `CLAUDIO_TASK_MAX_MINUTES=0` turns the default off. A task given a
time limit gets the existing warning at 80 % and a stop at 100 %.

**The machine and the chats are readable over the API.** `GET /api/system/load` returns the
reading, the admission limits in force (`limits`) and whether the machine admits a chat now; `GET /api/system/processes` returns each live
chat's process tree: the number of processes, the resident memory in MB and the CPU seconds used
so far. The CPU figure is cumulative, so a rate is the difference between two readings.

## The limits, and where they come from

| Variable | Default | What it sets |
|---|---|---|
| `CLAUDIO_ADMIT_MEMORY_FLOOR_MB` | 2048 | Memory below which no chat starts |
| `CLAUDIO_ADMIT_MEMORY_PRESSURE` | 20 | Memory PSI `some10` (percent) at which no chat starts |
| `CLAUDIO_TASK_MAX_MINUTES` | 180 | Time a task may run without its own limit; 0 disables it |
| `CLAUDIO_MAX_CONCURRENT_RUNS` | 8 | Count of chats (unchanged) |

The two admission values are read when the server starts; a restart applies a change. The defaults
are a starting point, not a measurement: they are to be set from the benchmark phases, not taken as
the right numbers for a given server.

## What is not done

- **Children started by an agent are not limited.** A chat's `npm`, Vitest or Chromium runs under the
  CLI, and Claudio cannot cap what the CLI starts without a cgroup. The memory check is the only
  guard, and it acts before a chat starts, not while it runs. A cgroup limit per service belongs in
  the deployment (see `docs/plans/resource-control.md`).
- **Refusals are polled, not queued.** A task waiting for memory looks again every three seconds. A
  queue with priority for interactive chats is not built.
- **A stop that finds no `/proc` falls back to signalling the CLI alone**, as before.
- **Synchronous `git` on request paths** (`packages/core/src/git.ts`, `execFileSync`) still blocks the
  event loop for as long as a git call takes. Not changed here.
- **The process table is still read in full, but at most every two seconds** for what is shown
  (`recentProcessTable`). Stopping a chat or cancelling a command reads it fresh: a stale table could
  name a pid the system has reused.
- **The E2E port is fixed** (`e2e/run.mjs`, 8799): two runs on one machine collide.
- **The overview shows the figures in a Machine widget** (memory bar, pressure, admission, chats with
  their resident memory), polled every 10 s by `useSystemLoad` and `useSystemProcesses`. The history
  page is not built yet; see `docs/plans/resource-control.md`.

## Related

- [[orchestrations]]
- [[orchestration-timings]]
- [[chat-environment]]
- [[status]]
