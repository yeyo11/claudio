---
created_at: 2026-09-19T07:37:05Z
updated_at: 2026-10-19T09:00:00Z
tags:
    - desktop
    - electron
    - linux
    - packaging
    - operations
    - updates
---
# Desktop app (Linux)

The desktop app is Claudio in a window: the same UI and REST API as the Docker image, packaged as
an AppImage and a `.deb` for Linux x86_64. No container, no port to remember.

It is a small Electron shell. On start it launches the bundled API as a child process on
`127.0.0.1`, waits for it to come up and loads the UI. The API runs on the Node that ships inside
Electron, so **you do not need Node installed**. Quitting the window stops the server.

The port is chosen once and then kept: the first start takes a free one and writes it to
`server-port.json` in the app's data directory, and every start after that asks for the same one, so
a bookmark or a tunnel pointed at the app still works tomorrow. It is a preference and not a
promise — if something else holds that port, the server takes a free one instead of refusing to
start, and that becomes the port it remembers. `PORT` in the environment overrides the lot.

## How it differs from Docker

| | Docker image | Desktop app |
| --- | --- | --- |
| Where Claude runs | Inside the container | On your machine, as you |
| Sandbox | The container | **None** |
| Default permission mode | `bypassPermissions` | `acceptEdits` |
| Claude Code CLI | Baked into the image | Yours, from your `PATH` |
| Login | `CLAUDE_CODE_OAUTH_TOKEN` | Your existing `~/.claude` login |
| Listens on | `0.0.0.0:8797` | `127.0.0.1`, the port it used last |
| Web Push | Over HTTPS, to any installed browser or phone | Not registered — see below |
| Tunnel (Settings → Access & safety → Remote access) | Off unless `CLAUDIO_TUNNEL=on` | On; needs Tailscale installed and signed in on the machine (not a `.deb` dependency) |

The image can afford `bypassPermissions` because the container is the boundary. The desktop app has
no boundary: Claude reads and writes your real files and runs commands with your privileges. So it
starts in `acceptEdits`, where file edits are applied and anything else that needs permission is
sent to the panel for you to allow or deny. A run can still choose another mode from the UI.

The desktop app registers **no service worker**, and so receives no Web Push: it already has the
bundle locally, and the window is there anyway — the bell and its toasts are what tell you inside
the app. Until the port was kept there was a second reason, that every launch would strand another
registration under an origin that never came back; that one no longer holds, so if push in the
window ever looks worth having, it is now a question of whether it earns its keep and not of
whether it can work.
To be told on a phone, point it at a wrapper served over HTTPS — see
[pwa.md](pwa.md) and [deploy.md](deploy.md).

Authentication is off by default (see [SECURITY.md](../SECURITY.md)). The desktop server only
listens on the loopback interface, but any process on your machine can reach that port. Turn on a
token in Settings → Access & safety if other users share the machine.

## Requirements

- Linux x86_64. There is no arm64 build.
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in on
  the host. The app uses that login and your `~/.claude` (sessions, settings, MCP servers); it does
  not ask for a token. Run `claude` once in a terminal to log in.
- [Tailscale](https://tailscale.com/download), signed in, for the tunnel in Settings → Access &
  safety → Remote access, with MagicDNS and HTTPS certificates on for the tailnet and your user set as the node's
  operator once (`sudo tailscale set --operator=$USER`). It is not a dependency of the `.deb`, since
  it is not in Debian's archive. Without it, the tab says how to install it and everything else
  works.
- For the AppImage, FUSE: `/dev/fuse` and `fusermount3` (present on current desktops). The AppImage
  uses the static runtime, so `libfuse2` is no longer needed. Without FUSE, run it with
  `--appimage-extract-and-run`, or take the `.deb`.

## Installing

**One command**

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash
```

It downloads the latest release and picks the format that suits your system:

- **The AppImage** where Chromium's sandbox starts without root and FUSE is usable. It is installed
  under `~/.local` with a menu entry, an icon and a `~/.local/bin/claudio` link, and needs no root.
- **The `.deb`, through a signed apt repository,** everywhere else on Debian and Ubuntu. Ubuntu 24.04
  and later restrict unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns`),
  and Chromium's sandbox cannot start inside an AppImage in a user folder there. The `.deb` can: its
  postinst installs an AppArmor profile. Claudio never starts without the sandbox (`--no-sandbox`) to
  get around this. The installer asks for your password once.
