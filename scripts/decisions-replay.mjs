#!/usr/bin/env node
// Puts a decision point's labelled states to a provider again and scores the answers against the
// labels (docs/plans/decision-engine-v2.md, M5). A person runs it; it is the way to try a reworded
// question, a new Jev version or the CLI's model before the point ships with them.
//
//   pnpm exec tsx scripts/decisions-replay.mjs --point run.continuation --provider jev
//   pnpm exec tsx scripts/decisions-replay.mjs --data ~/.config/Claudio/data --point flow.bounce \
//       --provider cli --questions reworded.json --dry-run
//
// Flags
//   --data <dir>            the data directory to read (wrapper.db, decisions.json and, for Jev, the saved
//                           key). Without it the script uses CLAUDIO_DATA_DIR or the app's default and
//                           prints which one: it never picks one silently
//   --point <id>            the decision point (required)
//   --provider cli|jev      where the states go (default: the provider the point runs on)
//   --questions <file.json> reworded questions (a JSON array of questions) instead of the point's own
//   --labels <file.jsonl>   a set built outside: one { state, questions?, positive, note? } per line,
//                           instead of the table's labels
//   --limit <n>             the newest n labels (default 100)
//   --concurrency <n>       calls at once (default 2, at most 8)
//   --dry-run               print what would be sent and to whom, and send nothing
//   --consented-by-owner    the owner says consent for this point and provider was given out of band, for
//                           this one run; recorded with the stored result. Without consent in
//                           decisions.json or this flag, nothing is sent
//   --no-store              print the result and write nothing
//   --note <text>           kept with the stored result
//   --model <id>            the CLI's model (default: decisions.json's `cli.model`)
//   --deadline-ms <n>       per call (default 5000 for jev, 60000 for cli)
//   --max-cost <usd>        stop starting calls past this spend (default 1)
//   --max-minutes <n>       the whole run's ceiling (default 30)
//
// The database is opened read-only to read the labels, and a second time, read-write, only to
// append the result when it is stored: the script never migrates, prunes or otherwise touches a
// live install's tables. A Jev key is read through the credential store and is never printed.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = async (relative) => {
  try {
    return await import(pathToFileURL(join(root, relative)).href);
  } catch (err) {
    if (err && (err.code === 'ERR_UNKNOWN_FILE_EXTENSION' || err.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
      console.error('This script imports the sources in TypeScript: run it with tsx, `pnpm exec tsx scripts/decisions-replay.mjs ...`');
      process.exit(1);
    }
    throw err;
  }
};
const core = 'packages/core/src/decisions';
const { replayDecisions, replayConsent, replayRecord, parseQuestions, ReplayError } = await load(`${core}/replay.ts`);
const { readDecisionLabels, hasReplayTable, insertDecisionReplay } = await load(`${core}/replay-rows.ts`);
const { decisionPoint } = await load(`${core}/points.ts`);
const { redactState, stateBytes } = await load(`${core}/redact.ts`);
const { JevProvider } = await load(`${core}/providers/jev.ts`);
const { decisionPrompt, decisionSchema, parseAnswers } = await load(`${core}/providers/cli.ts`);
const { DecisionCredentialStore, JEV_MODEL } = await load(`${core}/settings.ts`);
const { dataDirFrom } = await load('packages/core/src/paths.ts');

