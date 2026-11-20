import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canaryState, isRecord, type CliCanary, type CliCanaryCheck, type CliCanaryCheckId } from '@claudio/shared';
import { mcpOAuthKey } from './mcp-oauth-key.ts';

/**
 * The canary (docs/plans/account-configuration-and-project-rules.md §6.7): when the CLI is a version
 * Claudio has not checked, S1, S2, S3c and S6 of the plan's spikes are run again against it, each in a
 * temp dir of their own. What shared accounts rely on is behaviour no vendor documents (a rewrite of
 * `.claude.json` that keeps a link, a `plugins/` that survives an install, project trust read from the
 * account's state file), and a CLI release can change any of it.
 *
 * Free by construction: no turn is started and no account is needed. The environment of every process
 * is built from nothing (no variable of the server, no credential, no real `HOME` or config dir), so a
 * check can neither spend anything nor touch what belongs to a person. A check the CLI will not run
 * without a signed-in account is reported as `needs-sign-in` and not retried.
 */

export interface CanaryOptions {
  /** The CLI binary; default `claude` on the PATH */
  claude?: string;
  /** The version being checked; stored with the result as given */
  version: string;
  /** Where the temp dir is made; default the OS's. Only for tests. */
  tmp?: string;
  /** How long one CLI command may take; default 40 s */
  timeoutMs?: number;
  /** How long a project server may stay `pending` before S3c calls it unsettled; default 20 s */
  settleMs?: number;
  /** Where the PATH comes from; default the process's. The rest of the environment is never inherited. */
  env?: NodeJS.ProcessEnv;
  /** Hears of each CLI process as it starts, so the owner can end it on shutdown */
  onSpawn?: (child: ChildProcess) => void;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 40_000;
/** The project server's status is `pending` for a moment after `initialize`; this long is waited for it to settle */
const SETTLE_MS = 20_000;

/** A line of the CLI's own words about being signed out: enough to say "needs sign-in" instead of "error" */
const SIGNED_OUT = /not (?:logged|signed) in|log ?in required|sign ?in required|please (?:run )?\/?login|no (?:account|credentials)/i;

class NeedsSignIn extends Error {}

interface Sandbox {
  root: string;
  env(configDir: string, home: string): NodeJS.ProcessEnv;
  run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; out: string }>;
}

