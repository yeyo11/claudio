// End-to-end suite: boots an ISOLATED wrapper (temp config/workspace/data dirs, built UI) and
// drives it with headless Chrome. It never touches the real ~/.claude.
//   pnpm build && pnpm e2e              all specs
//   pnpm e2e config palette             only some
//   E2E_LIVE=1 pnpm e2e chat            specs that talk to Claude (needs a logged-in CLI; costs tokens)
// A hung run cannot outlive its limits: E2E_SPEC_TIMEOUT (ms, per spec; a spec may export `timeout`)
// and E2E_TIMEOUT (ms, whole run). The server and the browser are closed on every way out (end,
// failure, timeout, SIGINT/SIGTERM/SIGHUP, uncaught error), by the PID of what this run started.
// E2E_SPECS_DIR runs the specs of another directory (the harness's own test uses it); E2E_KEEP=1
// keeps the temporary sandbox for inspection.
// A spec that exports `fakeCli = true` runs against the fake `claude` of e2e/fake-cli instead of the
// real one: the server is restarted with it first on PATH, and those specs run after every other,
// so a spec that did not ask never sees it. See e2e/fake-cli/README.md.
// Claudio's own release check never reaches GitHub: CLAUDIO_RELEASES_URL points at a fixture served
// here, whose tag a spec sets through `releases.set(tag)`. The daily check is off, so only a spec
// that presses Check for updates (or posts /system/release/check) learns of a release.
// Shards: E2E_SHARD=k/N runs only shard k of N (1-based) in this process, which is what each CI
// matrix job does. E2E_SHARDS=N runs all N at once as children, each with its own sandbox, port and
// Chrome, and prints one report in the order a single run would (default: one shard per two cores,
// at most 4, never more than there are groups; E2E_PORT, when set, is the first of N ports). The
// split is greedy longest-first over e2e/timings.json (seconds per spec, checked in so every CI job
// computes the same split; a spec missing from it weighs the median), and every fakeCli spec stays
// in one shard, behind one restart of its server. See e2e/shards.mjs.
// Collaborators (docs/plans/collaborators.md, C4): a spec that exports `peers = ['ben', …]` gets one
// more wrapper per name, each with a sandbox, a port and a fake `claude` of its own, started before
// it and stopped after it; its context gains `peers.<name>` (`api`, `dirs`, `fakeCli`, `baseUrl`,
// `page`, the same browser tab with `goto` aimed at that wrapper, `openTab()`, a tab of its own at
// that wrapper, for a page that must stay loaded while another install acts (its console errors fail
// the spec, it is captured on a failure and closed after the spec), and `restart()`, which starts its
// server again on the same port and directories). Every spec's context also has `capture(label)`,
// the failure screenshots taken now (from a spec's `catch`, before its cleanup changes the page), and
// `serverLog(pattern?)`, the stderr lines every server wrote during the spec. Every wrapper of a run binds
// its iroh endpoint on the minimal preset to a fixed loopback port (CLAUDIO_COLLAB_PRESET,
// CLAUDIO_COLLAB_BIND): no relay and no discovery, so installs reach each other by their loopback
// tickets and the suite needs no network, and an invite stays good across a turn off and on.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './driver.mjs';
import { runShards } from './parallel.mjs';
import { freePort, killGroup } from './processes.mjs';
import { defaultShardCount, groupSpecs, loadTimings, parseCount, parseShard, splitSpecs } from './shards.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const live = process.env.E2E_LIVE === '1';
// A run that hangs holds a browser and a server: both have a limit, and both are closed on the way out
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!(Number(raw) > 0)) {
    console.error(`${name} must be a number of milliseconds greater than 0, got "${raw}"`);
    process.exit(2);
  }
  return Number(raw);
}
const SPEC_LIMIT_MS = envMs('E2E_SPEC_TIMEOUT', 180_000);
const RUN_LIMIT_MS = envMs('E2E_TIMEOUT', 1_500_000);
const specsDir = process.env.E2E_SPECS_DIR ? resolve(process.env.E2E_SPECS_DIR) : join(here, 'specs');

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist is missing: run `pnpm build` first.');
  process.exit(2);
}

const wanted = process.argv.slice(2);
const allSpecs = readdirSync(specsDir)
  .filter((f) => f.endsWith('.spec.mjs'))
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)))
  .sort();
