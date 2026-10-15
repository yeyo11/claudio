# Sign-in recordings

Raw output of each documented sign-in command, run with **no TTY**, recorded on 2026-10-08 for
step 1 of [the in-app setup plan](../../../../../docs/plans/in-app-setup.md). They are what
`LoginService`'s patterns and the fake CLIs in its tests are written from.

## How they were made

- In a throwaway container (`docker run --rm`). gh 2.102.0 and glab 1.120.0 were the vendors' linux
  amd64 release binaries, checked against their checksum files and mounted on the `PATH`.
- Every home pointed at a fresh folder inside the container: `HOME`,
  `GH_CONFIG_DIR`, `GLAB_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`. No keyring, no clipboard,
  no browser, no `DISPLAY`.
- Each command started in its own process group with stdin from `/dev/null` (device flows) or a pipe
  (key flows), stdout and stderr captured to separate files. A device flow was stopped with SIGTERM
  to the process group 3 s after its code appeared. Nobody opened a URL, so no account signed in.
- Per recording: `<tool>-<method>.stdout`, `.stderr`, and `.json` with the command, stdin, exit code,
  how it was stopped, how long it ran, the CLI version and the date. Nothing is redacted: the codes
  are one-time and expired unused. The bytes are as the CLI wrote them, ANSI escapes included.

## Device-code flows

Both run with no TTY and keep polling until approved, cancelled or expired.

| Tool | Command | Stream | URL line | Code line | Lifetime printed | Exit on SIGTERM |
|---|---|---|---|---|---|---|
| gh | `gh auth login --web -h github.com --git-protocol https --skip-ssh-key` | stderr | `Open this URL to continue in your web browser: https://github.com/login/device` | `! First copy your one-time code: 250D-975E` | not printed | 143 |
| glab | `glab auth login --device --hostname gitlab.com` | stderr | `Then open this URL on any device to authorize: https://gitlab.com/oauth/device` | `First copy your one-time code: 5NZYG1XD` | not printed | 1, after printing `The command execution has been interrupted.` |

What the patterns have to allow for:

- **Strip ANSI first.** glab's error box is coloured even with no TTY.
- **Code shapes differ.** gh `XXXX-XXXX`, glab eight characters with no dash. All upper-case letters and digits.
- **The exit code says nothing about success.** glab exits 1 when killed, before any approval. The
  plan's rule stands: success is the readiness probe after exit.
- **Noise to ignore.** gh says it could not copy the code to the clipboard; it still prints the URL and the code.
- **Lifetimes.** None prints one, so the 15-minute ceiling is the plan's.

## Key and token paths, with a bad credential

| Tool | Command | Exit | What it does with a bad key |
|---|---|---|---|
| gh | `echo bad \| gh auth login --with-token -h github.com` | 1 | Refused: `error validating token: HTTP 401: Bad credentials (https://api.github.com/)` |
| glab | `echo bad \| glab auth login --hostname gitlab.com --stdin` | 0 | **Accepts and stores it** with a warning: `WARNING: Could not look up the username for this token: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}`, then `✓ Stored your credentials in the configuration file.` |

So for glab the exit code cannot tell a refusal: its only sign is the `401` warning. `LoginService` must re-run the tool's readiness probe after a key, and for
glab may also read that warning line, before it says the key worked.

## Storage without a keyring

- **glab** does not ask: `WARNING: The operating system keyring is unavailable. Storing credentials as
  plaintext in the configuration file.` (in `GLAB_CONFIG_DIR/config.yml`). It also checks for updates
  and prints a banner (`A new version of glab is available`), which the parser ignores.
- **gh** asks nothing in either path; with no keyring it keeps the token in `GH_CONFIG_DIR/hosts.yml`.
  This was not observed here (no token was accepted) and is gh's documented fallback.

## Tailscale (recorded 2026-10-08, for the daemon the image runs)

Not in the image run above: tailscale 1.102.4's release binaries on the recording machine, the CLI
pointed with `--socket` at a **throwaway** `tailscaled --tun=userspace-networking
--state=<tmp>/state --socket=<tmp>/sock --statedir=<tmp> --port=0 --no-logs-no-support`, started
as an unprivileged user with a fresh state, the way the image starts its own. The machine's own
signed-in daemon was never asked anything but `--help`. The throwaway was killed by its PID and its
folder removed once the URL showed; nobody opened it, so no node joined a tailnet.

| Recording | Command | Exit | What it shows |
|---|---|---|---|
| `tailscale-up.*` | `tailscale up --reset --hostname=agentry`, stdin `/dev/null` | 1 on SIGTERM (`context canceled`) | stderr only: an empty line, `To authenticate, visit:`, an empty line, the URL alone after a tab (`\thttps://login.tailscale.com/a/<id>`), an empty line. **No code**: opening the URL is the sign-in. It took about 4.6 s to appear (the daemon asks the control server for it), and the command then waits until the node is `Running` (`--timeout` 0 = forever) |
| `tailscale-up-auth-key-bad.*` | the same with `--auth-key=file:<tmp>/key` (mode 0600, a well-shaped key that does not exist) | 1, at once | stderr `backend error: invalid key: API key does not exist`. The `file:` form is read: 1.102's `up --help` documents it, and a missing file answers `open <path>: no such file or directory` |

Also measured on the throwaway, and why `LoginService` runs what it runs:

- **`up` with flags that differ from what the daemon kept is refused** (`changing settings via 'tailscale
  up' requires mentioning all non-default flags`) unless `--reset` is given; `tailscale login` skips
  that check but its help calls it alpha. Hence `up --reset --hostname=<name>`, on a daemon only
  Claudio drives.
- **The CLI and the daemon run as the same unprivileged user** and the CLI may change everything
  (`up`, `logout`) with no `--operator`.
- **`tailscale logout`** on a node that is not signed in exits 0 with no output.
- **`status --json`** on the fresh daemon answers `BackendState: NeedsLogin`, `TUN: false`, and
  once `up` printed its URL, `AuthURL` holds it too.
