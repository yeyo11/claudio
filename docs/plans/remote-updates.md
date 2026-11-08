---
created_at: 2026-11-08T15:16:33.108454577Z
updated_at: 2026-11-08T18:00:00Z
tags:
    - plan
    - updates
    - desktop
    - security
    - packaging
---
# Plan: remote, passwordless updates, stale assets and an unreachable server

Status: **built on 2026-11-08, awaiting the `review` task and the integrator**; orchestration `c1c8c025` on
branch `fix/remote-updates` from `main` (0.14.2), in parallel with the servers engine
(`docs/plans/claudio-servers.md` on branch `feat/servers`). Outcome per task in §6; the features are
documented in [updates.md](../updates.md), [desktop.md](../desktop.md),
[security-model.md](../security-model.md) and [pwa.md](../pwa.md).

## 1. What the owner asked for

"The update of Claudio does not work well. I want to launch it remotely, without a password, and
Claudio restarts by itself." His Claudios at 192.168.0.28-30 are desktop `.deb` installs. Then, with a
phone screenshot: after an update every Home widget reads "No se ha podido mostrar el widget …
'text/html' is not a valid JavaScript MIME type."

Owner's decisions (2026-11-08): a **systemd unit + polkit rule** shipped by the package (after
weighing AppImage: on Ubuntu 26.04 `kernel.apparmor_restrict_unprivileged_userns=1` leaves an
Electron AppImage without its sandbox, and a user-writable executable loses the root-owned trust
anchor of `docs/desktop.md`); restart **with confirmation** from any device; he accepts that any
process of his user can *start* the update (it can only install the newest signed `claudio` from his
repository); in parallel with the servers work.

## 2. Findings (evidence on the owner's machine)

1. **Nothing upgrades the package unattended.** Every `claudio` upgrade in `/var/log/apt/history.log`
   (0.6.0 → 0.14.2) is `apt-get install -y claudio` requested by the owner through sudo.
   `/etc/apt/apt.conf.d/50unattended-upgrades` allows only Ubuntu origins; the repository's `Origin`
   is `Claudio`. The premise of `docs/desktop.md` ("the system's updater does it") and D3 of
   `docs/plans/unified-updates.md` does not hold on a stock Ubuntu.
2. **0.14.2 could not be installed in-app.** Dependency PR #90 moved Electron 44 → 45, so the release
   carries `minShell 0.14.2`; the server answers `412 update.needs-shell`.
3. **False rollbacks.** `data/app/state.json` holds `"bad": ["0.13.0","0.14.0"]` and
   `lastRollback {from: 0.14.0, to: 0.14.0}`: when apt installs the same version as the overlay in
   use, `pick()` refuses the overlay as "not newer" and records it as a failed boot
   (`packages/core/src/launcher/machine.ts:118-121`), and the card says "0.14.0 did not start, so the
   app went back to 0.14.0".
4. **Restarting after a package upgrade is IPC-only** (`apps/desktop/src/main.ts:903-912`): a phone
   or another Claudio cannot finish it. The phone's card says the desktop app is updated on the
   computer that runs it.
5. **Stale chunks after an update.** `apps/api/src/app.ts:291-294` answers **every** unknown path
   outside `/api` with `index.html` and `200`, `/assets/<old-hash>.js` included; Safari reports
   "'text/html' is not a valid JavaScript MIME type", which `CHUNK_ERROR` in
   `apps/web/src/lib/reload.ts:26` does not recognise, so `WidgetBoundary`
   (`apps/web/src/pages/dashboard/Dashboard.tsx:9,33`) shows the raw English message per widget
   instead of the stale-build path (`noticeStaleChunk`).
6. The pkexec failure of 2026-10-20 (`pkexec must be setuid root`) is closed since 0.12 (R23); the
   app holds no escalation and `apps/desktop/test/updater.test.ts:142-144` forbids it. That rule stays.