const VALUE_FLAGS = new Set(['--data', '--point', '--provider', '--questions', '--labels', '--limit', '--concurrency', '--note', '--model', '--deadline-ms', '--max-cost', '--max-minutes']);
const SWITCHES = new Set(['--dry-run', '--consented-by-owner', '--no-store', '--help']);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES.has(arg)) opts[arg] = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`);
      opts[arg] = value;
    } else die(`unknown flag ${arg}`);
  }
  return opts;
}

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const whole = (value, fallback, name, max) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) die(`${name} must be a whole number from 1${max ? ` to ${max}` : ''}`);
  return n;
};

const opts = parseArgs(process.argv.slice(2));
if (opts['--help']) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const point = opts['--point'];
if (!point) die('--point is required');
const def = decisionPoint(point);
if (!def) die(`unknown decision point ${point}`);

// ---- Which install: said out loud, never guessed silently
const dataFlag = opts['--data'];
const dataDir = dataFlag ? resolve(dataFlag) : dataDirFrom();
const dataFrom = dataFlag ? '--data' : process.env.CLAUDIO_DATA_DIR ? 'CLAUDIO_DATA_DIR' : "the app's default";
console.log(`data directory: ${dataDir} (from ${dataFrom})`);
const dbPath = join(dataDir, 'wrapper.db');
if (!existsSync(dbPath)) die(`no wrapper.db in ${dataDir}: pass --data with the directory of an install`);

const readJson = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
// decisions.json is read as it is, never through the settings store, which creates directories and migrates files
const stored = readJson(join(dataDir, 'decisions.json'));
const settings = { points: stored.points && typeof stored.points === 'object' ? stored.points : {} };
const cliSettings = stored.cli && typeof stored.cli === 'object' ? stored.cli : {};

const providerId = opts['--provider'] ?? (stored.provider === 'jev' || stored.provider === 'cli' ? stored.provider : 'cli');
if (providerId !== 'cli' && providerId !== 'jev') die('--provider must be cli or jev');

// ---- The cases: the table's labels (read-only) or a file
function readLabels() {
  const file = opts['--labels'];
  if (file) {
    const lines = readFileSync(resolve(file), 'utf8').split('\n').filter((l) => l.trim() !== '');
    return lines.map((line, i) => {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        return die(`${file} line ${i + 1} is not JSON`);
      }
      if (!item || typeof item.state !== 'object' || item.state === null || typeof item.positive !== 'boolean') die(`${file} line ${i + 1} needs a state object and a boolean positive`);
      const questions = item.questions === undefined ? [] : parseQuestions(item.questions);
      if (!questions) die(`${file} line ${i + 1}: questions are not valid`);
      return { id: null, state: item.state, questions, positive: item.positive };
    });
  }
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  try {
    conn.exec('PRAGMA busy_timeout = 5000');
    const table = conn.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'decision_labels'").get();
    if (!table) die('this install has no golden set yet: open it once with a version that has replays');
    return readDecisionLabels(conn, point).map((l) => ({ id: l.id, state: l.state, questions: l.questions, positive: l.positive }));
  } finally {
    conn.close();
  }
}

const limit = whole(opts['--limit'], 100, '--limit');
const all = readLabels();
const cases = all.slice(-limit);
if (cases.length === 0) die(`${point} has no labels${opts['--labels'] ? ' in that file' : ''}`, 2);

let questions;
if (opts['--questions']) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolve(opts['--questions']), 'utf8'));
  } catch {
    die(`${opts['--questions']} is not JSON`);
  }
  questions = parseQuestions(raw);
  if (!questions) die(`${opts['--questions']} is not a valid list of questions (unique ids; choices need 2 to 255 options, scores 2 to 10 levels)`);
}

// ---- The provider
const model = providerId === 'jev' ? JEV_MODEL : (opts['--model'] ?? (typeof cliSettings.model === 'string' ? cliSettings.model : 'haiku'));
const maxCostUsd = opts['--max-cost'] === undefined ? 1 : Number(opts['--max-cost']);
if (!(maxCostUsd > 0)) die('--max-cost must be above 0');

/**
 * The CLI, driven directly: a one-shot `claude -p` with no tool, held to the question's schema. The
 * server uses its chat runtime for this; standing that up here would open the live database for
 * writing, which this script must not. It runs in an empty directory so no project's files are read.
 */
// As confined as the engine's own chat (`confine` in packages/core/src/one-shot.ts and the flags
// `providers/claude-code/args.ts` builds from it): the stored states are untrusted text, so the
// person's hooks, settings files and MCP servers must not load beside them. The `=` forms keep an
// empty list a value of its flag.
const CONFINEMENT = ['--restricted', '--tools=', '--setting-sources=', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'dontAsk'];

/** The child's environment: what it needs to sign in, and never a Claudio server's address, token or chat id */
function confinedEnv() {
  const env = { ...process.env };
  for (const name of ['CLAUDIO_API_URL', 'CLAUDIO_API_TOKEN', 'CLAUDIO_CHAT_ID']) delete env[name];
  return env;
}

function claudeCliProvider() {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const callBudget = typeof cliSettings.maxCostUsd === 'number' && cliSettings.maxCostUsd > 0 ? cliSettings.maxCostUsd : 0.1;
  const cwd = mkdtempSync(join(tmpdir(), 'decisions-replay-'));
  return {
    id: 'cli',
    available: () => true,
    ask(request, { signal }) {
      const started = Date.now();
      const unavailable = (reason) => ({ status: 'unavailable', reason, latencyMs: Date.now() - started });
      const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(decisionSchema(request.questions)), '--model', model, '--max-budget-usd', String(callBudget), '--no-session-persistence', ...CONFINEMENT];
      return new Promise((resolveAsk) => {
        let out = '';
        let child;
        try {
          child = spawn(bin, args, { cwd, env: confinedEnv(), stdio: ['pipe', 'pipe', 'ignore'], signal });
        } catch {
          resolveAsk(unavailable('server-error'));
          return;
        }
        child.on('error', () => resolveAsk(unavailable(signal.aborted ? 'timeout' : 'server-error')));
        child.stdout.on('data', (chunk) => {
          if (out.length < 4_000_000) out += chunk;
        });
        child.on('close', () => {
          let result;
          try {
            result = JSON.parse(out);
          } catch {
            resolveAsk(unavailable(signal.aborted ? 'timeout' : 'server-error'));
            return;
          }
          if (!result || result.is_error) {
            resolveAsk(unavailable(typeof result?.result === 'string' && /limit/i.test(result.result) ? 'rate-limited' : 'server-error'));
            return;
          }
          const answers = parseAnswers(result.structured_output, request.questions);
          if (!answers) {
            resolveAsk(unavailable('invalid-answer'));
            return;
          }
          resolveAsk({ status: 'answered', answers, latencyMs: Date.now() - started, inputTokens: null, costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null, model });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(decisionPrompt(request, model));
      });
    },
  };
}

const provider = providerId === 'jev' ? new JevProvider({ getKey: () => new DecisionCredentialStore({ dataDir }).getKey() }) : claudeCliProvider();
const consent = replayConsent(point, providerId, settings, opts['--consented-by-owner'] === true);
const destination = providerId === 'jev' ? `TypeSafe (Jev, ${JEV_MODEL})` : `Claude Code, model ${model}`;

// ---- Dry run: what would go, to whom
if (opts['--dry-run']) {
  const sizes = cases.map((c) => stateBytes(redactState(c.state, def.maxStateBytes)));
  const total = sizes.reduce((a, b) => a + b, 0);
  const first = cases[0];
  const wording = questions ?? (first && first.questions.length > 0 ? first.questions : []);
  console.log(`dry run: nothing is sent`);
  console.log(`point: ${point} (state version ${def.stateVersion})`);
  console.log(`would send: ${cases.length} labelled states, ${total} bytes after redaction (largest ${Math.max(...sizes)}), one call each, to ${destination}`);
  console.log(`consent: ${consent === 'point' ? 'the point has it' : consent === 'owner-flag' ? 'out of band, from --consented-by-owner' : 'MISSING: a real run would refuse'}`);
  console.log(`questions: ${questions ? `reworded, from ${opts['--questions']}` : "the point's own"}`);
  console.log(JSON.stringify(wording, null, 2));
  process.exit(0);
}

if (!consent) {
  die(`${point} has no consent for ${providerId} at state version ${def.stateVersion}. A replay sends states out as a live request does: grant it in Settings, or pass --consented-by-owner if you gave it out of band for this run.`, 2);
}

// ---- Run
const concurrency = whole(opts['--concurrency'], 2, '--concurrency', 8);
const deadlineMs = whole(opts['--deadline-ms'], providerId === 'jev' ? 5_000 : 60_000, '--deadline-ms');
const maxMinutes = whole(opts['--max-minutes'], 30, '--max-minutes');
console.log(`replaying ${cases.length} cases of ${point} on ${destination} (consent: ${consent})`);

let run;
try {
  run = await replayDecisions({
    point,
    cases,
    ...(questions ? { questions } : {}),
    provider,
    concurrency,
    deadlineMs,
    signal: AbortSignal.timeout(maxMinutes * 60_000),
    consent: { settings, ownerFlag: opts['--consented-by-owner'] === true },
    model,
    maxCostUsd,
    onProgress: (done, total) => {
      if (done === total || done % 10 === 0) console.log(`  ${done}/${total}`);
    },
  });
} catch (err) {
  if (err instanceof ReplayError) die(err.message, 2);
  throw err;
}

// ---- Report
const pct = (r) => (r.value === null ? 'n/a' : `${r.value.toFixed(2)} (90% lower bound ${r.lower90 === null ? 'n/a' : r.lower90.toFixed(2)}, n=${r.n})`);
const c = run.confusion;
console.log(`\nprovider ${run.provider}, model ${run.model || 'unknown'}, questions ${run.questionsHash}`);
console.log(`cases ${run.cases}, unavailable ${run.unavailable}, cost ${run.costUsd.toFixed(4)} US$`);
if (run.unavailable > 0) {
  const reasons = {};
  for (const r of run.results) if (r.unavailable) reasons[r.unavailable] = (reasons[r.unavailable] ?? 0) + 1;
  console.log(`  unavailable by reason: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
