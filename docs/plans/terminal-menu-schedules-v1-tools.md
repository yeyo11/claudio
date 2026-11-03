---
created_at: 2026-11-03T00:00:00Z
updated_at: 2026-11-03T00:00:00Z
tags:
    - plan
    - terminal
    - mcp
    - schedules
    - api
    - openai
    - ui
---
# Terminal context menu, phone paste, schedule tools in the MCP, `/v1` client tools named like Claude Code's

Status: **proposed, waiting for the owner's approval** before the orchestration is launched. One
branch, one pull request (`feat/terminal-menu-schedules-mcp-v1-tools`), five independent pieces.

## 1. Findings (verified in the code, 2026-11-03)

### 1.1 Right click in the desktop app

`apps/web/src/components/terminal/TerminalView.tsx` (`onContext`): with a selection the right click
copies it **silently** (no toast); with none it does nothing, and `apps/desktop/src` has no
`context-menu` handler, so Electron draws no menu either. Paste is only `Ctrl+Shift+V` or the `⋯`
menu. `docs/plans/terminal.md` promised "selection copies on right-click", so this is as planned, and
incomplete: there is no paste and no real menu.

### 1.2 Copy and paste on a phone

The `⋯` menu (`TerminalPanel.tsx`, entries `copy` and `paste`) already offers both, but:

- `paste()` reads `navigator.clipboard?.readText()`. Claudio is often opened over plain HTTP on a
  LAN address, where `navigator.clipboard` is `undefined`: the text becomes `''` and `sendPaste('')`
  does nothing, with no toast. `copyText` has a fallback for this case; `paste` has none.
- When the browser does refuse, the toast `notices.pasteBlocked` says "Paste with Ctrl+Shift+V
  instead", which a phone cannot do.

### 1.2b The dock stays open, empty, after the last terminal is closed

`TerminalDock` renders `TerminalWorkspace` with `scope={{ all: true }}`. Closing the last terminal
(`closeCurrent`, or the server ending it with `reason === 'closed'`) leaves `terminals` empty and the
workspace draws its `term-empty` body ("No hay ninguna terminal abierta…") inside the open dock: a
panel with nothing in it, to be hidden by hand. `bar.hide` already exists and `autoOpen` only runs
once per opening, so nothing hides it. Reported by the owner with a screenshot, 2026-11-03.

### 1.3 Schedules from an agent

Claudio's own MCP server (`packages/mcp`, tool names in `src/names.ts`) has no schedule tool, although
the REST API has the whole surface (`/schedules`, `docs/rest-api.md#schedules`).

**Correction, found while building (2026-11-03).** The first version of this section said a chat's
token is not refused on `/schedules`. That holds for the reads only. `security.ts` has no schedule
rule because the class lives in `ROUTE_DOCS`: `POST /schedules`, `PATCH /schedules/:id` and
`POST /schedules/:id/run` are `access: 'person'` (decision D1 of
[regression-fixes-2026-10-29.md](regression-fixes-2026-10-29.md), `/schedules` listed under
`person` in [../security-model.md](../security-model.md)), so a guarded install answers a chat's token
`403 chat-forbidden`. And `write-tools.test.ts` ("a chat token may call it (work)") refuses a write tool
that declares a `person` route. A schedule runs later with nobody watching, and its target is a whole
`NewChatRequest` or `OrchestrationSpec`, which `workFields` (top-level names only) cannot narrow.

### 1.4 `/v1` client tools that share a name with Claude Code's

`clientToolsProblem` (`packages/core/src/openai/client-tools.ts`) refuses a client tool named like a
built-in (`bash`, `edit`, `glob`, `grep`…), case-blind, with `400 invalid_request_error` on
`tools[i].function.name`. Reason: the model would see `Bash` and `mcp__client__bash` side by side and
a `tool_choice` or a call read back would be ambiguous. A coding-agent client sends exactly those
names, so it cannot use Claudio as its model.