Prior art: electron-updater's `.deb` path always needs an interactive pkexec prompt; VS Code, Plex and
Jellyfin leave updates to apt; Orca self-updates only its AppImage and its user-level remote server;
the passwordless and remote-capable pattern is a **root unit shipped by the package plus a polkit rule
that lets one group start exactly that unit** (ArchWiki's single-unit example), with no argument
reaching root and `--only-upgrade` so no downgrade (the PackageKit CVE-2018-1106 report). Pitfalls:
`exec.path` on an interpreter, arguments reaching the helper, apt lock contention, restart storms,
false health-check rollbacks (Home Assistant).

## 3. Decisions

- **D1. `claudio-update.service`**, a root oneshot unit shipped in the `.deb`: `apt-get update`
  limited to `/etc/apt/sources.list.d/claudio.sources` (`-o Dir::Etc::sourcelist=… -o
  Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0`), then `apt-get install --only-upgrade -y
  claudio` with `DEBIAN_FRONTEND=noninteractive`, waiting for the dpkg lock with a bounded timeout.
  It takes no argument and installs nothing but `claudio` from that signed source. It writes its
  outcome (`from`, `to`, `result`, `endedAt`, error text) to `/var/lib/claudio-update/status.json`
  (root-owned, world-readable). `StartLimitBurst` keeps a loop from hammering apt.
- **D2. A polkit rule** (`/usr/share/polkit-1/rules.d/50-claudio-update.rules`) lets members of the
  group `claudio-update` perform `org.freedesktop.systemd1.manage-units` **only** when
  `action.lookup("unit") == "claudio-update.service"` and `verb == "start"`. The postinst creates the
  group and adds the installing user (`SUDO_USER`, else `PKEXEC_UID`'s user); postrm removes the rule
  and the group. Membership takes effect at the next login: the card says so when the unit is there
  but the start is refused.
- **D3. The server starts it, never with pkexec.** `systemctl start --no-block claudio-update.service`
  as the user (polkit authorises), and reads its state with `systemctl show` plus the status file.
- **D4. Restart with confirmation, from any device.** Nothing restarts on its own after a package
  upgrade: the card shows the installed version and **Restart**; the person presses it from any
  device. The server asks the desktop shell to relaunch by exiting with a dedicated code (76, beside
  the payload's 75), which `apps/desktop/src/main.ts` turns into `app.relaunch()`; busy chats or
  terminals answer `409 update.live-work` unless the request says `whenIdle`.
- **D5. A package upgrade to the overlay's own version is not a failure.** The launcher drops the
  overlay quietly, records no rollback and does not add it to `bad`; the stale `bad` entries and
  rollback notice of 0.13.0 / 0.14.0 are cleared once.
- **D6. Old builds keep working until reloaded (skew protection).** Unknown paths that name a file
  (`/assets/*`, or any last segment with an extension) answer `404`, never `index.html`; `/assets`
  misses are served from the previous kept payload versions' web builds when the file is there there
  (immutable hashes, so it is safe); `CHUNK_ERROR` learns Safari's and WebKit's wordings ("is not a
  valid JavaScript MIME type", "Load failed" on an import); `WidgetBoundary` hands a chunk error to
  `noticeStaleChunk` and shows the stale-build message through i18n, never a raw English error; the
  service worker never answers an asset request with the shell.
- **D7. Fewer forced package upgrades.** Dependabot groups Electron and native-module bumps apart
  from the rest and leaves Electron majors out of the automatic groups; the release workflow prints a
  notice in the release PR when a release raises `minShell`.
- **D8. Who may trigger.** The new routes are `person` (chat tokens refused) and owner actors,
  including the servers plan's `server:*` actor, so a hub can update and restart a remote. The
  desktop credential's four update writes are not widened.
- **D9. "Server unreachable" is its own screen, not a reload offer** (owner, 2026-11-08). Two cases
  that the PWA used to blur: a **new version** (the server answers with another version, or an old
  chunk is gone) keeps the existing banner with **Reload**; a server that **cannot be reached** (a
  network error, not an HTTP status, on the first auth check or on `/api/health`, e.g. a phone
  outside home without Tailscale) shows a full-screen `Empty` with the `offline` illustration
  (`packages/ui/src/components/illustrations/offline.tsx`) instead of the pages, and never offers
  Reload. Copy (`es` per the GLOSSARY; `en` mirrors it): with `navigator.onLine === false`, title
  "Sin conexión", text "Este dispositivo no tiene conexión a internet."; otherwise title "No se puede
  contactar con Claudio", text "No llega a `<address>`. Si estás fuera de casa, activa Tailscale o
  conéctate a tu red local.", the address (`location.host`) in Geist Mono. Below: "Reintentando en
  N s" and the button **Reintentar ahora**. It retries on its own with back-off (2 s doubling to
  30 s), and at once on `online`, on focus and on `visibilitychange` to visible; when the server
  answers again the app goes on **without a reload** (queries refetched, the events feed reopened);
  if the version changed meanwhile, then the update banner appears. While unreachable, no widget,
  route or reload banner shows its own network error. The boot guard's plain fallback
  (`apps/web/boot-guard.js`) keeps its role for a broken bundle, and when the cause is that the
  network failed it says so in the same words instead of only "Reload". The same component will be
  used later by the servers feature for a remote that is offline while the hub is reachable.
- **Rejected:** AppImage (sandbox and trust anchor, above); unattended-upgrades for the origin (daily
  only, no remote trigger); PackageKit (distribution-dependent policy, CVE history); pkexec from the
  app (needs an agent and an active session, and the rule above).

## 4. Contracts

Types in `packages/shared/src/types.ts` (owned by `update-trigger`):

```ts
export type DesktopUpdateState = 'unavailable' | 'needs-login' | 'idle' | 'installing' | 'installed' | 'up-to-date' | 'failed';
export interface DesktopUpdateStatus {
  state: DesktopUpdateState;      // unavailable: no unit (not a .deb, or an older package); needs-login: unit there, group not yet in effect
  installed: string;              // the desktop app's version on disk now
  running: string;                // the shell version this process started with
  from: string | null;            // last run's versions
  to: string | null;
  startedAt: string | null;
  endedAt: string | null;
  restartNeeded: boolean;         // installed !== running
  reason?: { code: string };      // i18n code, e.g. 'update.unit-missing', 'update.apt-locked', 'update.apt-failed'
}
export interface RestartRequest { whenIdle?: boolean }
export interface RestartResult { scheduled: 'now' | 'when-idle' }
```

| Route | Access | What |
| --- | --- | --- |
| `GET /system/desktop-update` | person | `DesktopUpdateStatus` |
| `POST /system/desktop-update` | person | starts the unit; `409` while one runs; `412 update.unit-missing` without the unit; `403 update.needs-login` when polkit refuses |
| `POST /system/restart` | person | `RestartRequest` → `RestartResult`; `409 update.live-work` when busy and not `whenIdle`; `412` when no desktop shell runs the server |
| event `desktop-update.changed` | — | on `/events`, with the status |

Each route: summary, tag and access in `apps/api/src/openapi/routes.ts`, a row in `docs/rest-api.md`,
schemas regenerated, an audit row (the audit already writes every write).

## 5. Tasks

Graph `claudio-remote-updates`, worktrees on, concurrency 3, base `fix/remote-updates`. Models by
task (the orchestrator's choice): opus for root packaging and the update path, sonnet for the
well-specified web work and the docs, haiku for the mechanical CI change.

| id | Owns | Depends on | Model / effort |
| --- | --- | --- | --- |
| `update-unit` | D1, D2: `apps/desktop/build/linux/` (unit, polkit rule, `after-install.sh`, a postrm), `apps/desktop/electron-builder.yml` (`deb:` files), the install script if it registers the source; shell tests (bats-style or Node tests over the scripts) and a dry-run test of the apt command line | — | opus · high |
| `update-trigger` | D3, D4, D5, D8: types (§4), `apps/api/src/routes/server-update.ts` or a new `desktop-update.ts`, `packages/core/src/updates/` (unit start and status read, injectable for tests), `packages/core/src/launcher/machine.ts` (D5), `apps/desktop/src/main.ts` + `updater.ts` (exit 76 → relaunch; `apt-managed` states), OpenAPI + rows, tests | — | opus · high |
| `update-ui` | The Updates card (`apps/web/src/pages/config/UpdatesCard.tsx`) on every device: Update the desktop app with its progress, the installed version with **Restart** (confirmation dialog, whenIdle option when busy), `needs-login` and `unit-missing` explained, the phone line about "the computer that runs it" removed; i18n en/es; against the contract of §4 | — | sonnet · high |
| `stale-assets` | D6: `apps/api/src/app.ts` not-found and previous-build assets, `apps/web/src/lib/reload.ts`, `apps/web/src/pages/dashboard/Dashboard.tsx`, `apps/web/public/sw.js`; tests (API: an old hash served or 404 with the right type; web: the Safari wording; widget boundary) | — | sonnet · high |
| `unreachable-screen` | D9: a reachability state in the web (`apps/web/src/api.ts` request layer classifies network errors; `apps/web/src/lib/events.ts` feed state; a provider and the screen under `apps/web/src/components/`), its wiring in `apps/web/src/App.tsx` so it replaces the page, the reload banner suppressed while unreachable (`apps/web/src/lib/reload.ts`, `components/ReloadOffer.tsx`), the boot guard's wording; i18n en/es; unit tests (classification, back-off, recovery without reload) and an e2e spec that stops answering the API and checks the screen, then answers again and checks the app resumes | — | sonnet · high |
| `minshell-guard` | D7: `.github/dependabot.yml`, the release workflow's notice | — | haiku · medium |
| `review` | Reviews the diff against D1-D9 as an adversary (root boundary: no argument reaches root, polkit scope, downgrade, apt lock, restart loops, who can trigger), fixes with tests, runs lint/typecheck/test and the e2e specs the web touches through Sluice | all six | opus · high |
| `docs` | `docs/updates.md`, `docs/desktop.md` (the premise fixed), `docs/security-model.md` (the unit and the rule), this plan's Outcome | `update-unit`, `update-trigger`, `update-ui`, `stale-assets`, `unreachable-screen` | sonnet · medium |

Two stages in series. Rules for every task:
read this plan whole, `CLAUDE.md` and `CONTRIBUTING.md`; touch only what your row owns; tests with
every change; TypeScript strict; English; Conventional Commits; never push; verify through Sluice's
`verify`; no `sudo`, `pkexec`, `apt` or `systemctl start` against the real system in tests or by hand
(everything that touches the system is injected and faked).

## 6. Outcome

Written by `docs` from the code of the merged branches, not only from the workers' reports. Nothing here
was run on a real machine: no `.deb` was built, no unit started, no browser suite run.

- **`update-unit` (D1, D2).** Built as planned: `claudio-update.service`, the helper
  `/usr/lib/claudio/claudio-update`, `50-claudio-update.rules`, group handling in `after-install.sh` and
  `after-remove.sh`, `deb.fpm` entries and `package:stage` (modes fixed at staging). Beyond the plan:
  `startedAt` and `code` in `status.json`; a new code `update.source-missing`; the apt lock handled by a
  retry loop (60 × 5 s) because `DPkg::Lock::Timeout` does not cover `apt-get update`; conffiles kept
  (`--force-confold`). `packaging/apt/test/roundtrip.sh` (CI only) was extended and has not run.
  Open: Ubuntu 22.04's polkit 0.105 ignores `.rules`; installing as plain root adds nobody to the group.
- **`update-trigger` (D3, D4, D5, D8).** `packages/core/src/updates/desktop-update.ts` with an injected
  `systemctl`; routes `GET`/`POST /system/desktop-update` and `POST /system/restart`, owner-only
  (the desktop credential refused), event `desktop-update.changed`. Exit 76 relaunches the shell; an
  older shell gets 75; no shell is `412 update.no-shell`. `pick()` drops an outrun overlay quietly
  and clears the stale `bad`/`lastRollback` once. Beyond the plan: `--no-ask-password`, codes
  `update.busy`, `update.start-failed`, `update.no-shell`. Open: whether polkit applies a new group
  membership before the next login (the plan says no; the worker thought yes; unverified), and that
  `systemctl show` honours `--timestamp=unix` (a `Date.parse` fallback exists).
- **`update-ui`.** The Updates card shows the unit on desktop, browser and phone, with the Restart
  dialog (`whenIdle` after a 409). Its contract types are still local to `lib/updates.ts` (`DesktopUnitStatus`, …) instead of imports from `@claudio/shared`, and the card **polls** (2 s installing, 5 s waiting for idle) although `events.ts` now refetches `['desktop-update']` on `desktop-update.changed`: importing the shared types and dropping the polling is open. Left alone: the
  "Up to date" tag shows beside **Update** when a newer Claudio exists, and `unavailable` uses the amber
  alert for plain information. No e2e spec written or run.
- **`stale-assets` (D6).** As §3: 404 for missing files, `/assets` served from kept builds with
  immutable caching, Safari wordings, `WidgetBoundary` moved to `pages/dashboard/WidgetBoundary.tsx`
  and wired to `noticeStaleChunk`, service worker guards. Open: a bare "Load failed" from an
  `import()` in Safari is not detected (needs a device); after a `.deb` upgrade the old build is gone,
  so only the 404 and the reload offer remain; the Home e2e spec has not run. Pre-existing UI issues
  noted by its review: `ErrorBox` title weight, three gradient buttons with the banner on screen,
  Home findings I3 and I9.
- **`unreachable-screen` (D9).** `lib/reachability.ts` (probe of `/api/health`, back-off 2 → 30 s,
  recovery without reload), `components/Unreachable.tsx`, wiring in `App.tsx`, `events.ts`, `auth.ts`,
  `api.ts`, the reload banner suppressed while unreachable, the boot guard's words, and
  `e2e/specs/unreachable.spec.mjs` (written, not run). Its worker's report was empty, so this entry
  comes from the code.
- **`minshell-guard` (D7).** Not part of this branch when `docs` ran; see its own branch and the
  `review` task.
- **`docs`.** This section and the five documents above. Merge conflicts resolved: `strings.json`
  keeps both the route-audit sentence and the card's button (both strings exist); `module-graph.json`
  regenerated with `tsx scripts/module-graph.ts --write`. Beyond the plan: nothing.

## Related

[[updates.md]] · [[desktop.md]] · [[security-model.md]] · [[plans/unified-updates.md]] ·
[[plans/regression-fixes-2026-10-29.md]] · [[plans/claudio-servers.md]]
