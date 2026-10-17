---
created_at: 2026-10-16T14:00:00Z
updated_at: 2026-10-16T18:00:00Z
tags:
    - evals
    - team
    - agents
    - instructions
    - worktrees
    - verification
---
# Instruction evals

You edit an agent file, a skill, a rule or `CLAUDE.md`, and you want to know whether agents now
follow it. An *eval* answers that. It is a small JSON file in the project with a few *cases*. Each
case is a prompt plus deterministic *expectations* about what the agent does: which tools it calls,
in what order, with which commands or paths, and what the repository looks like afterwards.

This page describes Phases 1 and 2 as built (2026-10-16). The design, the rejected options and the
task graph are in [plans/instruction-evals.md](plans/instruction-evals.md). Phase 2 (pressure levels,
pass@k and pass^k, a model judge, a promotion gate, case drafting) is behind its own settings switch:
see [Phase 2](#phase-2). The idea is from ECC, studied in [reports/ecc.md](reports/ecc.md); no
ECC code is copied.

## What a person does

1. Open **Team → Evals** on a project that has the Team module on (`?view=team&section=evals`).
2. Write an eval: a target (project-scope agent, skill, rule, or `CLAUDE.md` / `CLAUDE.local.md`),
   a pinned commit, cases and expectations. Save writes
   `<project>/.claude/claudio-evals/<name>.json`, which can be committed. Until it is, the list says
   "Not committed". Claudio never edits the repository's git config.
3. Press **Run eval**. The start dialog picks the variants, shows the cost ceiling and, the first
   time for a given file content, the prompts and commands that will run.
4. Read the run: a matrix of cases by variant, each cell an attempt, and a comparison column
   (regressed, improved, same). Open a sample to see its tool calls and checks.

From a team member page, **Evaluate this change** hands the unsaved agent text to the start dialog as
the *proposed* variant. It is kept in `sessionStorage` under
`claudio.evals.proposed.<projectId>.<agent>` (at most 256 KiB) and cleared when a run starts.

Nothing starts on its own. Only a person's click starts a run: no schedule, no flow hook, no
decision point and no MCP tool. The start request repeats the ceiling (`confirmMaxCostUsd`), so a
client cannot start a run whose cost the person never saw.

## The variants

- `pinned`: the file as committed at the pin.
- `current`: the file in the checkout now, saved or not.
- `proposed`: text sent with the start request.

`current` and `proposed` are overlaid onto the sample's worktree only, never onto the checkout. For
an agent target the same text also becomes the `--agents` definition, as the flow does. A user-scope
target can only be run as it is; a proposal for one is refused (`user-scope-proposal`), because a
proposal must never be written to the person's config dir.

## How a sample runs

A sample is a housekeeping chat of `ChatManager` (`internal: true`, `keepAlive: false`,
`api: false`, `uploads: false`), started through the runtime exactly as the decision engine's `cli`
provider does ([decision-engine.md](decision-engine.md)). There is no CLI surface of its own, so
account choice, the concurrency limit, `--max-budget-usd` and process cleanup come from the existing
chat code. Claudio folds the tool calls out of the stream and checks them in plain code
(`packages/core/src/evals/`: `definition.ts`, `matchers.ts`, `score.ts`, `runner.ts`, `lanes.ts`,
`store.ts`, `service.ts`, `export.ts`).

- **Tool policy.** An agent target that is a team member runs under the flow's stage policy and
  permission mode, so the eval measures the member as the flow runs it. Any other target runs under
  the eval's own policy: read and edit anything, any command, no network, no `git push`, in
  `dontAsk`.
- **The journal is not appended**, so the target is the only thing that differs between variants.
- **Lanes.** Each sample runs in a detached, locked worktree on the pinned commit, under
  `CLAUDIO_EVALS_DIR` or `<dataDir>/eval-lanes/`, never under the repository (Claude Code reads
  `CLAUDE.md` from parent directories, so the checkout's own would leak in). Lanes are reset between
  samples, removed when the run ends, and swept at start and hourly. A lanes root with a `CLAUDE.md`
  or `.claude/` in an ancestor is refused with `lanes-root-contaminated`.
- **Git hooks are off** for every git command an eval runs (`core.hooksPath=/dev/null`,
  `core.fsmonitor=false`).
- **At a usage limit a sample is not scored.** It is run again from scratch after the reset, never
  replayed: a housekeeping chat keeps no transcript to resume, and a replay would mix two accounts.
- **One live run per project**, enforced by a partial unique index.

## Expectations

Deterministic in Phase 1 (the `judged` kind is Phase 2's): `called` (with `min` / `max`), `not-called`, `before`, `after`,
`sequence`, `text` (the final answer), `file` (existence and content, read by Claudio), `touched`
(over `git status`) and `command` (run in the lane, needs consent). Matchers take a tool glob, a
command, a path, input fields, an outcome and a scope (`main` or `sub`). Types are
`EvalDefinition`, `EvalCase`, `EvalExpectation` and `EvalCallMatcher` in
`packages/shared/src/types.ts`.

## Cost and consent

- The defaults are k = 2 samples per case, 0.50 USD per sample and concurrency 2. The ceiling is
  shown before every start, and a run stops at it (`capped`). Resuming a `capped` or `interrupted`
  run re-queues the unfinished samples; its new ceiling is what was spent plus the worst case of
  what is left, and the person must repeat it.
- **Consent is per file content.** Before the first run of a file, and again after it changes, the
  person accepts every prompt, the setup command and every assertion command. It is keyed by the
  file's SHA-256 and kept in `<dataDir>/eval-consents.json`. A committed eval file is repository
  content that someone else may have written, so what it runs on this machine is the person's call.

## Data

Appended at the end of `MIGRATIONS` in `packages/core/src/db.ts`: `eval_runs`, `eval_variants`,
`eval_samples`, `eval_calls` and `eval_checks`, and for Phase 2 `eval_judgements`, a `pressure`
column on samples and `gate`, `gate_detail` on runs. A run stores the definition as run, so a report
records what was measured. Calls are capped at 500 per sample, inputs at 4 KiB, results at 1 KiB,
and the final text at 8 KiB, all with secrets masked. The 100 newest ended runs are kept per eval.

## API

Every route is in the Evals tag (`apps/api/src/routes/evals.ts`) and in the [Evals](rest-api.md#evals) table of the REST API.

| Method | Route |
|---|---|
| GET | `/projects/:id/evals` |
| GET, PUT, DELETE | `/projects/:id/evals/:name` |
| POST | `/projects/:id/evals/:name/estimate` |
| POST | `/projects/:id/evals/:name/consent` |
| POST | `/projects/:id/evals/:name/runs` |
| GET | `/projects/:id/eval-runs` |
| GET, DELETE | `/eval-runs/:runId` |
| GET | `/eval-runs/:runId/samples/:sampleId` |
| GET | `/eval-runs/:runId/compare` |
| POST | `/eval-runs/:runId/cancel` |
| POST | `/eval-runs/:runId/resume` |
| GET | `/eval-runs/:runId/export` |
| GET | `/eval-runs/:runId/gate` (Phase 2) |
| POST | `/eval-runs/:runId/rejudge` (Phase 2) |
| POST | `/eval-runs/:runId/accept-judge` (Phase 2) |
| POST | `/projects/:id/evals/:name/draft-cases` (Phase 2) |

Errors carry a `code`: `team-off`, `changed-on-disk`, `eval-running`, `cost-not-confirmed`,
`consent-needed`, `not-resumable`, `variant-not-in-run`, `evals-phase2-off`, and for estimate and start `pin-missing`,
`target-missing`, `not-git`, `no-commit`, `lanes-root-contaminated`, `user-scope-proposal`.

**Auth.** A chat token may read, estimate and cancel, but is refused (403, `CHAT_FORBIDDEN_EVALS` in
`apps/api/src/security.ts`) on writing or deleting eval files, consent, start, resume, deleting
runs, re-judging, accepting a judge and drafting cases: an injection in a chat must not spend money or consent for the person. Read-only mode refuses
every write with 405. The export route accepts `?token=` for download links. The events are
`eval.run` and `eval.sample`.

## The screens

The web is in `apps/web/src/pages/team/evals/`: list, editor, start dialog (a `Sheet` on a phone),
run view, sample and history, following [design-system.md](design-system.md). Only a running run
moves: the energy border on its card, ring spinners on running samples. Status is always a word and
an icon. Copy is in `apps/web/src/i18n/locales/{en,es}/evals.json`; check `detail` text, prompts and
file contents are English records and are not translated.

## Phase 2

Everything here needs `evalsPhase2` (Settings → Security → Instruction evals, or
`CLAUDIO_EVALS_PHASE2`). Off, the routes answer 409 `evals-phase2-off`, the editor offers none of it
and a version 2 file still opens. A version 1 file keeps working unchanged: it reads as neutral-only,
and is saved as version 2 only when the person adds a version 2 field.

### Pressure levels

A case may carry `prompts: { supportive?, neutral, competing? }` instead of `prompt`.

- **supportive** reminds the agent of the rule, **neutral** is the task alone, **competing** adds a
  plausible reason to skip it ("this is urgent, keep it quick").
- Claudio never writes pressure text. The person writes it, or accepts the assistant's draft.
- Each level is its own cell. The run view has a tab per level, and a "pressure" list shows how much
  the pass rate falls from supportive to competing: how much pressure it takes to break the rule.
- `samples` goes up to 10 in a version 2 file, and `k` (default 3, at most `samples`) is the k of
  pass@k. The estimate multiplies variants by levels by samples, and the start dialog shows the
  per-level breakdown.

### Metrics

For a cell with `n` scored samples and `c` passes: pass@k = 1 − C(n−c, k) / C(n, k), pass^k = C(c, k) /
C(n, k), and a Wilson 95 % interval beside the rate (`packages/core/src/evals/metrics.ts`, mirrored
in `apps/web/src/pages/team/evals/run-model.ts`; keep them in step). A rate never appears alone: it is
shown as `c/n`, with the interval, a bar and the unjudged count. The history has a pass-rate trend,
drawn with one series, a 2 px line and the interval band, with a table view.

### Judged expectations

`{ kind: 'judged', statement, model?, examples? }` is for what a matcher cannot see. After the
deterministic checks, one housekeeping chat per expectation and sample judges it:

- `--json-schema` for `{ pass, reason (≤ 400 chars), evidence: call seqs }`, no tools, no settings
  files, no API token, `--max-budget-usd` from `limits.maxJudgeCostUsd` (default 0.05) and effort
  `low` (`packages/core/src/evals/judge.ts`). The model defaults to `sonnet`, because a judge must be
  at least as capable as what it grades.
- The input is the statement, the numbered calls and the final text, inside a `pasted()` block with
  `PASTED_NOTE`: data, never instructions. The worst a transcript can do is a wrong verdict, shown
  with its reason and evidence.
- A judge that fails (error, limit, invalid JSON, timeout) gives `unjudged`. That sample is not
  scored for its cell, and it fails closed for the gate. **Judge again** re-judges from the stored
  calls, without re-running the sample.
- **Calibration.** `examples` are judged once before the first sample. A judge that disagrees is
  shown as unreliable (warn), and the gate stays `incomplete` until the person accepts that judge
  (`POST /eval-runs/:runId/accept-judge`) or edits the statement.

### The promotion gate

For a run with both `current` and `proposed` that has ended, `GET /eval-runs/:runId/gate` gives one
verdict, shown as a card on the run view with a word and an icon:

- **promotable:** no `mustHold` case's pass^k fell, and the mean pass rate did not fall by more than
  its interval;
- **regressed:** with the cases that fell;
- **incomplete:** unjudged or unscored `mustHold` samples, fewer than 3 scored per `mustHold` cell, or
  an unreliable judge.

The gate writes nothing. **Save proposed** (agent targets in the project) opens that member's page with
the proposed text unsaved, in `sessionStorage` under `claudio.evals.save.<projectId>.<agent>`, and the
person still presses Save. A run on a pinned account says so on the card, and that does not change the
verdict.

### Draft cases

From the editor, **Draft cases** starts a project-assistant run of kind `evals`
(`POST /projects/:id/evals/:name/draft-cases`): it reads the target file and proposes up to five
`eval-case` proposals, in English, with prompts at each level and deterministic checks first. The
assistant cannot write files. **Add to eval** appends the case through the file's write with
`ifMatch`; a case that carries commands changes the SHA, so consent is asked again. **Discard** does
nothing. The route is refused for a chat token and by the daily spend cap.

## Known gaps

- An invalid file shows its problems but not its raw JSON read-only: no route serves the raw text.
- A run can be deleted through the API (`DELETE /eval-runs/:runId`) but the web has no button for it.
- Phase 2's draft cases and the gate's buttons were tested as isolated components; their Radix open
  states and mutations run only in the e2e.
- The fake CLI ignores the agent file, so `evals-phase2.spec.mjs` cannot produce a real regression; the
  gate's verdict paths are covered by core's tests.
- The CLI facts F2–F11 were not recorded: [reports/instruction-evals-e0.md](reports/instruction-evals-e0.md)
  is partial, because the account hit its usage limit.

## Tests

Core and web unit tests cover the matchers, scoring, metrics, judge, gate and the screens. The e2e
specs are `e2e/specs/evals.spec.mjs` (Phase 1) and `evals-phase2.spec.mjs` (pressure levels, a judge
scripted with `json:`, the metrics and the gate card), plus additions to `a11y-shared.mjs` and
`motion.spec.mjs`.

## Related

[[plans/instruction-evals.md]] · [[reports/instruction-evals-e0.md]] · [[reports/ecc.md]] ·
[[team-and-flow.md]] · [[decision-engine.md]] · [[prompts.md]] · [[security-model.md]] ·
[[design-system.md]] · [[status.md]]