The CLI can drop its own tools from the list instead of denying them: `--tools=<list>`, which
`args.ts` already passes for a confined chat (`spec.confine.tools`). A request whose declared
allow list is empty (`X-Claudio-Allowed-Tools: []`) says the client wants none of them.

## 2. Design

### 2.1 Terminal context menu (UI, `claudio-ui` skill, design system)

- **Desktop and any pointer device.** Right click on the terminal opens a `Menu` (the control from
  `packages/ui/src/components/controls`, never a native menu) at the pointer, with the same entries as
  the `⋯` menu's first group: **Copy** (disabled, with its reason, when nothing is selected),
  **Paste**, **Search**, with the shortcuts shown in mono (`Ctrl+Shift+C`, `Ctrl+Shift+V`,
  `Ctrl+Shift+F`). The entries are one list shared with `TerminalPanel` (`terminalEntries()`), so the
  two menus cannot drift.
- **Shift + right click** keeps the browser's own menu (what xterm users expect, and what spell
  checks and "inspect" need).
- A copy by right click now says so: the same `notices.copied` toast as the menu.
- The menu must open inside the terminal's bounds, close on `Escape`, return the focus to the
  terminal, and work in both themes with tokens only. No new colour, radius or duration.
- If the controls package has no pointer-anchored menu, the task adds one as a variant of `Menu`
  (anchor by `{ x, y }`), documents it in `docs/design-system.md` and `claudio-ds.css` in the same PR.
- **Phone.** A long press selects text (xterm); the `⋯` stays the way to copy. No context menu on
  touch: the `Sheet` the `⋯` already opens is the phone's version.

### 2.2 Phone paste

- `paste()` tries, in order: `navigator.clipboard.readText()` when it exists in a secure context;
  otherwise it opens a **paste sheet**.
- The **paste sheet** (a `Sheet` on a phone, a small `Dialog` on a desktop over HTTP) holds one
  multi-line text field at 16 px, autofocused, with the helper line "Press and hold, then choose
  Paste" and two actions: **Send to terminal** (the zone's primary action) and **Cancel**. The text
  goes through `sendPaste`, so it is cleaned, chunked and capped as any paste.
- The sheet also replaces the old error toast: `notices.pasteBlocked` no longer names a key. The
  copy says what to do ("Paste it in the box that opened").
- Touch targets ≥ 44 px; the field follows the on-screen keyboard like the composer does.
- Copy on a phone: `copyText` already has the HTTP fallback; the `⋯` menu keeps "Copy selection",
  and when nothing is selected the toast says how to select ("Press and hold the text to select it").
- Copy en/es with parity, `es` per `apps/web/src/i18n/GLOSSARY.md` (infinitive buttons, Spain).

### 2.2b The dock closes with its last terminal

- `TerminalWorkspace` gets an optional `onEmptied` callback. It fires when the list goes from at
  least one terminal to none **because a terminal was closed** (the person's close, or the server's
  `closed`), never on the first load and never when the list is empty because nothing was ever
  opened. `TerminalDock` passes `bar.hide`, and the "+" in the status bar opens the dock again, with
  its usual first shell.
- Closing one of several terminals changes nothing: the next tab takes the front.
- "No more" means none in the dock's scope, which is every project (`{ all: true }`): a terminal of
  another project keeps the dock open.
- Opening the dock with no terminal still shows the empty state until `autoOpen` opens a shell, as
  now. A terminal that ends by itself (`exited`, not `closed`) keeps its tab with the reopen action,
  so the dock stays.
- Focus goes back to where it was before the dock opened (the page), not to a hidden panel.
- No new copy, colour or motion: only a state change. The empty body stays for the places that use
  `TerminalWorkspace` without `onEmptied`.

### 2.3 Schedule tools in Claudio's MCP server

New tools in `packages/mcp`, each a thin wrapper over the REST route, named in `names.ts` and
catalogued in `tools.ts` (the test that compares the two stays green):

