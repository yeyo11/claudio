import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { Account, AccountLimit, AccountLoginSession, SystemInfo } from '@claudio/shared';
import { Api, CliError, EXIT, Interrupted, type ExitCode } from './client.ts';

/**
 * What `GET /api/ready` answers (D11): `ReadyStatus` of the shared types, which the `profile` task
 * adds; read here by shape so the command does not depend on its order of arrival.
 */
interface ReadyAnswer {
  ready: boolean;
  reason?: string;
}

/** What `claudio status --json` prints: the readiness plus the account and its last usage reading. */
export interface StatusReport {
  url: string;
  ready: boolean;
  /** Why it is not ready (`cli-missing`, `signed-out`, `sign-in-expired`, `starting`); null when it is */
  reason: string | null;
  version: string;
  /** `full` or `headless`; null from a server that does not say */
  profile: string | null;
  cli: { installed: boolean; version: string | null };
  /** The account new work would start on; null when none can take work */
  account: {
    id: string;
    label: string;
    kind: string;
    email: string | null;
    plan: string | null;
    signInState: string;
    checkedAt: string | null;
  } | null;
  /** Its last usage reading; null when nothing was read */
  usage: AccountLimit | null;
}

/** Everything the command touches of its process, so a test drives it whole. */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /**
   * Prompts and reads one line without echoing it. Resolves null at the end of input; rejects once
   * `signal` aborts.
   */
  readSecret: (prompt: string, signal: AbortSignal) => Promise<string | null>;
  /** Aborted when the person presses Ctrl-C */
  interrupt: AbortSignal;
  /** How often a sign-in's state is read; 1 s by default */
  pollMs?: number;
}

const USAGE = `Usage:
  claudio login  [--url URL] [--token TOKEN] [--account default]
  claudio status [--url URL] [--token TOKEN] [--json]

Signs a Claudio server's Claude account in, or says whether it is ready to take work.

Options:
  --url URL        The server (default http://127.0.0.1:$PORT, PORT 8797 when unset)
  --token TOKEN    Its API token (default $CLAUDIO_AUTH_TOKEN, then the first-run token file)
  --account ID     The account to sign in (default: default, the CLI's own login)
  --json           Print the status as JSON
  -h, --help       Show this help

Exit codes: 0 done (status: ready), 1 failed or expired (status: not ready), 2 usage or connection error.
`;

const REASONS: Record<string, string> = {
  'cli-missing': 'Claude Code is not installed',
  'signed-out': 'no account is signed in; run `claudio login`',
  'sign-in-expired': 'the sign-in expired; run `claudio login`',
  starting: 'the server is still starting',
};