/** What the CLI said, cut to a line: it may be shown on the page, so it never carries more than this */
const gist = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/** Runs the checks against the installed CLI. Never throws: a check that cannot run says why. */
export async function runCanary(opts: CanaryOptions): Promise<CliCanary> {
  const claude = opts.claude ?? 'claude';
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.env ?? process.env;
  const root = await mkdtemp(join(await realpath(opts.tmp ?? tmpdir()), 'claudio-canary-'));
  const sandbox: Sandbox = {
    root,
    // Built from nothing: only what finds the binary and decodes its output. No account variable, no
    // token and no `HOME` of a person can come through.
    env: (configDir, home) => ({
      ...(base.PATH ? { PATH: base.PATH } : {}),
      ...(base.LANG ? { LANG: base.LANG } : {}),
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: root,
      CLAUDE_CONFIG_DIR: configDir,
      DISABLE_AUTOUPDATER: '1',
    }),
    run: (args, env, cwd) =>
      new Promise((resolve, reject) => {
        const child = execFile(claude, args, { env, cwd, timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
          // A binary that is not there or was killed for its time is no answer from the CLI
          if (error && (typeof error.code === 'string' || error.killed)) return reject(error);
          resolve({ code, out: `${stdout}\n${stderr}` });
        });
        // No input is ever sent: closing stdin means a command that waits for some ends instead of hanging until its timeout
        child.stdin?.end();
        opts.onSpawn?.(child);
      }),
  };
  try {
    const checks: CliCanaryCheck[] = [];
    checks.push(await settle('s1', () => checkS1(sandbox)));
    checks.push(await settle('s2', () => checkS2(sandbox)));
    checks.push(await settle('s3c', () => checkS3c(sandbox, claude, timeout, opts.settleMs ?? SETTLE_MS, opts.onSpawn)));
    checks.push(await settle('s6', () => checkS6(sandbox, claude, timeout, opts.settleMs ?? SETTLE_MS, opts.onSpawn)));
    return { version: opts.version, checkedAt: (opts.now?.() ?? new Date()).toISOString(), state: canaryState(checks), checks };
  } finally {
    // Only what this call made: `root` was created above, empty, and nothing else points into it
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function settle(id: CliCanaryCheckId, run: () => Promise<Omit<CliCanaryCheck, 'id'>>): Promise<CliCanaryCheck> {
  try {
    return { id, ...(await run()) };
  } catch (error) {
    if (error instanceof NeedsSignIn) return { id, state: 'needs-sign-in', observed: gist(error.message) || 'the CLI asked for an account signed in' };
    const message = error instanceof Error ? error.message : String(error);
    return { id, state: 'error', observed: `the check could not run: ${gist(message)}` };
  }
}

/** Runs a CLI command that must succeed for the check to mean anything; a refusal for sign-in is its own state */
async function must(sandbox: Sandbox, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const { code, out } = await sandbox.run(args, env, cwd);
  if (code === 0) return out;
  if (SIGNED_OUT.test(out)) throw new NeedsSignIn(gist(out));
  throw new Error(`\`claude ${args.slice(0, 3).join(' ')}\` exited ${code ?? 'abnormally'}: ${gist(out)}`);
}

const isLink = async (path: string): Promise<boolean> => (await lstat(path).then((s) => s.isSymbolicLink(), () => false));
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;

/**
 * S1: does the CLI's rewrite of `.claude.json` replace a symlink? `acc/.claude.json` is a link to a
 * file of `shared/`, and `mcp add --scope user` makes the CLI rewrite the state file. A shared account
 * relies on the write going through the link (or on nobody linking the file: Claudio never does).
 */
async function checkS1(sandbox: Sandbox): Promise<Omit<CliCanaryCheck, 'id'>> {
  const dir = join(sandbox.root, 's1');
  const [home, acc, shared] = [join(dir, 'home'), join(dir, 'acc'), join(dir, 'shared')];
  await Promise.all([home, acc, shared].map((d) => mkdir(d, { recursive: true })));
  await writeFile(join(shared, 'state.json'), '{}\n');
  await symlink(join(shared, 'state.json'), join(acc, '.claude.json'));
  await must(sandbox, ['mcp', 'add', '--scope', 'user', 'canary', '--', 'echo'], sandbox.env(acc, home), dir);
  if (!(await isLink(join(acc, '.claude.json')))) return { state: 'fail', observed: 'the CLI replaced the linked state file with a regular file of its own' };
  const doc = await readJson(join(shared, 'state.json')).catch(() => null);
  const servers = isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : {};
  if (!('canary' in servers)) return { state: 'fail', observed: 'the state file is still a link, but the file it points to does not hold the new server' };
  return { state: 'pass', observed: 'the state file is still a link and the file it points to holds the new server' };
}

/**
 * S2: do a linked `plugins/` and `settings.json` survive a plugin install and update? A directory
 * marketplace (no network) with one plugin is added and installed, its version is raised and the
 * marketplace and the plugin are updated, all in an account dir whose two items are links.
 */
async function checkS2(sandbox: Sandbox): Promise<Omit<CliCanaryCheck, 'id'>> {
  const dir = join(sandbox.root, 's2');
  const [home, acc, shared, market] = [join(dir, 'home'), join(dir, 'acc'), join(dir, 'shared'), join(dir, 'market')];
  const plugin = join(market, 'plugins', 'canary-plugin');
  await Promise.all([home, acc, join(shared, 'plugins'), join(market, '.claude-plugin'), join(plugin, '.claude-plugin')].map((d) => mkdir(d, { recursive: true })));
  await writeFile(join(shared, 'settings.json'), '{}\n');
  await symlink(join(shared, 'plugins'), join(acc, 'plugins'));
  await symlink(join(shared, 'settings.json'), join(acc, 'settings.json'));
  await writeFile(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'canary-market', owner: { name: 'canary' }, plugins: [{ name: 'canary-plugin', source: './plugins/canary-plugin', description: 'canary' }] }));
  const manifest = (version: string): Promise<void> => writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'canary-plugin', version, description: 'canary' }));
  await manifest('1.0.0');
  const env = sandbox.env(acc, home);
  await must(sandbox, ['plugin', 'marketplace', 'add', market], env, dir);
  await must(sandbox, ['plugin', 'install', 'canary-plugin@canary-market'], env, dir);
  await manifest('1.1.0');
  await must(sandbox, ['plugin', 'marketplace', 'update', 'canary-market'], env, dir);
  await must(sandbox, ['plugin', 'update', 'canary-plugin@canary-market'], env, dir);
  const replaced = [(await isLink(join(acc, 'plugins'))) ? null : 'plugins/', (await isLink(join(acc, 'settings.json'))) ? null : 'settings.json'].filter((x): x is string => x !== null);
  if (replaced.length) return { state: 'fail', observed: `the CLI replaced the link of ${replaced.join(' and ')} with a real ${replaced.length > 1 ? 'items' : 'item'} of its own` };
  const settings = await readJson(join(shared, 'settings.json')).catch(() => null);
  const enabled = isRecord(settings) && isRecord(settings.enabledPlugins) && settings.enabledPlugins['canary-plugin@canary-market'] === true;
  const records = await readJson(join(shared, 'plugins', 'installed_plugins.json')).catch(() => null);
  const installed = isRecord(records) && isRecord(records.plugins) && 'canary-plugin@canary-market' in records.plugins;
  if (!enabled || !installed) {
    return { state: 'fail', observed: `both items are still links, but the linked ${[enabled ? null : 'settings.json lacks the plugin', installed ? null : 'plugins/ has no install record'].filter(Boolean).join(' and ')}` };
  }
  return { state: 'pass', observed: 'plugins/ and settings.json are still links; the plugin is enabled in the linked settings and recorded in the linked plugins/' };
}

