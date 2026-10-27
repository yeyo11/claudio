---
created_at: 2026-10-26T19:30:00Z
updated_at: 2026-10-27T04:00:00Z
tags:
    - plan
    - goal
    - release
    - api
    - openai
---
# Goal: test, merge and release the OpenAI-compatible API

Status: **set by the owner on 2026-10-26; in progress** (see "Progress" below). This document is the goal a Claude Code session works to
until every box under "Done means" is ticked. It assumes the plan
([openai-compatible-api.md](openai-compatible-api.md)) and the spike
([openai-compatible-api-spike.md](openai-compatible-api-spike.md)).

## Where it starts

- All work is on one stack of local branches, never pushed. Checkpoint: `feat/openai-phase4` at
  `815618842` (worktree `/tmp/claudio-openai-p4`) passed lint, typecheck and test. It holds the plan,
  the spike, phases 1-4, the reviews' fixes, the API chat title and the origin-badge keyboard hint.
- Phase 5 (`POST /v1/responses`, `GET`/`DELETE /v1/responses/:id`) is being built on
  `feat/openai-phase5` (worktree `/tmp/claudio-openai-p5`), based on that checkpoint.
- `origin/main` is 80 commits ahead of the stack's base (`574199438`): v0.9.0 is released and the
  release-please PR #63 (0.9.1) is open. Merges now go through Sluice's merge queue.
- `/ui-review` is SHIPPABLE for both UI changes (the "API" origin badge; the badge hint by keyboard).

## Progress

