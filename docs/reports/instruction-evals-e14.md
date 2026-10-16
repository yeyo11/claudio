# instruction-evals e14: security review (Phase 1)

Reviewed against the plan's "Security and privacy" section, item by item, on the diff of e0–e11.
Two findings were confirmed and fixed in this task; no confirmed finding is open.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F-1 | high | `runCommand` (`packages/core/src/verification.ts`) spawned eval `setup` and `command` checks with the daemon's whole `process.env`, so `CLAUDIO_AUTH_TOKEN`, `CLAUDIO_DESKTOP_TOKEN` and the like reached code the variant under test had just written in the lane, while a sample itself gets no token (`api: false`). Also, the commands were not marked `CLAUDIO_AGENT_RUN`. | Fixed: `EvalRunner.command` passes the run id and an environment without `CLAUDIO_AUTH_*`, `CLAUDIO_DESKTOP_TOKEN`, `CLAUDIO_API_*`, `CLAUDIO_CHAT_ID`, `CLAUDIO_OIDC_*` (`runner.ts`, `commandEnv`; new optional `base` parameter of `runCommand`). |
| F-2 | medium | `writeOverlay` (`lanes.ts`) checked the overlay path lexically only. A symlink committed at the pin (a directory or the target file itself) made `writeFileSync` write the proposed text outside the lane, for example into the person's `~/.claude`, which item 7 forbids. The absent-variant `rmSync` had the same hole. | Fixed: `assertInsideLane` resolves the nearest existing ancestor and refuses a path that leaves the lane; a link at the target is replaced, never written through. Test: `eval-lanes.test.ts`, "never writes an overlay through a link". |
| F-3 | low | Failure `reason` strings for `lane-failed` are stored from git's message without `maskSecrets` on the lane path (`runner.ts`, `runSample`). They are cut and carry no input. Not changed. | Open, accepted |
| F-4 | low | Prompts of a file Claudio itself wrote (`wroteSha`) need no consent when it has no commands; this matches decision 16 and the plan's grant rules. | Accepted |

## Items

1. **The one rule.** Holds. Samples start through `runtime.start` with `keepAlive: false`, `internal: true` (`runner.ts` `startChat`); the only other process is `runCommand` and git. No SDK or HTTP call. The README row exists (e8).
2. **Nothing starts on its own.** Holds. `evals.start` / `resume` are called only from the two routes `apps/api/src/routes/evals.ts:127,172`; `CHAT_FORBIDDEN_EVALS` (`apps/api/src/security.ts:314`) gives a chat token 403 on PUT, DELETE, consent, start, resume and run delete; no MCP tool mentions evals (`packages/mcp/src`).
3. **Spending.** Holds. `maxBudgetUsd: run.cap` per sample, `ceilingUsd` with margin, `cost-not-confirmed` on start (`runner.ts` start) and on resume; waits at limits re-queue without spending.
4. **Untrusted eval files.** Holds. `EvalConsents` is keyed by SHA (`definition.ts:533`), checked at start, resume and again per sample (`consent-revoked`). The dialog showing the text verbatim is e11's; I read the code but did not run the screen.
5. **Untrusted repository code.** Holds after F-1. Commands run in the lane through `runCommand` with a time limit and their own process group; every git call in `packages/core/src/evals/` uses `evalGit` or `GIT_QUIET` (hooks and fsmonitor off), including `service.ts:54`.
6. **Secrets.** Holds after F-1. `api: false`, `uploads: false` (`runner.ts` `startChat`); stored inputs, results, check output and result text go through `maskSecrets` and `cutToBytes`; the consent file is written 0600 (`definition.ts:554`), the agents files 0600 in a 0700 dir (`agents-file.ts`), the lanes root 0700 (`lanes.ts:31`). See F-3.
7. **Isolation of variants.** Holds after F-2. A proposal reaches only the lane (overlay) and the `--agents` file under `<dataDir>/eval-agents`; user-scope proposals are refused (`user-scope-variant`); `ensureLanesRoot` refuses an ancestor with `CLAUDE.md` or `.claude`.
8. **No pushes.** Holds. `DEFAULT_EVAL_POLICY.gitPush = 'deny'`; lanes are `--detach`. A member target runs under the flow's own policy, which also denies pushes by default.
9. **Prompt injection.** Holds for Phase 1. Tool output is only stored and displayed; checks compare, nothing acts on it. The judge and case drafting are Phase 2 (f10).
10. **Cleanup.** Holds. `removeRunLanes` at the end of every run, `startLaneSweep` at start and hourly; tests use `mkdtempSync(join(tmpdir(), …))`.
11. **Exports.** Holds. The export reads stored (masked) rows; the file name is built from a UUID; markdown cells and fences are escaped; the route is in `QUERY_TOKEN` and no other eval GET is.

## Checks

`pnpm typecheck` clean. `eval-lanes`, `instruction-runner` and `verification` tests pass (82). No e2e run.