/** A minimal MCP server over HTTP that answers only a request carrying the header the helper prints */
function mcpServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      if (req.headers['x-canary'] !== '1') {
        res.writeHead(404).end();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!isRecord(message) || message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const params = isRecord(message.params) ? message.params : {};
      const result =
        message.method === 'initialize'
          ? { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canary', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [] }
            : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the canary talks to nothing outside the machine
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('the local server has no port'));
      resolve({ server, port: address.port });
    });
  });
}

interface Session {
  ask(subtype: string): Promise<Record<string, unknown>>;
  end(): void;
}

/** One `claude -p --input-format stream-json` process that answers control requests, with no turn */
function session(claude: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number, onSpawn?: (child: ChildProcess) => void): Session {
  const child = spawn(claude, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  onSpawn?.(child);
  const waiting = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let ended: Error | null = null;
  const fail = (error: Error): void => {
    ended ??= error;
    for (const w of waiting.values()) w.reject(ended);
    waiting.clear();
  };
  child.on('error', (e) => fail(e));
  child.on('close', () => fail(new Error('the CLI ended before it answered')));
  child.stdin.on('error', () => undefined);
  // Read only for a refusal to run signed out, and cut before it is kept
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(msg) || msg.type !== 'control_response' || !isRecord(msg.response)) continue;
      const id = typeof msg.response.request_id === 'string' ? msg.response.request_id : '';
      const w = waiting.get(id);
      if (!w) continue;
      waiting.delete(id);
      if (msg.response.subtype === 'error') {
        const text = typeof msg.response.error === 'string' ? msg.response.error : '';
        w.reject(SIGNED_OUT.test(text) || SIGNED_OUT.test(stderr) ? new NeedsSignIn(gist(text || stderr)) : new Error(`the CLI refused the request: ${gist(text)}`));
      } else w.resolve(isRecord(msg.response.response) ? msg.response.response : {});
    }
  });
  let n = 0;
  return {
    ask: (subtype) =>
      new Promise((resolve, reject) => {
        if (ended) return reject(ended);
        const id = `canary-${n++}`;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`the CLI did not answer ${subtype} in ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
        child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`);
      }),
    end: () => {
      child.kill();
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The status of the server `name` once it stops being `pending`, or `pending` when it never does */
async function statusOf(s: Session, name: string, settleMs: number): Promise<string> {
  const until = Date.now() + settleMs;
  for (;;) {
    const answer = await s.ask('mcp_status');
    const servers = Array.isArray(answer.mcpServers) ? answer.mcpServers : [];
    const found = servers.find((x): x is Record<string, unknown> => isRecord(x) && x.name === name);
    const status = found && typeof found.status === 'string' ? found.status : 'absent';
    if (status !== 'pending' || Date.now() >= until) return status;
    await wait(500);
  }
}

/**
 * S3c: is a project's `.mcp.json` server trusted from the account's state file in Claudio's own
 * mode? Two runs of `initialize` plus `mcp_status` control requests (no turn) in a project with one
 * HTTP server whose `headersHelper` leaves a mark when it runs: without
 * `projects[<dir>].hasTrustDialogAccepted` the helper must not run and the server must not connect;
 * with it, both must. The overlay of the plan's §6.4 stands on exactly this.
 */
async function checkS3c(sandbox: Sandbox, claude: string, timeoutMs: number, settleMs: number, onSpawn?: (child: ChildProcess) => void): Promise<Omit<CliCanaryCheck, 'id'>> {
  const dir = join(sandbox.root, 's3c');
  await mkdir(dir, { recursive: true });
  const { server, port } = await mcpServer();
  try {
    const helper = join(dir, 'helper.mjs');
    const marks = join(dir, 'helper-runs');
    await writeFile(helper, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marks)}, 'x');\nconsole.log(JSON.stringify({ 'x-canary': '1' }));\n`);
    await chmod(helper, 0o755);
    const observe = async (trusted: boolean): Promise<{ status: string; helperRuns: number }> => {
      const name = trusted ? 'trusted' : 'untrusted';
      const [home, acc, proj] = [join(dir, name, 'home'), join(dir, name, 'acc'), join(dir, name, 'proj')];
      await Promise.all([home, acc, proj].map((d) => mkdir(d, { recursive: true })));
      await writeFile(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { canary: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headersHelper: helper } } }));
      // The path the CLI itself sees as its cwd is the key it reads trust under
      if (trusted) await writeFile(join(acc, '.claude.json'), JSON.stringify({ projects: { [await realpath(proj)]: { hasTrustDialogAccepted: true } } }));
      await rm(marks, { force: true });
      const s = session(claude, sandbox.env(acc, home), proj, timeoutMs, onSpawn);
      try {
        await s.ask('initialize');
        const status = await statusOf(s, 'canary', settleMs);
        const runs = await readFile(marks, 'utf8').then((t) => t.length, () => 0);
        return { status, helperRuns: runs };
      } finally {
        s.end();
      }
    };
    const without = await observe(false);
    const withTrust = await observe(true);
    const seen = `without trust the server was ${without.status} and its helper ran ${without.helperRuns} times; with trust it was ${withTrust.status} and its helper ran ${withTrust.helperRuns} times`;
    if (withTrust.status === 'pending' || without.status === 'pending') return { state: 'error', observed: `the server never settled: ${seen}` };
    if (without.status === 'connected' || without.helperRuns > 0) return { state: 'fail', observed: `the CLI used the project's server without the account trusting the project: ${seen}` };
    if (withTrust.status !== 'connected' || withTrust.helperRuns < 1) return { state: 'fail', observed: `the account's trust of the project no longer makes its server connect: ${seen}` };
    return { state: 'pass', observed: seen };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** A local HTTP MCP server that answers only a request with `Authorization: Bearer <token>`, and 401 to any other */
function bearerServer(token: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!isRecord(message) || message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const params = isRecord(message.params) ? message.params : {};
      const result =
        message.method === 'initialize'
          ? { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canary', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [] }
            : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only, as for the server of S3c
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('the local server has no port'));
      resolve({ server, port: address.port });
    });
  });
}

