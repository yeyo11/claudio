#!/usr/bin/env node
// Listing bench: how long `/overview`, `/chats`, `/projects` and `/usage` take over a machine's worth
// of Claude transcripts (docs/plans/regression-fixes-2026-10-29.md, C7 and the Checklist's item 9).
//
// It writes a corpus of transcripts into a sandbox of its own, starts an isolated Claudio on it (its
// own data dir, config dir and port, the fake CLI of e2e/fake-cli, no credential, nothing inherited
// that names the person's install), imports a few projects, and times each route:
//   first    the first request after the server came up, while nothing was read yet
//   warm     sequential requests once everything was read once (p50 / p95 / max)
//   burst    the four routes at once, as a dashboard and the tray ask for them (p50 / max of the slowest)
//   restart  the first request after a restart on the same data dir: what a persisted fold saves
//
//   node scripts/listing-bench.mjs [--transcripts 1400] [--dirs 660] [--lines 200] [--projects 20]
//                                  [--warm 20] [--root <checkout>] [--unwatched] [--json] [--keep]
//
// `--root` runs the server of another checkout (with its dependencies installed) on the same corpus,
// for a before/after under the same load: the fake CLI is still this checkout's.
//
// Nothing outside the sandbox is read or written, and the server's whole process group is ended on
// every way out. No Claude turn is run: the fake CLI answers what the server asks.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, killGroup } from '../e2e/processes.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const rootAt = args.indexOf('--root');
/** The checkout whose server is measured */
const root = rootAt >= 0 && args[rootAt + 1] ? resolve(args[rootAt + 1]) : here;
const TRANSCRIPTS = flag('transcripts', 1400);
const DIRS = flag('dirs', 660);
const LINES = flag('lines', 200);
const PROJECTS = flag('projects', 20);
const WARM = flag('warm', 20);
const JSON_OUT = args.includes('--json');
const UNWATCHED = args.includes('--unwatched');
const KEEP = args.includes('--keep');
/** `/chats*` is every chat read the way the web reads a list without a limit: page after page, following `x-next-cursor` */
const ROUTES = ['/overview', '/chats', '/chats*', '/projects', '/usage'];
/** What a dashboard and the tray ask for at once */
const BURST = ['/overview', '/chats', '/projects', '/usage'];
/** How long a server may take to come up: `pnpm`, `tsx` and the API, on a busy machine */
const BOOT_MS = 180_000;
/** One request's ceiling: a slow listing is a number to report, a hung one is a failure */
const REQUEST_MS = 120_000;