console.log(`precision of the answer that acts: ${pct(run.score.precision)}`);
console.log(`recall of the answer that acts:    ${pct(c.recall)}`);
console.log(`act rate:                          ${pct(run.score.actRate)}`);
console.log('\nconfusion (answer against label)');
console.log('                     acting was right   acting was wrong');
console.log(`  answer acts        ${String(c.actedRight).padStart(16)}   ${String(c.actedWrong).padStart(16)}`);
console.log(`  answer holds       ${String(c.heldWrong).padStart(16)}   ${String(c.heldRight).padStart(16)}`);
if (c.unreadable > 0) console.log(`  answers that say neither: ${c.unreadable}`);
const buckets = run.score.calibration.filter((b) => b.all.n > 0);
if (buckets.length > 0) {
  console.log('\nreliability (confidence bucket, answers, observed accuracy)');
  for (const b of buckets) console.log(`  ${b.from.toFixed(2)}-${b.to.toFixed(2)}  n=${b.all.n}  ${b.all.value === null ? 'n/a' : b.all.value.toFixed(2)}`);
}

// ---- Store
if (run.aborted) {
  console.log('\nthe run hit its time ceiling: the result is partial and was not stored');
  process.exit(1);
}
if (opts['--no-store']) {
  console.log('\n--no-store: nothing written');
  process.exit(0);
}
const conn = new DatabaseSync(dbPath);
try {
  conn.exec('PRAGMA busy_timeout = 5000');
  if (!hasReplayTable(conn)) die('\nthis install has not run the version that stores replays: open it once with that version, then store again. Nothing was written.');
  const note = opts['--note'] ?? (opts['--labels'] ? `labels from ${basename(opts['--labels'])}` : null);
  insertDecisionReplay(conn, replayRecord(run, { at: new Date(), note }));
  console.log(`\nstored (consent: ${run.consent})`);
} finally {
  conn.close();
}
