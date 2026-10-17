// Runs the e2e suite on GitHub Actions (.github/workflows/e2e.yml) for the pushed branch, and waits
// for it. The suite never runs on a developer's machine (docs/decisions/e2e-on-github.md).
//   pnpm e2e:remote                    the whole suite, 4 shards
//   pnpm e2e:remote config palette     only the specs those prefixes name, as `pnpm e2e` takes them
//   pnpm e2e:remote --shards 2 a11y    a shard count of your own, 1 to 4
//   pnpm e2e:remote --wait <run id>    go on waiting for a run started earlier
// It waits at most E2E_REMOTE_WAIT seconds (default 540, under the 10 minutes an agent's command may
// take), then exits 3 and prints the --wait line to go on with. On a failure it downloads every
// failed shard's log and screenshots and prints where they are, with the end of each log.
// Exit codes: 0 passed, 1 failed or cancelled, 2 refused before starting, 3 still running.
// It talks to GitHub through the `gh` CLI, signed in as the person or agent running it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = 'e2e.yml';
const MAX_SHARDS = 4;

/** The spec files each prefix names, the way e2e/run.mjs picks them; a prefix that names none is an error. */
export function matchSpecs(prefixes, files) {
  const specs = files.filter((f) => f.endsWith('.spec.mjs')).sort();
  const unknown = prefixes.filter((p) => !specs.some((f) => f.startsWith(p)));
  const matched = prefixes.length === 0 ? specs : specs.filter((f) => prefixes.some((p) => f.startsWith(p)));
  return { matched, unknown };
}

/** The whole suite gets every shard; a few specs get one shard per two of them, so no shard is empty for long. */
export function defaultShards(matchedCount, wholeSuite) {
  if (wholeSuite) return MAX_SHARDS;
  return Math.max(1, Math.min(MAX_SHARDS, Math.ceil(matchedCount / 2)));
}

