---
created_at: 2026-11-15T14:00:00Z
updated_at: 2026-11-15T20:00:00Z
tags:
    - decision
    - spike
    - restart
    - architecture
    - claude-code
    - systemd
    - one-rule
---
# Spikes: parked CLI processes (S1 to S6)

The six spikes of [survive-restarts](plans/survive-restarts.md#8-spikes), task `t2`, run on 2026-11-15
against Claude Code **2.1.322** (real CLI for S2, the e2e fake CLI for S1), on the owner's Linux
desktop (systemd 259, user manager lingering, ext4 `/home`, tmpfs `/tmp`). Everything ran in
scratch directories under `/tmp/t2` and `~/.cache`, with a scratch `CLAUDE_CONFIG_DIR` and `env -i`.
The owner's running app, `~/.config/Claudio` and `~/.claude` were never signalled, written or
copied (S6 read transcript sizes only). Every process, unit and mount created was ended by name or
pid and checked afterwards. No tokens were spent, except S3, which ran later the same day on one Haiku turn (below).

Confidence marks as in the plan: **verified** (measured here), **inferred**, **not determined**.

## Summary

| Spike | Result | Confidence |
|---|---|---|
| S1 adoption | A prototype of layer 2 (wrapper, row, tail, fold, guarded takeover) adopts a CLI after a server `SIGKILL` mid-turn, with the same pid, no duplicate event and one spend row per turn; a pending prompt is answered by the successor | Verified with the fake CLI; the production code does not exist yet (t3, t4) |
| S2 real CLI behind a FIFO | Works: FIFO stdin, file stdout, `initialize` answered by two successive writers, `pending_permission_requests: []` | Verified, real CLI 2.1.322 |
| S3 pending prompt, real CLI | Works: after a `SIGKILL` of the writer and a 5 s gap, a re-sent `initialize` returns the pending request in `pending_permission_requests` with the same id; both prompts were answered, the turn ended `success`, 0.0012 USD; the guard hook fired for both tools, the second after the gap | Verified, real CLI 2.1.322, one run |
| S4 scopes | Scopes survive a stop, a restart and a `SIGKILL` of the launcher's unit; stopping a scope leaves nothing, double forks included | Verified |
| S5 AppImage mount | A process running from a mount keeps running after a lazy unmount, but a plain unmount is refused while it runs. A real AppImage's FUSE server dying is **inferred** to fault it | Partly verified (tmpfs stand-in), the FUSE part inferred |
| S6 volume and holes | Transcripts: median 68 MB/day, peak 120 MB/day over 14 days. `fallocate --punch-hole` on a file a process is appending to works on ext4 | Verified for the holes; volume is a proxy |

## S1. Adoption after a server `SIGKILL`

**Question.** Can a server, killed mid-turn and restarted, adopt the parked process with no gap and no
duplicate?

**How run.** Claudio has no adoption code yet, so the spike is a prototype in `/tmp/t2/s1`
(`wrapper.sh`, `server.mjs`) of exactly the plan's layer 2, run on `e2e/fake-cli/claude` with scripted
turns (`CLAUDIO_FAKE_CLI_SCRIPTS`):

- The wrapper is the plan's: `setsid sh`, the FIFO held read-write, stdout appended to `out.jsonl`,
  the exit code to `exit.code`.
- The row (SQLite, `node:sqlite`) holds the pid and its start time (field 22 of `/proc/<pid>/stat`),
  the owner (pid and start time), the committed offset and the stdin sequence.
- The server tails `out.jsonl` by byte offset and folds each line. Every effect is keyed by
  `(process, byte offset)` with `INSERT OR IGNORE`; the committed offset moves only at a `result`,
  in one transaction with its spend row.
- Adoption checks the pid and start time, takes the lease with
  `UPDATE … SET owner = ? WHERE id = ? AND owner IS <the owner it read>`, replays from the
  committed offset, then writes `initialize` to the FIFO.

**Results.**

1. **Gap longer than the turn.** Server 1 was killed 2.5 s into a 4 s two-command turn; the CLI
   finished it with nobody reading (7 lines in `out.jsonl` at the end of the gap). Server 2 adopted:
   same pid, replay from offset 0, 3 lines already applied ignored, both results folded, then a
   second turn sent through the FIFO ran on the same process. 0 duplicated uuids, 2 spend rows for
   2 turns.
2. **Gap inside the turn, with a race and a second death.** Two successors started together: one
   took the lease, the other saw a live owner and stood down. The winner was `SIGKILL`ed
   mid-replay; a third took over from the dead owner (`changes=1`), replayed from the same
   committed offset and finished the turn. One CLI start (`init` count 1), the same pid
   throughout, 0 duplicates, 1 spend row.
3. **A prompt pending across the gap** (fake CLI, `ask:` steps). Server 1 died with `can_use_tool`
   unanswered; server 2 replayed `out.jsonl`, found the request had no row in `answers`, answered
   it through the FIFO, and the turn finished (`Allowed: …`). The answers table makes it idempotent
   per request id.

**What it found that the plan did not say.**

- **A background job in a non-interactive `sh` gets `/dev/null` as stdin.** The first wrapper ended
  with `claude … >>out.jsonl &`; the CLI read EOF at once and exited 0. The fix is an explicit
  redirection from a descriptor the wrapper holds: `exec 3<>in.fifo; claude … <&3 >>out 2>>err 3>&- &`.
  The plan's one-liner (`exec 0<>in.fifo; claude …` in the foreground, M3) is correct as written;
  this only bites a wrapper that backgrounds the CLI to record its pid.
- **The wrapper's `sh` is adopted by the user manager**, not by anything of Claudio's (its ppid
  became that of `systemd --user`), so the server's death does not touch it.
- **The result of a turn can already be in the replay** when the adopter starts. Waiting for "the
  next result" hangs; the adopter must decide from the committed offset and the row's turn state.
- **Liveness of the previous owner** (pid plus start time) is enough for one machine; the lease
  expiry is still needed when the owner cannot be probed (another pid namespace).
- The fake CLI does not put `pending_permission_requests` in `initialize`; case 3 therefore
  proves the replay path, and S2 and S3 cover the real answer.

**Confidence.** Verified for the design with a fake CLI. The real CLI's mid-turn behaviour on a
second `initialize` is S3's.

**Means for t3/t4.**

- Key every fold effect on `(process, byte offset)`, and commit the offset with the spend row in
  one transaction. That alone made the replay exactly-once (R1).
- Adoption order: check pid and start time, guarded takeover, replay, `initialize`.
- Keep an `answers` set (request ids already answered) in the row's store: it is what makes
  pending prompts idempotent when the CLI's own list is empty or absent.
- Use the `<&3` form if the wrapper backgrounds the CLI.

## S2. A real CLI behind a FIFO

**Question.** Does `claude -p --input-format stream-json` accept a FIFO as stdin and a regular file
as stdout, and answer `initialize` twice from two successive writers?

**How run.** CLI 2.1.322, `env -i HOME=<scratch> CLAUDE_CONFIG_DIR=<scratch>` (no credential), the
wrapper of M3 (`exec 0<>in.fifo`, `>>out.jsonl`), no prompt, no turn, no tokens. Two separate
`echo '{…initialize…}' > in.fifo` writers, 5 s apart, and a third one later.

**Result (verified).**

- The CLI started with no sign-in, kept its FIFO and file (`/proc/<sh>/fd/0 -> in.fifo`,
  `fd/1 -> out.jsonl`) and answered every `initialize` with `subtype: success`. Each writer closed
  its end after one line; the CLI never read EOF and stayed up.
- The answer carries `pending_permission_requests: []` and `pending_user_dialog_requests: []`
  **beside** the inner `response` object (at `response.pending_permission_requests`, a sibling of
  `response.response`), not inside it. `hooks_applied` did not appear (no hooks were configured).
  The inner response lists `pid` and `claude_code_version`, `session_state: "idle"` and
  `capabilities`, which is a free liveness and version probe for adoption.
- Each `initialize` answer is about **18 KB** of stdout (command and model lists). Every adoption
  adds one; it is noise for the fold and must not count as turn output.
- After the answers the CLI wrote a `system/background_tasks_changed` line on its own.
- **SIGINT on an idle `-p` CLI ended it** (exit code 0, recorded by the wrapper). The plan's lease
  watchdog says SIGINT "ends the turn"; with no turn open it ends the process. The wrapper is
  still the only holder, so the exit is recorded, but the watchdog must act only while a turn is
  open (the tail knows: a `result` closes it).

**Confidence.** Verified, real CLI 2.1.322.

**Means for t3/t4/t6.** Layer 2 needs no new CLI surface. The pending list lives at
`response.pending_permission_requests` of the `control_response`. The CLI's start with no account
is fine, so `initialize` also works as the liveness probe for an adopted process.

## S3. A pending prompt across the gap

**Question.** With a permission request pending, does killing the server, then re-sending
`initialize`, deliver the same request again and accept the answer? Do guard hooks keep firing?

**How run (2026-11-15, CLI 2.1.322, Haiku).** The driver below, unchanged except that the CLI ran in
a scratch config directory the owner had signed in to for the spikes (account A, Max plan) instead of
a fresh `claude auth login`, and with `HOME` and every working directory in a scratch directory.
`--model haiku --max-budget-usd 0.05 --max-turns 4 --tools Bash`, a PreToolUse hook on Bash that
appends `date +%s` to `hook.log`. The prompt asked for two `touch` calls.

**Result (verified, one run).**

- Phase 1 saw the first `can_use_tool` request and died by `SIGKILL` with the request unanswered.
- Phase 2 waited 5 s with no server, then re-sent `initialize`. The `control_response` came back and
  `response.pending_permission_requests` held **the same request** (same `request_id`, the tool
  name, the full input and the description), so the vendor's list is enough for `PermissionBroker`
  to rebuild a prompt after adoption. It held the one request that was pending at that time.
- Answering it with `allow` and then the second request (which arrived afterwards on the same
  stream) ended the turn: `result subtype=success is_error=false`, `prompts_answered=2`, files `a`
  and `b` created. The CLI had not exited at the `SIGKILL` of the writer, as in S2.
- `total_cost_usd` was **0.00122627** (limit 0.05).
- `hook.log` has **two lines**, six seconds apart (1794751601, 1794751606): the second hook ran
  after the gap, so guard hooks keep firing across a hand-over.

**Confidence.** Verified on the real CLI, but one run, one tool, one prompt at a time. Several
simultaneous pending prompts were not tried, so the list's order and completeness stay inferred for
that case.

**Means for t4.** The first path (rebuild the prompts from `pending_permission_requests` after the
re-sent `initialize`) works and is the one to implement; the replay-based path stays as the
fallback for an empty list. The guard needs nothing more across the gap. The "inferred" mark on
guard hooks in the plan (section 6, section 11) becomes verified.

The script that was run (the adaptation was removing the `claude auth login` line and the final
`rm -rf` of the config; zsh):

```zsh
T=$(mktemp -d /tmp/claudio-s3.XXXXXX); export T
mkfifo $T/in.fifo; mkdir $T/cfg $T/work
CLAUDE_CONFIG_DIR=$T/cfg claude auth login        # the same paste-code sign-in as the app, in the scratch dir
cat > $T/settings.json <<EOF
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"date +%s >> $T/hook.log"}]}]}}
EOF
cat > $T/s3.mjs <<'JS'
// S3 driver. phase1: send the prompt, wait for the CLI's first can_use_tool, then die by SIGKILL (a crashed server).
// phase2: a new writer re-sends initialize, answers what is pending, and follows the turn to its result.
import fs from 'node:fs';
const [phase, T, arg] = process.argv.slice(2);
const out = `${T}/out.jsonl`, fifo = `${T}/in.fifo`;
const send = (o) => { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, JSON.stringify(o) + '\n'); fs.closeSync(fd); };
const lines = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asks = () => lines().filter((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool');
const allow = (id, input) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: input } } });

if (phase === 'phase1') {
  send({ type: 'user', message: { role: 'user', content: arg } });
  for (let i = 0; i < 600; i++) {
    const a = asks()[0];
    if (a) { console.log(`phase1: the CLI asks permission (request ${a.request_id}, ${JSON.stringify(a.request.input).slice(0, 80)}); now dying by SIGKILL`); process.kill(process.pid, 'SIGKILL'); }
    if (lines().some((m) => m.type === 'result')) { console.log('phase1: the turn ended with no prompt; the test needs a Bash call that asks'); process.exit(2); }
    await sleep(100);
  }
  console.log('phase1: timed out'); process.exit(2);
}
if (phase === 'phase2') {
  console.log(`phase2: ${lines().length} lines already in out.jsonl; waiting ${arg ?? 5}s with no server`);
  await sleep(Number(arg ?? 5) * 1000);
  const id = `reattach-${Date.now()}`; send({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
  let init; for (let i = 0; i < 300 && !init; i++) { init = lines().find((m) => m.type === 'control_response' && m.response?.request_id === id); await sleep(100); }
  if (!init) { console.log('phase2: NO answer to initialize'); process.exit(1); }
  const pending = init.response?.pending_permission_requests;
  console.log(`phase2: initialize answered; pending_permission_requests = ${JSON.stringify(pending)?.slice(0, 300)}`);
  const answered = new Set();
  for (let i = 0; i < 1800; i++) {
    for (const a of asks()) if (!answered.has(a.request_id)) { answered.add(a.request_id); console.log(`phase2: answering allow for ${a.request_id} (${JSON.stringify(a.request.input).slice(0, 80)})`); allow(a.request_id, a.request.input); }
    const r = lines().find((m) => m.type === 'result');
    if (r) { console.log(`phase2: result subtype=${r.subtype} is_error=${r.is_error} total_cost_usd=${r.total_cost_usd} prompts_answered=${answered.size}`); process.exit(0); }
    await sleep(100);
  }
  console.log('phase2: timed out'); process.exit(2);
}
JS
setsid sh -c 'exec 3<>"$0/in.fifo"; cd "$0/work"; CLAUDE_CONFIG_DIR="$0/cfg" claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --max-budget-usd 0.05 --max-turns 4 --tools Bash --permission-mode default --permission-prompts host --permission-prompt-tool stdio --settings "$0/settings.json" --include-hook-events <&3 >>"$0/out.jsonl" 2>>"$0/err.log" & echo $! >"$0/pid"; wait $!; echo $? >"$0/exit.code"' $T </dev/null >/dev/null 2>&1 &
sleep 2
node $T/s3.mjs phase1 $T "Use the Bash tool to run exactly: touch $T/work/a   then exactly: touch $T/work/b   then say done."
node $T/s3.mjs phase2 $T 5                            # 5 s with no server, then re-attach
ls $T/work; cat $T/hook.log                           # a and b exist; two hook lines, the second after the gap
kill $(cat $T/pid); sleep 1; cat $T/exit.code; rm -rf $T
```

What to look for, and what each outcome means:

- `phase2: initialize answered; pending_permission_requests = [ … ]` with the request id phase 1
  printed: the vendor's list works as documented, and `PermissionBroker` can rebuild its prompts
  from it. An empty list while the request is still waiting: adoption must rebuild prompts from
  the replayed `out.jsonl` (S1 case 3 already shows that path works).
- `result … total_cost_usd` is the cost actually spent; it must be under 0.05.
- `hook.log` has two lines, the second written after the gap: guard hooks keep working across a
  hand-over.

## S4. Scopes and restarts

**Question.** Are CLI trees in `systemd-run --user --scope` units untouched when the launcher's unit
stops or restarts, and does stopping one scope leave nothing?

**How run.** systemd 259, user manager. A transient service `t2-launcher` started two scopes
(`t2-cli-1`, `t2-cli-2`, `-p TimeoutStopSec=4`), each running a tree of five processes: a child, a
double-forked `setsid` grandchild, one that ignores SIGTERM, and their shells. The scopes were
started by the launcher as `systemd-run --user --scope --unit=… -- sh payload.sh &`.

**Results (verified).**

- The scopes lived in `app.slice`, the launcher in its own service cgroup; the five processes of a
  scope were in the scope's cgroup, not in the launcher's.
- `systemctl --user stop t2-launcher`: both scopes stayed `active (running)` with 5 processes each.
- Starting a launcher unit again, then `systemctl --user restart` on it: same two scopes, same 5
  processes each.
- `kill -9` of the launcher's main pid: the service went `failed` (as it would under
  `Restart=on-failure`, which restarts it); both scopes stayed running.
