---
created_at: 2026-10-15T17:46:01Z
updated_at: 2026-10-15T17:46:01Z
tags:
    - research
    - terminal
    - pty
    - websocket
    - security
    - packaging
---
# Terminal facts spike (t0)

Task `t0` of [plans/terminal.md](../plans/terminal.md) §7: the facts the terminal's design rests on,
each one measured with a command, before any product code. No product code changed. Facts that
contradict the plan have been corrected in the plan itself (its "Facts from t0" block and the
sections they touch).

Run on 2026-10-15, on Ubuntu 26.04.1 (glibc 2.43, kernel 7.0.0), Node v22.21.1, pnpm 10.17.1,
Electron 44.5.1 (the version in `apps/desktop`), Docker 29.8.2 with `node:26-bookworm-slim`
(Node v26.12.0, Debian 12.15, glibc 2.36), Chrome 154, Firefox 158 and Playwright's WebKit 27.2.
The scripts lived in a scratch directory outside the repo (`/tmp/t0-scripts`, packages installed in
their own `/tmp/t0-*` directories); the ones the next tasks can reuse are in the appendix.

## Decisions

| Question | Answer |
|---|---|
| Which PTY package | **`node-pty` `1.2.0-beta.15`, exact pin**: Microsoft's own package, the release on its `beta` dist-tag (2026-08-03). It ships a Linux x64 prebuild (glibc ≥ 2.28), so nothing compiles anywhere: no toolchain in the Docker build stage, `npmRebuild: false` stays, no `@electron/rebuild`, and pnpm need not run its install script. Its PTY child closes every inherited descriptor before `exec`, so shells do not hold each other's masters and **no patch** is needed. Rejected: `1.1.0` (no Linux prebuild, and shells inherit masters, so it needs the patch below and a compiler in every distribution); `@lydell/node-pty` (a third party's repackaging of the same beta, with the same descriptor behaviour) |
| Which xterm line | **6.0.0** (stable since 2025-12-22) for the view and the host: `@xterm/xterm` and `@xterm/headless` `6.0.0`, `@xterm/addon-serialize` `0.14.0`, `-unicode11` `0.9.0`, `-fit` `0.11.0`, `-webgl` `0.19.0`, `-search` `0.16.0`, `-web-links` `0.12.0`, all published together, all exact pins. 5.5.0 works as well (same results below), but it is 2½ years old and its `addon-serialize` 0.13 peer-depends on `@xterm/xterm` ^5, which `packages/core` does not have |
| The `FD_CLOEXEC` patch | **Not needed** with the beta. The patch for `1.1.0` was written and proved (§3), and stays here in case the pin has to fall back |
| CSP | `connect-src 'self'` stays as it is |

## 1. `node-pty` loads, and where

### 1.1 What each version ships

```
$ npm view node-pty dist-tags --json        →  "latest": "1.1.0", "beta": "1.2.0-beta.15"
$ ls node_modules/node-pty/prebuilds        (1.1.0)
darwin-arm64  darwin-x64  win32-arm64  win32-x64
$ ls node_modules/node-pty/prebuilds        (1.2.0-beta.15)
darwin-arm64  darwin-x64  linux-arm64  linux-x64  win32-arm64  win32-x64
```

`1.1.0` has **no Linux prebuild**: its `install` script (`node scripts/prebuild.js || node-gyp
rebuild`) compiles it. Under pnpm 10 that script does not run unless the package is listed in
`onlyBuiltDependencies` (today `electron` and `esbuild` only), so `1.1.0` would install with **no
binary at all**. The beta loads with the script skipped:

```
$ pnpm add node-pty@1.2.0-beta.15
│   Ignored build scripts: node-pty.
$ node load-buffer.cjs /tmp/t0-pnpm
node v22.21.1 abi 127 napi 10 electron -
loaded node-pty 1.2.0-beta.15
data types: Buffer bytes: 68c3a96c6c6f0d0a exit: {"exitCode":3,"signal":0}
```

(t2 should add `node-pty` to `ignoredBuiltDependencies` in `pnpm-workspace.yaml` to silence the
warning; nothing needs to build.)

### 1.2 glibc floor

```
$ objdump -T prebuilds/linux-x64/pty.node | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1    (beta)
GLIBC_2.28
$ objdump -T build/Release/pty.node | grep -E 'GLIBC_2\.(3[3-9]|4[0-9])'    (1.1.0 built on this machine)
(GLIBC_2.42) cfsetospeed   (GLIBC_2.34) openpty   (GLIBC_2.42) cfsetispeed   (GLIBC_2.34) forkpty
```

A binary compiled on the build machine inherits that machine's glibc. `1.1.0` built on this
Ubuntu 26.04 **does not load** in the Docker image:

```
$ docker run --rm -v …/server:/app:ro node:26-bookworm-slim node -e 'require("/app/node_modules/node-pty/build/Release/pty.node")'
/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.42' not found (required by /app/node_modules/node-pty/build/Release/pty.node)
```

The same applies to the AppImage: compiled on a recent runner, it would stop running on older
distributions. The beta's 2.28 floor is below Debian 12 (2.36) and any current desktop distribution.

**node-pty hides the real load error.** Its loader tries `build/Release`, `build/Debug` and
`prebuilds/<platform>-<arch>`, and throws only the *last* error:

```
pty-missing: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64: Error: Cannot find module './prebuilds/linux-x64//pty.node'
```

The glibc error above only shows when `pty.node` is required directly. The host's loader (t2) should,
on failure, also try `require()` on the `.node` file it expects and log that error in the
`pty-missing` reason.

### 1.3 Node 22 (dev), Electron's Node, the Docker image

Each run spawns `bash -c 'printf "h\xc3\xa9llo\n"; exit 3'` through `pty.spawn(…, { encoding: null })`
and prints the type of every `onData` chunk ([appendix A.1](#a1-load-and-buffer-check)):

| Runtime | Command | Output |
|---|---|---|
| Node 22, beta | `node load-buffer.cjs /tmp/t0-pnpm` | `node v22.21.1 abi 127 napi 10` · `loaded node-pty 1.2.0-beta.15` · `data types: Buffer bytes: 68c3a96c6c6f0d0a exit: {"exitCode":3,"signal":0}` |
| Electron 44.5.1 as Node, beta | `ELECTRON_RUN_AS_NODE=1 …/electron/dist/electron load-buffer.cjs /tmp/t0-pnpm` | `node v24.21.0 abi 149 napi 10 electron 44.5.1` · `loaded node-pty 1.2.0-beta.15` · `data types: Buffer …` same bytes, exit 3 |
| `node:26-bookworm-slim` as `node`, beta | `docker run --rm -u node -v /tmp/t0-pnpm:/w:ro node:26-bookworm-slim node /scripts/load-buffer.cjs /w` | `node v26.12.0 abi 147 napi 10` · `loaded node-pty 1.2.0-beta.15` · `data types: Buffer …` same bytes, exit 3 |
| Node 22, 1.1.0 (built here) | `node load-buffer.cjs /tmp/t0-spike` | `loaded node-pty 1.1.0` · `data types: Buffer …` same bytes, exit 3 |
| Electron 44.5.1, 1.1.0 (the Node 22 build) | `ELECTRON_RUN_AS_NODE=1 …/electron load-buffer.cjs /tmp/t0-spike` | `loaded node-pty 1.1.0` · `data types: Buffer …` same bytes, exit 3 |
| bookworm, 1.1.0, no toolchain | `npm install node-pty@1.1.0` in the bare image | `npm exit=1` · `gyp ERR! find Python … checking if "python3" can be used` |
| bookworm, 1.1.0, `apt-get install python3 make g++` | same, then `load-buffer.cjs` | `npm exit=0` · `loaded node-pty 1.1.0` · `data types: Buffer …` · binary floor `GLIBC_2.34` |

N-API holds: one binary serves Node 22 (ABI 127), Electron's Node 24 (ABI 149) and Node 26
(ABI 147). The slim image has no `python3`, `make` or `g++`, which is why `1.1.0` would need them in
the build stage.

### 1.4 `encoding: null` hands `Buffer`s

Every row above prints `data types: Buffer`, and the bytes are the raw UTF-8 (`c3 a9` for `é`): no
decoding in the PTY layer, so a multi-byte character cut at a chunk edge stays bytes. The typings
disagree: `onData` is declared `IEvent<string>` in both versions, so t2 needs one cast at the
boundary. `write()` accepts `string | Buffer` in both.

### 1.5 `pause()` blocks the producer

```
$ node pause.cjs /tmp/t0-pnpm          (spawns `yes`, pauses, waits 1 s, resumes)
flowing: 903807 bytes in 300 ms; paused 1 s: +0 bytes, yes used 0 cpu ticks, state S (S = sleeping, blocked on write)
resumed 300 ms: +1567966 bytes
```

Same with `1.1.0`. The watermarks of plan §2.7 work as planned: a paused PTY stops the program in the kernel.

### 1.6 The packaged layout, read-only

What the host needs of `node-pty` at run time is three things: `package.json`, `lib/`, and the one
binary (`prebuilds/linux-x64/pty.node` for the beta, `build/Release/pty.node` for a build): **172 KiB**
for the beta, against 26 MiB for the whole installed package (every platform's prebuilds and the
sources). `node-addon-api` is a build-time dependency only. On Linux there is no `spawn-helper`.

A host bundled the way `apps/api/scripts/bundle.mjs` bundles (esbuild 0.28.2, `platform: 'node'`,
`format: 'esm'`, `external: ['node-pty']`, the same `createRequire` banner) from a stand-in
`host.ts` that imports `@xterm/headless`, `-serialize` and `-unicode11` and loads `node-pty` with
`createRequire(import.meta.url)`:

```
$ node bundle-host.mjs …/esbuild host.ts out/terminal-host.mjs …
out/terminal-host.mjs 394326 bytes; inputs: @xterm/headless/lib-headless/xterm-headless.js, @xterm/addon-serialize/lib/addon-serialize.js, @xterm/addon-unicode11/lib/addon-unicode11.js, host.ts
$ node out/terminal-host.mjs                                  (node_modules/node-pty beside it)
snapshot "\u001b[32;1mgreen\u001b[0m ok\u001b[1B\u001b[8D"
$ ELECTRON_RUN_AS_NODE=1 …/electron out/terminal-host.mjs
snapshot "\u001b[32;1mgreen\u001b[0m ok\u001b[1B\u001b[8D"
$ node out/terminal-host.mjs                                  (node_modules moved away)
pty-missing Cannot find module 'node-pty'
exit=2
```

`createRequire(import.meta.url)` resolves `node-pty` from the bundle's own directory, so
`<resources>/server/node_modules/node-pty` and `/app/node_modules/node-pty` both work. The headless
screen adds about 390 KB to the host bundle.

**An AppImage stand-in.** `pnpm desktop:dist` was not run (the integrator runs it). Instead an
AppImage was assembled from the real AppImage runtime (the first 188 392 bytes of an existing
electron-builder AppImage on this machine, `--appimage-offset`) and a squashfs (`mksquashfs`) holding
Electron 44.5.1's `dist/` renamed `claudio`, `resources/server/terminal-host.mjs` (the bundle above)
and the 172 KiB `node-pty`, with an `AppRun` that runs the host as the desktop shell runs
`server.mjs` (`ELECTRON_RUN_AS_NODE=1 "$APPDIR/claudio" "$APPDIR/resources/server/terminal-host.mjs"`):

```
$ ./Claudio-t0.AppImage
APPDIR=/tmp/.mount_ClaudiAQMxZ5 APPIMAGE=/tmp/t0-fakeapp/Claudio-t0.AppImage
Claudio-t0.AppImage /tmp/.mount_ClaudiAQMxZ5 fuse.Claudio-t0.AppImage ro,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0
snapshot "\u001b[32;1mgreen\u001b[0m ok\u001b[1B\u001b[8D"
exit=0
```

So `pty.node` loads from the read-only, `nosuid,nodev` FUSE mount, on the packaged Electron, from the
path electron-builder's `extraResources` would put it at. **To verify by the integrator** on the
real build, after t5: see [§9](#9-to-verify-by-the-integrator).

The same layout also ran read-only from a plain directory (`chmod -R a-w`) on Node 22 and Electron,
and from `docker run -u node -v …/server:/app:ro node:26-bookworm-slim node /app/terminal-host.mjs`:
`output "ok-from-pty\r\n" isBuffer true exit {"exitCode":0,"signal":0}`.

**pnpm's store.** In the workspace, `node_modules/node-pty` is a symlink into `.pnpm/`. t5 should
stage the three needed paths, dereferenced, into `apps/api/dist/node_modules/node-pty` from the
bundle script, so `electron-builder.yml` picks them up with the existing `from: ../api/dist` entry
(its comment already says app-builder cannot walk pnpm's symlinks) and the Dockerfile copies one
plain directory.

## 2. Masters: does one shell hold another's?

Two shells spawned from one process, as the host does, then `ls -l /proc/<pid>/fd` of the second and
of an ordinary `child_process` started afterwards ([appendix A.2](#a2-descriptor-check)):

**`1.1.0`: yes.**

```
$ node fd-leak.cjs /tmp/t0-spike
host pid 803306 pty A 803313 /dev/pts/1 pty B 803316 /dev/pts/2
host ptmx fds: 20->/dev/ptmx 22->/dev/ptmx | 20 flags:	0104002 ; 22 flags:	0104002
shell A fds: 0->/dev/pts/1 1->/dev/pts/1 2->/dev/pts/1
shell B fds: 0->/dev/pts/2 1->/dev/pts/2 2->/dev/pts/2 20->/dev/ptmx
$ ls -l /proc/803316/fd
lrwx------ 1 yeyo yeyo 64 Oct 15 19:31 0 -> /dev/pts/2
lrwx------ 1 yeyo yeyo 64 Oct 15 19:31 1 -> /dev/pts/2
lrwx------ 1 yeyo yeyo 64 Oct 15 19:31 2 -> /dev/pts/2
lrwx------ 1 yeyo yeyo 64 Oct 15 19:31 20 -> /dev/ptmx
child_process.execFileSync child fds:
lrwx------  1 yeyo yeyo 64 Oct 15 19:31 20 -> /dev/ptmx
lrwx------  1 yeyo yeyo 64 Oct 15 19:31 22 -> /dev/ptmx
```

Flags `0104002` are `O_RDWR | O_NONBLOCK | O_LARGEFILE`, without `O_CLOEXEC` (`02000000`). Shell B
holds A's master, writable, and so does every later child of the process that owns the PTYs.

**`1.2.0-beta.15`: no, for shells.** Its child runs `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)`
(falling back to marking fds 3 and up) before `exec`:

```
$ node fd-leak.cjs /tmp/t0-pnpm            (and the same under ELECTRON_RUN_AS_NODE and in the bookworm image)
host ptmx fds: 20->/dev/ptmx 22->/dev/ptmx | 20 flags:	0104002 ; 22 flags:	0104002
shell A fds: 0->/dev/pts/1 1->/dev/pts/1 2->/dev/pts/1
shell B fds: 0->/dev/pts/2 1->/dev/pts/2 2->/dev/pts/2
child_process.execFileSync child fds:
lrwx------  1 yeyo yeyo 64 Oct 15 19:31 20 -> /dev/ptmx
lrwx------  1 yeyo yeyo 64 Oct 15 19:31 22 -> /dev/ptmx
```

The masters themselves are still not close-on-exec in the parent, so a `child_process` started by the
host would inherit all of them. **Rule for t2: the host process never uses `child_process`** (no
`exec`, `execFile`, `spawn`), only `node-pty`. `processes.ts` reads `/proc` and spawns nothing, so
reusing `processTable()` / `descendantsOf()` / `terminateTree()` in the host is safe. The API process
never holds a master at all, which is the point of the host (plan §2.1).

In the Docker image the master reads `/dev/pts/ptmx`, not `/dev/ptmx`
(`17->/dev/pts/ptmx 19->/dev/pts/ptmx`): the plan's §6.1 descriptor test must match both.

`@lydell/node-pty@1.2.0-beta.15` behaves exactly like the upstream beta (shell B clean, a
`child_process` child holds both masters).

## 3. The `FD_CLOEXEC` patch for `1.1.0` (fallback only)

Not applied, because the pin is the beta. If the pin ever has to go back to `1.1.0`, this is the
patch, as a `pnpm patch` of `node-pty@1.1.0`:

```diff
--- a/src/unix/pty.cc
+++ b/src/unix/pty.cc
@@ -445,6 +445,11 @@
       if (pty_nonblock(master) == -1) {
         throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
       }
+      // forkpty(3) opens the master without O_CLOEXEC: every process spawned later would
+      // inherit it and keep this terminal's PTY alive, with a writable handle on it.
+      if (fcntl(master, F_SETFD, fcntl(master, F_GETFD) | FD_CLOEXEC) == -1) {
+        throw Napi::Error::New(napiEnv, "Could not set master fd to close-on-exec.");
+      }
   }
 #endif
```

Rebuilt with `node-gyp rebuild` and run again:

```
$ node fd-leak.cjs /tmp/t0-patched
host ptmx fds: 20->/dev/ptmx 22->/dev/ptmx | 20 flags:	02104002 ; 22 flags:	02104002
shell A fds: 0->/dev/pts/1 1->/dev/pts/1 2->/dev/pts/1
shell B fds: 0->/dev/pts/2 1->/dev/pts/2 2->/dev/pts/2
child_process.execFileSync child fds:
lrwx------+ 1 yeyo yeyo 64 Oct 15 19:32 0 -> socket:[136261264]
lrwx------+ 1 yeyo yeyo 64 Oct 15 19:32 1 -> socket:[136261266]
lrwx------+ 1 yeyo yeyo 64 Oct 15 19:32 2 -> socket:[136261268]
```

The patch is stronger than the beta (no child of any kind inherits a master), but costs a compiler in
every distribution and the glibc floor of §1.2. The fork happens on the JS thread between `forkpty`
and `fcntl`, so no other fork can slip in between. The fallback path, in full: add `node-pty` to
`onlyBuiltDependencies`, `pnpm patch node-pty@1.1.0`, `python3 make g++` in the Dockerfile's build
stage, and compile the desktop's copy in an old-glibc container in CI.

## 4. xterm: headless, serialize, unicode11

[Appendix A.3](#a3-headless-screen-check) writes 20 coloured lines with `é` and `👍` into a 40 × 6
headless screen, switches to the alternate screen, serializes, replays into a second screen and
compares:

```
$ node headless.mjs /tmp/t0-spike
headless 6.0.0 serialize 0.14.0 unicode11 0.9.0
unicode version 11 snapshot bytes 671 has alt-screen switch true
restored: same active buffer true type alternate cursor 15 2 -> 15 2
normal buffer after leaving alt: same true lines 21 21
half sequence: original row "before RED" replayed without tail "before 1mRED"
serialize scrollback 1000: 112212 bytes
serialize scrollback 500: 58212 bytes
serialize scrollback 250: 31212 bytes
serialize scrollback 100: 15012 bytes
serialize scrollback 0: 4220 bytes
rss MiB after 3 screens 73
```

5.5.0 / 0.13.0 / 0.8.0 print the same lines (`rss MiB after 3 screens 71`); its `npm install`
pulled `@xterm/xterm` 5 in as a peer of `addon-serialize` 0.13. The 6.0 addons have no peer
dependency.

What this confirms for plan §2.5 and §2.6:

- The snapshot restores the alternate screen, the buffer under it and the cursor.
- **The unfinished tail is real**: a sequence cut in half at the snapshot instant (`ESC[1;3` |
  `1m`) is lost by the serializer, and the live bytes that follow print as text (`1mRED`). The host
  has to keep and resend the bytes since the parser was last in ground state, as the plan says.
- Snapshot size on a 120-column screen of full lines: about 112 bytes per line, so 1 000 lines are
  110 KiB. The 512 KiB budget holds about 4 500 such lines; the step-down only matters for heavily
  coloured output.

Packaging notes:

- `@xterm/headless` 6.0.0 declares `"module": "lib/xterm.mjs"`, a file the package does not contain
  (it has `lib-headless/xterm-headless.{js,mjs}`). esbuild with `platform: 'node'` reads `main` first
  and bundles fine (§1.6); a bundler that prefers `module` would fail. Import it only from the host.
  `@xterm/xterm` 6.0.0's `module` (`lib/xterm.mjs`) does exist, so Vite is fine.
- 6.0 has no canvas renderer: `@xterm/addon-canvas` ends at 0.7.0 with a peer of `@xterm/xterm`
  ^5. The plan already falls back to the DOM renderer, not canvas.
- All seven 6.0 packages and `node-pty` 1.1.0 were published on 2025-12-22.

## 5. The host's IPC channel

`fork()` with `serialization: 'advanced'`, the child started with only what it is given in `env`
([appendix A.4](#a4-ipc-check)):

```
$ node ipc-buffer.cjs
runtime node v22.21.1 | host env keys: []
received: Buffer Buffer.isBuffer true hex c3a9
64 MiB in 64 KiB messages: 67108864 bytes in 206 ms
$ ELECTRON_RUN_AS_NODE=1 …/electron ipc-buffer.cjs
runtime electron 44.5.1 | host env keys: ["ELECTRON_RUN_AS_NODE"]
received: Buffer Buffer.isBuffer true hex c3a9
64 MiB in 64 KiB messages: 67108864 bytes in 353 ms
```

A `Buffer` arrives as a `Buffer` (Node's advanced serializer keeps the type), at 180–300 MiB/s,
far above what a PTY produces. Under Electron the host's own environment holds
`ELECTRON_RUN_AS_NODE`, which is why `env.ts` must build each shell's environment from the server's,
never from the host's `process.env`.

## 6. WebSocket: Fastify, the hook, Vite

Fastify 5.12.5 (the lockfile's), `@fastify/websocket` 11.3.4 (`ws` 8.22.0), Vite 8.3.2, with a global
`onRequest` hook as `security.ts` registers it on the root instance ([appendix A.5](#a5-websocket-check)):

```
$ FIX=1 node ws-facts.mjs /tmp/t0-ws
fastify 5.12.5 @fastify/websocket 11.3.4 ws 8.22.0 vite 8.3.2
1 direct, allowed: {"result":"open","seenByApi":{"host":"127.0.0.1:42789","origin":"http://127.0.0.1:42789","peer":"127.0.0.1","xff":null,"forwarded":null},"binaryEcho":true,"echo":"c3a90d"}
  order: onRequest(upgrade:websocket) -> handler | url seen by hook: /api/terminals/term_x/socket?ticket=abc
2 direct, onRequest replies 401: {"result":"HTTP 401","body":"{\"error\":\"denied by onRequest\"}"}
  handler reached: false
3 direct, foreign Origin refused in onRequest: {"result":"HTTP 403","body":"{\"error\":\"origin\",\"origin\":\"https://evil.example\",\"host\":\"127.0.0.1:42789\"}"}
4 via Vite proxy ws:true, changeOrigin:true: {"result":"open","seenByApi":{"host":"localhost:42789","origin":"http://127.0.0.1:37637","peer":"127.0.0.1","xff":null,"forwarded":null},"binaryEcho":true,"echo":"c3a90d"}
5 via Vite proxy ws:true, Origin = <scheme>://<Host> check: {"result":"HTTP 403","body":"{\"error\":\"origin\",\"origin\":\"http://127.0.0.1:37637\",\"host\":\"localhost:42789\"}"}
6 via Vite proxy ws:false: {"result":"timeout"}
  (vite servers closed)
  dial for 7: open
7 app.close() with an open socket: app.close resolved | client close code 1005 after 2 ms
```

- **The upgrade goes through `onRequest`** before the handshake, with the full URL (query
  included, so the logger redaction of plan §3.6 is needed) and `upgrade: websocket`. A reply from the
  hook (401, 403) refuses the upgrade and the route's handler never runs. Binary frames round-trip
  as binary.
- **Vite needs `ws: true`.** Without it the upgrade neither fails nor succeeds: the client waits
  (case 6, a 3 s timeout).
- **Vite's `changeOrigin: true` breaks the Origin check and defeats "this machine only".** It
  rewrites `Host` to the target (`localhost:8797`) and leaves `Origin` as the page's
  (`http://localhost:5181`), so plan §3.7's Origin check refuses every dev socket (case 5). Worse, a LAN
  device reaching a dev server started with `--host` would arrive with a loopback peer, a loopback
  `Host` and no forwarding header: it would pass `fromLocalMachineStrict()`. With
  `changeOrigin: false` the API sees Vite's own `Host`, the Origin matches and a LAN address stays
  a LAN address:

  ```
  $ CHANGE_ORIGIN=false FIX=1 node ws-facts.mjs /tmp/t0-ws
  4 …: {"result":"open","seenByApi":{"host":"127.0.0.1:46473","origin":"http://127.0.0.1:46473","peer":"127.0.0.1","xff":null,"forwarded":null},…}
  5 … Origin = <scheme>://<Host> check: {"result":"open",…}
  ```

  So t5 adds a proxy entry for the socket, **before** `/api`:
  `'^/api/terminals/[^/]+/socket': { target: API_TARGET, ws: true, changeOrigin: false }`.
- **A refused upgrade leaves its socket open, and `app.close()` then never resolves.** Node stops
  tracking a socket once it has emitted `upgrade`, so `forceCloseConnections` does not reach it, and
  the HTTP server allows half-open sockets, so even a client that hangs up leaves it there. Without
  the fix, after cases 2 and 3:

  ```
  $ NOVITE=1 node ws-facts.mjs /tmp/t0-ws           (NOVITE skips cases 4–6)
  7 app.close() with an open socket: app.close still pending after 5 s | client close code 1005 after 5003 ms
  $ NOVITE=1 SKIP23=1 node ws-facts.mjs /tmp/t0-ws  (no refused upgrade)
  7 app.close() with an open socket: app.close resolved | client close code 1005 after 3 ms
  ```

  The fix (`FIX=1`): when a request carries `Upgrade` and gets an HTTP answer, destroy its socket
  once the answer is written: `reply.raw.once('finish', () => req.raw.socket.destroy())`. t3 must do
  this for **every** HTTP answer to an upgrade (the guard's 401/405/421, the gate's 403/409, a 404),
  so it belongs in one `onRequest` hook registered first, and a test should close the app after a
  refused upgrade. Accepted sockets are fine: `@fastify/websocket` closes them on `app.close()`
  (alone: `app.close() resolved after 5 ms; client saw close 1005`, with or without
  `forceCloseConnections`). The client sees 1005 (no status), not 1001.

## 7. CSP: `connect-src 'self'` and same-origin WebSockets

A page served with Claudio's exact CSP (copied from `app.ts`, the script as a same-origin file) opens
a WebSocket by absolute URL, by relative URL (`new WebSocket('/ws')`), and to another port, which the
CSP must block ([appendix A.6](#a6-csp-check)):

| Browser | Command | Same-origin absolute | Relative `/ws` | Other port |
|---|---|---|---|---|
| Chrome 154 (headless), `http:` | `google-chrome --headless=new --user-data-dir=… http://127.0.0.1:18931/` | `open ws://127.0.0.1:18931/ws` | `open ws://127.0.0.1:18931/ws` | `error`, violation `connect-src ws://127.0.0.1:18932/ws` |
| Firefox 158 (headless), `http:` | `firefox --headless --new-instance --profile … http://127.0.0.1:18941/` | `open ws://127.0.0.1:18941/ws` | `open ws://127.0.0.1:18941/ws` | `threw NS_ERROR_CONTENT_BLOCKED`, violation `connect-src ws://127.0.0.1:18942/ws` |
| WebKit 27.2 (Playwright), `http:` | `node webkit-open.cjs … http://127.0.0.1:18951/` | `open ws://127.0.0.1:18951/ws` | `open ws://127.0.0.1:18951/ws` | `threw SecurityError: The operation is insecure.`; console: `Refused to connect to ws://127.0.0.1:18952/ws because it does not appear in the connect-src directive` |
| Chrome 154, `https:` (self-signed) | same, `--ignore-certificate-errors`, `https://127.0.0.1:18961/` | `open wss://127.0.0.1:18961/ws` | `open wss://127.0.0.1:18961/ws` | `error`, violation `connect-src wss://127.0.0.1:18962/ws` |
| WebKit 27.2, `https:` | same, `ignoreHTTPSErrors`, `https://127.0.0.1:18971/` | `open wss://127.0.0.1:18971/ws` | `open wss://127.0.0.1:18971/ws` | `threw SecurityError` |

The server logged the two same-origin connections and none on the other port in every run.
`connect-src 'self'` covers same-origin `ws:` from `http:` and `wss:` from `https:` (the tunnel) in all
three engines, and still blocks other origins. The relative URL works in all three, so the view can
write `new WebSocket(\`/api/terminals/${id}/socket?ticket=…\`)` with no scheme logic. **iOS Safari on
a real phone was not available**: WebKit 27.2 shares Safari's WebCore CSP code, which makes a failure
unlikely; the owner's check is in §9.

## 8. Peer lookup through `/proc/net/tcp`

From the server side of a loopback connection: find the client's `ip:port` as a *local* address in
`/proc/net/tcp` (IPv4) or `/proc/net/tcp6`, take the socket inode, find the pid holding
`socket:[inode]` under `/proc/*/fd`. The client is a child process, so the right answer is known
([appendix A.7](#a7-peer-lookup)):

```
$ node peer.mjs                              (this desktop, 416 processes, as uid 1000)
uid 1000 kernel 7.0.0-38-generic
listen 127.0.0.1 <- connect 127.0.0.1: remote 127.0.0.1:33772 -> /proc/net/tcp inode 136296698 -> pid 812840 (child 812840, match true) in 41.2 ms, /proc/<pid>/fd unreadable for 247 pids
listen ::1 <- connect ::1: remote ::1:39528 -> /proc/net/tcp6 inode 136294666 -> pid 812847 (child 812847, match true) in 29.9 ms, /proc/<pid>/fd unreadable for 247 pids
listen :: <- connect 127.0.0.1: remote ::ffff:127.0.0.1:57072 -> /proc/net/tcp inode 136294677 -> pid 812854 (child 812854, match true) in 36.7 ms, /proc/<pid>/fd unreadable for 247 pids
listen :: <- connect ::1: remote ::1:44366 -> /proc/net/tcp6 inode 136293966 -> pid 812861 (child 812861, match true) in 29.2 ms, /proc/<pid>/fd unreadable for 247 pids
listen 0.0.0.0 <- connect 127.0.0.1: remote 127.0.0.1:41228 -> /proc/net/tcp inode 136296711 -> pid 812868 (child 812868, match true) in 32.7 ms, /proc/<pid>/fd unreadable for 247 pids
$ docker run --rm -u node -v /tmp/t0-scripts:/scripts:ro node:26-bookworm-slim node /scripts/peer.mjs
uid 1000 kernel 7.0.0-38-generic
listen 127.0.0.1 <- connect 127.0.0.1: … -> /proc/net/tcp inode 136297892 -> pid 14 (child 14, match true) in 3.2 ms, /proc/<pid>/fd unreadable for 0 pids
listen ::1 <- connect ::1: … -> /proc/net/tcp6 inode 136290265 -> pid 21 (child 21, match true) in 2.7 ms, …
listen :: <- connect 127.0.0.1: remote ::ffff:127.0.0.1:51022 -> /proc/net/tcp inode 136300578 -> pid 28 (child 28, match true) in 3.6 ms, …
listen :: <- connect ::1: … -> /proc/net/tcp6 inode 136292957 -> pid 35 (child 35, match true) in 2.8 ms, …
listen 0.0.0.0 <- connect 127.0.0.1: … -> /proc/net/tcp inode 136292966 -> pid 42 (child 42, match true) in 2.2 ms, …
```

It works for IPv4, IPv6 and a dual-stack server, on the host and in the container (as `node` and as
root). What t2 needs to know:

- **A v4-mapped peer is in `/proc/net/tcp`, not `tcp6`.** A server on `::` sees
  `::ffff:127.0.0.1` but the client's socket is an IPv4 socket. Addresses are little-endian per
  32-bit word on x86 (`127.0.0.1:8797` is `0100007F:225D`).
- **The cost is the `/proc/*/fd` scan, not "a few reads":** 30–40 ms on this desktop, 3 ms in a
  container. Cheaper and equivalent: scan only the fds of the chat processes and their descendants
  (`claudioChildren()` plus `descendantsOf()`, already cached for 1 s). If one of them holds the
  inode, refuse; a process that has left every chat's tree would not have been found by the ancestor
  walk either.
- **"Not found" is not "not a chat".** 247 of 416 processes here belong to other users and their
  `fd` directories are unreadable; a client running as another user, or in another network
  namespace, has no row the server can read. That is `unknown`: refused under `mode: none`, as
  plan §3.5 says.
- **A dev server started by a chat taints everything behind it.** Through Vite's proxy the peer is
  Vite's Node process; if a chat ran `pnpm dev`, every browser request through it comes from a chat
  descendant and is refused `terminal.from-agent`. Correct, but surprising; Settings could say so.
- `/proc/net/tcp` shows the reader's own network namespace. A request reaching Docker through a
  published port arrives from the bridge gateway, never loopback, so plan §2.13's "unavailable with auth
  off" holds. A hardened container that hides `/proc` (`hidepid`, gVisor) was not tested: there the
  check reports `unknown`.

## 9. To verify by the integrator

These need `docker build` or `pnpm desktop:dist`, which only the integrator runs:

1. **Packaged AppImage** (after t5):

   ```bash
   pnpm desktop:dist
   APP=$(ls apps/desktop/release/Claudio-*-x86_64.AppImage)
   "$APP" --appimage-extract >/dev/null    # into ./squashfs-root
   ls squashfs-root/resources/server/node_modules/node-pty/prebuilds/linux-x64/pty.node
   ELECTRON_RUN_AS_NODE=1 squashfs-root/claudio -e "const r=require('module').createRequire('$PWD/squashfs-root/resources/server/terminal-host.mjs'); const p=r('node-pty').spawn('/bin/sh',['-c','echo ok'],{encoding:null}); p.onData(d=>console.log(Buffer.isBuffer(d), String(d).trim()))"
   # expected: true ok
   rm -rf squashfs-root
   ```

   Then run the AppImage itself (from its FUSE mount), turn the terminal on in Settings → Security
   and open one: the plan's manual check.
2. **Docker image** (after t5):

   ```bash
   docker build -f docker/Dockerfile -t claudio:terminal .
   docker run --rm --entrypoint node claudio:terminal -e "const p=require('/app/node_modules/node-pty').spawn('/bin/bash',['-lc','echo ok \$0'],{encoding:null}); p.onData(d=>console.log(Buffer.isBuffer(d), String(d).trim()))"
   # expected: true ok bash   (as user node, no compiler in the image)
   docker run --rm --entrypoint sh claudio:terminal -c 'command -v gcc make python3 || echo "no toolchain"'
   ```
3. **iOS Safari** (the owner, on the phone, with the tunnel up and token auth on): open a terminal
   through the tunnel URL. If it does not connect, Web Inspector's console shows whether CSP refused
   `wss://…/api/terminals/…/socket`; per plan §3.7 the fallback is a per-request `connect-src` with that
   exact origin.

## Appendix: the scripts

Trimmed to what matters; each one took the directory of its `node_modules` as the first argument.

### A.1 Load and Buffer check

```js
// load-buffer.cjs <dir> [package]
const path = require('path'), fs = require('fs');
const req = require('module').createRequire(path.join(process.argv[2], 'x.js'));
const pkg = process.argv[3] || 'node-pty';
const pty = req(pkg);
console.log('node', process.version, 'abi', process.versions.modules, 'napi', process.versions.napi, 'electron', process.versions.electron || '-');
console.log('loaded', pkg, JSON.parse(fs.readFileSync(path.join(process.argv[2], 'node_modules', pkg, 'package.json'), 'utf8')).version);
const p = pty.spawn('/bin/bash', ['--norc', '--noprofile', '-c', 'printf "h\\xc3\\xa9llo\\n"; exit 3'],
  { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, encoding: null });
const types = new Set(); let total = Buffer.alloc(0);
p.onData((d) => { types.add(Buffer.isBuffer(d) ? 'Buffer' : typeof d); total = Buffer.concat([total, Buffer.from(d)]); });
p.onExit((e) => console.log('data types:', [...types].join(','), 'bytes:', total.toString('hex'), 'exit:', JSON.stringify(e)));
```

### A.2 Descriptor check

```js
// fd-leak.cjs <dir>: two shells from one process, then what each one (and a later child) holds
const opts = { cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, encoding: null };
const a = pty.spawn('/bin/sh', ['-c', 'sleep 30'], opts);
const b = pty.spawn('/bin/sh', ['-c', 'sleep 30'], opts);
const fds = (pid) => fs.readdirSync(`/proc/${pid}/fd`).map((fd) => `${fd}->${fs.readlinkSync(`/proc/${pid}/fd/${fd}`)}`);
const flags = (pid, fd) => fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').split('\n').find((l) => l.startsWith('flags'));
setTimeout(() => {
  const ptmx = fds(process.pid).filter((s) => s.includes('ptmx'));
  console.log('host ptmx fds:', ptmx.join(' '), '|', ptmx.map((s) => `${s.split('->')[0]} ${flags(process.pid, s.split('->')[0])}`).join(' ; '));
  console.log('shell A fds:', fds(a.pid).join(' '));
  console.log('shell B fds:', fds(b.pid).join(' '));
  console.log(execFileSync('ls', ['-l', `/proc/${b.pid}/fd`]).toString());
  console.log('child_process.execFileSync child fds:\n' + execFileSync('/bin/sh', ['-c', 'ls -l /proc/$$/fd']).toString());
  a.kill('SIGKILL'); b.kill('SIGKILL'); process.exit(0);
}, 500);
```

### A.3 Headless screen check

```js
// headless.mjs <dir>
const make = (cols, rows) => {
  const t = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  const s = new SerializeAddon(); t.loadAddon(s); t.loadAddon(new Unicode11Addon()); t.unicode.activeVersion = '11';
  return { t, s };
};
const write = (t, d) => new Promise((r) => t.write(d, r));
const rows = (t) => { const b = t.buffer.active, out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out; };
const a = make(40, 6);
for (let i = 1; i <= 20; i++) await write(a.t, `line ${i} \x1b[1;31mred\x1b[0m é 👍\r\n`);
await write(a.t, '\x1b[?1049h\x1b[H\x1b[2JALT SCREEN\x1b[3;5Hcursor-here');
const snap = a.s.serialize({ scrollback: 1000 });
const b = make(40, 6); await write(b.t, snap);   // compare rows(a.t) with rows(b.t), the cursor, then leave the alt screen in both
const c = make(40, 6); await write(c.t, 'before '); await write(c.t, '\x1b[1;3');
const half = c.s.serialize({ scrollback: 0 }); await write(c.t, '1mRED\x1b[0m');
const d = make(40, 6); await write(d.t, half); await write(d.t, '1mRED\x1b[0m');   // "before 1mRED"
```

### A.4 IPC check

```js
// ipc-buffer.cjs: forks itself with serialization 'advanced' and an env holding only ELECTRON_RUN_AS_NODE under Electron
const child = fork(__filename, ['child'], { serialization: 'advanced', env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}, execPath: process.execPath });
// child: process.send({ kind: 'data', bytes: Buffer.from([0xc3, 0xa9]) }), then 1 024 × 64 KiB
// parent: m.bytes.constructor.name, Buffer.isBuffer(m.bytes), bytes received and elapsed time
```

### A.5 WebSocket check

```js
// ws-facts.mjs <dir>: the parts that matter
const app = Fastify({ forceCloseConnections: true });
app.addHook('onRequest', async (req, reply) => {
  seen.push({ hook: 'onRequest', url: req.url, upgrade: req.headers.upgrade ?? null });
  // The fix: a refused upgrade's socket is no longer tracked by Node, so close it ourselves
  if (process.env.FIX && req.headers.upgrade) reply.raw.once('finish', () => req.raw.socket.destroy());
  if (req.url.includes('deny=1')) return reply.code(401).send({ error: 'denied by onRequest' });
  if (req.url.includes('origin=check') && req.headers.origin !== `http://${req.headers.host}`)
    return reply.code(403).send({ error: 'origin', origin: req.headers.origin, host: req.headers.host });
});
await app.register(websocket);
app.get('/api/terminals/:id/socket', { websocket: true }, (socket, req) => {
  seen.push({ hook: 'handler', url: req.url });
  socket.send(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, peer: req.socket.remoteAddress,
    xff: req.headers['x-forwarded-for'] ?? null, forwarded: req.headers.forwarded ?? null }));
  socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
});
// Two Vite dev servers in front: proxy { '/api': { target, changeOrigin: process.env.CHANGE_ORIGIN !== 'false', ws, timeout: 0, proxyTimeout: 0 } }, ws true and false
// Clients: new WebSocket(url, { origin }) from the `ws` package; case 7 races app.close() against 5 s
```

### A.6 CSP check

```js
// csp-ws.mjs <dir> <port>: GET / sends `<script src="/t.js">` with the CSP below; /t.js tries three sockets and POSTs /report
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
// t.js: tryWs('same-origin absolute', 'ws://' + location.host + '/ws'); tryWs('same-origin relative', '/ws');
//       tryWs('other port', 'ws://127.0.0.1:<port + 1>/ws'); plus a securitypolicyviolation listener
// The https variant serves the same with a self-signed certificate and wss:// URLs.
```

### A.7 Peer lookup

```js
// peer.mjs: the lookup itself, reusable by peer.ts
const hex4 = (ip) => ip.split('.').map((n) => Number(n).toString(16).padStart(2, '0')).reverse().join('').toUpperCase();
function hex6(ip) {                       // four 32-bit words, each little-endian
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const words = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((w) => w.padStart(4, '0'));
  const bytes = Buffer.from(words.join(''), 'hex');
  let out = '';
  for (let i = 0; i < 16; i += 4) out += Buffer.from(bytes.subarray(i, i + 4)).reverse().toString('hex');
  return out.toUpperCase();
}
function inodeOf(ip, port) {              // ip, port: the client's, i.e. req.socket.remoteAddress / remotePort
  const p = port.toString(16).toUpperCase().padStart(4, '0');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const [file, local] = !ip.includes(':') ? ['/proc/net/tcp', `${hex4(ip)}:${p}`]
    : mapped ? ['/proc/net/tcp', `${hex4(mapped[1])}:${p}`] : ['/proc/net/tcp6', `${hex6(ip)}:${p}`];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === local && f[9] !== '0') return f[9];   // field 9 is the inode
  }
}
// Then: the pid whose /proc/<pid>/fd/* reads `socket:[<inode>]` (EACCES on other users' processes)
```

## Related

[[plans/terminal.md]] · [[security-model.md]] · [[desktop.md]] ·
[[deploy.md]] · [[chat-environment.md]]
