---
created_at: 2026-10-19T14:00:00Z
updated_at: 2026-10-19T14:00:00Z
tags:
    - plan
    - transcript
    - models
    - accounts
    - status-bar
    - composer
    - mcp
    - collaborators
---
# Plan: five fixes and Claudio's MCP on demand, from the owner's report of 2026-10-19

Status: **settled, ready to build** (2026-10-19). The owner's decisions are taken. One orchestration
on `fix/owner-report-fixes` builds six independent tasks: the five fixes, and Claudio's MCP server
switched on from the "+" of any chat (asked by the owner the same day). Tasks run on
`claude-sonnet-5-5`, with `models`, `claudio-mcp` and `review` on `claude-opus-5-5`; never fable. The tasks share no files, so each one ships
as **its own pull request** from its task branch, rebased on `main` (one concern per PR). The
integration branch exists only for the review and one CI run over everything together.

This plan is the source of truth for that orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins. Workers start in fresh
worktrees with none of the session's context, so every section says what to build, where, and
against which contract. Workers never run the e2e suite: CI runs it (`pnpm e2e:remote`, the
`e2e-on-github` skill).

## Context

Several users reported these problems on 2026-10-19 (CLI 2.1.303, desktop app 0.7.0). Read-only
investigations found the causes, and the facts below were re-read at `671350a4d`. Line numbers
are a guide; find the code by name.

### 1. A successful command shows a red "Errors" box: "Shell cwd was reset to …"

- The CLI appends `\nShell cwd was reset to <project dir>` to a Bash call's **stderr** when the
  command leaves the shell outside the project and the added dirs. A recording shows the shape:
  `packages/core/test/fixtures/recordings/claude-hooks/2.1.300/b-state/stdout.jsonl`, noted as F17
  in that folder's `g0-NOTES.md`.
  - The `tool_result` has `"is_error": false`, and its `content` is stdout and stderr joined:
    `"/tmp\nShell cwd was reset to /tmp/g0/b-state/work"`.
  - `tool_use_result` carries `stdout: "/tmp"` and `stderr: "\nShell cwd was reset to …"`.
  - A plain CLI 2.1.302 session with no Claudio has the same shape, so Claudio does not cause the
    reset. Claudio passes only `--add-dir <uploads>` (`packages/core/src/providers/claude-code/args.ts`),
    which widens the allowed dirs.
- `packages/shared/src/normalize.ts` (`kind: 'command'` branch) copies `stderr` into the detail
  untouched.
- `BashLens` in `packages/chat-ui/src/components/ToolBody.tsx` draws two zones:
  - Output: `call.result.content`, which already ends with the stderr.
  - Errors: `detail.stderr` again, as `.call-stderr`, which `packages/chat-ui/src/styles/transcript.css`
    paints `--bad`.
- So a call that did not fail shows the line twice, once in red. This breaks the rule that red
  means failed or destructive. Any harmless stderr (git progress, npm warnings) is shown the same
  way.

### 2. The model picker shows invented entries, not the CLI's `/model` list

- The picker reads `system.models` from `GET /overview`:
  - `defaultModels()` in `packages/core/src/index.ts` calls `ClaudeCodeDriver.models()`
    (`packages/core/src/providers/claude-code/driver.ts`).
  - That calls `modelOptions(file, seen, listed)` in `packages/core/src/providers/claude-code/models.ts`.
  - On the web it goes through `useModelCatalog` and `dedupeModels` in `apps/web/src/components/ui.tsx`.
- `listed` is `accounts.cachedModels(DEFAULT_ID)`: the account's `initialize` control-response
  `models[]`, cached in `<data>/accounts/models/<id>.json` (`packages/accounts/src/models.ts`). It is
  the right source, but **only when the cache exists**.
- Otherwise `modelOptions` falls back to:
  - four hard-coded aliases (`ALIASES`);
  - `~/.claude.json` → `additionalModelOptionsCache`;
  - labels guessed from `model-aliases.json`.

  That fallback is exactly what the owner saw: "fable", "Opus 5.5", "sonnet", "Haiku 5.5",
  "Fable — Fable 5.1 · …".
