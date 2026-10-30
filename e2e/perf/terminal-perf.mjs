// How fast the terminal is, measured against an isolated server (temp data dir, no real ~/.claude),
// and with headless Chrome for the parts that need a page. Run by hand and in a non-gating CI job:
//   node e2e/perf/terminal-perf.mjs                  everything
//   node e2e/perf/terminal-perf.mjs --only server    the server's parts, no browser (no `pnpm build` needed)
//   node e2e/perf/terminal-perf.mjs --only browser   the page's parts (needs `pnpm build`)
//   node e2e/perf/terminal-perf.mjs --check          fail when a result is beyond its budget in budgets.json
// PERF_PORT (default 8819) is the server's port. The terminal runs the person's own shell: the
// numbers say how a shell's bytes travel, nothing here starts Claude Code in it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../driver.mjs';
import { killGroup } from '../processes.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { WebSocket } = createRequire(join(root, 'apps/api/package.json'))('ws');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : 'all';
const PORT = Number(process.env.PERF_PORT || 8819);
const baseUrl = `http://127.0.0.1:${PORT}`;
const MB = 1024 * 1024;

// ---------- numbers ----------

const percentile = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), worst: sorted.at(-1) ?? 0 };
};
const round = (value, digits = 1) => Number(value.toFixed(digits));

/** Resident memory of a process and everything below it, in MiB (Linux: /proc) */
function treeRss(pid) {
  const rows = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      rows.set(Number(entry), { ppid: Number(/PPid:\s+(\d+)/.exec(status)?.[1]), rss: Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) / 1024 });
    } catch {
      // it exited while we looked
    }
  }
  const below = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, row] of rows) if (!below.has(id) && below.has(row.ppid)) (below.add(id), (grew = true));
  }
  let total = 0;
  for (const id of below) total += rows.get(id)?.rss ?? 0;
  return total;
}

/** Samples a tree's memory until stopped; `peak()` is the highest seen */
function watchRss(pid) {
  let peak = treeRss(pid);
  const timer = setInterval(() => (peak = Math.max(peak, treeRss(pid))), 100);
  return { peak: () => peak, stop: () => clearInterval(timer) };
}

// ---------- the isolated server ----------

const sandbox = mkdtempSync(join(tmpdir(), 'claudio-perf-'));
const dirs = { config: join(sandbox, 'claude'), workspace: join(sandbox, 'workspace'), data: join(sandbox, 'data') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
writeFileSync(join(dirs.data, 'app-settings.json'), `${JSON.stringify({ setupSeen: true }, null, 2)}\n`);

let server = null;
let browser = null;
function cleanUp() {
  if (server) killGroup(server.pid, { graceMs: 3000 });
  server = null;
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
}
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));

const request = async (method, path, body) => {
  const res = await fetch(`${baseUrl}/api${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), origin: baseUrl }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function startServer() {
  server = spawn('pnpm', ['--filter', '@claudio/api', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      CLAUDIO_WORKSPACE_DIR: dirs.workspace,
      CLAUDIO_DATA_DIR: dirs.data,
      CLAUDIO_WEB_DIST: join(root, 'apps/web/dist'),
      CLAUDIO_UPDATE_CHECK: 'off',
      CLAUDE_CONFIG_DIR: dirs.config,
    },
  });
  for (let i = 0; i < 240; i++) {
    if (await request('GET', '/terminal').then((r) => r.status === 200, () => false)) return;
    await sleep(500);
  }
  throw new Error('the server did not start within 2 minutes');
}

async function openTerminal(projectId) {
  const made = await request('POST', '/terminals', { projectId, cols: 120, rows: 32 });
  if (made.status !== 201) throw new Error(`could not open a terminal: ${made.status} ${JSON.stringify(made.body)}`);
  return made.body.id;
}

/**
 * A socket client on a terminal. `ack` says whether it acknowledges what it receives; the tests of
 * back-pressure use one that does not. `seen` is everything received, as text, for waiting on markers.
 */
async function attach(id, { ack = true } = {}) {
  const ticket = await request('POST', `/terminals/${id}/ticket`);
  if (ticket.status !== 200 && ticket.status !== 201) throw new Error(`no ticket: ${ticket.status}`);
  const opened = performance.now();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminals/${id}/socket?ticket=${encodeURIComponent(ticket.body.ticket)}`, { headers: { origin: baseUrl } });
  const client = { socket, bytes: 0, tail: '', frames: [], helloAfter: null, closed: null, waiters: new Set() };
  socket.on('message', (data, binary) => {
    if (!binary) {
      const frame = JSON.parse(data.toString());
      client.frames.push(frame);
      if (frame.type === 'hello') client.helloAfter = performance.now() - opened;
      if (frame.type === 'closed') client.closed = frame.reason;
      return;
    }
    client.bytes += data.length;
    client.tail = (client.tail + data.toString('latin1')).slice(-4096);
    // Checked as the bytes arrive: in a flood the tail is gone again by the time a poll looks
    for (const waiter of [...client.waiters]) if (client.tail.includes(waiter.marker)) (client.waiters.delete(waiter), waiter.resolve());
    if (ack) socket.send(JSON.stringify({ type: 'ack', bytes: data.length }));
  });
  await new Promise((resolveOpen, reject) => (socket.once('open', resolveOpen), socket.once('error', reject)));
  client.type = (text) => socket.send(Buffer.from(text));
  client.waitFor = (marker, ms = 60_000) =>
    new Promise((resolveWait, reject) => {
      const waiter = { marker, resolve: () => (clearTimeout(timer), resolveWait()) };
      const timer = setTimeout(() => (client.waiters.delete(waiter), reject(new Error(`timed out waiting for ${marker}`))), ms);
      if (client.tail.includes(marker)) waiter.resolve();
      else client.waiters.add(waiter);
    });
  client.close = () => socket.close();
  return client;
}

