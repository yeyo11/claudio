---
created_at: 2026-10-15T20:00:00Z
updated_at: 2026-10-15T20:00:00Z
tags:
    - terminal
    - pty
    - websocket
    - security
    - feature
---
# The terminal

A real interactive shell per project and per chat, opened in the project's directory or in the
chat's worktree, in a panel of the web app (desktop and phone) and of the Electron app. It is **the
person's own shell**: Claudio never writes into it, never reads what it prints to decide anything and
never starts `claude` in it. The design, the threat model and the decisions are in
[the plan](plans/terminal.md); this page says what exists and how to use and check it.

## Who may open it

- **Off by default.** Settings → Access & safety → Terminal turns it on; `CLAUDIO_TERMINAL=off|on` overrides
  the switch for whoever deployed Claudio (the UI then shows it read-only).
- **Authentication off: this machine only.** From loopback, with no forwarded or runtime host.
- **Authentication on: the owner's token.** From another device only through the tunnel
  (`remote: 'tunnel'`, the default outside a container), or from any device with a token
  (`remote: 'any'`, which the card warns about, and the default in a container). `remote: 'off'`
  keeps it to this machine.
- **In a container the default is `any`.** Every request there comes from the Docker bridge, never
  from loopback, so `'tunnel'` made the terminal unusable rather than safer (`CLAUDIO_DISTRIBUTION=docker`
  picks the default; a value saved in `terminal.json` wins). The image makes an owner token on its
  first start ([deploy.md](deploy.md#the-first-run-token)), which is what the terminal then needs.
  The owner token already starts chats that run any command as `node`, so this adds no capability to
  its holder.
- **Never** a chat's token, the desktop secret, or a process an agent started (peer check). Read-only
  mode refuses it.
- **Limit with authentication off.** A process that detaches from its chat's process tree (`setsid -f`,
  a double fork) is no longer found by the peer check, so an agent that has a shell can reach the
  terminal. With token or OIDC authentication it cannot: it holds no credential. The owner accepted
  this on 2026-10-15 and the card warns about it beside the switch when the mode is `none`.

**Refusals are shown in words.** Settings → Access & safety → Terminal turns every reason the gate gives
into a sentence with a link to the fix where there is one (protect access with a token; open the
tunnel; read-only mode); it never shows the server's own English text. The switch returns to its value
and the sentence appears under it, and *Where it opens* can be chosen before the terminal is on.
Raising it from another device is refused by design (a remote caller must not widen its own access),
so the card does not offer a button for that: change it on this machine, or through the tunnel.

**Dev server.** `pnpm dev` proxies `/api` through Vite with `xfwd: true`. Opened at
`http://localhost:5181` or `http://127.0.0.1:5181` on this machine, the terminal works as it does in
production; opened from another device the proxy passes the client's address on, the API sees a
forwarded request from a client that is not loopback and refuses it (`needs-auth`, or the tunnel and
token rules). A dev server reached from a LAN device with a token needs `CLAUDIO_ALLOWED_HOSTS` for
its name and `remote: 'any'`; the ticket's `Origin` check is then against the proxy's rewritten `Host`
and refuses, so use the built app (`pnpm build && pnpm start`) for that. The rule is in
[security-model.md](security-model.md#the-terminal).

The gate's reasons (`GET /terminal` → `reason`) are listed in the [REST API tables](rest-api.md#terminal).

## What a shell gets

The person's login shell, in a clean environment: no `CLAUDIO_*` variable and none of Claude's
credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`), plus the
vault's tool credentials (GitHub, GitLab, YouTrack…) so `gh`, `glab` and the tracker CLIs work.

## Lifetime

Shells survive a page reload and an idle socket (idle timeout, cap per actor), several devices may
attach to one shell, and every shell ends when the server stops. The server keeps a headless copy of
the screen only to repaint a client that reattaches; it is never searched, logged or stored.
Scrollback, input and output are written nowhere. Sessions and attachments (no content) are SQLite
rows, shown in the card's history table.

## Where it is in the UI

- **The status bar.** A Terminal item (icon and the number of running shells) next to the usage and the
  account toggles a panel docked above the status bar, on every page. The panel holds all the terminals:
  one tab per terminal (named after its project or folder, with its status), switch, X to close and "+"
  to open another. "+" opens in the project chosen in the top bar; with All projects it is a menu of the
  projects. It is resizable by its handle, remembers open or closed and its height in the browser, and Esc
  hides it unless focus is inside a terminal. `Ctrl+\`` toggles it from anywhere.
- **That is the only desktop entry point** (owner, 2026-10-15). There is no Terminals page, no "Open
  terminal" button on a project, no palette command and no button in the chat header. An old `/terminals`
  link on a desktop shows the panel and goes to the home page.
- **Full screen and a window of its own** (desktop only, owner 2026-10-15). The header of the open
  terminal has **Full screen** (the Fullscreen API on the terminal's frame; Esc or the same button
  leaves; the button is hidden where the browser has no such API) and **Open in a window**, which opens
  `/terminal-window/:id`: that terminal alone, with no app shell, attached to the same shell as the
  panel (several clients may attach). The panel then shows the terminal as "En otra ventana" with
  "Traer aquí", which closes the other window; closing the window leaves the shell running and the panel
  shows it again. Windows know each other through a same-origin `BroadcastChannel`. In the Electron
  app the window is native (see [desktop.md](desktop.md#the-terminal)). A menu opened in full screen
  does not show (it is outside the element); leave full screen first.
- On a phone there is no status bar: More → Terminals lists the open terminals and offers "New terminal"
  (in the project chosen, or a menu of projects with All projects); a row opens `/terminals/:id`, a full
  screen with a key bar (Esc, Tab, arrows, sticky Ctrl and Alt).

**Closing.** X (`DELETE /terminals/:id`) ends the shell and removes the terminal from the list at once,
and forgets one that already ended. A terminal that ended by itself (the shell exited, idle, a server
restart) stays listed as "Cerrado" with "Abrir de nuevo" until X dismisses it, or an hour passes. The
history table keeps every session either way.

Every entry stays hidden unless `GET /terminal` says `available`. Colours come from the `--term-*`
tokens, in both themes; the cursor blinks only at motion level `full`.

## Checks

- Unit: `packages/core/test/terminals-*.test.ts`; API: `apps/api/test/terminals.test.ts`; web:
  `apps/web/test/terminal-*.test.tsx`.
- Browser: `e2e/specs/terminal.spec.mjs` (renderer forced to the DOM), plus a terminal's screen and the phone's list in
  `a11y-core.spec.mjs` (both themes, phone width) and the panel's cursor in `motion.spec.mjs`.
- Performance: `node e2e/perf/terminal-perf.mjs` (see [reports/terminal-perf.md](reports/terminal-perf.md));
  budgets in `e2e/perf/budgets.json`.

## Related

[[plans/terminal.md]] · [[security-model.md]] · [[reports/terminal-perf.md]] · [[reports/terminal-t0.md]] ·
[[design-system.md]] · [[tunnel.md]] · [[deploy.md]] · [[desktop.md]]
