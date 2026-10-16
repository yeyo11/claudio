---
created_at: 2026-10-16T12:35:00Z
updated_at: 2026-10-16T12:35:00Z
tags:
    - plan
    - accounts
    - rotation
    - orchestration
    - claude-code
---
# Plan: an expired sign-in is out, rotates, and a retry chooses again

Status: **done** (2026-10-16), see Outcome. Fixes R2–R5 of [requests.md](../requests.md), found when the ECC
orchestration stalled on 2026-10-16: one account's OAuth session expired and could not be refreshed
(its stored copy had an empty `refreshToken`), and nine tasks failed on it while another account had
room. The limit fixes merged the same day (`1d2b21087`, `3ee906fb4`, `2d79a7daa`, `43611759d`) are
the base: read them first, keep their behaviour, and do not reintroduce limit detection from text.

The one rule holds: everything is read from what the Claude Code CLI ships (its exit, its stream-json
`result`/`system` events and its stderr as the CLI prints it, the files it writes). Claudio never reads
a `login` account's tokens; it may look at whether its credentials file exists, its modification time,
and whether the `claudeAiOauth` object has a non-empty `refreshToken` key (presence only, never the
value, and never logged).

## The failure, as recorded

- The CLI prints `Failed to authenticate: OAuth session expired and could not be refreshed` and the
  turn ends with an error result; the run's execution has `outcome: 'failed'` and that error.
- `claude auth status` still answers `loggedIn: true` for that dir, so `identify()`
  (`packages/accounts/src/identify.ts:17`) keeps `signedIn: true`; an unread account is
  `ASSUMED_IDENTITY` (`store.ts`). `choose.ts` keeps picking it.
- An orchestration task retried with `POST /orchestrations/:id/tasks/:t/retry` resumes the same chat
  (`retryTask`, `orchestrator.ts`), and the chat keeps its account, even one at its limit or signed
  out; `retry-clean` (a new chat) lets the rotation choose. A retried turn that hit a session limit
  was marked failed instead of moving (R5; the limit fixes above may already cover it).

## Decisions

1. **A sign-in failure is a state of the account, not of the task.** It is stored as
   `authFailedAt` (ISO) on the account in `accounts.json` (settings-shaped), cleared when the
   credentials file changes after that time (a new `claude auth login` or a copied file) or when a
   later run on that account succeeds. While set, the account reads `signedIn: false` with
   `signInState: 'expired'` and is never chosen.
2. **A sign-in failure moves the work like a limit does:** the account is marked, another account is
   chosen by the same rules (`choose`, policies, `rotateOnLimit` for a person's chat; automated work
   always), and the turn is replayed in the same chat on it. With no usable account, the work waits
   exactly as at a limit and the person is told why (the account needs a sign-in).
3. **A retry chooses its account again.** `retryTask` keeps the chat and its worktree, but the next
   execution runs on the account the rotation picks now, skipping accounts that are exhausted or
   expired; the chat's own account is kept only if it is usable.
4. **A file with no `refreshToken` is flagged at once** as `signInState: 'incomplete'` (the copy is
   broken), with the same exclusion and the same UI, before any run fails on it.
5. **UI:** the Accounts page and the status bar account card show "Sesión caducada" / "Sign-in
   expired" (status bad, with an icon and a word) and a "Volver a iniciar sesión" / "Sign in again"
   action that opens the existing sign-in panel for that account. A chat replayed because of it
   shows the same kind of line a limit switch shows today, with the reason in words.

## Starting point

`~/Escritorio/claudio-research/launch/expired-login-draft.patch` is an abandoned, uncommitted draft
of decision 1 (an `authFailedAt` on stored accounts in `packages/accounts/src/store.ts`,
`packages/shared/src/types.ts`, `apps/web/src/lib/events.ts`), made on top of `2d79a7daa`. Read it
and reuse what fits; it is not wired into core and has no tests.

## Task graph

Every worker is `claude-sonnet-5-5`, commits with Conventional Commits (no attribution lines), runs
`pnpm typecheck` and only the test files it adds or changes (`node scripts/test-tmp.mjs`), and never
runs e2e: task `z` does.

| Id | Title | Depends on |
| --- | --- | --- |
| `a1` | Accounts: the expired and incomplete sign-in state | — |
| `a2` | Core: a sign-in failure marks the account and moves the turn | `a1` |
| `a3` | Orchestrator: a retry chooses its account again (R4), and R5 confirmed | `a1` |
| `a4` | Web and API: the state shown, and sign in again | `a1` |
| `z` | Fake CLI, e2e and docs | `a2`, `a3`, `a4` |

### a1 — Accounts: the expired and incomplete sign-in state

- Files: `packages/accounts/src/{store,identify,choose,types}.ts` and their tests,
  `packages/shared/src/types.ts` (the `Account` fields), regenerated OpenAPI schemas.
