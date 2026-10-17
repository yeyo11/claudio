---
name: e2e-on-github
description: Run Claudio's browser (e2e) specs on GitHub Actions with `pnpm e2e:remote`, never on this machine, and read a failure from its downloaded log and screenshots. Use whenever a change needs an e2e spec run, a spec was written or changed, or a check asks for `pnpm e2e`.
---

# Running the e2e specs on GitHub

The e2e suite does not run on this machine: `pnpm e2e` refuses outside CI. Every run boots a server
and a headless Chrome per shard as if it had the machine to itself, and a few agents doing that at
once froze the host. GitHub runs it on clean machines, four shards side by side, for free on this
public repository. The decision is in `docs/decisions/e2e-on-github.md`.

## Steps

1. **Commit and push your branch.** GitHub tests the pushed commit, not your working tree. A branch
   cut before `.github/workflows/e2e.yml` existed has to be rebased on `main` first.
2. **Run only what your change touches** while you iterate: the specs for the screens, routes or
   files you changed, named by prefix exactly as `pnpm e2e` takes them.

   ```bash
   timeout 590 pnpm e2e:remote config palette
   ```

   A few specs take about 3–4 minutes, most of it setup. The whole suite (`pnpm e2e:remote` with no
   prefix) takes about 7 minutes of wall time on 4 shards; a pull request runs it anyway, so run it
   yourself only when the change is broad.
3. **Wait in the foreground.** The command waits up to 9 minutes (`E2E_REMOTE_WAIT`, seconds), then
   exits 3 and prints the line to go on with. Run that line, again under `timeout 590`:

   ```bash
   timeout 590 pnpm e2e:remote --wait <run id>
   ```

   Never send it to the background to poll with `sleep`.
4. **Read the result by its exit code.**
   - `0`: passed.
   - `1`: failed or cancelled. The failed shards' `e2e.log` and screenshots are downloaded to
     `$TMPDIR/claudio-e2e-remote-<run id>/`, and the end of each log is printed. Read the log before
     changing anything, and open the screenshots of the failing spec.
   - `2`: refused before starting (not pushed, on `main`, an unknown spec prefix, `gh` not signed in).
     The message says what to do.
   - `3`: still running; go on with `--wait`.
5. **Fix, commit, push, run the same prefixes again.** A newer dispatch on the same branch cancels
   the older one, so do not wait for a run you have made stale.

## Rules

- Never run `pnpm e2e` here, and never set `E2E_ALLOW_LOCAL=1`: that is the owner's way to watch
  one spec in a browser, not an agent's.
- A spec that fails on GitHub fails. Do not call it flaky without running it again on GitHub and
  comparing with a run of `main`; if it is flaky, find the cause (`docs/plans/e2e-harness-waits.md`).
- Name the specs you ran and how each ended in your report, with the run's URL.
- `--shards N` (1–4) overrides the shard count; the default is 4 for the whole suite and one per two
  spec files otherwise.