- `AccountStore.warmModels()` (`packages/accounts/src/store.ts`) is the only writer. It runs only on
  an account switch (`packages/core/src/chats.ts`), on rotation (`packages/core/src/rotation.ts`)
  and on fallback-suggest (`apps/api/src/routes/accounts.ts`). Never at boot.
- `cachedModels()` ignores the CLI version; only `entry()` checks it. A CLI update therefore keeps
  the old list for good.
- Stage A2 of [models-per-account.md](models-per-account.md) added the `initialize` list but kept the
  fallback. It looked fixed on the machine where it was tested because that machine's cache was
  already warm.
- `dedupeModels` keys on `resolvedModel`. The CLI's `default` resolves to the same model as
  `haiku`, so it hides the `haiku` row that `/model` shows.
- The picker always reads the `default` account's list, not the list of the chat's own account.

### 3. The status bar says "Sin sesión iniciada" while Accounts shows the account signed in

- `useConnection` in `apps/web/src/components/shell/StatusBar.tsx` computes:

  ```
  healthy = cli.installed && inUse !== null && !expired && claude.state === 'ready'
  ```

  Every unhealthy case that is not "CLI missing" or "expired" is titled `shell.notLoggedIn`. Three
  states that have nothing to do with sign-in end up there:
  - **Near the limit.** `withLimit` in `packages/core/src/providers/detector.ts` makes the provider
    `degraded`/`limit-near` from 75 % usage, and `degraded`/`limit-reached` when every account is
    exhausted. This is the likely cause of the "sometimes", because it follows usage.
  - **A probe that failed.** A version-probe timeout (10 s), a spawn failure or an unreadable
    version gives state `unknown`, cached for the 5-minute TTL.
  - **Every account exhausted.** `inUse` is null because `accounts.pick()` returns no account
    (`packages/accounts/src/choose.ts`).
- The Accounts page reads `GET /accounts`, where `signedIn` and `signInState` describe each
  account's credential only, with no limit or probe in them. That is why it disagrees.
- The single fallback came in with #46 (`659d0e7bc`). Before it, the check was
  `cli.installed && auth.loggedIn`.

### 4. The chat's options popover: preset and MCP rows that say nothing true

- The chips under the composer come from `useStatusWords` in
  `packages/chat-ui/src/composer/Composer.tsx`. On a live chat, the popover is `LiveOptions` in
  `apps/web/src/pages/chat/Controls.tsx`.
- **MCP.** The chip and the popover row read `chat.tools.mcp`, the selection made when the chat
  started. They never show what the "+" menu's Servers panel has switched since.
  - That panel (`packages/chat-ui/src/composer/ServersPanel.tsx`: `useLiveServers`, `serversOn`,
    over `GET /chats/:id/mcp`) already knows "3 de 5 activos".
  - With no selection, the chip says "MCP: lo que cargue el CLI" while the popover says "como los
    carga el CLI".
- **Preset.** It is read-only text that repeats `ToolsCard` in the inspector's Environment tab
  (`apps/web/src/pages/chat/Inspector.tsx`). `ToolsCard` also shows the allowed and blocked rules,
  which are what explain a refused tool.
- `status.liveHint` is a three-clause paragraph that mostly points at the "+".

### 5. The project's Shared tab disappears when Collaborators is switched off

- `sharedWith()` in `apps/web/src/pages/dashboard/views.ts` returns `[]` unless
  `settings.enabled && !unavailable`.
- `useSharedWith` in `apps/web/src/pages/project/shared-data.ts` reads the catalog only while
  Collaborators is on.
