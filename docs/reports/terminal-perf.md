---
created_at: 2026-10-15T20:00:00Z
updated_at: 2026-10-15T20:00:00Z
tags:
    - report
    - terminal
    - performance
---
# Terminal performance

`node e2e/perf/terminal-perf.mjs [--only server|browser] [--check]` boots an isolated server (temp
data and config dirs) and measures the plan's §6.5. `--check` fails the run when a result is beyond
`e2e/perf/budgets.json`. It is meant for a non-gating CI job.

## Measured: the server's parts (2026-10-15)

Linux 7.0.0-38 x64, Intel i7-9750H × 12, 30.6 GB, Node v22.21.1, `node-pty` 1.2.0-beta.15, dev server
(`tsx`), one `ws` client on loopback.

| Measure | Result | Plan's first guess | Budget now |
|---|---|---|---|
| Throughput, 64 MiB of `fold` output, client acking | 10.6 MB/s | ≥ 30 | ≥ 7 |
| Server tree RSS growth during that flood | 87.9 MiB | < 40 | ≤ 132 |
| API round trip while a terminal floods, p95 / worst | 14.9 / 45 ms | < 150 | ≤ 150 |
| `hello` on reattach with 1 000 lines behind, p50 / worst | 29 / 44 ms | < 300 | ≤ 300 |
| Back-pressure (`yes`, client never acks): bytes received before the shell paused | 2 MB | pause at the high watermark | |
| Back-pressure: server RSS growth over 10 s | 66 MiB | flat | ≤ 99 |

Budgets that were measured are the measurement plus 50 % headroom (a floor for throughput); the
rest keep the plan's values. Throughput and RSS miss the plan's guesses: the figure is the whole
service, host IPC included, with a client that acknowledges every frame. Whether 30 MB/s is
reachable is for whoever tunes the host.

## Not measured

The page's parts (300 000 lines end to end, keystroke echo, cold load with the terminal open) need
`pnpm build` and Chrome and were not run; their budgets are still the plan's guesses. Run
`node e2e/perf/terminal-perf.mjs --only browser` after a build and replace them.

## Finding: a stalled client freezes the shell for the others

With two clients attached, one never acknowledging, the shell pauses at 2 MiB unacked and stays
paused: the second client's `echo` did not arrive within 15 s. §2.7 says a slow client must not hold
the others hostage, by eviction past 8 MiB unacked, but the pause at 2 MiB keeps the unacked count
from ever reaching 8 MiB, so the eviction in `packages/core/src/terminals/flow.ts` cannot fire. The
shell recovers when the stalled client disconnects. A fix belongs to the core (evict a client that
stays above the high watermark for some seconds, or put the eviction threshold under the pause); the
script reports it as a failed line, and `--check` fails until it is fixed.

## Related

[[terminal.md]] · [[plans/terminal.md]]
