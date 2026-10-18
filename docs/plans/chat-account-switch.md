---
created_at: 2026-10-16T12:50:00Z
updated_at: 2026-10-18T12:00:00Z
tags:
    - plan
    - accounts
    - chat
    - composer
    - claude-code
---
# Plan: switch a chat's account from the composer

Status: **built** (2026-10-16). Builds R1 of [requests.md](../requests.md): the owner asked on
2026-10-15 to switch a chat's account "en caliente", automatically **and on demand**. The automatic
half exists (at a limit the turn is replayed on another account); this plan builds the on-demand
half. The owner chose the place on 2026-10-16: **an account section in the composer's "+" menu**,
beside the MCP servers.

The one rule holds: the switch is a new execution of the same session with `--resume` under the
chosen account's `CLAUDE_CONFIG_DIR` (or token), exactly as the rotation already does at a limit.
Stage A confirmed that `--resume` works across accounts ([reports/accounts-a0.md](../reports/accounts-a0.md)).

## Decisions

1. **Where:** a "Cuenta" / "Account" section in `ComposerMenu` (`packages/chat-ui/src/composer/ComposerMenu.tsx`),
   above the servers. One row per account: its name (alias or email), plan, the usage bar of its
   binding window (neutral below 60 %, warn from 60 %, bad from 75 % or exhausted, per the design
   system) and its state in words. The chat's current account is marked "En uso" / "In use". On a
   phone the menu is the existing `Sheet`.
2. **What can be chosen:** an enabled, signed-in account that is not exhausted. Others are shown
   disabled with the reason in words ("Agotada hasta 16:00", "Desactivada", "Sesión caducada" once the
   sign-in states of [rotation-auth-fixes.md](rotation-auth-fixes.md) exist — read
   `Account.signInState` when the field is there, otherwise only `enabled`, `signedIn` and the limit).
   An account that cannot run the chat's model (models per account, `GET /accounts/:id/models`) is
   disabled with "No ofrece <modelo>".
3. **When it applies:** idle chat with or without a live process: at once (the live process, if any,
   is ended between turns; the next message runs on the chosen account). Working chat: queued, applied
   when the current turn ends, never interrupting it; the row says "Al terminar este turno" / "When
   this turn ends" and the choice can be undone until then.
4. **Not a pin:** the choice becomes the chat's current account. The automatic rotation still moves
   it at a limit (per `rotateOnLimit`), as for any chat. A chat started pinned to an account
   (`opts.account`) keeps its pin semantics; choosing another account for it replaces the pin with the
   new one.
5. **Who:** the person only. A chat's own token gets 403 (as for every account change).
6. **Record:** the switch is a rotation event with `reason: 'person'` (the `account.switched` event and
   the rotation history), and the transcript shows one line: "Cuenta cambiada a X" / "Switched to X",
   like the line a limit switch shows.

## API

- `POST /chats/:id/account` with `{ accountId: string }` → `{ chat, pending: boolean }`. Errors: 404
  unknown chat or account; 409 the account cannot be chosen (`code`: `disabled`, `sign-in-expired`,
  `signed-out`, `exhausted`, `model-unavailable`, `same-account`; `AccountSwitchRefusalCode`); 403 a chat token. A body naming the chat's current
  account while a switch is pending cancels it.
- `GET /chats/:id` carries `chat.account` (current) and `chat.pendingAccount` (or null).
- OpenAPI summary and tag (Chats), a row in `docs/rest-api.md`, regenerated schemas.

## Task graph

Every worker is `claude-sonnet-5-5`, commits with Conventional Commits (no attribution lines), runs
`pnpm typecheck` and only the test files it adds or changes, and never runs e2e: task `w` does.

| Id | Title | Depends on |
| --- | --- | --- |
| `s1` | Contract and core: the switch, queued or immediate | — |
| `s2` | API route and security | `s1` |
| `s3` | Composer: the Account section | `s1` |
| `w` | Fake CLI, e2e and docs | `s2`, `s3` |