- `systemctl --user stop t2-cli-1.scope`: none of the five pids was left, double fork included, and
  the other scope was untouched. With a member that ignores SIGTERM the stop took exactly
  `TimeoutStopSec` (4.1 s) and the scope ended `failed` (it needs `reset-failed` before its name is
  reused). A tree that honours SIGTERM stopped in 0.04 s and left no unit.
- The user manager adopts the orphaned `sh` (ppid of the wrapper after the server died).

**Not run.** The container has no user manager, so the `setsid` fallback (D9 b) is only reasoned: it
keeps the CLI out of the launcher's process group but not in a cgroup, so a stop must kill the tree
by walking `/proc` or by process group, and double forks escape the group.

**Confidence.** Verified on this desktop. The container path is inferred.

**Means for t3/t6.**

- One scope per CLI is what survives the server, the launcher and an update; the launcher may be
  restarted freely.
- Pass `-p TimeoutStopSec=<n>` at scope creation (the default 90 s would block a "stop all work"),
  and `systemctl --user reset-failed 'claudio-cli-*'` when reaping rows whose scope ended `failed`.
- Stopping is `systemctl --user stop <scope>`; reading is `systemctl --user show -p ControlGroup`
  and the `cgroup.procs` file. Neither needs the pid.

## S5. A process left running from an AppImage mount