- An existing `.deb` install stays a `.deb`, so a second run does not install a second copy.

The AppImage is checked before it is installed, against the release's Ed25519-signed desktop manifest
with the key pinned in `install.sh` (OpenSSL 3). With an older OpenSSL, or a release without a
manifest, it says so and checks the sha512 in `latest-linux.yml`; a manifest that is present and does
not verify stops the install. Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash -s -- --version v0.2.0
curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash -s -- --appimage
curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash -s -- --deb
curl -fsSL https://raw.githubusercontent.com/yeyo11/claudio/main/scripts/install.sh | bash -s -- --uninstall
```

`--appimage` and `--deb` force a format. `--deb` fetches the repository's keyring and refuses it
unless it holds exactly the pinned key (fingerprint `33DC4ECFD40612112D06475843E6487D3DF5098F`), then
runs `apt-get install -y claudio`.

Uninstalling keeps your data (`~/.config/Claudio`, `~/Claudio`). To update, see [Updating](#updating).

**Add the apt repository by hand**

The `.deb` registers the repository itself when it is installed. To do it first, follow the page at
<https://yeyo11.github.io/claudio/apt/>, then `sudo apt install claudio`. The repository is signed
(`InRelease`, valid for 90 days and re-signed every month), and its key is trusted for this repository
only (`Signed-By`), never through `/etc/apt/trusted.gpg.d`. The decision and its findings:
[decisions/apt-repository.md](decisions/apt-repository.md).

**By hand**

Both files are attached to each [GitHub release](https://github.com/yeyo11/claudio/releases).

**AppImage**

```bash
chmod +x Claudio-<version>-x86_64.AppImage
./Claudio-<version>-x86_64.AppImage
```

**Debian / Ubuntu**

```bash
sudo apt install ./Claudio-<version>-amd64.deb
```

apt may end with a note that the download was "performed unsandboxed as root" because the file is
not readable by user `_apt`. That is harmless: the package installed. Installing from `/tmp`
avoids it.

This installs to `/opt/Claudio`, links `/usr/bin/claudio` and adds a launcher entry. Start it from
your application menu or with `claudio`. The package also registers the apt repository once
(`/etc/apt/sources.list.d/claudio.sources`, with its keyring in `/usr/share/keyrings`), so apt keeps
the app up to date from then on. If you delete the source it does not come back on an upgrade; set
`CLAUDIO_APT_REPO=off` in `/etc/default/claudio`, or in the environment of the install, to skip it.
`apt remove claudio` removes the source and `apt purge` also removes `/etc/default/claudio`.

The window opens on a splash screen while the server starts: a 4 s brand intro in which the
logo's C takes two bits of code from its cursor in two bites, settles, and the name is written out
of the cursor ([plans/splash-eat-the-code.md](plans/splash-eat-the-code.md)). The intro always
plays to its end and then fades; if the server is still starting, the finished logo stays. If it
cannot start, the window shows the reason with a **Restart** button and a link to the logs.

## The window, the tray and the taskbar

**Title bar.** The window has no separate title bar: Claudio's own top bar is the title bar, and
dragging any empty part of it moves the window. The window controls sit on the right, drawn by the
system over a 54 px strip that matches the top bar, and follow the light or dark theme as you
change it (or as the system does, when the theme follows it). On macOS the traffic lights sit at the
top left instead, and the sidebar and top bar leave room for them. The splash and error pages can be
dragged too, and so can the first-run step and the sign-in: they have no top bar, so each carries a
fixed strip of the same height as its drag region. Without it the window had no drag region at all
there, and on Wayland (GNOME, Ubuntu) the mouse reached nothing in the first-run step until the
person got into the app by keyboard (0.30.0).

**Tray.** A tray icon says what is live. Its tooltip reads like "Claudio — 2 working · 1 waiting ·
1 orchestration"; Linux trays never show a tooltip, so the same line is also the first entry of its
menu. The menu has **Open Claudio**, **New chat**, up to eight live items — chats waiting for you
first, then working chats, then running orchestrations with their tasks done out of the total, and
"N more…" past that — and **Quit Claudio**. Picking an item opens it in the window without reloading
the page. Closing the window still quits the app: the tray shows what is live, it does not keep
Claudio running in the background.

**Progress and badge.** The taskbar or dock shows the combined progress of the running
orchestrations (tasks done over tasks, across all of them; indeterminate for one that has no tasks
yet), cleared when none runs. The badge counts the chats waiting for a person. Both appear where the
platform supports them: on Linux, docks that implement the Unity launcher API; the badge also on
macOS, not on Windows.

**Where the tray's data comes from.** Only the local server the app started: `/api/overview`, the
working and waiting chat lists and `/api/orchestrations` (these only while the overview says
something runs), re-read when the `/api/events` feed announces a change, at most every 1.5 s, and
every 30 s while the feed is down. The tray and the window menus are in English only.

**The tray's credential.** At each launch the app generates a secret (32 random bytes) and hands it
to the server it starts as `CLAUDIO_DESKTOP_TOKEN`; the tray sends it as its bearer token. It is
what lets the tray read a server guarded from Settings → Access & safety, whose token only exists as a
hash and so is never known to the app. The server accepts the secret only from `127.0.0.1` dialled
on a loopback name (not through the tunnel or a proxy), compares it in constant time, and treats it
as the actor `desktop`, which may only read (`GET`/`HEAD`; anything else is `403`). It lives in the
memory of the two processes only: it is never written to `auth.json` or a log, no route returns it,
it is removed from the environment chats and commands inherit, and the next launch has another.
Without a secret, `CLAUDIO_AUTH_TOKEN` from the app's environment is sent instead.

**When the server refuses it.** A `401` or `403` makes the tray stop asking for 5 minutes, then 10,
up to 30, feed and polling alike; a `429` waits as long as `Retry-After` says. `desktop.log` gets
one line when the refusals start and one when the server answers again, not one per attempt. Up to
0.23.1 the tray polled a guarded server without a credential every 15 to 30 s, and because the
server then counted every refused request against `127.0.0.1`, it locked the owner's own window
and chats out with `429` ([decisions/requests-without-credential.md](decisions/requests-without-credential.md)).

## Updating

An update has two parts, and most releases change only the first
([decisions/shell-payload-updates.md](decisions/shell-payload-updates.md),
[plans/unified-updates.md](plans/unified-updates.md)):

- **Claudio, the payload.** The server, the API, the web and the terminal and Collaborators hosts: a
  signed bundle, the same one the Docker image installs ([updates.md](updates.md)). It installs
  **without a password and without replacing the app**: only the server restarts, and the window
  reloads on its own.
- **The desktop app, the shell.** Electron, the launcher machine, the guard, the public keys and the
  preload with its IPC. It changes rarely, and only a package can change it. Each release says the
  oldest shell it runs on (`minShell`); when the newest Claudio needs a newer shell, Settings says so
  and the payload waits for it.

The app learns of a release from its own server, which asks GitHub for the latest Claudio release
once a day and whenever you press **Check for updates** (see [plans/app-updates.md](plans/app-updates.md)).
While a newer one is known, a dot marks Settings in the sidebar. The app never downloads or restarts
on its own: both happen when you ask.

**Where to ask.** Settings → General → Updates has two zones. **Claudio** shows what runs and the
newest release, with **Download Claudio X** and its progress, then **Restart to update to X**.
**Desktop app** shows the shell's own state (below). Help → **Check for updates…** reads both
through dialogs, the payload first and then the shell; when a command has to be copied it opens
Settings, which can hold it. Once an update is ready, the tray menu has one line above Quit:
**Restart to update to X**, or **Restart to finish the update to X** after the system replaced the
shell.

When the newest release cannot be installed from here, the card offers no download. It says why, once
and translated: published without an in-app update, needs a newer desktop app, could not be checked,
or did not start here before. A refusal is shown from its code, never as the server's English text.

**The restart waits for idle.** Restarting stops every chat in flight, so if chats are working or
waiting for your answer, orchestrations are running, or terminals are open, the restart asks first
and offers **Restart now**, **Restart when nothing is running** (or **Update when I quit** for the
shell) or Cancel. Chats and orchestrations resume after a payload restart (the next turn continues
the session, interrupted tasks continue); a turn in flight is lost, and so is every terminal shell:
terminals end with the server and show as closed with **Open again**
([terminal.md](terminal.md), [known-limitations.md](known-limitations.md)).

**How a payload installs.** The signed bundle is unpacked into
`~/.config/Claudio/data/app/<version>/` (`$XDG_CONFIG_HOME` respected), with `state.json` beside the
versions. That path is inside the data folder the guard protects from agents, and it survives an
AppImage swap, an apt upgrade and a switch between the two. The shell runs the same state machine as
the Docker launcher (`packages/core/src/launcher/machine.ts`) around the server child:

1. At **every boot** it verifies the bundle's Ed25519 signature and every file's sha256 against the
   public keys in `<resources>/keys`, and never boots anything older than the payload bundled in the
   shell or than the running one.
2. The server exits 75 to ask for a restart; the shell starts it again from the new bundle and the
   window goes back to the page it was on.
3. The new bundle is a *trial*. It is kept only when `/api/health` answers **and** the web page tells
   the shell it rendered (`claudio:page-ready`) within 30 s of the window starting to load it. After
   two failed trials it is marked bad, never offered again, and the app goes back to the previous
   bundle, then to the payload bundled in the shell. The server writes an audit row for the rollback
   and the card says "Claudio X did not start, so the app went back to Y".

To recover without the page, use Help → **Use the bundled Claudio (X)** (shown while an overlay
runs), or start the app once with `CLAUDIO_PAYLOAD=bundled`, which ignores overlays.

The page cannot update the payload by itself, because the desktop runs without a token by default.
It asks the shell over IPC (`claudio:payload`), and the shell calls the server's update routes with
its per-launch desktop credential. The server accepts that credential for exactly the four update
writes, and only when the shell started it (`CLAUDIO_LAUNCHER=desktop`); chat tokens, read-only mode
and the anonymous local actor stay refused, so an agent's `curl` to `127.0.0.1` cannot restart the
server over live work.

**The shell, by package.** Whichever package you installed, the app **never asks for elevation**:
no `pkexec`, no password dialog, no `dpkg` under the running app.

- **AppImage.** The update replaces the AppImage file in place and restarts the app. Before it
  installs, the shell checks the download again against the signed desktop manifest (a listed key,
  the version, no downgrade, and size, sha256 and sha512). `install.sh` installs it as
  `~/.local/share/claudio/Claudio.AppImage`, a name with no version in it, so the menu entry keeps
  working. A copy you downloaded by hand as `Claudio-<version>-x86_64.AppImage` is replaced by a file
  under the new version's name, so a launcher or a shortcut pointing at the old name has to be
  pointed at the new one.
- **`.deb` with the apt source** (`apt-managed`). The system's updater (Software Updater,
  `unattended-upgrades`, `apt upgrade`) installs the new version. The app downloads nothing for the
  shell; it only tells you a newer one is out. Once apt replaced the files, the app notices
  (it re-reads `<resources>/shell.json` every minute, when the window gets focus and when the folder
  changes), says "The system installed desktop app X", and offers **Restart Claudio**. Until you
  restart it, any restart of the server is upgraded to a full relaunch, because the binary on disk
  is no longer the one running.
- **`.deb` without the apt source** (installs from before the repository, or after you removed the
  source). The app downloads the `.deb`, checks it against the signed desktop manifest and shows one
  command to copy into a terminal. It copies the file to a root-owned path, checks its sha256 and only
  then hands apt that copy, so a process running as you cannot swap the package between the check and
  your `sudo`:

  ```
  /usr/bin/sudo /usr/bin/install -D -m 0644 -o root -g root -- '<cache file>' '/var/cache/claudio/claudio_<v>_amd64.deb' && echo '<sha256>  /var/cache/claudio/claudio_<v>_amd64.deb' | /usr/bin/sha256sum -c - && /usr/bin/sudo /usr/bin/apt install -- '/var/cache/claudio/claudio_<v>_amd64.deb'
  ```

  There is no `-y`: apt shows what it will change and asks. The new package registers the apt
  source, so you need this command **once**.

**Switch to the AppImage.** On a `.deb`, when the host lets the AppImage sandbox without root and FUSE
works, the card offers **Use the AppImage instead**. It downloads the AppImage, checks it against the
signed manifest, installs it at `install.sh`'s paths and restarts from it, so later updates need no
password. Your chats, settings, overlays, `~/Claudio/workspace` and `~/.claude` stay. The `.deb`
stays installed (removing it needs root), so the card shows `/usr/bin/sudo /usr/bin/apt remove
claudio`; until you run it, `/usr/bin/claudio` still starts the `.deb`. A `~/.local/bin/claudio` you
wrote yourself is left alone. On a host that restricts user namespaces the switch is not offered.

**When it says it cannot update itself** (`unsupported`), it gives one of three reasons, and links
the release page so you can install by hand:

| Reason | Message |
| --- | --- |
| A development build (`desktop:dev`) | Updates are off in a development build. |
| The AppImage cannot be written | The AppImage at *path* cannot be replaced: the file or its folder is not writable. |
| Neither an AppImage nor a `.deb` | This copy of Claudio was not installed from an AppImage or a .deb, so it cannot update itself. |

A copy is an AppImage when its runtime sets `APPIMAGE`, and a `.deb` when `resources/package-type`
(which electron-builder writes into the package) says `deb`, the same test electron-updater makes.
The app passes the answer to its server as `CLAUDIO_DISTRIBUTION`, and the facts about the shell
(`CLAUDIO_SHELL_VERSION`, `CLAUDIO_SHELL_INPUTS`, `CLAUDIO_SHELL_PACKAGE`, `CLAUDIO_SHELL_APT`),
which is how a browser pointed at this server tells the payload from the shell. A browser or a phone
on this server sees the Claudio zone, and for the shell only "The desktop app is updated on the
computer that runs it."

**How it is verified.** The payload and the desktop manifest carry Ed25519 signatures with a key id,
so a key rotation can overlap; an AppImage must match both `latest-linux.yml`'s sha512 and the signed
manifest; the apt repository is GPG-signed with a `Valid-Until`; and every artifact has a GitHub
build-provenance attestation. The table is in
[plans/unified-updates.md](plans/unified-updates.md#d7-verification-stronger-than-sha512). What the
updater does is logged to `desktop.log`.

**Migrating a 0.6.x `.deb`.** An install from before this mechanism takes the first release through its
old updater (one last `pkexec` password), or with `sudo apt install ./Claudio-<v>-amd64.deb`. The new
package registers the repository, and from then on apt handles the shell and the app handles the
payload.

## Where things live

| What | Path |
| --- | --- |
| Wrapper state (runs, orchestrations, `wrapper.db`) | `~/.config/Claudio/data` |
| Installed payloads and their `state.json` | `~/.config/Claudio/data/app/` |
| Logs | `~/.config/Claudio/logs/desktop.log` and `server.log` |
| Default working directory for runs | `~/Claudio/workspace` |
| Claude Code config and transcripts | `~/.claude` (the CLI's own, unchanged) |
| The record of the tunnel's Serve rule, while it exists | `~/.config/Claudio/data/tunnel/serve-rule.json` |
| "Open the tunnel when Claudio starts" | `~/.config/Claudio/data/tunnel-settings.json` |

`~/.config` is `$XDG_CONFIG_HOME` if you set it. The workspace can be moved by starting the app
with `CLAUDIO_WORKSPACE_DIR` set. Each run can still use any project directory.

The packaged app carries `guard.mjs` in `<resources>/server/`, beside `server.mjs`, and the server
finds it through `CLAUDIO_GUARD_ENTRY` ([guards.md](guards.md)). The AppImage is a read-only mount and
the `.deb` installs under a root-owned directory, so the agent cannot edit it. Guard files and per-run
scratch folders go under the data folder (`guards/`, `tmp/`). The guard, the public keys
(`<resources>/keys`) and `shell.json` are the shell's: an installed payload never carries them.

The **File** menu opens the data, workspace and logs folders (press `Alt` if the menu bar is
hidden). Each log is rotated when the app starts once it passes 5 MB, keeping the last three.

Only one instance runs at a time: opening the app again focuses the existing window.

## The terminal

Settings → Access & safety → Terminal opens your login shell in the app. With authentication off, the window counts as
this machine, so it works as soon as you turn it on; a phone needs the tunnel and a token. The server
forks the shell host from `<resources>/server/terminal-host.mjs`, run on Electron's own Node, and
loads `node-pty` from `<resources>/server/node_modules/node-pty` (a prebuilt binary: the build
compiles nothing).

While a terminal has focus, the menu leaves its keys to the shell: `Ctrl+W`, `Ctrl+R`,
`Ctrl+Shift+R` and `Ctrl+Shift+C/V` reach it. Reload is `F5` (`Shift+F5` forces it), closing the window
is `Alt+F4`, and DevTools in a dev run is `F12`. Shells outlive a reloaded window, not a restart of the
app.

**A terminal in its own window.** The panel's *Open in a window* button calls `window.open` on the web
app's `/terminal-window/:id` route. The main window's `setWindowOpenHandler` allows exactly that route on
the local server's origin and opens a native window titled *Terminal — <project>* with the same security
flags as the main window (`contextIsolation`, `sandbox`, no Node) and no preload (the bridge only drives
the main window); anything else still goes to the system browser. It shares the app's one instance and
closes with the main window. Full screen is the browser's Fullscreen API, which Electron allows inside
the window.

## Accounts

The app runs the CLI on the account you choose for each chat. The default account is whatever
`~/.claude` is signed in to; more accounts are added on the Accounts page (a sign-in in the browser, or a
token) and each one keeps its own config directory under `accounts/` in the app's data folder, which
the **File** menu opens. At a limit, work moves to another account and the turn is replayed in the
same chat; with none left it waits for the reset. See [[accounts.md]]. The app never calls claude-swap,
and the accounts in `~/.local/share/claude-swap` are never touched.

## Reaching it from a phone

The server listens on `127.0.0.1` only, so a phone cannot reach it directly. Settings → Access & safety → **Remote
access** serves it on your tailnet through Tailscale (`tailscale serve`): an HTTPS address on this
machine's tailnet name, `https://<machine>.<tailnet>.ts.net:8444`, and a QR code. The phone needs
the Tailscale app signed in to the same tailnet. Turn on a token in Settings → Access & safety first,
because the tunnel refuses to open without authentication. The tunnel reaches the port the server
actually bound to, and since the app keeps that port, "Open the tunnel when Claudio starts" keeps
working across launches. The address stays the same while the machine keeps its name.
[tunnel.md](tunnel.md) has the details, and `CLAUDIO_TUNNEL=off` in the app's environment turns the
tab off.

