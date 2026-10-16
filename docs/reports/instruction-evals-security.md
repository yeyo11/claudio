---
title: Instruction evals, Phase 2 security review (f10)
tags: [evals, security, review, phase-2]
---

# Instruction evals: Phase 2 security review

Phase 2 (pressure levels, the judge, the gate, case drafting, the `evalsPhase2` switch) reviewed against
the plan's "Security and privacy" section ([plans/instruction-evals.md](../plans/instruction-evals.md)),
item by item. The Phase 1 review is [instruction-evals-e14.md](instruction-evals-e14.md); this one covers
what Phase 2 added. Three findings were confirmed and fixed, each with a test.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| P2-1 | high | `PUT /settings/app` refused a chat's token only for `dailySpendCapUsd` (`apps/api/src/routes/app-settings.ts`). An injected chat could turn `evalsPhase2` on, which lets a judge spend and opens drafting, so the "person's click" boundary of items 2 and 3 had a hole. | Fixed: a chat token gets 403 for `evalsPhase2`. Test: `security.test.ts`, "a chat's token cannot give a graph the spend pass…". |
| P2-2 | high | `POST /assistant/proposals/:id/accept` is open to a chat's token (it decides "as that chat"). Accepting a drafted `eval-case` appends a case to a repository eval file, which `PUT /projects/:id/evals/:name` forbids a chat from doing (item 2, item 9: "a drafted case is a proposal that the person accepts"). | Fixed: `Assistant.accept` refuses an `eval-case` proposal to any actor that is not the person (403, proposal stays pending). Test: `assistant.test.ts`, "an agent cannot accept a drafted eval case…". |
| P2-3 | medium | Spending (item 3): the judge was built without `spendOpen`, so judges and calibration ignored the daily cap; `judgeFor` ignored the Phase 2 switch, so a Phase 1 request for a file that held `judged` expectations spent on a judge with the switch off; and `POST …/runs`, `…/resume` and `…/rejudge` had no `spendGate`, so they ignored the daily cap too (only `draft-cases` had it). | Fixed: `judgeFor` returns no judge while `evalsPhase2` is off (the check ends `unjudged`, nothing is spent) and passes `spendOpen: spend.allows('person')`; the three routes carry `spendGate`. Tests: `spend.test.ts` (runs and resume answer 409 `spend-cap`); the judge's own `spendOpen` is covered by `evals-judge.test.ts`. |
| P2-4 | low | The judge's `model` comes from the eval file and is passed to `--model` after only a length check; consent covers prompts, setup and commands, not the model. It is one argv element (no shell), so it cannot add a flag. | Open, accepted (same exposure as `runAs.model`). |
| P2-5 | low | A re-judge spends up to one `maxJudgeCostUsd` per unjudged check outside the run's reserved ceiling and without `confirmMaxCostUsd`. It starts only from the person's click, is bounded by the stored unjudged checks, and now honours the daily cap. | Open, accepted. |

## Items

1. **The one rule.** Holds. A judge is a housekeeping chat of `ChatManager` started with `runtime.start` and flags already in `providers/claude-code/args.ts:43-46` (`--restricted`, `--tools=`, `--setting-sources=`), `--json-schema` and `--max-budget-usd` (`packages/core/src/evals/judge.ts:145-170`), the shape of `decisions/providers/cli.ts:158-175`. No SDK, HTTP call or scraping. Drafting is an assistant run (`assistant.ts`), also a chat.
2. **Nothing starts on its own.** Holds after P2-1 and P2-2. Judges run only inside a run a person started (`runner.ts` `judgeFor`) or in a re-judge a person asked for (`routes/evals.ts` rejudge). `CHAT_FORBIDDEN_EVALS` (`apps/api/src/security.ts:314-324`) refuses rejudge, accept-judge and draft-cases to a chat token; `POST /projects/:id/assistant/runs` with `kind: 'evals'` is refused to a chat in `routes/assistant.ts:16`; `gate` stays readable. No MCP tool mentions evals (`packages/mcp/src`). The switch is off by default and, after P2-1, moved only by the person.
3. **Spending.** Holds after P2-3. Per judge: `--max-budget-usd` from `limits.maxJudgeCostUsd` (0.01–1, default 0.05; `judge.ts:158`, `packages/shared/src/evals.ts:82`). Per run: `judgeExtraUsd` is added to each sample's reservation, so the ceiling and `confirmMaxCostUsd` already cover judges (`runner.ts:205,388,503,576`); a judge's cost is added to the run (`runner.ts:1001`, calibration `:1023`). The estimate multiplies k × levels × variants. Daily cap: judges and the routes above. Waits at limits spend nothing (a judge at a limit is `unjudged`, `judge.ts:179`). See P2-5.
4. **Untrusted eval files.** Holds. Consent is per SHA and unchanged. A drafted case with a `command` check changes the SHA, so consent is asked again, and a `command` check needs consent even for a file Claudio wrote (`runner.ts:363-367`). Judge statements and calibration examples are sent only to the confined judge; they run nothing.
5. **Untrusted repository code.** Holds. The judge runs no code and has no tool: `confine: { tools: [], settingSources: [] }`, `JUDGE_POLICY` denies read, edit, commands, network and push, `permissionMode: 'dontAsk'`, no MCP (`judge.ts:34,164-166`). Phase 2 adds no `command` path.
6. **Secrets.** Holds. `api: false`, `uploads: false` (`judge.ts:162-163`). The judge's input is the stored, already masked material: calls are folded then `maskSecrets` (`runner.ts:299,960,1077`), the final text is masked and cut (`runner.ts:957`, stored `resultText` on re-judge). The verdict's `reason` is masked before storing (`runner.ts:1000`) and clipped to 400 characters (`judge.ts` `parseVerdict`); evidence is integers of known seqs only. The judge's prompt is never stored. Calibration examples come from the person's file and are not stored. Exports read the stored, masked rows.
7. **Isolation of variants.** Holds, nothing new: the gate writes nothing, and "Save proposed" only puts the text in the web editor, where the person presses Save (`putResource`). Drafted cases are written only through `appendCase` with `ifMatch` (`service.ts:129`), on the person's accept (P2-2).
8. **No pushes.** Holds. `JUDGE_POLICY.gitPush = 'deny'`; the assistant run uses `assistantPolicy()`, read-only.
9. **Prompt injection.** Holds. The transcript, the statement and the final text sit in one `pasted()` block with `PASTED_NOTE` (`judge.ts` `judgePrompt`; `prompt-rules.ts:150`), whose id is random per prompt, so a transcript cannot close the block. The judge has no tool, so the worst case is a wrong verdict, shown with its reason and evidence; a failure or an invalid verdict is `unjudged`, which fails closed in the gate (`gate.ts`, `incomplete`). Verdict evidence is cut to existing seqs. The drafting run's inputs (the target file, case titles) are pasted data, the run is read-only, and each proposal waits for the person (P2-2).
10. **Cleanup.** Holds. The judge chat is stopped, awaited and removed in `finally` (`judge.ts` `dispose`); Phase 2 adds no lane or file.
11. **Exports.** Holds. They read masked rows; judgements hold masked reasons, a model name and integer evidence.

## Checks

`pnpm typecheck` clean. Tests run: core `assistant`, `evals-judge`, `instruction-runner` (93 pass); api `spend`, `security`, `evals`, `app-settings`. No e2e run and no spec written.