**Question.** Does a process started from the AppImage mount fault after the AppImage's process exits?

**How run.** Partly. A real AppImage needs `squashfuse` or its own runtime, and neither is
installed here (FUSE itself is: `/dev/fuse`, `fusermount3`); no installed application's AppImage
was mounted or probed. The stand-in is a tmpfs inside a private mount namespace
(`unshare -rm`) with a copy of `sleep` started from it with `setsid`.

**Results.**

- A plain `umount` of the mount is refused while the process runs from it (`EBUSY`, "el destino está
  ocupado"). A **lazy** `umount -l` succeeds; the process kept running, its `/proc/<pid>/exe` became
  `/app-sleep` (detached), and the path no longer lists files (`0 files`).
- A real AppImage's mount is served by a FUSE process (the runtime). When that process exits, the
  connection is gone and a read of a page not loaded yet fails with `ENOTCONN`, and a page of a
  mapped executable that is not resident raises `SIGBUS`. A tmpfs cannot show this; it is
  **inferred** from how FUSE works, not reproduced.

**Confidence.** The kernel behaviour with a stand-in is verified; the AppImage fault is inferred.

**Means for t6.** Nothing that outlives the window may be executed or lazily loaded from the
AppImage mount: the launcher and the server's files (`server.mjs`, `mcp.mjs`, `guard.mjs`) must be
copied under `<dataDir>/app/<version>` before the daemon detaches, as the plan proposed. The `.deb`
install in `/opt/Claudio` is not affected (apt replaces files by rename).

## S6. Stdout volume and punching holes

**Question.** How many bytes does a day of the owner's real usage put on a CLI's stdout, and does
`fallocate --punch-hole` work on a file a process is still appending to?

**How the volume was read (read-only).** The running app must not be touched, and its stdout
counter does not exist. The proxy is the CLI's transcripts under `~/.claude/projects`: the size of
every line, grouped by the line's own timestamp (day, UTC), over the files changed in the last 14
days (677 files). Content was never printed or kept.

| Day | MB | Day | MB |
|---|---|---|---|
| 11-02 | 70.9 | 11-09 | 67.0 |
| 11-03 | 67.8 | 11-10 | 64.1 |
| 11-04 | 0.7 | 11-11 | 20.1 |
| 11-05 | 13.4 | 11-12 | 15.4 |
| 11-06 | 25.2 | 11-13 | 104.6 |
| 11-07 | 99.3 | 11-14 | 107.6 |
| 11-08 | 120.0 | 11-15 (partial) | 79.1 |

**Median 68 MB/day, peak 120 MB/day.** `/proc/<pid>/io` `wchar` of the owner's live CLIs (M4) is an
upper bound only.

**What this is not.** Stdout carries what the transcript lacks (the `stream_event` deltas that
`--include-partial-messages` adds, an 18 KB `initialize` answer per adoption) and the transcript
carries what stdout lacks. The stdout-to-transcript ratio is **not determined**: one real turn
measures it (S3 did not record it; the script can: compare the size of `out.jsonl` with the transcript in the account directory).

**Hole punching (verified, ext4, `/home`).** A writer opened `out.jsonl` with `O_APPEND` and wrote
4000 lines of 1 KB every 2 ms while another process punched the already-read prefix every 200 ms
(`fallocate --punch-hole --keep-size`, always 8 KB behind the end, block-aligned). At the end the
file's size was 4.08 MB, its allocation 12 KB, every line from the first intact one to number 4000
was present and consecutive (0 gaps), the writer was never disturbed, and the only unparsable
fragment was the one line cut by the hole's edge. On the first, real-CLI file of S2 (tmpfs), the
same call freed the prefix and the next 18 KB answer landed at the new end.

**Means for t3.**

- Disk use is bounded by the open turn, not by the day: with the offset committed at each
  `result` (S1), a long turn of tens of MB is the worst case, against 68 to 120 MB/day cumulative
  if nothing were freed.
- Punch only below the committed offset and in whole blocks; the line that straddles the hole's
  edge is gone, which is why the committed offset is always a line end.
- Reading after a punch must start at the committed offset, never at 0 (the prefix reads as NULs).
- Filesystems without hole punching (tmpfs does it; some network mounts do not) must degrade to
  rotating the file at a turn boundary.

## What changes for the tasks

**t3 (start and run).**
- Wrapper: FIFO held read-write by the wrapper (`<&3` if backgrounded), stdout appended, exit code
  recorded, in a scope with `-p TimeoutStopSec` (S1, S4).
- Row: pid and start time, owner pid and start time, committed offset, stdin sequence, answered
  request ids; effects keyed on `(process, offset)` (S1).
- Hole punching as above (S6).

**t4 (adoption).**
- Order: probe pid and start time, guarded takeover, replay, `initialize`; read
  `response.pending_permission_requests` and fall back to the unanswered `can_use_tool` of the
  replay (S1, S2).
- The lease watchdog sends SIGINT only while a turn is open (S2).
- `initialize` answers are not turn output; they are 18 KB each (S2).

**t6 (daemon).**
- Everything the daemon or a CLI runs lives under `<dataDir>/app/<version>`, not under an
  AppImage mount (S5).
- Scopes make the launcher restartable at will (S4); without a user manager the fallback gives up
  the cgroup guarantee.

**Still open.** The stdout-to-transcript ratio, several simultaneous pending prompts, and the
container's `setsid` path. S3 is closed (above).

## Related

[[plans/survive-restarts.md]] · [[plans/process-isolation.md]] · [[cli-surfaces.md]] · [[providers.md]] · [[security-model.md]] · [[desktop.md]] · [[decisions/get-usage-control-request.md]]