// ---------- the server's parts ----------

async function throughputServer(projectId) {
  const id = await openTerminal(projectId);
  const client = await attach(id);
  await sleep(300);
  const rss = watchRss(server.pid);
  const base = treeRss(server.pid);
  client.bytes = 0;
  const start = performance.now();
  client.type("head -c 64m /dev/zero | tr '\\0' 'x' | fold -w 120; echo END$((1+1))\r");
  await client.waitFor('END2', 120_000);
  const seconds = (performance.now() - start) / 1000;
  rss.stop();
  client.close();
  await request('DELETE', `/terminals/${id}`);
  return { mbPerSecond: round(client.bytes / MB / seconds), megabytes: round(client.bytes / MB), seconds: round(seconds, 2), rssGrowthMb: round(rss.peak() - base) };
}

async function drift(projectId) {
  const id = await openTerminal(projectId);
  const client = await attach(id);
  client.type("head -c 32m /dev/zero | tr '\\0' 'x' | fold -w 120; echo END$((1+1))\r");
  // A cheap route polled while one terminal floods: how long the API takes to answer is how late its loop runs
  const late = [];
  while (!client.tail.includes('END2') && late.length < 2000) {
    const start = performance.now();
    await request('GET', '/terminal');
    late.push(performance.now() - start);
    await sleep(50);
  }
  client.close();
  await request('DELETE', `/terminals/${id}`);
  return { requests: late.length, p95Ms: round(stats(late).p95), worstMs: round(stats(late).worst) };
}

async function backPressure(projectId) {
  const id = await openTerminal(projectId);
  const slow = await attach(id, { ack: false });
  let quick = null;
  try {
  const base = treeRss(server.pid);
  const rss = watchRss(server.pid);
  slow.type('yes\r');
  await sleep(10_000);
  const received = slow.bytes;
  await sleep(2000);
  const stalled = slow.bytes - received < 4 * MB;
  const evicted = slow.closed;
  // A second client, which acks, takes over: it stops `yes` and times echoes
  quick = await attach(id);
  quick.type('\x03');
  await sleep(500);
  quick.type('echo ready$((1+1))\r');
  // While the stalled client stays attached the shell is paused for everyone (§2.7): say so, don't hang
  const blocked = await quick.waitFor('ready2', 15_000).then(() => false, () => true);
  const echoes = [];
  if (!blocked) {
    for (let i = 0; i < 20; i++) {
      const marker = `q${1000 + i}`;
      const start = performance.now();
      quick.type(`echo ${marker.slice(0, 1)}$((${i}+1000))\r`);
      await quick.waitFor(marker, 10_000);
      echoes.push(performance.now() - start);
    }
  }
  // Once the stalled client is gone the shell must come back
  slow.close();
  quick.tail = '';
  quick.type('echo back$((2+3))\r');
  const recovered = await quick.waitFor('back5', 15_000).then(() => true, () => false);
  rss.stop();
  quick.close();
  return { secondClientBlocked: blocked, shellRecoveredAfterStalledClientLeft: recovered, receivedMbBeforeStall: round(received / MB), stalledAfterTenSeconds: stalled, slowClientEnd: evicted ?? 'still attached', rssGrowthMb: round(rss.peak() - base), secondClientEchoP95Ms: blocked ? null : round(stats(echoes).p95) };
  } finally {
    slow.close();
    quick?.close();
    await request('DELETE', `/terminals/${id}`).catch(() => {});
  }
}