/**
 * S6: does the CLI accept an `mcpOAuth` entry copied into another config dir under the key Claudio
 * computes? (The S6 follow-up of the plan: shared accounts get the default's MCP sign-ins.) A local
 * HTTP server answers only a bearer token. An account with the server and no entry must not connect;
 * the same account with the entry written under `mcpOAuthKey` (its token being the one the server
 * wants) must. If the key formula drifted, the CLI would not find the entry and the second run says so.
 * Unlike S1 to S3c, a failure here stops the copies: its failure mode is a 401, not a silent difference.
 * The token is random, lives in the temp dir and is never in what is observed.
 */
async function checkS6(sandbox: Sandbox, claude: string, timeoutMs: number, settleMs: number, onSpawn?: (child: ChildProcess) => void): Promise<Omit<CliCanaryCheck, 'id'>> {
  const dir = join(sandbox.root, 's6');
  await mkdir(dir, { recursive: true });
  const token = randomBytes(16).toString('hex');
  const { server, port } = await bearerServer(token);
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    const name = 'canary-oauth';
    const observe = async (copied: boolean): Promise<string> => {
      const label = copied ? 'with' : 'without';
      const [home, acc, proj] = [join(dir, label, 'home'), join(dir, label, 'acc'), join(dir, label, 'proj')];
      await Promise.all([home, acc, proj].map((d) => mkdir(d, { recursive: true })));
      await writeFile(join(acc, '.claude.json'), JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }));
      if (copied) {
        const entry = { serverName: name, serverUrl: url, accessToken: token, discoveryState: { authorizationServerUrl: `http://127.0.0.1:${port}` } };
        await writeFile(join(acc, '.credentials.json'), JSON.stringify({ mcpOAuth: { [mcpOAuthKey({ name, type: 'http', url })]: entry } }), { mode: 0o600 });
      }
      const s = session(claude, sandbox.env(acc, home), proj, timeoutMs, onSpawn);
      try {
        await s.ask('initialize');
        return await statusOf(s, name, settleMs);
      } finally {
        s.end();
      }
    };
    const without = await observe(false);
    const withEntry = await observe(true);
    const seen = `without the entry the server was ${without}; with the entry copied under the computed key it was ${withEntry}`;
    if (without === 'pending' || withEntry === 'pending') return { state: 'error', observed: `the server never settled: ${seen}` };
    // A server that connects with no token says nothing about a copy
    if (without === 'connected') return { state: 'error', observed: `the check says nothing, the server connected with no token: ${seen}` };
    if (withEntry !== 'connected') return { state: 'fail', observed: `a copied entry under the computed key is no longer accepted (the key formula or the entry's shape changed): ${seen}` };
    return { state: 'pass', observed: seen };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
