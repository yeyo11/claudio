---
created_at: 2026-10-17T16:00:00Z
updated_at: 2026-10-17T16:00:00Z
tags:
    - decision
    - e2e
    - ci
    - performance
    - agents
---
# Decision: the e2e suite runs on GitHub, never on this machine

Taken by the owner on 2026-10-17. The browser suite (`e2e/`) runs only on GitHub Actions. On a
developer's machine `pnpm e2e` refuses to start, and agents run the specs they need with
`pnpm e2e:remote`, which dispatches them on the pushed branch and waits for the result.

## Why

- **It froze the host.** Each run sizes itself as if it had the machine to itself: four shards,
  each with its own API server and headless Chrome (`e2e/run.mjs`, one shard per two cores). With a
  few agents doing that at once, the owner's 12-core machine reached a load of 40–49, with CPU
  pressure at 73 % at p90 in a 20-minute baseline, and it froze. Memory had room; CPU was the
  bottleneck. Specs then failed only because of the load, and the 2026-10-17 close-out could not
  finish a local run.
- **GitHub decides anyway.** No pull request merges without the `test` check, which needs the four
  e2e shards. A local run only predicts what CI will say.
- **It costs nothing and is faster.** The repository is public, so standard runners are free. Four
  shards on clean machines take about 10 minutes of wall time, against about 33 minutes for the
  suite in one process (1,970 seconds of specs).
- **The results are cleaner.** One machine per shard removes the failures that came only from load,
  which took much of the week before this decision.

A rule in `CLAUDE.md` alone was not enough: agents forget prose. The runner enforces it.

## What was built

- **The refusal.** `e2e/run.mjs` exits 2 before starting anything unless `CI=true` (GitHub sets it)
  or `E2E_ALLOW_LOCAL=1`. The message names `pnpm e2e:remote`. `E2E_ALLOW_LOCAL=1` is for a person
  watching one spec in a browser and for the live specs (`E2E_LIVE=1`), which need a logged-in CLI and
  so can only run here. Agents never set it. The runner's own test (`e2e/harness.test.mjs`) sets it
  for its probe specs, and checks the refusal.
- **One workflow for both callers.** `.github/workflows/e2e.yml` takes `specs` (prefixes, as
  `pnpm e2e` takes them) and `shards` (1–4). CI calls it with the whole suite on 4 shards for every
  pull request that needs it (`workflow_call`), and `pnpm e2e:remote` dispatches it on a branch
  (`workflow_dispatch`). A newer dispatch on the same branch cancels the older one. The inputs reach
  the shell through the environment and only spec-name characters pass. Each shard writes its whole
  output to `e2e-shots/e2e.log`, uploaded with the screenshots when it fails.
- **`pnpm e2e:remote`** (`e2e/remote.mjs`, tested in `e2e/remote.test.mjs`):
  - refuses a detached head, `main`, a commit not on `origin`, a spec prefix that names no spec (so a
    typo cannot pass as an empty green run), and a `gh` that is not signed in;
  - picks 4 shards for the whole suite and one per two spec files otherwise, or `--shards N`;
  - waits in the foreground at most `E2E_REMOTE_WAIT` seconds (540), because an agent's command may
    take 10 minutes at most and must not be polled from the background, then exits 3 with the
    `--wait <run id>` line to go on with;
  - on a failure downloads every failed shard's log and screenshots to
    `$TMPDIR/claudio-e2e-remote-<run id>/` and prints the end of each log;
  - exits 0 passed, 1 failed or cancelled, 2 refused, 3 still running.
- **The rule everywhere it was stated.** `CLAUDE.md`, `CONTRIBUTING.md`, the pull request template,
  the `developer` and `qa` agents, the `night-shift-ui-check` skill and
  [development.md](../development.md) now say to push and use `pnpm e2e:remote`. The new repo skill
  `e2e-on-github` (`.claude/skills/e2e-on-github/SKILL.md`) is what an agent loads to do it.

## Balanced shards (2026-10-17, #30)

The first CI run through `e2e.yml` showed one shard at 16 minutes while the other three took 6 to 7:
every spec that asks for the fake CLI was one group, so the split put all 35 of them (about 900 of
the suite's 1,970 seconds) in one shard, to restart the server with the fake CLI only once. Now every
spec is placed on its own (`groupSpecs` in `e2e/shards.mjs`). Each shard runs its own fakeCli specs
last, behind one restart of its own server, which costs seconds. `e2e/timings.json` was re-measured from
that run's four shards (85 of the 86 specs; `chat.spec.mjs` is live-only and weighs the median). The
split now estimates about 500 seconds per shard, so a pull request's e2e takes about 10 minutes
instead of 16.

## What it costs

- **Iterating on one spec is slower.** A push and one to two minutes on GitHub for a spec or two (40 seconds for `config` in the first try), most of it setup, against
  one or two minutes here. Running only the specs a change touches keeps it close.
- **Work in progress is pushed to a public repository.** The suite uses the fake CLI and needs no
  secret, so nothing private goes with it, but unfinished branches are visible.
- **No GitHub, no e2e.** During an outage only `E2E_ALLOW_LOCAL=1` is left, and only for a person.
- **Concurrency is GitHub's.** A whole-suite run takes five jobs (plan and four shards). Several
  agents dispatching at once queue on GitHub instead of on this machine.

## What it does not change

- Unit tests, the type check and the build still run here; they are light enough.
- Claudio's own orchestration prompts stay generic: the `e2e-specs` task is told to find how a
  project runs its browser specs (`packages/core/src/verification.ts`), and in this repository it
  finds `pnpm e2e:remote` in `CONTRIBUTING.md` and in the runner's refusal.
- `pnpm media` still records here: it boots one sandbox and one Chrome, on demand, by a person.
- The rest of the isolation study (agents and their tests in a sandbox of their own) is still worth
  doing, with less urgency.

## Related

[[development.md]] · [[resource-control.md]] · [[plans/ci-e2e-shards.md]] · [[plans/verify-faster.md]] · [[plans/e2e-harness-waits.md]] · [[plans/e2e-flakes-under-load.md]]