| Tool | Kind | Route |
|---|---|---|
| `list_schedules` | read | `GET /schedules` |
| `get_schedule_runs` | read | `GET /schedules/:id/runs` |
| `preview_schedule` | read | `GET /schedules/preview` (what a cron expression will do; saves nothing) |
| `create_schedule` | write | `POST /schedules` |
| `update_schedule` | write | `PATCH /schedules/:id` (`enabled` included, so no separate enable/disable) |
| `run_schedule` | write | `POST /schedules/:id/run` |

- Writes follow the existing rule: never in `--allowedTools`, so each call reaches the person as a
  permission prompt and nothing is created that nobody confirmed. **No delete tool**, like every other
  write tool (`names.ts`: "no delete, no setting, no account, no security").
- A schedule spends money while nobody watches, so `create_schedule` and `update_schedule` render
  the cron expression **in words** and the next fires from `preview` in the prompt, the target's
  kind (chat or orchestration) and the overlap policy, before the person answers.
- The assistant's write-prompt copy (`packages/chat-ui/src/lib/write-prompts.ts`) gets one entry per
  tool, en/es.
- Docs: `docs/plans/claudio-mcp-server.md` and the assistant's doc list the new tools.

**Built (2026-11-03).** The three reads (`list_schedules`, `get_schedule_runs`, `preview_schedule`)
are `work` routes. The three writes (`create_schedule`, `update_schedule`, `run_schedule`) are built
as the table says, with the prompts below, **but on an install that guards its API a chat's token gets
`403 chat-forbidden` from them** (see the correction in §1.3): the person approves the prompt and the
tool then answers the 403 as its error. Nothing was widened to avoid it: the routes stay `person`, and
`write-tools.test.ts` carries a three-route exception (`PERSON_UNTIL_APPROVAL`) that a test in
`schedule-tools.test.ts` keeps honest. The owner decides how they become usable, outside this task:

1. **Wait for the assistant's server-side approval** ([assistant-everything.md](assistant-everything.md)),
   which lets the assistant's token call `person` routes after a single-use approval bound to the
   call's body. The tools then work unchanged, and the exception is deleted.
2. **Reclassify the three routes as `work`**, with a check of the target's own fields for a chat's
   token (the same fields `POST /chats` and `POST /orchestrations` list in `workFields`, never a
   permission mode, a tool list or a server), in `apps/api/src/security.ts` and `routes.ts`, with
   `docs/security-model.md` and `route-access.test.ts` changed to match.

The tools build the target from named fields only, as `start_chat` and `launch_orchestration` do, so
a confirmed call cannot schedule more than the defaults. The prompt (`write-prompts.ts`, en/es) shows
the expression, the zone, what each fire starts, the overlap policy and whether it is on; the
permission component then asks `GET /schedules/preview` through the chat client's optional
`schedulePreview` and adds the expression in words and the next fires (and the server's reason when
the expression is wrong). A prompt is built from the input alone, so the preview is a read the app
makes, not something the tool knows.

### 2.4 `/v1` client tools named like Claude Code's

- **Rule.** When a request declares client tools **and** an explicit empty allow list
  (`X-Claudio-Allowed-Tools: []`), the chat starts with `--tools=` (no built-in tool at all). Then the
  model only sees `mcp__client__*`, there is nothing to be ambiguous with, and
  `clientToolsProblem` skips the built-in-name check for that request. Every other check stays (the
  length with the prefix, case-blind duplicates).
- Without the explicit empty list nothing changes: the `400` stays, and its message now says how to
  get past it ("send `X-Claudio-Allowed-Tools: []`, or rename the tool").
- **Plumbing.** A new optional `builtinTools?: string[]` on the chat spec (`driver.ts`), emitted by
  `args.ts` as `--tools=<list>` when set and not already set by `confine`; stored with the chat's
  policy so a continuation is compared with it (`ApiChatPolicy`), as the allow list is. A turn that
  continues a chat whose policy differs is refused as the other policy mismatches are.