- Do decisions 1 and 4: `authFailedAt` and `signInState: 'ok' | 'expired' | 'incomplete' | 'unknown'`
  on every account, the default (CLI's own) one included; `markAuthFailed(id, at)`,
  `clearAuthFailed(id)`; clearing on a newer credentials mtime or a later success; `choose` never
  picks an account whose `signInState` is not `ok`/`unknown`. The incomplete check reads only the
  presence of a non-empty `refreshToken` key. Unit tests for each transition, for `choose`, and that
  no token value is ever read into memory beyond the presence check or written to a log.

### a2 — Core: a sign-in failure marks the account and moves the turn

- Files: where a run's result and exit are folded (`packages/core/src/providers/claude-code/*`,
  `live-chat.ts`, `chat-service.ts`), `rotation.ts`, tests.
- Recognise the sign-in failure from what the CLI ships (the error result text and the exit as the
  CLI emits them; add a recorded fixture of that output under `packages/core/test/fixtures`), never
  from Claudio's own wording. On it: `markAuthFailed` for the run's account, then the same path a
  limit takes after the 2026-10-16 fixes (switch, replay in the same chat, or wait), with
  `reason: 'auth'` on the rotation event. A person's chat follows `rotateOnLimit`. Tests: an
  automated run and a person's chat each move to the next usable account; with none, they wait; the
  account is excluded until cleared.

### a3 — Orchestrator: a retry chooses its account again

- Files: `packages/core/src/orchestrator.ts` (`retryTask`), `chats.ts` (choosing the account for a
  resumed execution), tests.
- Do decision 3. Then reproduce R5 with the core fake CLI: a retried task whose first turn on an
  exhausted account hits the limit must move to another account, not end `failed`. If the limit fixes
  already make it pass, keep the test as the guard; if not, fix it.

### a4 — Web and API: the state shown, and sign in again

- Files: `apps/web` Accounts page and status bar account card, i18n `en`/`es` (GLOSSARY.md), the
  rotation line in the chat for `reason: 'auth'`, API route docs if a field is added.
- Do decision 5. Night Shift tokens only, both themes, status bad with a word and an icon, 44 px on a
  phone, the sign-in action reusing the existing sign-in panel. Web unit tests where the codebase has
  a pattern; regenerate the web fixtures.

### z — Fake CLI, e2e and docs

- Teach `e2e/fake-cli/claude` an `FAKE-AUTH-EXPIRED-ACCOUNT` line that answers the recorded sign-in
  failure only on the account whose token starts with `fake-expired` (like `FAKE-LIMIT-ACCOUNT`).
- Extend `e2e/specs/accounts.spec.mjs`: the chat moves to the other account, the expired account
  shows "Sign-in expired", and an orchestration task retried after an account ran out runs on the
  other one. Run `pnpm build` and then, alone, `E2E_SHARDS=1 E2E_PORT=8850 pnpm e2e accounts` and every
  other spec whose files this branch touched; fix what fails (app or spec, the right side). Ports
  8850–8853 are yours.
- Update `docs/accounts.md` (the states, the move on a sign-in failure, retry), `docs/requests.md`
  (R2–R5 closed with their commits) and this plan's status and Outcome.

## Outcome

Built on 2026-10-16, one commit per task: `c3480b0e0` (a1, the `signInState`), `6597a0341` (a2, a 401
result marks the account and moves the turn), `c493a8be9` (a3, a guard test) and `38810ccc6` (a4,
the state shown and `POST /accounts/:id/login`); z adds the fake CLI line and the e2e case.

- A sign-in failure is recognised from the error `result`'s `api_error_status: 401`, never from its
  wording. The recording is `packages/core/test/fixtures/replay/auth-expired.jsonl`; it follows the
  documented message and was not captured from a real expired session, so if a live run differs,
  change the one condition in `stream.ts`.
- a3 needed no source change: `chooseAccount` already runs at every launch, so a retry chooses
  again and a limit on it moves the turn. R5 is confirmed by `orchestration-retry-account.test.ts`.
  A retry does not skip an account that only 429'd earlier with no reading; it costs one turn.
- `AccountSwitchReason` gained `'auth'`.
- z: the fake CLI answers `FAKE-AUTH-EXPIRED-ACCOUNT` on a `fake-expired` token and
  `e2e/specs/accounts.spec.mjs` covers the move, the "Sign-in expired" state and an orchestration
  task after it. An e2e case for a task retried after an account ran out was not written: a task
  cannot be made to fail on one account in the fake, and core guards it. The e2e suite was not run
  by this task; it runs once on the merged branch.

## Related

[[requests.md]] · [[accounts.md]] · [[plans/claude-only-fork.md]] · [[plans/models-per-account.md]] ·
[[orchestrations.md]]