// Loaded up front, to know which want the fake CLI: those run last, behind one restart of the server,
// and they are the one group the split keeps together
const allLoaded = [];
for (const file of allSpecs) {
  try {
    allLoaded.push({ file, spec: await import(join(specsDir, file)) });
  } catch (error) {
    allLoaded.push({ file, error });
  }
}
const wantsFake = (entry) => entry.spec?.fakeCli === true;
const entries = allLoaded.map((e) => ({ file: e.file, fake: wantsFake(e) }));
const timings = loadTimings(resolve(specsDir, '..', 'timings.json'));

const shardText = process.env.E2E_SHARD;
const shard = shardText ? parseShard(shardText) : null;
if (shardText && !shard) {
  console.error(`E2E_SHARD must be k/N with 1 ≤ k ≤ N, got "${shardText}"`);
  process.exit(2);
}
const countText = process.env.E2E_SHARDS;
if (!shard && countText && !parseCount(countText)) {
  console.error(`E2E_SHARDS must be a whole number of 1 or more, got "${countText}"`);
  process.exit(2);
}
if (!shard) {
  const groups = groupSpecs(entries, timings).length;
  const count = Math.max(1, Math.min(countText ? Number(countText) : defaultShardCount(availableParallelism(), groups), groups));
  if (count > 1) {
    const order = [...entries.filter((e) => !e.fake), ...entries.filter((e) => e.fake)].map((e) => e.file);
    const basePort = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : undefined;
    process.exit(await runShards({ runner: fileURLToPath(import.meta.url), args: wanted, shards: splitSpecs(entries, timings, count), order, basePort, runLimitMs: RUN_LIMIT_MS }));
  }
}
const mine = shard ? new Set(splitSpecs(entries, timings, shard.count)[shard.index - 1]?.files) : null;
const specs = mine ? allSpecs.filter((f) => mine.has(f)) : allSpecs;
const loaded = mine ? allLoaded.filter((e) => mine.has(e.file)) : allLoaded;

const PORT = Number(process.env.E2E_PORT || 8809);
const baseUrl = `http://127.0.0.1:${PORT}`;

// GitHub's latest-release shape, reduced to the fields the check reads
const releases = {
  tag: 'v999.0.0',
  set(tag) {
    releases.tag = tag;
  },
  get url() {
    return `https://github.com/yeyo11/claudio/releases/tag/${releases.tag}`;
  },
};
const releaseFixture = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ tag_name: releases.tag, html_url: releases.url, published_at: '2026-09-01T12:00:00Z', draft: false, prerelease: false }));
});
releaseFixture.listen(0, '127.0.0.1');
await once(releaseFixture, 'listening');
// It must not keep the run alive on its own; the process ending closes it
releaseFixture.unref();
const releasesUrl = `http://127.0.0.1:${releaseFixture.address().port}/repos/yeyo11/claudio/releases/latest`;

/** Collaborators on loopback only, at a UDP port the wrapper keeps for the whole run (see the header) */
const collabEnv = async () => ({ CLAUDIO_COLLAB_PRESET: 'minimal', CLAUDIO_COLLAB_BIND: `127.0.0.1:${await freePort('udp')}` });