- `projectViews()` shows `shared` only for a non-empty list.
- The behaviour is deliberate: `docs/collaborators.md` ("The Shared tab only appears when
  Collaborators is on…") and a test in `apps/web/test/shared-view.test.tsx` both say so.
- The data stays readable while off:
  - `shared()` and the copy readers in `packages/core/src/collab/service.ts` never call
    `requireOn()`.
  - The `GET /collaborators/shared/**` routes have no gate.
  - Only `?refresh=1` and blobs never fetched before need the connection.
- Each shared project carries `sync: SyncState`, whose `state` is one of
  `'live' | 'synced' | 'offline' | 'pending'` (`packages/shared/src/types.ts`).
  - While Collaborators is off, every copy reads `offline`, the same as "the owner is away".
  - Nothing shows on the tab itself. `SyncLine` (`apps/web/src/pages/project/SharedView.tsx`) and
    `syncWord` (`apps/web/src/pages/collaborators/model.ts`) show the state only inside the view and
    on the Collaborators page.

### 6. Claudio's own MCP server only reaches the assistant and opted-in chats

- `packages/mcp` is the `claudio` server: 16 read tools, nine write tools and seven `collab_*` reads,
  chosen by `CLAUDIO_MCP_TOOLSETS` ([claudio-mcp-server.md](../claudio-mcp-server.md)).
- It is handed over only at spawn, with `--mcp-config`:
  - to the confined assistant chat (`claudioMcp`, `assistantChatOptions` in
    `packages/core/src/claudio-mcp.ts`);
  - to project chats that opted into teammates' copies, with the `collab` toolset alone
    (`collabMcpSync`).
- An ordinary chat cannot get it, and a live chat can only toggle servers it already loaded
  (`mcp_toggle`, `PUT /chats/:id/mcp/:name`).
- **Spike, 2026-10-19, real CLI 2.1.302, no turn sent, no tokens spent.** In a
  `-p --input-format stream-json` session:
  - The control request
    `{"subtype":"mcp_set_servers","servers":{"claudio":{"type":"stdio","command":"node","args":[<tsx loader>, "packages/mcp/src/main.ts"],"env":{"CLAUDIO_API_URL":…,"CLAUDIO_API_TOKEN":…}}}}`
    answered `{"added":["claudio"],"removed":[],"errors":{}}`.
  - Six seconds later `mcp_status` listed `claudio` as `connected`, with scope `dynamic` and 25 tools.
  - `mcp_set_servers` with `servers: {}` answered `removed: ["claudio"]`, and the server left
    `mcp_status`. The user's own servers were untouched both times.
- This is the documented surface the Agent SDK exposes as `Query.setMcpServers()`. It replaces the
  set of *dynamic* servers only, and the reply carries `errors` per name: a reserved name or a
  refused config shows there.

## Decisions

### D1. A CLI notice in stderr is a note, and red is only for failed calls

- `normalize.ts` takes lines matching `^Shell cwd was reset to (.+)$` out of `stderr` and puts the
  path in a new field of the `command` detail, `cwdReset: string | null`. The rest of stderr is
  trimmed and kept.
- `BashLens`:
  - shows `content` minus its stderr tail when `content` ends with the raw stderr, so nothing is
    shown twice;
  - shows the stderr zone only when what is left is non-empty;
  - draws `cwdReset` as a muted `call-meta` line.
- The stderr zone is titled **"Errors"** in `--bad` only when the call failed (`isError`). Otherwise
  it is titled **"Standard error"**, in the neutral `Term` colours.
- If the CLI ever rewords the notice, it falls back to today's display. Nothing breaks.

### D2. The CLI's `initialize` list is the only model list

- Delete the fallback: `ALIASES`, the `additionalModelOptionsCache` read, `modelDisplayName`, and
  the label use of `ModelAliasIds`. `seen` stays only if something other than labels still needs it.
- Read the list:
  - **at boot**, in the background, for every enabled, signed-in account;
  - **again whenever the cached entry's CLI version differs** from the running CLI's version.
    `cachedModels` checks the version stamp, as `entry()` does.
- While no list exists yet, `system.models` is `[]` and the picker shows a disabled "Cargando
  modelos…" row. It never shows invented entries.
  - A free-text model id is still accepted, as the Combobox does today.
  - If the read fails, the picker says "No se pudo leer la lista del CLI" with a Retry. Retry calls
    `GET /accounts/:id/models?refresh=1` (it exists, `models.ts` `entry(…, { refresh })`).
- **Per chat account.** The chat's popover and the resume/fork picker read the list of the chat's
  account (`GET /accounts/:id/models`). The overview's `system.models` stays the default account's
  list, for the new-chat form when no account is chosen.
- **Dedup only on an identical `value`.** Keep the CLI's order, its `displayName` and its
  `description` as given, so `default` and `haiku` both show, as in `/model`.
- The `initialize` read starts no turn and spends no tokens (`docs/providers.md`: a probe spends
  nothing). This is already what `models.ts` does.

### D3. Signed in, near a limit and "couldn't check" are three different words

- `useConnection` answers three questions separately.
  - **Signed in?** True when `inUse !== null`, or when any enabled account in `GET /accounts` has
    `signedIn`. That is the source the Accounts page reads.
  - **Can it work now?** Provider state `degraded` with `limit-near` or `limit-reached` is a limit
    warning: tone warn, title "Cerca del límite" or "Límite alcanzado". The status bar's usage
    meter already exists.
  - **Could it check?** Provider state `unknown` (probe-timeout, spawn-failed…) is "No se pudo
    comprobar el CLI", tone warn. It never downgrades a signed-in account.
- "Sin sesión iniciada" shows **only** when no enabled account has a credential, or the in-use
  account's `signInState` is `signed-out`.
- The server gives `inUse` a reason when it is null:
  `SystemInfo.auth.inUseReason: 'signed-out' | 'limit' | null`, from `pick()`'s outcome. The web
  does not have to guess.
- One helper, `connectionOf(...)` in `apps/web/src/lib/accounts.ts`, is shared by the status bar and
  the phone's More sheet.

### D4. The popover's MCP and preset rows lead to the real thing (option A)

- **The MCP chip on a live chat** reads `useLiveServers(chat.id)` and says "MCP: 3 de 5 activos".
  - It uses the same query key as the "+" panel, so it costs no extra fetch.
  - On a chat that is not running, it keeps the start selection. With none, it says "MCP: los del
    CLI".
- **Popover row "Servidores MCP"** becomes a link-styled button, "3 de 5 activos ›". It opens the
  composer's "+" menu on its Servers panel, through the same state path the menu uses
  (`setPanel('servers')`), not a second list.
- **Popover row "Preset de herramientas"** becomes "Solo lectura · Ver reglas ›", or "Sin preset ·
  Ver reglas ›". It opens the inspector's Environment tab, which shows `ToolsCard`.
- `status.liveHint` becomes one sentence:
  - en: "The tool preset was fixed when the chat started; resuming it can change it."
  - es: "El preset de herramientas quedó fijado al empezar el chat; reanudarlo puede cambiarlo."
- One wording for "the CLI's servers" everywhere: es "los del CLI", en "the CLI's". Applies to
  `status.mcpDefault`, `tools.card.serversDefault` and the picker's own row.

### D5. The Shared tab stays while there is shared data, and carries a sync icon

- `sharedWith()` drops the `enabled` condition. It keeps hiding the tab when the module is
  `unavailable`.
- `useSharedWith` always reads the catalog. It is one small local read.
- Add `'paused'` to `SyncStateKind`: the state of every copy while Collaborators is off, computed in
  core where the client is stopped (`packages/core/src/collab/client.ts`). Update `syncWord`.
- The tab label carries one icon showing the **worst** state among the project's shared copies.
  Order: error > paused > offline > pending > synced/live.
  - The icon has an `aria-label` and a `Tooltip` with the full words.
  - Inside the view, `SyncLine` gains the paused state and its action.
- `docs/collaborators.md` and the test are changed to say the new rule.

### D6. Claudio's MCP server is a switch in the "+" of any live chat

- The owner chose: **all the tools** (read and write) behind one switch. The tools obey the chat's
  permission mode, like any other MCP tool.
  - With "Sin comprobar permisos" (bypass), a write runs without asking. The switch's hint says so.
  - The API's audit already records every call by `x-claudio-tool`.
- **On a live chat** the core sends `mcp_set_servers` with the `claudio` server. The server is built
  by the existing `mcpCommand`/`claudioMcp` helper, with toolsets `claudio`, plus `collab` when the
  chat's project may read teammates' copies, as `collabMcpSync` decides today.
  - Switching off sends the dynamic set without it.
  - `CLAUDIO_CHAT_ID` and `CLAUDIO_API_TOKEN` are literal values in the request's `env`, taken from
    the chat process's own environment. They travel over the process's stdin and are never written
    to disk.
  - **First commit: check** whether the CLI expands `${NAME}` in a pushed config, as it does in a
    file. If it does, use the references, as the config file does.
- **The choice is stored on the chat**, as `ChatToolConfig.claudioMcp: boolean`. A resume or fork,
  and Claudio's own respawns (account switch, rotation, limit resume), start the process with
  the server in its `--mcp-config`, merged as `collabMcpSync` already merges. The switch therefore
  survives a restart.
- **Where it shows:**
  - In the "+" menu's Servers panel, as the **first row**, "Claudio": the brand mark, the summary
    "Lee y cambia proyectos, tareas, chats y orquestaciones", and a `Switch`.
  - Once on, it also appears in the CLI's own list (status `connected`, n tools). The panel shows
    it once: the row merges the CLI's entry named `claudio` with scope `dynamic`.
  - For a chat that is not live, the start options (resume, fork, new chat) offer the same switch
    beside the servers they already offer.
- **Not offered:**
  - in the assistant chat, which already has it, confined;
  - in chats whose provider is not Claude Code;
  - when the API URL is unknown (`claudioMcp` throws): there the switch is disabled with the reason.
- **Errors:**
  - A name in the reply's `errors`, or a server that ends `failed`, shows inline in the row, in
    words, with the CLI's message in mono.
  - A user server already named `claudio` is reported as such ("Ya hay un servidor llamado
    claudio"), never overwritten.
- **The fake CLI** (`e2e/fake-cli/claude`) learns `mcp_set_servers`. It adds or removes a dynamic
  server in its `mcp_status` and answers `added`/`removed`/`errors` as recorded. The README lists it
  beside `mcp_toggle`.

## Design

Every visual change follows [docs/design-system.md](../design-system.md) and the `claudio-ui`
skill. Tokens only, both themes, contrast ≥ 4.5:1. A status colour always goes with a word or an
icon.

### The Bash row (D1)

| Part | Look |
| --- | --- |
| Output | `Term` as today, with the stderr tail removed when it duplicates |
| cwd note | one `.call-meta` line under Output, `--fg-3`, `--fs-small`. es "La shell volvió a {{path}}", en "The shell went back to {{path}}"; the path in Geist Mono with an ellipsis in the middle and the full path in a `Tooltip` |
| Stderr, call ok | zone "Salida de error" / "Standard error", neutral `Term` (no `--bad`), only when non-empty after removing the notice |
| Stderr, call failed | zone "Errores" / "Errors", `.call-stderr` in `--bad`, as today |

Keep the class `.call-stderr` for the failed case. Add `.call-stderr-neutral` for the other one in
`transcript.css`, beside it.

### The model picker (D2)

- Rows: the CLI's `displayName` (label), and its `description` (hint) on a second line, as today.
  Ids in mono only where the label is an id.
- Loading: one disabled row with the braille spinner, es "Cargando modelos…", en "Loading models…".
  Never a list of guesses.
- Read failure: one row, es "No se pudo leer la lista del CLI", en "Couldn't read the CLI's list",
  with a "Reintentar" / "Retry" action.

### The status bar and the More sheet (D3)

| State | Dot | Short text (es / en) | Detail (es / en) |
| --- | --- | --- | --- |
| ready | ok | account label | as today |
| near limit | warn | account label · "Cerca del límite" / "Near the limit" | "Las cuentas cambian solas al llegar al límite" / "Accounts rotate at the limit" when rotation is on, else "Revisa el uso en Cuentas" / "Check usage in Accounts" |
| limit reached | bad | "Límite alcanzado" / "Limit reached" | "Vuelve a estar disponible a las {{time}}" / "Available again at {{time}}" when the reset is known |
| probe unknown | warn | account label · "Sin comprobar" / "Not checked" | "No se pudo comprobar el CLI; se reintentará" / "Couldn't check the CLI; it will retry" |
| signed out | warn | "Sin sesión iniciada" / "Not signed in" | as today |
| expired, CLI missing, API down, connecting | as today | as today | as today |

Times go through `packages/ui/src/lib/format.ts`. No `%` in copy.

### The chat options popover (D4)

```
Permisos        [ Sin comprobar permisos   v ]
Modelo          [ claude-opus-5-5          v ]
Preset          Sin preset · Ver reglas ›
Servidores MCP  3 de 5 activos ›
El preset de herramientas quedó fijado al empezar el chat; reanudarlo puede cambiarlo.
```

- The two link rows use the existing `btn-link` style: brand colour, `--fs-body`, no underline until
  hover or focus, ≥ 44 px tall on a phone.
- The counts are tabular, through `format.ts`.
- Chip row: `claude-opus-5-5 · Sin comprobar permisos · sin preset · MCP: 3 de 5 activos`.

### The Shared tab's sync icon (D5)

| State | Icon (lucide) | Tone | Tooltip and aria-label (es / en) |
| --- | --- | --- | --- |
| live / synced | `CircleCheck` | ok | "Sincronizado · hace {{ago}}" / "Synced · {{ago}} ago" |
| pending | ring spinner (small) | neutral | "Sincronizando…" / "Syncing…" |
| offline | `Moon` | idle | "El propietario no está conectado" / "The owner is away" |
| paused | `Pause` | warn | "En pausa: Colaboradores está desactivado" / "Paused: Collaborators is off" |
| error | `TriangleAlert` | bad | "Falló la última sincronización" / "The last sync failed" |

- 14 px icon after the tab's word, inside the tab button. The tab keeps its classes.
- `SyncLine` in paused mode: a `Tag` warn "En pausa" / "Paused", plus a link "Activar Colaboradores" /
  "Turn Collaborators on" to `/collaborators`.
- The spinner follows the motion levels: it stops under subtle, off, reduced motion and a hidden
  tab, as every loop does.

### The Claudio row in the "+" Servers panel (D6)

```
[◆] Claudio                                          [ ●— ]
    Lee y cambia proyectos, tareas, chats y orquestaciones
    25 herramientas · conectado
```

- `[◆]` is `BrandMark` at 16 px. It is the logo, so it is not counted as a gradient surface (it is
  the logo's own use).
- Title "Claudio", `--fs-body`, `--fw-strong`. Summary in `--fg-3`, `--fs-small`.
- While on, the status line uses the panel's existing `Tag` tones: `connected` ok, `pending` muted
  with the braille spinner, `failed` bad.
- Hint under the row when the chat's mode is `bypassPermissions`, `--fs-small`, `--warn` with
  `TriangleAlert`. es "Con «Sin comprobar permisos» sus cambios se aplican sin preguntar", en "With
  permission checks off, its changes apply without asking".
- A separator under the row, then the CLI's own servers as today. ≥ 44 px row on a phone, inside
  the "+" sheet.
- The panel's existing classes stay (`.composer-servers`). The row adds
  `.composer-servers-claudio`.

## Contracts

### Shared types (`packages/shared/src/types.ts`)

- The `command` tool detail gains `cwdReset: string | null` (D1).
- `SystemInfo.auth` gains `inUseReason: 'signed-out' | 'limit' | null` (D3).
- `SyncStateKind` gains `'paused'` (D5).
- `ChatToolConfig` gains `claudioMcp?: boolean` (D6). The start choices (`StartChoices`, the new-chat,
  resume and fork bodies) gain `claudioMcp?: boolean`.

Regenerate the schemas after each: `pnpm --filter @claudio/api openapi:schemas`.

### Routes

- **New:** `PUT /chats/:id/claudio-mcp`, body `{ enabled: boolean }`, answers `ChatMcpServers` as
  `PUT /chats/:id/mcp/:name` does.
  - 400 when the chat has no live process.
  - 409 when a user server already holds the name.
  - 503 when Claudio's server cannot be built (no API URL).
  - It needs a summary and the `Chats` tag in `apps/api/src/openapi/routes.ts`, a row in
    `docs/rest-api.md`, and the `add-rest-route` skill.

Otherwise, no new route. `GET /accounts/:id/models` (with `?refresh=1`) and `GET /chats/:id/mcp` already
exist. Check that each is listed in `docs/rest-api.md`.

### i18n

New keys go in the namespace that owns the component, with `en`/`es` parity. The Spanish follows
`apps/web/src/i18n/GLOSSARY.md`: Spain, infinitive buttons, sentence case.

## Tasks

The integrator launches this graph on `fix/owner-report-fixes`. Six independent tasks, then the
review and the docs:
`shell-notice · models · status-bar · chat-options · shared-tab · claudio-mcp → review · docs`.

| Id | Model | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- | --- |
| `shell-notice` | sonnet | D1 | – | `packages/shared/src/normalize.ts`, the `command` detail type, `packages/chat-ui/src/components/ToolBody.tsx` (`BashLens` only), `packages/chat-ui/src/styles/transcript.css` (`.call-stderr*`), `chat.json` keys under `transcript.call`, their tests | `pnpm typecheck`, `pnpm test` (shared, chat-ui), `openapi:schemas`, design lint |
| `models` | opus | D2 | – | `packages/core/src/providers/claude-code/models.ts`, `driver.ts` (models only), `packages/accounts/src/models.ts`, `AccountStore.cachedModels`/`warmModels` and a boot call in core's start-up, `apps/web/src/components/ui.tsx` (`dedupeModels`, `useModelCatalog`, `useModelOptions`, `ModelCombobox`), the chat pickers' account wiring in `apps/web/src/pages/chat/Controls.tsx` (`ModelCombobox` props only), model keys in i18n, tests | `pnpm typecheck`, `pnpm test` (accounts, core, web), plus a test that boots with an empty models cache, sees the list arrive with no account action, and refreshes on a version change |
| `status-bar` | sonnet | D3 | – | `apps/web/src/components/shell/StatusBar.tsx` (`useConnection`), the More sheet's use of it, `apps/web/src/lib/accounts.ts`, `SystemInfo.auth.inUseReason` and its producer `accountInUse()` in `packages/core/src/index.ts`, `components.json` `shell.*` keys, tests | `pnpm typecheck`, `pnpm test` (core, web), `openapi:schemas`, design lint |
| `chat-options` | sonnet | D4 | – | `apps/web/src/pages/chat/Controls.tsx` (`LiveOptions` only), `packages/chat-ui/src/composer/Composer.tsx` (`useStatusWords`, `StatusLine`), the open-panel hook into `ComposerMenu`/`ServersPanel` (no changes to their lists), the inspector tab opener, `chat.json` keys `status.*`, `tools.card.serversDefault`, tests | `pnpm typecheck`, `pnpm test` (chat-ui, web), design lint |
| `shared-tab` | sonnet | D5 | – | `apps/web/src/pages/dashboard/views.ts`, `apps/web/src/pages/project/shared-data.ts`, the tab labels in `apps/web/src/pages/Home.tsx`, `apps/web/src/pages/project/SharedView.tsx` (`SyncLine`), `apps/web/src/pages/collaborators/model.ts` and `SharedWithYou.tsx`, `SyncStateKind` and `packages/core/src/collab/client.ts` (paused state), the collaborators i18n, `apps/web/test/shared-view.test.tsx`, `apps/web/test/collaborators-page.test.tsx`, `docs/collaborators.md` | `pnpm typecheck`, `pnpm test` (core, web), `openapi:schemas`, design lint |
| `claudio-mcp` | opus | D6 | – | `packages/core/src/claudio-mcp.ts` (a `dynamicClaudioServer` builder beside the existing helpers), `packages/core/src/providers/claude-code/driver.ts` and `control.ts` (`mcp_set_servers` only), the chat start/respawn path that builds `--mcp-config` (the `claudioMcp` merge), `ChatToolConfig.claudioMcp` and the start choices in `types.ts`, the new route in `apps/api/src/routes/` beside `PUT /chats/:id/mcp/:name`, `routes.ts`, `docs/rest-api.md`, `packages/chat-ui/src/composer/ServersPanel.tsx` (the Claudio row; `chat-options` only imports its hooks), the start options' servers picker (`ChatToolsPicker`), the client method, `chat.json` keys under `composerMenu.claudio*`, `e2e/fake-cli/claude` and its README and test, `docs/claudio-mcp-server.md` (a section "On demand in any chat"), `docs/cli-surfaces.md` (the `mcp_set_servers` row), tests | `pnpm typecheck`, `pnpm test` (core, api, chat-ui, web, fake CLI), `openapi:schemas`, design lint; an API test through the fake CLI that switches it on, sees `claudio` connected, switches it off, and resumes with it kept |
| `review` | opus | conventions, design, copy, the one rule, cross-task consistency; at most one test run | all six | none (findings, or one-line fixes nobody owns) | reads; at most one `pnpm test` |
| `docs` | sonnet | `docs/cli-surfaces.md` (the notice, the `initialize` list as the only source), the models section of `docs/accounts.md`, `docs/plans/models-per-account.md` (dated note), `docs/collaborators.md` if `shared-tab` left it, `docs/status.md` (PR references, no versions), this plan's Outcome | all six | the listed docs | `pnpm test` (docs tests) |

`shell-notice`, `status-bar`, `shared-tab` and `claudio-mcp` each change `types.ts` in a different interface.
`chat-options` reads `useLiveServers`/`serversOn` from `ServersPanel.tsx` but does not edit it; `claudio-mcp`
owns that file.
Each adds only its own field. The integrator regenerates the schemas once after merging.

### Rules for every task

1. Work only in your worktree, on your branch. Conventional Commits in English with a body saying
   why. Never push.
2. Read CLAUDE.md and CONTRIBUTING.md first. TypeScript strict, no `any`,
   `noUncheckedIndexedAccess`.
3. Run `pnpm typecheck` and `pnpm test`, wrapped in `timeout` so a hang fails instead of waiting.
   Write or update e2e specs if a selector changes, but **never run `pnpm e2e`**.
4. UI tasks load the `claudio-ui` skill. Before finishing, they run `node scripts/ui-check.mjs` on
   their route if a dev server is up. If it is not, they say so; `/ui-review` runs after
   integration.
5. Keep every class the e2e specs select. `e2e/specs/collaborators.spec.mjs` selects
   `.shared-chats`, `.shared-chat`, `.read-only-bar` and `[data-testid=collab-shared-project]`.
   Check `grep -rn` over `e2e/specs` for any class you touch.

## Tests

- **shell-notice:** normalize a recorded Bash result with the notice. `cwdReset` holds the path,
  `stderr` is empty, and the lens shows no stderr zone. A result with real stderr and
  `is_error: false` shows "Standard error" in neutral; with `is_error: true` it shows "Errors" in
  red.
- **models:**
  - With an empty cache, no fallback entry ever appears.
  - The boot warm-up fills it.
  - A version stamp that differs refreshes it.
  - `default` and `haiku` both survive the dedup.
  - The picker on a chat uses that chat's account list.
- **status-bar:** `useConnection` for each row of the D3 table. In particular, `limit-near` with a
  signed-in account never says "Not signed in".
- **chat-options:**
  - The chip reads the live count.
  - The two links open the Servers panel and the Environment tab.
  - The wording is the same in chip and popover, in both languages.
- **shared-tab:** the tab shows with Collaborators off when the catalog has a matching project. The
  icon picks the worst state. `paused` comes from core when the client is stopped.
- **claudio-mcp:**
  - Through the fake CLI: switching it on sends `mcp_set_servers` with `claudio` and the chat's env,
    and switching it off removes it.
  - A name clash answers 409.
  - A resume of a chat with `claudioMcp: true` carries it in `--mcp-config`.
  - It is not offered in the assistant chat.
  - The Claudio row renders first, and the bypass hint shows only in bypass mode.
- After integration: `/ui-review` on a chat (`/chats/:id`), a project with a shared copy
  (`/projects/:id?view=shared`) and the status bar, in both themes, at 1280×720 and 390×844. Then
  `pnpm e2e:remote` on the integration branch, watched with fail-fast.

## Risks

- Removing the model fallback leaves the picker empty while the first `initialize` read runs, a
  few seconds after boot. The "Cargando modelos…" row and the free-text entry cover it.
- A CLI that answers `initialize` without `models` (an old version) leaves the list empty. The
  "couldn't read" state names the problem rather than hiding it.
- The notice regex is English and tied to the CLI's wording. The fallback is today's display.

## Open questions

None. On 2026-10-19 the owner chose option A for the popover, the orchestration for the fixes,
and all of Claudio's tools behind one switch for D6.

## Related

- [models-per-account.md](models-per-account.md)
- [container-polish.md](container-polish.md) (where D3's single fallback came from)
- [collaborators.md](collaborators.md)
- [docs/claudio-mcp-server.md](../claudio-mcp-server.md)
- `projects-as-repositories.md` and `assistant-mascot.md`, the other two plans from the same report (their own branches)
- [docs/chat-composer.md](../chat-composer.md)
- [docs/design-system.md](../design-system.md)