const sandbox = mkdtempSync(join(tmpdir(), 'claudio-listing-bench-'));
const dirs = {
  claude: join(sandbox, 'claude'),
  data: join(sandbox, 'data'),
  workspace: join(sandbox, 'workspace'),
  repos: join(sandbox, 'repos'),
  loose: join(sandbox, 'loose'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

let server = null;
const cleanup = () => {
  if (server?.pid) killGroup(server.pid, { graceMs: 3000 });
  server = null;
  if (!KEEP) rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

const log = (line) => {
  if (!JSON_OUT) console.error(line);
};

// ---------- the corpus ----------

/** Where the CLI files a session run in `cwd`: every character that is not a letter or a digit becomes `-` */
const encode = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function makeRepos() {
  const repos = [];
  for (let i = 0; i < PROJECTS; i++) {
    const repo = join(dirs.repos, `project-${String(i).padStart(2, '0')}`);
    mkdirSync(repo, { recursive: true });
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=bench', '-c', 'user.email=bench@example.com', ...a], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    // A linked worktree in the CLI's own layout, for the chats that ran in one
    const worktree = join(repo, '.claude', 'worktrees', 'feature');
    git('worktree', 'add', '-q', '-b', 'feature', worktree);
    repos.push({ repo, worktree });
  }
  return repos;
}

/** The working directory of transcript `i`: two in three in a project, a worktree now and then, the rest loose */
function cwdOf(i, repos) {
  const repo = repos[i % repos.length];
  if (repo && i % 3 !== 2) return i % 7 === 0 ? repo.worktree : repo.repo;
  return join(dirs.loose, `dir-${String(i % Math.max(1, DIRS - repos.length)).padStart(3, '0')}`);
}

const DAY_MS = 86_400_000;
const TEXT = 'The change reads the transcript once and keeps what it learned, so the next list only reads what was appended. '.repeat(3);

async function writeTranscript(file, cwd, i) {
  const out = createWriteStream(file);
  const start = Date.now() - (i % 30) * DAY_MS - (i % 24) * 3_600_000;
  for (let n = 0; n < LINES; n++) {
    const at = new Date(start + n * 20_000).toISOString();
    const user = n % 2 === 0;
    const line = user
      ? { type: 'user', uuid: `u-${i}-${n}`, timestamp: at, cwd, sessionId: `s${i}`, version: '2.1.300', gitBranch: 'main', message: { role: 'user', content: n === 0 ? `Task ${i}: make the listing incremental` : `Go on with step ${n}` } }
      : {
          type: 'assistant',
          uuid: `a-${i}-${n}`,
          timestamp: at,
          cwd,
          isSidechain: n % 10 === 5,
          message: {
            id: `msg-${i}-${n}`,
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: TEXT }],
            usage: { input_tokens: 1200 + n, output_tokens: 300, cache_read_input_tokens: 20_000 + n * 10, cache_creation_input_tokens: 500 },
          },
        };
    if (!out.write(`${JSON.stringify(line)}\n`)) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

async function makeCorpus(repos) {
  const projects = join(dirs.claude, 'projects');
  for (let i = 0; i < TRANSCRIPTS; i++) {
    const cwd = cwdOf(i, repos);
    const dir = join(projects, encode(cwd));
    mkdirSync(dir, { recursive: true });
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await writeTranscript(join(dir, `${id}.jsonl`), cwd, i);
  }
}

// ---------- the server ----------

const port = await freePort('tcp');
const base = `http://127.0.0.1:${port}/api`;

/** The person's environment without anything that names their install, their port or their token */
function serverEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDIO_') || name === 'PORT' || name === 'HOST' || name === 'CLAUDE_CONFIG_DIR') delete env[name];
  const fake = join(here, 'e2e', 'fake-cli');
  return {
    ...env,
    PATH: [fake, process.env.PATH].filter(Boolean).join(delimiter),
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    CLAUDE_CONFIG_DIR: dirs.claude,
    CLAUDE_BIN: join(fake, 'claude'),
    CLAUDIO_DATA_DIR: dirs.data,
    CLAUDIO_WORKSPACE_DIR: dirs.workspace,
    CLAUDIO_AUTH_MODE: 'none',
    CLAUDIO_UPDATE_CHECK: 'off',
    CLAUDIO_TUNNEL: 'off',
    CLAUDIO_COLLAB_PRESET: 'minimal',
    CLAUDIO_FAKE_CLI_LOG: join(sandbox, 'fake-cli.jsonl'),
    FAKE_STATE_DIR: dirs.data,
  };
}

async function get(path, timeoutMs = REQUEST_MS) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  const ms = performance.now() - started;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
  return { ms, bytes: body.length, body, next: res.headers.get('x-next-cursor') };
}

/** Every chat, a page at a time; a server that does not page answers them all with the first */
async function everyChat(query = '') {
  const started = performance.now();
  const rows = [];
  for (let page = await get(`/chats${query ? `?${query}` : ''}`); ; ) {
    rows.push(...JSON.parse(page.body));
    if (!page.next) break;
    page = await get(`/chats?${query ? `${query}&` : ''}after=${encodeURIComponent(page.next)}`);
  }
  return { ms: performance.now() - started, rows };
}

const measure = (route) => (route === '/chats*' ? everyChat() : get(route));

async function startServer() {
  server = spawn('pnpm', ['--filter', '@claudio/api', 'start'], { cwd: root, env: serverEnv(), stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const until = Date.now() + BOOT_MS;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode}:\n${stderr}`);
    try {
      await get('/health', 2000);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`the server did not come up in ${BOOT_MS / 1000} s:\n${stderr}`);
}

/**
 * A client following `/events`, as the web and the tray do while they are open: it keeps the
 * server's watch of the projects directory on. `--unwatched` measures a server nobody follows.
 */
let feed = null;
async function follow() {
  if (UNWATCHED) return;
  feed = new AbortController();
  const res = await fetch(`${base}/events`, { signal: feed.signal });
  const reader = res.body?.getReader();
  void (async () => {
    try {
      while (reader && !(await reader.read()).done);
    } catch {
      // aborted with the server
    }
  })();
  // The watch reaches every directory before the first measure
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

function stopServer() {
  feed?.abort();
  feed = null;
  if (server?.pid) killGroup(server.pid, { graceMs: 5000 });
  server = null;
}

// ---------- the measures ----------

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const round = (ms) => Math.round(ms);

async function firsts() {
  const out = {};
  for (const route of ROUTES) out[route] = round((await measure(route)).ms);
  return out;
}

async function warm() {
  const samples = Object.fromEntries(ROUTES.map((r) => [r, []]));
  for (let i = 0; i < WARM; i++) for (const route of ROUTES) samples[route].push((await measure(route)).ms);
  return Object.fromEntries(ROUTES.map((r) => [r, { p50: round(quantile(samples[r], 0.5)), p95: round(quantile(samples[r], 0.95)), max: round(Math.max(...samples[r])) }]));
}

async function burst() {
  const slowest = [];
  for (let i = 0; i < WARM; i++) {
    const times = await Promise.all(BURST.map(async (r) => (await get(r)).ms));
    slowest.push(Math.max(...times));
  }
  return { p50: round(quantile(slowest, 0.5)), max: round(Math.max(...slowest)) };
}

log(`sandbox ${sandbox}`);
const repos = makeRepos();
const corpusStarted = performance.now();
await makeCorpus(repos);
log(`corpus: ${TRANSCRIPTS} transcripts of ${LINES} lines in ${DIRS} directories, written in ${round(performance.now() - corpusStarted)} ms`);

await startServer();
await follow();
log(`server up on :${port}${UNWATCHED ? ', nobody following /events' : ', a client following /events'}`);
for (const { repo } of repos) {
  const res = await fetch(`${base}/projects/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: repo }) });
  if (!res.ok) throw new Error(`import ${repo}: HTTP ${res.status} ${await res.text()}`);
}
const first = await firsts();
const chats = (await everyChat('origin=claudio,external,orchestration')).rows.length;
const warmed = await warm();
const bursts = await burst();

stopServer();
await startServer();
await follow();
const restarted = await firsts();
stopServer();

const result = { transcripts: TRANSCRIPTS, lines: LINES, dirs: DIRS, projects: PROJECTS, watched: !UNWATCHED, chats, first, warm: warmed, burst: bursts, restart: restarted };
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`\n${TRANSCRIPTS} transcripts × ${LINES} lines, ${PROJECTS} projects, ${chats} chats listed, ${UNWATCHED ? 'nobody following /events' : 'a client following /events'}`);
  console.log('route        first  warm p50  warm p95  warm max  restart');
  for (const r of ROUTES) {
    const w = warmed[r];
    console.log(`${r.padEnd(12)} ${String(first[r]).padStart(5)}  ${String(w.p50).padStart(8)}  ${String(w.p95).padStart(8)}  ${String(w.max).padStart(8)}  ${String(restarted[r]).padStart(7)}`);
  }
  console.log(`burst of the four, slowest: p50 ${bursts.p50} ms, max ${bursts.max} ms`);
}
