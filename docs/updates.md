---
created_at: 2026-10-18T20:00:00Z
updated_at: 2026-11-09T12:00:00Z
tags:
    - updates
    - docker
    - launcher
    - security
    - claude-code
    - desktop
    - apt
    - polkit
    - systemd
---
# Updating Claudio and Claude Code from the app

How a Claudio **in a container or in the desktop app** updates itself, and how a container installs a
newer Claude Code, from Settings → General → Updates. A source checkout is updated with git. The
mechanism is one: a **shell** that only a package changes and a signed **payload** that installs
in-app on both hosts ([decisions/shell-payload-updates.md](decisions/shell-payload-updates.md)). The
container's decision: [decisions/container-in-app-updates.md](decisions/container-in-app-updates.md);
the plans are [plans/container-polish.md](plans/container-polish.md) and
[plans/unified-updates.md](plans/unified-updates.md). How the app learns of a release at all
(`release.json`, `system.release`) is in [deploy.md](deploy.md#updating-claudio).

## Two hosts, one mechanism

| | Container (and Helm) | Desktop app |
| --- | --- | --- |
| The shell (trust anchor, read-only) | the image: `/app`, the launcher, `guard.mjs`, `/app/keys` | the AppImage's mount or root-owned `/opt/Claudio`: Electron, the machine, `guard.mjs`, `<resources>/keys`, the preload |
| The base payload | the server in the image | the server bundled in the shell (`<resources>/server`), at the shell's version |
| Installed payloads | `/data/app/<version>/` | `~/.config/Claudio/data/app/<version>/` |
| Who runs the state machine | `launcher.mjs`, around a `node` child | the main process, around `ServerProcess` |
| `CLAUDIO_LAUNCHER` | `1` | `desktop` |
| A newer shell is needed (`minImage` / `minShell`) | new image: host commands | new desktop app: the Desktop app zone ([desktop.md](desktop.md#updating)) |
| Who may ask | an owner token or OIDC actor | the same, and the shell's per-launch desktop credential, for the four update writes only |
| The shell's own update | new image: host commands | AppImage swap, or the `.deb` through [the update unit](#the-desktop-app-package-the-update-unit-and-restart) |

**The same tarball serves both.** The container runs `api.mjs`; the desktop runs `server.mjs`. Both
native modules (`node-pty`, `@number0/iroh`) are N-API prebuilds, so a bundle built in the image's
build stage loads on Electron's Node. That is why the desktop checks `minShell`, not `nodeAbi`.

The state machine is one pure module, `packages/core/src/launcher/machine.ts`, with spawning, health
checks, the clock and file access injected. It decides which bundle to boot, runs the trial, marks it
good, rolls back after two failures and falls back to the base. The container's launcher and the
desktop's `payload.ts` are its two drivers. The machine imports only `node:*` and `protocol.ts`, so
the launcher stays a single dependency-free file.

## The shape

The image's `/app` is the base. A verified **overlay** in `/data/app/<version>/` replaces it when it
is newer. A **launcher** (`/app/launcher.mjs`, root-owned and read-only like the guard) is the
container's `CMD`: it starts the server from the overlay or from `/app`, restarts only the node
process onto a new bundle, marks a bundle good once `/api/health` answers, rolls back on its own
after failed boots and falls back to `/app`. It is called the launcher because *supervisor* already
names the chat supervisor. It only imports `node:*`, so it carries no dependency to break.

- **Exit code 75** (`RESTART_EXIT_CODE`) means "restart me onto the new bundle". Any other exit ends
  the launcher with the server's code, so the container stops exactly as it does today and a restart
  policy (or Kubernetes) brings it back on the same good bundle.
- **No restart policy needed.** A plain `docker run` with no `--restart` still restarts the server onto
  a new bundle, because the loop lives inside the container.
- **On the desktop** the shell does the launcher's part around the server child. A trial also waits for
  the web to send `claudio:page-ready` (30 s after the window starts loading), so a payload whose
  server answers `/api/health` but whose page never renders is rolled back too. A rollback is
  recorded in the audit log and the card says "Claudio X did not start, so the app went back to Y".
  `CLAUDIO_PAYLOAD=bundled` boots the base and ignores overlays; Help → **Use the bundled Claudio**
  reverts without the page.
- **The plain image with no overlay behaves as before**, except that `launcher.mjs` is the parent of
  `api.mjs`.
- SIGTERM and SIGINT are passed to the server, so `docker stop` is as clean as before.

## Who may update

The owner only: a `token:*` or OIDC actor. It is refused to a chat's token (`CHAT_FORBIDDEN_SYSTEM`),
under `mode: none` (`update.needs-auth`) and in read-only mode (`405`). **The desktop credential is
accepted for exactly the four update writes** (`download`, `apply`, `DELETE …/scheduled`, `revert`),
and only when the shell started the server (`CLAUDIO_LAUNCHER=desktop`): the page in the desktop
window holds no token, so it asks the shell over IPC and the shell calls the routes. Under `none` an
anonymous local request is still refused, so an agent's `curl` to `127.0.0.1` cannot restart the
server over live work.
Every request writes the audit log, and a rollback the launcher did is written as a row on the next
start. `CLAUDIO_SERVER_UPDATE=off` hides the feature (the card reports `no-launcher`).

If it cannot update itself, the Updates card says why (`unsupportedReason`: `needs-auth`, `read-only`,
`no-launcher`, `no-keys`, `not-docker` — now "no launcher host", a source install — and `development`,
a desktop dev build) and shows the host commands of
[deploy.md](deploy.md#updating-claudio) with one line above them.

## The flow

1. **Available.** The release check ([deploy.md](deploy.md#updating-claudio)) found a newer release.
   The card shows **Download Claudio {version}**. Only the newest release is offered, and only a
   version newer than both the base and the running one. **Only when a download can succeed:**
   after every release check the server looks for the three assets, verifies the manifest and judges
   `minImage`/`nodeAbi` (container) or `minShell` (desktop), and the answer is `offer`
   (`installable`, or `blocked` as `no-bundle`, `needs-image`, `needs-shell`, `unverified` or
   `failed-before`). A blocked release shows its version, the notes link and one sentence, with no
   download button.
2. **Download** (`POST /system/server-update/download`). The server checks the manifest's signature,
   `minImage` and the Node ABI **before** downloading (`412 update.needs-image` if the image is too
   old), then downloads the tarball, checks its sha256 and then every file's. The card shows a
   progress bar, then *Checking the signature…*.
3. **Ready.** The bundle is unpacked into `/data/app/<version>/` and recorded as the *trial* in
   `/data/app/state.json`. The card offers **Restart to update to {version}**.
4. **Apply** (`POST /system/server-update/apply`). If chats are working or waiting, or orchestrations
   are running, it answers `409 update.live-work` with the counts and the card asks: **Restart now** or
   **Restart when nothing is running** (checked every 15 s; **Cancel** undoes it). The rule is the
   desktop's `installDecision`, counted as the desktop counts. Then the server exits 75.
5. **Trial boot.** The launcher verifies the bundle again and starts it. If `/api/health` answers within
   60 s the bundle is kept (it becomes `active`, the old one `previous`). After two failed boots it is
   marked `bad`, the rollback is recorded and the next candidate is tried: the previous update, then
   `/app`. A `bad` version is never offered again; the next release is.
6. **The page reloads on its own** when `stream.hello` reports the new version.

**Download retries.** The tarball is downloaded by `downloadFile` (`packages/core/src/updates/download.ts`)
over `node:http`/`node:https`, never `fetch`: undici's parser asserts `!this.paused` when a
`Connection: close` server ends the socket while the body is paused by back-pressure, and throws it
from a socket listener no caller can catch; it took a desktop smoke run's server down mid-download
(Node 24.22). A connection that closes early, a body shorter than its `Content-Length` or than the
manifest's size, a reset or 60 s without data is an interrupted attempt, retried three times after
2, 8 and 30 s, as is a 5xx, 408 or 429. A retry goes on from the partial file with `Range` (and
`If-Range` with the ETag or `Last-Modified`) when the server sent `Accept-Ranges: bytes` and answers
206 from exactly where the file ends; otherwise it starts over. A partial file never counts as
downloaded: the sha256 and the signature are checked on the whole file as it lies on disk, and a size
other than the manifest's fails at once. The same downloader fetches the Claude Code tarball and
the desktop shell's AppImage when it switches from the `.deb`.

A download that fails comes back as `state: 'failed'` with `error` (`fetch-failed`,
`download-interrupted` when every retry was interrupted, `bad-signature`, `bad-manifest`, `disk`,
`needs-image`, `needs-shell`); only preconditions are HTTP errors. The card
shows every error and refusal (`update.<code>`, including `update.needs-shell`) from its code in the
person's language, each with its way out, never the server's English text. A downloaded update applies at the next
restart of any kind, since the trial is set at download time.

**Going back.** On an overlay, *Go back to the image's version* (`POST /system/server-update/revert`)
restarts onto `/app` (on the desktop, the shell's bundled payload), with the same live-work question. Open terminals count as live work (`LiveWork.terminals`), because a restart ends every shell.

## The desktop app package: the update unit and restart

The payload above updates in-app on its own. The **shell** (the `.deb`: Electron, the guard, the keys)
cannot, because only root replaces it. Nothing upgrades it unattended either: on a stock Ubuntu,
`unattended-upgrades` allows only Ubuntu's origins and the repository's `Origin` is `Claudio`, and
every `claudio` upgrade in the owner's `/var/log/apt/history.log` was a `sudo apt-get install`. So
the `.deb` ships its own root helper, and the person starts it from Settings → General → Updates on
**any device**: the desktop window, a browser, a phone
([plans/remote-updates.md](plans/remote-updates.md), decisions D1–D5, D8).

**The unit.** `claudio-update.service` is a root `Type=oneshot` unit, never enabled (no `[Install]`).
Its `ExecStart` is `/usr/lib/claudio/claudio-update` with no argument, and the script reads no
argument, no environment variable and no file a user can write. It runs
`apt-get update` limited to `/etc/apt/sources.list.d/claudio.sources` (the same options as
`scripts/install.sh`, so no other list is touched or cleaned), then
`apt-get install -y --no-remove --only-upgrade claudio` with `DEBIAN_FRONTEND=noninteractive` and the
admin's existing config files kept. `--no-remove` means a run started from a phone may upgrade
`claudio` and install what it needs, but never takes another package off the machine to make room;
such an upgrade fails with apt's reason and is left to an admin. When another apt holds the lock it retries every 5 s up to 60 times,
then fails with `update.apt-locked`. `StartLimitBurst=4` per 600 s makes a fifth start fail with
`start-limit-hit` instead of hammering apt, and a run is cut at 30 minutes. It writes
`/var/lib/claudio-update/status.json` (root-owned, 0644, atomically):

```json
{"result":"installing|installed|up-to-date|failed","from":"0.14.2","to":"0.15.0","startedAt":"…Z","endedAt":"…Z","code":null,"error":null}
```

`code` is `update.apt-locked`, `update.apt-failed` or `update.source-missing` (the source file was
removed, so apt would otherwise "succeed" against stale lists). The contract declares every reason
code, `update.source-missing`, `update.start-limited` and `update.unit-failed` included, and a web
test fails to compile when a code has no words on the card. While it works `result` is
`installing`, with `to` and `endedAt` `null`.

The server also reads systemd's `Result` for the unit. `start-limit-hit` is `failed` with
`update.start-limited`: the refused start ran nothing, so the status file still describes the run
before it and must not be shown as this one's outcome. Any other failed run the status file does
not describe (a timeout, a signal, out of memory, the script dying before it wrote) is `failed` with
`update.unit-failed`. A code in the file that the contract does not declare reads as
`update.apt-failed`.

**The pin.** The package ships `/etc/apt/preferences.d/claudio.pref`, a conffile (kept on remove,
deleted on purge): `claudio` from `release o=Claudio` (the repository's `Origin`) at 990, and
`claudio` from `origin *`, every other repository, at -1. So apt, the unit's helper or the system's
own updater never install a package named `claudio` from another source. 990 is below 1000, so the
pin never downgrades. `origin *` leaves dpkg's status alone, so a version installed by hand keeps
its candidate and still upgrades from Claudio's repository.

**The trigger.** `GET /system/desktop-update` returns a `DesktopUpdateStatus` and
`POST /system/desktop-update` starts the unit. The server runs
`systemctl start --no-block --no-ask-password claudio-update.service` **as its own user**, never
through `pkexec` or `sudo`; polkit allows it for the members of the group `claudio-update`
([security-model.md](security-model.md#the-desktop-update-unit)). It reads the state with
`systemctl show` and the status file, and sends `desktop-update.changed` on `/events` at every
change (module `packages/core/src/updates/desktop-update.ts`, whose `systemctl` is injected, so no
test touches the system). The card reads the status once when it opens and `desktop-update.changed` refetches it (`events.ts`);
it does not poll. The states:

| `state` | Meaning | Card |
| --- | --- | --- |
| `unavailable` | No unit: not a `.deb`, or a package older than the unit (`412 update.unit-missing`) | says how to get the update service, links the release page (an information alert, not a warning) |
| `needs-login` | The unit is there but polkit refused the start (`403 update.needs-login`) | explains the one log-out and log-in |
| `idle`, `installing`, `up-to-date`, `failed` | the unit's last run | **Update the desktop app**, "Updating…", the reason from its code, **Try again** (the green "Up to date" tag is hidden while a newer Claudio exists) |
| `installed` | the package is newer than the running shell (`restartNeeded`) | **Restart** |

A start while one runs is `409 update.busy`; any other refusal from systemd is
`500 update.start-failed`. Both routes are for the **owner** from any device (`token:*`, OIDC, or the
servers feature's `server:*` actor): `403 update.needs-auth` under `mode: none`,
`403 update.not-owner` otherwise. The desktop credential is **not** accepted on them, so the four
update writes above stay the only thing it opens.

**Restart, on confirmation.** Nothing restarts by itself after the package upgrade. The card shows
the installed version and **Restart** in a dialog; `POST /system/restart` takes
`{ whenIdle?: boolean }` and answers `{ scheduled: 'now' | 'when-idle' }`.

- With chats, orchestrations or terminals live it answers `409 update.live-work` (with the counts)
  unless `whenIdle` is set; the card then offers **Restart when nothing is running**, checked every
  15 s like the payload's.
- The server exits with **76** (`RELAUNCH_EXIT_CODE`, beside the payload's 75). The desktop shell
  turns it into `app.relaunch()`, so the whole app starts from the binary now on disk. A shell that
  predates 76 gets 75, which relaunches once it saw apt replace the package. With no desktop shell at
  all (`CLAUDIO_LAUNCHER` is not `desktop`) the answer is `412 update.no-shell`.
- A payload trial that exits with 76 **after** it proved itself (answered its health check) is not a
  failed boot. One that exits with 76 **before** it proved itself spends an attempt like any other
  boot that never answered (`TRIAL_ATTEMPTS` = 2, then the version goes into `bad` and the rollback is
  recorded), because a bundle that asked for a relaunch before it was healthy would otherwise relaunch
  the app forever and never be rolled back.
- While the server is gone the web shows **Restarting Claudio…** instead of the unreachable screen's
  failure words (see [pwa.md](pwa.md#when-the-server-cannot-be-reached)). The card calls
  `expectRestart()` once `POST /system/restart` answers `scheduled: 'now'`; a restart scheduled for
  when nothing is running does not, because the server goes down long after the click, so that one
  shows the plain unreachable screen when it happens.

**No false rollback.** When apt installs the version the overlay already was, or a later one, the
launcher's `pick()` drops the overlay quietly: no rollback row, no entry in `bad`
(`packages/core/src/launcher/machine.ts`). It still never boots an overlay that is not newer than the
base, so the downgrade rule holds. The stale `bad` list and `lastRollback` that earlier false
rollbacks left (finding 3 of the plan) are cleared the first time a boot reads them.

**Fewer package upgrades to begin with.** A release raises `minShell` when Electron, a native module
or the launcher changes, which forces this path. D7 of the plan groups those dependency bumps apart
in Dependabot (Electron and `node-pty` apart, Electron majors left out of the automatic groups) and
prints a notice in the release PR when a release raises it (`.github/dependabot.yml` and the release
workflow).

## After an update: stale chunks

A page opened before an update keeps asking for the hashed files of the build it came from, and the
new server no longer has them. Until 2026-11-08 the server answered every unknown path outside `/api`
with `index.html` and `200`, so Safari reported "'text/html' is not a valid JavaScript MIME type" in
each Home widget. Skew protection (D6) has four parts:

- **The API never answers a missing file with the shell.** A path whose last segment has an extension
  is a plain-text `404`; a navigation to a client route still gets `index.html`, and `/api` keeps its
  own 404 (`apps/api/src/web-assets.ts`, `app.ts`).
- **Old assets are served from the builds the launcher keeps.** A miss under `/assets/<name>` is looked
  up in `<dataDir>/app/<version>/web/assets` of the kept payload versions, newest first, and answered
  with `Cache-Control: max-age=31536000, immutable` (hashed names never change content). Only flat
  names and regular files whose real path stays inside that folder qualify. After a `.deb` upgrade the
  previous build was the base payload and no longer exists, so there the clean 404 and the offer to
  reload are what remain.
- **The page recognises the failure.** `CHUNK_ERROR` (`apps/web/src/lib/reload.ts`) knows "is not a
  valid JavaScript MIME type", and "Load failed" counts only when the same message mentions `import`
  or `/assets/`, because WebKit uses it for any failed fetch. A bare "Load failed" from an
  `import()` in Safari is still not detected; that needs a real device to check.
- **A widget says it, in the person's language.** `WidgetBoundary` hands a chunk error to
  `noticeStaleChunk` (the reload banner) and shows `shell:reload.stalePageHint`, never the raw
  English message. The service worker (`public/sw.js`) never paints the shell for a navigation that
  names a file and drops an asset cached as `text/html`.

A server that cannot be reached at all is a different case, with its own screen:
[pwa.md](pwa.md#when-the-server-cannot-be-reached).

## How it is trusted

- **Signing.** Each release carries `claudio-server-<v>-linux-x64.tar.gz`, its manifest `….json`
  (`schema`, `version`, `nodeAbi`, `minImage`, `imageInputs`, `commit`, the tarball's sha256 and
  size, every file's sha256) and `….json.sig`, an Ed25519 signature over the manifest's exact bytes.
  The private key is the secret `CLAUDIO_BUNDLE_SIGNING_KEY` of the GitHub Environment `release`,
  restricted to `main`; the release job refuses to publish an unsigned bundle. The tarball also gets a
  build-provenance attestation, for people.
- **The image is the trust anchor.** `launcher.mjs`, `/app/keys/*.pub`, `/app/image.json` and
  `guard.mjs` come only from the image, root-owned, never from an overlay. An overlay never carries a
  guard. Every accepted public key is in the image, so a rotation ships the new key in an image before
  it signs anything.
- **Signatures carry a key id.** A `.sig` may hold several `<keyId> <base64>` lines (`keyId` is the
  first 16 hex characters of the sha256 of the public key's DER) and verification passes when any
  line verifies with a trusted key, so a rotation can overlap; a bare base64 line stays valid. The
  desktop manifest (`claudio-desktop-<v>-linux-x64.json`, listing the AppImage and the `.deb`) is
  signed the same way, and both manifests carry a GitHub build-provenance attestation.
- **`minShell`.** The counterpart of `minImage`: CI computes `shellInputs` over the Electron version,
  the native modules' versions, `packages/core/src/launcher/**`, `packages/core/src/guards/**`,
  `docker/keys/*.pub`, the preload and IPC and `payload.ts`. A bundle whose `minShell` is newer than
  the running shell is never downloaded or booted; the card says the desktop app needs a full
  update first. Helm and the image are unchanged by it.
- **Verified twice.** By the server before unpacking, and by the launcher (or, on the desktop, the shell) at **every** boot. The
  agents' user can write `/data`, but cannot forge a signature, and cannot point the launcher outside
  `/data/app/<v>`: paths are built from validated version strings and never read from `state.json`.
  The launcher refuses extra files and symlinks in a bundle.
- **`/app` is root-owned.** `api.mjs`, `mcp.mjs`, `guard.mjs`, `launcher.mjs`, the host files, `web`,
  `node_modules/*`, `entrypoint.sh` and `healthcheck.sh` can no longer be rewritten by an agent running
  as `node`.
- **`minImage`.** Each bundle declares the oldest image it runs on. CI computes `imageInputs`, a sha256
  over what only a new image can change (the runtime stage of the Dockerfile, the entrypoint and
  healthcheck, the launcher and guard, the keys, the Node ABI, and the `node-pty` and `@number0/iroh`
  versions); if it equals the previous release's, `minImage` is inherited. When the newest release
  needs a newer image the card says so and shows the host commands.
- **The image still wins.** A `docker pull` or `helm upgrade` to a newer image beats an older overlay
  by the version rule: only bundles newer than the image and the running version are booted.
- **Helm.** The overlay lives on the data volume and survives a pod restart. The 60 s trial fits inside
  the liveness tolerance (30 s × 3); keep the two so.

## Claude Code

The Claude Code CLI updates in-app too, into `/data/cli/<version>/`
(`POST /system/cli-version/install`, owner only, `DELETE` to go back).

- It installs the native platform package `@anthropic-ai/claude-code-linux-x64` from the npm registry
  (or `CLAUDIO_CLI_REGISTRY_URL`), checked against its `dist.integrity` (SHA-512). Only `package/claude`
  is extracted and no package script runs. The version must be inside the driver's range
  (`>=2.1 <3`) and newer than the image's pin, and `claude --version` must report it.
- **Which binary runs.** One resolver (`packages/core/src/claude-bin.ts`) decides, on every launch:
  the binary set in Settings → Claude Code; else `/data/cli/current` when it is valid (an executable
  file, a version newer than the image's pin and inside the driver's range); else `claude` on the
  server's own PATH. The overlay is used **by absolute path**: Claudio puts the login shell's PATH
  first for what it starts, and that PATH leads to the image's CLI, so a lookup by name would keep
  running the old one. Chats, accounts (sign-in, identity, usage, models), connectors, the setup
  sign-in and the system read all go through it.
- **When the switch applies.** `current` is a symlink swapped by rename. When an install finishes (or
  *Use the image's version* removes the link) Claudio reads the CLI again, so the card, `/api/system`
  and readiness show the new version at once. A running chat keeps its process; the next one starts
  the new binary. At every start the launcher removes `current` when it is not newer than the image's
  pin (a newer image wins) and deletes versions nothing points at.
- **The terminal agrees.** The image's `~/.profile` ends by putting `/data/cli/current/bin` first
  when it holds a binary, because a login shell rebuilds PATH and would otherwise put the image's
  `~/.local/bin` ahead. The CI docker job checks it with a stand-in overlay.
- Errors: `integrity`, `out-of-range`, `not-newer`, `version-mismatch`, `fetch-failed`,
  `download-interrupted` (retried as the bundle is), `disk`; and
  `cli.no-version` (400) when no newer version is known. *Use the image's version* removes the link.

## Files and variables

| Path | What |
| --- | --- |
| `/app/launcher.mjs`, `/app/keys/*.pub`, `/app/image.json` | the trust anchor, root-owned |
| `/data/app/<version>/` | an unpacked bundle with its manifest and signature |
| `/data/app/state.json` | `{ active, previous, trial, attempts, bad, lastRollback, scheduled, rollbackAudited }` |
| `~/.config/Claudio/data/app/<version>/`, `…/state.json` | the same, on the desktop |
| `<resources>/keys/*.pub`, `<resources>/shell.json` | the desktop shell's keys and `{ version, shellInputs }` |
| `/usr/lib/claudio/claudio-update`, `/usr/lib/systemd/system/claudio-update.service`, `/usr/share/polkit-1/rules.d/50-claudio-update.rules` | the update unit's helper, unit and polkit rule, from the `.deb` |
| `/var/lib/claudio-update/status.json` | the unit's last outcome |
| `/data/cli/<version>/bin/claude`, `/data/cli/current` | an installed CLI and the link to the one in use |

`CLAUDIO_SERVER_UPDATE`, `CLAUDIO_BUNDLE_KEYS_DIR`, `CLAUDIO_LAUNCHER` and `CLAUDIO_APP_DIR` are in
[configuration.md](configuration.md#environment-variables). The desktop shell also sets
`CLAUDIO_LAUNCHER=desktop`, `CLAUDIO_WEB_DIST`, `CLAUDIO_GUARD_ENTRY` (always the shell's guard),
`CLAUDIO_BUNDLE_KEYS_DIR` (`<resources>/keys`) and `CLAUDIO_SHELL_VERSION`, `CLAUDIO_SHELL_INPUTS`,
`CLAUDIO_SHELL_PACKAGE` and `CLAUDIO_SHELL_APT`; a person may set `CLAUDIO_PAYLOAD=bundled` for one
launch. These are for the shell, not for setting by hand. The routes are in
[rest-api.md](rest-api.md). The bundle is built by `apps/api/scripts/server-bundle.mjs` and released by
`.github/workflows/server-bundle.yml`.

## Limits

- Linux x64 only. A source checkout updates with git.
- Terminals do not survive a restart of the server, on either host. Keeping shells alive across a
  restart needs a reattach channel of its own and is a separate plan ([[plans/terminal-persistence]]).
- A release that changed the OS layer, Node or the native modules needs a new image.
- Without a public key in the image the card shows host commands (`no-keys`).
- Tests: `packages/core/test/launcher.test.ts`, `server-update.test.ts`, `cli-install.test.ts`,
  `apps/api/test/server-update.test.ts`, `apps/desktop/test/{payload,desktop-manifest,switch,updater,update-unit,packaging}.test.ts`, `packages/core/test/{desktop-update,launcher-machine}.test.ts`, `apps/api/test/{desktop-update,stale-assets}.test.ts`, `apps/web/test/{desktop-unit-view,reload,widget-boundary}.test.tsx`, `packaging/apt/test/roundtrip.sh` (CI only), and `e2e/specs/updates.spec.mjs` for the card in a container.
  The full flow (download, restart, rollback) is checked by the integrator on a real container, not by a spec: it needs a launcher, a key and a signed bundle that the e2e runner does not have.

## Related

[[deploy.md]] · [[desktop.md]] · [[security-model.md]] · [[configuration.md]] · [[plans/container-polish.md]] · [[plans/unified-updates.md]] · [[plans/app-updates.md]] · [[plans/remote-updates.md]] · [[pwa.md]] · [[decisions/container-in-app-updates.md]] · [[decisions/shell-payload-updates.md]]
