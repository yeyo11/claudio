---
created_at: 2026-11-16T19:40:00Z
updated_at: 2026-11-16T19:40:00Z
tags:
    - report
    - desktop
    - electron
    - wayland
    - daemon
---
# Report: the desktop window came back as garbage after a close (0.19.0)

The owner closed Claudio's window while a chat's subagent was running and opened Claudio again; the
window showed only a grid of small pink and red blocks and noisy coloured tiles over white. It
happened on two machines, both on the `.deb` of 0.19.0, and both also felt slow. Investigated
read-only on both; fixed in the desktop shell.

## Evidence

**Machines.** Both run GNOME Shell 50 on Wayland with hybrid graphics (Intel UHD 630 + GTX 1650, and
Intel Iris Xe + RTX 3050 Ti); Chromium's GPU process uses the Intel render node
(`--ozone-platform=wayland --render-node-override=/dev/dri/renderD128`). Electron 45.2.3, Chrome
156.0.8078.80. No `--disable-gpu*` switch; GPU compositing and rasterization are on.

**Timeline, first machine** (desktop log in UTC, journal and screenshot in local time, UTC+1):

| When | What |
| --- | --- |
| 20:01:45 | Electron main starts (gnome-shell scope `app-gnome-claudio-2717219`), GPU process with it |
| 19:01:47Z | `started the daemon (user unit claudio-daemon-1d3a7a4e45cd.service)`; server ready |
| (some time later) | the owner closes the window; the main process, the GPU process and the tray stay |
| 20:07:53 | a second launch from the dock (`app-gnome-claudio-2795831`) hits the single-instance lock and exits; the running process gets `second-instance` |
| 19:07:54Z | the same process creates a **new** `BrowserWindow`: `server ready at http://127.0.0.1:41985` logged a second time, with no daemon reconnection |
| 20:07:58 | the new window's renderer process starts (after the splash hand-off) |
| 20:08:05 | the owner's screenshot (`gnome-screenshot`): the page is garbage, the window controls drawn by Electron are fine |
| before 20:08:42 | the window renders again (the owner uploaded the screenshot from it) |

The second machine shows the same sequence: main and GPU process from 20:05:52, daemon
`claudio-daemon-9242d67dd03d.service` at 20:05:55, a dock launch at 20:07:18 that lived 361 ms, and a
new renderer at 20:07:23 under the same main and GPU process.

**Processes now**, on both: one Electron main, one GPU process, one utility, one renderer, the daemon
and its server; one window, one instance. Process start times confirm the main and GPU process
outlived the first window. The journal has no GPU error at the reopen (only the usual
`vaInitialize failed` at start). Before 0.19.0, `window-all-closed` quit the app, so every window was
the first one of a fresh process.

## Cause

0.19.0 (t6 of [plans/survive-restarts.md](../plans/survive-restarts.md)) keeps the Electron process
alive for the tray when the window closes, and reopening created a second main window inside that
process, served by the GPU process that had served the first one. That path was new in 0.19.0, and
it is the only thing that differs between the reopen that failed and every start that worked. The
picture is web-content tiles showing memory nobody had drawn into yet: per-tile blocks, while the
window controls, which Electron draws itself, stayed fine.

What we could not do is make it happen on purpose. A minimal Electron 45.2.3 app and the real
desktop build, closed and reopened inside an isolated headless GNOME Shell on the same GPU, captured
a clean page each time (`webContents.capturePage`). That capture reads the renderer's frame and not
the buffer the compositor shows, so it cannot tell. No Electron or Chromium issue with this symptom
turned up (searched for garbled, corrupted, glitch and artifacts with Wayland and reopen).

## Slowness

No loop came from t6. The daemon log has four lines on each machine (start, hand-over, payload,
ready); the server was not restarted; one `/api/events` stream per page load, no reconnect storm, no
renderer reload loop. The renderer took 10 to 47 % of a core and the GPU process 1 to 39 % while a
chat was running, close to what 0.18 spent (the shell's scope used 1 h 44 min of CPU over 7 h 13 min on
the second machine). Both machines were loaded at the time (load average 28 on 12 threads on the
first, from agents' test suites; a Rust test at 1150 % on the second). The garbled seconds read as a
stall too.

## Fix

A closed window never comes back in the same process. Showing the window after it was closed (a
second launch, the tray's **Open Claudio** or one of its items) relaunches the desktop process as an
update does: the window side leaves (`shutdown('leave')`, the daemon and its work untouched), a new
process takes the lock and the tray, attaches to the running daemon and opens the page asked for,
which travels as `--claudio-open=<path>` and is checked as an in-app path. The AppImage is started
again from its file, since its mount goes with the process. The rule is in
`apps/desktop/src/window-lifecycle.ts` (`reopenPlan`, `relaunchArgs`, `openPathFromArgv`) with tests
in `apps/desktop/test/window-lifecycle.test.ts`. The quit question and the restart dialogs no
longer open a window to ask: with the window closed they use the native dialog.

Checked in the isolated compositor with the real build: close, second launch, relaunch, attach (the
log shows `opening the window again in a new process`, `quitting for a restart`, `attaching to the
running daemon`), the same daemon unit throughout, and a start with `--claudio-open=/settings/general`
lands on that page.

## Workaround on 0.19.0

Do not reopen into the old process: quit Claudio from the tray (**Quit Claudio**, then **Keep working
in the background**) and start it again. The new process attaches to the daemon and nothing running
stops. A window already showing garbage recovers the same way.

## Related

[[desktop.md]] · [[plans/survive-restarts.md]]