const sandbox = mkdtempSync(join(tmpdir(), 'claudio-e2e-'));
// The guard program every guarded run is armed with, bundled the way apps/api/scripts/bundle.mjs ships
// it and read-only, as the image and the packages install it. The server runs from source, where the
// guard would be packages/core/src/guards/main.ts: under umask 002 a checkout leaves it group-writable,
// preflight refuses it (rightly), and every orchestration task failed with guard-unavailable before
// it ran. The suite tests the app, not the umask of the machine it was cloned on.
const guardEntry = join(sandbox, 'guard', 'guard.mjs');
createRequire(join(root, 'apps/api/package.json'))('esbuild').buildSync({
  entryPoints: [join(root, 'packages/core/src/guards/main.ts')],
  outfile: guardEntry,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'error',
});
chmodSync(guardEntry, 0o444);
// Specs seed transcripts and files straight into these directories; `guardEntry` is the guard the
// server runs, which a spec may make untrustworthy for a while
const dirs = {
  configDir: live ? null : join(sandbox, 'claude'),
  workspaceDir: join(sandbox, 'workspace'),
  dataDir: join(sandbox, 'data'),
  guardEntry,
};
// Without setup recorded as seen, the setup assistant stands in for the app on every page
// load, and no other spec could see the app. So the sandbox starts as a machine that finished that
// step (`setupSeen`); its one agent, Claude Code, is the fake CLI of e2e/fake-cli.
mkdirSync(dirs.dataDir, { recursive: true });
writeFileSync(join(dirs.dataDir, 'app-settings.json'), `${JSON.stringify({ setupSeen: true }, null, 2)}\n`);
// The code hosts are fakes too (e2e/fake-hosts), reached by the override in hosts.json: no real gh or
// glab on the machine changes what the Integrations and merge request specs see
writeFileSync(
  join(dirs.dataDir, 'hosts.json'),
  `${JSON.stringify({ hosts: { github: { enabled: true, binaryPath: join(here, 'fake-hosts', 'gh') }, gitlab: { enabled: true, binaryPath: join(here, 'fake-hosts', 'glab') } } }, null, 2)}\n`,
);
// YouTrack's program is a fake too (e2e/fake-trackers), reached by the override in trackers.json; the
// address and token stay unset, so a spec saves them like a person does
writeFileSync(
  join(dirs.dataDir, 'trackers.json'),
  `${JSON.stringify({ trackers: { youtrack: { enabled: true, binaryPath: join(here, 'fake-trackers', 'youtrack-app') } } }, null, 2)}\n`,
);
// glab lists the hosts it knows in its own config.yml: the sandbox has one, with gitlab.com and an
// account, so a real ~/.config/glab-cli never changes what the specs see
const glabConfigDir = join(sandbox, 'glab-config');
mkdirSync(glabConfigDir, { recursive: true });
writeFileSync(join(glabConfigDir, 'config.yml'), 'hosts:\n  gitlab.com:\n    user: tanuki\n');
const env = {
  ...process.env,
  GLAB_CONFIG_DIR: glabConfigDir,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  CLAUDIO_WORKSPACE_DIR: join(sandbox, 'workspace'),
  CLAUDIO_DATA_DIR: join(sandbox, 'data'),
  // The build this run is about, and not whatever the environment already pointed at. Inherited
  // from a shell that had it set — a desktop install exports it for its own packaged bundle — the
  // server serves that instead, and the suite reports on a build nobody asked it to look at. The
  // check above proves this directory exists; it is also the one every spec means.
  CLAUDIO_WEB_DIST: join(root, 'apps/web/dist'),
  // The bundled guard above, and never one the environment pointed at (a desktop install exports its own)
  CLAUDIO_GUARD_ENTRY: guardEntry,
  CLAUDIO_RELEASES_URL: releasesUrl,
  CLAUDIO_UPDATE_CHECK: 'off',
  // The Updates card offers the Docker commands, the one distribution a browser run can stand for
  CLAUDIO_DISTRIBUTION: 'docker',
  // ...which turns the tunnel off by default; the Remote access specs need it offered. No spec can
  // open a real one: the suite runs with authentication off, and the tunnel refuses to start then
  CLAUDIO_TUNNEL: 'on',
  // The tunnel's CLI is the core tests' fake, on a node file of the sandbox's own: the suite never
  // asks, let alone changes, the real Tailscale of the machine it runs on
  TAILSCALE_BIN: join(root, 'packages/core/test/fixtures/fake-tailscale.mjs'),
  FAKE_TAILSCALE_STATE: join(sandbox, 'tailscale-node.json'),
  // Live specs need the real login; everything else runs against an empty config dir
  ...(live ? {} : { CLAUDE_CONFIG_DIR: join(sandbox, 'claude') }),
  ...(await collabEnv()),
};
// The fake CLI's sandbox: the same directories, with the fake first on PATH. The config directory is
// always the sandbox's, live or not, since the fake has no login to need the real one. Health is
// checked every half second, so a signal reaches the page within a spec's patience.
// `scripts` is the fake's scripts file (CLAUDIO_FAKE_CLI_SCRIPTS): a spec writes it to script a turn it
// cannot type itself, such as the prompt an assistant run is started with. The fake reads it anew on
// every turn, and a missing file scripts nothing.
const fakeCli = { bin: join(here, 'fake-cli', 'claude'), log: join(sandbox, 'fake-cli.jsonl'), scripts: join(sandbox, 'fake-cli-scripts.json') };
const fakeEnv = {
  ...env,
  PATH: [join(here, 'fake-cli'), process.env.PATH].filter(Boolean).join(delimiter),
  CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
  CLAUDIO_HEALTH_INTERVAL_MS: '500',
  CLAUDIO_FAKE_CLI_LOG: fakeCli.log,
  CLAUDIO_FAKE_CLI_SCRIPTS: fakeCli.scripts,
  CLAUDIO_FAKE_CLI_HEARTBEAT_MS: '500',
  // By absolute path, not by PATH alone: the API puts the login shell's PATH first, and on a machine
  // with Claude Code in ~/.local/bin that found the real CLI, so every fakeCli spec talked to it and
  // ran out its time
  CLAUDE_BIN: join(here, 'fake-cli', 'claude'),
};

