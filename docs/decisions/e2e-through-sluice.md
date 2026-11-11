---
created_at: 2026-10-24T16:00:00Z
updated_at: 2026-11-10T23:45:00Z
tags:
    - decision
    - e2e
    - ci
    - performance
    - agents
    - sluice
---
# Decision: the e2e suite runs here through Sluice

Taken by the owner on 2026-10-24. It replaces
[the e2e suite runs on GitHub, never on this machine](e2e-on-github.md). On a developer's machine the
browser suite (`e2e/`) runs as Sluice's `e2e` gate: an agent calls Sluice's `verify` tool with
`gates: ["e2e"]` and the spec prefixes in `extra_args`, a person runs `sluice run e2e -v -- <prefixes>`.
Every pull request still runs the whole suite on GitHub.

> **2026-11-07:** `pnpm e2e:remote` (`e2e/remote.mjs`), the bridge of the GitHub-only period, was
> removed by the owner: Sluice's gate is how a spec runs here, and CI is how the whole suite runs on
> a pull request. The workflow lost its `workflow_dispatch` trigger and keeps `workflow_call`.

## Why

- **What froze the host is gone.** The suite was banned here because each run sized itself as if it
  had the machine to itself (four shards, each an API server and a headless Chrome), and a few agents
  doing that at once, with nothing between them, took a 12-core machine to a load of 40–49. Since
  2026-10-24 the repository's checks go through [Sluice](../development.md#checks-through-sluice):
  one queue and one CPU budget for every agent on the machine, with admission held back under CPU
  pressure. A gate waits until the budget has room, so a few agents asking for the suite at once
  queue instead of piling up. Since Sluice 0.6.0 admission also weighs memory: each gate's working set
  is learned from its runs, and a job starts only when it fits what the machine has free, so an `e2e`
  run (a build, then two servers and two Chromes) does not start beside a test suite it would not
  fit with.
- **A pass is shared.** Sluice caches a pass per git tree: several agents verifying the same commit
  run the suite once, and a tree that already passed answers in milliseconds.
- **Iterating is faster.** A spec or two no longer need a push and one to two minutes of GitHub
  setup, nor work in progress pushed to a public repository.

## What was built

- **The `e2e` gate** in `.sluice.toml`: `pnpm run e2e:gate`, which is `pnpm build` and then
  `node e2e/run.mjs` with whatever prefixes `extra_args` (or `sluice run e2e -- …`) appends. The build
  is part of the gate so a cached pass always means this tree's UI. It has no hook, so nothing runs it
  on commit or push; it runs when a change needs it. Two shards (`E2E_SHARDS=2`) instead of the
  default four, a weight Sluice learns from measured runs (`auto`), a 45-minute limit, and failure
  screenshots in `e2e-shots/` (`E2E_SHOTS`), as on GitHub.
- **The refusal now admits Sluice.** `e2e/run.mjs` starts when `CI=true`, when `SLUICE_JOB` is set
  (Sluice sets it in every job it runs) or with `E2E_ALLOW_LOCAL=1`; otherwise it exits 2 and names
  the `e2e` gate and `pnpm e2e:remote`. Agents never set `SLUICE_JOB` or `E2E_ALLOW_LOCAL`
  themselves. The runner's own test (`e2e/harness.test.mjs`) checks the refusal with `SLUICE_JOB`
  cleared, since it runs inside a Sluice job too, and checks that a job is admitted.
- **No fixed port inside a job.** A single shard used `8809` unless `E2E_PORT` was set, so two jobs
  from two worktrees would collide. Inside a Sluice job it takes a free port; parallel shards already
  did.
- **The rule everywhere it was stated.** `CLAUDE.md`, `CONTRIBUTING.md`,
  [development.md](../development.md), the pull request template, the `developer` and `qa` agents
  and the `claudio-ui` skill's references now name the gate first. The repo skill `e2e-on-github`
  became `run-e2e` (`.claude/skills/run-e2e/SKILL.md`), with Sluice as the default and GitHub as the
  second way.

## What it costs

- **A whole-suite run is slower here than on GitHub.** Two shards on one machine take about 20
  minutes plus the build, against about 10 on four GitHub runners, and longer when the queue is busy.
  A broad change gets the whole suite from its pull request's CI.
- **The queue is shared.** A whole-suite run holds a large part of the budget for its duration, so
  other agents' gates wait behind it. Running only the specs a change touches keeps that short.
- **Without Sluice, no local e2e.** A machine without `sluice` on the `PATH` relies on the pull
  request's CI, or on `E2E_ALLOW_LOCAL=1` for a person.

## What it does not change

- GitHub decides: no pull request merges without the four e2e shards of `e2e.yml`.
- The live specs (`E2E_LIVE=1`) still need a logged-in CLI and a person.

## Agent marks in the gate (2026-11-10)

An agent's `verify` of the whole suite failed the four terminal specs and `motion`, which pass in CI.
The terminal guard of the sandboxed server walks a client's process ancestry for an agent's mark
(`CLAUDIO_CHAT_ID`, `CLAUDIO_AGENT_RUN`, `packages/core/src/terminals/peer.ts`). The gate's job inherited
the agent's environment, and so did the Sluice daemon an agent had started. The `e2e` gate now begins
with `exec env -u …` for those marks and the chat's API credentials, so no process of the job carries
them. The daemon above the job still does until it is started from a clean environment; that is
reported to Sluice. The person's own terminal is another server and its guard is unchanged.

## Related

[[decisions/e2e-on-github.md]] · [[development.md]] · [[resource-control.md]] · [[plans/ci-e2e-shards.md]] · [[plans/e2e-harness-waits.md]]
