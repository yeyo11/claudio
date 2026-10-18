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

**A person's chat goes before a task's worker.** When a person's start (`purpose: 'person'`) is
refused a place, by the count or by the memory, they are told exactly what they were told before
(the same words and status), and `ChatManager` also notes that someone is waiting
(`InteractiveHold`, `packages/core/src/admission-queue.ts`). For the next 20 seconds, or until a
person's start is admitted, a task start from the orchestrator (`queued: true`, the two calls that
keep the task pending) is refused with `QUEUE_YIELD_PREFIX` ("Waiting for a chat a person asked to
start first"), which the orchestrator matches like the other transient refusals: the task stays
pending and is looked at again in three seconds. So the place that frees up is there when the person
retries, and not taken by a poll that fired first. A graph's reviewers, workflow lead and fixers are
not made to give way (they have no pending state to give way into), and neither are housekeeping,
flow runs or evals.

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

**The figures are kept, a week of them.** `SystemSampler` (`packages/core/src/system-history.ts`)
reads the same figures once a minute and stores one row in `system_samples` (SQLite, in the style of
`usage_history`): the one-minute load, memory total and available, the PSI `some10` of CPU, memory
and I/O, the count of chats and their resident memory, and whether a chat would have been admitted.
A reading older than 7 days is deleted at each sample, so the table holds about 10,080 rows. A machine
with no `/proc` stores nothing. `GET /api/system/history?since=&until=&limit=&bucket=` returns the rows
oldest first; `bucket` (seconds) folds a long range into a few hundred points, each the worst of its
span (the largest load, pressure, chats and resident memory, the smallest available memory). The
**Machine** page, Settings → Runs & spend → Machine, draws memory in use, the three pressures with the
admission limit and the load with the core count over 1 hour, 6 hours, 24 hours or 7 days, and lists
the live chats by resident memory and CPU time.

## The limits, and where they come from

| Variable | Default | What it sets |
|---|---|---|
| `CLAUDIO_ADMIT_MEMORY_FLOOR_MB` | 2048 | Memory below which no chat starts |
| `CLAUDIO_ADMIT_MEMORY_PRESSURE` | 20 | Memory PSI `some10` (percent) at which no chat starts |
| `CLAUDIO_TASK_MAX_MINUTES` | 180 | Time a task may run without its own limit; 0 disables it |
| `CLAUDIO_MAX_CONCURRENT_RUNS` | 8 | Count of chats (unchanged) |
| `CLAUDIO_MACHINE_SAMPLE_SECONDS` | 60 | Seconds between stored readings of the machine; 0 turns the history off |
| `CLAUDIO_MACHINE_RETENTION_DAYS` | 7 | Days a stored reading is kept |

The admission values and the sampler's two are read when the server starts; a restart applies a change. The defaults
are a starting point, not a measurement: they are to be set from the benchmark phases, not taken as
the right numbers for a given server.

## What is not done

- **Children started by an agent are not limited.** A chat's `npm`, Vitest or Chromium runs under the
  CLI, and Claudio cannot cap what the CLI starts without a cgroup. The memory check is the only
  guard, and it acts before a chat starts, not while it runs. A cgroup limit per service belongs in
  the deployment (see `docs/plans/resource-control.md`).
- **There is no queue of requests.** A person's refused start is answered at once and is not held;
  the priority is a reservation of the next place, not a line. A worker's refusal is still polled every
  three seconds: nothing emits an event when memory frees up, so a wake-up would be a poll of its own.
  Holding the person's request open until a place frees, or accepting it and starting it later, would
  change how a refusal is reported to the person (a 409 at once today), and was left out on purpose.
- **A stop that finds no `/proc` falls back to signalling the CLI alone**, as before.
- **Synchronous `git` is left where it is not on a request path, or is not the cost.** The review
  endpoints (`/chats/:id/changes`, `/changes/diff`, the task, integration and work-item twins, and a
  project's overview commit count) go through `...Async` twins in `git.ts` (`execFile`, same arguments,
  same parsers, same errors) and no longer hold the event loop. Left sync: the orchestrator's own
  worktree and merge steps, verification, pull-request and merge preparation, `review-diff.ts`
  (the review prompts), the health poll, the guards (which must answer a hook call before the CLI goes
  on) and the evals' lanes. Each runs in a background step or is a short single call; converting them
  is the same mechanical work if one shows up in a profile.
- **The process table is still read in full, but at most every two seconds** for what is shown
  (`recentProcessTable`). Stopping a chat or cancelling a command reads it fresh: a stale table could
  name a pid the system has reused.
- **The E2E port is fixed** (`e2e/run.mjs`, 8799): two runs on one machine collide.
- **The overview shows the figures in a Machine widget** (memory bar, pressure, admission, chats with
  their resident memory), polled every 10 s by `useSystemLoad` and `useSystemProcesses`; the history is
  on the Machine page. Neither shows the load per chat over time: only its resident memory and its
  cumulative CPU time now.

## Related

- [[orchestrations]]
- [[orchestration-timings]]
- [[chat-environment]]
- [[status]]
