---
name: run-e2e
description: Run Claudio's browser (e2e) specs through Sluice's `e2e` gate on this machine, or on GitHub Actions with `pnpm e2e:remote`, and read a failure from its log and screenshots. Use whenever a change needs an e2e spec run, a spec was written or changed, or a check asks for `pnpm e2e`.
---

# Running the e2e specs

On this machine the e2e suite runs only as a Sluice job: `pnpm e2e` refuses to start outside one
(and outside CI). Every run boots a server and a headless Chrome per shard, and a few agents doing
that at once, outside any queue, once froze the host. Sluice's queue admits the `e2e` gate only when
the machine's budget has room for it, and caches a pass per git tree. GitHub stays available for the
whole suite on four clean machines. The decision is in `docs/decisions/e2e-through-sluice.md`.

## Through Sluice (the default)

1. **Commit nothing special.** The gate tests your working tree's git tree, as every Sluice gate does;
   it runs `pnpm build` first, so the UI it tests is always this tree's.
2. **Run only what your change touches** while you iterate: the specs for the screens, routes or
   files you changed, named by prefix exactly as `pnpm e2e` takes them. Call the `verify` MCP tool:

   ```
   verify  working_directory=<absolute path>  gates=["e2e"]  extra_args=["config", "palette"]
   ```

   With no `extra_args` it runs the whole suite on two shards (about 20 minutes plus the build, and
   longer when the queue is busy). A pull request runs the whole suite on GitHub anyway, so run it
   yourself only when the change is broad.
3. **Read the result.** `verify` prints pass or FAIL and, on a failure, the end of the log. For the
   whole log use the `logs` tool with the job id. Failure screenshots are in `e2e-shots/` at the
   repository root. Read the log before changing anything, and open the screenshots of the failing
   spec. Do not re-run to diagnose: a tree that passed is answered from the cache, and one that
   failed fails the same way.
4. **Fix and verify the same prefixes again.**

## On GitHub (the whole suite fast, or a second opinion)

1. Commit and push your branch: GitHub tests the pushed commit, not your working tree.
2. `timeout 590 pnpm e2e:remote config palette` (no prefix for the whole suite, about 10 minutes on
   4 shards). It waits up to 9 minutes (`E2E_REMOTE_WAIT`), then exits 3 and prints the line to go
   on with: `timeout 590 pnpm e2e:remote --wait <run id>`. Never send it to the background to poll
   with `sleep`.
3. Exit codes: `0` passed; `1` failed or cancelled (the failed shards' `e2e.log` and screenshots are
   downloaded to `$TMPDIR/claudio-e2e-remote-<run id>/`); `2` refused before starting (not pushed, on
   `main`, an unknown spec prefix, `gh` not signed in); `3` still running.
4. A newer dispatch on the same branch cancels the older one. `--shards N` (1–4) overrides the shard
   count.

## Rules

- Never run `pnpm e2e` or `node e2e/run.mjs` in the shell, and never set `E2E_ALLOW_LOCAL=1` or
  `SLUICE_JOB` yourself: the first is the owner's way to watch one spec in a browser, the second
  would run the suite outside the queue that keeps the machine responsive.
- Never wrap the gate in `sluice exec` or a script: the `e2e` gate carries the build, the shard count
  and the weight the queue needs.
- A spec that fails, fails. Do not call it flaky without running it again alone and comparing with
  `main`; if it is flaky, find the cause (`docs/plans/e2e-harness-waits.md`).
- Name the specs you ran and how each ended in your report (the Sluice job id, or the GitHub run's
  URL).
