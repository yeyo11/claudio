---
created_at: 2026-10-18T20:00:00Z
updated_at: 2026-10-18T20:00:00Z
tags:
    - plan
    - updates
    - desktop
    - docker
    - releases
    - security
    - apt
    - design-system
---
# Plan: one update mechanism for the desktop, the container and Helm

Status: **planned** (2026-10-18). This is **phase 2 of the container-polish pull request**
([plans/container-polish.md](container-polish.md)) and **waits on phase 1**: it starts on top of
the merged result of phase 1's orchestration (the launcher, the signed server bundle, the
`/system/server-update` routes). The owner's decisions are settled except the three items in
[Open questions](#open-questions). Workers run security-sensitive tasks on `claude-opus-5-5` and the
rest on `claude-sonnet-5-5`, never fable. Two owner actions are needed before the merge:
[the apt signing key and GitHub Pages](#owner-actions-before-the-merge).

This plan is the source of truth for that orchestration, together with CLAUDE.md, CONTRIBUTING.md
and phase 1's plan, whose contracts it extends. Where a task prompt and this plan disagree, the plan
wins. Workers never run the e2e suite: CI runs it (`pnpm e2e:remote`, the `e2e-on-github` skill).
Before launching, the integrator works through [Re-check after phase 1](#re-check-after-phase-1).

## Context

### What the desktop does today

- **The owner runs 0.6.0 as a `.deb` in `/opt/Claudio`**, root-owned (`resources/package-type` says
  `deb`). electron-updater's `DebUpdater` installs an update through `pkexec`, which asks for a
  password in a system dialog while the window hangs and the server is already stopped
  (`apps/desktop/src/updater.ts:6-7`, the `no-elevation` check `:61-117`; `restartToUpdate` in
  `apps/desktop/src/main.ts:239-260`).
- **`scripts/install.sh:61` picks the `.deb` whenever apt exists**, and the AppImage elsewhere, in
  `~/.local/share/claudio/Claudio.AppImage` with a menu entry and a `~/.local/bin/claudio` link.
  `docs/plans/app-updates.md:51,70` accepted the password and rejected an apt repository ("a GPG key,
  signing in CI and a hosted repository to keep alive").
- **One release is one thing.** Every update, however small, replaces the whole Electron app
  (AppImage 159 MB, `.deb` 129 MB for 0.6.0) and restarts the window, the tray and the server.
- **How the shell starts the server.** `ServerProcess` (`apps/desktop/src/server-process.ts`) runs
  `<resources>/server/server.mjs` on Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), waits for its
  `CLAUDIO_READY {url}` line, and calls `onCrash` on any exit it did not ask for
  (`main.ts:107-156`). `resolveResources` (`apps/desktop/src/resources.ts`) finds the server, MCP
  server, guard and web under `<resources>`; the server finds the guard as its sibling unless
  `CLAUDIO_GUARD_ENTRY` is set. The terminal host and the Collaborators host are forked children of
  the server (`packages/core/src/terminals/host-client.ts:164`), not detached: every shell ends when
  the server stops (`docs/terminal.md`, Lifetime).
- **What survives a server restart today** (`docs/known-limitations.md:26-33`): transcripts, run
  metadata, chats (the next turn resumes the session; a turn in flight is lost with its CLI process),
  orchestration tasks (marked `interrupted` and continued), and limit waits. Terminals do not.
- **The guard's `integrity` rule** blocks agent writes to Claudio's data dir, the guard's folder and
  the Claude config dirs (`packages/core/src/guards/rules/common.ts:404`, `integrity.own-state`).
- **This machine** (Ubuntu 26.04.1) has `kernel.apparmor_restrict_unprivileged_userns = 1`. The
  `.deb` installs an AppArmor profile for `/opt/Claudio/claudio` granting `userns`
  (electron-builder's `after-install.tpl`), which is why it runs. An AppImage in a user dir gets no
  such profile.
- **electron-builder 26.15.3** offers a static-runtime AppImage toolset (`toolsets.appimage`
  `1.0.2`/`1.0.3`, beta, "Runtime 20251108") that needs no `libfuse2`; the build uses the legacy one.
- GitHub Pages is not enabled on `yeyo11/claudio` (public repository).

### Phase 1, which this builds on

Phase 1 ([container-polish.md D4](container-polish.md#d4-claudio-updates-itself-inside-the-container))
splits the container into a root-owned **base** (`/app`: launcher, guard, keys, the bundled server)
and a verified **overlay** in `/data/app/<version>/`, an Ed25519-signed server bundle. The launcher's
state machine verifies the overlay at every boot against `/app/keys`, runs a trial boot, marks it
good after `/api/health`, rolls back after two failures and falls back to `/app`. `minImage` (from
`imageInputs`) says when a bundle needs a newer image. The routes are `/system/server-update/*`, the
state is `/data/app/state.json`, and the restart exit code is 75.

### How Orca does it (stablyai/orca v1.4.229, read 2026-10-18)

| | Orca | This plan |
| --- | --- | --- |
| Linux targets | AppImage, deb, rpm (`config/electron-builder.config.cjs:743`); recommends only the AppImage (`README.md:220`) | AppImage where it runs sandboxed without root, the `.deb` + apt repository elsewhere ([D5](#d5-installsh-defaults-to-the-appimage-where-it-runs-sandboxed-without-root)) |
| Feed | electron-updater generic feed on GitHub releases, with blockmaps | electron-updater for the shell; the phase-1 signed bundle for the payload |
| deb/rpm updates | never escalates: `performQuitAndInstall` returns and the UI offers "Copy Install Command" `/usr/bin/sudo /usr/bin/apt install -- '<cache path>'`, no `-y` (`updater-install-execution.ts:37-44`, `linux-package-install-command.ts:85-89`) | never escalates; the command installs a root-owned, hash-checked copy, never the user-writable cache file ([D3](#d3-shell-updates-never-escalate-from-inside-the-app)) |
| Package detection | a package-type marker, fail closed (`linux-update-package-type.ts`) | the same (`resources/package-type`, already read) |
| Why | PR #18100 after #15744; #15176: `DebUpdater`'s synchronous `dpkg -i` crashed the old process | the same failure, plus the password |
| apt repository | planned (#18086): signed repository registered from postinst, marker watched for "restart to update"; polkit rules and root helpers rejected | built now ([D4](#d4-a-signed-apt-repository-on-github-pages)) |
| Live work | preserved across restarts (`update-restart-preservation.ts`); terminal daemon from a copy in `~/.cache/orca/appimage` so it outlives the AppImage swap; a watchdog | most updates restart only the server child; terminals end, chats and orchestrations resume ([D6](#d6-live-work-across-a-restart)) |
| Signatures | none on Linux artifacts (sha512 only) | Ed25519 on the payload and on a desktop manifest, GPG on the apt repository, sha512, provenance attestations ([D7](#d7-verification-stronger-than-sha512)) |

The difference that matters: Orca updates the whole app. Claudio's release is mostly server and web
code, so splitting it lets nearly every release install with no password and no window restart.

## Decisions

### D1. Shell and payload, one mechanism

- **The shell** is what only a package can change: Electron (or the image's OS layer and Node), the
  launcher state machine, `guard.mjs`, the public keys, the preload and its IPC contract, the native
  modules' versions. It is the **trust anchor**: on the desktop it lives in the AppImage's read-only
  mount or in root-owned `/opt/Claudio`; in the container it is `/app` (phase 1). It rarely changes.
- **The payload** is phase 1's signed server bundle: `server.mjs`, `api.mjs`, `mcp.mjs`,
  `terminal-host.mjs`, `collab-host.mjs`, `web/`, and `node_modules/{node-pty,@number0}`. **The same
  tarball serves both hosts**: the container runs `api.mjs`, the desktop runs `server.mjs`. Both
  native modules are N-API prebuilds, which already load on Electron's Node unchanged
  (`apps/desktop/electron-builder.yml`, the `npmRebuild: false` comment).
- **On the desktop the payload installs to `<dataDir>/app/<version>/`**, that is
  `~/.config/Claudio/data/app/<version>/` (`$XDG_CONFIG_HOME` respected), with `state.json` beside
  the versions. Why that path:
  1. It is phase 1's layout relative to the data dir (`/data/app/<v>/` in the container, where `/data`
     is the data dir), so one module in `packages/core/src/updates/` computes it from
     `CLAUDIO_DATA_DIR` on every host.
  2. It is already inside the guard's `integrity.own-state` protection, so an agent under guards
     cannot write it, with no new rule.
  3. It survives an AppImage swap, an apt upgrade and a switch between the two, which share the data
     dir.
  4. Rejected: `~/.cache/Claudio` (a cache may be wiped by the person or a cleaner, which would
     silently downgrade; and it is outside the guard's protection), `~/.local/share/claudio` (the
     AppImage's install dir, where `--uninstall` removes it, and outside the guard), inside the
     AppImage or `/opt` (read-only or root-owned).
- **The same state machine runs both hosts.** Phase 1's launcher logic is (or becomes, see
  [Re-check](#re-check-after-phase-1)) a pure module, `packages/core/src/launcher/machine.ts`, with
  spawning, health checks, clock and file access injected. The container's `launcher.mjs` drives it
  around a `node` child; the desktop's main process drives it around `ServerProcess`. Rejected:
  running `launcher.mjs` as a middle process under Electron. The main process already owns the
  child's lifecycle, the `READY` line, the splash and error pages and crash handling; a middle process
  would hide crashes from it and double the signal handling.
- **On the desktop, a payload update restarts only the server child** (exit 75, as in phase 1) and
  reloads the window. No password, AppImage or `.deb`. The tray, the window and Electron stay up.
- **The fallback is the payload bundled in the shell** (`<resources>/server`, `<resources>/web`),
  whose version is the shell's version: phase 1's "fall back to `/app`".
- **Helm and the container change nothing** beyond the manifest fields below: they are the phase-1
  host of the same mechanism.

### D2. `minShell`, the counterpart of `minImage`

- CI computes `shellInputs`, a sha256 over what only a new shell can change:
  - the Electron version (and with it its Node, ABI and N-API level);
  - the versions of `node-pty` and `@number0/iroh`;
  - `packages/core/src/launcher/**` (the state machine and verification);
  - `packages/core/src/guards/**` (the guard is the shell's, and the rules format the server writes
    for it is defined there);
  - `docker/keys/*.pub` (one key set for both hosts);
  - `apps/desktop/src/ipc.ts` and `apps/desktop/src/preload.ts` (the payload's web talks to the shell
    through them);
  - `apps/desktop/src/payload.ts` (the desktop host of the machine).
- If it equals the previous release's, `minShell` is inherited; otherwise it is this version. Each
  bundle manifest carries `minShell` and `shellInputs` beside phase 1's `minImage` and `imageInputs`.
- A payload whose `minShell` is newer than the running shell is never downloaded or booted. The card
  says the desktop app needs a full update ([Design](#design)), the way phase 1 says "needs a new
  image".
- Rejected: one hash for both hosts. A Dockerfile change would force a desktop shell update and an
  Electron bump would force a new image, for no reason.

### D3. Shell updates never escalate from inside the app

- **AppImage**: electron-updater's `AppImageUpdater` replaces the file in place, as today, then a full
  restart (`appImageRelaunch`). Before installing, the shell also checks the downloaded file against
  the signed desktop manifest ([D7](#d7-verification-stronger-than-sha512)).
- **`.deb` with the apt source registered** (`/etc/apt/sources.list.d/claudio.sources` and the
  keyring exist): state `apt-managed`. The system's updater (Software Updater, `unattended-upgrades`,
  `apt upgrade`) installs it. The app downloads nothing for the shell.
- **`.deb` without the apt source** (installs from before this plan, the owner's 0.6.0 among them, or
  a person who removed the source): download through `DebUpdater.downloadUpdate()` (never its
  `install()`), check it against the signed desktop manifest, and show the exact command to copy:

  ```
  /usr/bin/sudo /usr/bin/install -D -m 0644 -o root -g root -- '<cache file>' '/var/cache/claudio/claudio_<v>_amd64.deb' && echo '<sha256>  /var/cache/claudio/claudio_<v>_amd64.deb' | /usr/bin/sha256sum -c - && /usr/bin/sudo /usr/bin/apt install -- '/var/cache/claudio/claudio_<v>_amd64.deb'
  ```

  - Absolute paths to trusted binaries, `--` before paths, single quotes, no `-y`: apt shows what it
    will do and asks.
  - **Why not Orca's `apt install -- '<cache path>'`**: the cache file is user-writable, and an agent
    running as the person could swap it between the check and the person's `sudo`, getting a root
    install of its own package. The command first copies it to a root-owned path, checks the copy
    against the sha256 from the signed manifest (embedded in the text the person sees), and only then
    hands apt the root-owned copy. It also avoids apt's "unsandboxed as root" note: `_apt` can read
    `/var/cache/claudio`.
  - The new `.deb`'s postinst registers the apt source, so this command is needed **once**; after
    it the install is `apt-managed`.
- **Never `pkexec`.** `DebUpdater.install()`, `debCanElevate` and the `no-elevation` reason are
  removed. Rejected, as Orca rejected them: a polkit rule (a standing root grant to a user-writable
  app's request), a root helper (a setuid surface to maintain), `DebUpdater` as today (the password,
  and the synchronous `dpkg -i` under the running app, Orca #15176).
- **The `.deb` after apt upgraded it underneath.** The package ships
  `<resources>/shell.json` (`{ version, shellInputs }`). The running app re-reads it every 60 s and on
  window focus (and through an `fs.watch` on `<resources>` where it fires). When its version differs
  from `app.getVersion()`, the state is `shell-replaced`: the card and the tray offer **Restart
  Claudio**, a full relaunch (`app.relaunch()`, the binary is on disk). From then on, any server
  restart is upgraded to a full relaunch, because `process.execPath` now points at the new Electron.
  Rejected: a marker written by the postinst into a user's dir (root writing into homes) or into
  `/var/lib/claudio` (a second file to keep in step with the one dpkg already replaces).

### D4. A signed apt repository on GitHub Pages

- **Where**: GitHub Pages of `yeyo11/claudio`, deployed by Actions (`actions/upload-pages-artifact`
  and `actions/deploy-pages`), at `https://yeyo11.github.io/claudio/apt/`. Why:
  1. One repository, one set of secrets and environments; the release workflow builds it in the
     same run as the packages.
  2. A deployment from an artifact keeps no binary in git history and is not bound by the 100 MB
     per-file push limit (the `.deb` is 129 MB).
  3. The repository is **rebuilt from scratch on every release** from the published releases' assets
     (the newest three `.deb` files plus the one being released), so Pages holds no state to lose
     and stays under its 1 GB site limit (four `.deb` files ≈ 520 MB).
  - Rejected: a `gh-pages` branch (binaries in history; the 100 MB file limit); a separate
    `claudio-apt` repository (a second repository, a cross-repository token); release-asset URLs as
    the pool (apt's `Filename` is relative to the repository and Pages cannot redirect); a hosted
    service such as Cloudsmith or packagecloud (another account and another party in the trust path).
    The last stays the fallback if Pages' limits bite ([Risks](#risks)).
- **Layout**: suite `stable`, component `main`, architecture `amd64` ([Contracts](#apt-repository-layout)).
  Built with `apt-ftparchive` (apt-utils), signed with `gpg --clearsign` (`InRelease`) and
  `gpg --detach-sign --armor` (`Release.gpg`).
- **`Valid-Until`** is set 90 days ahead, and a monthly scheduled run rebuilds and re-signs it, so a
  mirror or a man in the middle cannot serve a stale `Release` forever (a freeze attack). Rejected:
  no `Valid-Until` (staleness undetectable); 7–14 days (a broken cron would break `apt update` for
  every user within days).
- **The key**: an OpenPGP Ed25519 signing key, made by the owner's session
  ([Owner actions](#owner-actions-before-the-merge)), held as the secret `CLAUDIO_APT_SIGNING_KEY`
  in the GitHub Environment `release` (deployment branch policy `main`, as phase 1's Ed25519 key).
  Ed25519 OpenPGP signatures are accepted by both `gpgv` and `sqv`, which Ubuntu 26.04's apt uses.
- **Registration by the `.deb`'s postinst**, Chrome and VS Code style:
  - The package ships the keyring as a regular file,
    `/usr/share/keyrings/claudio-archive-keyring.gpg` (binary, dearmored), so a key rotation travels
    in a package update, and dpkg removes it with the package.
  - postinst (`configure`) writes `/etc/apt/sources.list.d/claudio.sources` (deb822, with
    `Signed-By:` that keyring) **once**: it records `repo_add_once=false` in `/etc/default/claudio`
    afterwards, so a person who deletes the source does not get it back on the next upgrade.
    `CLAUDIO_APT_REPO=off` in `/etc/default/claudio` (or set before install) skips it.
  - postrm on `remove` deletes the source (the keyring it names goes with the package, and a source
    left pointing at a missing keyring would break `apt update`); on `purge` it also deletes
    `/etc/default/claudio`. On `upgrade` it does nothing.
  - Both scripts keep electron-builder's own content (the `/usr/bin` alternative, `chrome-sandbox`
    mode, the AppArmor profile), copied from `app-builder-lib/templates/linux/after-*.tpl`.
  - Rejected: `/etc/apt/trusted.gpg.d` (trusts the key for every repository), a keyring in
    `/etc/apt/keyrings` written by the postinst (an admin's directory; the package could not remove
    it cleanly).

### D5. `install.sh` defaults to the AppImage where it runs sandboxed without root

The owner asked for the AppImage as the default on every distribution. One fact found while
writing this plan narrows it, and is the first [open question](#open-questions):

- On hosts that restrict unprivileged user namespaces (Ubuntu 24.04 and later, this machine
  included: `kernel.apparmor_restrict_unprivileged_userns = 1`), Chromium's sandbox cannot start
  inside an AppImage in a user dir. Its namespace sandbox is denied, and its SUID fallback cannot be
  setuid inside a FUSE mount. Electron then aborts ("The SUID sandbox helper binary was found, but
  is not configured correctly"). The `.deb` works because its postinst installs an AppArmor profile
  for `/opt/Claudio/claudio`.
- The rootless ways out are `--no-sandbox` (drops the renderer sandbox: rejected) or a root-installed
  AppArmor profile matching the FUSE mount path `/tmp/.mount_*/claudio` (a glob any user can satisfy
  with their own binary, granting it unconfined user namespaces: rejected).

So:

- **Default**: the AppImage when the host lets it sandbox without root (`sandboxRootless()`:
  `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` absent or `0`, and
  `/proc/sys/kernel/unprivileged_userns_clone` absent or `1`, and `/proc/sys/user/max_user_namespaces`
  above 0). Otherwise the `.deb` through the apt repository. Since payload updates need no password
  on either, "no password" holds for nearly every release on both paths; only a shell update on the
  `.deb` path goes through apt.
- **Where**: the paths `install.sh` already uses, so existing AppImage installs keep working and
  the updater can write: `${XDG_DATA_HOME:-~/.local/share}/claudio/Claudio.AppImage`, the menu entry
  `${XDG_DATA_HOME:-~/.local/share}/applications/claudio.desktop` (same file name as the `.deb`'s
  `/usr/share/applications/claudio.desktop`, so the user entry shadows the system one), the icon in
  `hicolor/512x512/apps/claudio.png`, and the CLI link `~/.local/bin/claudio`.
- **FUSE**: the AppImage moves to the static-runtime toolset (`toolsets.appimage: "1.0.3"`) if the
  spike in `release-apt` shows it builds, updates and starts; then `libfuse2` is no longer needed,
  only `fusermount3` (present on current desktops). If not, `install.sh` checks for `libfuse2` and
  chooses the `.deb` on a Debian-like host without it.
- **Options**: `--appimage` and `--deb` force a format; `--version` and `--uninstall` stay.
  `--deb` registers the apt repository first (keyring fetched from Pages and checked against the
  fingerprint pinned in `install.sh`), then `sudo apt-get install claudio`. Here `-y` stays: the
  person ran the installer, and a piped script has no terminal for apt's prompt.
- **The AppImage path verifies the download** against the signed desktop manifest with
  `openssl pkeyutl -verify -rawin` (OpenSSL 3) and the public key pinned in `install.sh`, and falls
  back to the sha512 in `latest-linux.yml` when `openssl` is older, saying so.

**Switch to the AppImage** (a one-time, in-app offer for an existing `.deb` install):

- Offered only when `sandboxRootless()` holds and FUSE is usable. On this machine it is **not**
  offered; the owner's path is the apt repository.
- It downloads the AppImage, verifies it against the signed desktop manifest, installs it at the
  paths above with the menu entry, icon and CLI link, then quits and starts the AppImage (the
  single-instance lock passes over on exit, as `appImageRelaunch` already does).
- **What it keeps**: everything in `~/.config/Claudio` (data, payload overlays, logs, settings),
  `~/Claudio/workspace`, `~/.claude`. Both packages use the same `userData`.
- **What it leaves**: the `.deb` stays installed (removing it needs root). The card then shows the
  command to remove it, `/usr/bin/sudo /usr/bin/apt remove claudio`, which also removes the apt
  source through the postrm. Until then the system entry is shadowed by the user entry and
  `/usr/bin/claudio` still starts the `.deb`; the card says which one is running.
- Rejected: removing the `.deb` from the app (escalation), or a silent switch on update.

### D6. Live work across a restart

- **A payload restart** (the common case): the window, the tray, Electron and the AppImage mount
  stay. Before the restart, phase 1's live-work rule applies (`installDecision`,
  `apps/desktop/src/updater.ts:350-358`; `409 update.live-work`), with one addition: open terminals
  count as live work (`LiveWork.terminals`).
  - **Survives**: every chat and its transcript (the next turn resumes the session), orchestrations
    (tasks caught in flight are `interrupted` and continue once the server is back), limit waits,
    accounts, settings, the window's route (the window reloads the same path), the tray.
  - **Lost**: a turn in flight (its CLI process ends; the transcript keeps what was written), its
    stderr and rate-limit notice, every terminal shell (it shows as "Cerrado" with "Abrir de nuevo",
    as today), Collaborators connections (the host reconnects on start).
- **A shell restart** (AppImage update, `shell-replaced`, switch to the AppImage): the same, plus the
  window is re-created (its bounds and maximised state are restored by `restoreWindowState`).
- **Terminals do not survive, in this phase.** Rejected for now: Orca's detached terminal daemon.
  Orca needs it because the daemon would die with the AppImage mount; here a payload restart does not
  touch the mount at all, and the payload's `terminal-host.mjs` already lives outside it. Making
  shells outlive the server needs an authenticated reattach channel, a host protocol that holds
  across payload versions and orphan accounting: a plan of its own (wanted:
  `[[plans/terminal-persistence]]`).
- **Scheduling stays**: **Restart when nothing is running** (phase 1's `whenIdle`) and, for a shell
  update, **Update when I quit** as today.

### D7. Verification stronger than sha512

| Artifact | Checked by | With |
| --- | --- | --- |
| Payload (server bundle) | the server before unpacking; the shell's (or the container launcher's) machine before every boot | Ed25519 over the manifest (phase 1), per-file sha256, `minShell`/`minImage`, never older than the base or the running version |
| AppImage update | electron-updater, then the shell before `install()` | sha512 from `latest-linux.yml`, **and** the sha512 in the Ed25519-signed desktop manifest |
| `.deb` from the in-app command | the shell before showing the command; root's `sha256sum` on a root-owned copy | the signed desktop manifest's sha256 |
| `.deb` through apt | apt | GPG-signed `InRelease` with `Valid-Until`, `Packages` hashes |
| `install.sh` downloads | `install.sh` | the signed desktop manifest (OpenSSL 3), else sha512 |
| Everything | people, auditors | GitHub build-provenance attestations (`actions/attest-build-provenance`) on the AppImage, the `.deb`, the server tarball and both manifests |

- **The desktop manifest** (`claudio-desktop-<v>-linux-x64.json` and `.sig`) is new: it lists the
  AppImage's and the `.deb`'s names, sizes, sha256 and sha512, and `shellInputs`, signed with the same
  Ed25519 key as the payload, so the shell's own keys verify it.
- **Signatures carry a key id** so a rotation can overlap: a `.sig` file may hold several lines
  `<keyId> <base64>`, and verification passes when any line verifies with a trusted key. A bare
  base64 line (phase 1's format) stays valid. `keyId` is the first 16 hex characters of the sha256 of
  the public key's DER.
- **Releases stay drafts until every asset exists**: `publish` waits for the image, the desktop
  packages, the server bundle, both manifests and the signed apt repository artifact. The Pages
  deployment runs **after** publish, so apt never offers a version whose release is not public.

### D8. Who may update a payload on the desktop

- The page in the desktop window holds no owner credential (the desktop runs under auth `none` by
  default), and phase 1 refuses `none`, the `desktop` actor and chat tokens.
- So the window asks the shell over IPC, and **the shell calls the server's phase-1 routes with its
  per-launch desktop credential** (`CLAUDIO_DESKTOP_TOKEN`, the one the tray already uses). The
  routes accept the `desktop` actor **only when `CLAUDIO_LAUNCHER=desktop`**, which only the shell
  sets. An owner token or OIDC actor (a phone or browser on this server) is accepted as in phase 1.
- Still refused: chat tokens (`CHAT_FORBIDDEN_SYSTEM`), read-only, and the anonymous `local` actor
  under `none` (an agent's `curl` to 127.0.0.1 must not be able to restart the server over live
  work).

## Design

Every screen follows Night Shift and the `claudio-ui` skill. Load it before touching any `*.tsx` or
`*.css`, open `docs/design-system/reference/` for Settings, and finish with `/ui-review`. No new
component: the card is phase 1's Updates card (`apps/web/src/pages/config/UpdatesCard.tsx`,
`apps/web/src/lib/updates.ts`), with `PrefRow`, `ReservedLabel`, `Tag`, `CopyButton`, `Dialog`, the
`.progress` bar and the busy dialog. No new gradient surface: at most one `btn-primary` per zone.
Status colours keep phase 1's table: `ok` up to date or verified; `warn` needs a newer desktop app, a
rollback happened; `bad` a bad signature or a failed download; `idle` waiting for the person (ready to
restart, `shell-replaced`). Mono only for versions' literal commands, paths and hashes, never for the
versions in the facts line (tabular numbers, as today). Copy follows
`apps/web/src/i18n/GLOSSARY.md` ("la aplicación de escritorio", infinitive buttons, sentence case,
"No se ha podido …").

### Settings → General → Updates, in the desktop window

The card keeps its two zones in this order: **Claudio** (the payload, what most releases change) and
**Desktop app** (the shell). The Claude Code zone stays docker-only (phase 1).

**Claudio** (payload), from `GET /system/server-update` plus the shell's bridge for actions:

- **Facts line**: en "In use {{running}} · desktop app {{shell}}" · es "En uso {{running}} ·
  aplicación de escritorio {{shell}}". The second part shows only when they differ.
- **Up to date, Available, Downloading, Verifying, Ready, Scheduled, Restarting, Failed, Rolled
  back**: phase 1's states and copy, unchanged, with two words swapped where the container named its
  base:
  - Restarting: en "Restarting Claudio… the window reloads on its own." · es "Reiniciando Claudio…
    la ventana se recarga sola."
  - Rolled back: en "Claudio {{from}} did not start, so the app went back to {{to}}." · es "Claudio
    {{from}} no arrancó, así que la aplicación ha vuelto a {{to}}."
  - Running an overlay, the quiet action: en "Go back to the desktop app's version ({{shell}})" · es
    "Volver a la versión de la aplicación de escritorio ({{shell}})".
- **Needs a newer desktop app** (`needsShell`), `warn` alert, with the Desktop app zone's action
  under it:
  - en: "Claudio {{version}} needs a newer desktop app ({{minShell}} or later). Update the desktop
    app first; Claudio follows on its own."
  - es: "Claudio {{version}} necesita una aplicación de escritorio más reciente ({{minShell}} o
    posterior). Actualiza primero la aplicación de escritorio; Claudio se actualizará después."
- The busy dialog adds the terminals line to `updates.live`: en "{{count}} terminal is open" /
  "{{count}} terminals are open" · es "{{count}} terminal está abierta" / "{{count}} terminales están
  abiertas".

**Desktop app** (shell), from `window.claudioDesktop.updates` (the extended IPC state):

| State | Shows | Action |
| --- | --- | --- |
| `idle` | `Tag ok` "Up to date" · "Al día" | – |
| `available` (AppImage) | en "Desktop app {{version}} is available." · es "La aplicación de escritorio {{version}} está disponible." | **Download desktop app {{version}}** · **Descargar la aplicación de escritorio {{version}}** (`btn-primary` only when the Claudio zone has none) |
| `downloading` | the existing progress bar, `updates.downloading` | – |
| `verifying` | braille spinner, en "Checking the signature…" · es "Comprobando la firma…" | – |
| `ready` (AppImage) | – | **Restart to update to {{version}}** (existing `updates.restart`), busy dialog with **Update when I quit** |
| `apt-managed` | en "Your system updates the desktop app through apt, with its other updates." · es "El sistema actualiza la aplicación de escritorio con apt, junto con sus otras actualizaciones." When the shell manifest says a newer one exists, a second line: en "Desktop app {{version}} is out; it arrives with the system's next update." · es "Ya ha salido la aplicación de escritorio {{version}}; llegará con la próxima actualización del sistema." | – |
| `copy-command` | en "Install it from a terminal. It asks for your password, and apt shows what it will change before it does." · es "Instálala desde una terminal. Te pedirá la contraseña, y apt mostrará lo que va a cambiar antes de hacerlo." The command in `UpdateSteps` (mono, wraps, never ellipsised) with `CopyButton` (existing `updates.copyCommand`). Under it, quiet: en "After this, apt keeps it up to date." · es "Después, apt la mantendrá al día." | Copy |
| `shell-replaced` | `Tag idle` en "Installed" · es "Instalada", en "The system installed desktop app {{version}}. Restart Claudio to use it." · es "El sistema ha instalado la aplicación de escritorio {{version}}. Reinicia Claudio para usarla." | **Restart Claudio** · **Reiniciar Claudio** (`btn-primary`), busy dialog |
| `unsupported` | existing reasons minus `no-elevation` | release link |
| `error` | `bad`, by code: `bad-signature` en "The download has no valid signature and was discarded." · es "La descarga no tiene una firma válida y se ha descartado."; otherwise `updates.desktopFailed` | **Try again** · **Reintentar** |

- **Switch to the AppImage** (only `.deb`, only when `switch.available`): a quiet link under the
  zone, en "Use the AppImage instead" · es "Usar la AppImage". It opens a `Dialog`:
  - title en "Switch to the AppImage?" · es "¿Cambiar a la AppImage?"
  - body en "Claudio installs the AppImage in your user folder and restarts from it. It then updates
    without a password. Your chats, settings and projects stay as they are. The .deb stays installed
    until you remove it." · es "Claudio instala la AppImage en tu carpeta de usuario y se reinicia
    desde ella. Así se actualiza sin contraseña. Tus chats, ajustes y proyectos se quedan como están.
    El .deb sigue instalado hasta que lo quites."
  - buttons: Cancel · Cancelar, and **Switch and restart** · **Cambiar y reiniciar** (`btn-primary`),
    through the busy dialog when work is live.
  - Afterwards, on the AppImage, while a `.deb` is still installed: en "The .deb is still installed.
    Remove it from a terminal:" · es "El .deb sigue instalado. Quítalo desde una terminal:" and the
    command with `CopyButton`.
- **The two zones and their primaries**: when the Claudio zone needs a newer desktop app, its own
  primary disappears and the Desktop app zone's action is the card's one primary. Otherwise each zone
  has at most one.
- **Both themes** at 1280 × 720 and 1600 × 950; a long command wraps with `overflow-wrap: anywhere`
  inside its container.

### The card served to a browser or a phone

The phone has no desktop app, so phone layout applies only to the web a desktop server serves (to a
phone over the tunnel, or a browser on the LAN). Such a page has no bridge:

- The **Claudio** zone reads `GET /system/server-update` and works with an owner token as in phase 1;
  with no owner credential its actions are replaced by phase 1's `needs-auth` sentence.
- The **Desktop app** zone shows only the facts and one sentence: en "The desktop app is updated on
  the computer that runs it." · es "La aplicación de escritorio se actualiza en el ordenador donde se
  ejecuta." When `needsShell` is set, the `warn` alert above it says the same.
- Phone: the card stacks, buttons full width at 44 px, as phase 1 says.

### Tray and menus (English, like the rest of the shell)

- Tray, above Quit, at most one line: "Restart to update to {{version}}" (payload or AppImage
  ready), or "Restart to finish the update to {{version}}" (`shell-replaced`). Both go through
  `confirmRestart`'s dialog when work is live.
- Help → **Check for updates…** keeps its dialogs and reads both zones: the payload first, then the
  shell. New messages: "Claudio {{v}} needs a newer desktop app" (with Open Settings),
  "Your system updates the desktop app through apt", and the copy-command case ("Open Settings", which
  shows the command; a dialog cannot hold a copyable command well).
- Help → **Use the bundled Claudio ({{shell}})**: shown while an overlay runs. It reverts through the
  shell, with no page involved, so a payload whose web is broken can always be undone.

## Contracts

### Shared types (`packages/shared/src/types.ts`)

Additive to phase 1's `[update-core]` block. After a change, run
`pnpm --filter @claudio/api openapi:schemas`.

```ts
// [payload-core]
/** Phase 1's, plus the open terminals a restart ends */
export interface LiveWork { working: number; waiting: number; running: number; terminals: number }

/** Phase 1's, plus 'development' (a desktop dev build) */
export type ServerUpdateUnsupported = 'not-docker' | 'no-launcher' | 'no-keys' | 'needs-auth' | 'read-only' | 'development';
// 'not-docker' now means "no launcher host": a source install. Its name is kept for compatibility.

/** Phase 1's, plus 'needs-shell' */
export type ServerUpdateError = 'fetch-failed' | 'bad-signature' | 'bad-manifest' | 'disk' | 'needs-image' | 'needs-shell';

/** The desktop shell the server runs under, as the shell told it at spawn */
export interface ShellInfo {
  version: string;
  package: 'appimage' | 'deb';
  shellInputs: string;
  /** The apt source is registered: apt updates the shell */
  aptManaged: boolean;
}

export interface ServerUpdateStatus {
  // … phase 1's fields; `image` holds the base payload's version on both hosts …
  /** What the base payload ships in: the image (`/app`) or the desktop shell (`<resources>`) */
  base: 'image' | 'shell';
  /** Null outside the desktop */
  shell: ShellInfo | null;
  /** The newest release needs a newer desktop shell than this one */
  needsShell: { version: string; minShell: string } | null;
}
```

**The bundle manifest** (phase 1's `claudio-server-<v>-linux-x64.json`) gains `minShell` and
`shellInputs`. `schema` stays `1` because the fields are additive, provided phase 1's parser ignores
unknown fields ([Re-check](#re-check-after-phase-1)); otherwise `schema: 2` and both parsers accept 1
and 2.

### The desktop IPC (`apps/desktop/src/ipc.ts`, `preload.ts`, `updater.ts`)

The shell's `UpdateState` becomes:

```ts
export type UnsupportedReason = 'development' | 'read-only' | 'unknown-package';   // 'no-elevation' removed
export type ShellUpdateError = 'bad-signature' | 'fetch-failed' | 'other';
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'verifying'; version: string }
  | { status: 'ready'; version: string }                                 // AppImage only
  | { status: 'apt-managed'; latest: string | null }
  | { status: 'copy-command'; version: string; command: string }
  | { status: 'shell-replaced'; version: string }
  | { status: 'unsupported'; reason: UnsupportedReason; message: string }
  | { status: 'error'; code: ShellUpdateError; message: string };

export interface SwitchState { available: boolean; reason: 'not-deb' | 'sandbox-restricted' | 'no-fuse' | null; debStillInstalled: boolean }
export type PayloadAction = { action: 'download'; version?: string } | { action: 'apply' | 'revert'; force?: boolean; whenIdle?: boolean } | { action: 'cancel-scheduled' };
```

New channels (the same `fromLocalPage` rule as today):

| Channel | Direction | Body → answer |
| --- | --- | --- |
| `claudio:payload` | page → main (invoke) | `PayloadAction` → the route's JSON (`ServerUpdateStatus`, or `{ status: 409, code, live }`) |
| `claudio:page-ready` | page → main (send) | none: the web rendered its shell; ends a trial's window check |
| `claudio:switch-state` | page → main (invoke) | → `SwitchState` |
| `claudio:switch-appimage` | page → main (invoke) | `{ force?: boolean }` → `InstallAnswer` |

`window.claudioDesktop.updates` gains `payload(action)`, `switchState()`, `switchToAppImage(opts)`;
the web calls `pageReady()` once after its first render. The web parses every answer defensively,
as `apps/web/src/lib/updates.ts` already does, so an older shell cannot break the card.

### Routes (phase 1's, extended; no new route)

| Route | Change |
| --- | --- |
| `GET /system/server-update` | answers the new `base`, `shell`, `needsShell`; supported on `appimage`/`deb` when `CLAUDIO_LAUNCHER=desktop` |
| `POST /system/server-update/download` | refuses `412 update.needs-shell` (beside `412 update.needs-image`); accepts the `desktop` actor under `CLAUDIO_LAUNCHER=desktop` (D8) |
| `POST /system/server-update/apply` | `409 update.live-work` carries `LiveWork` with `terminals`; the `desktop` actor as above |
| `DELETE /system/server-update/scheduled`, `POST /system/server-update/revert` | the `desktop` actor as above; `revert` restarts onto the shell's bundled payload |
| `POST /system/cli-version/install`, `DELETE …` | unchanged: docker only (the desktop uses the person's own `claude`) |

The `CHAT_FORBIDDEN_SYSTEM` set (phase 1) already lists every one of these. Rows in
`docs/rest-api.md` get the new error codes.

### Environment variables

| Variable | Set by | Meaning |
| --- | --- | --- |
| `CLAUDIO_LAUNCHER=desktop` | the desktop shell, for its server | supervised by the shell: exit 75 restarts the server; update routes accept the `desktop` actor |
| `CLAUDIO_APP_DIR` | the shell | the running payload's directory (`<resources>/server` or `<dataDir>/app/<v>`) |
| `CLAUDIO_WEB_DIST` | the shell | `<resources>/web` or `<dataDir>/app/<v>/web` |
| `CLAUDIO_GUARD_ENTRY` | the shell, always | `<resources>/server/guard.mjs`: the guard is the shell's, never the payload's |
| `CLAUDIO_BUNDLE_KEYS_DIR` | the shell | `<resources>/keys` |
| `CLAUDIO_SHELL_VERSION`, `CLAUDIO_SHELL_INPUTS`, `CLAUDIO_SHELL_PACKAGE`, `CLAUDIO_SHELL_APT` | the shell | `ShellInfo`, read once at start |
| `CLAUDIO_PAYLOAD=bundled` | the person, for one launch | boot the bundled payload and ignore overlays (recovery) |

### Files on disk

| Path | Owner, mode | Written by | Content |
| --- | --- | --- | --- |
| `<resources>/keys/*.pub` | AppImage mount / root 0444 | package | Ed25519 public keys, copied from `docker/keys/` |
| `<resources>/shell.json` | AppImage mount / root 0444 | package | `{ version, shellInputs }`; dpkg replacing it is the `shell-replaced` marker |
| `<resources>/server/guard.mjs` | AppImage mount / root | package | the guard (unchanged place) |
| `~/.config/Claudio/data/app/<v>/` | the person, 0755 | server (download), shell (GC) | the unpacked payload, `manifest.json`, `manifest.json.sig` |
| `~/.config/Claudio/data/app/state.json` | the person, 0600 | shell and server, atomic | phase 1's `{ active, previous, trial, attempts, bad, lastRollback, scheduled }` |
| `~/.cache/claudio-updater/pending/` | the person | electron-updater | downloaded shell packages (its own cache) |
| `/var/cache/claudio/claudio_<v>_amd64.deb` | root 0644 | the copied command | the root-owned copy apt installs |
| `/usr/share/keyrings/claudio-archive-keyring.gpg` | root 0644 | `.deb` | the apt key |
| `/etc/apt/sources.list.d/claudio.sources` | root 0644 | postinst, removed by postrm | the source (below) |
| `/etc/default/claudio` | root 0644 | postinst, removed on purge | `repo_add_once=false`, optional `CLAUDIO_APT_REPO=off` |
| `~/.local/share/claudio/Claudio.AppImage`, `~/.local/share/applications/claudio.desktop`, `~/.local/bin/claudio` | the person | `install.sh`, the switch | the AppImage install |

```
# /etc/apt/sources.list.d/claudio.sources
Types: deb
URIs: https://yeyo11.github.io/claudio/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/claudio-archive-keyring.gpg
```

### Release assets

Attached to the draft release before `publish` (phase 1's server-bundle assets, plus):

- `Claudio-<v>-x86_64.AppImage`, `Claudio-<v>-amd64.deb`, `latest-linux.yml` (as today);
- `claudio-desktop-<v>-linux-x64.json`: `{ schema: 1, version, shellInputs, minShell, commit, builtAt,
  files: { "<name>": { size, sha256, sha512 } } }` for the AppImage and the `.deb`;
- `claudio-desktop-<v>-linux-x64.json.sig`: `<keyId> <base64>` lines (D7);
- provenance attestations for the AppImage, the `.deb`, the server tarball and both manifests (in
  GitHub's attestation store, not as files).

**Feeds**: electron-updater reads `latest-linux.yml` (shell); the server reads the release JSON and
its asset list (payload, phase 1; the desktop manifest by the same route). apt reads the Pages
repository.

### apt repository layout

```
https://yeyo11.github.io/claudio/apt/
  index.html                                  how to add the repository by hand (static, no script)
  claudio-archive-keyring.gpg                 binary keyring (what the .deb ships)
  claudio-archive-keyring.asc                 armored, for people
  dists/stable/InRelease                      clearsigned Release
  dists/stable/Release                        Origin: Claudio · Label: Claudio · Suite: stable · Codename: stable
                                              Architectures: amd64 · Components: main · Valid-Until: +90 days
                                              SHA256 (and SHA512) of every index below
  dists/stable/Release.gpg                    detached signature
  dists/stable/main/binary-amd64/Packages
  dists/stable/main/binary-amd64/Packages.gz
  pool/main/c/claudio/claudio_<v>_amd64.deb   the newest four releases
```

### Workflows

- `desktop.yml`: also builds `shell.json` and the desktop manifest, signs it (job in environment
  `release`), attests, uploads while a draft.
- `apt-repo.yml` (new, reusable): from the draft's `.deb` and the newest three published `.deb`
  files, build and sign the repository (environment `release`, secret `CLAUDIO_APT_SIGNING_KEY`),
  upload it as a Pages artifact. **Fails** without the secret on a release tag. A `schedule:`
  (monthly) and `workflow_dispatch` rebuild from published releases only and deploy.
- `release.yml`: `publish` needs `release` (image), `desktop`, `server-bundle` (phase 1) and
  `apt-repo`; a new `pages` job after `publish` runs `actions/deploy-pages` (environment
  `github-pages`, `pages: write`, `id-token: write`).
- `desktop-smoke.yml` (new, on pull requests touching `apps/desktop/**`, `packaging/**`,
  `packages/core/src/launcher/**`, `scripts/install.sh`): see [Tests](#tests).

## Security

| Threat | Held by |
| --- | --- |
| **A tampered payload in a user-writable dir** (an agent running as the person rewrites `~/.config/Claudio/data/app/<v>/server.mjs` or `mcp.mjs`) | Under guards, `integrity.own-state` already refuses the write (the path is in the data dir). Without guards: the shell verifies the signature and every file's sha256 **at every boot** with keys in its read-only resources, and refuses and marks bad anything that fails. Residual: a same-user process can change a file after the boot check (for example `mcp.mjs`, which each chat's CLI starts later). That gives it nothing it lacks: the same user can already edit `~/.claude/settings.json` hooks or `~/.bashrc`, which the guard protects in the same way and no more. The guard itself stays in the shell (`CLAUDIO_GUARD_ENTRY`), and its rules format is in `shellInputs` |
| An agent edits `state.json` to point somewhere else | Phase 1's rule: paths are built from validated version strings under `<dataDir>/app`, never read from `state.json` |
| **Ed25519 key compromise** | The key is in the protected `release` environment, `main` only. Rotation: ship the new public key in a shell (desktop) and an image (container) first, then sign with both (multi-line `.sig`), then drop the old key in the next shell. An attacker also needs to serve the release JSON (GitHub over TLS, or the person's own mirror) |
| **apt key compromise** (the highest-impact secret: a root install on every apt user) | Same environment protection; key used only by the `apt-repo` job; revocation certificate kept offline by the owner; rotation by shipping the new key in the keyring file of a `.deb` signed by the old one, and an overlap period where `InRelease` carries both signatures. Recommended to the owner: a required reviewer on the `release` environment ([Open questions](#open-questions)) |
| A freeze or replay of the apt repository | `Valid-Until` 90 days, re-signed monthly |
| **Downgrade attacks** | Payload: only newer than the base and the running version, `bad` never retried (phase 1). AppImage: electron-updater's `allowDowngrade` stays false, and the shell refuses a desktop manifest older than itself. apt: version ordering, and `Valid-Until` |
| A swapped `.deb` between download and `sudo` | The copied command installs a root-owned copy checked against the signed sha256 (D3) |
| **A payload that bricks the window** (the server answers `/api/health` but the web never renders) | The desktop trial also waits for `claudio:page-ready` (30 s after the window loads); without it the attempt fails and two failures roll back. Help → Use the bundled Claudio and `CLAUDIO_PAYLOAD=bundled` revert without the page |
| A payload needing a newer shell | `minShell`, checked by the server before download and by the shell's machine before boot |
| A local process triggers an update or a forced restart | The routes take the `desktop` actor only from the shell's per-launch secret under `CLAUDIO_LAUNCHER=desktop`; `none` stays refused; chat tokens are denylisted |
| A malicious page in the window drives updates | IPC is accepted only from the local server's page (`fromLocalPage`) |
| The apt source persists after uninstall | postrm on `remove` deletes the source; `purge` also deletes `/etc/default/claudio` |
| AppImage without Chromium's sandbox | Never offered or installed by default where the sandbox needs root (D5); `--no-sandbox` is never used |

## Tasks

The integrator launches this graph on `fix/container-polish` after phase 1 is merged and the
[re-check](#re-check-after-phase-1) is done. **Three stages in series**:
`payload-core · release-apt → desktop-shell · web-updates → review · docs`.

| Id | Model | Task | dependsOn | Owns | Checks |
| --- | --- | --- | --- | --- | --- |
| `payload-core` | `claude-opus-5-5` | D1, D2, D7, D8 in core and api: extract `machine.ts` if phase 1 left it inside `main.ts`; multi-key `.sig`; `minShell`/`shellInputs` in the manifest and its checks; desktop support in the overlay manager (`base`, `shell`, `needsShell`, data-dir path); the `desktop` actor rule; `LiveWork.terminals` (`core.liveWork()` counts open shells); types; the bundle script's `--shell-json` and desktop manifest | – | `packages/core/src/launcher/**`, `packages/core/src/updates/**`, the `liveWork` lines in `packages/core/src/index.ts`, `apps/api/src/routes/server-update.ts`, `apps/api/scripts/server-bundle.mjs`, the update part of `packages/shared/src/types.ts`, the generated schemas, `docs/rest-api.md` rows, their tests | `pnpm typecheck`, `pnpm test`, `openapi:schemas`; `node apps/api/scripts/server-bundle.mjs --sign-with <test key>` then a verify round trip with two keys |
| `release-apt` | `claude-opus-5-5` | D3 packaging, D4, D5, D7 in CI: the deb scripts, `shell.json` and keys in resources, the static AppImage toolset spike, `apt-repo.yml`, `desktop.yml` signing and attestations, `release.yml` wiring and the `pages` job, `desktop-smoke.yml`, `install.sh` | – | `apps/desktop/electron-builder.yml`, `apps/desktop/build/linux/**` (new `after-install.sh`, `after-remove.sh`), the `scripts` of `apps/desktop/package.json`, `packaging/apt/**` (new: build script, `index.html`, public keyring), `.github/workflows/{desktop,release,apt-repo,desktop-smoke}.yml`, `scripts/install.sh` | `actionlint` if installed; `shellcheck scripts/install.sh packaging/apt/*.sh apps/desktop/build/linux/*.sh`; build the repo locally with a throwaway GPG key, then in `docker run debian:trixie` and `ubuntu:26.04`: add it, `apt update`, install a dummy `claudio` package, check the source and keyring, `apt purge` removes them |
| `desktop-shell` | `claude-opus-5-5` | D1, D3, D5 switch, D6, D8 in the shell: `payload.ts` (the machine around `ServerProcess`, trial with `/api/health` and `page-ready`, exit 75, window reload, GC); `resources.ts` (keys, guard, `shell.json`); `serverEnv` additions; the updater rewrite (no pkexec, `apt-managed`, `copy-command`, `shell-replaced`, the desktop-manifest check); the switch; IPC, preload, tray, menu | `payload-core` | `apps/desktop/src/**`, `apps/desktop/test/**`, `apps/desktop/scripts/build.mjs` (only if the bundle needs it), `e2e/specs/updates-desktop.spec.mjs` | `pnpm typecheck`, `pnpm test` (desktop), `pnpm desktop:dist`, then the AppImage under `xvfb-run` with a separate config dir: a signed local payload served through `CLAUDIO_RELEASES_URL` → download → restart → page-ready → promoted; a payload whose web never renders → rolled back |
| `web-updates` | `claude-sonnet-5-5` | the [Design](#design): the two zones, every state, the switch dialog, the remote card, copy en/es, `pageReady()` | `payload-core` | `apps/web/src/pages/config/UpdatesCard.tsx`, `apps/web/src/lib/updates.ts`, `apps/web/src/lib/desktop.ts`, the update functions in `apps/web/src/api.ts`, `locales/{en,es}/config.json` keys under `updates`, the `pageReady` call in `apps/web/src/main.tsx` | `pnpm typecheck`, `pnpm test` (web), design lint on edited files, `/ui-review /settings/updates` with a fake bridge in both themes at 1280 × 720 and 390 × 844 |
| `review` | `claude-opus-5-5` | design, conventions, security (D3's command, D7, D8, the deb scripts), copy against the glossary; at most one test run | all four above | none (findings, or one-line fixes in owned-by-nobody places) | reads |
| `docs` | `claude-sonnet-5-5` | `docs/desktop.md` (Installing, Updating, Where things live), `docs/updates.md` (phase 1's, extended to the desktop), `README.md` install lines, two decision records (`docs/decisions/shell-payload-updates.md`, `docs/decisions/apt-repository.md`), notes in `docs/plans/app-updates.md` and `docs/plans/container-polish.md`, `docs/status.md`, this plan's Outcome | the four implementation tasks | those files | `pnpm test` (docs tests) |

`desktop-shell` and `web-updates` share only the IPC contract written above; the web parses it
defensively and tests against a fake bridge. `release-apt` calls `server-bundle.mjs --shell-json`
and the desktop-manifest flags by the contract; the integrator checks the call after the merge.

### Rules for every task

Phase 1's [rules](container-polish.md#rules-for-every-task) apply unchanged. And:

1. Read phase 1's plan, D4 and Contracts, and the code it produced, before changing it.
2. Security-sensitive code (`launcher/**`, verification, the deb scripts, signing steps) gets a
   comment saying what it defends against, and a test for the refusal path, not only the happy path.
3. Never run `sudo` on the worker's host; the `.deb` and apt checks run inside `docker run`.

### Patterns to follow

- A state machine with an injected engine and its fake: `DesktopUpdater` at
  `apps/desktop/src/updater.ts:152-305`, tested against a fake engine.
- The live-work decision: `apps/desktop/src/updater.ts:350-358`.
- The server child and its `READY` line: `apps/desktop/src/server-process.ts:76-150`.
- IPC accepted only from the local page: `apps/desktop/src/main.ts:211-215,497-503`.
- A draft-only upload: `.github/workflows/desktop.yml:57-75`; a reusable workflow call:
  `.github/workflows/release.yml:89-97`.
- The card's defensive parsing and route choice: `apps/web/src/lib/updates.ts` (`parseUpdateState`,
  `updateRoute`).
- electron-builder's deb scripts to extend: `app-builder-lib/templates/linux/after-install.tpl`,
  `after-remove.tpl`.

## Owner actions before the merge

1. **The apt signing key**, made by the owner's session the way phase 1's Ed25519 key was:
   - In a throwaway `GNUPGHOME` on a tmpfs:
     `gpg --batch --quick-gen-key 'Claudio apt repository <yeyochico@gmail.com>' ed25519 sign 3y`
     with no passphrase (the secret store is the protection; a passphrase in the same store adds
     nothing).
   - Export the armored private key into the GitHub Environment `release` as
     `CLAUDIO_APT_SIGNING_KEY`; export the public key dearmored as
     `packaging/apt/claudio-archive-keyring.gpg` and armored as `.asc`, committed; record the
     fingerprint in `docs/decisions/apt-repository.md` and pin it in `install.sh`.
   - Generate a revocation certificate and keep it, with the private key, in the owner's password
     manager. Delete the `GNUPGHOME`.
   - The key expires in 3 years; extending it is a re-export of the same key, shipped in a `.deb`.
2. **GitHub Pages**: Settings → Pages → Source **GitHub Actions**; the `github-pages` environment's
   deployment branch policy allows `main` only.
3. **Decide the [open questions](#open-questions)**.
4. **Migrating this machine**: the installed 0.6.x takes the first phase-2 release through its
   existing updater (one last `pkexec` password) or `sudo apt install ./Claudio-<v>-amd64.deb`; the
   new postinst registers the repository, and from then on apt handles the shell and the app the
   payload.

## Tests

- **Unit** (per task above): the machine on both hosts with fakes (trial promoted, rolled back after
  two failures, page-ready timeout, tampered file, multi-key `.sig`, rotated and unknown keys,
  `minShell` refusal, `CLAUDIO_PAYLOAD=bundled`, GC); `shellInputs` stability (same inputs, same
  hash); the overlay manager's `needsShell` and `base`/`shell`; the `desktop` actor accepted only
  under `CLAUDIO_LAUNCHER=desktop` and refused under `none`; the updater's new states from a fake
  engine and a fake `shell.json`; `sandboxRootless()` over fake `/proc` files; the copy command's
  quoting with a path holding spaces and a quote; the card's states from fixtures, with en/es parity.
- **Smoke in CI** (`desktop-smoke.yml`, `ubuntu-latest`, inside containers where root is needed):
  - **deb**: build the `.deb` and a repository signed with a throwaway key; in `debian:trixie` and
    `ubuntu:26.04`, install from the repository, check `claudio.sources`, the keyring and
    `/etc/default/claudio`; build a second version, `apt upgrade` to it; `apt remove` removes the
    source; `apt purge` removes `/etc/default/claudio`; an `InRelease` signed by another key is
    refused by `apt update`.
  - **AppImage**: start it under `xvfb-run` with a separate config dir (with `--no-sandbox` only in
    CI, where the runner's sandbox is not the subject; the test asserts the shell never passes it on
    its own), serve two signed payloads through `CLAUDIO_RELEASES_URL`, update to the first
    (promoted after page-ready), then to the second, whose web never renders (rolled back, audit row,
    `lastRollback`).
- **e2e** (CI only, `pnpm e2e:remote updates updates-desktop`): `updates-desktop.spec.mjs` with a
  fake bridge walks the payload states, `needsShell`, `apt-managed`, `copy-command` (the command is
  copyable and wraps), `shell-replaced` and the switch dialog; `updates.spec.mjs` with
  `CLAUDIO_DISTRIBUTION=deb` and `CLAUDIO_LAUNCHER` unset shows the remote card. Never apply in e2e.
- **Before the merge, by the integrator**: the AppImage built from the branch, on this machine, in a
  separate config dir, refusing to start sandboxed is the expected D5 result to record; the `.deb`
  installed in a VM or a container with a desktop, upgraded through the Pages repository from a
  test deployment (`workflow_dispatch` of `apt-repo.yml` on the branch, deploying to a preview path
  only if the owner allows it).

## Risks

- **GitHub Pages limits.** 1 GB per site (four `.deb` files fit) and a soft 100 GB a month of
  bandwidth (≈ 750 `.deb` downloads). If either bites, move the pool to a hosted service and
  rewrite the source's `URIs:` in the next postinst. Whether an artifact deployment takes a 129 MB
  file is unverified: `release-apt` checks it first with a `workflow_dispatch` deployment; if
  refused, the owner chooses the fallback ([Open questions](#open-questions)).
- **A broken monthly re-sign** expires the repository after 90 days and `apt update` warns for
  every user. The workflow fails loudly; the window is long.
- **The static AppImage runtime is beta** in electron-builder 26.15.3. Fallback: the legacy toolset
  and `libfuse2`, chosen by `install.sh`.
- **Files replaced under a running `.deb` app.** Renderers fork from the zygote and keep working;
  the shell treats itself as stale (`shell-replaced`) and upgrades every restart to a full relaunch.
  A crash before the person restarts is possible; it then starts the new version.
- **The extracted machine changes phase 1's launcher**, the one part an update cannot fix. Its tests
  must pass unchanged, and the container rollback run of phase 1 is repeated.
- **Same-user tampering after the boot check** is accepted (see Security); it is no weaker than the
  person's own dotfiles.
- **`shellInputs` is conservative**: any guard change needs a new shell. Accepted; the guard is the
  trust anchor.

## Decisions taken by the owner (2026-10-18)

1. **The AppImage default on hosts that restrict user namespaces** (D5): confirmed as planned. `install.sh`
   picks the AppImage only where it runs with Chromium's sandbox without root; everywhere else,
   this machine included (Ubuntu 26.04, `kernel.apparmor_restrict_unprivileged_userns = 1`), the
   `.deb` with the signed apt repository. Never `--no-sandbox`.
2. **A required reviewer on the `release` environment**: done. The owner (`yeyo11`) must approve
   every job that runs in `release`, so no bundle or apt signature exists without their click,
   even after a push to `main`. Its deployment branch policy stays `main` only. A separate `apt`
   environment is not needed: the apt key lives in `release` too.
3. **Hosting the apt repository**: GitHub Pages serves only the signed indexes (`InRelease`,
   `Release`, `Packages`); each `Filename` in `Packages` points at the `.deb` asset of the GitHub
   release (or the pool redirects to it), so Pages never holds the 129 MB file and its bandwidth
   limit does not apply to downloads. The `.deb`'s hash in `Packages` is what apt verifies, so the
   asset host needs no trust of its own. `release-apt` verifies that apt follows the link (a
   `Filename` with an absolute URL is not valid; use a pool path on Pages that answers a redirect,
   or a 404 page redirect, and record which works) and falls back to keeping the newest `.deb`
   on Pages only if no redirect form works.

## Carried over from phase 1

**Checking a credential never spends tokens** (owner, 2026-10-18). Phase 1's spike (`signin-core`,
fixtures `packages/accounts/test/fixtures/get-usage-refused-*.json`) and a probe on CLI 2.1.302 the
same day found that no free CLI surface tells a bad credential from a good one: `auth status`
says `loggedIn: true` whenever the variable exists; `initialize` answers the same `account`
(`tokenSource` and `apiProvider` only) and the same model list for an invalid OAuth token, an
invalid API key, no credential and a valid login; `get_usage` answers `rate_limits_available:
false` for all of them. The owner rejected an automatic paid test message, so:

- **An API key** (in the environment or saved in Claudio) is checked with the vendor's official SDK,
  `@anthropic-ai/sdk` `models.list()` (documented, free, answers 401 for a bad key), when the key
  is new or changed (a sha256 of the value stored in the data dir, never the value) and on
  **Check** in Settings. This is "the vendor's official SDK" of CLAUDE.md's one rule; the SDK is
  used for this check only, never to drive the agent. A 401 marks the account as a failed run
  does (`authFailedAt`, `signInState: 'expired'`); a network error changes nothing.
- **An OAuth token from the environment** (`CLAUDE_CODE_OAUTH_TOKEN`) has no free documented check,
  and claude.ai's internal endpoints are out (the one rule). It is shown as **Not confirmed** with
  the sentence "Claudio confirms it with the first chat", never as signed in. The first run
  settles it: an invalid token is refused at authentication, before any token is generated, so it
  costs nothing and marks the account expired (phase 1's run-failure path); a run that succeeds
  confirms it (`checkedAt`).
- **A login made in the app** is confirmed by `get_usage` returning the plan's limits when it does,
  as phase 1 built; otherwise the same "Not confirmed until the first chat".
- **Check** in Settings never sends a message on its own: for a key it runs `models.list()`; for an
  OAuth credential it offers **Send a test message** (phase 1's paid `/auth/verify`) as an explicit,
  labelled choice with its cost stated.
- Owned by a small stage-1 task `credential-check` (sonnet): `packages/core/src/cli.ts`,
  `packages/accounts/src/**` (the check and the state), `packages/core/src/index.ts` (start-up hook),
  the `@anthropic-ai/sdk` dependency in `packages/accounts/package.json`, web copy for "Not
  confirmed" in `apps/web/src/i18n/locales/{en,es}/accountsConfig.json` and `config.json`, tests
  with a fake SDK transport (401, 200, network error).

**The tunnel survives a slow machine** (owner, 2026-10-18). On 2026-10-18 at 11:55 UTC the desktop's
tunnel closed itself with an error while Tailscale was fine: the machine was at 97 % CPU (two
`llama-server` processes and phase 1's workers, load average 20 on 12 cores), two consecutive
monitor probes (`monitorMs` 30 s, `commandTimeoutMs` 10 s, `maxMisses` 2,
`packages/core/src/tunnel.ts:47-50`) timed out, `check()` (`:576-593`) counted them as
`daemonDown`, and `giveUp()` (`:610-617`) failed the tunnel, withdrew its host from the allowlist
(audit row at 11:56:19) and ran `tailscale serve --https=8444 off` (tailscaled's journal:
"closing listener …:8444" at 11:55:42). tailscaled itself never stopped.

- **A probe that could not answer is `unknown`, not `down`.** `runCli` reports a timeout or a spawn
  failure apart from an answer; `check()` keeps the tunnel `active`, sets a `checking` flag the UI
  shows as "Checking…" (no status colour change), and retries with back-off (30 s, 60 s, 120 s,
  capped at 5 min). Only a definitive answer closes it: `BackendState` not `Running`, signed out,
  or the Serve rule gone or changed by someone else (`ruleRemoved`).
- **No destructive action on an inconclusive probe.** `giveUp()` after unknowns never runs `serve
  off` and never withdraws the host: Tailscale keeps serving the rule regardless of how slow the
  CLI is. After 10 minutes of nothing but unknowns the tunnel shows a warn state ("Tailscale is
  not answering") but keeps its rule and host.
- **It comes back on its own.** A tunnel that failed because Tailscale was down or signed out, and
  that the person had started (`wanted` was true), is started again when a later probe finds
  Tailscale ready, with an audit row; a tunnel the person stopped never restarts.
- Owned by a small stage-1 task `tunnel-resilience` (sonnet): `packages/core/src/tunnel.ts`, its
  types (`TunnelStatus.checking`), `packages/core/test/tunnel.test.ts` with
  `packages/core/test/fixtures/fake-tailscale.mjs` gaining a delay knob (slow answers keep the
  tunnel; a signed-out answer closes it; recovery restarts it), the Remote access card's copy in
  `apps/web/src/i18n/locales/{en,es}/config.json`, and `docs/tunnel.md`.

## Re-check after phase 1

The integrator verifies each against the merged phase-1 code before launching, and corrects this
plan (or the task prompts) where it differs:

1. Is the launcher's state machine separable from `packages/core/src/launcher/main.ts`, with spawn,
   health, clock and files injectable? If not, `payload-core` extracts it first, with phase 1's
   launcher tests unchanged.
2. The exact names: `RESTART_EXIT_CODE`, `verifyManifest`, `verifyFiles`, the `state.json` type, the
   manifest type, `isOwnerActor`, `core.liveWork()`, `CHAT_FORBIDDEN_SYSTEM`.
3. Does the manifest parser reject unknown fields or `schema` ≠ 1? Decides `schema: 1` vs `2`.
4. Does `.sig` verification accept only one bare line? The multi-key format must keep it valid.
5. Is the overlay path built from `CLAUDIO_DATA_DIR` or hard-coded `/data`? Is "supported" tied to
   `CLAUDIO_LAUNCHER === '1'` and `distribution === 'docker'`? Both must widen.
6. Does the overlay's tarball contain `server.mjs` as well as `api.mjs`, and `node_modules/node-pty`
   and `@number0` with their N-API binaries? If `server.mjs` is excluded, `payload-core` adds it.
7. The phase-1 `ServerUpdateStatus` fields as built (`image`, `source`, `needsImage`) and the
   `unsupportedReason` values; `LiveWork` as exported.
8. Is `/api/health` answered without credentials on the desktop's loopback under every auth mode
   the desktop allows?
9. Is the Updates card's container branch built so a desktop branch can share its states (one state
   renderer, two sources)?
10. Did `server-bundle.yml` sign in environment `release` with `actions/attest-build-provenance`, and
    is `publish` already waiting on it? The desktop and apt jobs follow the same pattern.
11. Did phase 1 release? If not, renaming `not-docker` and `image` to host-neutral names is free and
    the integrator may do it in `payload-core`.

## Related

- [[plans/container-polish]]
- [[plans/app-updates]]
- [[plans/terminal]]
- [[plans/process-isolation]]
- [[plans/terminal-persistence]]
- [[desktop]]
- [[deploy]]
- [[updates]]
- [[guards]]
- [[security-model]]
- [[terminal]]
- [[known-limitations]]
- [[orchestrations]]
- [[design-system]]
- [[decisions/shell-payload-updates]]
- [[decisions/apt-repository]]
- [[decisions/e2e-on-github]]