async function hello(projectId) {
  const id = await openTerminal(projectId);
  const first = await attach(id);
  first.type('seq 1 1000; echo END$((1+1))\r');
  await first.waitFor('END2');
  const times = [];
  for (let i = 0; i < 10; i++) {
    const again = await attach(id);
    await sleep(100);
    times.push(again.helloAfter ?? Number.NaN);
    again.close();
  }
  first.close();
  await request('DELETE', `/terminals/${id}`);
  return { helloP50Ms: round(stats(times).p50), helloWorstMs: round(stats(times).worst) };
}

// ---------- the page's parts ----------

async function inBrowser(projectId) {
  const out = {};
  browser = await launch({ baseUrl, port: Number(process.env.PERF_CDP_PORT ?? 0) });
  const { page } = browser;
  await page.goto('/', 800);
  await page.eval(`localStorage.setItem('claudio-terminal-renderer', 'dom'); localStorage.setItem('claudio-terminal-bar', '1'); return true`);
  const rows = `document.querySelector('.term .xterm-rows')?.innerText ?? ''`;
  const ready = () => page.waitFor(`return !!document.querySelector('.term .xterm-helper-textarea') && (${rows}).trim().length > 0`, { label: 'the terminal drawn', timeout: 60_000 });
  const typeLine = async (line) => {
    await page.focus('.term .xterm-helper-textarea');
    await page.type(line);
    await page.key('Enter');
  };
  const id = await openTerminal(projectId);
  // Long tasks of the main thread, from before the page's own scripts
  await page.onNewDocument(`window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}`);
  // The status bar's panel, remembered open, on the terminal opened above
  const url = `/?project=${encodeURIComponent(projectId)}`;
  await page.goto(url, 1500);
  await ready();

  // End to end: 300 000 lines until the last renders
  await page.eval('window.__long.length = 0; return true');
  const start = Date.now();
  await typeLine('seq 1 300000; echo END$((1+1))');
  await page.waitFor(`return (${rows}).includes('END2')`, { label: 'the last line', timeout: 120_000 });
  const seconds = (Date.now() - start) / 1000;
  const long = await page.eval('return window.__long');
  out.endToEnd = { seconds: round(seconds, 2), longestTaskMs: round(Math.max(0, ...long)), longTasks: long.length };

  // Echo: 200 characters typed into cat; each is a key event on xterm's textarea, timed to its glyph on screen
  await typeLine('cat');
  await sleep(300);
  out.echo = await page.eval(`
    const area = document.querySelector('.term .xterm-helper-textarea');
    const rows = document.querySelector('.term .xterm-rows');
    const count = () => (rows.innerText.match(/Q/g) || []).length;
    const times = [];
    for (let i = 0; i < 200; i++) {
      const want = count() + 1;
      const t0 = performance.now();
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Q', code: 'KeyQ', keyCode: 81, bubbles: true, cancelable: true }));
      area.dispatchEvent(new KeyboardEvent('keypress', { key: 'Q', code: 'KeyQ', charCode: 81, keyCode: 81, bubbles: true, cancelable: true }));
      while (count() < want) {
        if (performance.now() - t0 > 2000) break;
        await new Promise((r) => setTimeout(r, 0));
      }
      times.push(performance.now() - t0);
    }
    return times;`);
  out.echo = (({ n, p50, p95, worst }) => ({ n, p50Ms: round(p50), p95Ms: round(p95), worstMs: round(worst) }))(stats(out.echo));
  await page.focus('.term .xterm-helper-textarea');
  await page.key('c', 2);

  // Reattach: a cold page load with the terminal open and 1 000 lines behind it
  await typeLine('clear; seq 1 1000');
  await page.waitFor(`return (${rows}).includes('1000')`, { label: 'seq done' });
  await sleep(500);
  const cold = Date.now();
  await page.goto(url, 0);
  await page.waitFor(`return (${rows}).includes('1000')`, { label: 'the replayed screen', timeout: 30_000 });
  out.coldLoadMs = Date.now() - cold;
  await request('DELETE', `/terminals/${id}`);
  return out;
}

// ---------- run ----------