- Confined (headless) chats already pass `--tools=`; they are not touched.
- A call the model makes of the renamed-in-practice tool comes back to the client under the client's
  own name (`clientToolName` already strips the prefix), so the client sees `bash` as it sent it.
- Docs: `docs/openai-compatible-api.md` (Names), the OpenAPI text of both routes in
  `apps/api/src/openapi/routes.ts`.
- **Security.** `--tools=` only removes tools; it never adds one, and the stub's calls still pass
  through `can_use_tool`. The `never bypassPermissions` rule of the surface is untouched.

## 3. Tasks

Models: `claude-sonnet-5-5` for the graph's workers, fixer and synthesis; `claude-opus-5-5` for the
`/v1` task (policy and process args) and the review. Never fable.

| Id | Task | Owns | dependsOn | Checks |
|---|---|---|---|---|
| `v1-tools` | §2.4: `builtinTools` on the spec, `--tools=` in `args.ts`, policy comparison, `clientToolsProblem` skip, message, docs and OpenAPI text, tests: the request of the owner's report (`bash`, `edit`, `glob` with `[]`) is served, the same without `[]` is the `400`, a continuation with another policy is refused, args snapshot | `packages/core/src/openai/*`, `packages/core/src/providers/*`, `apps/api/src/routes/openai.ts`, `apps/api/src/openapi/routes.ts`, `docs/openai-compatible-api.md`, tests | — | `pnpm typecheck`, core and api tests, `openapi:schemas` |
| `mcp-schedules` | §2.3: six tools, names, catalogue, rendering, write prompts en/es, docs, tests next to `write-tools.test.ts` and `write-tools-api.test.ts` | `packages/mcp/*`, `packages/chat-ui/src/lib/write-prompts.ts`, the plan docs, tests | — | `pnpm typecheck`, mcp and web tests |
| `term-menu` | §2.1: shared entries, pointer-anchored `Menu`, Shift keeps the native one, toast, tests (unit for the entries, e2e spec for the right click) | `apps/web/src/components/terminal/*`, `packages/ui/src/components/controls/*`, design-system docs and CSS if a variant is added, i18n en/es | — | `pnpm typecheck`, web tests, the token test, `e2e` gate on `terminal` specs through Sluice |
| `term-paste` | §2.2: the paste sheet, the fallback in `paste()`, copy of the toasts, i18n en/es, phone screenshots | same folder as `term-menu` | `term-menu` (shares `TerminalView.tsx` and `TerminalPanel.tsx`) | same, plus a phone-width e2e check |
| `term-autoclose` | §2.2b: `onEmptied` in `TerminalWorkspace`, `bar.hide` from the dock, focus back to the page; tests: the last terminal closed hides the dock, one of two does not, an empty first load does not, a terminal of another project keeps it | `apps/web/src/components/terminal/TerminalWorkspace.tsx`, `TerminalDock.tsx`, tests, e2e spec | — | `pnpm typecheck`, web tests, `e2e` gate on `terminal` specs through Sluice |
| `review` | `/ui-review` on the three terminal changes, both themes and phone; check the five tasks against this plan; one PR | — | the five above | `verify` with every gate, then `queue_enqueue` |

`v1-tools`, `mcp-schedules`, `term-menu` and `term-autoclose` run in parallel: they share no file (`term-autoclose` touches the workspace and the dock, not the view or the panel).

## 4. Not in this PR

- A rename layer for `/v1` tool names (rejected: a name map in every request, response and history
  for a case the empty allow list already covers). It stays an option if a client cannot send the
  header.

## Related

[[plans/terminal.md]] · [[openai-compatible-api.md]] · [[plans/claudio-mcp-server.md]] · [[rest-api.md]] · [[design-system.md]]