/**
 * What every server of the run (the main one and the peers, each line prefixed with its name) wrote
 * to stderr while the spec running now ran: a spec reads it through `serverLog()` to say why it failed,
 * which the shard's interleaved output does not. Null between specs.
 */
let specLog = null;
/** Splits a stream into lines for `specLog`; a line cut across two chunks is kept until it ends */
function specLogLines(prefix) {
  let partial = '';
  return (chunk) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    if (specLog) for (const line of lines) if (line.trim()) specLog.push(`${prefix}${line}`);
  };
}

/** The server running now, and which CLI it was given */
let server = null;
let serverCli = null;
/** The last lines the server wrote to stderr: what a failed start is reported with */
let serverStderr = '';
const STDERR_TAIL_CHARS = 4000;
function startServer(cli) {
  // Its own process group: `pnpm`, `tsx` and the API are killed together, by the leader's PID
  const child = spawn('pnpm', ['--filter', '@claudio/api', 'start'], { cwd: root, env: cli === 'fake' ? fakeEnv : env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  serverStderr = '';
  const toSpecLog = specLogLines('');
  // Still shown as it comes, as when stderr was inherited; kept as well, so a start that fails can say why
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    if (server === child) serverStderr = (serverStderr + chunk).slice(-STDERR_TAIL_CHARS);
    toSpecLog(chunk);
  });
  child.on('error', () => {});
  server = child;
  serverCli = cli;
}
function stopServer() {
  // SIGTERM first: the API closes its database on it. Synchronous, so the port is free when it returns
  if (server) killGroup(server.pid, { graceMs: 3000 });
  server = null;
}
// 'exit' is the one hook every way out passes through (the browser closes itself from its own
// handler, registered when it launches). The server goes first, then the sandbox it was using.
process.on('exit', () => {
  stopPeers();
  stopServer();
  if (process.env.E2E_KEEP !== '1') rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
});
const stop = (code, message) => {
  console.error(`\n${message}`);
  process.exit(code);
};
// A signal ends the process through 'exit'; 128 + the signal number is the shell's convention
for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(signal, () => stop(128 + number, `${signal}: stopping the e2e run`));
process.on('uncaughtException', (error) => stop(1, `the e2e run crashed: ${error?.stack ?? error}`));
process.on('unhandledRejection', (error) => stop(1, `the e2e run crashed on an unhandled rejection: ${error?.stack ?? error}`));
setTimeout(() => stop(1, `the e2e run exceeded ${RUN_LIMIT_MS / 1000}s: stopping it (set E2E_TIMEOUT to allow longer)`), RUN_LIMIT_MS).unref();

