---
title: Release readiness for Claudio's first release
tags: [release, status, ecc]
---

# Release readiness for Claudio's first release

Written 2026-10-16 by task z1 of the ECC orchestration, on the merge of every plan's branch. The e2e run
was z2's, which wrote no report of it; nothing here claims it.

## What the first release contains

Claudio is a REST API, a web UI and multi-agent orchestration around the Claude Code CLI, reached only
through the interfaces the CLI ships for programs. Version `0.1.0` (release-please writes the changelog
from the commits; `CHANGELOG.md` was not edited). Beyond the base product ([status.md](../status.md)), the
ECC research ([ecc.md](ecc.md)) is built in full:

| Idea | What ships | Doc |
| --- | --- | --- |
| ★1 Review gate | opt-in per graph, reviewers, verifier, fixer loop, person-only *Accept anyway*, card and findings in the diff | [orchestrations.md](../orchestrations.md#the-review-gate) |
| ★2 Lessons | mined from corrections, approved by a person, delivered, decayed, promoted to `CLAUDE.md` | [lessons.md](../lessons.md) |
| ★3 Guards | `PreToolUse` hooks through `--settings`, bundled read-only `guard.mjs`, events, settings, notices | [guards.md](../guards.md) |
| ★4 Context control | breakdown, *Compact now*, compactions | [context-control.md](../context-control.md) |
| ★5 Instruction evals | phases 1 and 2 (the second behind `evalsPhase2`, off) | [evals.md](../evals.md) |
| 6–15 | agent-run improvements, tool rows and live branches | [plans/agent-run-improvements.md](../plans/agent-run-improvements.md) |

Each plan has an Outcome section (what was built, what differs, known gaps), and its Status says built.

## Checks run

On the merged branch, with `CLAUDIO_*` variables of the orchestrating chat unset where noted.

| Check | Result |
| --- | --- |
| `pnpm typecheck` (9 workspaces) | clean |
| `pnpm build` | passes. It first failed: a merge left the review gate's finding-card comment unclosed in `changes.css`, which Lightning CSS refused to minify. Fixed |
| `@claudio/web` tests | 1594 of 1594 pass |
| `@claudio/core` tests | 3209 pass; the 120 guard-audit `todo` rows are expected. In the last full run `orchestrator`, `project-settings` and `team` failed and passed alone (load), `claudio-assistant-chat` is the environment row below, and a golden was refreshed after |
| `@claudio/api` tests | 428 of 429 pass; the one failure (T8-1, `security.test.ts`) and `claudio-assistant-chat` (core) fail only when `CLAUDIO_API_URL` or `CLAUDIO_CHAT_ID` leak in from a chat, and pass with them unset |
| shared, ui, chat-ui, accounts, mcp tests | exit 0 |
| OpenAPI schemas regenerated | no diff after the final regeneration (805 schemas) |
| README REST tables against `routes.ts` | all 438 documented routes have a row (the three plugin routes share one row); every route has a summary and tag |
| `git grep 'TODO(ecc)\|FIXME'` | nothing new |

What the merge needed fixing (all committed): the unfinished merges of g16, g17, v9, l10, l12, l13, f9 and
f10 (conflicts in `index.ts`, `db.ts`, `types.ts`, `agents-file.ts`, docs and fixtures); api test fixtures
that built a Core with guards on (a group-writable checkout under umask 002 fails the guard preflight);
the fake CLI sending the assistant's schema to the review reviewer; decision points now 29; two health
strings; goldens for the hardened `git diff -c diff.external=`; a test that counted every `guards/` file
as part of the bundled program; and `core.guardStatus()`, which now reports the launcher's real
preflight instead of always "available".

## What the owner must do before tagging

1. Run the e2e specs of guards, review gate, lessons and evals were
   written without ever running, with guessed selectors. Fix what the run shows.
2. Check the web against the design reference in both themes. Not done: `.guard-rules` and `.guard-rule`
   are defined twice with different styles (Settings card and rules Sheet); the eval classes
   (`evals-rate`, `evals-gate`, `evals-trend`, `evals-draft`) are not in `docs/design-system.md`.
3. Decide about the guards' 120 known bypasses ([guards-audit.md](guards-audit.md)): 26 are rated high.
   Guards are documented as defence in depth, not a sandbox; the release notes should say so.
4. The e2e and measured costs rest on the `haiku` fake runs: the review gate's `sonnet` reviewer and `opus`
   verifier cost was never measured, so the $5 default cap is an estimate.
5. Re-sync the knowledge base: `kb_add_document` failed on a locked database for `docs/lessons.md`, and the
   edited documents need the re-sync ([knowledge-base.md](../knowledge-base.md)).
6. Run the full suites once from a plain shell (no `CLAUDIO_*` in the environment), and `docker build` and
   `desktop:dist` once: none was run here.
7. Merge, let release-please open the release pull request, and review its changelog.

## Related

[[status.md]] · [[reports/ecc.md]] · [[guards.md]] · [[lessons.md]] · [[evals.md]]