### s1 — Contract and core: the switch, queued or immediate

- Files: `packages/shared/src/types.ts` (request, `ChatSummary`/`Chat` fields, `reason: 'person'`),
  `packages/core/src/chats.ts` (and `chat-service.ts`/`live-chat.ts` where a turn ends), rotation
  history, tests in `packages/core/test`.
- `switchAccount(chatId, accountId, actor)`: validate per decision 2 (reuse `AccountStore` and the
  models-per-account cache), apply per decision 3 (end the live process between turns; or store
  `pendingAccount` and apply it when the turn's result arrives), set the chat's account for the next
  execution (the same mechanism the rotation uses to replay on another account), record the event per
  decision 6. Tests: idle with no process, idle with a live process, working (queued, then applied
  after the result, then the next message runs with the new account's env), cancel a pending switch,
  each refusal, and that the next execution's environment carries the new account and none of the old.

### s2 — API route and security

- Files: `apps/api/src/routes/chats.ts`, `apps/api/src/security.ts` (chat tokens refused),
  `apps/api/src/openapi/routes.ts`, `docs/rest-api.md`, schemas, `apps/api/test`.
- The route of the API section, its OpenAPI entry, the `docs/rest-api.md` row, API tests for every status code.

### s3 — Composer: the Account section

- Files: `packages/chat-ui/src/composer/ComposerMenu.tsx` (and a new `AccountPicker` beside it),
  `packages/chat-ui` client interface, `apps/web` wiring, i18n `en`/`es` per `GLOSSARY.md`, styles from
  the existing composer-menu classes (tokens only), web/chat-ui unit tests, regenerated web fixtures.
- Decisions 1–3 in the UI: rows, state words with an icon, the usage bar (`ProgressBar` control), the
  pending note with "Deshacer" / "Undo", focus and keyboard (`menuitemradio` semantics), 44 px rows on
  a phone. The transcript line of decision 6 in `packages/chat-ui`.

### w — Fake CLI, e2e and docs

- Extend `e2e/specs/accounts.spec.mjs` (or a new `chat-account-switch.spec.mjs`): open the "+" menu,
  see two accounts, switch while idle (the next message runs on the other one: check the execution's
  account through the API), switch while working (applied after the turn), an exhausted account is
  disabled with its reason. `pnpm build`, then alone `E2E_SHARDS=1 E2E_PORT=8860 pnpm e2e <specs this
  branch touched>`; ports 8860–8863 are yours; fix what fails on the right side.
- Update `docs/accounts.md` (switching on demand), `docs/chat-composer.md` (the Account section),
  `docs/requests.md` (R1 closed with its commits) and this plan's status and Outcome.

## Outcome

Built on 2026-10-16 in `a4c345c55` (core: `switchAccount`, queued or immediate), `56ca47b7c`
(`POST /chats/:id/account`, chat tokens refused) and `b465ed15d` (the composer's Account section),
with the e2e spec `e2e/specs/chat-account-switch.spec.mjs` and the docs of [accounts.md](../accounts.md)
and [chat-composer.md](../chat-composer.md). Known gaps:

- The "Switched to X" transcript line comes from the live stream, so a page reload drops it; making
  it permanent needs the server to write the notice into the chat's transcript.
- "Sign-in expired" reads `Account.signInState` since the merge with
  [rotation-auth-fixes.md](rotation-auth-fixes.md): an `expired` or `incomplete` account is disabled
  in the menu with that reason, and `POST /chats/:id/account` refuses it with 409 `sign-in-expired`.
- The spec was written but not run by this task; it runs with the e2e suite on the merged branch.

## Related

[[requests.md]] · [[accounts.md]] · [[chat-composer.md]] · [[plans/rotation-auth-fixes.md]] ·
[[plans/models-per-account.md]] · [[plans/claude-only-fork.md]]
