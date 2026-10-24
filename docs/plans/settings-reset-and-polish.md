---
created_at: 2026-10-20T12:00:00Z
updated_at: 2026-10-20T18:00:00Z
tags:
    - plan
    - settings
    - audit
    - terminal
    - decisions
    - design-system
    - polish
---
# Plan: settings reset and overrides, terminal and audit on a phone, and the polish follow-ups

Status: **settled, ready to build** (2026-10-20). The owner took every decision on 2026-10-20. One
orchestration on `feat/settings-reset-and-polish` builds it, and everything ships as **one pull
request** (the owner's choice). Tasks run on `claude-sonnet-5-5`. `audit`, `settings-core` and
`review` run on `claude-opus-5-5`. Never fable.

This plan is the source of truth for that orchestration, together with CLAUDE.md and
CONTRIBUTING.md. Where a task prompt and this plan disagree, the plan wins. Workers start in fresh
worktrees with none of the session's context, so every section says what to build, where, and
against which contract. Workers never run the e2e suite: CI runs it (`pnpm e2e:remote`, the
`e2e-on-github` skill). Workers run tests through `node scripts/test-tmp.mjs` (each package's `test`
script already does).

## Context

The facts below were re-read at `dbcf0d85d` (v0.8.1). Line numbers help you find the code, but
search for it by name.

### 1. Escape on the notifications panel drops focus on `<body>`

- `apps/web/src/components/NotificationPanel.tsx:156-157` opens `Popover.Root open` with only
  `<Popover.Anchor virtualRef={anchor} />`.
  - It has no `Popover.Trigger`, no `onCloseAutoFocus` and no `onEscapeKeyDown`.
  - `onOpenAutoFocus` (:173-176) focuses the content.
  - `onInteractOutside` (:170) ignores clicks on the bell.
  - Radix gives focus back to its `triggerRef`. With no trigger that ref is null, so focus lands on
    `<body>`.
- `apps/web/src/components/Notifications.tsx:38` holds the bell's ref (`button`), and :47 attaches
  it. The bell sits inside a `Tooltip` (:45-63). :66 hands the ref to the panel as `anchor`.
- `packages/ui/src/components/controls/Tooltip.tsx:37-46`: `focusOpensTooltip` opens the tooltip
  only for a focus that follows a navigation key (Tab, the arrows, Home/End, PageUp/PageDown) within
  1000 ms. Any other key, or a pointer down, resets the clock (:40-41). Escape is not a navigation
  key, so giving focus back after Escape does **not** open the bell's tooltip. The comment at
  :24-29 describes exactly this case. No tooltip change is needed.
- The UI library has no Popover wrapper. Code imports `@radix-ui/react-popover` directly. Pattern:
  `packages/ui/src/components/controls/Combobox.tsx:148` (`onCloseAutoFocus={(e) => e.preventDefault()}`).

### 2. A `font:` shorthand without a weight resets it to 400

- `font: <size> <family>` sets `font-weight` to `normal` (400, below `--fw-regular` 450) and
  `line-height` to `normal`.
- The tree has 41 `font:` shorthands with a real value. 22 of them lack a weight:
  - `apps/web/src/styles/shell.css`: 314, 325, 369, 407, 663 (the status bar), 1221, 1234, 1269 and
    1345. All of them are `var(--fs-small) var(--sans)`.
  - `apps/web/src/styles/overlays.css`: 212 (`var(--fs-small) var(--mono)`) and 264
    (`var(--fs-small) var(--sans)`).
  - `packages/chat-ui/src/styles/chat.css`:
    - 84: `var(--fs-small)/1.4 var(--mono)`
    - 151: `var(--fs-small) var(--sans)`
    - 1073: `var(--fs-small) var(--mono)`
  - `packages/chat-ui/src/styles/transcript.css`:
    - 483, 830, 881 and 901: `var(--fs-small) var(--mono)`
    - 493, 844 and 1238: `var(--fs-small)/1.6 var(--mono)`
    - 916: `var(--fs-small)/1.7 var(--mono)`
- Tokens in `packages/ui/src/styles/tokens.css`: `--lh-title` 28px (228), `--lh-section` 22px
  (230), `--lh-body` 20px (232), `--lh-small` 18px (234), `--fw-regular` 450 (237) and
  `--fw-strong` 600 (238).
- `scripts/design-lint.mjs`:
  - `fontShorthand()` (:61-66) reads the family, size and weight. The `font` branch of `lintCss`
    is at :104-115.
  - It checks only the values that are present. It never flags a missing weight.
  - The rule `type-weight` already exists.
- `apps/web/test/design-voice.test.ts` holds the tree to the lint at :14. Its "the lint catches
  what it is meant to catch" cases begin at :17.

### 3. Model ids are drawn in sans on the Chats filters

- `apps/web/src/pages/Chats.tsx:521` builds the model chip as
  `label: t('list.chipModel', { values: labelsOf(modelOptions, models) })`.
- The model facet's label is the raw model id: `facetOptions` in
  `packages/chat-ui/src/lib/chat-model.ts:220-231` sets `label = value` for `model`.
- `packages/ui/src/components/ListToolbar.tsx`:
  - :22-27 declares `ListFilterChip { id; label: string; onRemove }`.
  - :187 uses `label` in `aria-label` (`toolbar.removeFilter`).
  - :188 renders it as `<span>{chip.label}</span>`.
- `Facet` in `Chats.tsx` (:300-318) renders `<span className="facet-label">{option.label}</span>` for
  both the project facet and the model facet.
- The mono class is `.mono` (`apps/web/src/styles/base.css:128`). Pattern:
  `apps/web/src/components/OrchestrationMerge.tsx:318`.

### 4. Terminal history scrolls sideways on a phone

- `History()` in `apps/web/src/pages/config/security/TerminalCard.tsx:80-152` is a `.table-wrap`
  table (:98-99) with four columns:
  - When (:113): `small muted nowrap`.
  - Who (:115): `small mono nowrap`, the raw `entry.actor`. The words `owner` and `anonymous` show
    in mono.
  - Directory (:116): `small mono break`, the raw absolute cwd. On a phone it wraps one character
    at a time.
  - How (:117-128): the end reason, plus a `Tag tone="warn"` for refusals.
- At 390 and 320 the table scrolls sideways.
- The pattern the owner chose is the Guards "Recent blocks":
  - `RecentBlocks` in `apps/web/src/pages/config/GuardsCard.tsx:349-375` (`ul.guard-events`,
    `li.guard-event`).
  - Its CSS: `apps/web/src/styles/editors.css:1830-1892`.
  - `docs/design-system.md:1981-1982` and `docs/design-system/claudio-ds.css:2671-2672`.
- `shortPath(path, max = 48)` is at `packages/ui/src/lib/format.ts:167` and keeps the tail.
- `FullText` (`packages/ui/src/components/FullText.tsx:17`) sets the full text as `title`. That
  does not help on touch.
- The terminal's CSS is `apps/web/src/styles/terminal.css:391-470` (`.term-history`).

### 5. The audit log is too wide, and its "What" column is English

- `AuditTable` is in `apps/web/src/pages/config/security/AuditCard.tsx:160-200`. Both `AuditCard`
  (:39) and `AuditLatest` (:204) use it.
- Its five columns (:168-172) are when, actor, request, result and what.
  - Actor (:181): `FullText` with `mono audit-literal`.
  - Method (:183): `span.strong`, then the path in mono.
  - Summary (:190): `small audit-summary`.
- Width:
  - The columns use `nowrap` and minimum widths, so they need about 800 px. Settings gives about
    720 px at 1280.
  - `.table-wrap` (`apps/web/src/styles/lists.css:92-96`) has `overflow: auto` and
    `max-height: 72vh`. Twelve components share it.
- English:
  - The `onResponse` hook (`apps/api/src/security.ts:1030-1044`) writes `summary` as
    `auditSummary()` (:729-733): `ROUTE_DOCS[`${method} ${pattern}`].summary`, the English OpenAPI
    summary, stored as text.
  - The table is `packages/core/src/db.ts:159-168` (`id, at, actor, method, path, status, summary`).
    `appendAudit` is at :2028.
  - `AuditEntry` is in `packages/shared/src/types.ts:5093-5107`.
- `apps/api/src/openapi/routes.ts`:
  - `ROUTE_DOCS` (:160) is keyed `'METHOD /pattern'`.
  - It holds 286 POST/PUT/PATCH/DELETE entries out of 487.
  - Nothing generates anything from it today. Only `apps/api/src/security.ts` imports it.
- Where each actor value comes from:
  - `token:<id>`: `packages/core/src/security/auth.ts:350`.
  - `desktop`: `auth.ts:48`.
  - `chat:<id>`: `packages/core/src/security/chat-tokens.ts:13`.
  - `env`: `packages/core/src/index.ts:718`.
  - `claudio`: `index.ts:762`.
  - `local` and `anonymous`: `apps/api/src/security.ts:972` and :818.
  - An OIDC subject.
  - The doc comments at `types.ts:5096-5100`, `routes.ts:761` and `docs/rest-api.md:113` leave out
    `desktop`, `chat:`, `claudio` and `anonymous`.
- i18n:
  - Namespaces are registered in `apps/web/src/i18n/resources.ts` (imports from :5, the `en`/`es`
    objects around :91-156).
  - Parity is checked in `apps/web/test/i18n.test.ts`.

### 6. No settings row can go back to its default

Only the layered app settings know where their value comes from:

- `AppSettings.sources` is `env | file | default` (`types.ts:5192-5199`).
- The resolver is `packages/core/src/app-settings.ts:284-298`.
- `update()` (:247-277) writes `{ ...this.stored, ...changes }` (:265). Once a key is `file` it
  never goes back to `default`.
- `null` is a real value for `dailySpendCapUsd` (no cap).

Every other store is a JSON document with its own shape:

| Store | Core | Routes | Default | Write |
| --- | --- | --- | --- | --- |
| `app-settings.json` | `app-settings.ts` | `/settings/app` | `DEFAULT_APP_SETTINGS`, `packages/core/src/paths.ts:205-212`; `defaultPermissionMode` is `bypassPermissions` in the image | merge |
| `providers.json` | `providers/settings.ts:66` | `/providers/settings` | `defaultProvidersSettings` :52, `defaultRotationSettings` :14 | replaced whole |
| `lessons.json` | `lessons/settings.ts:123` | `/lessons/settings` | `DEFAULT_LESSON_SETTINGS` :14 | merged, then written whole |
| `decisions.json` | `decisions/settings.ts:284` | `/decisions/settings` | `DEFAULT_DECISION_SETTINGS` :93 | replaced whole; `points` is sparse |
| `guards.json` | `guards/settings.ts:161` | `/settings/guards` | `defaultGuardSettings` :24 | merge |
| `terminal.json` | `terminals/settings.ts:111` | `/terminal/settings` | `terminalDefaults()` :28 (`remote: 'any'` in docker); `TerminalStatus.sources` exists | merge |
| `tunnel-settings.json` | `tunnel.ts:494` | `/tunnel/settings` | `DEFAULT_SETTINGS` :255 | merge |
| `accounts.json` | `packages/accounts/src/store.ts:535` | `/accounts/settings` | in the store | merge |
| collaborators | `packages/core/src/collab/settings.ts` | the collaborators routes | in the store | merge |
| browser | `lib/theme.tsx:11`, `packages/ui/src/i18n/language.ts:12`, `packages/ui/src/lib/motion.ts:20`, `notifications-model.ts:169` | none (`localStorage`) | in each file | always set, except motion |

None of them is SQLite.

- `PrefRow` (`apps/web/src/pages/config/PrefRow.tsx:9-35`) has no slot for "changed".
- The Runs rows are plain `data-setting` elements: `AppSettingsCards.tsx:277` and :291, the spend
  cap at :395, the evals at :147. So are the lessons rows (`.lessons-row`), the decision engine
  fields (`.dp-field`, `decisions/Engine.tsx`), the points (`.dp-point`, `decisions/Points.tsx:229`)
  and the provider rows (`ProvidersTab.tsx:109`, :143).
- The design is already drawn:
  - `.claude/skills/claudio-ui/references/settings-patterns.md`, "Anatomy of a row": the
    `[● changed · Reset]` slot with its room reserved.
  - `docs/plans/settings-ia.md` §6.0 (:188, :194), and its open items (:504-505).
- Existing copy:
  - `config:shared.reset` is "Reset" / "Restablecer" (GLOSSARY.md:148).
  - The glossary says "Predeterminado", never "por defecto" (GLOSSARY.md:236, 490).

### 7. Nothing says that projects override a global setting

- `config:settings.overridden_one/_other` exists but nothing uses it: "Overridden in {{count}}
  project(s)" / "Cambiado en {{count}} proyecto(s)", `en/config.json:542-543`.
- What a project overrides (`ProjectSettings`, `types.ts:1969-1994`, in
  `project-settings/<id>.json`, `packages/core/src/project-settings.ts:569`):
  - `decisions.provider` and `decisions.points[id].{mode,threshold}` (`ProjectDecisionSettings`,
    :9546).
  - `providers.order` and `providers.onLimit` (:1998-2004).
  - `flow.guards[stage].rules` (:1952).
  - `lessons` and `guards.chats` are project-only switches, with no global row of the same setting.
- `core.projects()` (`packages/core/src/index.ts:2305`) lists every project with its settings.
- The project's own rows keep "Use global"
  (`apps/web/src/pages/home/ProjectDecisions.tsx:238-245`).
- A project's settings open at `/?project=<id>&view=settings` (`apps/web/src/pages/team/Team.tsx:80`).

### 8. A Shadow point with no consent says it runs, and it does not

- `packages/core/src/decisions/engine.ts:160-162`: a point with no consent valid for its state
  version and provider returns `OUTCOME_OFF()`, whatever its mode. This happens before the split
  into shadow and active at :168.
- `effective().limited` (:111) is `mode === 'active' && …`. `isLimited`
  (`apps/web/src/pages/config/decisions/model.ts:102-111`) mirrors it, so it is false for shadow.
- `ConsentPart` (`Points.tsx:294-323`) shows `points.limited` only when `isLimited && needsConsent`
  (:314).
  - en: "Runs as shadow until it has consent." (`en/decisions.json:77`)
  - es: "Funciona como sombra hasta que tenga consentimiento."
  - Both claim it runs, which is false. A shadow point with no consent shows nothing at all. The
    row offers no action: the only way is Off and back (`groups/Decisions.tsx:86-89`, which opens
    `ConsentDialog` through `setAsking`).
- `ConsentDialog` (`decisions/ConsentDialog.tsx:22`) takes `info, name, provider, mode, consent,
  onClose, onGranted`.

### 9. The process isolation study still waits for decisions the owner has taken

- `docs/plans/process-isolation.md` was merged with #32 and is tagged `parked`.
  - Its status (:15-17) and §7 (:405) say "D4 to D8 — the owner reviews them in this pull
    request".
  - D2 (:414-421) is unanswered.
- Stale facts:
  - §3 (:154-193) predates the `InteractiveHold` priority
    (`packages/core/src/admission-queue.ts:42`, #38), the `server.lock`
    (`packages/core/src/data-dir-lock.ts:19`), the `CLAUDIO_*` env allow-list
    (`packages/shared/src/server-env.ts:8`) and the terminal peer check
    (`packages/core/src/terminals/peer.ts`).
  - §5 and §6 (:237, :250, :347-348, :418, :513, :522) describe sign-in as a long-lived
    `setup-token` token. Since #46, sign-in is the in-app `claude auth login`.
- `docs/providers.md:31` says "No SDK", while CLAUDE.md allows "the vendor's official SDK".

## Decisions

### D1. Escape gives focus back to the bell

The panel takes `onEscapeKeyDown`, which notes `closedBy = 'escape'` in a ref, and
`onCloseAutoFocus`:

```ts
onCloseAutoFocus={(e) => { e.preventDefault(); if (closedBy.current === 'escape') anchor.current?.focus(); }}
```

- An outside click leaves focus where that click put it. Radix does the same with a trigger.
- A link inside the panel navigates, and focus follows the new page.
- The bell's tooltip does not open after Escape (`focusOpensTooltip`, Context §1), so the Tooltip
  needs no change.

### D2. Every `font:` shorthand names its weight and its line height; the lint enforces it

- The 22 shorthands become `font: var(--fw-regular) var(--fs-small)/var(--lh-small) var(--sans|--mono)`.
- The four with a raw ratio of 1.6 or 1.7 (`transcript.css` 493, 844, 916, 1238) are code and
  terminal blocks. They take `var(--lh-body)` (20 px, the token closest to 13 × 1.6).
- `chat.css:84` (`/1.4`) takes `--lh-small`.
- Before finishing, re-grep `font:` over `apps/web/src/**/*.css` and `packages/*/src/**/*.css`.
  Any new one gets the same treatment.
- `design-lint.mjs`: a `font` shorthand with a size and a family but no weight is a `type-weight`
  problem, with the message "font shorthand without a weight resets it to 400; name
  --fw-regular or --fw-strong". `font: inherit` and the other keyword forms are left alone.
- `palette.css:68` keeps its weight and its raw `/1.4`. The lint does not flag it, and changing it
  is out of scope.

### D3. Model ids are mono on the chip and in the facet

- `ListFilterChip` gains `content?: ReactNode`. When present, the chip draws it in place of `label`.
  `label` stays the accessible name and stays required.
- The Chats model chip passes `label` as today. Its `content` is the `chipModel` prefix in sans,
  then each id in `<span className="mono">`, comma-separated.
  - New key `list.chipModelPrefix`: en "Model:", es "Modelo:".
  - Use `<Trans>`, or the prefix followed by the list. Never build the sentence by concatenating.
- `Facet` gains `mono?: boolean`, which adds `mono` to `.facet-label`. Only the model facet sets
  it. Project names stay sans.

### D4. Terminal history becomes wrapping rows below 560 px

- The table stays at 560 px and wider. Measure the container with a container query on
  `.term-history` (container queries for components, the claudio-ui skill).
- Below 560 px the table is not rendered. The same entries render as `ul.term-history-rows` >
  `li.term-history-row`, the `.guard-event` pattern. Each row has three lines:
  1. Time (`formatDateTime`, tabular sans), then "·", then the actor word in sans.
  2. The cwd in mono through `shortPath(cwd, 40)`, as a button (`.term-history-cwd`,
     `aria-expanded`) that shows the full path in place, wrapping with `overflow-wrap: anywhere`. A
     tap reveals it on touch. On desktop the `FullText` title is kept. `—` when there is no cwd,
     and then it is not a button.
  3. The end reason, then the refusal `Tag tone="warn"` as today.
- No sideways scroll at 390 or 320. The rows go in a plain container, not `.table-wrap`.
- Actor words: `owner` is "Owner" / "Propietario" and `anonymous` is "Anonymous" / "Anónimo", in
  sans, in both the table and the rows. Any other value (an id) stays mono.
- Only one of the two renders at a time. Pick it with `useMediaQuery` on the container's width, or
  with CSS `display: none` driven by the container query, so that only one is in the accessibility
  tree.

### D5. Audit: a `route` column, every write route translated, rows on a phone

- **Storage.** A new migration appends `ALTER TABLE audit ADD COLUMN route TEXT;` to `MIGRATIONS` in
  `db.ts`. Pattern: `db.ts:1286`. Never edit an existing migration.
  - `appendAudit` writes it. The hook stores `` `${method} ${pattern}` `` (the `ROUTE_DOCS` key,
    with `API_PREFIX` stripped), or `null` when Fastify matched no route.
  - Old rows read `route: null`.
  - The `summary` column stays and keeps being written, so an old client and a log shipped
    elsewhere still read English.
- **Copy.**
  - New namespace `auditRoutes` (`apps/web/src/i18n/locales/{en,es}/auditRoutes.json`), registered
    in `resources.ts`. It is a flat map keyed by the verbatim route key, `"POST /chats/:id/mcp/:name": "…"`.
  - Look strings up with
    `t(entry.route, { ns: 'auditRoutes', keySeparator: false, nsSeparator: false, defaultValue: entry.summary })`.
    The keys contain `:` and `.`.
  - A row with no `route`, or with a route missing from the map, shows the stored `summary`.
- **Generator.** `apps/api/scripts/generate-audit-strings.ts` (script `audit:strings` in
  `apps/api/package.json`, beside `openapi:schemas`):
  - It writes `en/auditRoutes.json` from every non-GET `ROUTE_DOCS` summary, sorted by key.
  - It adds keys missing from `es/auditRoutes.json` with the English text **and fails with the list
    of untranslated keys**. A person or a task then translates them. It never overwrites an
    existing `es` value.
  - It drops keys whose route no longer exists from both files.
- **Spanish.** The `audit` task translates all 286 keys per `GLOSSARY.md`: Spain, sentence case,
  and the infinitive, as for buttons ("Crear un chat", "Activar el servidor MCP de Claudio en un
  chat"). Literals stay as written (`CLAUDE.md`, `git push`, `MCP`).
- **Test.** `apps/api/test/audit-strings.test.ts` checks four things:
  - every write route of `ROUTE_DOCS` has a non-empty `en` and `es`;
  - `en` equals the summary;
  - no `es` equals its `en` unless the string has no letters to translate, or is listed in an
    explicit `SAME_IN_BOTH` set (`MCP`, a product name);
  - no key is orphaned.
- **Actors.** Shown as words in sans: `local` is "Local access" / "Acceso local", `desktop` is
  "Desktop app" / "Aplicación de escritorio", `env` is "Environment" / "Entorno", `claudio` is
  "Claudio" / "Claudio", and `anonymous` is "Anonymous" / "Anónimo". `token:<id>`, `chat:<id>` and
  an OIDC subject stay mono through `FullText`.
- **Method.** Mono, not `strong`, in `--fg-2`, followed by the path in mono.
- **Desktop width.**
  - The table fits the settings column with no sideways scroll at 1280: `table-layout: fixed` on
    `.audit-table`.
  - When: `nowrap`, about 11ch.
  - Who: capped at 16ch, ellipsis and `FullText`.
  - Request: method and path on one line, with the path capped by ellipsis and `FullText`.
  - Result: `nowrap`.
  - What: takes the rest and wraps.
- **Height.** The audit is paged, so its wrapper gets a modifier, `.table-wrap.is-paged
  { max-height: none; }`. The global `.table-wrap` cap stays for the other eleven components.
- **Phone.** Below 560 px of the card (container query), `AuditTable` renders
  `ul.audit-rows` > `li.audit-row`, the D4 pattern:
  1. Time, then "·", then the actor, then the result at the end of the line.
  2. What, in sans, wrapping.
  3. The method and the `shortPath`'d path in mono, `--fs-small`, `--fg-3`, as a tap-to-reveal
     button like D4.
- `GET /audit` keeps its query. `path` still filters on the path.
- The doc comments that list the actors (`types.ts:5096-5100`, `routes.ts:761`, the `/audit` row
  of `docs/rest-api.md`) name all of them.

### D6. One reset contract for every server-side setting: `DELETE /settings/state/:setting`

The owner asked for Reset on every settings row, in every group. Two shapes were possible.

**Rejected: `PUT` with `null` meaning "remove", store by store.** `null` is already a real value:
`dailySpendCapUsd: null` is "no cap", and `auth.oidc: null` deletes OIDC. The eight stores also
write differently: some replace the whole document, some merge. The meaning of `null` would
change from route to route. And every store would need its own check against chat tokens.

**Chosen: one registry in core, keyed by the setting ids `settingsIndex.ts` already uses.**

- `GET /settings/state` returns `{ settings: Record<id, SettingState> }`.
- `DELETE /settings/state/:setting` removes the person's stored value for one row, so the default
  applies again, and future defaults too.
- `GET /settings/overrides` (D7) uses the same ids.

The reasons:
- One id space for search, `data-setting`, Reset and overrides.
- One route to document and audit.
- One place for the chat-token refusal (`fromChat`, `apps/api/src/routes/app-settings.ts:12`).
- A Reset that **removes** the key instead of writing the default, so the row follows a default that
  changes later, or differs by distribution (`defaultPermissionMode` is `bypassPermissions` in the
  image, the terminal's `remote` is `any` in docker). That is why the default comes from the server
  and is never hard-coded in the web.

The rules:

- **changed** = the store holds a value for the row **and** it deep-differs from the default. A
  value equal to the default is "not changed", even when stored. Stores that write their whole
  document on every save stay correct with no change to how they write.
- **source** is `env`, `stored` or `default`.
  - `env`: the row shows `EnvNote` and no Reset (`changed: false`). `DELETE` answers 409
    `setting-from-env`.
- **A chat's token cannot reset** (403), for every id. It is the person's action, as the spend cap
  and the evals already are.
- The reset goes through the store's own write path. It is chained and atomic, and emits the event
  the store's `PUT` emits. Pattern: `app-settings.ts:262-268`.
- **A point's reset removes `mode` and `threshold` and keeps `consent`.** Consent is the person's
  grant, and it is withdrawn on its own.
- **Draft screens** (Decisions, the rotation form) apply the returned value to that field of the
  draft right away. Other unsaved edits stay. Otherwise a later Save would write back the old value.
- **Browser settings** (theme, language, motion, notification kinds) never reach the server. The web
  resets them with the same row slot. "Changed" is "the stored key differs from the default". Reset
  removes the `localStorage` key.
  - Theme defaults to `dark`.
  - Language defaults to the browser's language, falling back to `en`.
  - Motion defaults to `full`.
  - Notification kinds default to `defaultPrefs()`.
  - Theme and language always write their key today. They stop writing it when the person picks the
    default.

**What gets a Reset.** Reset is offered on a row whose value is a preference with a default. It is
not offered on identity, credentials, lists the person builds item by item, security state that
changes who can reach the server or the shell, actions, or status. The inventory below is the
contract. `settings-core` confirms each path in the code and stops to report any row that does not
fit.

| Row id (`data-setting`) | Store → path | Reset |
| --- | --- | --- |
| `appearance.theme`, `appearance.language`, `appearance.motion` | browser | yes (web only) |
| `notifications.kinds` | browser, the kinds blob | yes (web only) |
| `notifications.devices`, `updates.*`, `install.app`, `sign-in.*`, `provider.check`, `behaviour.settings-json`, `files.tree` | — | no: devices, actions or status |
| `provider.binary` | `providers.json` → `providers.*.binaryPath` | yes (all providers; only Claude Code runs today) |
| `provider.limits` | `providers.json` → `rotation.onLimit` | yes |
| `connectors.*`, `code-hosts.*`, `trackers.*`, `webhooks`, `mcp.servers` | — | no: connections and credentials |
| `instructions.claude-md`, `memory.projects`, `rules.list`, `output-styles.list`, `lessons.global`, every `extensions` `*.list` | — | no: documents and lists |
| `lessons.miner-model` | `lessons.json` → `miner.model` | yes |
| `lessons.miner-effort` | `miner.effort` | yes |
| `lessons.max-cost` | `miner.maxCostUsd` | yes |
| `lessons.project-daily` | `caps.perProjectDailyUsd` | yes |
| `lessons.global-daily` | `caps.globalDailyUsd` | yes |
| `lessons.chat-minutes` | `caps.perChatMinMinutes` | yes |
| `lessons.jobs-daily` | `caps.perProjectDailyJobs` | yes |
| `lessons.approve-floor` | `confidence.approveFloor` | yes |
| `lessons.deliver-at` | `confidence.deliverAt` | yes |
| `lessons.budget` | `delivery.handoffBytes` (confirm in `LessonsTab.tsx`) | yes |
| `lessons.loose-chats` | `delivery.looseChats` | yes |
| `lessons.repeated-errors` | `signals.repeatedErrorsTrigger` | yes |
| `lessons.manual-mining` | `manualMining` | yes |
| `engine.who-answers` | `decisions.json` → `provider` | yes |
| `engine.cap` | `cli.maxCostUsd` | yes |
| `engine.cli-model` | `cli.model` | yes |
| `engine.cli-effort` | `cli.effort` | yes |
| `engine.history-days` | `historyDays` | yes |
| `engine.jev-key` | — | no: a secret, with its own Remove |
| `point-<id>` (29) | `decisions.json` → `points[id].{mode,threshold}` | yes, consent kept |
| `points.history`, `machine.history`, `audit.log`, `agent-reads.log` | — | no: logs |
| `runs.permission-mode` | `app-settings.json` → `defaultPermissionMode` | yes |
| `runs.concurrent` | `maxConcurrentRuns` | yes |
| `spend-cap.daily` | `dailySpendCapUsd` | yes (back to "no cap") |
| `evals.phase-2` | `evalsPhase2` | yes |
| `hosts.allowed` | — | no: a list, with a per-host remove |
| `access.mode`, `access.token`, `access.read-only`, `secrets.storage` | — | no: who can reach the server |
| `remote.tunnel` | `tunnel-settings.json` → `startWithClaudio` | yes |
| `guards.mode` (new id) | `guards.json` → `mode` | yes |
| `guards.automated` (new id) | `automated` | yes |
| `guards.rule.<ruleId>` (new ids: `no-verify`, `push`, `destructive`, `secrets`, `protect-configs`) | `rules[ruleId]` | yes |
| `guards.rules` | the block that holds them | — (its rows carry the Reset) |
| `terminal.enabled`, `terminal.remote` (new id) | — | no: who gets a shell |
| `terminal.max-terminals`, `terminal.idle-minutes`, `terminal.scrollback`, `terminal.replay`, `terminal.shell`, `terminal.login-shell` (new ids) | `terminal.json` → the field | yes |
| `accounts.rotate-on-limit`, `accounts.threshold`, `accounts.hysteresis`, `accounts.cooldown`, `accounts.strategy` (new ids, `/accounts` page) | `accounts.json` → the field | yes |
| `collaborators.relay`, `collaborators.assistant-reads` (new ids, `/collaborators` page) | collaborators → `relayUrl`, `assistantReads` | yes |
| `collaborators.enabled`, display name, label | — | no: the module switch and identity |

- The new ids for rows inside Settings join `settingsIndex.ts`, so search finds them. Their label
  and keywords keys go in `config.json` under `settings.rows`.
- The `accounts.*` and `collaborators.*` ids live on their own pages and do not join Settings search.

### D7. "Overridden in N projects" on the global row

- `GET /settings/overrides` answers `Record<id, projectId[]>` (only ids with at least one project).
  The project ids are sorted by project name. Core computes it from `core.projects()`:
  - `engine.who-answers`: `decisions.provider` set and not `inherit`.
  - `point-<id>`: `decisions.points[id].mode` or `.threshold` set.
  - `provider.limits`: any field of `providers.onLimit`.
  - `provider.order`: `providers.order` set. There is no global order row, so the web shows it on
    the Provider section's head line.
  - `guards.rule.<ruleId>`: any stage of `flow.guards` sets `rules[ruleId]`.
- Not counted: `lessons.*` and `guards.chats`. They are project-only settings with no global row of
  the same setting. Showing "overridden" on an unrelated global row would say something false.
- The web reads it once per Settings visit (React Query, invalidated on any project settings save).

### D8. No consent means off, and the row says so and offers the way out

- The engine is right. Nothing changes in `engine.ts:162`.
- `points.limited` is replaced by `points.offUntilConsent`:
  - en "Off until it has consent."
  - es "Apagado hasta que tenga consentimiento."
- It shows when `mode !== 'off' && needsConsent(info, consent, provider)`, for shadow and active
  alike, independent of `isLimited`. Tone warn, always with the word, and the `TriangleAlert` icon
  beside it.
- Beside it, a `link-btn` "Review and consent" / "Revisar y consentir" calls
  `onReviewConsent(info.id, mode)`. `Points` passes the callback down from `groups/Decisions.tsx`,
  where it calls the existing `setAsking({ id, mode })`. The existing `ConsentDialog` opens with the
  current mode. `onGranted` sets the mode (unchanged) and clears `asking`. Check that the decision
  settings query is invalidated after the grant, so the row's consent state refreshes. Add the
  invalidation if the dialog does not already do it.
- `isLimited` keeps its other meaning, an act point on `cli`, which has its own copy if any. Its
  doc comment and `engine.ts:68-69` say "a point without consent is off", not "asks nothing as
  active". If any other consumer of `limited` (grep `limited` in `apps/web/src` and `packages/core`)
  words it as "runs as shadow", correct it the same way.
- Remove `points.limited` from both locales if nothing else uses it.

### D9. The isolation study records the owner's answers of 2026-10-20

The text to write into `docs/plans/process-isolation.md` (prose only):

- **Status header.** "Study (#32), parked 2026-10-17. Decided: D1 no host limits for now
  (2026-10-17), D3 parked (2026-10-17), D2 and D4–D8 decided by the owner on 2026-10-20 (§7)."
  Keep the tag `parked`.
- **§7.** Replace ":405 … D4 to D8 — the owner reviews them in this pull request. D2 stays his,
  unanswered." with a dated line "**Owner, 2026-10-20:**" and under each D its decision:
  - **D2.** Subscriptions go through the credential proxy: the claude.ai accounts reach isolated
    and remote workers through the proxy. This is the owner's choice. Keep the study's caveat beside
    it, written out: Anthropic's consumer terms (the text quoted in §6, :396-401) may limit using a
    claude.ai login from a third-party program, so re-check them before the proxy is built. The
    proxy must also be designed against the one rule: it may only carry what the CLI sends through
    a documented surface, and needs its row in `docs/cli-surfaces.md` before it is built (D8).
  - **D4.** (b): the devcontainer is optional, an attribute of the container provider.
  - **D5.** (a): one queue for chats and orchestrations. The `InteractiveHold` priority for people
    stays (`packages/core/src/admission-queue.ts`, #38).
  - **D6.** (a): native with systemd for the host-scope provider. The container image and Helm (the
    signed bundle overlay, no Docker socket, #46) are first-class supported forms too, not
    leftovers.
  - **D7.** (a): only installs of the same owner for the first remote provider.
  - **D8.** (a): implement the runner contract (stdin, stdout, kill, exit) with no SDK dependency.
- **Stale facts.**
  - §3 gains a dated paragraph on what exists since the study: `InteractiveHold`; `server.lock` in
    `packages/core/src/data-dir-lock.ts`; the `CLAUDIO_*` allow-list in
    `packages/shared/src/server-env.ts`; the terminal peer check in
    `packages/core/src/terminals/peer.ts`.
  - §5 and §6 say that sign-in is the in-app `claude auth login` since #46, not a long-lived
    `setup-token` token. Keep the historical sentences as history, marked "at the time of the
    study".
- **`docs/providers.md:31`.** Reconcile with CLAUDE.md in the same change. The rule allows the
  vendor's official SDK as part of "the interface its vendor ships for programs". For Claude Code,
  Claudio uses the CLI and takes no SDK dependency, per D8 of the study. Replace "No SDK," with that
  sentence, linking the study.
- **Related** gains `[[plans/container-polish.md]]`.

## Design

Every visual change follows [docs/design-system.md](../design-system.md) and the `claudio-ui`
skill:

- Tokens only, in both themes, with contrast ≥ 4.5:1.
- A status colour always goes with a word or an icon.
- Mono only for literals.
- Four sizes and two weights.
- Nothing here moves: no spinner, no `--live`, no energy border. Nothing in this change is an agent
  working.

### The "Changed · Reset" slot (D6)

```
Concurrent runs                                   [ 12        ]
Up to 12 chats and workers at once                ● Changed · Reset
```

- **Component.** `SettingChange` in `apps/web/src/pages/config/SettingChange.tsx`. Its props are
  `{ state: { changed: boolean; source: 'env' | 'stored' | 'default' }, defaultText: string,
  onReset: () => Promise<void> | void, overridden?: { count: number; href: string } }`.
  - `PrefRow` gains `change?: ReactNode` and renders it in a new `.pref-row-change` cell, under the
    control in the control column.
  - Rows that cannot be a `PrefRow` render `SettingChange` themselves, in a `.pref-row-change` cell
    of their own: `.dp-point`, `.prov-item`, a Switch inside a settings block, and the rotation form.
- **Look.**
  - A 6 px dot in `--fg-3`, neutral: a change is not a status, so it is never ok, warn or bad.
  - Then the word "Changed" / "Cambiado" in `--fg-2`, `--fs-small`, `--fw-regular`.
  - Then "·", then the `link-btn small` "Reset" / "Restablecer" (`config:shared.reset`).
  - Reset's `Tooltip` and `aria-label` read "Default: {{value}}" / "Predeterminado: {{value}}". The
    value is worded the way the control words it: the option's label, a number through `format.ts`,
    "On"/"Off" ("Activado"/"Desactivado"), "No cap"/"Sin límite" for a null cap, and "Every rule's
    default" / "Los predeterminados de cada regla" for a composite value. The aria-label is "Reset
    {{setting}} to its default ({{value}})" / "Restablecer {{setting}} a su valor predeterminado
    ({{value}})".
- **Space.** The cell keeps its room when nothing is changed (`visibility: hidden`, and
  `aria-hidden` on the hidden content). Nothing shifts when it appears (I4).
  - **Revised 2026-10-24** (the PR #55 `/ui-review`, R4: the reserved slot made every row 28 px
    taller at 1280 and left a ~62 px blank band on a phone). On a desktop the slot sits **inline on
    the row's head line** (the end of the label's line or of the control's line, a
    `.setting-change-row` grid column), takes no extra height and never wraps inside itself; its
    width stays reserved there, so nothing shifts sideways. On a phone (≤ 900 px or a coarse
    pointer) nothing is reserved: the slot appears only while the value differs from the default,
    on its own line under the consequence, left aligned, with a 44 px Reset. That line comes and
    goes with the person's own edit or Reset; a shift within 500 ms of their input is not
    cumulative layout shift. A field a Reset closes (the spend cap's amount) keeps its room hidden
    until the person's next toggle, so the Reset moves nothing on a desktop. Row heights, before →
    after: Runs at once 114 → 90 px at 1280 (142 → 148 at 390, slot shown), the spend cap 268 → 232
    (324 → 316), Evals 136 → 100 (204 → 196), a changed decision point 81 → 81 (227 → 260, its
    evidence links now on lines 26 px apart so their 44 px targets do not overlap), an unchanged
    one 78 → 78 (182 → 134).
- **Env.** A value set by the environment keeps its `EnvNote` in the same cell and gets no Reset.
- **After Reset.**
  - The control shows the default.
  - The cell hides.
  - Focus moves to the row's control, so it is not lost on a hidden button.
  - A polite live region announces "Restored to the default" / "Valor predeterminado restablecido".
  - No toast.
- **Errors.** A failed reset shows the server's message in the cell's reserved line, in `--bad`
  with its icon. The value stays.
- **Phone (≤ 900 px or a coarse pointer, revised 2026-10-24).** The cell wraps under the
  consequence line, left aligned, only once the value is changed. Reset is ≥ 44 px tall (`--touch`).
  After a Reset the line keeps its room, hidden (`data-held`), until the next change: the second
  `/ui-review` measured a 0.027 shift with `hadRecentInput: false` when the answer took 700 ms.
- **Project rows.** They keep their own "Use global" (`ProjectDecisions.tsx:238-245`) and do not
  get `SettingChange`.

### The overridden line (D7)

```
Who answers                                       [ Claude Code CLI  v ]
Uses your Claude Code quota · Overridden in 2 projects
```

- Neutral text in `--fg-3`, appended to the consequence line after "·".
- "Overridden in {{count}} project(s)" / "Cambiado en {{count}} proyecto(s)" (the existing keys) is
  a `Link` to `/?project=<first>&view=settings`, with no tone.
- Its `Tooltip` lists the project names (at most 5, then "and {{count}} more" / "y {{count}} más").
- Shown on `engine.who-answers`, each `point-<id>`, `provider.limits`, each `guards.rule.<id>` row,
  and the Provider section's head line (for `provider.order`).
  - **Revised 2026-10-24.** The provider has no row of its own for its limits: they are the
    section's, so `provider.limits` is said on the Provider section's head line
    (`SettingsSection`'s `aside`, `.settings-section-head`), not in the provider item's status
    column. `provider.order` is not shown yet: with Claude Code the only provider that runs, there
    is no order to override.

### Terminal history rows (D4)

```
20 Oct, 14:32 · Owner
…/.claude/worktrees/polish                        (mono, tap to show all)
Closed for inactivity   [Refused ×2: peer]
```

- The `.term-history-row` rows are separated by a 1 px `--line` hairline, with no card. The time is
  in tabular sans and the cwd is in `--fs-small` mono, in `--fg-2`.
- The expanded cwd wraps with `overflow-wrap: anywhere`. The button's focus ring is visible, and
  its tap target is ≥ 44 px.
- Copy: the existing `history.*` keys in `terminal.json`, plus `history.actors.owner` and
  `history.actors.anonymous` (above), and `history.showPath` / `history.hidePath` ("Show the full
  path" / "Mostrar la ruta completa", "Hide the full path" / "Ocultar la ruta completa") for the
  button's `aria-label`.

### Audit rows (D5)

```
14:32:05 · Desktop app                                  201
Activar el servidor MCP de Claudio en un chat
POST /chats/1f3a…/claudio-mcp                           (mono, tap to show all)
```

- The result keeps the outcome words of `outcome()` (`AuditCard.tsx:27`) with their tones.
- At 560 px and wider, the table is the D5 table.

### The consent line on a point (D8)

```
Shadow  ▾      ⚠ Off until it has consent. · Review and consent
```

- The warning sits in `.dp-evidence-consent.is-none` with `TriangleAlert`, as warn.
- The `link-btn` follows after "·". It is ≥ 44 px on a phone and wraps under the line.

### What goes into the design system

Each task appends its subsection. None rewrites another's.

- `docs/design-system.md`:
  - §"The setting row (Settings)" (:2514) gains rows for `.pref-row-change` and `SettingChange`
    (`settings-web`).
  - §"Terminal" (:1985) gains `.term-history-row` (`terminal-phone`).
  - A new "Audit log" subsection goes after "Guards" (`audit`).
- `docs/design-system/claudio-ds.css` gains the matching rules next to `.guard-event` (:2671), each
  task in its own block.

## Contracts

### Shared types (`packages/shared/src/types.ts`)

```ts
// audit
export interface AuditEntry {
  // … as today, plus:
  /** `METHOD /pattern` as `ROUTE_DOCS` keys it (`POST /chats/:id/mcp/:name`); null for rows written before it, or no matched route */
  route: string | null;
}

// settings-core
/** Where a setting's value comes from: the environment (read-only here), what the person stored, or the default */
export type SettingSource = 'env' | 'stored' | 'default';
/** A setting's default, as the store defines it; the web words it */
export type SettingDefault = string | number | boolean | null | string[] | { [key: string]: string | number | boolean | null };
export interface SettingState {
  /** The stored value differs from the default: the row shows "Changed · Reset" */
  changed: boolean;
  source: SettingSource;
  default: SettingDefault;
}
/** `GET /settings/state`: every server-side setting a row can reset, by its `data-setting` id */
export interface SettingsState {
  settings: Record<string, SettingState>;
}
/** `GET /settings/overrides`: the projects that override each global setting, sorted by project name; only ids with one or more */
export type SettingOverrides = Record<string, string[]>;
```

- `packages/shared/src/setting-ids.ts` (new, exported from the package index) holds the server
  setting ids as a `const` tuple, `SERVER_SETTING_IDS`, and `type ServerSettingId`. It builds the
  `point-<id>` ids from `DECISION_POINT_IDS` and the `guards.rule.<id>` ids from the guard rule
  ids.
  - Core's registry is a `Record<ServerSettingId, SettingEntry>`, so the compiler catches a missing
    id.
  - A web test checks that every id in Settings (not `accounts.*` or `collaborators.*`) exists in
    `settingsIndex.ts`.

Regenerate the schemas once all types are in: `pnpm --filter @claudio/api openapi:schemas`.

### Routes

All three new routes use the tag `Configuration`, as `/settings/app` does (`routes.ts:622`), and
each gets a row in `docs/rest-api.md` beside `/settings/app` (:813). Use the `add-rest-route` skill.

| Route | Answer | Errors |
| --- | --- | --- |
| `GET /settings/state` | `SettingsState` | — |
| `DELETE /settings/state/:setting` | the `SettingState` after the reset | 404 for an unknown id, 409 `setting-from-env`, 403 for a chat's token |
| `GET /settings/overrides` | `SettingOverrides` | — |

- `DELETE /settings/state/:setting` summary: "Reset a setting to its default". Its description
  says that it removes the stored value, that it emits the store's own change event, and that a
  point keeps its consent.
- `GET /audit`: the description and the `docs/rest-api.md` row name the full actor list and the
  `route` field.
- The audit's `auditRoutes` map gains the one new write route, `DELETE /settings/state/:setting`
  (en "Reset a setting to its default", es "Restablecer un ajuste a su valor predeterminado"). See
  the `review` task.

### Database (`packages/core/src/db.ts`)

- One new migration, appended: `ALTER TABLE audit ADD COLUMN route TEXT;`.
- `appendAudit` and `auditPage` read and write the column.
- No settings move to SQLite. They are settings-shaped JSON documents (CONTRIBUTING), and the reset
  goes through each store's own chained write.

### Core

- `packages/core/src/settings-registry.ts` (new) exports `createSettingsRegistry(deps)`. Each entry
  is:

  ```ts
  interface SettingEntry {
    read(): { stored: boolean; value: unknown; default: SettingDefault; source: SettingSource };
    reset(): Promise<void>;
  }
  ```

  The registry also exposes `state(): SettingsState`, `reset(id): Promise<SettingState>` and
  `overrides(): SettingOverrides`. `changed` is `source === 'stored' && !isDeepStrictEqual(value,
  default)`.
- Each store gains one method to remove keys from its stored document and re-resolve:
  `resetKeys(paths: readonly (readonly string[])[]): Promise<void>`. It goes through the store's
  existing chained `writeAtomic`.
  - The stores are: `AppSettingsStore` (it also refuses env keys), `ProvidersSettingsStore`, the
    lessons, decisions, guards and terminal settings stores, the tunnel settings, `AccountStore`
    settings and the collaborators settings.
  - The stores that read "defaults for what is missing" (`lessons/settings.ts:10-11`, providers
    :79) need nothing else.
- `Core` exposes it as `core.settings` (wired in `packages/core/src/index.ts` beside
  `appSettings`).

### i18n

Keys go in the namespace that owns the component, with `en`/`es` parity, following
`apps/web/src/i18n/GLOSSARY.md`. Each task adds keys only inside its own subtree and never
reformats a file:

- `config.json` `settings.change.*` (`settings-web`), `audit.*` (`audit`).
- `decisions.json` `points.*` (`decisions-consent`).
- `terminal.json` `history.*` (`terminal-phone`).
- `chats.json` `list.*` (`polish-small`).
- `auditRoutes.json` (`audit`).

The copy:

| Key | en | es |
| --- | --- | --- |
| `settings.change.changed` | Changed | Cambiado |
| `settings.change.default` | Default: {{value}} | Predeterminado: {{value}} |
| `settings.change.resetLabel` | Reset {{setting}} to its default ({{value}}) | Restablecer {{setting}} a su valor predeterminado ({{value}}) |
| `settings.change.restored` | Restored to the default | Valor predeterminado restablecido |
| `settings.change.on` / `.off` | On / Off | Activado / Desactivado |
| `settings.change.noCap` | No cap | Sin límite |
| `settings.change.composite` | Every rule's default | Los predeterminados de cada regla |
| `settings.change.more` | and {{count}} more | y {{count}} más |
| `points.offUntilConsent` | Off until it has consent. | Apagado hasta que tenga consentimiento. |
| `points.reviewConsent` | Review and consent | Revisar y consentir |
| `list.chipModelPrefix` | Model: | Modelo: |

The audit's actor words and the terminal's actor words are given in D4 and D5.

## Tasks

The integrator launches this graph on `feat/settings-reset-and-polish`. It has three stages in
series (`docs/orchestrations.md`, "Writing an orchestration graph"):

```
polish-small ─────────────────────────────┬─ review (opus)
audit (opus) ─────────────────────────────┤
settings-core (opus) ──┐                  │
decisions-consent ─────┼─ settings-web ───┼─ docs (sonnet)
terminal-phone ────────┘                  │
isolation-doc ────────────────────────────┘ (review only)
```

| Id | Model | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- | --- |
| `polish-small` | claude-sonnet-5-5 | D1, D2, D3 | – | `apps/web/src/components/NotificationPanel.tsx`; the 22 `font:` lines in `shell.css`, `overlays.css`, `packages/chat-ui/src/styles/chat.css` and `transcript.css` (no other line of those files); `scripts/design-lint.mjs` (the `font` branch); `apps/web/test/design-voice.test.ts`; `packages/ui/src/components/ListToolbar.tsx` (`ListFilterChip.content`); `apps/web/src/pages/Chats.tsx` (the model chip, `Facet` `mono`); `chats.json` `list.chipModelPrefix`; tests; `e2e/specs/a11y-shell.spec.mjs` (Escape on the bell panel), `e2e/specs/chats.spec.mjs` (mono chip) | `pnpm typecheck`; `pnpm test` (ui, chat-ui, web); `node scripts/design-lint.mjs` over the touched CSS |
| `terminal-phone` | claude-sonnet-5-5 | D4 | – | `TerminalCard.tsx` (`History()` only); `apps/web/src/styles/terminal.css` (`.term-history*`); `terminal.json` `history.*`; its subsections in `docs/design-system.md` (§Terminal) and `claudio-ds.css`; tests; `e2e/specs/terminal.spec.mjs` (history at 390: rows, no sideways scroll) | `pnpm typecheck`; `pnpm test` (web); design lint |
| `audit` | claude-opus-5-5 | D5 | – | `packages/core/src/db.ts` (one migration, `appendAudit`, `auditPage`); `AuditEntry.route` in `types.ts`; `apps/api/src/security.ts` (the hook and `auditSummary` neighbour); `apps/api/scripts/generate-audit-strings.ts` and its `package.json` script; `apps/api/test/audit-strings.test.ts`; `GET /audit` in `routes.ts` and `docs/rest-api.md`; `apps/web/src/i18n/locales/{en,es}/auditRoutes.json` and `resources.ts`; `AuditCard.tsx`; `lists.css` (`.audit-*`, `.table-wrap.is-paged`); `config.json` `audit.*`; its subsection in `design-system.md` and `claudio-ds.css`; a core test that upgrades a database across the migration (pattern: the `*_SCHEMA_VERSION` constants, `db.ts:1409-1491`); `e2e/specs/security.spec.mjs` (Spanish summary, rows at 390) | `pnpm typecheck`; `pnpm test` (core, api, web); `openapi:schemas`; `pnpm --filter @claudio/api audit:strings` exits 0 |
| `settings-core` | claude-opus-5-5 | D6, D7 server side | – | `packages/shared/src/setting-ids.ts`; `SettingState`, `SettingsState` and `SettingOverrides` in `types.ts`; `packages/core/src/settings-registry.ts`; `resetKeys` in each store listed under Contracts › Core; `core.settings` in `packages/core/src/index.ts`; `apps/api/src/routes/settings-state.ts` and its registration; the three routes in `routes.ts` and `docs/rest-api.md`; the client methods `settingsState()`, `resetSetting(id)` and `settingOverrides()` in `apps/web/src/api.ts`; tests in `packages/core/test` and `apps/api/test/settings-state.test.ts` | `pnpm typecheck`; `pnpm test` (shared, core, accounts, api); `openapi:schemas`; `rest-api-doc.test.ts` |
| `decisions-consent` | claude-sonnet-5-5 | D8 | – | `decisions/Points.tsx` (`ConsentPart`, the `onReviewConsent` prop); `groups/Decisions.tsx` (passing it, the invalidation); `decisions/model.ts` (doc comment); `engine.ts` (doc comment only, :68-69); `decisions.json` `points.*`; tests; `e2e/specs/decisions.spec.mjs` (shadow without consent → the line and the dialog) | `pnpm typecheck`; `pnpm test` (core, web); design lint |
| `isolation-doc` | claude-sonnet-5-5 | D9 | – | `docs/plans/process-isolation.md`; `docs/providers.md` (:29-33 only) | prose only: every path and link it cites exists |
| `settings-web` | claude-sonnet-5-5 | D6, D7 UI | `settings-core`, `decisions-consent`, `terminal-phone` | `SettingChange.tsx`; `PrefRow.tsx`; `editors.css` (`.pref-row-change`); `settingsIndex.ts` (new ids); `AppSettingsCards.tsx` (Runs, spend cap and evals rows onto `PrefRow`); `AppearanceTab.tsx`, `NotificationsTab.tsx` and the browser stores (`lib/theme.tsx`, `packages/ui/src/i18n/language.ts`, `packages/ui/src/lib/motion.ts`, `notifications-model.ts`: default and remove); `ProvidersTab.tsx`; `LessonsTab.tsx`; `decisions/Engine.tsx`; `decisions/Points.tsx` and `groups/Decisions.tsx` (the slot and the draft update, after `decisions-consent`); `GuardsCard.tsx`; `TerminalCard.tsx` (the settings rows, not `History()`); `RemoteAccessTab`; `pages/accounts/RotationCard.tsx`; `pages/collaborators/YouCard.tsx` and `AgentsCard.tsx`; `config.json` `settings.change.*` and `settings.rows.*`, and `accountsConfig.json` and `collaborators.json` labels if needed; its subsection in `design-system.md` and `claudio-ds.css`; tests; `e2e/specs/settings-reset.spec.mjs` (new: change, see Changed, Reset, see the default, reload, gone; env row without Reset; one override line) | `pnpm typecheck`; `pnpm test` (ui, web); design lint; `node scripts/ui-check.mjs` on `/settings?tab=runs` and `/settings?tab=decisions` if a dev server is up |
| `review` | claude-opus-5-5 | conventions, design, copy, the one rule, cross-task consistency; then the integration chores below | all seven | findings, one-line fixes nobody owns, and: run `audit:strings` and add the `es` line for `DELETE /settings/state/:setting`; run `openapi:schemas` once on the merged tree | reads; `audit:strings`; `openapi:schemas`; at most one `pnpm test` |
| `docs` | claude-sonnet-5-5 | `docs/layered-settings.md` and `docs/settings.md` (Reset, the registry, overrides); `docs/plans/settings-ia.md` (dated note: §6.0's changed dot, Reset and overridden are built, and the open items at :504-505 are closed); `docs/decision-engine.md` (:262, the row's "Off until it has consent" and its action); `docs/terminal.md` (history on a phone); `docs/security-model.md` or `docs/securing.md`, whichever describes the audit (route column, translated summaries); `docs/status.md`; this plan's Outcome | `polish-small`, `terminal-phone`, `audit`, `settings-web`, `decisions-consent` | the listed docs | prose only: every path and link it cites exists |

Files that several tasks touch:

- `types.ts`: `audit` and `settings-core` each add only their own interfaces.
- `routes.ts` and `docs/rest-api.md`: `audit` edits only the `/audit` entries, and `settings-core`
  only adds its three.
- `design-system.md` and `claudio-ds.css`: each task adds its own subsection.
- `config.json`: `audit` edits `audit.*`, and `settings-web` edits `settings.*`.
- `Points.tsx`, `Decisions.tsx` and `TerminalCard.tsx` are edited in sequence, through `dependsOn`.

The schemas and the audit strings are regenerated once, by `review`, on the merged tree.

### Rules for every task

1. Work only in your worktree, on your branch. Write Conventional Commits in English, with a body
   that says why. Never push.
2. Read CLAUDE.md and CONTRIBUTING.md first. TypeScript strict, no `any`, and respect
   `noUncheckedIndexedAccess`.
3. Run `pnpm typecheck` and `pnpm test` (through `node scripts/test-tmp.mjs`, which each package's
   `test` script uses), wrapped in `timeout` so that a hang fails instead of waiting. Write or update
   the e2e specs named in your row, but **never run `pnpm e2e`**. CI runs them.
4. UI tasks load the `claudio-ui` skill and follow `docs/design-system.md`:
   - tokens only, both themes;
   - every string through i18n with `en`/`es` parity and the glossary;
   - mono only for literals;
   - controls from `packages/ui/src/components/controls`;
   - before finishing, `node scripts/ui-check.mjs --route <route>` if a dev server is up. If it is
     not, say so: `/ui-review` runs after integration.
5. Keep every class and `data-setting` that the e2e specs select (`grep -rn` over `e2e/specs` for
   any class you touch). The `.pref-row`, `.dp-point`, `.guard-event`, `.audit-table` and
   `.term-history` classes stay.
6. Cite and follow one existing pattern per convention. The ones this plan read:
   - A JSON store's chained atomic write: `packages/core/src/app-settings.ts:262-268`.
   - A chat token refused on a person's setting: `apps/api/src/routes/app-settings.ts:12-15`.
   - A route doc entry: `apps/api/src/openapi/routes.ts:622`.
   - A migration that adds a column: `packages/core/src/db.ts:1286`.
   - A settings row: `apps/web/src/pages/config/AppearanceTab.tsx:122`.
   - A `link-btn` in a decision row: `apps/web/src/pages/config/decisions/Points.tsx:317-319`.
   - Wrapping rows instead of a table: `apps/web/src/pages/config/GuardsCard.tsx:349-375`.
   - A lint case: `apps/web/test/design-voice.test.ts:17`.
   - An API test: `apps/api/test/app-settings.test.ts`.
   - A web unit test: `apps/web/test/i18n.test.ts`.

### `polish-small`

- D1: `onEscapeKeyDown` and `onCloseAutoFocus` on the panel's `Popover.Content`. A web test in
  jsdom: open, press Escape, and `document.activeElement` is the bell, with no `role="tooltip"`
  mounted. Close by an outside click, and focus is not moved to the bell.
- D2: the 22 lines, the lint check, and lint cases for no weight (flagged), `--fw-regular` (clean)
  and `inherit` (clean).
- D3: `ListFilterChip.content`, the chip, and `Facet` `mono`. A test that the chip's accessible
  name is still `label`.

### `terminal-phone`

D4 as specified. A test renders `History` in a narrow container (mock the container query hook)
and finds `li.term-history-row` and no `table`. The actor words are sans, and an id actor is mono.

### `audit`

D5 as specified. The Spanish set is the bulk of the work: translate all 286 keys, reading each
route's description when the summary is ambiguous. Tests:

- the migration adds `route` and old rows read `null`;
- the hook stores the pattern;
- `audit-strings.test.ts`;
- the card shows a Spanish summary for a row with `route`, and the stored summary for one without;
- the actor words.

### `settings-core`

D6 and D7, server side. Confirm each path in the D6 table against the store's code. If a row does
not fit the rule, stop and report it in the task summary; do not invent a path. Tests:

- each store's `resetKeys` leaves every other key alone;
- `changed` is false for a stored value equal to the default;
- an env key answers 409;
- a chat token answers 403;
- a point's reset keeps its consent;
- overrides are counted from two seeded projects and sorted by name;
- `DELETE` emits the store's event.

### `decisions-consent`

D8. Tests:

- a shadow point without consent shows "Off until it has consent." and the link;
- the link opens `ConsentDialog` with mode `shadow`;
- granting refreshes the row to "Consented on …";
- an `off` point shows neither.

### `isolation-doc`

D9, prose only. Bump `updated_at` in both documents. Do not re-add them to the knowledge base.

### `settings-web`

D6 and D7, the UI. Read the state and the overrides through React Query. Invalidate a store's own
query after a reset. Put every row in the D6 table that says "yes" on `PrefRow` with `change`, or on
`SettingChange` directly where Context §6 names a custom row. Tests:

- `SettingChange` reserves its room (the hidden state is in the DOM with `visibility: hidden`);
- Reset calls the route and focuses the control;
- an env row shows `EnvNote` and no Reset;
- a browser setting resets to its default and removes its key;
- the Decisions draft takes the returned value and keeps an unrelated unsaved edit;
- the overridden link points at the first project.

## Tests

- Unit and API tests are listed per task above.
- e2e specs, written by the workers and run by CI only:
  - `a11y-shell` (Escape on the bell panel);
  - `chats` (the mono chip);
  - `terminal` (history at 390);
  - `security` (the audit in Spanish, rows at 390);
  - `decisions` (consent from a Shadow row);
  - `settings-reset` (new);
  - `ui-invariants` stays green with long content on the new rows.
- After integration:
  - `/ui-review` on `/settings?tab=runs`, `/settings?tab=decisions`, `/settings?tab=access` (guards,
    terminal, audit), `/accounts`, `/collaborators` and `/chats`;
  - in both themes, at 1280×720, 390×844 and 320.
- Then `pnpm e2e:remote` on the branch, watched with fail-fast.

## Risks

- **The Spanish of 286 summaries.** It is a large translation done by one task. The test catches a
  missing or untranslated key, not a bad one. `review` samples it against the glossary.
- **Pinning after a reset.** A draft screen that saves its whole document after a reset writes the
  default back as a stored value. It reads "not changed", because it equals the default, but it no
  longer follows a future default. That is acceptable. Making every store sparse is a larger change,
  left out on purpose.
- **Ids in two places.** `SERVER_SETTING_IDS` and `settingsIndex.ts` can drift. The web test ties
  them together.
- **The line-height change** in the transcript's code blocks (1.6 → 20 px) moves text by a fraction
  of a pixel per line. `/ui-review` checks the transcript.
- **The credential proxy (D9, D2)** is recorded as the owner's choice, with its open caveat about
  consumer terms. Nothing in this plan builds it.

## Open questions

None. On 2026-10-20 the owner chose: one pull request; terminal history as "Recent blocks" rows;
the audit translated per route, complete; Reset on every settings group; "Overridden in N
projects"; consent from the Shadow row with the engine unchanged; and the answers to D2 and D4–D8 of
the isolation study. The exclusions in the D6 table (security, identity, credentials, lists, logs)
apply the owner's "every setting" to what has a default. They are a design decision of this plan,
not a question.

## Outcome

Built by the orchestration's ten tasks on 2026-10-20, as one pull request. What was verified, and
what was not: the worker checks were the type checks and the unit suites of the packages each task
touched (web 1879 of 1879 on the audit branch, api 510 of 510); the browser suite, `/ui-review` and
the pull request's CI run after integration and are not recorded here yet.

**Built, as settled**

- **D1.** Escape on the notifications panel gives focus back to the bell, and only Escape does: an
  outside click or a link leaves focus where it put it.
- **D2.** All 22 `font:` shorthands name their weight and line height. `scripts/design-lint.mjs`
  flags a shorthand with a size and a family but no weight (`type-weight`).
- **D3.** The Chats model chip and facet draw ids in mono (`ListFilterChip.content`, `Facet`
  `mono`); the chip's accessible name is still its label.
- **D4.** The terminal history is wrapping rows below 560 px of the card and the table above it. A
  path that fits is text; a shortened one is a 44 px button that shows the whole path on tap.
- **D5.** `audit.route` (a migration; old rows read `null`), `AuditEntry.route`, the `auditRoutes`
  namespace in `en` and `es`, the generator (`audit:strings`) and its test, actors in words, and a
  table that fits the settings column at 1280 and wraps into rows on a phone.
- **D6 and D7.** `packages/core/src/settings-registry.ts`, the three routes, the `SettingChange`
  slot on every row of the inventory, the browser settings resetting by removing their key, and
  "Overridden in N projects".
- **D8.** A point that is not Off and has no consent says "Off until it has consent." and offers
  Review and consent. The engine did not change.
- **D9.** The owner's answers to D2 and D4–D8 are recorded in
  [process-isolation.md](process-isolation.md), and `docs/providers.md` is reconciled with the one
  rule.

**Where the build departed from the plan**

- **266 write routes, not 286.** The plan counted 286 from the route docs; the real count of
  POST/PUT/PATCH/DELETE routes the generator found on the audit branch is 266, and all of them are
  translated. `DELETE /settings/state/:setting` came in with `settings-core`, so `review` adds its
  Spanish line ("Restablecer un ajuste a su valor predeterminado") and runs `audit:strings` on the
  merged tree.
- **Audit table.** "When" puts the date and the time on two lines, "Who" is 12 characters wide
  rather than 16, a long result tag wraps inside its column, and on a phone the path is a button
  only when it was actually shortened. "Start a chat" reads "Crear un chat", as the plan's example.
- **Terminal history.** "Owner" and "Anonymous" are words in sans, as planned; the history rows
  use a container query, so they follow the card's width and not the viewport's.
- **Jsdom.** The repo has no jsdom, so D1's unit test is checks in `e2e/specs/a11y-shell.spec.mjs`
  instead; the web tests for the consent row render static markup, and the dialog opening and the
  refresh after a grant are covered by `e2e/specs/decisions.spec.mjs`.

**Left open**

- The browser specs written here (`a11y-shell`, `chats`, `terminal`, `security`, `decisions`,
  `settings-reset`) have not run: `pnpm e2e:remote` runs them on the branch.
- `/ui-review` on the screens listed under Tests, in both themes, at 1280, 390 and 320.
- Small notes from the reviews, none blocking: a shortened terminal path at 320 px can leave its
  last word alone on a second line; the 1280 table still breaks a long terminal path by character;
  the desktop audit path is cut at its end rather than in the middle; a row from a route missing
  from the route docs reads "No route matched"; the Spanish "400 · rechazado" tag wraps at 1280;
  `scripts/ui-check.mjs` captures dark screenshots for a route with a `#hash` even in its light
  pass; "token bearer" is not in the Spanish glossary.
- The credential proxy of D9 is the owner's choice, still caveated by Anthropic's consumer terms;
  nothing here builds it.

## Related

[[plans/settings-ia.md]] · [[plans/owner-report-fixes.md]] · [[plans/process-isolation.md]] · [[plans/container-polish.md]] · [[layered-settings.md]] · [[settings.md]] · [[decision-engine.md]] · [[terminal.md]] · [[guards.md]] · [[rest-api.md]] · [[design-system.md]] · [[providers.md]] · [[orchestrations.md]]
