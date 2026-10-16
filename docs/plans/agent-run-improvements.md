---
created_at: 2026-10-15T21:00:00Z
updated_at: 2026-10-15T21:00:00Z
tags:
    - plan
    - spec
    - prompts
    - orchestration
    - flow
    - verification
    - budgets
    - observability
    - team
    - ecc
    - claudio
    - planned
---
# Plan: smaller improvements to agent runs (ECC ideas 6–10 and 12–15)

Status: **planned** (2026-10-15). Nothing here is built yet.

This plan builds nine of the smaller ideas ranked in [reports/ecc.md](../reports/ecc.md) §2, on
`feat/claude-only` (`~/Escritorio/claudio-stage-a`). Idea 11, the structured session note, is
not here: it is folded into [plans/context-control.md](context-control.md), which is written in
parallel. The nine ideas are:

| # | Idea | Kind of change | Size |
|---|---|---|---|
| 6 | Pattern grounding for the planner and the refine stage | prompt | S |
| 7 | The graph's objective and shape for every worker, and retrieval in at most three rounds | prompt | S |
| 8 | Explicit stop rules for the fixer and for `checks.fix`, and `[FIXED] path:line` rows on the verification card | prompt, harness, contract, UI | S–M |
| 9 | A risk score for each tool call, shown in the transcript and Step by step, and fed to `notification.urgency` | shared scorer, contract, UI | M |
| 10 | Four more roles shipped in project templates, with read-only tools for the review roles | data, agent files, UI | S–M |
| 12 | A delegation contract for workflow-engine leads and other unattended runs | prompt, harness | S |
| 13 | A global daily spend cap across chats and orchestrations | runtime setting, SQLite ledger, API, UI | M |
| 14 | Plateau detection for flow bounces and task retries | harness, project setting, UI copy | S |
| 15 | Path-scoped rules proposed by the project assistant and by flow members instead of growing `CLAUDE.md` | prompt, contract, migration, UI | S–M |

It ends with one task graph, for one orchestration, that builds all of them.

**Credit.** The ideas come from ECC ("Everything Claude Code") by Affaan Mustafa, MIT-licensed. Claudio
re-implements them in its own words and code; no ECC prompt, script, hook or agent file is copied.

**The one rule holds throughout.** Everything here reads what the CLI already emits (stream-json
`result.total_cost_usd`, `tool_use` blocks, the transcript, `system/task_*` events) or writes files
the CLI reads (`.claude/agents/*.md`, `.claude/rules/*.md`). Nothing calls an SDK, an Anthropic HTTP
endpoint or a terminal. None of the rejected ideas of [reports/ecc.md](../reports/ecc.md) §4 is
brought back. In particular:

- the risk score (9) adds no hook on any tool call; it reads the stream and the transcript Claudio
  already has;
- the spend cap (13) sums only the cost the CLI reports and prices nothing from tokens;
- the build-resolver role (10) runs no formatter or type check on every edit.

## Decisions (2026-10-15)