/** Rejects when `work` outlives `ms`; the caller must not go on driving the browser afterwards. */
function within(work, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// Generous on purpose: a loaded machine (CI running suites side by side, shards starting together)
// has taken well over 20 s to boot `pnpm`, `tsx` and the API. A server that died is reported at once.
const SERVER_START_LIMIT_MS = envMs('E2E_SERVER_START_TIMEOUT', 120_000);

/**
 * Resolves once the API answers. `/api/health` is the probe because it is cheap and never measures
 * anything (`/api/system` may start a `claude` process), and it answers only after every route is
 * registered, since the server listens last. Its `ok` field speaks of the CLI's login, which the
 * sandbox does not have: any 200 means the server is ready.
 */
async function waitForServer(child = server, url = baseUrl, stderr = () => serverStderr) {
  // Already gone if it failed between the spawn and this call
  let exited = child.exitCode !== null || child.signalCode !== null ? { code: child.exitCode, signal: child.signalCode } : null;
  const onExit = (code, signal) => (exited = { code, signal });
  child.once('exit', onExit);
  const started = Date.now();
  try {
    while (Date.now() - started < SERVER_START_LIMIT_MS) {
      if (exited) {
        throw new Error(`the API exited before it answered (${exited.signal ?? `code ${exited.code}`}):\n${stderr().trim() || '(no stderr)'}`);
      }
      try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the API did not answer /api/health within ${SERVER_START_LIMIT_MS / 1000}s (set E2E_SERVER_START_TIMEOUT to allow longer):\n${stderr().trim() || '(no stderr)'}`);
  } finally {
    child.off('exit', onExit);
  }
}

function apiAt(url) {
  const client = {
    baseUrl: url,
    async request(method, path, body) {
      const res = await fetch(`${url}/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    get: (path) => client.request('GET', path),
    put: (path, body) => client.request('PUT', path, body),
    post: (path, body) => client.request('POST', path, body),
    del: (path) => client.request('DELETE', path),
  };
  return client;
}
const api = apiAt(baseUrl);

// ---------- peers: the other wrappers of a Collaborators spec ----------

/** The peers running now, by name; started for one spec and stopped after it */
const peers = new Map();
let peerRuns = 0;
const PEER_NAME = /^[a-z][a-z0-9-]{0,30}$/;
/** The tabs peers opened for the spec running now, by the name of the peer whose page each shows */
const peerTabs = [];

/** What the peers' own tabs logged as errors, emptied */
function takePeerTabErrors() {
  return peerTabs.flatMap(({ name, tab }) => tab.takeErrors().map((e) => `[${name}] ${e}`));
}

async function closePeerTabs() {
  for (const { tab } of peerTabs.splice(0)) await tab.close();
}

function stopPeers() {
  for (const peer of peers.values()) if (peer.child) killGroup(peer.child.pid, { graceMs: 3000 });
  peers.clear();
}

/**
 * One more wrapper, as the main one is made but always on the fake CLI: a peer is a teammate's
 * machine, and nothing a spec does there may reach the real `claude`. Each run of a spec gets fresh
 * directories, so no spec sees what an earlier one left on a peer.
 */
async function startPeer(name, page, browser) {
  const home = join(sandbox, 'peers', `${name}-${++peerRuns}`);
  const peerDirs = { configDir: join(home, 'claude'), workspaceDir: join(home, 'workspace'), dataDir: join(home, 'data') };
  for (const dir of Object.values(peerDirs)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(peerDirs.dataDir, 'app-settings.json'), `${JSON.stringify({ setupSeen: true }, null, 2)}\n`);
  const port = await freePort('tcp');
  const url = `http://127.0.0.1:${port}`;
  const peerFake = { bin: fakeCli.bin, log: join(home, 'fake-cli.jsonl'), scripts: join(home, 'fake-cli-scripts.json') };
  // Kept for a restart: the same port, directories and iroh bind, so the peer comes back as itself
  const peerEnv = {
    ...fakeEnv,
    PORT: String(port),
    CLAUDIO_WORKSPACE_DIR: peerDirs.workspaceDir,
    CLAUDIO_DATA_DIR: peerDirs.dataDir,
    CLAUDE_CONFIG_DIR: peerDirs.configDir,
    CLAUDIO_FAKE_CLI_LOG: peerFake.log,
    CLAUDIO_FAKE_CLI_SCRIPTS: peerFake.scripts,
    FAKE_TAILSCALE_STATE: join(home, 'tailscale-node.json'),
    ...(await collabEnv()),
  };
  const entry = { child: null };
  peers.set(name, entry);
  let stderr = '';
  const boot = async () => {
    const child = spawn('pnpm', ['--filter', '@claudio/api', 'start'], { cwd: root, env: peerEnv, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    stderr = '';
    const toSpecLog = specLogLines(`[${name}] `);
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[${name}] ${chunk}`);
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      toSpecLog(chunk);
    });
    child.on('error', () => {});
    entry.child = child;
    await waitForServer(child, url, () => stderr);
  };
  await boot();
  const peerPage = Object.assign(Object.create(page), {
    baseUrl: url,
    // The same tab, sent to the peer's own origin: a person looking at a teammate's screen
    async goto(path, wait = 1200) {
      await page.eval(`location.assign(${JSON.stringify(`${url}${path}`)}); return true`);
      await page.sleep(wait);
    },
  });
  /**
   * Stops the peer's server and starts it again on what it left on disk: a teammate's machine that
   * restarted. A spec changes those files in between (a vault lost, say) to see what the app makes of it.
   */
  const restart = async () => {
    // SIGTERM first, as the main server: the API closes its database, and the port is free on return
    killGroup(entry.child.pid, { graceMs: 3000 });
    await boot();
  };
  const openTab = async () => {
    const tab = await browser.openTab(url);
    peerTabs.push({ name, tab });
    return tab;
  };
  return { name, baseUrl: url, port, api: apiAt(url), dirs: peerDirs, fakeCli: peerFake, page: peerPage, openTab, restart };
}

async function startPeers(names, page, browser) {
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !PEER_NAME.test(n)) || new Set(names).size !== names.length) {
    throw new Error(`\`peers\` must be distinct lower-case names, got ${JSON.stringify(names)}`);
  }
  const started = await Promise.all(names.map((name) => startPeer(name, page, browser)));
  return Object.fromEntries(started.map((peer) => [peer.name, peer]));
}

/** The main tab and every peer's own tab, as screenshots under E2E_SHOTS (nothing without it) */
async function captureFailure(name, page) {
  await page.shot(name).catch(() => {});
  for (const { name: peer, tab } of peerTabs) await tab.shot(`${name}-${peer}`).catch(() => {});
}

function check(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const ordered = [...loaded.filter((e) => !wantsFake(e)), ...loaded.filter(wantsFake)];
const firstToRun = ordered.find((e) => !(e.spec?.live && !live));
startServer(firstToRun && wantsFake(firstToRun) ? 'fake' : 'real');

let failed = 0;
const failedFiles = [];
let browser;
try {
  await waitForServer();
  // Chrome chooses its debugging port, so a second suite can run beside this one given its own E2E_PORT
  browser = await launch({ baseUrl, port: Number(process.env.E2E_CDP_PORT ?? 0), shotsDir: process.env.E2E_SHOTS });
  for (const { file, spec, error } of ordered) {
    if (error) {
      failed++;
      failedFiles.push(file);
      console.log(`✗ ${file}\n  could not be loaded: ${error.message}`);
      continue;
    }
    if (spec.live && !live) {
      console.log(`- ${file} (skipped: set E2E_LIVE=1)`);
      continue;
    }
    const cli = wantsFake({ spec }) ? 'fake' : 'real';
    if (cli !== serverCli) {
      console.log(`- restarting the server with the ${cli === 'fake' ? 'fake CLI (e2e/fake-cli)' : 'real CLI'}`);
      stopServer();
      startServer(cli);
      await waitForServer();
    }
    const started = Date.now();
    // A spec with a lot to scan says so with `export const timeout`
    const limit = spec.timeout ?? SPEC_LIMIT_MS;
    try {
      await browser.page.reset();
      browser.page.takeErrors();
      specLog = [];
      const context = cli === 'fake' ? { page: browser.page, api, check, dirs: { ...dirs, configDir: join(sandbox, 'claude') }, fakeCli, releases } : { page: browser.page, api, check, dirs, releases };
      // A spec's `finally` runs before the harness sees its error: one whose cleanup changes the page
      // captures it from its own `catch`, and says why with what the servers logged meanwhile
      context.capture = (label) => captureFailure(`FAILED-${file}-${label}`, browser.page);
      context.serverLog = (pattern) => (specLog ?? []).filter((line) => !pattern || pattern.test(line));
      if (spec.peers !== undefined) context.peers = await startPeers(spec.peers, browser.page, browser);
      await within(spec.default(context), limit, file);
      const errors = [...browser.page.takeErrors(), ...takePeerTabErrors()];
      check(errors.length === 0, `console errors:\n  ${[...new Set(errors)].join('\n  ')}`);
      console.log(`✓ ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failed++;
      failedFiles.push(file);
      console.log(`✗ ${file}\n  ${error.message.replaceAll('\n', '\n  ')}`);
      await captureFailure(`FAILED-${file}`, browser.page);
      // A spec that timed out is still running in the background: the browser is not safe to reuse
      if (error.message.endsWith(`took longer than ${limit / 1000}s`)) {
        console.log('- stopping: the timed-out spec may still be driving the browser');
        break;
      }
    } finally {
      specLog = null;
      // Closed before their servers stop: a page whose server goes away under it is noise
      await closePeerTabs().catch(() => {});
      stopPeers();
    }
  }
} catch (error) {
  failed++;
  console.error(error.message);
} finally {
  // The 'exit' handlers would do it too; closing here keeps the browser from lingering while the summary prints
  browser?.close();
}
// The failed files come last, so the tail of the output (all a fixer may be shown) names them
if (failedFiles.length) console.log(`\nfailed:\n${failedFiles.map((f) => `✗ ${f}`).join('\n')}`);
console.log(failed ? `${failedFiles.length ? '' : '\n'}${failed} spec(s) failed` : `\nall ${specs.length} spec file(s) passed`);
process.exit(failed ? 1 : 0);