const budgets = JSON.parse(readFileSync(join(here, 'budgets.json'), 'utf8'));
const results = {};
const wantServer = only === 'all' || only === 'server';
const wantBrowser = only === 'all' || only === 'browser';
try {
  if (wantBrowser && !existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('apps/web/dist is missing: run `pnpm build` first (or use --only server).');
  await startServer();
  const put = await request('PUT', '/terminal/settings', { enabled: true });
  if (put.status !== 200) throw new Error(`the terminal could not be turned on: ${put.status} ${JSON.stringify(put.body)}`);
  const status = (await request('GET', '/terminal')).body;
  if (!status.available) throw new Error(`the terminal is not available here: ${status.reason}`);
  const project = await request('POST', '/projects/import', { path: dirs.workspace, name: 'perf' });
  if (project.status !== 201) throw new Error(`could not import the project: ${project.status}`);
  const projectId = project.body.id;

  if (wantServer) {
    results.throughput = await throughputServer(projectId);
    results.drift = await drift(projectId);
    results.hello = await hello(projectId);
    results.backPressure = await backPressure(projectId);
  }
  if (wantBrowser) Object.assign(results, await inBrowser(projectId));
} finally {
  await browser?.close?.();
}

// ---------- verdict ----------

const machine = {
  date: new Date().toISOString().slice(0, 10),
  os: `${platform()} ${release()} ${arch()}`,
  cpu: `${cpus()[0]?.model ?? 'unknown'} × ${cpus().length}`,
  memoryGb: round(totalmem() / 1024 ** 3),
  node: process.version,
  chrome: wantBrowser ? (spawnSync(process.env.CHROME_BIN || 'google-chrome', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() : null,
};

/** [label, value, limit, direction] — `max` limits are ceilings, `min` limits are floors */
const rules = [
  ['server throughput (MB/s)', results.throughput?.mbPerSecond, budgets.throughputMbPerSecond, 'min'],
  ['server RSS growth, flood (MiB)', results.throughput?.rssGrowthMb, budgets.rssGrowthMb, 'max'],
  ['API latency under flood, p95 (ms)', results.drift?.p95Ms, budgets.driftP95Ms, 'max'],
  ['API latency under flood, worst (ms)', results.drift?.worstMs, budgets.driftWorstMs, 'max'],
  ['hello on reattach, p50 (ms)', results.hello?.helloP50Ms, budgets.helloP50Ms, 'max'],
  ['back-pressure RSS growth (MiB)', results.backPressure?.rssGrowthMb, budgets.backPressureRssGrowthMb, 'max'],
  ['second client echo p95 (ms)', results.backPressure?.secondClientEchoP95Ms ?? undefined, budgets.secondClientEchoP95Ms, 'max'],
  ['300 000 lines end to end (s)', results.endToEnd?.seconds, budgets.endToEndSeconds, 'max'],
  ['longest main-thread task (ms)', results.endToEnd?.longestTaskMs, budgets.longestTaskMs, 'max'],
  ['keystroke echo p50 (ms)', results.echo?.p50Ms, budgets.echoP50Ms, 'max'],
  ['keystroke echo worst (ms)', results.echo?.worstMs, budgets.echoWorstMs, 'max'],
  ['cold load with the terminal open (ms)', results.coldLoadMs, budgets.coldLoadMs, 'max'],
];
const lines = rules
  .filter(([, value]) => value !== undefined)
  .map(([label, value, limit, direction]) => {
    const ok = direction === 'min' ? value >= limit : value <= limit;
    return { label, value, limit, direction, ok };
  });
if (results.backPressure?.secondClientBlocked) lines.push({ label: 'a second client stays responsive beside a client that stopped acking', value: 'no (the shell stays paused)', limit: 'yes', direction: 'is', ok: false });
if (results.backPressure && !results.backPressure.shellRecoveredAfterStalledClientLeft) lines.push({ label: 'the shell recovers when the stalled client leaves', value: 'no', limit: 'yes', direction: 'is', ok: false });
if (results.backPressure && !results.backPressure.stalledAfterTenSeconds) lines.push({ label: 'a client that stops acking pauses the shell', value: 'no', limit: 'yes', direction: 'is', ok: false });

console.log(JSON.stringify({ machine, results }, null, 2));
console.log(`\n${lines.map((l) => `${l.ok ? '✓' : '✗'} ${l.label}: ${l.value} (${l.direction === 'min' ? '≥' : '≤'} ${l.limit})`).join('\n')}`);

if (flag('check') && lines.some((l) => !l.ok)) process.exitCode = 1;