These are the architect's decisions within the owner's brief. The [open questions](#open-questions-for-the-owner)
list what only the owner can decide.

1. **Prompt texts live in `prompt-rules.ts`.** Every new instruction is a named export there, shared
   by every builder that uses it, as [prompts.md](../prompts.md) requires. The new exports are
   `PATTERN_GROUNDING`, `RETRIEVAL`, `DELEGATION`, `FIX_ONE_AT_A_TIME`, `FIX_STOP_WHEN` and
   `FIXER_REPORT_ROWS`. Each one is checked against the twelve points of [prompts.md](../prompts.md)
   below. Point 8 ("nothing discourages tool use") is the one at risk, from the retrieval rounds of
   idea 7, and the text is worded so it does not discourage tool use.
2. **The delegation contract (12) goes beyond workflow leads.** It is also given to orchestration
   workers, the flow's work stage and the fixer. The failure it prevents, a turn that ends while
   background agents still run and so loses their work, happens in any unattended run. The harness
   also checks it from facts: the chat's own list of running background agents and tasks.
3. **Harness rules are code; prompt rules ask.** Ideas 8 and 14 each get a prompt half and a
   deterministic half. The deterministic half never depends on the model's wording. It works from:
   - a normalised failure signature;
   - an error count from known tool formats;
   - the criteria QA returns.

   Like `maxAttempts` and `maxBounces`, it only ever ends a loop sooner, never later.
4. **The risk score never blocks.** It is a pure function in `@claudio/shared`, so the server
   (urgency input, Step by step) and the transcript in `@claudio/chat-ui` score a call the same way,
   as `notifications.ts` already does for notifications. Blocking stays the job of the guard hooks
   (★3 of the report).
5. **The spend cap is a start gate, not a kill switch.** Over the cap:
   - new automated units of work wait;
   - a person's new turn asks first;
   - nothing running is stopped.

   A unit of work is a flow run, an orchestration task, a schedule fire, a supervisor call, a
   decision asked through the CLI, or an assistant run. The phases of a graph whose tasks have all
   started (integration, verification and its fixer, synthesis) go on, because stopping between
   them would leave a half-merged branch. Overshoot is bounded by each run's own limits
   (`flow.maxCostUsd`, task `limits.maxCostUsd`, the fixer's `maxCostUsd`).
6. **Spend is a ledger of rows, not a sum over chat documents.** A new SQLite table,
   `spend_ledger`, gets one row per `result` that reported a cost. The row holds the increase of the
   CLI's cumulative `total_cost_usd` for that process. Two processes share one data dir, a turn's
   cost must land on the day it was spent, and the [Usage](../../README.md) report attributes a whole
   execution to the day it ended, which is too coarse for a daily cap. The Usage report itself is
   not changed.
7. **The cap counts every cost the CLI reports, for every account kind**, by default:
   - for API-key accounts it is money;
   - for subscription accounts (`login`, `token`) it is the API price of the same use, the only
     figure the CLI gives.

   The UI says which is which. Counting only API-key accounts is
   [open question 1](#open-questions-for-the-owner).
8. **The day is the server's local day**, the same one `localDay` (`usage.ts:47`) gives the Usage
   page, so both pages show the same figures. Midnight is computed from local date parts, never as
   `+24 h`, so DST days are 23 or 25 hours long, as they really are.
9. **Plateau stopping is on by default in the flow** (`flow.stopOnPlateau`, absent reads as `true`).
   It only makes a card wait for a person sooner, which spends less; a project can switch it off.
   Before shipping, a backtest over the existing `flow_runs` measures how often it would have stopped
   a round that later passed (see [How to measure](#how-to-measure-14)).
10. **New roles are offered, not imposed.** `ProjectTemplate.optionalTeam` holds them. "Add the
    template's team" with no `roles` adds exactly what it adds today. The person or the assistant
    picks optional roles by name.
11. **A path-scoped rule is a file the CLI reads**: `.claude/rules/<name>.md` with a `paths:` list in
    its front matter, which Claude Code documents as a project memory file. Claudio already edits
    `rules` resources (`config/resources.ts:10`). A proposed rule must name `paths`; guidance that
    holds everywhere stays an `instructions` proposal for `CLAUDE.md`.
12. **Contract first, in one task.** Every shared type change, both migrations and the regenerated
    OpenAPI schemas are made by task `s0`, so the parallel tasks do not each regenerate
    `schemas.json` and conflict on it. `s0` also builds the risk scorer, so it is not a task that only
    writes types (rule 2 of [orchestrations.md](../orchestrations.md)).

## Goals

- Planner task prompts and refined work items cite real patterns as `path:line`, so workers copy
  conventions instead of inventing them.
- Workers know the whole graph's objective and their siblings' tasks, and search in bounded rounds.
- No unattended run ends its turn with work it delegated still running.
- Fixers stop when more attempts will not help, say why in a fixed form, and their fixes show as
  `path:line` rows on the verification card and the fix panel.
- A person sees which tool calls are risky, in the transcript, in permission prompts and in Step by
  step, and the urgency of a notification can take that risk into account.
- Projects get four tested roles, two of them read-only reviewers.
- One number caps what all of Claudio's automation spends in a day.
- Bounce and retry loops that stopped improving end early and wait for a person.
- `CLAUDE.md` stops growing with guidance that concerns only part of a project.

## Non-goals

- Blocking a tool call on its risk score (★3, guard hooks).
- A review gate (★1), lessons (★2), context control and the session note (★4 and idea 11), evals
  (★5).
- Hard-stopping running work at the spend cap, or estimating a cost the CLI did not report.
- Changing the Usage report's attribution, or making the cap per project or per account (see
  [open question 2](#open-questions-for-the-owner) for per-card overrides).
- Reading MCP tool annotations (`readOnlyHint`, `destructiveHint`). The CLI does not hand them to
  Claudio today; the scorer works from tool names.
- Auto-reverting a fixer's commits. The fixer is told to undo a fix that made things worse with a new
  commit; Claudio never rewrites history by itself.

## Shared ground for every idea

- **Language.**
  - Prompts, schemas, agent files, rule files, ledger purposes and every record an agent writes are
    English.
  - UI copy goes through i18n with en/es parity, following `apps/web/src/i18n/GLOSSARY.md`: Spanish
    from Spain, infinitive buttons, sentence case.
  - New glossary rows:
    - Daily spend cap → *Tope de gasto diario*;
    - Spend today → *Gasto de hoy*;
    - Risk (of a tool call) → *Riesgo*;
    - Irreversible → *Irreversible*;
    - Leaves this machine → *Sale de esta máquina*;
    - Rewrites history → *Reescribe el historial*;
    - Outside the working directory → *Fuera del directorio de trabajo*;
    - Plateau (no improvement) → *Sin mejora*;
    - Path-scoped rule → *Regla por rutas*.
- **Persistence.**
  - Settings-shaped values go in JSON: `app-settings.json` for the cap, the project settings document
    for `flow.stopOnPlateau`, the orchestration document for the spend pass.
  - Accumulating records are SQLite rows: `spend_ledger`, `spend_alerts`, `flow_runs.checks` and
    `memory_proposals.target_paths`.
  - Migrations are appended at the **end** of `MIGRATIONS` in `packages/core/src/db.ts`. Today the last
    entry is `ALTER TABLE provider_limits ADD COLUMN overage TEXT;` at `db.ts:806`.
- **Contract.** Every change visible over HTTP starts in `packages/shared/src/types.ts`, then
  `pnpm --filter @claudio/api openapi:schemas`. New routes get a summary and a tag in
  `apps/api/src/openapi/routes.ts` and a row in the README's REST tables.
- **Chat tokens.** A chat's own token (`CLAUDIO_API_TOKEN`) may read the new state. It may not:
  - raise or clear the cap;
  - grant a spend pass;
  - override the cap on a request.

  The new denials join the `CHAT_FORBIDDEN*` sets in `apps/api/src/security.ts:162`.
- **UI.**
  - Night Shift tokens only, dark first and both themes.
  - Controls come from `packages/ui/src/components/controls`.
  - Status colours keep one meaning each and always come with a word or an icon.
  - Usage bars are neutral below 60 %, warn from 60 % and bad from 75 % or when exhausted.
  - Nothing new moves: a wait does not move, and a risk tag is static.
  - On a phone, targets are ≥ 44 px and "⋯" menus open as a `Sheet`.
  - New variants go into `docs/design-system.md` and `docs/design-system/claudio-ds.css` in the
    same pull request.

---

## Idea 6 · Pattern grounding for the planner and the refine stage

### Current state

- `PLANNER_GRAPH_GUIDANCE` (`packages/core/src/orchestrator.ts:302`) asks for six things. The last
  is "Every task prompt names the files, modules or routes it will touch". It asks for no example of
  a convention.
- The planner prompt embeds the guidance at `orchestrator.ts:2184`, and it is told to read the
  directory first.
- `flowPrompt` (`packages/core/src/flow.ts:700`) refines in two branches:
  - `backlog` (`flow.ts:718`): complete the description and the criteria;
  - `todo` (`flow.ts:726`): check readiness.

  Both carry `EXPLORE` (`flow.ts:800`): read the documents and the code the item concerns. Neither
  asks for a pattern with its location.
- [orchestrations.md](../orchestrations.md) keeps the same planner rules for people, as rules 1–6.
  Rule 6 is "Name the files and routes in each task prompt".

### Change

A new export in `packages/core/src/prompt-rules.ts`:

```ts
/**
 * Conventions are shown by example rather than described: one real place per convention, read in
 * this run, or the word that the code has none. A worker or a developer copies what it is shown.
 */
export const PATTERN_GROUNDING =
  'Ground the work in the patterns this code already has. For each convention it depends on (naming, error handling, data access, tests, and any other the work touches), cite one real place that shows it, as `path:line` of a file you opened in this run, or say that the code has none and the work sets it. Never cite a place you have not read.';
```

1. **Planner.** One sentence is appended to `PLANNER_GRAPH_GUIDANCE`, after the "names the files"
   sentence:

   > Every task prompt that adds or changes code also names, for each convention its worker must
   > follow (naming, error handling, data access, tests), one real example as `path:line` that you
   > read, or says that the code has none, so the worker copies a pattern instead of inventing one.

2. **Refine in `backlog`.** In `flow.ts`, right after `EXPLORE`, push `PATTERN_GROUNDING` and then:

   > Put the citations in the description, under a `## Patterns to follow` heading.

3. **Refine in `todo`.** After `EXPLORE`, push:

   > Check that the description names the patterns to follow. If it has no `## Patterns to follow`
   > section, return the description with one added.

   followed by `PATTERN_GROUNDING`.

4. **Docs.** [orchestrations.md](../orchestrations.md) gains rule 7, "Cite one pattern per convention",
   with the reason. [prompts.md](../prompts.md) lists `PATTERN_GROUNDING` in the shared-texts table,
   and updates point 9 for the planner and for flow refine.

Against the twelve points:

- 1–2: it asks for no written reasoning and no stages.
- 4: the citations are the run's own words, not pasted text.
- 8: it asks for more reading, never less.
- 9: it strengthens "explore before acting".

### Data, API, UI

None. The work item's description is Markdown already, and `## Patterns to follow` renders with
the existing Markdown component.

### Edge cases

- **A new project with no code.** The text allows "the code has none and the work sets it". The
  planner and the Product Owner say so instead of inventing a citation.
- **A citation of a file the run did not open.** "Never cite a place you have not read" asks against
  it, and the measurement below counts citations that do not resolve.
- **Line numbers drift** as the code changes between refine and work. The citation is a pointer for
  reading, not a contract. The worker opens the file and finds the pattern by name.
- **Non-code items** (research, documents, the `research` template). There are no code conventions
  to cite. The text says "any other the work touches", which covers a document template or a style
  guide, and "none" is a valid answer.
- **Very large items.** The rule asks for one citation per convention, not one per file, so the
  section stays short.
- **A refined description written by a person.** In `todo` the run adds the section only when it is
  missing. `refineItem` (`flow.ts`) already keeps a person's edits made during the run.
- **A Spanish item.** The section heading and the citations are English (`RECORDS_IN_ENGLISH`), and
  the person's own text stays as written.

### Tests

- `packages/core/test/prompt-rules.test.ts`:
  - `PATTERN_GROUNDING` holds the four convention words and `path:line`;
  - the banned-phrasing search still passes.
- `packages/core/test/flow.test.ts`:
  - both refine branches carry `PATTERN_GROUNDING` and their `## Patterns to follow` sentence;
  - work and verify do not carry it.
- `packages/core/test/orchestrator.test.ts`: the planner prompt holds the new guidance sentence.

### How to measure

Over the two weeks before and after, read:

- the planner's drafts (`orchestrations.json` task prompts);
- refined descriptions (`work_items.description` changed by `flow.refined`).

From them, count:

- the share of task prompts and descriptions with at least one `path:line` citation;
- the share of citations whose path exists and whose line is within the file at the commit the run
  saw;
- the worker's turns before its first `Edit`/`Write`, from the transcripts (fewer is better).

A one-off script under `scripts/` does it. It is not part of the product.

---

## Idea 7 · The graph's objective and shape for every worker, and bounded retrieval

### Current state

- `workerHead` (`orchestrator.ts:925`) already passes the objective, wrapped with `pasted()`, when
  the graph has one. A graph written by hand with no objective gets nothing, and no worker learns
  what the other tasks do.
- `buildPrompt` (`orchestrator.ts:944`) adds the results of the tasks it depends on (up to
  `MAX_DEP_CONTEXT`). `workerTask` (`orchestrator.ts:929`) adds:
  - `workerChecks`;
  - `REAL_VERIFICATION`;
  - `frontend`;
  - `scopeAndCompletion()`;
  - `UNATTENDED`;
  - `PASTED_NOTE`;
  - `WORKER_CLOSING`.
- The workflow engine reuses `workerHead` as each task's `before` text (`compile`,
  `orchestrator.ts:2551`), so whatever the head says reaches both engines.
- `prompt-rules.ts` has no retrieval rule. [prompts.md](../prompts.md) point 8 forbids anything that
  discourages tool use.

### Change

1. **`workerHead(orch, task)`** takes the task. `compile` and `buildPrompt` pass it. It returns:

   ```
   You are one worker in a multi-agent orchestration.
   Overall objective, as the person wrote it:
   <pasted objective>            ← only when the graph has one; else "The graph is named <pasted name>."
   The graph has N tasks; yours is `<id>`. The others, so you neither redo nor undo their work:
   <pasted>
   - `a` <name> (depends on: b, c)
   - …
   </pasted>
   ```

   - At most 30 other tasks are listed, in graph order, each name clipped to 80 characters, then
     "and N more".
   - Names are person-supplied, so the list is one `pasted()` block.
   - The `e2e-specs` built-in task is listed by its name like the others.

2. **A new export, `RETRIEVAL`**, in `prompt-rules.ts`, pushed in `workerTask` right after
   `REAL_VERIFICATION`:

   ```ts
   /**
    * Context a worker was not given is found in rounds aimed at the objective; the third round is
    * where a search that keeps widening stops paying for itself. It bounds searching for what is
    * missing, never reading what the task names.
    */
   export const RETRIEVAL =
     'When you need context you were not given, search with the objective above in mind, in rounds: search, read what looks relevant, and judge what is still missing before the next search. Three rounds are enough for most gaps; after the third, work with what you have and name in your report what you could not find. When you hand a search to a subagent, give it the objective as well as the question, so it can judge what is relevant.';
   ```

Point 8 check:

- it bounds rounds of *searching for missing context*, not reading;
- the files a task names are read regardless;
- it never says to avoid a tool or to read less.

The [prompts.md](../prompts.md) Worker section records this reading of point 8.

### Data, API, UI

None.

### Edge cases

- **A graph of one task.** "The graph has 1 task; yours is `x`." and no list.
- **A very large graph** (100+ tasks). The list is capped at 30 lines plus "and N more", so the head
  stays under about 3 KiB.
- **Task names with markup or tags.** They are inside one `pasted()` block with a random id, so they
  cannot close it.
- **A relaunch or template launch with a new objective.** The head is built when each worker starts,
  so it reads the current objective.
- **The workflow engine.** `compileWorkflow` fixes the paste id per task when the script is
  generated, because the sandbox has no randomness. That holds for the new list as well.
- **The fixer and the integrator** do not use `workerHead`, and they already get the objective.
  `RETRIEVAL` is not added to them: they work on a known failure or a known conflict.
- **Continuations** do not repeat the head. They resume the same chat.

### Tests

- `orchestrator.test.ts`:
  - over the fake CLI, a worker prompt lists the sibling tasks and its own id;
  - a graph without an objective names the graph;
  - 31+ tasks are capped;
  - the list is one pasted block;
  - `RETRIEVAL` is present.
- `packages/core/test/workflow-engine` tests (wherever `compileWorkflow` is pinned): each task's
  `before` holds its own id.
- `prompt-rules.test.ts`: `RETRIEVAL` is in the banned-phrasing search, and it contains none of
  "avoid", "minimi", "fewer tool" or "do not read".

### How to measure

Over comparable graphs:

- the median number of `Read`/`Grep`/`Glob` calls before a worker's first edit;
- task cost (`OrchestrationTaskState.costUsd`);
- the share of tasks whose branch touched a file another task of the same graph also touched (a
  proxy for overlap).

---

## Idea 8 · Stop rules for the fixer and for `checks.fix`

### Current state

- **Orchestration fixer.**
  - `fixerPrompt` (`packages/core/src/verification.ts:341`) has a rules block at
    `verification.ts:358`: timeouts, one spec at a time, never loosen a test, smallest change,
    commit, "if you cannot fix it … say so and change nothing".
  - The loop in `orchestrator.ts` (around `:1882`–`:1935`) stops on three things: attempts per check
    (`spec.maxAttempts`, default `DEFAULT_FIXER_ATTEMPTS = 2`, at most 10, `verification.ts:11`), the
    fixer's `maxCostUsd`, and the `orchestration.fixer` decision point (`fixerGivenUp`).
  - Nothing detects that an attempt left the same failure, or more errors than before.
  - `VerificationFix` (`packages/shared/src/types.ts:3575`) records the run, command, attempt, times,
    cost and effort. It records no locations.
- **Flow `checks.fix`.**
  - `checksFixPrompt` (`flow.ts:634`) asks the Developer to classify and fix failing CI checks, and
    to report `checks[{ name, cause, fixed }]` (schema at `flow.ts:411`).
  - `parseResult` reads them into `FlowCheckVerdict` (`flow.ts:338`, `:2289`), but nothing stores
    them.
  - `ChecksFix.hasRoom` (`packages/core/src/decisions/checks-fix.ts:91`) limits fixes per head
    (`checksFixAttempts`, default 2, at most 5), parallel runs and a budget cause.

### Change: the prompt half

Three new exports in `prompt-rules.ts`, shared by `fixerPrompt`, `checksFixPrompt` and the
build-resolver role of idea 10:

```ts
/** One error at a time: the fixes that went wrong unsupervised were the ones aimed at everything at once. */
export const FIX_ONE_AT_A_TIME =
  'Fix one error at a time: the first one the output reports, or the one the others follow from. Run the narrowest check that shows it, and move to the next only when it is gone.';

/** When more attempts stop helping; the same three conditions the harness checks from the outside. */
export const FIX_STOP_WHEN =
  'Stop fixing when the same error survives three of your fixes, when a fix leaves more errors than it removed, or when the fix needs a change of design (a new dependency, a change to a public interface or a stored format, a rewrite of a module) rather than a local change. Before you stop, undo a fix that made things worse with a new commit, never by rewriting history.';

/** The rows Claudio reads back out of a fixer's report: one per fix, one for an early stop. */
export const FIXER_REPORT_ROWS =
  'End your report with one line per error you fixed, exactly `[FIXED] path:line: what was wrong`, and, if you stopped early, one line `[STOP] same-error|more-errors|design: what a person must decide`.';
```

- **`fixerPrompt`.** The three are joined into the rules block after "Make the smallest change that
  fixes the failure.". The closing "Finish with a short report: …" stays, and `FIXER_REPORT_ROWS`
  follows it.
- **`checksFixPrompt`.** `FIX_ONE_AT_A_TIME` and `FIX_STOP_WHEN` go after the untrusted-log
  paragraph. The report line becomes:

  > Report each check in `checks`, by name: its `cause`, whether you `fixed` it, the `locations` you
  > changed for it as `path:line`, and `stopped` (`same-error`, `more-errors` or `design`) when you
  > stopped before it was fixed.

  The flow is a schema run, so rows go in the structured result, not in text.

Against the twelve points:

- 1: the `[STOP]` row names what a person must decide, not reasoning.
- 3: stopping on these conditions is not one of the four premature stops, and `UNATTENDED` still
  asks before a risky step.
- 6: unchanged.

### Change: the harness half (orchestration verification)

New pure functions in `verification.ts`, each with a comment on why:

- `failureSignature(output: string): string | null`.
  1. Take the stored output tail and keep the lines that match
     `\b(error|fail(ed|ure|ing)?|assert(ion)?|exception|panic|traceback)\b|[✗✖×]` (case-insensitive).
  2. Normalise each line:
     - strip ANSI codes;
     - drop ISO times and durations (`\d+(\.\d+)?\s?(ms|s|m)\b`);
     - drop hex ids of 7 or more digits;
     - drop temp paths (`/tmp/…`, `$TMPDIR/…`, mkdtemp suffixes);
     - then apply the same `\d+ → #` flattening `health.ts` uses (`flatten`, `health.ts:111`,
       exported for this).
  3. Sort, deduplicate and hash the lines (SHA-1, 16 hex).

  It returns null when no line matched. No signature means the rule does not apply.
- `errorCount(command: string, output: string): number | null`. It reads the count from the formats
  it knows and returns null otherwise:

  | Tool | What is read |
  |---|---|
  | `tsc` | `error TS\d+` lines, or "Found N errors" |
  | ESLint | "✖ N problems" |
  | `node --test` / TAP | `# fail N` |
  | Vitest | "Tests N failed" |
  | Jest | "Tests: N failed" |
  | pytest | "N failed" in the summary line |
  | `go test` | `--- FAIL:` lines |
  | cargo | "test result: FAILED. … N failed" |

  Null means unknown, never zero.
- `parseFixerReport(text: string): { fixed: FixedLocation[]; stop: FixerStop | null }`:
  - it reads `^\[FIXED\] (.+?):(\d+): (.+)$` and `^\[STOP\] (same-error|more-errors|design): (.+)$`;
  - it keeps at most 50 fixed rows, each note at most 200 characters;
  - it ignores malformed lines;
  - the last `[STOP]` wins.

The loop in `orchestrator.ts`:

1. For each failed check, keep its signature and error count before the first attempt and after
   each one (`VerificationCommand.runs` already records each pass).
2. After an attempt, the fixer's report is parsed:
   - `fixed` rows go on its `VerificationFix.fixed`;
   - a `[STOP]` row sets `VerificationFix.stop = { kind, note, by: 'fixer' }`, and the verification
     concludes `failed`: "The fixer stopped: <note>. Claudio made no further attempt."
3. When the checks have run again, the loop checks two things:
   - **More errors.** If any failed check now has a higher `errorCount` than before this attempt
     (both known), it stops: "Attempt n left more errors in `<command>` (B) than before it (A), so
     Claudio stopped there." The fix's `stop` is `{ kind: 'more-errors', by: 'claudio' }`. The
     attempt's commits stay on the integration branch, and the report names them (no automatic
     revert).
   - **Same error.** If a check's signature is the same before the last three attempts and after
     them (it survived three attempts), it stops with `same-error`. With the default of two attempts
     this cannot fire. It matters for graphs that allow more, and the prompt half covers the fixes
     inside one attempt.
4. The order of the checks: the existing `spentOut`, then the cost, then these two, then
   `fixerGivenUp`. Code rules stay ahead of the decision point.

### Change: the harness half (flow `checks.fix`)

- `FlowCheckVerdict` moves to `@claudio/shared` and gains:
  - `locations?: string[]`, at most 20, each `path:line`, each at most 200 characters;
  - `stopped?: 'same-error' | 'more-errors' | 'design'`.

  The schema at `flow.ts:411` gains both fields (optional). `parseResult` validates them.
- The parsed verdicts are stored as JSON in a new column, `flow_runs.checks` (migration M1), the
  way `flow_runs.criteria` is stored (`flow.ts:1616`). `FlowRun.checks?: FlowCheckVerdict[]` serves
  them.
- `ChecksFix` gets a new private `historyAllows(item, failingNames)`, called from `decide()` **before**
  `hasRoom`. It is a separate function so it does not collide with idea 13's change to `hasRoom`. It
  returns false when either holds:
  - the newest work run of this item that fixed checks reported `stopped: 'design'` for any check
    failing now;
  - the last two fix runs of this item each reported `fixed: true` for a check name that is failing
    again. That is the same check surviving two fixes; the third would be the third attempt.

  Either way no automatic fix starts, and the item gets one comment, in English, from the flow:
  "Claudio did not start another fix: `<check>` failed again after two fixes" or "… the last fix
  stopped for a design decision: <note>". A person's own "Fix checks" click is never refused by this.

### Data model

- `VerificationFix` gains:
  - `fixed?: Array<{ path: string; line: number | null; note: string }>`;
  - `stop?: { kind: 'same-error' | 'more-errors' | 'design'; note: string; by: 'fixer' | 'claudio' }`.

  These live in the orchestration document, JSON, so no migration is needed.
- `flow_runs.checks TEXT`, nullable (M1).

### API

- Shared types: `VerificationFix.fixed`, `VerificationFix.stop`, `FlowCheckVerdict` (exported),
  `FlowRun.checks`.
- No new route. The existing orchestration and flow-run reads carry the new fields. OpenAPI schemas
  are regenerated.

### UI

- **`VerificationCard`** (`apps/web/src/components/VerificationCard.tsx`).
  - Under the commits, a list "Arreglos" (`verification.fixes`). Per attempt, mono rows
    `path:line` + note. A path is not a link: Claudio never links to an editor.
  - When a `stop` exists: a `Tag` with tone `warn` and the word "Detenido", the kind in words
    ("el mismo error tras tres intentos", "más errores que antes", "necesita una decisión de
    diseño"), and the note.
- **The fix panel** (design system § "Fixing failing checks"). Under each check's "Arreglado"
  verdict, its `locations` in mono. A `stopped` check shows a `warn` "Detenido" with the kind in
  words, in place of "Sin cambios".
- States: no fixes (section hidden); fixes without rows (the attempt's line only); a stop with no
  rows; a long list (more than 8 rows folds into a `Collapsible`).
- Both themes, nothing moves.
- On a phone the rows wrap: path on the first line, note below.
- Strings go in `orchestrationV2.json` (the card) and `checks.json` (the fix panel), en/es.

### Edge cases

- **"Same error" detection.**
  - Signatures ignore numbers, durations, temp paths and ordering, so a re-run's timing noise does not
    make two runs differ.
  - A truly different failure that shares every error line is treated as the same. That is
    acceptable: the lines are what a person would read.
  - Outputs with no error-looking line give no signature, and the rule is skipped.
- **Unknown tool formats.** `errorCount` returns null, and the "more errors" rule is skipped for
  that check. It never compares counts from two different parsers.
- **Parallel groups.** One attempt covers several checks. Each check is compared on its own, and
  one worse check is enough to stop.
- **A fix that turns a fast failure into a timeout.** The count is unknown after a timeout (no
  summary), so only the signature applies. The existing timeout handling and `maxAttempts` still
  bound it.
- **A fixer that writes `[STOP]` and also fixed things.** Both are recorded. The stop wins, so
  there is no next attempt. The checks already ran again after the attempt, so a fix that happened
  to pass still concludes `fixed`.
- **Malicious or odd text in rows** (paths with `..`, very long notes): they are shown as text,
  clipped and never resolved to a file. A path that is absolute or contains `..` is shown as it is,
  marked with nothing, and is never used to read a file.
- **The `orchestration.fixer` point says "another attempt" after a code stop.** Code wins and the
  point is not asked.
- **Flow: a person clicks Fix after an automatic refusal.** Allowed: `historyAllows` gates only the
  decision-started path.
- **Flow: check names change between heads** (CI renames a job). They are treated as different
  checks; the per-head limit still holds.

### Tests

- `packages/core/test/verification.test.ts`:
  - `fixerPrompt` holds the three new texts in order;
  - `failureSignature` is equal across digits, durations, temp paths and line order, differs on a
    different error line, and is null on clean output;
  - `errorCount` for each listed format, and null for unknown;
  - `parseFixerReport` reads valid rows, ignores malformed ones, caps at 50, and the last `[STOP]`
    wins.
- `packages/core/test/orchestrator.test.ts`, over the fake CLI (`packages/core/test/fixtures`, the
  `FAKE-*` markers used by today's fixer tests):
  - a fixer that writes `[STOP] design: …` ends verification `failed` after one attempt, with the
    stop recorded;
  - an attempt that raises a TAP `# fail` count stops with `more-errors`;
  - with `maxAttempts: 5`, an unchanged signature over three attempts stops with `same-error`
    before the fourth;
  - `[FIXED]` rows land on `VerificationFix.fixed`.
- `packages/core/test/flow.test.ts`:
  - the work schema has `locations` and `stopped`;
  - parsed verdicts are stored in `flow_runs.checks`;
  - `checksFixPrompt` holds the two rules and the report sentence.
- `packages/core/test/checks-fix.test.ts`:
  - a `design` stop refuses the next automatic fix and comments;
  - two fixed-then-failing runs refuse the third;
  - a person's click is not refused.
- `apps/web/test/verification-card.test.tsx` (new): rows, stop tag with its word, folding past 8,
  en/es.

### How to measure

- The share of verifications that end `failed` after spending every attempt (should fall).
- The fixer's cost per verification.
- How often each stop kind fires.
- For flow, the automatic fixes refused by `historyAllows`, and whether a person later fixed the
  same check by hand (a refusal that was right).

---

## Idea 9 · A risk score for each tool call

### Current state

- Health signals (`packages/core/src/health.ts`) judge whether a worker is stuck: `repeat-stall`
  (`:68`), `loop` (`:119`), `no-progress`, `weakened-test` and `budget`. None judges how risky a
  single call is.
- `notification.urgency` (`packages/core/src/decisions/points.ts:219`):
  - global, `act`, invisible;
  - fields `kind`, `title`, `body`;
  - `maxStateBytes` 2 KiB;
  - it only raises a `normal` draft to `high` (`push.ts:411` `urgencyOf`, `:420` `askUrgency`).
- Permission notifications are already `high` (`packages/shared/src/notifications.ts`, the
  `run.waiting` case).
- Step by step (`apps/web/src/components/changes/steps/StepsLens.tsx`) shows `EditStep`s
  (`types.ts:3186`), which `packages/core/src/edit-steps.ts` builds from `Edit`, `MultiEdit`,
  `Write` and `NotebookEdit` only.
- The transcript renders tool rows in `packages/chat-ui/src/components/Transcript.tsx` (`:352`,
  `.tool-name` / `.tool-hint`). Permission prompts are in `PermissionPrompts.tsx` (`ToolPrompt`,
  `:62`).

### Change: the scorer

A new file, `packages/shared/src/tool-risk.ts`. It is pure, with no Node imports, and does POSIX
string path work only. It is exported from `@claudio/shared`.

```ts
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolRiskFactor =
  | 'irreversible'      // deletes or discards what cannot be recovered from git or a rebuild
  | 'history-rewrite'   // force push, rebase, amend, filter-branch
  | 'leaves-machine'    // push, publish, deploy, a write request to a remote
  | 'privilege'         // sudo, su, doas, recursive chmod/chown
  | 'outside-workdir'   // writes or deletes outside the chat's directory or worktree
  | 'secrets'           // reads or prints credentials into the transcript
  | 'sensitive-path'    // writes CI config, git internals, Claude settings, env files, keys
  | 'wide-scope';       // globs, recursive flags or home/root targets on a destructive command
export interface ToolRisk {
  level: ToolRiskLevel;
  /** 0–100, for ordering only */
  score: number;
  factors: ToolRiskFactor[];
  /** One English line with the part of the input that made it fire, for state and logs */
  reason: string;
  reasonCode: string;               // `risk.<first factor>`
  params?: LocalizedParams;         // { command | path, ... }
}
export interface ToolRiskContext {
  /** Absolute directory the chat works in; null when unknown, and then nothing is outside it */
  cwd: string | null;
  /** Further directories that count as inside: the task's worktree, the documents folder */
  roots?: readonly string[];
}
export function toolRisk(call: { name: string; input: Record<string, unknown> }, ctx: ToolRiskContext): ToolRisk;
```

**Weights.**

| Factor | Weight |
|---|---|
| `irreversible` | 70 |
| `history-rewrite` | 70 |
| `leaves-machine` | 60 |
| `privilege` | 60 |
| `outside-workdir` | 45 |
| `secrets` | 40 |
| `sensitive-path` | 35 |
| `wide-scope` | 25 |

- `score = min(100, max + 10 × (number of factors − 1))`.
- `high` at a score of 60 or more, `medium` at 30 or more, `low` below.
- `wide-scope` only adds to another factor; alone it is `low`.

**`Bash`.**

1. The command is split into segments on `&&`, `||`, `;`, `|` and newlines.
2. Quoted string contents and heredoc bodies are removed first, so `echo "rm -rf /"` and a commit
   message are not scored.
3. Leading `VAR=value`, `timeout N`, `time`, `nice` and `env` are stripped. `sudo`, `doas` and
   `su -c` are stripped and add `privilege`.

Each segment is then matched on words:

- **`irreversible`:**
  - `rm` with `-r`/`-R`/`--recursive`, or of a path outside the directory;
  - `git reset --hard`, `git clean -…f…`, `git branch -D`;
  - `git checkout -- .` and `git restore .` (they discard uncommitted work);
  - `git stash drop|clear`, `find … -delete`, `shred`, `dd … of=`, `mkfs`, `truncate`;
  - SQL `drop table|database|schema`, `truncate table`, and `delete from` without `where`, inside
    `psql -c`/`sqlite3`/`mysql -e` arguments;
  - `docker rm|rmi|volume rm|system prune`, `kubectl delete`, `terraform destroy`.
- **`history-rewrite`:** `git push --force|-f|--force-with-lease`, `git rebase`,
  `git commit --amend`, `git filter-branch`, `git filter-repo`.
- **`leaves-machine`:**
  - `git push`;
  - `npm|pnpm|yarn publish`, `docker push`;
  - `gh pr create|merge|comment|review`, `gh release create`, `gh issue create|comment`,
    `gh api` with `-X POST|PUT|PATCH|DELETE` or `-f`/`-F`;
  - `glab mr create|merge|note`, `glab release create`;
  - `curl` with `-X POST|PUT|PATCH|DELETE`, `-d`/`--data*`, `-F`/`--form` or `-T`/`--upload-file`;
    `wget --post-*`;
  - `scp` and `rsync` with a `host:` argument, `ssh <host> <command>`;
  - `kubectl apply`, `terraform apply`, `aws s3 cp|sync|rm` to `s3://`.

  `--dry-run` or `-n` on `git push`/`rsync` removes the factor.
- **`privilege`:** see above, plus `chmod 777`, `chmod -R` and `chown -R`.
- **`secrets`:** `cat|less|head|tail` of a secret path (below), `printenv`, a bare `env`, and
  `echo $…TOKEN|KEY|SECRET…`.
- **`wide-scope`:** on a segment that already has `irreversible` or `privilege`, a `*` glob, `/`,
  `~`, `$HOME` or `..` as an argument, `xargs rm`, or a recursive flag.
- **Regenerable targets are not irreversible.** `rm -rf` of `node_modules`, `dist`, `build`, `out`,
  `.next`, `.turbo`, `coverage`, `target`, `.cache`, `tmp` or `.pytest_cache`, under the directory,
  is `low`. They come back with a build. This is the commonest false positive, and it is removed.

**`Edit`, `MultiEdit`, `Write`, `NotebookEdit`** (on `file_path` or `notebook_path`):

- `outside-workdir` when the path is absolute and under neither `cwd` nor a `roots` entry;
- `sensitive-path` for:
  - `.env`, `.env.*` (except `.env.example`, `.env.sample`, `.env.template`);
  - `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`;
  - `.ssh/`, `.aws/`, `.gnupg/`, `.npmrc`, `.pypirc`, `.netrc`;
  - `.git/` (internals and hooks);
  - `.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`, `.husky/`;
  - `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`.

`CLAUDE.md` is scored `low`: agents legitimately propose to it, and it is shown as a memory proposal.

**`Read`, `Grep`, `Glob`:** `secrets` when the path or pattern is one of the secret paths above.
Everything else is `low`.

**MCP tools** (`mcp__<server>__<tool>`). The verb of the tool name decides:

- `delete|remove|drop|destroy|purge|revoke|terminate` → `irreversible`, capped at `medium`;
- `create|update|write|send|post|publish|push|merge|deploy|comment|upload|set|execute|run` →
  `leaves-machine`, capped at `medium`;
- `get|list|read|search|fetch|query|describe` and anything unknown → `low`.

The cap at `medium` is because a name is a guess. MCP annotations are not available to Claudio
today; when the CLI exposes them, they replace the guess.

**`Agent`, `Task`, `Workflow`, `TodoWrite`, `Skill`, `WebFetch`, `WebSearch`, `ExitPlanMode`:**
`low`. A subagent's own calls are scored like the main agent's (sidechain blocks).

### Change: where the score shows

1. **Transcript tool rows** (`Transcript.tsx`):
   - a `medium` or `high` call gets a `Tag` after `.tool-hint`;
   - `high` uses tone `bad` with the `ShieldAlert` icon and the first factor's word ("Irreversible",
     "Sale de esta máquina", "Reescribe el historial", "Con privilegios", "Fuera del directorio de
     trabajo");
   - `medium` uses tone `muted` with its word;
   - a `Tooltip` gives the full reason. `low` shows nothing.
   - The tag's text is its accessible name.
   - Context: `cwd` from the chat's `workingDir`; `roots` from the worktree when the chat has one.
2. **Permission prompts** (`ToolPrompt`, `PermissionPrompts.tsx:62`): a `.permission-risk` line
   under `.permission-head` with the same tags and reason. The buttons and their order are
   unchanged. Nothing is pre-selected or disabled.
3. **Step by step.**
   - `EditStep` gains `risk?: ToolRisk`, computed in `edit-steps.ts` from the call's input and the
     chat's directory; absent when `low`.
   - `StepList` rows show the tag.
   - Scrubber dots of `high` steps get `data-risk="high"`: a 2 px `--bad` ring, and an aria-label
     that says "riesgo alto".
   - The step detail's `Why` header shows the tag.
4. **`notification.urgency` input.**
   - The point gains the field `risk` and `stateVersion: 2`, so the owner's earlier consent is
     cleared and asked again with the new preview (`decisions/points.ts`; `engine.ts:106` compares
     `stateVersion`).
   - `PushService` gets a dependency `recentRisk(runId): string | null`. It returns the highest-risk
     call of that chat in its last 10 minutes as `"<level>: <factors> (<command or path>)"`,
     redacted with `decisions/redact.ts` and clipped to 300 characters. It is null when every call
     is `low`.
   - `askUrgency` passes it.
   - The point's question is unchanged ("Should this notification interrupt the person now?").
   - The state's 2 KiB bound still holds.
   - The point stays `off` by default, so nothing changes until the owner turns it on.

### Data model

None in SQLite: the score is recomputed from the calls, which Claudio already keeps.

### API

- Shared: `ToolRisk`, `ToolRiskLevel`, `ToolRiskFactor`, `ToolRiskContext`, `toolRisk()`;
  `EditStep.risk?`.
- The step routes (`GET /chats/:id/changes/steps`, `GET /orchestrations/:id/tasks/:taskId/changes/steps`)
  carry it. Their OpenAPI descriptions say so.

### UI states

- **Transcript:** no tag (low); muted tag (medium); bad tag (high); a pending call (scored from its
  input, so the tag shows before the result); a sidechain call.
- **Permission prompt:** with and without the risk line.
- **Step by step:** list, scrubber, detail, and phone (tags wrap under the path; the scrubber keeps
  44 px targets).
- Dark, light, `motion=subtle` and `motion=off` (nothing moves anyway).
- Strings: `packages/chat-ui/src/locales/{en,es}/chat.json` (transcript and prompt) and
  `apps/web/src/i18n/locales/{en,es}/changes.json` (Step by step), en/es parity.

### Edge cases

- **False positives**, each with its handling:
  - regenerable `rm -rf` is low;
  - quoted strings and heredocs are ignored, as are commit messages and echoed text;
  - `git push --dry-run` is low;
  - `.env.example` is low;
  - writes inside the worktree under an absolute path are inside (roots).
  - The tests pin these cases. Anything else that turns out noisy is tuned in the tables, which are
    data.
- **False negatives.** Obfuscated commands (`$(echo cm0= | base64 -d)`, aliases, scripts that
  delete) are not caught. The score is a reading aid, not a control, which is why it never blocks.
- **Bash that `cd`s first** (`cd /etc && rm x`): a `cd` to an absolute path makes later relative
  paths in the same command count as outside. A `cd` to an unknown variable leaves them unknown,
  which is not outside.
- **Windows paths.** Claudio runs on Linux and in Docker; paths are POSIX. A `C:\` path counts as
  absolute and outside.
- **MCP tools of Claudio's own server** (`claudio` assistant writes) are scored by the same verbs.
  Their write prompts already ask the person.
- **Unknown tools** (new CLI tools) are `low`.
- **Inputs larger than 64 KiB** are scored on their first 64 KiB.
- **A permission prompt for a tool whose input is a plan or a question** carries no risk line.
- **Consent.** Bumping `stateVersion` turns an active `notification.urgency` into one without
  consent until the owner consents again. The decision settings screen already shows that, and
  [decision-engine.md](../decision-engine.md) records the bump.

### Tests

- `packages/shared/test/tool-risk.test.ts` (new): a table of at least 60 cases.
  - Every factor, both ways.
  - The regenerable list.
  - Quoted and heredoc text.
  - `--dry-run`.
  - `cd` handling.
  - Outside and inside the worktree roots.
  - MCP verbs and the medium cap.
  - Read of secrets.
  - Score arithmetic and levels.
  - The 64 KiB bound.
- `packages/core/test/edit-steps.test.ts`: a `.github/workflows` edit carries `risk.level ===
  'medium'`, and an outside absolute path carries `high`.
- `packages/core/test/push.test.ts`: the urgency state carries `risk` when a recent call is high,
  and none otherwise; `stateVersion` 2 asks for consent again.
- `packages/core/test/decision-points-runtime.test.ts`: `notification.urgency` fields include
  `risk`.
- `packages/chat-ui/test/tool-risk-tag.test.ts` (new): the tag text per level and factor, and
  nothing for low.
- `apps/web/test/steps-risk.test.tsx` (new): the list tag and the scrubber's `data-risk`.

### How to measure

- High and medium flags per day.
- The owner reviews a sample of 50 `high` flags and calls each right or wrong. The target is at
  least 80 % right; below that, the tables are tuned.
- When `notification.urgency` is on: how many raises carried a high risk, and whether the person
  opened them (the point's resolver already records `opened_at`).

---

## Idea 10 · Four more roles in the project templates

### Current state

- `project-templates.ts` defines seven roles (`:14`–`:20`) and five templates. Each template has
  one `team` list (`SOFTWARE_TEAM` at `:24`).
- `ProjectTeamRole` (`types.ts:1343`) has `role`, `model` and `responsibility` only. `ProjectTemplate`
  (`types.ts:1453`) has `team`.
- `team.ts`:
  - `DEFAULT_COLUMNS` (`:63`) maps roles to flow columns;
  - `ROLE_GUIDANCE` (`:79`) holds the body sentence per role;
  - `agentFileContent` (`:215`) writes `name`, `description` and `model` front matter and no
    `tools`;
  - `addFromTemplate` (`:526`) adds every offered role or the named ones.
- `flowAgentsFile` (`packages/core/src/index.ts:2126`) already reads `tools` and `disallowedTools`
  from an agent file's front matter and passes them in `--agents`, so a `tools:` line is enforced
  in flow runs.
- The assistant offers the template's team (`assistant.ts:1365` `templateOffered`, and the
  `teamMembers` lines in `assistant-answer.ts`).

### Change

1. **Shared types.**
   - `ProjectTeamRole` gains optional `tools?: string[]`, `writes?: string[]` and
     `commands?: string[]`. `ProjectTeamMember` already has `writes` and `commands`, and gains
     `tools?`.
   - `ProjectTemplate` gains `optionalTeam: ProjectTeamRole[]`.
   - `PutTeamMemberRequest` accepts `tools`, validated as at most 30 names, each matching
     `^[A-Za-z][A-Za-z0-9_]*(\([^()\n]{0,200}\))?$`.
2. **Four roles in `project-templates.ts`:**

   | Role | Model | Tools | Writes | Commands | Columns |
   |---|---|---|---|---|---|
   | `silent-failure-hunter` | `sonnet` | `Read, Grep, Glob, Bash` | `[]` (documents only) | `git diff *`, `git log *`, `git show *`, `git blame *`, `git grep *` | none (consulted) |
   | `type-design-analyst` | `opus` | `Read, Grep, Glob, Bash` | `[]` | same | none |
   | `build-resolver` | `sonnet` | absent (all) | absent (no limit of Claudio's) | absent | none |
   | `spec-miner` | `opus` | `Read, Grep, Glob, Bash, Write, Edit` | `[]` (documents only) | same as the reviewers | none |

   The review roles are read-only in Claudio's runs:
   - `writes: []` denies edits outside the documents folder;
   - `commands` restricts `Bash` to git reads in the flow's work stage;
   - `tools` restricts the agent wherever the CLI loads the file, the subagent case included.

   From a terminal, only the file's own words hold, as the generated file says.

   The template wiring:
   - `software`, `library` and `custom` get all four in `optionalTeam`;
   - `research` gets `spec-miner` only;
   - `simple` gets none.
3. **`ROLE_GUIDANCE`** gains these English bodies:
   - `silent-failure-hunter`: "You are consulted to find failures that make no noise. In the code the
     request names, and the code around it, look for errors caught and dropped, promises nobody
     awaits or whose rejection nobody handles, fallbacks and defaults that hide a failure, exit
     codes ignored (`|| true`, unchecked results), and retries that end without a word. Report each
     finding with `path:line`, what fails silently, and the input or state that makes it happen.
     Report only what you can point to; no finding is a valid answer. You change no code."
   - `type-design-analyst`: "You are consulted on type design. For the types the request names,
     judge whether they make illegal states unrepresentable: invariants held by the type rather
     than by comments, optional fields that some states always need (a discriminated union fits
     better), stringly typed values, casts and `any` that bypass the checker, and types wider than
     what their callers handle. Report each finding with `path:line`, the state it lets in, and the
     narrower type that would forbid it. Report only what you can point to; no finding is a valid
     answer. You change no code."
   - `build-resolver`: "When a build, a type check or a lint fails, make it pass with the smallest
     change, without loosening a test, a type or a lint rule." then `FIX_ONE_AT_A_TIME` and
     `FIX_STOP_WHEN` (idea 8) and `REAL_VERIFICATION`.
   - `spec-miner`: "You are consulted to write down what the code does today. For the area the
     request names, read the code and its tests and write a specification of the current behaviour
     in the documents folder: inputs, outputs, errors, edge cases and the invariants the tests pin,
     each with the `path:line` it comes from. Say where the code and its tests disagree. Describe
     what is, not what should be. You change no code."
4. **`agentFileContent`** writes `tools: Read, Grep, Glob, Bash` (comma form, which
   `readFrontmatterList` reads) when the member has `tools`. A file whose owner is the person is
   never rewritten (`WrittenFiles`).
5. **`addFromTemplate`.**
   - The offered roles are `team ∪ optionalTeam`.
   - Without `roles`, only `team` is added: the behaviour of today.
   - `roles` may name any offered role.
   - The unknown-role error lists both sets.
   - Optional roles never take a column (`DEFAULT_COLUMNS` has none for them).
6. **The assistant.** The `teamMembers` instruction (`assistant-answer.ts`) gets one more line after
   the template roles:

   > The template also offers these optional roles; propose one only where what you read shows the
   > need (for example many caught-and-ignored errors for the silent-failure hunter, or a large
   > untested module for the spec miner): <list>.

   `ProposedTeamMember.fromTemplate` stays true for them.
7. **UI.**
   - The Team screen's "Add the template's team" (`apps/web/src/pages/team/Members.tsx:241`) keeps
     its button for the template team.
   - A second, quiet "Más roles" menu (`MoreActions`, a `Sheet` on a phone) lists the optional
     roles with their responsibility and a "Añadir" each.
   - A read-only role shows a muted `Tag` "solo lectura".
   - Strings go in `team.json` en/es.

### Data, API

- No migration: the team and templates are settings JSON.
- `GET /project-templates`, or wherever templates are served (the task greps for
  `PROJECT_TEMPLATES`), returns `optionalTeam`.
- The OpenAPI description of `POST /projects/:id/team/from-template` (`routes.ts:250`) says optional
  roles are added only when named.

### Edge cases

- **A project that already has a member with one of these role names.** It is left alone ("a role
  already on the team is left alone").
- **An agent file with the same name written by the person.** It is kept (`WrittenFiles`).
- **A person removes `tools`** from a review role's file. Claudio's `writes: []` and `commands`
  still hold in flow runs. The member's screen shows the file's tools as the file says them.
- **`Bash(git diff:*)`-style patterns in `tools`.** The front matter uses plain tool names; the
  restriction to git reads comes from `commands`, which Claudio turns into permission rules.
- **The build resolver with `writes` absent.** It is meant to change code, and stop rules bound it.
- **Templates applied before this change.** `optionalTeam` is read when offered, never stored in
  the project, so old projects see the new roles too.

### Tests

- `packages/core/test/team.test.ts`:
  - `agentFileContent` writes `tools:` for the three restricted roles and none for the build
    resolver;
  - no `roles` adds only `team`;
  - naming an optional role adds it with no column;
  - an unknown role lists both sets.
- `packages/core/test/project-settings.test.ts` or the templates test: each template's `optionalTeam`
  matches the table.
- `packages/core/test/assistant.test.ts`: the optional-roles sentence and list are present.
- `apps/api/test/team.test.ts`: `from-template` with an optional role answers 201 and the member
  has `tools`.
- `apps/web/test/team-optional-roles.test.tsx` (new): the menu, the tag, en/es.

### How to measure

- Projects that added each optional role.
- `Agent` tool calls by `subagent_type` naming these roles, from the transcripts.
- For the reviewers: findings per run, and how many the person acted on (sampled).

---

## Idea 12 · A delegation contract

### Current state

- The workflow lead prompt (`orchestrator.ts:2589`) says "Wait for it to finish, then reply with
  one line saying whether it completed."
- Workers, flow runs and the fixer may spawn subagents (the `Agent` tool, possibly in the
  background) and background commands. Nothing tells them that a turn ending is the process ending.
- `open-items.ts` continues runs that end with an offer (`OFFERS`, `:37`), a question or an
  announced next step (`phraseItems`, `:90`). Structural items (`:73`) are a missing schema result
  and uncommitted paths.
- The chat knows its subagents (`SubagentInfo`, with `background` and `status`) and background
  tasks (`BackgroundTask`, with `status`) from stream events (`packages/core/src/cli-facts.ts:48`,
  `:74`; `live-chat.ts:627`).

### Change

1. A new export in `prompt-rules.ts`:

   ```ts
   /**
    * In an unattended run the end of a turn is the end of the process, and whatever it left running
    * in the background goes with it; a lead that delegated is the only one who can collect.
    */
   export const DELEGATION =
     'You own the results of the work you delegate. When you start subagents or background tasks, wait for each one to finish, read what it returned and use it before your turn ends. Never end a turn by saying that you are waiting for background agents or tasks: when this turn ends this process ends, and whatever still runs in the background is lost with it.';
   ```

   It is placed:
   - in the workflow lead prompt, before `timeSignal`;
   - in `workerTask`, after `UNATTENDED`;
   - in the flow's work stage, after `scopeAndCompletion()`;
   - in `fixerPrompt`, after `UNATTENDED`.
2. **A structural open item.**
   - `OpenItemsInput` gains `delegates?: { agents: string[]; tasks: string[] }`: the descriptions of
     background subagents and background tasks still `running` when the result arrived.
   - Background tasks the person sent to the background (`backgroundedByUser`) are excluded.
   - `structuralItems` adds, when either list is non-empty:

     > You ended your turn while work you delegated is still running: <names, at most 5, then "and N
     > more">. Wait for it to finish, read what it returns and use it; this process ends with your
     > turn.

   - Code decides it; no decision point can waive it (like uncommitted paths).
   - `FlowService.finish` (`flow.ts:1683`) and `Orchestrator.settleNow` read the chat's lists and
     pass them.
3. **A phrase item.** `WAITING` patterns join `phraseItems`:
   - `\bwaiting (for|on) (the )?(background|sub-?agents?|agents?|tasks?|workers?)\b`;
   - `\b(once|when) (the |they |it )?(background )?(sub-?agents?|agents?|tasks?) (finish|complete|report|return)`;
   - `\bi('ll| will) (report|check|update) (back )?(when|once)\b`.

   Item: "Your last message says you are waiting for delegated work. Nobody resumes you when it
   finishes: wait for it now, in this turn, and use its results."

Against the twelve points:

- 3: this is the harness side of point 3, applied to delegation.
- 8: it asks for more tool use (waiting, reading), not less.

### Data, API, UI

None. A continuation shows in the transcript as today's continuations do.

### Edge cases

- **A background task that is meant to outlive the turn** (a dev server the person asked for). In
  unattended runs Claudio's own rules already forbid it (`COMMANDS_IN_FOREGROUND`, `workerChecks`).
  In a person's chat, `openItems` is not applied.
- **A subagent that finished but whose status event has not arrived yet.** The list is read at the
  `result` event, when the CLI has emitted every `task_*` event of the turn. A late one costs at
  most one needless continuation.
- **`MAX_CONTINUATIONS` reached.** The result is judged as it is, as today.
- **The workflow lead.** Its turn ends when the Workflow tool returns, and `followWorkflow` follows
  the workflow run. The structural item is not applied to the lead; the prompt line is.
- **A Spanish final text.** The phrases are English (a known gap of [prompts.md](../prompts.md)).
  The structural item is language-free.

### Tests

- `prompt-rules.test.ts`:
  - `DELEGATION`;
  - `structuralItems` with agents, with tasks, with both, with the cap of five names, and with
    person-backgrounded tasks excluded;
  - the three phrase patterns, matched and not matched.
- `flow.test.ts`: the work stage carries `DELEGATION`. A scripted chat whose result arrives with a
  running background subagent is continued with the item.
- `orchestrator.test.ts`: a worker with a running background subagent at its result is continued
  (not an attempt). The workflow lead prompt holds `DELEGATION`.

### How to measure

- Continuations caused by the delegation item.
- Worker and flow results that arrived with running background work (from the chat's subagent
  list), before and after. The target is near zero after.

---

## Idea 13 · A global daily spend cap

### Current state

Budgets exist per unit:

| Budget | Where | How it is enforced |
|---|---|---|
| A chat execution | `ChatStartOptions.maxBudgetUsd` | the CLI's `--max-budget-usd` |
| A task | `TaskLimits.maxCostUsd` (`types.ts:637`), task over graph (`task-limits.ts:28`) | the CLI's `--max-budget-usd`; time by Claudio's own clock |
| A graph | `OrchestrationSpec.limits` | the same |
| A flow run | `flow.maxCostUsd` (`flow.ts:2114`, `project-settings.ts:255`) | the CLI's `--max-budget-usd` |
| The fixer | `VerificationSpec.maxCostUsd` | what is left, per attempt (`orchestrator.ts:1893`) |
| The supervisor | `maxCostUsd: 0.05` (`supervisor.ts:21`) | the CLI's `--max-budget-usd` |
| Decisions through the CLI | `cli.maxCostUsd: 0.02` (`decisions/settings.ts:92`) | the CLI's `--max-budget-usd` |

Other facts that shape the design:

- Usage limits are per account (`rotation.ts`, `@claudio/accounts`).
- **Where cost is summed.**
  - `foldResult` (`packages/core/src/chat-fold.ts:248`) keeps
    `execution.costUsd = max(previous, total_cost_usd)`; the CLI's figure is cumulative over its
    process.
  - The Usage report (`chat-service.ts:467` `spends`) puts each execution's whole cost on
    `localDay(endedAt)` (`usage.ts:47`), in the server's time zone.
  - Nothing sums across chats by day for a gate.
- **Runtime settings.**
  - `app-settings.json` is managed by `AppSettingsStore` (`packages/core/src/app-settings.ts`) with
    layers env → file → default.
  - The keys live in `AppSettingValues` (`types.ts:4087`), `DEFAULT_APP_SETTINGS` and
    `APP_SETTING_ENV` (`paths.ts:180`, `:203`).
  - The routes are `GET`/`PUT /settings/app` (`routes.ts:551`).
  - The UI is `AppSettingsCards.tsx`.
- **A precedent for "wait".**
  - `LimitWait` (`types.ts:3359`): a task keeps `running` and its slot, and shows a `.wait-line`
    (design system § "A wait, and the limit in the status bar").
  - The flow keeps queued runs as rows and claims them in a guarded transaction
    (`flow.ts:1375` `claim`).
  - The chat start gate is `ChatManager.admit` (`chats.ts:676`), which refuses with `ChatRefusal`
    at `maxConcurrentRuns`.

### Change: the ledger

Migration M1 creates two tables:

```sql
CREATE TABLE spend_ledger (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL,     -- ISO UTC of the result
  chat_id          TEXT NOT NULL,
  execution_id     TEXT NOT NULL,
  usd              REAL NOT NULL,     -- this result's increase of the process's total_cost_usd; 0 when not reported
  reported         INTEGER NOT NULL,  -- 0 when the result carried no total_cost_usd
  purpose          TEXT NOT NULL,     -- person|flow|orchestration|planner|fixer|integrator|synthesis|assistant|decision|supervisor|schedule|other
  account          TEXT,              -- account id; null for the default config dir
  account_kind     TEXT,              -- login|token|api-key; null when unknown
  project_id       TEXT,
  orchestration_id TEXT
);
CREATE INDEX spend_ledger_at ON spend_ledger (at);
CREATE TABLE spend_alerts (
  day   TEXT NOT NULL,                -- local YYYY-MM-DD of the process that wrote it
  level TEXT NOT NULL,                -- 'warn' (75 %) | 'exhausted' (100 %)
  at    TEXT NOT NULL,
  PRIMARY KEY (day, level)
);
```

- **The write.** `foldResult` reports `delta = total_cost_usd − lastReportedThisProcess` through a
  new `ChatHost.recordSpend`. `lastReportedThisProcess` lives on the live chat, reset whenever a
  process is spawned (a resume, a rotation replay or a restart). It does not use the execution's
  `max()`, which would under-count after a process restart inside one execution.
- **What is skipped.** A non-positive or non-finite delta writes nothing. A result without a cost
  writes a row with `usd = 0, reported = 0`.
- **Purpose.** A new core-internal start option, `ExecutionExtras.purpose`, is set by each starter:
  - flow, orchestrator (worker, planner, fixer, integrator, synthesis), assistant, decisions `cli`,
    supervisor and schedules set their own;
  - person routes default to `person`;
  - anything unset is `other`.
- **Backfill.** Migration M2, a function, backfills today: one row per execution whose `endedAt`
  falls in the process's local today and whose `costUsd > 0`, `at = endedAt`, `purpose = 'other'`.
  The day of the upgrade then starts from what was really spent.
- **Retention.** Rows older than 35 days are deleted at startup. Only today is needed. The Usage
  report reads executions, not the ledger.

### Change: the gate

A new `packages/core/src/spend.ts` holds `SpendGate`:

- `state(now = Date.now()): SpendState`.
  - It sums `usd` over `at ∈ [localMidnight(now), nextLocalMidnight(now))`.
  - It computes `share = spent / cap`.
  - `level` follows the usage-bar rule: `off` with no cap; `ok` below 0.6; `warn` from 0.6; `bad`
    from 0.75; `exhausted` from 1.
  - `blocked = level === 'exhausted'`.
  - `resetsAt` is the next local midnight.
  - It returns the breakdowns and the waiting counts, and the `unreported` count.
- `allows(purpose, { override?, orchestrationId? }): boolean`. It is true when not blocked, when
  `override` (a person's), or when the orchestration holds today's pass.
- `onChange(listener)`. It fires on four occasions:
  - after a cap change;
  - on a level crossing, computed after each ledger write;
  - at local midnight, from a timer re-armed each day from local date parts;
  - when a pass is granted.

  Listeners call `FlowService.dispatch()` and `Orchestrator.schedule()` for running graphs, and the
  bus emits `spend.changed`.
- **Alerts.** On crossing 75 % and 100 %, the process that manages `INSERT OR IGNORE INTO
  spend_alerts` emits `spend.alert` (once per day and level, even with two processes on one data
  dir).

The cap itself: `AppSettingValues.dailySpendCapUsd: number | null`.

- The default is `null` (off).
- The variable is `CLAUDIO_DAILY_SPEND_CAP_USD`.
- Valid values are greater than 0 and at most 100,000, rounded to cents.
- `parseValue` checks it. A file value that fails is dropped to the default, as for every key.

**Where the gate is checked:**

| Starter | Code | Over the cap |
|---|---|---|
| Flow run claim | `flow.ts:1375` `claim`, inside its write transaction, before the parallel count | Stays `queued`; FIFO order kept; dispatched when the gate opens |
| Flow continuation, restart recovery, limit replay | `finish`, `recover`, `rotation.ts` | Proceeds: in-flight |
| `checks.fix` decision start | `checks-fix.ts:91` `hasRoom` | `false`: no automatic fix. The point is asked once per head, so after the gate opens a person starts it |
| A person's "Fix checks" / "Address" | `pull-requests.ts` | Queues a flow run, which waits at `claim` |
| Orchestration task start | `orchestrator.ts` `schedule` (the loop that starts `pending` tasks) | Stays `pending` unless the graph has today's pass; the graph shows a wait line |
| Task retry and continuation, integrator, verification and its fixer, synthesis | `settleNow`, verification loop | Proceed: in-flight (decision 5) |
| Workflow-engine launch | `launchWorkflow` | Gated like the first task start |
| Schedule fire | `schedules.ts:633` `fire` | A `skipped` run with "Today's spend cap was reached (X of Y USD), so this slot was skipped, not run late." |
| Supervisor proposal | `supervisor.ts` | No call; health still shows |
| Decision through the CLI provider | `decisions/providers/cli.ts` | `unavailable: 'spend-cap'` → today's behaviour (points never block) |
| Person routes (table below) | `apps/api/src/routes/*` | `409 { code: 'spend-cap' }` unless the person overrides |
| A message to a chat that is already running a turn (queued delivery) | — | Proceeds: it was accepted before |
| Pre-warmed spare processes, the auth check | `chats.ts` | Not gated: no turn, no cost |

**Person routes that answer `409 spend-cap` over the cap:**

- `POST /chats`, `/chats/:id/messages`, `/chats/:id/resume`, `/chats/:id/fork`;
- `POST /workflows/saved/run`;
- `POST /orchestrations`, `/orchestrations/plan`, `/orchestrations/plan/start`;
- `POST /orchestrations/templates/:templateId/launch`;
- `POST /orchestrations/:id/resume|relaunch|verify`;
- `POST /orchestrations/:id/tasks/:taskId/retry|retry-clean|rerun`;
- `POST /projects/:id/assistant/runs`;
- `POST /assistant/chats`.

The 409 body is `{ error, code: 'spend-cap', spend: SpendState }`.

**Override.**

- The request header `X-Claudio-Spend-Override: 1` lets the request through.
- A request authenticated by a chat's token cannot override: the header is ignored and the 409
  stands.
- An override on a route that starts or resumes a graph grants that graph today's pass
  (`Orchestration.spendPass = 'YYYY-MM-DD'`, kept in its document), so its tasks run today.
- The audit log records the request as usual.

### API

- Shared types:
  - `SpendState`;
  - `SpendPurpose`;
  - `SpendLevel = 'off' | 'ok' | 'warn' | 'bad' | 'exhausted'`;
  - `SpendChangedEvent` (`spend.changed`, `{ spend }`);
  - `SpendAlertEvent` (`spend.alert`, `{ level, spend }`);
  - `AppSettingValues.dailySpendCapUsd`;
  - `Orchestration.spendPass?: string | null`;
  - `DecisionUnavailableReason` gains `'spend-cap'` (`types.ts:7020`);
  - `SpendCapRefusal`, the 409 body.
- **`GET /spend`** (new). Tag `Usage`, summary "Today's spend against the daily cap". It returns
  `SpendState`. Chat tokens may read it.
- **`POST /orchestrations/:id/spend-pass`** (new). Tag `Orchestrations`, summary "Let a graph run
  past today's spend cap". It sets today's pass and answers the orchestration. It is forbidden to
  chat tokens.
- **`GET`/`PUT /settings/app`** carry `dailySpendCapUsd`.
  - A `PUT` that names it from a chat token answers 403: "a chat's token cannot change the daily
    spend cap".
  - Read-only mode refuses with 405 as today.
- `SpendState`:

  ```ts
  interface SpendState {
    day: string;                 // local YYYY-MM-DD
    timezone: string;            // Intl resolved zone of the server
    capUsd: number | null;
    spentUsd: number;
    share: number | null;        // null when no cap
    level: SpendLevel;
    blocked: boolean;
    resetsAt: string;            // next local midnight, ISO
    unreported: number;          // results today without a cost
    byPurpose: Partial<Record<SpendPurpose, number>>;
    byAccountKind: { login: number; token: number; apiKey: number; unknown: number };
    waiting: { flowRuns: number; orchestrationTasks: number };
  }
  ```

- **Notifications** (`packages/shared/src/notifications.ts`). `spend.alert` makes a draft of kind
  `limit`:
  - `warn`: priority `normal`, tone `warn`, "Gasto de hoy al 75 % del tope";
  - `exhausted`: priority `high`, tone `bad`, "Tope de gasto diario alcanzado: el trabajo automático
    espera hasta las 00:00".

  Both link to Settings → Runtime.
- **README.** Rows for `GET /spend` and `POST /orchestrations/:id/spend-pass`. The `/settings/app`
  row (`README.md:1245`) names the new key. The "How it talks to Claude" row "Spending and time
  limits" (`README.md:209`) adds: "the daily cap sums the `total_cost_usd` each `result` reports".
- **OpenAPI.** Summaries and tags; the 409 response on each listed route; the override header
  documented once in the info description and referenced from each route.

### UI

- **Settings → Runtime** (`apps/web/src/pages/config/AppSettingsCards.tsx`). A new card, "Tope de
  gasto diario", with:
  - a `Switch` "Limitar el gasto diario";
  - a `NumberInput` in USD, two decimals;
  - the hint: "Hoy: <formatCost(spent)> según el CLI. Por encima del tope, el trabajo automático
    espera y tus chats te preguntan antes de enviar."
  - a second hint: "En cuentas de suscripción es lo que costaría en la API, no lo que pagas."

  Its states:
  - off;
  - on;
  - set by the environment (`EnvNote`, read-only);
  - invalid input (inline error from the controls' own error slot);
  - saving;
  - saved (toast);
  - error (toast with the server's message).

  `SourceTag` as on the other cards.
- **Status bar** (`apps/web/src/components/shell/StatusBar.tsx`). A `.spend` item beside `.lim`,
  shown only when a cap is set:
  - a neutral bar below 60 %;
  - `warn` with "cerca del tope" from 60 %;
  - `bad` with the percentage from 75 %;
  - `bad` with "tope alcanzado · vuelve a las 00:00" when exhausted.

  Its tooltip gives spent, cap, unreported and the time zone. With no reading (the request failed)
  nothing is drawn: no figure is invented.
- **Usage page** (`apps/web/src/pages/Usage.tsx`). A line "Tope diario" with the same bar and
  words, on a desktop and on a phone. On a phone this is where the cap shows, since the status bar
  is desktop only.
- **Wait lines** (`.wait-line`, warn-tinted, no motion). Each shows only while the gate is closed
  and the thing is waiting:
  - a board card whose flow run is queued: "Esperando al tope diario · vuelve a las 00:00";
  - the orchestration page header: "N tareas esperan al tope diario · vuelven a las 00:00", with a
    quiet "Seguir hoy de todos modos" that opens a confirm `Dialog` (a `Sheet` on a phone) and posts
    the pass.
- **Chat send** (`apps/web/src/pages/chat`, where the composer's send errors are handled).
  - A `409 spend-cap` opens a confirm `Dialog` (a `Sheet` on a phone): "Has alcanzado el tope de gasto
    diario" with spent and cap, "Enviar igualmente" as the zone's primary, "Cancelar", and a link
    "Cambiar el tope".
  - Confirming resends with the override header. The message stays in the composer until then.
  - The choice is remembered for that chat for the local day (`sessionStorage`, key
    `claudio.spendCap.ack.<day>.<chatId>`), so a conversation is not asked on every turn.
  - The same dialog serves New chat, plan, launch and the orchestration actions.
- **Motion.** None of this moves.
- **Gradients.** No new gradient surface. The dialog's primary is the zone's one primary.
- **Strings.** `config.json`, `shell.json`, `usage.json`, `orchestration.json`, `work.json` and
  `chats.json`, en/es.
- **Phone.** Dialogs become `Sheet`s, targets are ≥ 44 px, and the `NumberInput` uses 16 px text.

### Edge cases

- **Time zone and day boundary.**
  - The day is the server's local day, as on the Usage page.
  - A turn that spans midnight counts on the day its result arrives. Each turn is a row, so a long
    chat spreads over the days it really spent on.
  - DST days are 23 or 25 hours long.
  - A server whose zone changes while running: each check computes the window from the current
    zone.
  - Two processes with different zones on one data dir (unusual): each reads its own window. The
    alert rows carry each writer's day, which can double an alert at worst.
- **Clock jumps.** Windows come from "now". Rows dated in the future count when their day comes.
- **Cost not reported by the CLI.** It is not counted, it is never estimated, and `unreported` says
  how many results lacked it. Chats run from a terminal are not in the ledger at all, as on the
  Usage page.
- **Runs in flight when the cap is hit.** They continue (decision 5).
  - The overshoot is bounded by each run's own `--max-budget-usd`. With no such limit, it is bounded
    only by the run.
  - The UI says "X US$ por encima del tope, de trabajo que ya estaba en marcha" when spent is over
    the cap.
- **Several accounts.** One global cap, with a breakdown by account kind. Rotation does not change
  it.
- **API-key versus subscription accounts.** Both are counted by default (decision 7), and the UI
  labels the figure. See [open question 1](#open-questions-for-the-owner).
- **Raising the cap mid-day** opens the gate at once. `onChange` re-dispatches the queued flow
  runs, oldest first, and schedules every running graph.
- **Lowering it below today's spend** closes the gate for new starts at once. Nothing running
  stops.
- **Turning it off** opens everything.
- **A cap set by the environment** cannot be changed in the UI or by `PUT` (400, as for every
  env-set key).
- **Assistant and decision runs.**
  - Counted in the spend: they cost.
  - The project assistant and the Claudio assistant are person-started, so they ask first.
  - Decision points answer `unavailable: 'spend-cap'` and fall back to today's behaviour.
  - Jev (an outside service, not Claude) is not counted. Its cost stays on the Usage page's
    decisions line.
- **Schedules.** A slot over the cap is skipped with its reason, never run late after midnight.
  This matches how slots missed while Claudio was down are treated.
- **Two processes on one data dir.**
  - The ledger and the alerts are rows, and alerts are deduplicated by primary key.
  - The cap is read from the server process's `AppSettingsStore`. The MCP server reaches Claudio
    through its API, so it never decides on its own.
- **Graph passes.** A pass is for one local day. A graph still waiting the next day is under that
  day's cap. Passes are only granted by a person.
- **Rounding.** Sums are kept as REAL and shown with `formatCost`. A cap of 20 is reached at
  ≥ 20.00 after rounding to cents, so it never reads "20,00 de 20,00" while still open.
- **Concurrency and spend both refuse a chat start.** Spend answers first (409 `spend-cap`), because
  the dialog can resolve it, then concurrency.
- **A chat-token client** (an agent calling the API) gets 409 and cannot override, so an agent
  cannot spend past the person's cap.
- **Backfill at upgrade.** Only executions that ended today are backfilled. A long execution still
  running at upgrade starts counting from its next result.
- **Ledger growth.** About one row per turn, pruned after 35 days.

### Tests

- `packages/core/test/spend.test.ts` (new):
  - the window across DST (with `TZ=Europe/Madrid` fixed in the test process);
  - the level thresholds 0.6, 0.75 and 1;
  - the cent rounding at the cap;
  - `unreported`;
  - the breakdowns;
  - `allows` with an override and with a graph pass;
  - the midnight timer re-arms;
  - alerts are written once per day and level with two `SpendGate`s on one database;
  - retention.
- `packages/core/test/chat-model.test.ts` or `chats.test.ts`, over the fake CLI:
  - cumulative `total_cost_usd` 0.10 → 0.25 writes 0.10 and 0.15;
  - a respawned process restarts the baseline;
  - a result with no cost writes `reported = 0`.
- `packages/core/test/flow.test.ts`:
  - over the cap a queued run stays queued and keeps FIFO;
  - raising the cap dispatches;
  - continuations proceed.
- `packages/core/test/orchestrator.test.ts`:
  - pending tasks do not start over the cap;
  - a pass lets them start;
  - verification and its fixer proceed for a graph whose tasks all started.
- `packages/core/test/schedules.test.ts`: a slot over the cap is `skipped` with the reason.
- `packages/core/test/checks-fix.test.ts`: `hasRoom` is false over the cap.
- `packages/core/test/decision-engine.test.ts`: the `cli` provider answers `unavailable:
  'spend-cap'`.
- `packages/core/test/supervisor.test.ts`: no call over the cap.
- `packages/core/test/app-settings.test.ts`: the key's range, the env layer, sanitize.
- `packages/core/test/db.test.ts`: M1 and M2 from the version before them; the backfill counts only
  today.
- `apps/api/test/spend.test.ts` (new):
  - `GET /spend`;
  - 409 on each listed route;
  - the override header works for the owner and is ignored for a chat token;
  - the pass route, with 403 for a chat token;
  - `PUT /settings/app` with the cap from a chat token answers 403.
- `apps/api/test/security.test.ts`: the new denials.
- `apps/web/test/spend-cap.test.tsx` (new):
  - the status bar levels and words;
  - the settings card states;
  - the confirm dialog resends with the header and remembers per chat and day;
  - en/es.
- `e2e/specs/spend-cap.spec.mjs` (new, written but **not run by the worker**): set a cap in
  Settings, see it in the status bar, both themes.

### How to measure

- Days the cap was reached.
- The overshoot per day (spent − cap).
- Waits per day (flow runs and tasks) and how long they waited.
- Overrides per day.
- Unreported results per day.

---

## Idea 14 · Plateau detection for bounces and retries

### Current state

- **Flow.** QA's failing verdict sends a card back (`flow.ts:1785`) until `maxBounces` (default 3,
  `team.ts:55`, at most 20, `project-settings.ts:41`). Then the card waits for a person
  (`waiting: 'bounces'`, cause `flow.bounces`).
  - `flow.bounce` (`decisions/points.ts:113`) can end a round sooner, when it is active.
  - Each verify run's criteria are stored as JSON in `flow_runs.criteria` (`flow.ts:1616`).
- **Orchestration.** A failed task is retried in the same chat until `maxAttempts` (default 2,
  `orchestrator.ts:101`, at most 10). `orchestration.retry` can call an error permanent
  (`orchestrator.ts:1304`).
- **Health.**
  - `repeat-stall` (`health.ts:68`) watches one execution for commands of one kind that hang
    repeatedly.
  - `loop` (`:119`) watches the same call with the same answer, or the same error, four times in
    the last twelve calls.

  Both live within one execution and are time- or call-based. Neither looks across rounds or
  attempts.

### Change

1. **Flow plateau** in `FlowService.finish`, on `verify` + `rejected`, before the bounce decision.
   - `plateaued(history)` is a new pure function in `flow.ts`. It reads the criteria of this
     round's verify runs: the last `bounces + 1` verify runs of the item, oldest first.
   - For two consecutive runs `a` and `b`, `improved(a, b)` holds when some criterion unmet in `a`
     is met in `b` (by id; `needsPerson` criteria are left out), or the number unmet fell.
   - With at least three runs `r1, r2, r3` (the newest three), it is a plateau when neither
     `r1 → r2` nor `r2 → r3` improved: no improvement for two rounds.
   - On a plateau, while `flow.stopOnPlateau !== false`:
     - the card waits for a person (`waiting: 'bounces'`) with the cause `flow.plateau`, a new
       `FLOW_CAUSE`;
     - the flow writes one English comment: "Two rounds brought no improvement: the same criteria
       are still unmet (<ids>). Waiting for a person."
   - `maxBounces` still applies first, so the rule only ever ends a round sooner. With
     `maxBounces < 2` it cannot fire.
2. **Task retry plateau** in `Orchestrator.settleNow`. Before a retry, compare
   `failureSignature(result.result)` (idea 8) with the signature stored for the previous failed
   attempt, on the task state as `lastErrorSignature`. If they are equal, the task fails for good
   with: "the same error came back on two attempts in a row, so Claudio did not try again". Code
   decides; `orchestration.retry` is not asked.
3. **Relation to the health signals.**

   | Signal | Scope | Evidence | Effect |
   |---|---|---|---|
   | `repeat-stall` | One execution | The same kind of command outlasting its limit, twice or more in a row | A health signal, and the supervisor's hint |
   | `loop` | One execution | The same call and answer, or the same error, four times in the last 12 calls | A health signal |
   | Plateau (new) | Across rounds or attempts | No criterion improved for two rounds; the same error signature twice | Ends the loop and waits for a person |

   - They share the "same thing again" normalisation: `flatten` from `health.ts` is exported and
     used by `failureSignature`.
   - A plateau is not a health signal. The chat itself is not stuck; the loop around it is.
4. **Project setting.** `ProjectFlowSettings.stopOnPlateau?: boolean`, parsed in
   `project-settings.ts` (a boolean, absent kept absent).
   - The Team screen's flow settings get a `Switch`, "Parar si dos rondas no mejoran", with a hint.
   - Strings go in `team.json`.

### Data model

None new. It reads `flow_runs.criteria`. `lastErrorSignature` lives in the orchestration document.
`stopOnPlateau` lives in the project settings JSON.

### API

- Shared: `ProjectFlowSettings.stopOnPlateau`, and `OrchestrationTaskState.lastErrorSignature?`
  (internal, but in the stored document).
- The cause code `flow.plateau` is translated in `apps/web/src/pages/tasks/item/model.ts:203`
  (`CAUSE_KEY`) and the team and workItem locales.
- The schemas are regenerated.

### UI

- **The board card** in `waiting: 'bounces'` with the cause `flow.plateau`: the existing "te espera"
  strip, with the reason "Sin mejora en dos rondas".
- **The item history** shows the cause.
- **The Team screen** shows the switch.
- **States:** on (default), off, and a card stopped by the plateau versus by the bounce limit (two
  different texts).
- Nothing moves. The `idle` colour is used for "te espera".

### Edge cases

- **Criteria added or removed between rounds** (a person edits them). Comparisons use ids present
  in both runs. A new unmet criterion is not a regression, and a removed one is not an improvement.
- **Every unmet criterion needs a person.** Then nothing remains to compare. These do not bounce
  today either: they wait for approval.
- **QA returns no criteria** (an item without any). Fall back to comparing the verdict summary's
  signature. Two equal summaries in a row are not enough; three are needed, the same "two rounds"
  rule.
- **A person moved the card between rounds.** That starts a new round (`bounces` is reset on a
  person's move), so the history starts again.
- **`flow.bounce` is active and says "needs a person" first.** It wins, as today.
- **Task retries whose errors differ only in numbers or paths.** They are equal after
  normalisation, which is intended.
- **A rate limit or a budget cause.** Not retried today, so the plateau does not apply.

### Tests

- `packages/core/test/flow.test.ts`:
  - three verify runs with the same unmet ids stop at the second bounce, with `maxBounces` 5;
  - an improvement in the middle run does not stop;
  - `needsPerson` criteria are ignored;
  - a setting of `false` keeps the old behaviour;
  - the comment is English and names the ids;
  - a person's move resets the history.
- `packages/core/test/orchestrator.test.ts`: with `maxAttempts` 3, two attempts with the same error
  fail the task without a third. Different errors retry.
- `packages/core/test/project-settings.test.ts`: `stopOnPlateau` is parsed.
- `apps/web/test/plateau-cause.test.tsx` (new): the strip and history text, en/es.

### How to measure

- **The backtest before release.** A script over the current `flow_runs` replays `plateaued()` on
  every finished round. It reports:
  - how many rounds it would have stopped;
  - how many of those later passed (false stops);
  - the bounces it would have saved, with their cost from the chats' executions.

  Go if false stops are below 10 % of stops. Otherwise ship the default off and say so in
  [team-and-flow.md](../team-and-flow.md).
- **After release:** rounds stopped by plateau, cost saved, and how often a person then fixed the
  card versus sent it back to the flow unchanged.

---

## Idea 15 · Path-scoped rules instead of a growing `CLAUDE.md`

### Current state

- `ResourceKind` includes `rules` (`config/resources.ts:10`), so Settings → Extensions already lists
  and edits `.claude/rules/*.md`.
- The project assistant proposes only `agents`, `skills` and `commands`:
  - `ASSISTANT_RESOURCE_KINDS`, `packages/shared/src/assistant.ts:33`;
  - `AssistantResourceKind`, `types.ts:2825`;
  - `FRONTMATTER` at `assistant-answer.ts:123`, and the Spanish title map at `:249`.
- Flow members propose memory with the target kinds `instructions` (a `CLAUDE.md` section),
  `memory` and `journal` (`flow.ts:347` `TARGET_KINDS`; `types.ts:2668`).
  - `instructions` proposals are written into `CLAUDE.md` by `withText` (`memory-proposals.ts`)
    once a person approves.
  - Nothing proposes a rule scoped to paths.
- Claude Code loads `.claude/rules/*.md` as project memory. A rule whose front matter has `paths:`
  (a list of globs) is loaded only when the agent works on matching files.

### Change

1. **Assistant: rules as a resource kind.**
   - `AssistantResourceKind` becomes `'agents' | 'skills' | 'commands' | 'rules'`, and
     `ASSISTANT_RESOURCE_KINDS` adds `'rules'`.
   - `FRONTMATTER.rules`: "`paths` (a YAML list of globs relative to the project; the CLI loads the
     rule only when it works on matching files) and optionally `description`".
   - The title map gains `rules: 'regla'`.
   - In the resources proposal lines (`assistant-answer.ts`), after the "Propose only what …" line,
     add:

     > Propose a rule for guidance that concerns only part of the project (one package, one
     > language, the tests, the migrations) instead of a CLAUDE.md addition; keep CLAUDE.md for
     > what holds everywhere. A rule names in `paths` the files it is for.

   - `parseAnswer` drops a `rules` proposal whose content has no non-empty `paths` front matter
     list (`readFrontmatterList(content, 'paths')`), or whose globs fail validation. It records a
     finding: "dropped rule <name>: it names no paths".
2. **Flow members: a `rule` memory target.**
   - `MemoryProposalTargetKind` adds `'rule'`, and `MemoryProposalTarget` gains
     `paths: string[] | null`.
   - The `target` schema of `flowResultSchema` (`flow.ts:363`) gains `paths`. The kind enum
     description says: "rule: a path-scoped rule in `.claude/rules/<file>`, loaded only for files
     matching `paths`; prefer it to `instructions` when the text concerns only part of the
     project".
   - `file` names the rule file.
   - `targetOf` (`memory-proposals.ts:409`) validates `file` as a resource name plus `.md`, and
     `paths` (below).
   - Approving writes through `ConfigResources` in project scope:
     - **a new file:** `---\npaths:\n  - "<glob>"\n---\n\n<text>\n`;
     - **an existing file with the same set of paths:** the text is appended;
     - **an existing file with other paths, or none:** 409 "`.claude/rules/<file>` exists with other
       paths; approve it under another name". The approve dialog lets the person rename `file`
       first.
3. **Glob validation (shared).** 1 to 10 globs. Each:
   - is relative, with no leading `/` and no `..` segment;
   - is at most 200 characters;
   - uses only `[A-Za-z0-9_.*?{}\[\]/,-]` and spaces.
4. **The `CLAUDE.md` nudge.**
   - `RECORDS_IN_ENGLISH` and the memory proposal descriptions stay as they are.
   - The flow's work and refine stages already list `memoryProposals`. The target description above
     is what steers them.
5. **UI.**
   - **Memory proposal card:** the target as "Regla · `.claude/rules/<file>` · `<paths…>`" in mono,
     with paths beyond 3 folded.
   - **Approve dialog:** a text input to rename `file` when the 409 comes back.
   - **Assistant proposals list:** a `rules` kind label "Regla", and the content preview shows the
     front matter.
   - Strings go in `assistant.json` and the memory-proposals namespace (`team.json` or wherever
     proposals are labelled today), en/es.

### Data model

Migration M1 adds `ALTER TABLE memory_proposals ADD COLUMN target_paths TEXT;` (a JSON array, or
null).

### API

- Shared: `AssistantResourceKind`, `ASSISTANT_RESOURCE_KINDS`, `MemoryProposalTargetKind`,
  `MemoryProposalTarget.paths`, `MEMORY_PROPOSAL_TARGET_KINDS`.
- The OpenAPI descriptions of the memory proposal routes say what `rule` writes and when approval
  answers 409.
- The README's memory proposals row names `rule`.
- Chat tokens: approving a proposal is already the person's. No change.

### Edge cases

- **A proposed rule identical to a `CLAUDE.md` section.** Duplicate detection compares text within
  the same target only, as today. A person sees both.
- **A glob that matches nothing today.** Allowed: a rule can be for files about to exist.
- **A project not under git.** It does not matter: rules are files.
- **Confined runs** (`--setting-sources=`: the assistant, decisions) do not load rules. That is
  intended; they read `CLAUDE.md` through Claudio's system prompt.
- **A rule file edited by the person** between proposal and approval. Append only when the paths
  match exactly; otherwise 409.
- **Name collisions with existing rule files from other tools.** Handled by the 409 and the rename.
- **An approved `rule` proposal on a project whose `.claude/` is not writable.** The error is
  surfaced as today's write errors.

### Tests

- `packages/core/test/assistant.test.ts`:
  - the `rules` kind is in the schema enum and in the prompt line;
  - a rule without paths is dropped with a finding.
- `packages/core/test/memory.test.ts` or the proposals tests: approving a `rule` handles a new file,
  an append with the same paths, and a 409 with different paths; glob validation; the target
  column round-trips.
- `packages/core/test/flow.test.ts`: the schema has `paths`, and a proposal with `kind: 'rule'` is
  parsed.
- `packages/core/test/db.test.ts`: `target_paths` exists after M1.
- `apps/api/test/team.test.ts` or `journal.test.ts`, wherever memory proposal routes are tested: the
  409 body.
- `apps/web/test/rule-proposal.test.tsx` (new): the target line, the rename on 409, en/es.

### How to measure

- `CLAUDE.md` size per project over time.
- `rule` proposals made, approved and rejected.
- `instructions` proposals per week (it should fall as rules take their place).

---

## Contract summary (task `s0`)

All in `packages/shared/src/types.ts` unless named. Then regenerate the schemas.

| Type | Change | Idea |
|---|---|---|
| `VerificationFix` | `+fixed?`, `+stop?` | 8 |
| `FlowCheckVerdict` (moved from `flow.ts:338`) | `+locations?`, `+stopped?` | 8 |
| `FlowRun` | `+checks?: FlowCheckVerdict[]` | 8 |
| `ToolRisk*`, `toolRisk()` | new, `packages/shared/src/tool-risk.ts` | 9 |
| `EditStep` | `+risk?: ToolRisk` | 9 |
| `ProjectTeamRole` | `+tools?`, `+writes?`, `+commands?` | 10 |
| `ProjectTeamMember`, `PutTeamMemberRequest` | `+tools?` | 10 |
| `ProjectTemplate` | `+optionalTeam` | 10 |
| `AppSettingValues` | `+dailySpendCapUsd: number \| null` | 13 |
| `SpendState`, `SpendLevel`, `SpendPurpose`, `SpendCapRefusal` | new | 13 |
| `SpendChangedEvent`, `SpendAlertEvent` | new, in the event union | 13 |
| `Orchestration` | `+spendPass?: string \| null` | 13 |
| Decision unavailable reasons | `+'spend-cap'` | 13 |
| `ProjectFlowSettings` | `+stopOnPlateau?` | 14 |
| `OrchestrationTaskState` | `+lastErrorSignature?` | 14 |
| `AssistantResourceKind` (+ `ASSISTANT_RESOURCE_KINDS` in `assistant.ts`) | `+'rules'` | 15 |
| `MemoryProposalTargetKind` (+ `MEMORY_PROPOSAL_TARGET_KINDS` in `work-items.ts`) | `+'rule'` | 15 |
| `MemoryProposalTarget` | `+paths: string[] \| null` | 15 |

## Migrations (task `s0`), appended at the end of `MIGRATIONS`

- **M1 (string):**
  - `CREATE TABLE spend_ledger` and its index;
  - `CREATE TABLE spend_alerts`;
  - `ALTER TABLE flow_runs ADD COLUMN checks TEXT;`;
  - `ALTER TABLE memory_proposals ADD COLUMN target_paths TEXT;`.
- **M2 (function):** the backfill of today's executions into `spend_ledger` (idea 13).
- Export `SPEND_SCHEMA_VERSION` (found by `findIndex`, like the others) for the upgrade test.

---

## Task graph: orchestration `agent-run-improvements`

### Launch settings

| Setting | Value |
|---|---|
| Engine | `graph` |
| Worktrees | yes |
| Concurrency | 4 |
| `maxAttempts` | 2 |
| Graph limits | `maxMinutes: 150`, `maxCostUsd: 15` per task |
| Model | `claude-sonnet-5-5` (the exact id) for every task except `s8` |
| Effort | the recommendation for the model |
| `verification.e2eSpecs` | `false`: workers never run e2e |

`verification`:

```json
{
  "commands": [
    ["pnpm typecheck", "pnpm --filter @claudio/api openapi:schemas && git diff --exit-code -- apps/api/src/openapi/schemas.json"],
    "pnpm test",
    "pnpm build"
  ],
  "fixer": true,
  "maxAttempts": 2,
  "maxCostUsd": 10,
  "timeoutMinutes": 30,
  "e2eSpecs": false
}
```

`pnpm e2e` runs once, by the integrator, on the merged branch, with a port of its own
(`E2E_PORT=<free>`), because another orchestration may be verifying on this machine. Nobody runs
`docker build` or `pnpm desktop:dist`.

**Rules every task prompt carries.** These are in addition to Claudio's own worker rules:

- Work only in your worktree, commit with Conventional Commits, and never push.
- Run `pnpm typecheck` and the tests of the packages you changed (`pnpm --filter <pkg> test`, or
  one file with `node scripts/test-tmp.mjs npx tsx --test <file>`). Never run `pnpm e2e`,
  `docker build` or `pnpm desktop:dist`.
- Search with `timeout 30 git grep -n`.
- Technical text is English.
- UI copy goes through i18n with en/es parity per `apps/web/src/i18n/GLOSSARY.md`.
- UI follows `docs/design-system.md`: tokens only, both themes, controls from
  `packages/ui/src/components/controls`.
- Migrations only at the end of `MIGRATIONS`.
- If you must change a shared type beyond what `s0` did, regenerate the schemas. A merge conflict
  in `apps/api/src/openapi/schemas.json` is resolved by regenerating, never by hand.

**Longest chain:** `s0 → s4 → s5 → s7`, four tasks.

| Id | Title | Depends on | Model |
|---|---|---|---|
| `s0` | Contract, migrations and the risk scorer | — | `claude-sonnet-5-5` |
| `s1` | Prompt rules: grounding, objective, retrieval, delegation, fixer stop rules | — | `claude-sonnet-5-5` |
| `s2` | Fixer and loop stops in the harness (ideas 8 and 14) | `s0` | `claude-sonnet-5-5` |
| `s3` | Risk score in the transcript, Step by step and urgency (idea 9) | `s0` | `claude-sonnet-5-5` |
| `s4` | Daily spend cap: ledger, gate and starters (idea 13, core) | `s0` | `claude-sonnet-5-5` |
| `s5` | Daily spend cap: API and web (idea 13) | `s4` | `claude-sonnet-5-5` |
| `s6` | Optional roles and path-scoped rules (ideas 10 and 15) | `s0` | `claude-sonnet-5-5` |
| `s7` | Docs, design system and glossary | `s1`, `s2`, `s3`, `s5`, `s6` | `claude-sonnet-5-5` |
| `s8` | Design and one-rule review | `s1`, `s2`, `s3`, `s5`, `s6` | `claude-opus-5-5` |

### `s0` · Contract, migrations and the risk scorer

**Files:**

- `packages/shared/src/types.ts`;
- `packages/shared/src/tool-risk.ts` (new), `packages/shared/src/index.ts`;
- `packages/shared/src/assistant.ts`, `packages/shared/src/work-items.ts`;
- `packages/shared/test/tool-risk.test.ts` (new);
- `packages/core/src/db.ts`, `packages/core/test/db.test.ts`;
- `packages/core/src/flow.ts` (only to import `FlowCheckVerdict` from shared);
- `packages/core/src/assistant-answer.ts` (only the `FRONTMATTER.rules` and title-map entries the
  wider union forces);
- `packages/core/src/paths.ts`, `packages/core/src/app-settings.ts` (only the new key's default,
  env variable and `parseValue` case);
- `apps/api/src/openapi/schemas.json` (regenerated).

**Prompt:**

> Make the shared contract and the storage for docs/plans/agent-run-improvements.md, and build the
> tool risk scorer. Read the plan's "Contract summary", "Migrations" and "Idea 9 · Change: the
> scorer" first.
>
> (1) In `packages/shared/src/types.ts`, make every change of the Contract summary table, each with
> a doc comment that says why, in the style of the file. Move `FlowCheckVerdict` from
> `packages/core/src/flow.ts:338` into shared and import it back. Add `'rules'` to
> `ASSISTANT_RESOURCE_KINDS` (`packages/shared/src/assistant.ts:33`) and `'rule'` to
> `MEMORY_PROPOSAL_TARGET_KINDS` (`packages/shared/src/work-items.ts:233`).
>
> (2) Make only the edits these force elsewhere to keep `pnpm typecheck` green, with no behaviour
> change:
> - `FRONTMATTER.rules` and the `rules: 'regla'` title entry in
>   `packages/core/src/assistant-answer.ts`;
> - `dailySpendCapUsd` in `DEFAULT_APP_SETTINGS` (`null`) and `APP_SETTING_ENV`
>   (`CLAUDIO_DAILY_SPEND_CAP_USD`) in `packages/core/src/paths.ts`;
> - its environment parsing, and a `parseValue` case in `packages/core/src/app-settings.ts`:
>   a number greater than 0 and at most 100000, rounded to cents, or null.
>
> Until `s6` builds it, `targetOf` in `packages/core/src/memory-proposals.ts` must refuse a
> `rule` target with 400 "rule targets are not supported yet".
>
> (3) Append migrations M1 (string) and M2 (function) at the end of `MIGRATIONS` in
> `packages/core/src/db.ts`, exactly as the plan's Migrations section says, after the current last
> entry (`ALTER TABLE provider_limits ADD COLUMN overage TEXT;`). Export `SPEND_SCHEMA_VERSION` the
> way `JEV_COST_SCHEMA_VERSION` is found. In `packages/core/test/db.test.ts`, add an upgrade test
> from the version before M1: the tables and columns exist, and M2 inserts one ledger row per
> execution that ended today with a cost, and none for yesterday's.
>
> (4) Write `packages/shared/src/tool-risk.ts` as the plan specifies: the types, the weights, the
> levels, the Bash segmenting and quote and heredoc stripping, every factor's matchers, the
> regenerable targets, the path rules, the MCP verbs and the medium cap, the 64 KiB bound. Use pure
> string code with no Node imports, since `@claudio/chat-ui` runs it in the browser. Export it from
> the package index. Write `packages/shared/test/tool-risk.test.ts` with at least 60 table cases
> covering every bullet of the plan's scorer and edge-case lists.
>
> (5) Run `pnpm --filter @claudio/api openapi:schemas` and commit the result.
>
> Run `pnpm typecheck` and the shared and core tests you touched. Conventions: TypeScript strict,
> no `any`, `noUncheckedIndexedAccess`, comments say why.

**Acceptance criteria:**

1. `pnpm typecheck` passes at the repository root.
2. `packages/shared/test/tool-risk.test.ts` has at least 60 cases and passes. It includes:
   - `rm -rf node_modules` → low;
   - `git push --force origin main` → high with `history-rewrite` and `leaves-machine`;
   - `echo "rm -rf /"` → low;
   - a `Write` to `/etc/hosts` from a chat in `/home/x/p` → high `outside-workdir`;
   - a `Write` to `.github/workflows/ci.yml` → medium;
   - `mcp__github__delete_repo` → medium;
   - `Read` of `.env` → medium `secrets`.
3. `db.test.ts` upgrades from the version before M1 and checks every new table and column, and the
   backfill's day window.
4. `apps/api/src/openapi/schemas.json` matches what `openapi:schemas` generates.
5. No behaviour changes outside the scorer: the existing core and API tests pass unchanged, and a
   `rule` memory target is refused with 400.

### `s1` · Prompt rules: grounding, objective, retrieval, delegation, fixer stop rules

**Files:**

- `packages/core/src/prompt-rules.ts`, `packages/core/src/open-items.ts`;
- `packages/core/src/orchestrator.ts`: `PLANNER_GRAPH_GUIDANCE`, `workerHead`, `workerTask`,
  `buildPrompt`, `compile`, `launchWorkflow`'s prompt, and the `settleNow` call of `openItems`
  inputs only;
- `packages/core/src/flow.ts`: `flowPrompt`, `checksFixPrompt`, and the `finish` call of
  `structuralItems` only;
- `packages/core/src/verification.ts`: `fixerPrompt` only;
- `packages/core/test/prompt-rules.test.ts`, `packages/core/test/flow.test.ts`,
  `packages/core/test/orchestrator.test.ts`, the `workflow-engine` tests;
- `docs/prompts.md`, `docs/orchestrations.md`.

**Prompt:**

> Build the prompt changes of ideas 6, 7, 8 (prompt half) and 12 of
> docs/plans/agent-run-improvements.md. Copy the exact English texts from the plan.
>
> (1) In `packages/core/src/prompt-rules.ts`, add `PATTERN_GROUNDING`, `RETRIEVAL`, `DELEGATION`,
> `FIX_ONE_AT_A_TIME`, `FIX_STOP_WHEN` and `FIXER_REPORT_ROWS`, each with the doc comment the plan
> gives.
>
> (2) Idea 6:
> - append the planner sentence to `PLANNER_GRAPH_GUIDANCE` (`orchestrator.ts:302`);
> - add `PATTERN_GROUNDING` and its heading sentence to both refine branches of `flowPrompt`
>   (`flow.ts:718` and `:726`) right after `EXPLORE`.
>
> (3) Idea 7:
> - change `workerHead` (`orchestrator.ts:925`) to take the task, and return the objective (or the
>   graph's name) and the list of the other tasks in one `pasted()` block, capped at 30 lines with
>   names clipped to 80 characters;
> - pass the task from `buildPrompt` (`:944`) and `compile` (`:2551`);
> - push `RETRIEVAL` in `workerTask` (`:929`) right after `REAL_VERIFICATION`.
>
> (4) Idea 12:
> - push `DELEGATION` in the workflow lead prompt (`:2589`, before `timeSignal`), in `workerTask`
>   after `UNATTENDED`, in the flow work stage after `scopeAndCompletion()`, and in `fixerPrompt`
>   after `UNATTENDED`;
> - in `packages/core/src/open-items.ts`, add `delegates` to `OpenItemsInput` and its structural
>   item, and the three `WAITING` phrase patterns with their item;
> - pass the running background subagents and tasks (`SubagentInfo.background && status ===
>   'running'`; `BackgroundTask.status === 'running' && !backgroundedByUser`) from
>   `FlowService.finish` (`flow.ts:1683`) and `Orchestrator.settleNow`.
>
> (5) Idea 8, prompt half:
> - add `FIX_ONE_AT_A_TIME` and `FIX_STOP_WHEN` to the rules block of `fixerPrompt`
>   (`verification.ts:358`), and `FIXER_REPORT_ROWS` after its closing report line;
> - in `checksFixPrompt` (`flow.ts:634`), add the two rules and replace the report sentence with the
>   plan's `locations`/`stopped` sentence. Do not touch the result schema: `s2` does.
>
> (6) Docs: update `docs/prompts.md` (the shared texts table, the inventory where texts were added,
> each affected prompt's point-by-point section, Known gaps for the English-only phrases, How it is
> tested) and add rule 7 to `docs/orchestrations.md`.
>
> Tests: the plan's Tests sections of ideas 6, 7, 8 (the prompt parts) and 12. Keep the
> banned-phrasing search green.

**Acceptance criteria:**

1. `prompt-rules.test.ts` pins each of the six texts exactly, and the banned-phrasing search passes.
   `RETRIEVAL` contains none of "avoid", "minimi", "fewer tool", "do not read".
2. A worker prompt (over the fake CLI in `orchestrator.test.ts`):
   - lists its own id and the other tasks inside one pasted block;
   - names the graph when there is no objective;
   - is capped at 30 listed tasks plus "and N more";
   - holds `RETRIEVAL` and `DELEGATION`.
3. Both refine branches hold `PATTERN_GROUNDING`; work and verify do not. The planner prompt holds
   the new guidance sentence.
4. `structuralItems` returns the delegation item for running background agents or tasks, and not
   for person-backgrounded tasks. A flow work run and a worker whose result arrives with a running
   background subagent are continued once (a test each).
5. `fixerPrompt` and `checksFixPrompt` hold the stop rules. `docs/prompts.md` and
   `docs/orchestrations.md` describe every new text.

### `s2` · Fixer and loop stops in the harness (ideas 8 and 14)

**Files:**

- `packages/core/src/verification.ts`: `failureSignature`, `errorCount`, `parseFixerReport`;
- `packages/core/src/health.ts` (export `flatten`);
- `packages/core/src/orchestrator.ts`: the verification loop around `:1882`–`:1935`, `fix`,
  `settleNow` retries;
- `packages/core/src/flow.ts`: the result schema and `parseResult` for checks, storing
  `flow_runs.checks`, `plateaued()` and its use in `finish`, `FLOW_CAUSE.plateau`;
- `packages/core/src/decisions/checks-fix.ts` (`historyAllows`, called from `decide`; do **not**
  edit `hasRoom`, which `s4` changes);
- `packages/core/src/project-settings.ts`;
- `apps/web/src/components/VerificationCard.tsx` and the fix panel component (find it with
  `timeout 30 git grep -n "fix-panel" apps/web/src`);
- `apps/web/src/pages/tasks/item/model.ts`, the Team flow settings component;
- locales `orchestrationV2.json`, `checks.json`, `team.json`, `workItem.json` (en/es);
- tests: `verification.test.ts`, `orchestrator.test.ts`, `flow.test.ts`, `checks-fix.test.ts`,
  `project-settings.test.ts`, `apps/web/test/verification-card.test.tsx` (new),
  `apps/web/test/plateau-cause.test.tsx` (new).

**Prompt:**

> Build the harness halves of ideas 8 and 14 of docs/plans/agent-run-improvements.md. The prompt
> texts are `s1`'s; you read what the fixer writes.
>
> (1) Idea 8, orchestration. In `packages/core/src/verification.ts`, add the pure functions
> `failureSignature`, `errorCount` (every format of the plan's table, null when unknown) and
> `parseFixerReport`, each with a comment on why. Export `flatten` from `health.ts:111` and reuse
> it. In the verification loop of `orchestrator.ts`:
> - keep each failed check's signature and count before and after each attempt;
> - put the parsed `[FIXED]` rows on `VerificationFix.fixed`;
> - conclude `failed` on a fixer `[STOP]`, on more errors, and on the same signature surviving three
>   attempts, with the plan's exact report sentences and `VerificationFix.stop`;
> - keep the order: `spentOut`, cost, the new rules, then `fixerGivenUp`.
>
> (2) Idea 8, flow:
> - extend the work schema's `checks` items (`flow.ts:411`) with `locations` and `stopped`;
> - validate them in `parseResult` (`flow.ts:2289`);
> - store the verdicts as JSON in `flow_runs.checks` (the column exists after `s0`), like `criteria`
>   at `flow.ts:1616`, and serve them on `FlowRun.checks`;
> - add `historyAllows` to `ChecksFix` and call it from `decide()` before `hasRoom`, with the item
>   comment the plan gives;
> - a person's click is never refused.
>
> (3) Idea 14:
> - add `plateaued()` to `flow.ts` and use it in `finish` on a rejected verify, before the bounce,
>   while `flow.stopOnPlateau !== false`, with the cause `flow.plateau` and the English comment;
> - parse `stopOnPlateau` in `project-settings.ts`;
> - in `settleNow`, store `lastErrorSignature` and end retries when two consecutive errors have the
>   same signature.
>
> (4) UI:
> - the "Arreglos" rows and the stop tag in `VerificationCard.tsx`;
> - the locations and the stop under each check in the fix panel;
> - the `flow.plateau` cause in `apps/web/src/pages/tasks/item/model.ts:203` (`CAUSE_KEY`) and the
>   card strip;
> - the `stopOnPlateau` `Switch` in the Team screen's flow settings.
>
> Follow docs/design-system.md: status words with colours, warn for a stop, nothing moves, both
> themes, phone wrap.
>
> Tests: every case in the Tests sections of ideas 8 (harness) and 14.

**Acceptance criteria:**

1. `failureSignature`, `errorCount` and `parseFixerReport` have unit tests for every case the plan
   lists, and pass.
2. Over the fake CLI:
   - a `[STOP] design` ends verification `failed` after one attempt;
   - a rising TAP fail count stops with `more-errors`;
   - with `maxAttempts` 5, an unchanged signature stops after the third attempt;
   - `[FIXED]` rows appear on `VerificationFix.fixed`.
3. Flow:
   - `locations` and `stopped` are in the schema and stored in `flow_runs.checks`;
   - `historyAllows` refuses after a `design` stop and after two fixed-then-failing runs, each with
     its comment;
   - a person's fix is not refused.
4. With `maxBounces` 5, three verify runs with the same unmet ids put the card in `waiting:
   'bounces'` with the cause `flow.plateau` after the second bounce. An improvement does not.
   `stopOnPlateau: false` keeps the old behaviour.
5. Two task attempts with the same normalised error fail the task without a third, when
   `maxAttempts` is 3.
6. The web tests for the card rows, the stop tag, the plateau text and the switch pass in en/es.
   `pnpm typecheck` passes.

### `s3` · Risk score in the transcript, Step by step and urgency (idea 9)

**Files:**

- `packages/core/src/edit-steps.ts`;
- `packages/core/src/push.ts`;
- `packages/core/src/decisions/points.ts` (`notification.urgency`: field `risk`, `stateVersion: 2`);
- `packages/core/src/index.ts` (wire `recentRisk`);
- `packages/chat-ui/src/components/Transcript.tsx`,
  `packages/chat-ui/src/components/PermissionPrompts.tsx`;
- `packages/chat-ui/src/locales/{en,es}/chat.json`;
- `apps/web/src/components/changes/steps/StepsLens.tsx`, `steps-model.ts`;
- `apps/web/src/i18n/locales/{en,es}/changes.json`;
- the step routes' OpenAPI descriptions in `apps/api/src/openapi/routes.ts`;
- tests: `edit-steps.test.ts`, `push.test.ts`, `decision-points-runtime.test.ts`,
  `packages/chat-ui/test/tool-risk-tag.test.ts` (new), `apps/web/test/steps-risk.test.tsx` (new).

**Prompt:**

> Show the tool risk score of idea 9 of docs/plans/agent-run-improvements.md. The scorer `toolRisk`
> exists in `@claudio/shared` (task `s0`); do not change its rules here. If a rule is wrong, say so
> in your report.
>
> (1) In `packages/core/src/edit-steps.ts`, set `EditStep.risk` from `toolRisk` with the chat's
> directory, plus the worktree as a root when there is one. Leave it absent when the level is low.
>
> (2) In `packages/core/src/push.ts`:
> - add a `recentRisk(runId)` dependency, the highest-risk call of the chat in the last 10 minutes,
>   formatted, redacted with `decisions/redact.ts` and clipped to 300 characters;
> - pass it as `risk` in `askUrgency` (`push.ts:420`);
> - add `risk` to the `notification.urgency` fields in `decisions/points.ts:219` and set its
>   `stateVersion` to 2;
> - wire `recentRisk` in `packages/core/src/index.ts` from the chat's live trace.
>
> (3) In `@claudio/chat-ui`:
> - the `Tag` after `.tool-hint` on tool rows in `Transcript.tsx:352`;
> - the `.permission-risk` line in `ToolPrompt` (`PermissionPrompts.tsx:62`);
> - high is `bad` with `ShieldAlert` and the factor word, medium is `muted`, low shows nothing;
> - a `Tooltip` with the reason;
> - en/es strings in the chat-ui locales.
>
> (4) In Step by step, the row tag, the scrubber's `data-risk="high"` with an aria-label that says
> it, and the tag in the `Why` header.
>
> (5) Update the step routes' OpenAPI descriptions.
>
> Follow docs/design-system.md: nothing moves, status colour always with a word, both themes, phone
> layout with ≥ 44 px targets. Do not add any hook or anything that blocks a call.

**Acceptance criteria:**

1. An `Edit` of `.github/workflows/ci.yml` yields `risk.level === 'medium'`, and a `Write` to an
   absolute path outside the chat's directory and worktree yields `high` (`edit-steps.test.ts`).
2. `push.test.ts`:
   - the urgency state carries `risk` when the run made a high-risk call in the last 10 minutes, and
     not otherwise;
   - it is redacted and at most 300 characters;
   - `notification.urgency` has `stateVersion` 2, and a consent for version 1 no longer counts.
3. The transcript tag renders the word for each high factor and nothing for low. The permission
   prompt shows the line and keeps its buttons unchanged.
4. Step by step shows the tag in the list and in the detail header, and marks high scrubber dots with
   an aria-label.
5. The en/es locales have the same keys. `pnpm typecheck` and the chat-ui, web and core tests
   touched pass.

### `s4` · Daily spend cap: ledger, gate and starters (idea 13, core)

**Files:**

- `packages/core/src/spend.ts` (new);
- `packages/core/src/chat-fold.ts` (`foldResult`, `:248`);
- `packages/core/src/live-chat.ts` (per-process baseline);
- `packages/core/src/chats.ts` (`ChatHost.recordSpend`, `ExecutionExtras.purpose`);
- `packages/core/src/flow.ts` (`claim`, `:1375`, inside the write transaction);
- `packages/core/src/orchestrator.ts` (the start of pending tasks in `schedule`, the workflow launch,
  `spendPass`);
- `packages/core/src/schedules.ts` (`fire`, `:633`);
- `packages/core/src/supervisor.ts`;
- `packages/core/src/decisions/providers/cli.ts`;
- `packages/core/src/decisions/checks-fix.ts` (`hasRoom` only);
- `packages/core/src/assistant.ts`, `packages/core/src/index.ts` (wiring, purposes, startup
  retention, the midnight timer, `spend.changed` and `spend.alert` on the bus);
- `packages/core/src/app-settings.ts` (`onChange` → gate);
- tests: `packages/core/test/spend.test.ts` (new), `chats.test.ts`, `flow.test.ts`,
  `orchestrator.test.ts`, `schedules.test.ts`, `checks-fix.test.ts`, `decision-engine.test.ts`,
  `supervisor.test.ts`, `app-settings.test.ts`.

**Prompt:**

> Build the core of the daily spend cap, idea 13 of docs/plans/agent-run-improvements.md. The
> contract and the `spend_ledger`/`spend_alerts` tables exist after `s0`.
>
> (1) Ledger:
> - in `foldResult` (`packages/core/src/chat-fold.ts:248`), compute the increase of the CLI's
>   cumulative `total_cost_usd` against a per-process baseline kept on the live chat, reset whenever
>   a process is spawned;
> - write one `spend_ledger` row per result through a new `ChatHost.recordSpend`, with `usd = 0,
>   reported = 0` when the result carried no cost;
> - add `purpose` to the start options every starter sets (the plan's list); person routes default
>   to `person`.
>
> (2) `packages/core/src/spend.ts`:
> - `SpendGate` with `state`, `allows` and `onChange`, exactly as the plan's "Change: the gate"
>   says: local-day window from local date parts, levels at 0.6, 0.75 and 1, cents rounding,
>   `unreported`, the breakdowns, the waiting counts;
> - alerts via `INSERT OR IGNORE` into `spend_alerts`, so only the inserting process emits
>   `spend.alert`;
> - a midnight timer re-armed daily, `unref`'d;
> - retention of 35 days at startup.
>
> (3) Gate every starter of the plan's table, and nothing else:
> - flow `claim` inside its write transaction (stays queued);
> - `Orchestrator.schedule`'s start of pending tasks and the workflow launch (stay pending unless
>   `spendPass` is today);
> - `schedules.ts` `fire` (a skipped run with the plan's sentence);
> - the supervisor (no call);
> - the `cli` decision provider (`unavailable: 'spend-cap'`);
> - `ChecksFix.hasRoom` (`checks-fix.ts:91`).
>
> In-flight work is never gated: continuations, retries, the integrator, verification and its
> fixer, synthesis, limit replays.
>
> (4) Expose `core.spend` for the API (`state`, `allows`, `grantPass(orchestrationId)`, and a
> `refusal()` helper that builds the `SpendCapRefusal` body). Emit `spend.changed` on the bus as the
> plan says. `onChange` re-dispatches the flow and schedules the running graphs.
>
> Do not touch the API or the web: `s5` does.

**Acceptance criteria:**

1. `spend.test.ts` covers:
   - the window across a DST change (the test fixes `TZ`);
   - the three level thresholds;
   - cent rounding at the cap;
   - `unreported`;
   - breakdowns by purpose and account kind;
   - `allows` with an override and with a graph pass;
   - one alert per day and level with two gates on one database;
   - the midnight re-arm;
   - 35-day retention.
2. Over the fake CLI, cumulative costs 0.10 then 0.25 write rows of 0.10 and 0.15. A respawned
   process restarts the baseline. A result without a cost writes `reported = 0`.
3. Over the cap:
   - a queued flow run stays queued in FIFO order and starts when the cap is raised;
   - pending tasks do not start unless the graph has today's pass;
   - a graph whose tasks have all started still runs verification and its fixer;
   - a schedule slot is `skipped` with the reason;
   - `checks.fix` starts nothing;
   - the supervisor makes no call;
   - the `cli` decision provider answers `unavailable: 'spend-cap'`.
4. With no cap set (the default), every existing core test passes unchanged.
5. `pnpm typecheck` passes.

### `s5` · Daily spend cap: API and web (idea 13)

**Files:**

- `apps/api/src/routes/spend.ts` (new), `apps/api/src/routes/app-settings.ts`;
- `apps/api/src/routes/chats.ts`, `orchestrations.ts`, `assistant.ts` (the 409 and the override
  header on the plan's listed routes);
- `apps/api/src/security.ts` (the new denials);
- `apps/api/src/openapi/routes.ts`, `README.md` (REST rows only);
- `apps/web/src/api.ts`;
- `apps/web/src/pages/config/AppSettingsCards.tsx`;
- `apps/web/src/components/shell/StatusBar.tsx`;
- `apps/web/src/pages/Usage.tsx`;
- the board card and orchestration header wait lines;
- the chat page's send error handling and a shared `SpendCapDialog`;
- `packages/shared/src/notifications.ts` (`spend.alert` → draft);
- locales `config.json`, `shell.json`, `usage.json`, `orchestration.json`, `work.json`,
  `chats.json`, `components.json` (en/es);
- tests: `apps/api/test/spend.test.ts` (new), `apps/api/test/security.test.ts`,
  `apps/api/test/app-settings.test.ts`, `apps/web/test/spend-cap.test.tsx` (new),
  `packages/shared/test/notifications.test.ts`;
- `e2e/specs/spend-cap.spec.mjs` (new, **not run**).

**Prompt:**

> Build the API and the web of the daily spend cap, idea 13 of
> docs/plans/agent-run-improvements.md, on the core `s4` built (`core.spend`).
>
> (1) API:
> - `GET /spend` (tag `Usage`) and `POST /orchestrations/:id/spend-pass` (tag `Orchestrations`),
>   each with a summary in `apps/api/src/openapi/routes.ts` and a row in the README's REST tables;
> - `dailySpendCapUsd` on `GET`/`PUT /settings/app`, with 403 when a chat's token names it in a
>   `PUT`;
> - on every route the plan lists under "Person routes", answer `409 { error, code: 'spend-cap',
>   spend }` when `core.spend.allows('person')` is false, unless the request carries
>   `X-Claudio-Spend-Override: 1` and is not authenticated by a chat token;
> - an override on a route that starts or resumes a graph grants that graph today's pass;
> - add the pass route to the chat-forbidden sets in `apps/api/src/security.ts:162`;
> - document the 409 and the header in OpenAPI;
> - update the `/settings/app` README row (`README.md:1245`).
>
> (2) Notifications: in `packages/shared/src/notifications.ts`, `spend.alert` makes a `limit` draft,
> `warn` normal and `exhausted` high, with en/es text through `NotificationText`.
>
> (3) Web, following docs/design-system.md and its checklist:
> - the "Tope de gasto diario" card in `AppSettingsCards.tsx` with every state of the plan;
> - the `.spend` item in `StatusBar.tsx` (hidden with no cap; neutral below 60 %, warn from 60 %,
>   bad from 75 % and when exhausted, each with its words);
> - the "Tope diario" line on the Usage page (desktop and phone);
> - the `.wait-line`s on the board card and the orchestration header, with "Seguir hoy de todos
>   modos";
> - a `SpendCapDialog` (`Dialog`, `Sheet` on a phone) used by chat send, New chat, plan, launch and
>   the orchestration actions, which resends with the header and remembers per chat and local day
>   in `sessionStorage`;
> - the `spend.changed` event invalidates the `['spend']` query.
>
> (4) Write `e2e/specs/spend-cap.spec.mjs` (set a cap, see it in the status bar, both themes), but
> **do not run e2e**. Say in your report that it has not been run.
>
> Strings in en/es per the glossary. Tokens only.

**Acceptance criteria:**

1. `apps/api/test/spend.test.ts`:
   - `GET /spend` returns `SpendState`;
   - each listed route answers 409 `spend-cap` over the cap and 2xx with the override header from
     the owner;
   - the header from a chat token still gets 409;
   - the pass route sets `spendPass` and answers 403 to a chat token;
   - a `PUT /settings/app` naming the cap from a chat token answers 403.
2. Every new route has a summary and a tag (the existing test passes) and a README row. The
   regenerated schemas have no drift.
3. `spend-cap.test.tsx`:
   - the status bar is hidden with no cap, and shows neutral, warn, bad and exhausted with their
     words;
   - the settings card shows off, on, env-set and invalid;
   - the dialog resends with the header and does not ask again for the same chat on the same day.
4. `spend.alert` makes the two drafts with the plan's priorities and tones (`notifications.test.ts`).
5. The en/es locale keys are at parity. `pnpm typecheck` and the API and web tests pass.
   `spend-cap.spec.mjs` exists and is reported as not run.

### `s6` · Optional roles and path-scoped rules (ideas 10 and 15)

**Files:**

- `packages/core/src/project-templates.ts`;
- `packages/core/src/team.ts` (`ROLE_GUIDANCE`, `agentFileContent`, `addFromTemplate`,
  `parseMemberRequest`);
- `packages/core/src/assistant-answer.ts` (optional roles line, rules prompt line, `parseAnswer`
  validation);
- `packages/core/src/assistant.ts` (`templateOffered`);
- `packages/core/src/memory-proposals.ts` (`rule` target, approval through `ConfigResources`);
- `packages/core/src/flow.ts` (the `target.paths` schema field and its parsing only);
- `apps/api/src/openapi/routes.ts` (descriptions of `from-template` and memory proposals), README
  (the memory proposals row);
- `apps/web/src/pages/team/Members.tsx`, the memory proposal card and approve dialog, the
  assistant proposals list;
- locales `team.json`, `assistant.json` (en/es);
- tests: `team.test.ts`, `assistant.test.ts`, the memory proposal tests, `flow.test.ts`,
  `apps/api/test/team.test.ts`, `apps/web/test/team-optional-roles.test.tsx` (new),
  `apps/web/test/rule-proposal.test.tsx` (new).

**Prompt:**

> Build ideas 10 and 15 of docs/plans/agent-run-improvements.md. The types exist after `s0`.
>
> (1) Idea 10:
> - add the four roles of the plan's table to `packages/core/src/project-templates.ts` and the
>   `optionalTeam` of each template as the plan says;
> - add their `ROLE_GUIDANCE` bodies to `team.ts:79`, with the exact English text; the build
>   resolver's body uses `FIX_ONE_AT_A_TIME`, `FIX_STOP_WHEN` and `REAL_VERIFICATION` from
>   `prompt-rules.ts`. If `s1` has not merged them yet in your worktree, add them exactly as the
>   plan gives them; the integrator keeps one copy;
> - write `tools:` in `agentFileContent` (`team.ts:215`) when a member has tools;
> - accept and validate `tools` in `parseMemberRequest`;
> - offer `team ∪ optionalTeam` in `addFromTemplate` (`team.ts:526`), adding only `team` when no
>   `roles` are given;
> - add the optional-roles sentence to the assistant's `teamMembers` lines;
> - on the web, add the "Más roles" menu and the "solo lectura" tag on the Team screen
>   (`apps/web/src/pages/team/Members.tsx`).
>
> (2) Idea 15:
> - add the rules prompt line to the assistant's resources section, and drop a proposed rule
>   without `paths` with a finding in `parseAnswer`;
> - implement the `rule` memory target in `memory-proposals.ts` (replace `s0`'s temporary 400):
>   validation of `file` and of the globs, approval writing `.claude/rules/<file>` through
>   `ConfigResources` (new file, append on the same paths, 409 on other paths), and `target_paths`
>   storage;
> - add `paths` to the target in `flowResultSchema` with the plan's description, and parse it;
> - on the web, the target line on the memory proposal card, the rename on a 409 in the approve
>   dialog, and the "Regla" label in the assistant's proposals.
>
> Update the OpenAPI descriptions and the README memory row. Strings in en/es per the glossary;
> follow docs/design-system.md.

**Acceptance criteria:**

1. `team.test.ts`:
   - `agentFileContent` writes `tools: Read, Grep, Glob, Bash` for the hunter and the analyst,
     `tools: Read, Grep, Glob, Bash, Write, Edit` for the spec miner, and no `tools` line for the
     build resolver;
   - `from-template` without `roles` adds exactly today's roles, and with `roles:
     ['silent-failure-hunter']` adds it with no flow column;
   - an unknown role's error lists both sets.
2. The flow passes a review role's `tools` in `--agents` (an existing `flowAgentsFile` test extended).
3. The assistant schema and prompt include `rules` and the rule line. A rule without `paths` is
   dropped with a finding.
4. Approving a `rule` proposal:
   - creates `.claude/rules/<file>` with the `paths` front matter;
   - appends when the paths are equal;
   - answers 409 when they differ;
   - stores and returns `target.paths`;
   - refuses invalid globs (`..`, an absolute path, more than 10) with 400.
5. The web tests for the roles menu, the read-only tag, the rule target line and the rename on 409
   pass in en/es. `pnpm typecheck` passes.

### `s7` · Docs, design system and glossary

**Files:**

- `docs/design-system.md`, `docs/design-system/claudio-ds.css`;
- `apps/web/src/i18n/GLOSSARY.md`;
- `docs/team-and-flow.md`, `docs/notifications.md`, `docs/decision-engine.md`,
  `docs/security-model.md`, `docs/assistant.md`, `docs/layered-settings.md`, `docs/deploy.md`,
  `docs/orchestration-timings.md` (if the verification stop lines appear there), `docs/status.md`;
- `README.md` ("How it talks to Claude" rows only);
- `docs/reports/ecc.md` (one line in §2 linking this plan);
- `docs/plans/agent-run-improvements.md` (Status and Outcome).

**Prompt:**

> Document what the orchestration built for docs/plans/agent-run-improvements.md. Read the merged
> code of `s1`–`s6` before writing, and write what it does, not what the plan hoped.
>
> (1) In `docs/design-system.md`, add each new variant, with what it means and which status colour
> and word it carries, and add it to `docs/design-system/claudio-ds.css` in the same commit:
> - the transcript and Step by step risk tag;
> - the permission prompt's risk line;
> - the status bar's `.spend`;
> - the spend `.wait-line` copy;
> - the `SpendCapDialog`;
> - the verification card's fix rows and stop tag;
> - the fix panel's locations;
> - the plateau strip text;
> - the optional roles menu and read-only tag;
> - the rule target line.
>
> (2) Add the plan's glossary rows to `apps/web/src/i18n/GLOSSARY.md`.
>
> (3) Update the docs in the file list:
> - `team-and-flow.md`: the plateau, the optional roles, rule proposals;
> - `notifications.md`: `spend.alert`, and urgency with risk;
> - `decision-engine.md`: `notification.urgency` field `risk` and `stateVersion` 2, `spend-cap`
>   unavailable;
> - `security-model.md`: the chat-token denials for the cap, the pass and the override;
> - `assistant.md`: the rules kind;
> - `layered-settings.md` and `deploy.md`: `CLAUDIO_DAILY_SPEND_CAP_USD`;
> - `status.md`.
>
> Keep each document's front matter and set its `updated_at`. In `README.md`, update the "How it
> talks to Claude" rows: the "Spending and time limits" row with the daily cap's source, and a row
> for `.claude/rules/*.md` with `paths:`. Add one line under the §2 table of `docs/reports/ecc.md`
> pointing to this plan for ideas 6–10 and 12–15. Set this plan's Status to built, with an Outcome
> section listing what changed from the plan.
>
> Technical text is English. Do not edit `CHANGELOG.md`.

**Acceptance criteria:**

1. Every new UI variant from `s2`, `s3`, `s5` and `s6` has an entry in `docs/design-system.md` and
   a rule in `claudio-ds.css`, and the web token test still passes.
2. The glossary has the nine rows, each with its Spanish form.
3. Each listed doc names the new behaviour with the file it lives in, and every touched doc has an
   updated `updated_at`.
4. The README's "How it talks to Claude" table names the cap's source (`total_cost_usd` of each
   `result`) and `.claude/rules/*.md`.
5. This plan's Status reads built, with an Outcome section.

### `s8` · Design and one-rule review

**Files:** none changed, unless a finding is a one-line fix the reviewer is sure of; otherwise its
report only.

**Prompt:**

> Review the merged work of `s1`–`s6` against docs/plans/agent-run-improvements.md, CLAUDE.md,
> CONTRIBUTING.md and docs/design-system.md. Check what automated checks cannot see. Do not re-run
> the whole test suite: verification does.
>
> Check:
> - **The one rule:** no SDK, no HTTP call to Anthropic, no hook added per tool call, no hand-priced
>   cost.
> - **The persistence split:** settings in JSON, records as rows; migrations only appended.
> - **Cross-process claims:** the spend alert's `INSERT OR IGNORE`, and the flow claim still in its
>   transaction.
> - **Safety:** `maxParallel`, `maxBounces`, budgets, the denied `git push` and the person-only move
>   to done are untouched; the cap never stops running work; chat tokens cannot raise the cap,
>   grant a pass or override.
> - **The prompt texts:** each against the twelve points of `docs/prompts.md`, with point 8 for
>   `RETRIEVAL`.
> - **The risk scorer's false positives:** run it over 200 real tool calls from this machine's
>   transcripts (read-only) and report the high flags you judge wrong.
> - **UI:** status colour with a word, the usage thresholds of 60 % and 75 %, both themes, phone
>   targets, en/es parity.
>
> Report each finding with `path:line`, the failure it causes, and the smallest fix.

**Acceptance criteria:**

1. The report covers every item of the checklist above, each marked pass or with findings.
2. Each finding has `path:line`, a concrete failure scenario and a proposed fix.
3. The scorer sample reports how many calls were scored high, and how many of those the reviewer
   judges wrong.

---

## Docs to update

These are done by `s1` and `s7`, and listed here so nothing is missed:

- `docs/prompts.md`:
  - the shared texts table;
  - the inventory;
  - the per-prompt points, including the point 8 note on `RETRIEVAL`;
  - Known gaps: the `WAITING` phrases are English;
  - How it is tested.
- `docs/orchestrations.md`: rule 7.
- `docs/team-and-flow.md`:
  - the plateau and `stopOnPlateau`;
  - the optional roles;
  - `rule` memory proposals;
  - the `checks.fix` history rule and `flow_runs.checks`.
- `docs/notifications.md`: `spend.alert`, and urgency with risk.
- `docs/decision-engine.md`:
  - `notification.urgency` field `risk`, `stateVersion` 2 (consent asked again);
  - `spend-cap` as an unavailable reason.
- `docs/security-model.md`: the chat-token denials (cap, pass, override).
- `docs/assistant.md`: rules proposals.
- `docs/layered-settings.md`, `docs/deploy.md`: `CLAUDIO_DAILY_SPEND_CAP_USD`.
- `docs/design-system.md`, `docs/design-system/claudio-ds.css`, `apps/web/src/i18n/GLOSSARY.md`.
- `README.md`:
  - REST rows for `GET /spend` and `POST /orchestrations/:id/spend-pass`;
  - the `/settings/app` row;
  - the memory proposals row;
  - "How it talks to Claude": the cap's source, and `.claude/rules/*.md`.
- `docs/status.md`.
- `docs/reports/ecc.md`: a link to this plan.

## Rollout

All of it ships in one pull request from the orchestration's integration branch, squash-merged.
After merge:

| Change | When it takes effect | Default |
|---|---|---|
| Prompt changes (6, 7, 8, 12) | The next run | Always on |
| Risk score (9) | At once | Display only, on. `notification.urgency` stays off, and if it was active it needs a new consent (stateVersion 2) |
| Fixer stops (8) | The next verification | On: they only stop sooner |
| `checks.fix` history rule (8) | — | Inert while `checks.fix` is off (its default) |
| Spend cap (13) | When the owner sets a cap | Off (`null`) |
| Plateau (14) | The next round | On by default, after the backtest (decision 9). If the backtest shows more than 10 % false stops, `s7` documents the default as off, and the parsing default flips in the same PR |
| Optional roles (10) | When offered | Opt-in per project |
| Rule proposals (15) | The next assistant or flow run | On, as a kind of proposal a person approves |

## Rollback

- **Revert the squash commit.** The new columns and tables are additive. Older code ignores them,
  and a database at a newer `user_version` opens fine (`migrate` stops at the version it knows,
  `db.ts:862`).
- **Keep placeholders for the two migrations if a later change adds migrations after a revert.**
  Do not delete M1 and M2. Turn them into `SELECT 1;` placeholders, so databases that ran them and
  databases that did not stay on the same numbering.
- **Turn features off without a revert:**
  - the cap: clear it;
  - the plateau: `flow.stopOnPlateau: false` per project;
  - `notification.urgency`: off;
  - the scorer: no switch, since it only displays. If it is noisy, its tables are data and can be
    tuned in a patch.

## Risks

| Risk | What holds it |
|---|---|
| Parallel tasks conflict in `orchestrator.ts`, `flow.ts`, `verification.ts`, the locales and `schemas.json` | Each task's prompt names the functions it owns; `s2` uses `historyAllows` so `s4` alone edits `hasRoom`; only `s0` regenerates schemas, and conflicts there are regenerated |
| The risk tags become noise | The regenerable list, quote stripping, `--dry-run`, the medium cap for MCP, nothing for low; `s8` samples 200 real calls; the tables are data |
| The cap stops a person's work by surprise | It asks instead of refusing, remembers the answer per chat and day, never stops running work, and is off by default |
| Agents spend past the cap through the API | Chat tokens can neither override nor raise it, nor grant a pass |
| Plateau stops a card that would have passed | The backtest before the default, the per-project switch, and it only waits for a person |
| A path-scoped rule hides guidance where it is needed | It must name `paths`; guidance for everywhere stays in `CLAUDE.md`; every rule is a person's approval |
| `RETRIEVAL` reads as discouraging tool use | Its wording, the `s1` banned-word test, and `s8`'s point-8 check |

## Resolved questions (2026-10-15)

Answered by the integrator on the owner's behalf. Where an answer differs from a section above,
the answer wins, and the task that builds the affected part follows it.

1. **The cap counts every cost the CLI reports.** One metric, the one Claudio already shows
   everywhere. For subscription accounts the UI labels it "API-equivalent cost" so nobody reads it
   as a bill. The cap ships **unset** (no cap until the person sets one), so nothing changes for
   anyone who does not opt in.
2. **Same pass for the flow.** A card waiting at the cap gets the same per-item "Keep going today"
   pass as a graph: person only (chat tokens get 403), valid until the day boundary, recorded. One
   mechanism for both surfaces.
3. **Plateau ships in observe mode.** It runs from day one but only records a `plateau` health
   signal ("would have stopped here") without stopping anything, like the decision engine's
   shadow mode. After the backtest and two weeks of signals the owner switches it to `stop`.
   Setting: `plateau: 'observe' | 'stop' | 'off'`, default `observe`.

## Related

[[reports/ecc.md]] · [[plans/context-control.md]] · [[prompts.md]] · [[orchestrations.md]] ·
[[team-and-flow.md]] · [[decision-engine.md]] · [[notifications.md]] · [[security-model.md]] ·
[[assistant.md]] · [[layered-settings.md]] · [[design-system.md]] · [[plans/worker-checks.md]] ·
[[plans/verify-faster.md]] · [[plans/agent-observability.md]] · [[plans/changes-review.md]] ·
[[plans/code-hosts.md]] · [[plans/claude-only-fork.md]] · [[accounts.md]]
