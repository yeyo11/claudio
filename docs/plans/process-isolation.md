---
created_at: 2026-10-17T19:45:00Z
updated_at: 2026-10-17T19:45:00Z
tags:
    - plan
    - study
    - isolation
    - resources
    - architecture
    - orchestration
    - decision-pending
---
# Process isolation: where agents and their commands run

**Status: study, interrupted 2026-10-17 by a reboot and completed from its transcript the same day;
the decisions in §7 wait for the owner.**

The study ran as one chat (`e40f4e8c-2fd4-4ead-8764-448d7f0975d5`, 2026-10-17 10:57–12:59 UTC, the
owner writing in Spanish) until a reboot of the machine cut it during a measurement. Its export is
`~/.local/share/claudio-launch/backup/isolation-study-chat-e40f4e8c.md`. Everything below comes from
that export unless it says otherwise: the owner's words, the measurements, eight research reports
and the architecture the chat reached. Where this document adds something the chat did not say, it
is marked **(added here)**. Times are UTC; the transcript's own shell output shows local time
(CEST, UTC+2).

## 1. What the owner asked, and what he decided along the way

**The question (10:57).** Would Claudio improve if its processes were isolated or ran in Docker? He
can launch many agents, those launch subagents, and those launch background tasks ("pnpm, test
e2e.."), all on the same host. He asked for "un estudio completo de arquitectura", not a single
solution, and to understand the problem first: "pregúntame todo lo que necesites".

**What he stated, in order.** The answers to the chat's questions have no timestamp of their own;
they fall between the messages around them.

| When | What the owner said or chose |
|---|---|
| 10:57–11:07 | The pain he has seen: **host saturation and orphan processes** (not collisions between agents, not security) |
| 10:57–11:07 | Where it must work: **all four**: his Linux desktop, a dedicated server, remote workers or cloud, Kubernetes |
| 10:57–11:07 | Worst-case scale: **unknown or variable** ("I want the system to adapt") |
| 10:57–11:07 | Unit of isolation: **the orchestration** |
| 10:57–11:07 | Credentials in a box: **mount the account's config dir** |
| 10:57–11:07 | On the desktop: **must work without Docker** (systemd and cgroups v2 by default, containers optional) |
| 10:57–11:07 | Environment inside the box: **the project's own** (its devcontainer or Dockerfile) |
| 10:57–11:07 | Interactive chats: **in scope, but only limits** (on the host, with limits and guaranteed cleanup) |
| 10:57–11:07 | At a memory limit: **pause and queue** |
| 10:57–11:07 | Remote content transport: "Git o iroh P2P que opinas?" (the chat answered: git for content, iroh or HTTP for control) |
| 10:57–11:07 | Deliverable: **a study in `docs/plans/`** (not measurements, not proofs of concept, at that point) |
| 10:57–11:07 | Constraint: **by phases**: simple first (local), an architecture that grows to remote and Kubernetes **without rewriting** |
| 11:07 | He **has seen the host freeze with e2e runs at once**; include a measurements section; and "vamos a volver a revisar el tema de las restricciones" |
| 11:07–11:19 | **Devcontainer mandatory to orchestrate**; heavy work **always in a separate pool**; after a crash **adopt and reconcile**; remote credentials **a long-lived token** |
| 11:07–11:19 | Container runtime: **Docker or Podman, whichever is there**; reaching the pool: **both** an MCP tool and a `PreToolUse` hook; what is heavy: **what the project declares**; code reaching the pool: **according to the executor** |
| 11:19 | "Veo flecos en el plan y problemas no muy bien resueltos, funcionalidad poco clara" |
| 11:20 | Declined to answer the follow-up questions (containers in phase 1 or not, chats in the pool, how Claudio runs on a server, depth for remote/K8s) |
| 11:22 | Research how modern tools solve it ("hermes, herd, orca.."), in English, Chinese, Russian and French |
| 11:33 | Rejected the same follow-up questions again; asked to research [pando](https://github.com/digiogithub/pando) before closing the research |
| 11:41 | "me he dado cuenta que alguna de mis decisiones no han sido las más acertadas" |
| 11:42 | On the chat's revision of his decisions: they were the changes of someone lazy ("como si fueras un perezoso"); "si fueras un verdadero profesional hubieras tomado otro camino dada la información obtenida" |
| 11:44 | Accepted the method below: "Bien, ahora sí nos vamos entendiendo" |
| 11:53 | "Sí a mi decisión y sí al experimento": the third-party subscription-login policy (§7, D2) is **his decision to take**, and he approved the controlled e2e experiment (§2) |

**The method he accepted at 11:44**, which shapes this document (it is also in the project memory as
`feedback-target-architecture-not-patches`):

1. Stop the bleeding operationally first: reversible host measures, with his approval.
2. Measure before deciding; never defer measurement to "a later phase".
3. Design the end-state architecture first (what remote and Kubernetes need) and make the local
   case a degenerate provider of it, so phases add providers instead of rewriting.
4. Check what the vendor (Anthropic) already ships before building.
5. Validate each critical piece with a short spike.

He rejected the "least-change" path (patches on today's design) as lazy. Several of his 10:57–11:19
choices were taken before the research and are revisited in §5 and §7; none of them was withdrawn by
him in so many words, so each one that the target architecture changes is listed as an open decision.

## 2. The problem as measured

**The machine.** 12 cores, 31,378 MB of RAM, an 8 GB swap file, systemd 259, Node 22.21.1, Claude
Code 2.1.301. The user manager has only the **`cpu memory pids`** controllers delegated
(`cpuset` is not), which is still true after the reboot.

**Checks run at 11:27–11:28.**

| Check | Result |
|---|---|
| `os.availableParallelism()` plain | 12 |
| under `systemd-run --user --scope -p AllowedCPUs=0-1` | 12: `cpuset` is not delegated, so `AllowedCPUs` does nothing here |
| under `systemd-run --user --scope -p CPUQuota=200%` | **2**: Node 22 honours `cpu.max` (the research had said the opposite; libuv ≥ 1.49 reads the quota) |
| Swap | 7.3 GB of 8 GB used |
| Does the CLI escape a transient scope? (a reported bug against 2.1.144, closed "not planned") | **Not reproduced** on 2.1.301 in stream-json mode: it stayed in `claudio-probe-scope.scope` |
| The desktop app's scope (`app-claudio-2425621.scope`) | **6,930 MB, 535 processes, `memory.max = max`**: all of Claudio and every chat's children in one unlimited scope |
| At that moment | another agent was running `E2E_SHARDS=3 pnpm e2e` in the `claudio-designer` worktree |

**Snapshot at 11:44.** Load average 21.2 / 31.8 / 33.8 (1/5/15 min) after 15 days up; CPU PSI
`some` avg10 6.3 %, avg60 43.0 %, avg300 **64.6 %**; memory PSI `some` avg300 0.2 %; I/O PSI ≈ 0;
20,479 MB available; swap 7,890 of 8,191 MB used; `vm.swappiness` 60; **`systemd-oomd` active**,
`earlyoom` inactive, no zram. The biggest swap users were old desktop processes (warp-terminal
682 MB, warp-svc 548 MB, nxnode 219 MB, ollama 149 MB, nxserver 148 MB, pando 135 MB). The top CPU
consumers were about 15 `node --require tsx` test processes of the `claudio-flakyweb` worktree at
about one core each (with `fake-claude.mjs` children): **a unit-test run sizing itself against the
whole machine**, not an e2e run.

**The 20-minute baseline (about 11:46–12:06, 600 samples every 2 s, read-only sampler costing 6 % of
one core).**

| Measure | p50 | p90 | max |
|---|---|---|---|
| Load (1 min) | 19.1 | 31.1 | 37.9 |
| CPU PSI `some10` (%) | 36.7 | **72.7** | 85.3 |
| Memory PSI `some10` (%) | 0.0 | 0.0 | 3.8 |
| Memory PSI `full10` (%) | 0.0 | 0.0 | 3.3 |
| I/O PSI `some10` (%) | 0.0 | 0.1 | 1.5 |
| MemAvailable (MB) | 20,431 | 21,733 | 22,478 |

127 of the 600 samples had CPU pressure above 60 %. Swap traffic over the 20 minutes was 21,872 pages
in and 38,174 out (about 85 and 150 MB): old pages, not active paging.

By worktree (mean CPU % of one core, peak RSS, peak processes): `claudio-flakyweb` 211 % / 8,080 MB /
108; everything outside `~/Escritorio` 90 % / 8,565 MB / 458; `claudio-evalorder` 68 % / 3,275 MB /
67; `claudio-designer` 56 % / 2,441 MB / 41; the main `claudio` checkout 7 % / 2,188 MB / 22. In the
hottest samples `claudio-flakyweb` alone used 5–6 cores.

By kind: tsx test processes 223 % / 3,556 MB / 61; **Chrome 60 % / 9,144 MB / 96**; the Claudio
app 45 % / 618 MB; python3 36 %; `tsc` 12 % / 1,985 MB; the `claude` CLIs 6 % / 1,440 MB / 6;
esbuild 6 %; the e2e runner itself 3 % / 427 MB.

**What was attributed to what.**

- **CPU, not memory, is the bottleneck.** Memory had about 20 GB free all the time; the full swap
  was a leftover of 15 days of uptime.
- **Every tool sizes itself against the whole host.** The e2e runner starts
  `min(4, floor(availableParallelism / 2), groups)` shards (`defaultShardCount` in
  `e2e/shards.mjs`), 4 on this machine, each with its own API server and headless Chrome; the unit
  tests run Node's test runner (`tsx --test`), whose default concurrency follows the core count
  **(added here)**; Vitest, Jest and pnpm do the same (§6, research). Three agents running e2e at once
  meant 12 servers and 12 Chromes, each sure it had 12 cores.
- **Concurrent e2e runs were the cause the owner had seen** (11:07) and the one the code explained.
  **The baseline itself measured unit tests as the largest consumer and Chrome second.** The
  experiment that was to quantify concurrent e2e runs never reported (below).
- Orphans: `terminateTree` (`packages/core/src/processes.ts`) walks the process tree from the CLI's
  pid, so a double fork or a daemon escapes it; only a cgroup kill catches everything.

**What was lost.** At 12:07 the chat started a controlled experiment: one, then two, then three full
e2e suites at once, each in its own `systemd-run --user --scope`, all under a runtime-only
`claudio-exp.slice` (`MemoryMax=14G`, `MemorySwapMax=0`, `CPUWeight=20`), each recording its
`memory.peak`, `pids.peak`, `cpu.stat`, its own CPU and memory pressure and whether its specs
passed (the hypothesis being that contention also produces false failures), with the sampler running
throughout. Round 1 started at 12:07:11; the machine rebooted before any round reported. The slice
lived in `/run/user` and is gone. **The sampler (`sample.py`), the experiment script (`exp.sh`),
`baseline.jsonl`, `exp.jsonl` and every round's logs were in `/tmp/claudio-measure` and were lost with
the reboot**; only the figures quoted in the transcript, reproduced above, remain.

## 3. What changed since, and what remains

**The e2e suite left this machine** ([decisions/e2e-on-github.md](../decisions/e2e-on-github.md),
the owner's decision of 2026-10-17). `e2e/run.mjs` exits 2 unless `CI=true` or `E2E_ALLOW_LOCAL=1`
(the owner's, never an agent's); agents run specs with `pnpm e2e:remote`, which dispatches
`.github/workflows/e2e.yml` on the pushed branch and waits; the shards were balanced (#30) to about
500 seconds of specs each, about 10 minutes per pull request. That removes the cause the owner had
observed and the code explained: e2e runs sizing themselves to the whole machine, four servers and
four Chromes per run, several runs at once.

**Resource control already in the server** ([resource-control.md](../resource-control.md)):
`ChatManager.admit()` refuses a new chat with 409 when `MemAvailable` is under 2,048 MB or memory
PSI `some10` is at or over 20 %; an orchestration task refused that way waits and retries every 3 s;
a stop signals the CLI's descendants and escalates to SIGKILL (`terminateTree`); a task without a
time limit gets 180 minutes; `GET /api/system/load` and `GET /api/system/processes` expose the
readings. Relation to this study: admission is by **memory**, and the measured bottleneck is **CPU**,
which never refuses by design; nothing limits a chat's children while they run (that document says
so: "Claudio cannot cap what the CLI starts without a cgroup"); refusals are polled, not queued;
the stop is pid-based. Each of those is a piece of the target in §5 (admission queue, per-sandbox
budget, cgroup or sandbox destruction), not something to discard.

**What remains.**

- **Agents' own commands.** Unit tests, the type check and the build still run here (the e2e
  decision calls them "light enough"). The baseline says otherwise for unit tests: one worktree's
  test run alone used 5–6 cores at peaks and was the largest consumer.
- **Many parallel chats and orchestrations.** Nothing caps their sum except the chat count
  (`CLAUDIO_MAX_CONCURRENT_RUNS`, 8) and the memory admission.
- **Other tenants of the machine.** A read-only snapshot taken for this document **(added here)**
  at 19:37, after the reboot and with no e2e running locally: load 31.3 / 25.5 / 20.3 (40.9 a minute
  later), CPU PSI `some` avg300 40 %, memory PSI 0, swap empty, 18.6 GB available. The top consumers
  were two `llama-server` processes of ollama (the local embeddings the knowledge base uses), at about
  5 cores together, and a unit-test run with `fake-claude.mjs` children in a worktree under
  `.claude/worktrees/`. CPU saturation outlived the e2e change. One snapshot, not a measurement.
- **Isolation for security and for remote or team use.** The guards are "not a sandbox"
  ([guards.md](../guards.md)); an agent's commands run with the person's rights, see the person's
  files and can reach the API's loopback. Running work on another machine (a server, a worker, a
  teammate's capacity) needs an execution plane that does not exist yet. The e2e change does nothing
  here.

## 4. Stop the bleeding

Proposed in the chat at 11:43 as operational, reversible measures to apply before any architecture,
and each **only with the owner's approval, because they change his systemd configuration**. None
was applied. Their relevance now:

| Measure (as proposed) | Still makes sense? | Needs approval |
|---|---|---|
| **Limits on Claudio's scope**: `MemoryHigh`, `MemoryMax`, `MemorySwapMax=0` on the scope the desktop app runs in (today unlimited: 6.9 GB, 535 processes) | **Yes, as a safety net**, though memory was not the bottleneck. **Add a CPU limit (added here)**: `CPUQuota` on that scope makes every Node child (`tsx --test`, Vitest, `tsc` workers) size itself to the quota, as checked at 11:27 (`CPUQuota=200%` gave 2), because libuv takes the smallest `cpu.max` up the cgroup tree; `CPUWeight` keeps the desktop responsive without shrinking anything. A quota under 200 % counts as 1 CPU. The scope's name changes per launch (`app-claudio-<pid>.scope`), so how to apply it persistently (a drop-in per prefix, or launching the app into a slice of its own) is to be verified. | Yes |
| **A machine-wide cap on simultaneous heavy commands** (proposed for e2e) | **Partly**: e2e no longer runs here; the same cap now applies to whole test suites and builds. Without the architecture it can only be a wrapper or convention; the per-scope `CPUQuota` above does most of the work at no code cost. | Yes, if it touches the person's shell or systemd |
| **`systemd-oomd` or zram**, so the system kills or compresses instead of paging to disk | `systemd-oomd` **is already active**, but no Claudio slice tells it what to watch (`ManagedOOMMemoryPressure=kill` on a slice). zram would replace a swap file that held only old pages. Low value while memory has room; keep as the memory-side net. | Yes |
| `MemorySwapMax=0` on heavy work (from the Russian/French research) | Yes, inside any scope that runs tests or browsers, so a runaway job is killed inside its box instead of dragging the host into swap. | Yes |
| `systemd-run --collect` (same source) | Yes for any transient unit Claudio or a script creates, so failed units do not pile up. | No (no persistent change) |

Every measure can first be applied with `--runtime` (it disappears at the next reboot) and measured,
then made persistent.

## 5. The target architecture

Reached at 11:43, after the owner rejected the least-change design. Every serious system the
research found has the same shape (Cursor, Copilot, Jules, Devin, OpenHands, Herd, OpenSandbox,
agent-sandbox): a **control plane** and an **execution plane**, separated.

- **Claudio is the control plane only**: queue, budgets, state, the API and the UI.
- **Each task runs entirely in its sandbox, with the CLI inside.** A small **Claudio runner** in the
  sandbox starts `claude`, holds its stream-json pipes, and relays them to Claudio over a channel
  (a local socket, HTTP or iroh). The CLI is still reached only through its flags, its stream, its
  control protocol, its hooks and the files it writes: only where the process runs changes.
- **Sandbox providers behind one interface.** The research found E2B's lifecycle API becoming a de
  facto standard (OpenSandbox, Tencent's CubeSandbox and Moonshot's AgentENV clone it). The
  implementations, one per phase (§9):
  1. **a host cgroup scope or slice**, no Docker, which keeps the owner's "works without Docker";
  2. Podman or Docker;
  3. a remote worker;
  4. Kubernetes, with `kubernetes-sigs/agent-sandbox`.
- **The local case is the degenerate provider**: same runner, same channel, same events, with the
  sandbox being a systemd scope on the same machine.

**Why this shape, against the patch it replaced** (the chat's own table):

| Problem | The patch (host CLI, `CLAUDE_CODE_SHELL_PREFIX` wrapper) | Runner + provider |
|---|---|---|
| Adoption after a crash | Impossible; only `--resume` | The runner holds the pipes, not Claudio; Claudio reconnects and the CLI does not notice |
| Credentials | Mount the config dir | A proxy injects them, or a long-lived token remotely; one mechanism everywhere |
| Transcripts, hooks, MCP | Same paths and exceptions in the wrapper | The runner bundle carries guards and MCP, and returns the JSONL the CLI writes |
| Heavy jobs | A separate subsystem with hooks | **One more sandbox, of class "heavy"**, with its queue, budget and snapshot |
| Orphans | `cgroup.kill` locally | Destroy the sandbox, the same in every provider |
| Phases | Rewrite at phase 3 (the prefix only works when the CLI is on the same machine as the box) | Only add providers |

**How Claudio's pieces map onto it.** Rows marked **(added here)** were not discussed in the chat.

| Piece | Where it goes |
|---|---|
| **Interactive chat** | A sandbox of class "chat" inside a shared budget for chats (the owner: chats get limits, not containers). Locally, the host-scope provider. |
| **Orchestration** | A **budget** (a slice per orchestration, `claudio-orch-<id>.slice`) holding **one sandbox per task**, not one box per orchestration: work items' worktrees are created mid-orchestration (`packages/core/src/work-links.ts`), and a running container cannot gain bind mounts. Containers join the orchestration's slice with `--cgroup-parent`. This keeps the owner's "the unit is the orchestration" as the unit of budget. |
| **Worktrees** | Locally the sandbox sees them where they are (`<main checkout>/.claude/worktrees/…`). In a container the main repository's `.git` must be mounted read-write **at the same absolute path**, because a worktree's `.git` file holds an absolute `gitdir:` (or `worktree.useRelativePaths`, which older git refuses). Remotely, git is the content protocol: the worker clones or fetches the branch and pushes back; a bare mirror served by Claudio over iroh avoids pushing half-done branches to GitHub. A shared volume (NFS/PVC) was rejected: git and SQLite locks misbehave on NFS. |
| **Credentials** | Out of the sandbox: a proxy outside the boundary injects them (`ANTHROPIC_BASE_URL`, or a Unix socket mounted into a `--network none` container), as Docker Sandboxes, CubeEgress and OpenSandbox do and Anthropic's secure-deployment guide recommends. Remotely, the owner chose a long-lived token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`). Sharing one config dir between processes races on OAuth refresh (one process ends signed out), which the proxy also avoids. Accounts and `limit-resume`'s switch are resolved when each task's sandbox starts. Subject to D2 and D7. |
| **MCP and guards** | Today both are host paths: the guards' hooks are a `node <host path>/guard.mjs` command (`buildSettings` in `packages/core/src/guards/files.ts`) and Claudio's MCP server is a stdio `node mcp.mjs` (`packages/core/src/claudio-mcp.ts`, `CLAUDIO_MCP_ENTRY`). Inside a sandbox they come from a read-only **runtime bundle** (node, `guard.mjs`, `mcp.mjs`, the CLI) that the runner provides, since a project's environment may have no node. |
| **The API from inside** | `CLAUDIO_API_URL` is the host's loopback today (`packages/core/src/chats.ts`); inside a container loopback is the container. The runner's channel (or a mounted socket or `host-gateway`) carries it, with the chat token as today. |
| **Event stream** | The runner relays the CLI's stream-json with sequence numbers and keeps a buffer; Claudio folds it exactly as now and serves its existing SSE feeds (`GET /api/events`, `GET /api/chats/:id/stream`, [api-wire.md](../api-wire.md)). Transcripts the CLI writes come back to Claudio (the one rule allows reading them; the Agent SDK's SessionStore, or a JSONL sync of our own). |
| **Stop and process stats** | From the provider, not from a pid walk: once the CLI is under `docker exec` or a remote runner, Claudio's child is a client, and `terminateTree` and `GET /api/system/processes` see nothing useful. cgroup counters (`memory.current`, `cpu.stat`, `pids.current`) or the runtime's stats instead. |
| **Heavy jobs** | A sandbox of class "heavy" with its own queue and budget: admission answers "busy, retry" (OpenSandbox's 429) instead of overcommitting; the code is a **git snapshot** (a temporary worktree locally), because the agent keeps editing while the job runs; Playwright's `workers` is set explicitly, since it ignores quotas; freezing is allowed only here. Reached transparently by a `PreToolUse` hook rewriting the command (`updatedInput`) into a queue client; the guarantee is the budget, not the hook (a hook does not see `node e2e/run.mjs` or `make test`). |
| **Ports** **(added here)** | A host scope does not isolate ports; a block of ports per sandbox exported as variables (Conductor's 10 per workspace, uzi's `portRange`) until a container provider gives each its own network. |
| **The terminal** **(added here)** | The person's own shell for a chat ([terminal.md](../terminal.md)) opens where the chat's worktree is, through the provider's exec; with the host-scope provider that is today's behaviour. |

**At a limit.** The owner's "pause and queue", made workable: freezing a cgroup does not free RAM, and
a frozen CLI keeps an API stream whose peer times out, so the layers are an **admission queue**
before a task starts, `MemoryHigh` to slow a box instead of killing it, `MemorySwapMax=0`, **freeze
only for heavy jobs** waiting for a slot (never a CLI), and `MemoryMax` as the last resort. A paused
or queued orchestration shows as warn (stopped or near a limit) in the UI.

**Reconnection after a crash.** Today a Claudio crash or restart kills every running chat: the CLI's
stdio pipes belong to Claudio, the CLI reads EOF and exits, and only `--resume` remains. With the
runner holding the pipes:

1. The runner keeps a lease with Claudio by heartbeat, modelled on Anthropic's self-hosted runner
   (a lease that lapses after about 60 s, one owner per runner).
2. Every event is written to a durable log with a sequence number **before** it is relayed, and a
   cursor confirms what Claudio processed (Pando's `events.jsonl` pattern); after a gap the runner
   replays from the cursor.
3. Claudio **re-sends `initialize`** over the same stdio: the documented way to re-sync after a
   transport gap. The answer carries `pending_permission_requests` (CLI 2.1.268 or later; 2.1.301 is
   installed), and the CLI re-sends its background-task snapshot.
4. Sandboxes, slices and runners are recorded as rows in SQLite and reconciled at start: reconnect,
   or kill and `--resume`, or clean up. After a SIGKILL-class stop, the 0-byte placeholder files the
   CLI leaves under `.claude` are cleaned (`claude doctor` lists them), and metadata is deleted only
   after the sandbox and worktree are really gone (Orca's orphan bug, #8613).
5. If the runner itself dies, the CLI dies with it; the fallback is `--resume` on a fresh sandbox,
   which restores the conversation but not unpushed work, so a sandbox pushes or snapshots before it
   is released.

This is the owner's "adopt and reconcile", which the first design could not deliver.

**What the 11:20 review found, and where it lands.** The chat reviewed its first plan against the
code at the owner's "flecos" and found these; they are kept here because each is a requirement of a
container or remote provider.

| # | Finding | In the target |
|---|---|---|
| A1 | Inside a container you cannot freeze the children without the CLI (`docker pause` freezes all) | Freeze only heavy sandboxes; the queue lives in the heavy pool |
| A2 | Guards hooks, Claudio's MCP, `CLAUDIO_API_URL` and the transcripts' path are tied to the host | Runtime bundle, runner channel, transcripts returned by the runner |
| A3 | Worktrees need the main `.git` at the same path, and appear mid-orchestration | One sandbox per task under the orchestration's budget |
| A4 | Under `docker exec`, Claudio's child is the client; stop and stats break | Stop and stats from the provider and cgroups |
| A5 | The CLI cannot be adopted after Claudio dies | The runner holds the pipes |
| A6 | Root Docker writes root-owned files into the worktree | `--user $(id -u):$(id -g)` or rootless Podman `--userns=keep-id` |
| A7 | `pnpm install` in a container rebuilds native modules (`node-pty`, `better-sqlite3`) for its libc, breaking the host's worktree | Same base distro as the host, or a per-container store |
| B1 | Neither Claudio nor the owner's projects have a `.devcontainer`; mandatory devcontainers stop every orchestration | Open: D4 |
| B2 | The pool was undefined: where, how many, order, task time limits while queued, what code it tests | Heavy sandbox class: same providers, its own queue and budget, git snapshot |
| B3 | A hook is not a guarantee (`node e2e/run.mjs`, `make test` pass it); Bash and MCP timeouts vs a long job | The budget is the guarantee; timeouts checked (§6): MCP tools ~28 h, background Bash 30 min default in stream-json, extendable |
| B4 | "Budget" undefined: reservation or limit, overcommit, how admission sums it | To define with the measurements (M1, S2) |
| B5 | Chats sharing one box choke each other | Open: D5 |
| B6 | `limit-resume` switches accounts mid-orchestration | Resolved per task when its sandbox starts |
| B7 | UI missing: runtime present, budget and use, reason for a pause, the queue, the devcontainer build | Needed by phase 1; through the design system (`claudio-ui`) |
| B8 | Claudio in Docker on a server needs the Docker socket (root on the host) and host-path mapping | Open: D6 |
| B9 | Remote and K8s only sketched: transcripts back, hooks/MCP/API from a worker, trust model | Runner + channel; trust model open: D7 |

## 6. Vendor first: what Anthropic ships

Researched at 11:44–11:48 against the official docs. The finding: **nothing gives Claudio an
execution plane ready-made, but official pieces cover the most delicate parts.** The quotations
below are the research's, from the cited pages on 2026-10-17; they were not re-fetched for this
document.

**What fits.**

- **The Agent SDK's `spawnClaudeCodeProcess(options: SpawnOptions) => SpawnedProcess`** is documented
  as "Use to run Claude Code in VMs, containers, or remote environments", and the process it expects
  is only stdin, stdout, kill and exit. "The Agent SDK spawns and supervises a `claude` CLI
  subprocess … talks to it over stdio", which is Claudio's model. **It is the runner's contract.**
  ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
  [hosting](https://code.claude.com/docs/en/agent-sdk/hosting))
- **Re-sending `initialize` to reconnect.** `reinitialize()` "Re-sends the `initialize` control
  request to the running CLI … Use it after a transport gap, such as reattaching to a session after a
  disconnect, so pending permission requests reach your `canUseTool` callback again." The answer
  carries `pending_permission_requests` (v2.1.268 or later), and the CLI re-sends a background-task
  snapshot after a repeated `initialize`. No resync protocol of our own is needed. Claudio already
  reads the `initialize` answer for each account's model list (`packages/accounts`).
- **The self-hosted runner's operating rules, as a model**: a heartbeat lease that lapses after about
  60 s, drains (`--drain-wait-sec`, `--retire-at`), `--push-outcome-on-release`, one owner per
  runner, per-session containers at capacity 1, `/healthz` reporting `last_poll_age_ms`.
- **A credential-injecting proxy is Anthropic's own guidance**: "run a proxy outside the agent's
  security boundary that injects credentials", through `ANTHROPIC_BASE_URL`, a host proxy reached
  over a mounted Unix socket from a `--network none` container, or Envoy's `credential_injector`;
  also [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (beta).
  ([secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment),
  [authentication](https://code.claude.com/docs/en/authentication))
- **SessionStore** (`append`/`load`, adapters for S3, Redis, Postgres) mirrors transcripts (not
  `CLAUDE.md` or working files; best-effort writes; resume needs the same `cwd`), and
  `--fork-session` makes a new session id. Sessions are "same machine only" without a store or
  moving the JSONL. ([session storage](https://code.claude.com/docs/en/agent-sdk/session-storage),
  [sessions](https://code.claude.com/docs/en/agent-sdk/sessions))
- **`claude agents --json`** is the supported way to read local background sessions (already a row
  in [cli-surfaces.md](../cli-surfaces.md)).
- **Headless credentials.** `claude setup-token` makes a one-year OAuth token for
  `CLAUDE_CODE_OAUTH_TOKEN` that "can only make model requests" and is not read under `--bare`;
  `apiKeyHelper` re-runs after a 5-minute TTL or on 401/403; precedence is cloud provider,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, profiles,
  `/login`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from Bash, hook and MCP child
  environments.

**What was rejected as the execution plane, and why.**

| Offering | Why not |
|---|---|
| **Self-hosted environments** for cloud sessions (public beta; `claude self-hosted-runner`) | "The control plane remains Anthropic-hosted" and the UI is claude.ai, so Claudio would be a dispatcher with no live stream; it "doesn't support `--output-format stream-json`"; Team and Enterprise only, off by default; no API keys and no long-lived CI token (30-day cap); after a runner stops polling the session is requeued on a fresh clone and "Resumed sessions lose unpushed work". Still the best reference for how a runner should behave. ([overview](https://code.claude.com/docs/en/self-hosted-environments), [reference](https://code.claude.com/docs/en/self-hosted-environments-reference)) |
| **Remote Control** (`claude remote-control`, `--remote-control`, `/rc`) | A feature for a person's UI at claude.ai, with no protocol documented for programs; survives the viewer leaving but not the local process; no API keys, and a `setup-token` token cannot open it; off when `ANTHROPIC_BASE_URL` points elsewhere. ([remote-control](https://code.claude.com/docs/en/remote-control)) |
| **Managed Agents self-hosted sandboxes** (beta, `managed-agents-2026-04-01`) | The agent loop runs at Anthropic and only tool calls run on the worker; it does not run the Claude Code CLI, so transcripts, hooks and stream-json would all go. Its platform guides (E2B, Modal, Daytona, Cloudflare, Fly.io, Vercel, GKE, AWS Lambda) are only relevant if a non-CLI provider is ever added. ([self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)) |
| **`claude daemon`** (behind `--bg`, `claude attach`, `logs`, `stop`, `respawn`) | Local only; "The files under `~/.claude/jobs/<id>/` are not a stable interface" and its socket protocol is undocumented. ([agent view](https://code.claude.com/docs/en/agent-view)) |
| **`--sdk-url`** | Not in the official CLI or environment reference; seen only in third-party mirrors as an internal flag of Remote Control. Using it would break the one rule. |
| **`claude serve`** | Does not exist. |
| **Claude Code's own sandbox** (bubblewrap/Seatbelt; `sandbox-runtime`) | Filesystem and network only, **no CPU or memory limits**; covers Bash and its children, not file tools, MCP or hooks. Useful inside a sandbox, not as one. ([sandboxing](https://code.claude.com/docs/en/sandboxing)) |

**Claude Code facts the design relies on** (the research's, from
[tools-reference](https://code.claude.com/docs/en/tools-reference),
[env-vars](https://code.claude.com/docs/en/env-vars) and [hooks](https://code.claude.com/docs/en/hooks)):

- Background Bash in unattended sessions (`-p`, SDK, stream-json) has a 30-minute default limit,
  2 hours at most, raised only through `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`; foreground
  Bash defaults to 120 s (600 s max) and moves to the background instead of being killed; background
  commands outlive the final response.
- The CLI reaps background shells under critical memory pressure after 30 idle minutes
  (`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`); `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns them
  off.
- `MCP_TOOL_TIMEOUT` defaults to about 28 hours; HTTP/SSE MCP servers have a 60 s per-request timeout;
  stdio servers none.
- `PreToolUse` `updatedInput` replaces the whole tool input, and permission rules are evaluated
  against the rewritten input; a timed-out hook does not block unless `"onFailure": "block"`.
  `Stop`/`SubagentStop` hooks receive `background_tasks` and `session_crons`.
- `CLAUDE_CODE_SHELL_PREFIX` wraps Bash tool calls, hook commands, status-line commands and stdio MCP
  startups ("The wrapper receives the command line as a single shell-quoted argument in `$1`";
  PowerShell and exec-form hooks run without it). This was the basis of the superseded design (§5).
- bwrap fails inside an unprivileged container (`enableWeakerNestedSandbox` needed); Ubuntu 24.04+
  AppArmor blocks its user namespaces without a profile; `.claude.json` lives outside `~/.claude`, so
  mounting only the directory loses login and trust state (`CLAUDE_CONFIG_DIR` fixes it).

**Fit with the one rule, and a tension in our own docs (added here).** [CLAUDE.md](../../CLAUDE.md)
allows "the vendor's official SDK"; [providers.md](../providers.md) says "No SDK, no HTTP call to
Anthropic". The runner can implement `spawnClaudeCodeProcess`'s contract without depending on the
SDK, and the `initialize` re-send is the CLI's control protocol, which both texts allow. A
credentials proxy on `ANTHROPIC_BASE_URL` would put a Claudio process in the CLI's HTTP path to
Anthropic, which providers.md's wording does not foresee. See D2 and D8.

**The policy risk the research found.** Anthropic's text, as quoted: "Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or rate limits for their
products, including agents built on the Claude Agent SDK." Claudio uses subscriptions of several
accounts, and no official document describes a proxy injecting a subscription OAuth bearer rather
than an API key. The chat said a decision on this must be written down before the proxy is designed,
and that the decision is the owner's, not a technical one; the owner said it is his (11:53). D2.

## 7. Open decisions for the owner

**Owner, 2026-10-17:** D1 — no host limits for now. D3 — parked: the study stays documented here and is taken up later. D4 to D8 — the owner reviews them in this pull request. D2 stays his, unanswered.

**D1. Host limits now?** Apply the measures of §4 to his session's systemd configuration?
Options: (a) approve the CPU-side measures (`CPUQuota` and `CPUWeight` on the scope Claudio runs in)
plus the memory safety net (`MemoryHigh`, `MemoryMax`, `MemorySwapMax=0`), first with `--runtime`;
(b) approve only the CPU side; (c) none until the spikes have measured footprints. **Recommendation:
(a), runtime-only first**: the measured bottleneck is CPU, a quota makes Node children size
themselves to it with no code change, and a runtime change disappears at the next reboot if it hurts.

**D2. Subscription login for a third-party program.** Claudio drives the CLI with the owner's
claude.ai subscriptions on several accounts; the credentials proxy and remote workers would extend
that. The chat quoted Anthropic's text (§6) and left the decision to him; he took it as his. Options
the chat had on the table: keep subscription accounts as today and decide whether the proxy and
remote workers may carry them; use `setup-token` tokens for workers (the owner's earlier choice for
remote credentials); use API keys for sandboxed and remote work; or ask Anthropic for the prior
approval the text mentions. **No recommendation on the policy itself**, as agreed. Technically:
record the decision before spike S3, and run S3 with an API key so it does not depend on the answer.

**D3. Pursue the target architecture now, and which phase first?** The e2e change removed the
observed trigger, so the urgency is lower (the e2e decision says the same). Options: (a) the full
phase 1 now (runner and host-scope provider); (b) only stop the bleeding and re-measure, and park
the architecture; (c) the runner first, with today's spawn as its provider, and the cgroup scope
after; (d) jump to a remote-worker provider for team use. **Recommendation: (b) then (c)**: apply D1,
re-run the lost measurement on the new load (M1), and spike the runner reconnect (S1), because the
runner pays off locally on its own: today a Claudio restart (an app update, a crash) ends every
running chat, and with the runner it would not.

**D4. Devcontainer mandatory to orchestrate?** His 11:07–11:19 choice; neither Claudio nor his
projects have one, and a cold image build is slow (Sculptor's reported pain). Options: (a) keep it
mandatory, with a default devcontainer Claudio generates; (b) optional: the project's environment is
an attribute of the container provider, used when the project has one and Podman or Docker exists;
(c) never. **Recommendation: (b)**, which is what the chat proposed at 11:41.

**D5. Do interactive chats use the heavy pool too?** Options: (a) yes, every chat's heavy commands
go through one queue; (b) only orchestrations; chats keep only their budget. **Recommendation: (a)**:
one source of truth for the host (the chat's recommendation, never answered).

**D6. How Claudio runs on a server.** Options: (a) native, as a systemd service, with the same
host-scope provider as the desktop; (b) in Docker with the Docker socket (root on the host, and
host-path mapping); (c) straight to the Kubernetes provider. **Recommendation: (a)** (the chat's,
never answered); the container image keeps serving what it serves today.

**D7. Who may ask a remote worker for work?** A worker is a different trust model from Collaborators,
which is read-only on purpose ("nobody can start work on another person's machine"). It would reuse
iroh's transport and identity, not the groups' semantics. Options: (a) only installs of the same
owner (his own keys); (b) members of a group the worker's owner names, with a separate grant; (c)
token-based, like the API. **Recommendation: (a) for the first remote provider**; widening it is a
decision of its own.

**D8. The runner's contract and the one rule.** Options: (a) implement `spawnClaudeCodeProcess`'s
contract (stdin, stdout, kill, exit) in our runner with no SDK dependency; (b) depend on the Agent
SDK and reconcile providers.md's "No SDK" with CLAUDE.md. **Recommendation: (a)**; and whatever D2
decides about the proxy, update providers.md and [cli-surfaces.md](../cli-surfaces.md) with a row
for it before it is built.

## 8. Spikes and measurements

Each spike is one or two hours, as the chat sized them.

**M1. Re-run the lost measurement.** Question: what does the host carry now that e2e runs on GitHub,
and what is the footprint of one task (CLI, its tests, its build)? Pass: a 20-minute baseline and a
controlled run of 1, 2 and 3 concurrent unit-test suites (`pnpm test`) and builds, each in its own
scope under a runtime-only slice with a protective cap, recording `memory.peak`, `pids.peak`,
`cpu.stat`, per-scope pressure and pass/fail, with the sampler kept somewhere that survives a reboot
(not `/tmp`). Cost: about an hour, and some CPU contention with running agents. An e2e round is the
owner's to run (`E2E_ALLOW_LOCAL=1`), never an agent's.

**S1. The runner survives Claudio.** Question: can a runner hold the CLI's stdio while Claudio is
killed and restarted, and can Claudio re-sync? Pass: `kill -9` Claudio mid-turn with a permission
request pending and a background task running; on restart Claudio reconnects, re-sends `initialize`,
gets the pending request in `pending_permission_requests` and the background-task snapshot, receives
the buffered events with no gap and no duplicate (sequence numbers), and the turn completes with the
same CLI pid. Cost: 1–2 hours.

**S2. A host-scope provider with heavy commands inside.** Question: does a systemd scope per task
(and a slice per orchestration) contain an agent's heavy commands and clean up completely? Pass:
with `CPUQuota`, `MemoryHigh`/`MemoryMax`, `MemorySwapMax=0` and `TasksMax`, three concurrent
`pnpm test` and `pnpm build` runs see their scope's cores (`availableParallelism`), host CPU pressure
stays under a threshold set from M1, the desktop stays responsive; the CLI stays in its scope (the
2.1.144 escape bug, checked after every start); stopping the unit leaves zero processes, double forks
included; `claude doctor` shows no placeholder files after a kill. Cost: 1–2 hours.

**S3. The credentials proxy.** Question: can the CLI in a sandbox run with no credential inside it?
Pass: a turn completes through a proxy outside the sandbox (`ANTHROPIC_BASE_URL`, or a mounted Unix
socket with `--network none`); no token is found in the sandbox's environment or files;
`rate_limit_event` and usage still arrive; whatever the proxy disables (Remote Control, some
defaults) is listed. Run first with an API key; with a subscription token only after D2. Cost: 1–2
hours.

**Named in the chat, now dropped or done.**

- The three checks of the `CLAUDE_CODE_SHELL_PREFIX` design (the persistent shell's state surviving
  the jump into the box, background commands staying in it, telling a Bash call from an MCP startup):
  dropped with that design.
- The CLI escaping a transient scope: checked at 11:28, not reproduced on 2.1.301; kept as a
  regression check in S2.
- The proofs of concept offered before 11:07 (a scope per orchestration, a devcontainer, cleanup by
  `cgroup.kill`): the owner chose a study instead; S2 covers the first and third.

## 9. Phases

Each phase adds a provider behind the same interface; none rewrites the previous one.

| Phase | Adds | Delivers |
|---|---|---|
| **0. Stop the bleeding** | No code: D1's host limits, M1 | A host that does not freeze; measured footprints to size budgets |
| **1. Runner and host-scope provider** | The runner (holds stdio, durable sequenced log, lease, `initialize` re-sync), the provider interface, the host cgroup provider (scope per task, slice per orchestration and one for chats), the admission queue, the heavy class with its queue and git snapshots, stop and stats from cgroups, reconcile at start, the UI for budgets, pauses and the queue | Claudio restarts without killing chats; budgets per orchestration; no orphans; heavy jobs queued instead of stacked; works without Docker |
| **2. Container provider** | Podman or Docker, whichever is there: same-path mounts, `keep-id`/`--user`, `--init`, `--cgroup-parent` to the orchestration's slice, the runtime bundle, the credentials proxy over a Unix socket, the project's devcontainer when it has one (D4), ports of its own | The project's environment; credentials out of the box; isolation of files, ports and network |
| **3. Remote worker provider** | The runner dialling out (HTTP or iroh), git as the content protocol (direct to `origin` or a Claudio mirror over iroh), long-lived tokens or the proxy (D2), transcripts back, the worker trust model (D7) | Work on other machines, behind NAT, with the same UI and events |
| **4. Kubernetes provider** | `kubernetes-sigs/agent-sandbox` (`SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`), runc or Kata (gVisor's file I/O is 10–200× slower for open/close-heavy work, which pnpm and Vitest are) | Scale beyond one machine; warm pools hide start time |

## 10. How the design moved during the chat

Kept so the reasoning is not lost; each step is superseded by §5.

1. **10:57–11:19, restrictions R1–R11**: the orchestration as the unit; chats on the host with
   limits; no Docker locally (cgroups v2 with `systemd-run --user`); devcontainer mandatory to
   orchestrate; mount the config dir locally, long-lived token remotely; pause and queue in layers;
   a separate heavy pool reached by MCP plus a `PreToolUse` hook; git for content and iroh or HTTP
   for control; `cgroup.kill` and adoption after a crash; phases behind one executor interface; the
   one rule unchanged; a measurements section.
2. **11:20, the review against the code** (A1–A7, B1–B9 in §5), concluding that saturation and
   orphans can be solved without containers, and that containers bring the project's environment,
   isolated ports and the road to remote.
3. **11:28, three layers after the research**: L1 budgets (slices per orchestration and for chats,
   a reserve for the desktop, `CPUQuota` since Node honours it), L2 the heavy pool, L3 executors by
   phase, and a lifecycle of reconciliation.
4. **11:3x, after Pando**: keep the CLI on the host and put only its commands in the box through
   `CLAUDE_CODE_SHELL_PREFIX`, which fixed A2, A4 and A5 locally.
5. **11:41, a revision of the owner's decisions**, which he called lazy at 11:42: it was a dead end
   for phases 3 and 4, since the prefix only works when the CLI and the box share a machine.
6. **11:43, the target architecture** of §5, with the five-step method of §1.

## Appendix: what the rest of the field does

Eight research reports (11:23–11:48), each marking verified and inferred claims; about 40 tools in
five languages. The field splits in three families, and **none solves one local host with many
agents**:

| Family | Examples | Isolates | Resource limits |
|---|---|---|---|
| Worktree managers | Orca, Conductor, Vibe Kanban, Claude Squad, uzi, Superset | Files (sometimes ports) | None |
| Vendors' local sandboxes | Claude Code (bwrap), Codex (bwrap + seccomp), Gemini and Qwen (Docker/Podman), Devin CLI | Files and network | None |
| Cloud microVM or container | Cursor, Jules, Devin, Copilot, E2B, OpenSandbox, CubeSandbox, AgentENV, agent-sandbox | Everything | Per VM or pod, with warm pools and snapshots |

**Patterns worth copying.**

- **Herd** ([runners](https://github.com/herd-os/herd/blob/main/docs/runners.md)): ephemeral one-job
  workers with a concurrency cap separate from pool size; partial work pushed before the hard
  timeout; `CLAUDE_CODE_OAUTH_TOKEN` per runner; replicas add build capacity, not LLM throughput on
  one subscription.
- **Hermes Agent** ([tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools),
  [docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)): pluggable backends (local,
  docker, ssh, singularity, modal, daytona, vercel_sandbox) with default limits (1 CPU, 5,120 MB,
  pids 256), a hardened container; but one container shared by all subagents.
- **Conductor** ([scripts](https://conductor.build/docs/reference/scripts)): a block of 10 ports per
  workspace; setup, run and archive scripts.
- **Docker Sandboxes** ([get started](https://docs.docker.com/ai/sandboxes/get-started.md)): a
  microVM with its own Docker daemon; credentials stay on the host and a proxy injects them;
  deny-by-default network; `--cpus` and `--memory`.
- **Alibaba OpenSandbox** ([repo](https://github.com/alibaba/OpenSandbox),
  [operator](https://github.com/alibaba/OpenSandbox/blob/main/docs/architecture/control-plane/operator.md)):
  one lifecycle API on Docker locally and Kubernetes in production; a warm pool paced at 25 % per
  pass; a retryable 429 when no pool has room, rechecked every 5 s; a `postStop` hook on every
  outcome; a hard `expireTime`; a credential vault.
- **Tencent CubeSandbox** ([repo](https://github.com/TencentCloud/CubeSandbox)) and **Moonshot
  AgentENV** ([repo](https://github.com/kvcache-ai/AgentENV)): microVMs starting in under 60 ms and
  50 ms (vendor figures), copy-on-write snapshots and forks, idle pause; both E2B-compatible.
  CubeEgress injects credentials at the egress gateway.
- **Alibaba ROCK** ([paper](https://arxiv.org/html/2512.24873v3)): agents in RL training opened a
  reverse SSH tunnel and mined cryptocurrency, first-hand evidence for egress control.
- **SWE-MiniSandbox** ([paper](https://arxiv.org/html/2602.11210v1)): container-free isolation (mount
  namespace and chroot) with concurrency capped by a disk-I/O budget.
- **Orca** ([#8613](https://github.com/stablyai/orca/issues/8613)): deleting metadata before the
  worktree and its processes were gone left orphans that could not be retried.
- **Pando** (studied at 11:33, MIT, Go): a per-command host sandbox on by default (bwrap, Landlock,
  seccomp; Seatbelt; Job Objects), a portguard that stops confined commands reaching its own ports
  and the Docker and systemd sockets ("without it, `systemd-run` from inside would be an escape"), a
  runtime per session (host, docker, podman, embedded) with `cpu_limit`, `mem_limit` and
  `pids_limit` 512, a subagent orchestrator with claim-leases and fork-bomb caps, and a durable event
  log written before broadcast with a cursor. It has no cgroups, no heavy-job pool, and its process
  groups are escaped by `setsid` as our pid walk is.

**Kernel, systemd and tool behaviour** (verified by the research unless noted):

- `MemoryHigh` throttles and never calls the OOM killer; `MemoryMax` is "the last line of defense";
  `TasksMax` counts threads; `cgroup.kill` kills the whole subtree, concurrent forks included; a
  frozen cgroup keeps its memory and sockets ([cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html),
  [systemd.resource-control](https://man.archlinux.org/man/systemd.resource-control.5.en)).
- Delegating `cpuset` and `io` to the user manager needs a `user@.service` drop-in and a re-login
  (third-party guide, [rootlesscontaine.rs](https://rootlesscontaine.rs/getting-started/common/cgroup2/)).
- libuv's `uv_available_parallelism()` takes affinity and then the smallest `cpu.max` up the cgroup
  tree (libuv 1.49+; Node 22 bundles 1.51), rounding down with a minimum of 1
  ([libuv](https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c)); Vitest and Jest use it
  (`availableParallelism() - 1`); **Playwright's default `workers: '50%'` uses `os.cpus().length` and
  ignores quota and affinity**; pnpm's `workspaceConcurrency` is the smaller of 4 and the cores.
- The GNU make jobserver (also Cargo, Ninja 1.13) is the established protocol for sharing one token
  pool across nested tools: a candidate protocol for the heavy queue.
- `docker exec`'d processes survive their client; use `--init` and kill through the cgroup. The
  `docker` group is root-equivalent; never mount the socket into an agent's box.
- Freezing is not a checkpoint: the Anthropic stream's peer times out during a long freeze.
- Russian and French sources had little primary material; the useful items were
  `MemorySwapMax=0` for heavy slices, `systemd-run --collect`, and Mistral's Vibe Code Web (one
  single-tenant sandbox per session, treated like a CI job with least-privilege credentials).

## Related

[[resource-control.md]] · [[plans/resource-control.md]] · [[decisions/e2e-on-github.md]] · [[providers.md]] · [[cli-surfaces.md]] · [[accounts.md]] · [[guards.md]] · [[security-model.md]] · [[chat-environment.md]] · [[claudio-mcp-server.md]] · [[terminal.md]] · [[api-wire.md]] · [[orchestrations.md]] · [[work-items.md]] · [[collaborators.md]] · [[plans/collaborators.md]] · [[deploy.md]] · [[plans/verify-faster.md]] · [[plans/ci-e2e-shards.md]] · [[plans/e2e-flakes-under-load.md]] · [[status.md]]
