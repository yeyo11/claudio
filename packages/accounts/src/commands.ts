import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@claudio/shared';
import { envFor } from './env.ts';
import { login } from './login.ts';
import { AccountStore } from './store.ts';
import { errorMessage } from '@claudio/shared';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** All of stdin, for `--token -` and `--api-key -`, so a secret never sits in the process list */
  stdin(): Promise<string>;
  /** One line typed by the person, for the code `claude auth login` waits for */
  prompt(question: string): Promise<string>;
}

export interface CliEnv {
  env: NodeJS.ProcessEnv;
  claude?: string;
}

const USAGE = `claudio-accounts <command>

  list [--json]                         the accounts and their latest reading
  add [--token -|--api-key -] [--alias NAME]
                                        add an account; with no flag, a login account
  login <account> [--email EMAIL]       sign in (runs \`claude auth login\` in the account's dir)
  remove <account>
  enable <account> | disable <account>
  alias <account> <name>
  status [--json]                       refresh identity and usage, then list
  pick [--json]                         the account new work would start on
  run <account> -- <claude args>        start claude with that account's environment

Options: --data-dir DIR (default $CLAUDIO_DATA_DIR or ~/.config/Claudio/data)`;

/** Both name and id answer to an account: aliases and emails are what people type. */
function resolve(accounts: readonly Account[], ref: string | undefined): Account {
  if (!ref) throw new Error('which account? give its id, alias or email');
  const hit = accounts.find((a) => a.id === ref) ?? accounts.find((a) => a.alias === ref) ?? accounts.find((a) => a.email === ref);
  if (!hit) throw new Error(`no account matches ${ref}`);
  return hit;
}

const label = (a: Account): string => a.alias ?? a.email ?? a.id;

function pct(a: Account): string {
  const l = a.limits;
  if (!l || l.utilization === null) return 'unknown';
  return `${Math.round(l.utilization * 100)}% ${l.window ?? ''} (${l.source}, ${l.observedAt})`.replace('  ', ' ');
}

function table(accounts: readonly Account[]): string {
  if (!accounts.length) return 'no accounts';
  return accounts
    .map((a) => `${a.id.padEnd(13)} ${a.kind.padEnd(8)} ${label(a).padEnd(28)} ${a.enabled ? 'enabled ' : 'disabled'} ${a.signedIn ? 'signed-in ' : 'signed-out'} ${a.plan ?? '-'}  ${pct(a)}`)
    .join('\n');
}

/** Takes `--name value` out of args; `undefined` when absent. */
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** Returns the exit code. */
export async function main(argv: readonly string[], io: Io, cli: CliEnv): Promise<number> {
  const args = [...argv];
  const dashes = args.indexOf('--');
  const passthrough = dashes === -1 ? [] : args.splice(dashes).slice(1);
  try {
    const dataDir = option(args, '--data-dir') ?? cli.env.CLAUDIO_DATA_DIR ?? join(homedir(), '.config', 'Claudio', 'data');
    const json = flag(args, '--json');
    const command = args.shift();
    if (!command || command === 'help' || command === '--help') {
      io.out(USAGE);
      return command ? 0 : 1;
    }
    const store = new AccountStore({ dataDir, env: cli.env, ...(cli.claude ? { claude: cli.claude } : {}) });
    const show = (accounts: Account[]): void => io.out(json ? JSON.stringify(accounts, null, 2) : table(accounts));

    switch (command) {
      case 'list':
        show(store.list());
        return 0;
      case 'add': {
        const alias = option(args, '--alias');
        const token = option(args, '--token');
        const apiKey = option(args, '--api-key');
        if (token !== undefined && apiKey !== undefined) throw new Error('--token and --api-key are exclusive');
        const secretFlag = token ?? apiKey;
        if (secretFlag !== undefined && secretFlag !== '-') throw new Error('give the secret on stdin: --token - or --api-key -');
        const secret = secretFlag === undefined ? undefined : (await io.stdin()).trim();
        const kind = token !== undefined ? 'token' : apiKey !== undefined ? 'api-key' : 'login';
        const account = await store.add({ kind, alias: alias ?? null, ...(secret ? { secret } : {}) });
        io.out(json ? JSON.stringify(account, null, 2) : `added ${account.id}${kind === 'login' ? `; sign it in with: claudio-accounts login ${account.id}` : ''}`);
        return 0;
      }
      case 'login': {
        const account = resolve(store.list(), args.shift());
        if (account.kind !== 'login') throw new Error(`${label(account)} is a ${account.kind} account: it has nothing to sign in to`);
        const email = option(args, '--email');
        const session = login(store.ref(account.id), { env: cli.env, ...(cli.claude ? { claude: cli.claude } : {}), ...(email ? { email } : {}) });
        const url = await session.url;
        if (url) {
          io.out(`Open this address and sign in:\n${url}`);
          // The CLI takes the code from stdin only when its browser could not complete the sign-in
          void io.prompt('If it asks for a code, paste it here (or wait): ').then((code) => code && session.submitCode(code));
        }
        const code = await session.done;
        if (code !== 0) throw new Error('claude auth login did not finish');
        const refreshed = await store.refresh(account.id);
        io.out(`signed in: ${label(refreshed)}${refreshed.plan ? ` (${refreshed.plan})` : ''}`);
        return 0;
      }
      case 'remove': {
        const account = resolve(store.list(), args.shift());
        await store.remove(account.id);
        io.out(`removed ${label(account)}`);
        return 0;
      }
      case 'enable':
      case 'disable': {
        const account = resolve(store.list(), args.shift());
        await store.setEnabled(account.id, command === 'enable');
        io.out(`${command}d ${label(account)}`);
        return 0;
      }
      case 'alias': {
        const account = resolve(store.list(), args.shift());
        const next = await store.setAlias(account.id, args.shift() ?? null);
        io.out(`${account.id} is now ${label(next)}`);
        return 0;
      }
      case 'status': {
        for (const a of store.list()) {
          await store.refresh(a.id).catch(() => undefined);
          await store.readCachedUsage(a.id);
        }
        show(store.list());
        return 0;
      }
      case 'pick': {
        for (const a of store.list()) await store.readCachedUsage(a.id);
        const choice = store.pick({ current: null });
        io.out(json ? JSON.stringify(choice, null, 2) : choice.account ? choice.account : `none${choice.waitUntil ? `; earliest reset ${new Date(choice.waitUntil).toISOString()}` : ''}`);
        return choice.account ? 0 : 1;
      }
      case 'run': {
        const account = resolve(store.list(), args.shift());
        if (!passthrough.length) throw new Error('run <account> -- <claude args>');
        const child = spawn(cli.claude ?? 'claude', passthrough, { env: envFor(store.ref(account.id), cli.env), stdio: 'inherit' });
        return await new Promise<number>((done) => {
          child.on('error', (e) => {
            io.err(e.message);
            done(127);
          });
          child.on('close', (c) => done(c ?? 1));
        });
      }
      default:
        io.err(`unknown command ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    io.err(errorMessage(e));
    return 1;
  }
}