- **2026-10-27, phase 5 closed.** Four review rounds on `/v1/responses` (the last two with an explicit
  "smallest correct change" rule, since each round found bugs in the previous round's code); the
  cycle was closed after the fourth, leaving the remaining edge cases as documented limits.
- **Real-client tests** (results in [openai-compatible-api.md](../openai-compatible-api.md#real-client-tests)):
  the Node SDK passed 9/9; the Python SDK found a real bug (the `retry:` field of `/v1` streams),
  fixed in `78b2ca25a`, then passed 4/4; Open WebUI ran a three-turn conversation correctly.
  Deviation from step 2: the test server used the owner's own Claude Code login, because a fresh
  `CLAUDE_CONFIG_DIR` has no sign-in; only Claudio's data was isolated.
- **Open choice for the owner (stop point):** idle API processes hold run slots for 10 minutes, so
  about eight conversations (three in Open WebUI, whose background tasks are chats too) make every
  other request answer 429. Asked three times on 2026-10-27, not answered yet.
- **Integration.** `origin/main` merged in `e240bf472`: conflicts in the migrations (main's
  `audit.route` shipped in v0.9.0 and keeps its place), their upgrade test, `docs/rest-api.md` and
  `docs/securing.md`; audit strings, OpenAPI schemas and the web strings snapshot regenerated.
  lint, typecheck and test pass through `verify`.
- **e2e.** This branch has no Sluice `e2e` gate (it is still uncommitted in the owner's checkout)
  and `pnpm e2e` refuses outside CI, so the suite ran on GitHub with `pnpm e2e:remote`: run
  40443085076, the whole suite in 4 shards, passed on `e240bf472`.
- **`/ui-review`** not repeated: the merge touched none of this stack's UI files, so both
  SHIPPABLE reviews stand.

## Done means

- [x] Phase 5 is built, reviewed (`code-review` at high), its findings fixed or disproved with a test.
- [ ] The surface works with real clients (see "Real-client tests"), and what they showed is in
      `docs/openai-compatible-api.md`. *(Tests done and written up; open until the owner chooses how
      idle API processes treat run slots, see "Progress".)*
- [x] The branch contains `origin/main`, every conflict resolved, OpenAPI schemas regenerated, and
      `verify` passes **lint, typecheck, test and e2e** on the final tree.
- [x] `/ui-review` is SHIPPABLE on the final tree for the screens the stack touches (run again only if
      the integration changed UI files).
- [ ] One pull request into `main`, squash title `feat(api): an OpenAI-compatible /v1 surface over
      Claude Code chats`, CI green, merged through Sluice's merge queue after the owner approved the
      train.
- [ ] The release that contains it (expected **v0.10.0**) is published: GitHub release Latest with the
      .deb, AppImage, signed server bundle and signed desktop manifest; image `ghcr.io/yeyo11/claudio`
      tagged; the apt repository lists it and `InRelease` verifies.
- [ ] After the release: knowledge base indexed, project memory updated, worktrees, branches and temp
      folders of this work removed, local `main` fast-forwarded.

## Steps

### 1. Close phase 5
1. Read the agent's report and check it against the branch: clean tree, checkpoint `815618842` still an
   ancestor, `verify` (lint, typecheck, test) green on the last commit.
2. `code-review` at high on `815618842..HEAD`; a developer agent fixes each finding in its own commit
   with a test that fails without it, or disproves it with a test or a trace.
3. A second review only if the first found a correctness bug in the held-call or state machinery.

### 2. Real-client tests
Against a server from the final branch, with an isolated data directory (own `CLAUDIO_DATA_DIR` and
`CLAUDE_CONFIG_DIR` scratch folders), the real CLI on `haiku`, `--max-budget-usd 0.5` per process, a
throwaway API token, loopback only:
1. The official `openai` SDK for Node (and for Python, if available on the machine) through
   `base_url = http://127.0.0.1:<port>/api/v1`: chat completions whole and streamed, `response_format`,
   one and two parallel tool calls with their results, and the same through `/v1/responses` with
   `previous_response_id`. The SDKs must parse every answer without errors.
2. Open WebUI pointed at the same base URL, if it can run locally (container): a conversation of three
   turns. Record the hidden requests it sends (titles, tags, follow-ups) and how many chats they create
   in Claudio. If they flood the chat list or cost noticeably, fix it before merging (for example a
   cheaper path for one-shot housekeeping prompts) or write it down as a known limit, with the owner's
   choice.
3. Write the results, costs and any limits in `docs/openai-compatible-api.md`.

### 3. Integrate `main`
1. Bring `origin/main` into the branch (a merge, so the reviewed commits keep their hashes), resolve
   every conflict on its merits, re-run `pnpm --filter @claudio/api openapi:schemas` if shared types
   moved, and check `ROUTE_DOCS` and `docs/rest-api.md` still cover every route.
2. `verify` with lint, typecheck and test, then with `e2e` (the `run-e2e` skill; spec prefixes for the
   chat and settings screens, then the whole suite if those pass).
3. `/ui-review` again only if the merge touched `apps/web`, `packages/ui` or `packages/chat-ui` files of
   this stack.

### 4. Pull request and merge
1. Push the branch, open one PR into `main` with: what the surface does, the decisions (link the plan
   and the spike), the limits (`_meta["claudecode/toolUseId"]` as the one soft spot; holds longer than
   30 minutes not measured; local use only under the subscription terms), the real-client results, the
   `/ui-review` reports, and the attribution line.
2. Watch CI with `--fail-fast` and start on the first failed check. Infrastructure failures are rerun
   once; real failures are fixed in new commits.
3. Commit, `verify`, then `queue_enqueue` with the branch's worktree. **Stop and tell the owner the job
   and train ids**: the owner approves the train (`sluice queue approve`). On a conflict or failed gate,
   fix, `verify`, `queue_retry`.

### 5. Release
1. After the merge, release-please updates its PR (today #63) to the next version. Check that the
   version is the expected minor bump and that CHANGELOG lists the feature.
2. Wait for that PR's CI to be green. **Stop and ask the owner before merging it.**
3. After the merge the Release workflow builds a draft. **The owner approves the `release`
   environment** (signing jobs). Watch the run to the end: `publish`, then `pages`.
4. Check the published release: Latest, assets present, image tag pulled, apt repo `Packages` lists the
   version, `InRelease` verifies, `Valid-Until` in the future.

### 6. After the release
- Index the new docs in the knowledge base (`kb_add_document`) and check `indexing_status`.
- Update the project memory (`project-openai-compatible-api.md`) to "released in vX".
- Remove `/tmp/claudio-openai-*`, `/tmp/claudio-ui-review-*`, `/tmp/claudio-origin-a11y*`,
  `/tmp/claudio-openai-title`, `/tmp/claudio-p4-*`, `/tmp/p4-split`, `/tmp/claudio-openai-safe`, their
  git worktrees, and the local and remote branches of this work; fast-forward local `main`.

## Stop points (the owner's, never the session's)
- Approving the Sluice merge train.
- Merging the release-please PR.
- Approving the `release` environment's signing jobs.
- Any choice the real-client tests raise (for example how to treat Open WebUI's hidden requests).

## Rules for the session
- Gates only through Sluice: the `verify` MCP tool; `sluice run <gate>` only if the tool is missing.
  A `KILLED for lack of memory` result is not flaky. Known flaky tests under load are rerun once.
- Every wait is bounded (`timeout`, a fixed number of checks, `curl --max-time 5`); never wait on a
  line that may not appear.
- Work in worktrees, never in the owner's checkout; never push to `main`, never force-push a shared
  branch, never approve a merge train.
- Commits in Conventional Commits, in English, ending with the session's `Co-Authored-By` line; the PR
  body ends with the session's attribution line. Never edit `CHANGELOG.md`.
- On a rate-limit cut, resume the agent with `SendMessage`; if it cannot resume, start a new one from
  the worktree's state and the last report.

## Out of scope (noted, not part of this goal)
- A Settings control for `openaiToolCallTimeoutMinutes` (owner: not now).
- Touch access to the origin badge's hint; hover-only hints on `StateBadge` and `ControlBadge`.
- `review-gate.ts`, `orchestrator.ts` and `evals/runner.ts` still matching "Concurrent run limit" by text.
- The ProviderDetector timing test and the client-disconnect test in `openai.test.ts`, both flaky under load.

## Related

[[openai-compatible-api.md]] · [[openai-compatible-api-spike.md]] · [[rest-api.md]] · [[e2e-through-sluice.md]] · [[updates.md]] · [[apt-repository.md]]
