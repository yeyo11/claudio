---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
tags:
    - development
    - e2e
    - monorepo
    - media
---
# Developing Claudio

Running it from a checkout, the browser suite, re-recording the README's media, and where each part
of the monorepo lives. The rules a change must follow are in [CONTRIBUTING.md](../CONTRIBUTING.md).
Until 2026-10-17 this page was the README's "Local development" and "Monorepo layout".

## Local development

Requires Node 22+, pnpm 10 and a logged-in `claude` CLI in your `PATH`.

```bash
pnpm install
pnpm dev          # API on :8797, UI on :5181 (proxies /api)
pnpm typecheck
pnpm test         # unit tests (shared, core, mcp, web, ui, chat-ui, desktop) + API integration (node:test)
pnpm build && pnpm e2e   # browser suite: isolated wrapper + headless Chrome, never touches ~/.claude
                         # E2E_SPEC_TIMEOUT (180000 ms) and E2E_TIMEOUT (1500000 ms) bound a spec and the run
                         # E2E_SERVER_START_TIMEOUT (120000 ms) bounds the wait for the API's /api/health
                         # E2E_SHARDS=N runs N isolated shards side by side (default: cores/2, at most 4);
                         # E2E_SHARD=k/N runs only shard k, as each CI job does (split: e2e/timings.json)
E2E_LIVE=1 pnpm e2e chat # specs that talk to Claude (logged-in CLI, costs a few tokens)
pnpm media        # re-record the README's tour and stills (needs pnpm build first, ~2 min)
```

Locally the wrapper uses your real `~/.claude`. Point `CLAUDE_CONFIG_DIR` somewhere else to
experiment with config writes safely.

The browser suite boots its own wrapper with temporary config, workspace and data directories (on
port 8809 when it runs as one shard; each parallel shard gets its own port, sandbox and Chrome), seeds whatever each spec needs and drives headless Chrome over the DevTools
protocol (no Playwright, no dependencies). A spec and the whole run each have a time limit, and Chrome
and the wrapper are closed on every way out (a pass, a failure, a timeout, `SIGINT`, `SIGTERM`, a crash),
by the pid the harness itself started. It covers every page in both themes and at phone
width, the config editors and their save/delete flows, the unsaved-changes guard, the command
palette and the chats list. The health actions need a live CLI process, so the specs that ask for it
(`export const fakeCli = true`) run last, behind one restart of the server, against the fake `claude`
in `e2e/fake-cli` — an executable that speaks just enough stream-json to hang a command, take a hint
and be interrupted; every other spec keeps the real CLI. `E2E_LIVE=1 pnpm e2e chat` additionally
holds a real conversation with Claude (streamed reply, follow-up turn, stop) using your login.

`pnpm media` re-records the tour and the stills the README shows, through the same fake CLI and one
headless Chrome: `scripts/record-media.mjs` boots an isolated wrapper, invents the projects, chats,
graph, schedules and accounts in frame, and writes `docs/media/`: the tour, desktop stills at
1280×800 and the working chat at phone size (390×844). It needs `pnpm build` first and takes about
two minutes. The board's stills (`board.png`, `board-mobile.png` and `work-item.png`) are not part
of it yet: they were captured the same way, with a one-off script against the same kind of sandbox.

## Monorepo layout

```
packages/shared   Types and the message normalizer shared by every package (the API contract)
packages/core     CLI communication: detection, auth, chat manager, transcript store,
                  orchestrator, rotation between accounts, config managers, the SQLite store
packages/accounts @claudio/accounts: the Claude accounts, their usage and the claudio-accounts CLI
packages/mcp      Claudio's own MCP server, which the assistant and confined chats reach it through
packages/ui       @claudio/ui: tokens, controls, dialogs, toasts, icons, illustrations, Markdown
packages/chat-ui  @claudio/chat-ui: the transcript, the composer, permission prompts, chat hooks
apps/api          Fastify REST API + SSE; serves the built UI in production
apps/web          React + Vite UI
apps/desktop      Electron shell: runs the API as a child process, packaged as AppImage and .deb
e2e/              Browser suite (headless Chrome over CDP, no dependencies)
scripts/          The installer, and record-media.mjs behind `pnpm media`
docker/           Dockerfile and the healthcheck
deploy/           Caddyfile for the `tls` compose profile, and the Helm chart
docs/             The knowledge base: guides, references, decisions and plans
```

Packages export TypeScript sources directly and the API runs through `tsx`, so development needs
no build step except for the UI. The image is built: it ships one compiled JavaScript file
(`/app/api.mjs`) and the built UI (`/app/web`), with no source tree, no `node_modules` and no
transpiler.

## Related

[[knowledge-base.md]] · [[status.md]] · [[desktop.md]] · [[deploy.md]] · [[plans/ci-e2e-shards.md]] · [[plans/web-packages.md]] · [[rest-api.md]]
