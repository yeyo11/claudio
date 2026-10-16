#!/usr/bin/env node
// Latency of a PreToolUse command hook (plan docs/plans/guards.md, fact F20).
//
//   node scripts/guard-bench.mjs [--calls 200] [--electron <path>] [--json]
//   node scripts/guard-bench.mjs --stream <timeline.jsonl>...
//
// First form: spawns a no-op hook the way the CLI does (`/usr/bin/env -i PATH=… LANG=C.UTF-8 <exec>
// <script>`, a tool-call JSON on stdin, exit 0) once with `node` (Docker, source) and once with the
// desktop app's Electron binary and ELECTRON_RUN_AS_NODE=1, and prints p50/p95/p99 of the wall time
// of each spawn. A first batch of spawns is discarded as warm-up.
//
// Second form: reads the `timeline.jsonl` files g0 recorded next to each capture (one line per
// stream event, with the millisecond it was seen at) and prints the same percentiles for the time
// between a `hook_started` and its `hook_response` as the CLI reports it, which is what the CLI
// adds to a tool call.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const asJson = args.includes('--json');

/** Nearest-rank percentile of a sorted list of numbers. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean,
  };
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
const print = (title, s) => {
  if (asJson) return;
  console.log(`${title.padEnd(34)} n=${String(s.n).padStart(3)}  p50 ${round(s.p50)} ms  p95 ${round(s.p95)} ms  p99 ${round(s.p99)} ms  (min ${round(s.min)}, mean ${round(s.mean)}, max ${round(s.max)})`);
};

function spawnOnce(cmd, argv, env, input) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(cmd, argv, { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(performance.now() - t0) : reject(new Error(`exit ${code}`))));
    child.stdin.end(input);
  });
}

async function measure(label, cmd, argv, env, calls, warmup) {
  const input = JSON.stringify({
    session_id: 'bench', transcript_path: '/dev/null', cwd: '/tmp', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo bench' }, tool_use_id: 'toolu_bench',
  });
  for (let i = 0; i < warmup; i++) await spawnOnce(cmd, argv, env, input);
  const samples = [];
  for (let i = 0; i < calls; i++) samples.push(await spawnOnce(cmd, argv, env, input));
  const s = summarise(samples);
  print(label, s);
  return [label, s];
}

const results = {};
const streams = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--stream') for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) streams.push(args[j]);

if (streams.length > 0) {
  for (const file of streams) {
    const open = new Map();
    const samples = [];
    // The timeline has no hook_id; hook events of one run never overlap in these captures, so a
    // started event pairs with the next response.
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.dir !== 'out') continue;
      if (e.kind.startsWith('system/hook_started') && e.kind.includes('PreToolUse')) open.set('last', e.ms);
      else if (e.kind.startsWith('system/hook_response') && e.kind.includes('PreToolUse') && open.has('last')) {
        samples.push(e.ms - open.get('last'));
        open.delete('last');
      }
    }
    const s = summarise(samples);
    results[file] = s;
    print(file.split('/').slice(-3, -1).join('/'), s);
  }
} else {
  const calls = Number(flag('--calls', '200'));
  const electron = flag('--electron', ['/opt/Claudio/claudio', '/usr/lib/claudio/claudio'].find((p) => existsSync(p)));
  const dir = mkdtempSync(join(tmpdir(), 'guard-bench-'));
  const script = join(dir, 'noop.mjs');
  // Reads its stdin to the end, like the guard has to, and exits 0 without a word
  writeFileSync(script, "import { readFileSync } from 'node:fs'; readFileSync(0); process.exit(0);\n");
  const base = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  try {
    const [l1, s1] = await measure('node (env -i)', '/usr/bin/env', ['-i', `PATH=${base.PATH}`, 'LANG=C.UTF-8', process.execPath, script], {}, calls, 20);
    results[l1] = s1;
    if (electron) {
      const [l2, s2] = await measure('electron as node (env -i)', '/usr/bin/env', ['-i', `PATH=${base.PATH}`, 'LANG=C.UTF-8', 'ELECTRON_RUN_AS_NODE=1', electron, script], {}, calls, 20);
      results[l2] = s2;
    } else if (!asJson) console.log('electron binary not found; pass --electron <path>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (asJson) console.log(JSON.stringify(results, null, 2));