/** Runs `claudio <argv>` and resolves the exit code; it never exits the process itself. */
export async function run(argv: string[], io: CliIo): Promise<ExitCode> {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    if (err instanceof Interrupted) {
      io.err('Cancelled.\n');
      return EXIT.failed;
    }
    if (err instanceof CliError) {
      io.err(`claudio: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

async function dispatch(argv: string[], io: CliIo): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        account: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return usage(io, err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (!command) return usage(io, 'a command is required');
  if (rest.length) return usage(io, `unexpected argument: ${rest.join(' ')}`);
  if (command !== 'login' && command !== 'status') return usage(io, `unknown command: ${command}`);
  if (command === 'login' && values.json) return usage(io, '--json is an option of `claudio status`');
  if (command === 'status' && values.account !== undefined) return usage(io, '--account is an option of `claudio login`');

  const base = baseUrl(values.url, io.env);
  if (!base) return usage(io, `--url must be an http or https URL: ${values.url ?? ''}`);
  const api = new Api(base, token(values.token, io.env), io.interrupt);
  if (command === 'status') return status(api, io, values.json === true);
  const account = values.account ?? 'default';
  if (!account.trim()) return usage(io, '--account must name an account');
  return login(api, account, io);
}

function usage(io: CliIo, problem: string): ExitCode {
  io.err(`claudio: ${problem}\n\n${USAGE}`);
  return EXIT.usage;
}

/** The server this machine runs, as the image and `pnpm start` publish it, unless `--url` names another. */
function baseUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const raw = flag ?? `http://127.0.0.1:${env.PORT?.trim() || '8797'}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href.replace(/\/+$/, '');
}

/**
 * `--token`, else the server's own `CLAUDIO_AUTH_TOKEN` (inside the container the command shares its
 * environment), else the first-run token the image writes to its data directory until it is first
 * used (docs/decisions/container-owner-token.md). None at all is a server with auth `none`.
 */
function token(flag: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const given = flag?.trim() || env.CLAUDIO_AUTH_TOKEN?.trim();
  if (given) return given;
  const dataDir = env.CLAUDIO_DATA_DIR?.trim();
  if (!dataDir) return null;
  try {
    return readFileSync(join(dataDir, 'first-run-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * `claudio login`: starts the CLI's paste-code sign-in on the server (`POST /api/accounts/:id/login`),
 * prints the URL it gives, reads the code without echo, hands it over and waits for the end. Ctrl-C,
 * or an end of input, cancels the sign-in on the server before the command ends.
 */
async function login(api: Api, account: string, io: CliIo): Promise<ExitCode> {
  const pollMs = io.pollMs ?? 1000;
  const started = await api.request<AccountLoginSession>('POST', `/api/accounts/${encodeURIComponent(account)}/login`);
  let session = started.body;
  const path = `/api/accounts/logins/${encodeURIComponent(session.id)}`;
  const read = async (): Promise<AccountLoginSession> => (await api.request<AccountLoginSession>('GET', path)).body;
  /** Polls until `done` holds; `stop` ends it early with what was read last */
  const until = async (done: (s: AccountLoginSession) => boolean, stop?: AbortSignal): Promise<AccountLoginSession> => {
    while (!done(session) && !stop?.aborted) {
      try {
        await sleep(pollMs, undefined, { signal: stop ? AbortSignal.any([io.interrupt, stop]) : io.interrupt });
      } catch {
        if (io.interrupt.aborted) throw new Interrupted();
        break;
      }
      session = await read();
    }
    return session;
  };

  try {
    session = await until((s) => s.url !== null || s.endedAt !== null);
    if (session.endedAt || !session.url) return ended(session, io);
    io.out(`Open this page in a browser, sign in, and paste the code it shows.\n\n  ${session.url}\n\n`);

    for (;;) {
      // The sign-in can end while the person reads the page (it expires after 15 minutes, or is
      // cancelled elsewhere): the prompt then stops instead of taking a code nobody can use
      const prompt = new AbortController();
      const watching = new AbortController();
      // A failed read (the server went away) stops the prompt too, and is reported once it has
      let lost: unknown = null;
      const watcher = until((s) => s.endedAt !== null, watching.signal).then(
        (s) => {
          if (s.endedAt) prompt.abort();
        },
        (err: unknown) => {
          lost = err;
          prompt.abort();
        },
      );
      let code: string | null;
      try {
        code = await io.readSecret('Code: ', AbortSignal.any([io.interrupt, prompt.signal]));
      } catch (err) {
        if (io.interrupt.aborted) throw new Interrupted();
        if (!prompt.signal.aborted) throw err;
        code = null;
      } finally {
        watching.abort();
      }
      await watcher;
      if (io.interrupt.aborted) throw new Interrupted();
      if (lost) throw lost;
      if (session.endedAt) return ended(session, io);
      if (code === null) throw new CliError('no code was entered (end of input); the sign-in is cancelled', EXIT.usage);
      if (!code.trim()) continue;
      // A sign-in that ended between the last read and now answers 409: what it ended as is read next
      const sent = await api.request<AccountLoginSession>('POST', `${path}/code`, { body: { code: code.trim() }, allow: [409] });
      if (sent.status !== 409) session = sent.body;
      break;
    }

    io.out('Checking the code…\n');
    session = await until((s) => s.endedAt !== null);
    return ended(session, io);
  } finally {
    // However the command ends before the sign-in does (Ctrl-C, end of input, an error), the CLI
    // waiting on the server is stopped rather than left for its 15 minutes
    if (!session.endedAt) await api.request('DELETE', path, { interruptible: false }).catch(() => undefined);
  }
}

function ended(session: AccountLoginSession, io: CliIo): ExitCode {
  switch (session.state) {
    case 'succeeded': {
      const who = session.account ? (session.account.email ?? session.account.alias) : null;
      const plan = session.account?.plan;
      io.out(`Signed in${who ? ` as ${who}` : ''}${plan ? ` (${plan})` : ''}.\n`);
      return EXIT.ok;
    }
    case 'expired':
      io.err('The sign-in expired before a code was entered. Run `claudio login` again.\n');
      return EXIT.failed;
    case 'cancelled':
      io.err('The sign-in was cancelled.\n');
      return EXIT.failed;
    default:
      io.err('The sign-in failed: Claude Code did not accept it. Run `claudio login` again for a new code.\n');
      return EXIT.failed;
  }
}

/**
 * `claudio status`: `/api/ready` (D11), then the authenticated `/api/system` and `/api/accounts` for
 * what readiness leaves out on purpose: the account and its last usage reading. Exits 0 when ready.
 */
async function status(api: Api, io: CliIo, json: boolean): Promise<ExitCode> {
  const ready = await api.request<ReadyAnswer>('GET', '/api/ready', { allow: [503] });
  const system = (await api.request<SystemInfo & { profile?: string }>('GET', '/api/system')).body;
  const inUse = system.auth.inUse;
  let found: Account | undefined;
  if (inUse) found = (await api.request<Account[]>('GET', '/api/accounts')).body.find((a) => a.id === inUse.id);
  const report: StatusReport = {
    url: api.base,
    ready: ready.body.ready === true,
    reason: ready.body.ready === true ? null : (ready.body.reason ?? null),
    version: system.version,
    profile: system.profile ?? null,
    cli: { installed: system.cli.installed, version: system.cli.version },
    account: inUse
      ? {
          id: inUse.id,
          label: inUse.label,
          kind: inUse.kind,
          email: found?.email ?? null,
          plan: found?.plan ?? null,
          signInState: inUse.signInState,
          checkedAt: inUse.checkedAt,
        }
      : null,
    usage: found?.limits ?? null,
  };
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : describe(report));
  return report.ready ? EXIT.ok : EXIT.failed;
}

function describe(r: StatusReport): string {
  const lines = [`Claudio ${r.version}${r.profile ? ` (${r.profile})` : ''} at ${r.url}`];
  lines.push(r.ready ? 'Ready: yes' : `Ready: no, ${r.reason ? (REASONS[r.reason] ?? r.reason) : 'no reason given'}`);
  lines.push(`Claude Code: ${r.cli.installed ? (r.cli.version ?? 'installed') : 'not installed'}`);
  if (r.account) {
    const who = r.account.email && r.account.email !== r.account.label ? `${r.account.label} <${r.account.email}>` : r.account.label;
    lines.push(`Account: ${who}${r.account.plan ? ` (${r.account.plan})` : ''}, sign-in ${r.account.signInState}${r.account.checkedAt ? `, checked ${r.account.checkedAt}` : ''}`);
  } else {
    lines.push('Account: none can take work');
  }
  const u = r.usage;
  if (u) {
    const used = u.utilization === null ? 'not read' : `${String(Math.round(u.utilization * 100))}% used`;
    lines.push(`Usage: ${used}${u.window ? ` of the ${u.window} window` : ''}, ${u.state}${u.resetsAt ? `, resets ${u.resetsAt}` : ''} (read ${u.observedAt})`);
  }
  return `${lines.join('\n')}\n`;
}
