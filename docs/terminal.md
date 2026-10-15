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

- **Off by default.** Settings → Security → Terminal turns it on; `CLAUDIO_TERMINAL=off|on` overrides
  the switch for whoever deployed Claudio (the UI then shows it read-only).
- **Authentication off: this machine only.** From loopback, with no forwarded or runtime host.
- **Authentication on: the owner's token.** From another device only through the tunnel
  (`remote: 'tunnel'`, the default), or from any device with a token (`remote: 'any'`, which the
  card warns about). `remote: 'off'` keeps it to this machine.
- **Never** a chat's token, the desktop secret, or a process an agent started (peer check). Read-only
  mode refuses it.

The gate's reasons (`GET /terminal` → `reason`) are listed in the [REST API tables](../README.md).

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

- the chat header's Terminal button and `Ctrl+\`` open a dock under the transcript;
- the project page (`/terminals?project=`), reached from the project card and header and from the
  palette ("Open terminal in …");
- on a phone, `/terminals/:id` is a full screen with a key bar (Esc, Tab, arrows, sticky Ctrl and Alt).

Every entry stays hidden unless `GET /terminal` says `available`. Colours come from the `--term-*`
tokens, in both themes; the cursor blinks only at motion level `full`.

## Checks

- Unit: `packages/core/test/terminals-*.test.ts`; API: `apps/api/test/terminals.test.ts`; web:
  `apps/web/test/terminal-*.test.tsx`.
- Browser: `e2e/specs/terminal.spec.mjs` (renderer forced to the DOM), plus the terminal page in
  `a11y-core.spec.mjs` (both themes, phone width) and the cursor in `motion.spec.mjs`.
- Performance: `node e2e/perf/terminal-perf.mjs` (see [reports/terminal-perf.md](reports/terminal-perf.md));
  budgets in `e2e/perf/budgets.json`.

## Related

[[plans/terminal.md]] · [[security-model.md]] · [[reports/terminal-perf.md]] · [[reports/terminal-t0.md]] ·
[[design-system.md]] · [[tunnel.md]] · [[deploy.md]] · [[desktop.md]]