/** The run this dispatch started: the newest dispatch of this commit created after we asked. */
export function pickRun(runs, headSha, sinceMs) {
  return (
    runs
      .filter((r) => r.headSha === headSha && Date.parse(r.createdAt) >= sinceMs - 5_000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}

/** Parses the command line; throws with a message for the person on a bad one. */
export function parseArgs(argv) {
  const out = { prefixes: [], shards: null, wait: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shards') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_SHARDS) throw new Error(`--shards takes 1 to ${MAX_SHARDS}, got "${argv[i]}"`);
      out.shards = n;
    } else if (a === '--wait') {
      const id = argv[++i];
      if (!/^\d+$/.test(id ?? '')) throw new Error(`--wait takes the run id printed earlier, got "${id}"`);
      out.wait = id;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a}`);
    } else {
      for (const p of a.split(',').filter(Boolean)) {
        if (!/^[A-Za-z0-9._-]+$/.test(p)) throw new Error(`a spec prefix is letters, digits, '.', '_' and '-', got "${p}"`);
        out.prefixes.push(p);
      }
    }
  }
  return out;
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gh = (...args) => sh('gh', args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(line);

function refuse(message) {
  console.error(message);
  process.exit(2);
}

/** The branch to test, refusing what GitHub would not be testing: a detached head, main, or a commit not pushed. */
function pushedBranch() {
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') refuse('HEAD is detached: check out a branch and push it first.');
  if (branch === 'main') refuse('This is main: run the suite on the branch of your change, before it is merged.');
  const head = sh('git', ['rev-parse', 'HEAD']);
  const remote = sh('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0] ?? '';
  if (remote !== head) {
    refuse(
      remote
        ? `origin/${branch} is at ${remote.slice(0, 9)}, not at your ${head.slice(0, 9)}: push first (git push origin ${branch}).`
        : `${branch} is not on origin: push it first (git push -u origin ${branch}).`,
    );
  }
  if (sh('git', ['status', '--porcelain', '--untracked-files=no'])) {
    say('Note: you have uncommitted changes. GitHub tests the pushed commit, without them.');
  }
  return { branch, head };
}

async function dispatch({ prefixes, shards }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { matched, unknown } = matchSpecs(prefixes, readdirSync(join(here, 'specs')));
  if (unknown.length) refuse(`No spec in e2e/specs starts with: ${unknown.join(', ')}`);
  const { branch, head } = pushedBranch();
  const count = shards ?? defaultShards(matched.length, prefixes.length === 0);
  const since = Date.now();
  try {
    gh('workflow', 'run', WORKFLOW, '--ref', branch, '-f', `specs=${prefixes.join(' ')}`, '-f', `shards=${count}`);
  } catch (error) {
    // A branch cut before e2e.yml took dispatches has no such workflow to run
    refuse(`GitHub refused the dispatch: ${String(error.stderr ?? error.message).trim()}\nIf ${branch} predates .github/workflows/e2e.yml, rebase it on main and push.`);
  }
  say(`Dispatched ${WORKFLOW} on ${branch} (${head.slice(0, 9)}): ${prefixes.length ? `${matched.length} spec file(s)` : 'the whole suite'}, ${count} shard(s).`);
  // GitHub lists a dispatched run a few seconds after accepting it
  for (let i = 0; i < 30; i++) {
    const runs = JSON.parse(gh('run', 'list', '--workflow', WORKFLOW, '--branch', branch, '--event', 'workflow_dispatch', '--limit', '10', '--json', 'databaseId,headSha,createdAt,url'));
    const run = pickRun(runs, head, since);
    if (run) return String(run.databaseId);
    await sleep(3_000);
  }
  console.error(`GitHub accepted the dispatch but listed no run for ${head.slice(0, 9)} within 90 s: see gh run list --workflow ${WORKFLOW} --branch ${branch}`);
  process.exit(1);
}

function newestFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function reportFailure(id, jobs) {
  const dir = join(tmpdir(), `claudio-e2e-remote-${id}`);
  try {
    gh('run', 'download', id, '--dir', dir);
  } catch (error) {
    say(`Could not download the artifacts (${String(error.stderr ?? error.message).trim()}); read the log with: gh run view ${id} --log-failed`);
    return;
  }
  const files = newestFiles(dir);
  for (const log of files.filter((f) => f.endsWith('e2e.log'))) {
    const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
    const tail = lines.slice(-60);
    say(`\n--- ${log} (${tail.length < lines.length ? `last ${tail.length} of ${lines.length} lines` : `${lines.length} lines`})`);
    say(tail.join('\n'));
  }
  const shots = files.filter((f) => f.endsWith('.png'));
  say(`\nArtifacts of the failed shards: ${dir} (${shots.length} screenshot(s))`);
  const failed = jobs.filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped').map((j) => j.name);
  if (failed.length) say(`Failed: ${failed.join(', ')}`);
}

async function wait(id) {
  const limitMs = Number(process.env.E2E_REMOTE_WAIT || 540) * 1000;
  const start = Date.now();
  let url = '';
  let seen = '';
  for (;;) {
    const run = JSON.parse(gh('run', 'view', id, '--json', 'status,conclusion,url,jobs'));
    url = run.url;
    const line = run.jobs.map((j) => `${j.name}: ${j.conclusion || j.status}`).join(' · ');
    if (line && line !== seen) {
      say(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
      seen = line;
    }
    if (run.status === 'completed') {
      say(`${run.conclusion === 'success' ? 'PASSED' : run.conclusion.toUpperCase()}: ${url}`);
      if (run.conclusion !== 'success') {
        reportFailure(id, run.jobs);
        process.exit(1);
      }
      process.exit(0);
    }
    if (Date.now() - start > limitMs) {
      say(`Still running after ${Math.round(limitMs / 1000)} s: ${url}`);
      say(`Go on waiting with: pnpm e2e:remote --wait ${id}`);
      process.exit(3);
    }
    await sleep(20_000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    refuse(error.message);
  }
  try {
    gh('auth', 'status');
  } catch {
    refuse('The gh CLI is not signed in: run gh auth login.');
  }
  const id = args.wait ?? (await dispatch(args));
  say(`Run ${id}`);
  await wait(id);
}