## The CLI is not detected

A launcher does not start the app from a login shell, so it would not see a `PATH` set up in your
shell profile (nvm, npm prefixes, `~/.local/bin`). To find the CLI the app builds the server's
`PATH` from, in order:

1. The `PATH` of your login shell, read with `$SHELL -ilc` (5 second timeout). The output is
   read between delimiters, so a banner printed by an rc file does not matter, and the shell runs
   with `CLAUDIO_SHELL_PATH_PROBE=1` set, which an rc file can test to skip prompts and plugins.
   When it cannot be read (no `$SHELL`, a timeout, a shell that does not start or one that prints
   no `PATH`) the app carries on with the next two.
2. The `PATH` the app itself was started with.
3. Install locations: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`,
   `~/.volta/bin`, the asdf and mise shims, pnpm's home, every nvm version (the one `nvm alias default`
   points at first, then the newest), Homebrew, nix, `/snap/bin`, `/usr/local/bin`, `/usr/bin` and `/bin`.

The commands are then looked up in those directories with the file system alone (an executable
file), without spawning `which`. The server does the same when it starts on its own (`pnpm dev`, a
service, the standalone bundle), so it finds what your terminal finds. Directories that do not exist are dropped. If the UI still says **Claude Code CLI not detected**:

1. Run `which claude` in a terminal. If that finds nothing, install the CLI first.
2. Check `~/.config/Claudio/logs/desktop.log`, and `server.log` for the server's own output.
3. If the CLI lives somewhere unusual, or your shell prints something that breaks non-interactive
   startup, launch the app from a terminal with the path set. The server inherits the environment:

   ```bash
   CLAUDE_BIN=/path/to/claude ./Claudio-<version>-x86_64.AppImage
   ```

   One variable does not get through: the server runs on Electron's own binary with
   `ELECTRON_RUN_AS_NODE=1`, and it removes that from its environment as it starts, so the chats
   and commands it runs — an Electron app among them — start as themselves rather than as Node.

Any variable from the [environment table](configuration.md#environment-variables), such as
`CLAUDIO_DEFAULT_PERMISSION_MODE`, can be set this way.

## Building from source

Needs Node 22+ and pnpm 10.

```bash
pnpm install
pnpm desktop:dev     # build the UI and the API bundle, then open Electron
pnpm desktop:dist    # AppImage and .deb
```

`desktop:dev` builds everything once and runs the shell against the repo's build output, with
DevTools in the View menu. It keeps its data in `~/.config/Claudio-dev`, apart from an installed
app. It does not watch for changes: rerun it after editing the UI or the API. For UI work,
`pnpm dev` and the browser are faster.

`pnpm --filter @claudio/desktop test` runs the shell's unit tests (the tray menu and tooltip, the
progress fraction, the event-stream reader, the title-bar options, the updater state machine and
when it can update, the payload machine around the server child, the desktop manifest check and the
switch to the AppImage), and the root `pnpm test` includes them. The Updates card's desktop branch is
covered in the browser by `e2e/specs/updates-desktop.spec.mjs`, which stands a fake
`claudioDesktop.updates` in for the preload (CI only). The package scripts and the apt round trip are
tested in `apps/desktop/test/packaging.test.ts` and `.github/workflows/desktop-smoke.yml`, inside
containers.

The web UI knows it is in the app through `window.claudioDesktop`, which the preload exposes with
`platform`, `version`, `setTitleBarTheme({ color, symbolColor })`, `onNavigate(listener)` and
`updates` (`state()`, `onState(listener)`, `download()`, `install({ whenIdle?, force? })`,
`payload(action)`, `switchState()`, `switchToAppImage({ force? })`, `pageReady()`), accepted only from
the local server's page like the title-bar colours. The web calls `pageReady()` once after its first
render; without it every new payload is rolled back. When it
exists, `<html>` carries `is-desktop` and `desktop-<platform>`: `.is-desktop .topbar` and
`.is-desktop .sidebar-head` are the drag region (`app-region: drag`, with links, buttons, inputs and
menus opted out), the top bar keeps clear of the window controls with `env(titlebar-area-x)` and
`env(titlebar-area-width)`, and `desktop-darwin` leaves room for the traffic lights. The main process
accepts `setTitleBarTheme` only from the local server's page and only as hex colours; the web sends
the theme's `--bg` and `--text` whenever the theme changes. The title-bar overlay is 54 px tall
because the top bar is (`--topbar-h`): change one and change the other.

`desktop:dist` writes `Claudio-<version>-x86_64.AppImage` and `Claudio-<version>-amd64.deb` to
`apps/desktop/release/`. The first run downloads Electron and the packaging tools from GitHub, so it
needs network access. The packaging is configured in `apps/desktop/electron-builder.yml`, which also ships the terminal host
and `node-pty` as `extraResources`. An `afterPack` hook (`apps/desktop/scripts/after-pack.mjs`) then clears group and other write
permission from the packed tree: files keep the builder's mode, and under umask 002 a group-writable
`guard.mjs` made the guards refuse to start any worker.

## How releases publish it

[release-please](https://github.com/googleapis/release-please) creates a draft GitHub release as
described in [CONTRIBUTING.md](../CONTRIBUTING.md#how-a-release-happens). The release workflow then
calls `.github/workflows/desktop.yml`, which builds on Ubuntu with `pnpm desktop:dist` and attaches
the AppImage, the `.deb` and `latest-linux.yml` — what an installed app's updater reads, listing both
packages with their SHA-512 — to that draft before it is published, together with the signed desktop
manifest (`claudio-desktop-<v>-linux-x64.json` and `.sig`, signed in the `release` environment, which
the owner approves). `apt-repo.yml` builds and signs the apt repository from the `.deb` in the same
run, and `release.yml` deploys it to Pages only after the release is published, so apt never offers a
version that is not public. electron-builder runs with
`--publish never`, so that workflow is the only thing that uploads, and there is no separate
`.blockmap` file: the AppImage's is embedded in the AppImage. Re-running it for a tag replaces
the files while the release is still a draft; a published release is immutable, so a rebuild of one
only keeps the packages as a run artifact.

**The first release and the release app.** The repository's history starts in Agentry, so
`release-please-config.json` sets `bootstrap-sha` to the fork point (`d1ee00514`) and the manifest
starts at `0.0.0`, with `initial-version` `0.1.0` (without it, a repository with no release yet starts at 1.0.0): the first release is `v0.1.0` and its changelog holds Claudio's commits only. The
release workflow uses a GitHub App token (`vars.RELEASE_APP_ID`, `secrets.RELEASE_APP_PRIVATE_KEY`)
when the app is configured, so the release pull request runs CI like any other; without it the
workflow falls back to `GITHUB_TOKEN`, releases still publish, and only that pull request's checks
must be started by hand. Before `v0.1.0` was published, `scripts/install.sh` had nothing to download;
every release since is listed in [CHANGELOG.md](../CHANGELOG.md).

You can also run the **Desktop** workflow by hand from the Actions tab. With no tag it only builds
and keeps the packages as the `claudio-linux` run artifact, which is a way to try a change before a
release.

## Related

[[plans/splash-eat-the-code.md]] · [[guards.md]] · [[deploy.md]] · [[status.md]] · [[decisions/requests-without-credential.md]] · [[plans/ui-redesign.md]] · [[plans/app-updates.md]] · [[plans/unified-updates.md]] · [[decisions/shell-payload-updates.md]] · [[decisions/apt-repository.md]] · [[updates.md]] · [[tunnel.md]]
