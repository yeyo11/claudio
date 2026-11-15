import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage, isRecord, withoutServerEnv, type AccountPlugins } from '@claudio/shared';
import { ACCOUNT_VARS } from './env.ts';
import { writeAtomic } from './fs.ts';

/**
 * Plugins of shared accounts (docs/plans/account-configuration-and-project-rules.md §6.3, decision D4).
 *
 * `settings.json` is linked into a shared account, so `enabledPlugins` and `extraKnownMarketplaces`
 * already are the default's; what is per account is `plugins/` (the install records, the marketplace
 * clones, the cached versions). Linking it is not proven safe (S2: `installPath` is recorded under the
 * installing account's dir), so each shared account's own `plugins/` is brought to the default's
 * with the CLI's documented `claude plugin` commands, run with that account's `CLAUDE_CONFIG_DIR`.
 * The vendor's installer stays the only writer of every install record: Claudio reads the default's
 * records (read-only) and never writes another dir's.
 *
 * Scope of what is reconciled: the user-scope plugins of the default that its settings do not switch
 * off. A project or local plugin belongs to a folder, and a disabled one would be switched on by an
 * install (the CLI enables what it installs, in the settings the account shares).
 */

/** What Claudio itself installed on the account, so that only that is ever uninstalled */
export const PLUGINS_RECORD = '.claudio-plugins.json';

const WATCHED = new Set(['installed_plugins.json', 'known_marketplaces.json', 'settings.json']);

/** Where a marketplace is fetched from, as the argument of `claude plugin marketplace add` */
export type MarketplaceSource = string;

export interface PluginState {
  /** User-scope installs: id (`plugin@marketplace`) to version */
  installed: Map<string, string>;
  /** `enabledPlugins` of the dir's settings; an absent id is not off */
  enabled: Map<string, boolean>;
  /** Marketplace name to what `marketplace add` takes, for the sources the CLI can re-add */
  marketplaces: Map<string, MarketplaceSource>;
  /** The marketplaces the dir's CLI has cloned */
  known: Set<string>;
}

export type PluginStep =
  | { kind: 'marketplace-add'; marketplace: string; source: MarketplaceSource }
  | { kind: 'marketplace-update'; marketplace: string }
  | { kind: 'install'; id: string }
  | { kind: 'update'; id: string }
  | { kind: 'uninstall'; id: string };

export interface PluginPlan {
  steps: PluginStep[];
  /** Plugins the default has that the plan cannot install (no source known for their marketplace) */
  unreachable: string[];
}

const readJsonSync = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

/** The name of the marketplace a plugin id belongs to: `plugin@marketplace` */
export const marketplaceOf = (id: string): string => id.slice(id.lastIndexOf('@') + 1);

/** What `marketplace add` takes for a source the CLI wrote, or null for a kind Claudio cannot re-add */
function sourceArg(source: unknown): MarketplaceSource | null {
  if (!isRecord(source)) return null;
  const kind = source.source;
  if (kind === 'github' && typeof source.repo === 'string') return source.repo;
  if ((kind === 'git' || kind === 'url') && typeof source.url === 'string') return source.url;
  if ((kind === 'directory' || kind === 'file') && typeof source.path === 'string') return source.path;
  return null;
}

/**
 * Reads the plugin state of a config dir from the files the CLI writes. A file that is missing or
 * not in the shape this reads is an empty state: the reader never throws and never writes.
 */
export function readPluginState(dir: string): PluginState {
  const state: PluginState = { installed: new Map(), enabled: new Map(), marketplaces: new Map(), known: new Set() };
  const installed = readJsonSync(join(dir, 'plugins', 'installed_plugins.json'));
  if (isRecord(installed) && isRecord(installed.plugins)) {
    for (const [id, entries] of Object.entries(installed.plugins)) {
      if (!Array.isArray(entries)) continue;
      const user = entries.find((e): e is Record<string, unknown> => isRecord(e) && (e.scope === undefined || e.scope === 'user'));
      if (user) state.installed.set(id, typeof user.version === 'string' ? user.version : '');
    }
  }
  const settings = readJsonSync(join(dir, 'settings.json'));
  if (isRecord(settings)) {
    if (isRecord(settings.enabledPlugins)) for (const [id, on] of Object.entries(settings.enabledPlugins)) if (typeof on === 'boolean') state.enabled.set(id, on);
    if (isRecord(settings.extraKnownMarketplaces)) {
      for (const [name, value] of Object.entries(settings.extraKnownMarketplaces)) {
        const arg = isRecord(value) ? sourceArg(value.source) : null;
        if (arg) state.marketplaces.set(name, arg);
      }
    }
  }
  const known = readJsonSync(join(dir, 'plugins', 'known_marketplaces.json'));
  if (isRecord(known)) {
    for (const [name, value] of Object.entries(known)) {
      state.known.add(name);
      const arg = isRecord(value) ? sourceArg(value.source) : null;
      if (arg) state.marketplaces.set(name, arg);
    }
  }
  return state;
}

/** The plugins the default has switched on, which are the ones an account is held to */
const wanted = (def: PluginState): [string, string][] => [...def.installed].filter(([id]) => def.enabled.get(id) !== false).sort(([a], [b]) => a.localeCompare(b));

/**
 * The plugins an account lacks (`missing`) or runs at another version (`differing`) than the default,
 * from the two dirs' records alone. No process is started.
 */
export function diffPlugins(defaultDir: string, accountDir: string): AccountPlugins {
  const def = readPluginState(defaultDir);
  const acc = readPluginState(accountDir);
  const missing: string[] = [];
  const differing: string[] = [];
  for (const [id, version] of wanted(def)) {
    const mine = acc.installed.get(id);
    if (mine === undefined) missing.push(id);
    else if (mine !== version) differing.push(id);
  }
  return { missing, differing };
}

/**
 * What would bring the account to the default's set, as commands and nothing else. Installs what the
 * account lacks, updates what runs at another version (after refreshing that plugin's marketplace),
 * and uninstalls only a plugin Claudio installed that the default no longer has: one a person
 * installed on the account on purpose is never removed. A plugin in `settled` is left alone: an update
 * already ran for it and it stayed behind.
 */
export function planPlugins(def: PluginState, acc: PluginState, managed: ReadonlySet<string>, settled: ReadonlySet<string> = new Set()): PluginPlan {
  const adds: PluginStep[] = [];
  const refreshes: PluginStep[] = [];
  const installs: PluginStep[] = [];
  const updates: PluginStep[] = [];
  const uninstalls: PluginStep[] = [];
  const unreachable: string[] = [];
  const added = new Set<string>();
  const refreshed = new Set<string>();
  for (const [id, version] of wanted(def)) {
    const market = marketplaceOf(id);
    const mine = acc.installed.get(id);
    if (mine !== undefined && (mine === version || settled.has(id))) continue;
    if (!acc.known.has(market) && !added.has(market)) {
      const source = def.marketplaces.get(market);
      if (source === undefined) {
        unreachable.push(id);
        continue;
      }
      added.add(market);
      adds.push({ kind: 'marketplace-add', marketplace: market, source });
    } else if (acc.known.has(market) && !refreshed.has(market)) {
      // A marketplace the account has is refreshed before its plugin is installed or updated, or the command sees the old catalog
      refreshed.add(market);
      refreshes.push({ kind: 'marketplace-update', marketplace: market });
    }
    (mine === undefined ? installs : updates).push({ kind: mine === undefined ? 'install' : 'update', id });
  }
  for (const id of [...managed].sort()) if (acc.installed.has(id) && !def.installed.has(id)) uninstalls.push({ kind: 'uninstall', id });
  return { steps: [...adds, ...refreshes, ...installs, ...updates, ...uninstalls], unreachable };
}

/** The `claude` arguments of a step. `-s user` is explicit because the CLI's own default is only "auto-detect" for update. */
export function argsOf(step: PluginStep): string[] {
  switch (step.kind) {
    case 'marketplace-add':
      return ['plugin', 'marketplace', 'add', step.source];
    case 'marketplace-update':
      return ['plugin', 'marketplace', 'update', step.marketplace];
    case 'install':
      return ['plugin', 'install', step.id, '--scope', 'user'];
    case 'update':
      return ['plugin', 'update', step.id, '--scope', 'user'];
    case 'uninstall':
      return ['plugin', 'uninstall', step.id, '--scope', 'user'];
  }
}

export interface PluginTarget {
  id: string;
  dir: string;
}

export interface PluginReconcilerOptions {
  /** The default account's config dir: the source of the set */
  defaultDir: string;
  /** The CLI binary, read at each run: it can move under a running server */
  claude: () => string;
  /** The shared accounts, not the default, none of them mid-switch */
  targets: () => PluginTarget[];
  /** Whether no live chat runs on the account; a running CLI is never given plugins moving under it */
  idle: (account: string) => boolean;
  /** The server's log; a failure is said once */
  log: (line: string) => void;
  /** The owner's children, so a shutdown ends a command still running */
  onSpawn?: (child: ChildProcess) => void;
  /** An account's plugins changed: what is served reads them again */
  changed?: () => void;
  /** Whether the owner is shutting down; nothing starts after it */
  closed?: () => boolean;
  /** The environment the commands start from; default the process's */
  env?: NodeJS.ProcessEnv;
  /** How long one command may take; default 90 s */
  timeoutMs?: number;
  /** How long the default's files stay quiet before a pass; default 3 s */
  debounceMs?: number;
  /** How long a deferred account waits before it is looked at again; default 2 minutes */
  retryMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEBOUNCE_MS = 3_000;
const RETRY_MS = 120_000;

const gist = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Keeps every shared account's plugins at the default's, one account at a time, in the background:
 * a spawn never waits for it. A pass runs at start-up, when the default's plugin records or settings
 * change (watched, with a debounce) and when `nudge` says the set of accounts changed. An account with
 * a live chat is left for later and looked at again on a slow timer that exists only while one waits.
 * A failed command is logged once and tried again at the next pass; a pass that finds nothing to do
 * starts no process.
 */
export class PluginReconciler {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly said = new Set<string>();
  /** `account/plugin` mapped to the pair of versions an update already tried, so a plugin that stays behind is not asked for again at every pass */
  private readonly tried = new Map<string, string>();
  private readonly active = new Set<ChildProcess>();

  constructor(private readonly opts: PluginReconcilerOptions) {}

  /** Watches the default's records and runs the first pass after the debounce */
  start(): void {
    this.watchDir(this.opts.defaultDir);
    this.watchDir(join(this.opts.defaultDir, 'plugins'));
    this.nudge();
  }

  /** Something that may have changed the set: a pass runs once the debounce has passed */
  nudge(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.opts.debounceMs ?? DEBOUNCE_MS);
    this.timer.unref();
  }

  close(): void {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    for (const child of this.active) child.kill('SIGTERM');
  }

  /** Runs a pass now and resolves when it ends; a pass already running runs once more after it */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private watchDir(dir: string): void {
    if (!existsSync(dir)) return;
    try {
      const watcher = watch(dir, (_event, name) => {
        if (name && WATCHED.has(String(name))) this.nudge();
      });
      // A directory removed under the watcher is the CLI's business, not an error to crash on
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch (error) {
      this.sayOnce(`watch:${dir}`, `plugins: cannot watch ${dir}: ${errorMessage(error)}`);
    }
  }

  private async pass(): Promise<void> {
    let deferred = false;
    for (const target of this.opts.targets()) {
      if (this.stopped || this.opts.closed?.()) return;
      try {
        if ((await this.account(target)) === 'deferred') deferred = true;
      } catch (error) {
        this.sayOnce(`${target.id}/pass/${gist(errorMessage(error))}`, `plugins: ${target.id} could not be reconciled: ${errorMessage(error)}`);
      }
    }
    if (deferred && !this.retry && !this.stopped) {
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.run();
      }, this.opts.retryMs ?? RETRY_MS);
      this.retry.unref();
    }
  }

  private async account(target: PluginTarget): Promise<'noop' | 'done' | 'deferred'> {
    const def = readPluginState(this.opts.defaultDir);
    const acc = readPluginState(target.dir);
    const record = await this.readRecord(target.dir);
    // A plugin the person removed since is no longer Claudio's to remove
    const managed = new Set([...record].filter((id) => acc.installed.has(id)));
    const settled = new Set([...def.installed.keys()].filter((id) => this.tried.get(`${target.id}/${id}`) === `${def.installed.get(id)}/${acc.installed.get(id)}`));
    const plan = planPlugins(def, acc, managed, settled);
    for (const id of plan.unreachable) this.sayOnce(`${target.id}/unreachable/${id}`, `plugins: ${target.id} lacks ${id}, and the default's record gives no source for its marketplace the CLI could add again`);
    const steps = plan.steps;
    if (steps.length === 0) {
      if (managed.size !== record.size) await this.writeRecord(target.dir, managed);
      return 'noop';
    }
    if (!this.opts.idle(target.id)) {
      this.sayOnce(`${target.id}/deferred`, `plugins: ${target.id} has a live chat; its plugins (${steps.length} step${steps.length === 1 ? '' : 's'}) wait until it is idle`);
      return 'deferred';
    }
    this.said.delete(`${target.id}/deferred`);
    const failedMarkets = new Set<string>();
    const updated: string[] = [];
    for (const step of steps) {
      if (this.stopped || this.opts.closed?.()) break;
      const market = step.kind === 'marketplace-add' || step.kind === 'marketplace-update' ? step.marketplace : marketplaceOf(step.id);
      // Without its marketplace, a plugin's install can only fail the same way
      if (failedMarkets.has(market) && (step.kind === 'install' || step.kind === 'update')) continue;
      const result = await this.exec(target, step);
      if (!result.ok) {
        if (step.kind === 'marketplace-add') failedMarkets.add(market);
        this.sayOnce(`${target.id}/${step.kind}/${'id' in step ? step.id : step.marketplace}/${gist(result.output)}`, `plugins: ${target.id}: \`claude ${argsOf(step).join(' ')}\` failed (${result.output}); it is tried again at the next pass`);
        continue;
      }
      if (step.kind === 'install') managed.add(step.id);
      else if (step.kind === 'uninstall') managed.delete(step.id);
      else if (step.kind === 'update') updated.push(step.id);
    }
    // Keyed by what the account runs now: an update that left the plugin behind the default's (the marketplace has nothing newer) is not asked for again
    const after = readPluginState(target.dir);
    for (const id of updated) this.tried.set(`${target.id}/${id}`, `${def.installed.get(id)}/${after.installed.get(id)}`);
    await this.writeRecord(target.dir, managed);
    this.opts.changed?.();
    return 'done';
  }

  private exec(target: PluginTarget, step: PluginStep): Promise<{ ok: boolean; output: string }> {
    const env = withoutServerEnv(this.opts.env ?? process.env);
    // Plugins are configuration: no credential of any account is needed or passed
    for (const name of ACCOUNT_VARS) delete env[name];
    env.CLAUDE_CONFIG_DIR = target.dir;
    return new Promise((resolve) => {
      const child = execFile(this.opts.claude(), argsOf(step), { env, timeout: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        this.active.delete(child);
        resolve(error ? { ok: false, output: gist(`${stderr}\n${stdout}`) || gist(error.message) } : { ok: true, output: '' });
      });
      // Closed input: a command that asks for confirmation ends instead of waiting for its timeout
      child.stdin?.end();
      this.active.add(child);
      this.opts.onSpawn?.(child);
    });
  }

  private async readRecord(dir: string): Promise<Set<string>> {
    try {
      const doc: unknown = JSON.parse(await readFile(join(dir, PLUGINS_RECORD), 'utf8'));
      return new Set(isRecord(doc) && Array.isArray(doc.installed) ? doc.installed.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private async writeRecord(dir: string, managed: ReadonlySet<string>): Promise<void> {
    const file = join(dir, PLUGINS_RECORD);
    if (managed.size === 0 && !existsSync(file)) return;
    await writeAtomic(file, `${JSON.stringify({ installed: [...managed].sort() }, null, 2)}\n`);
  }

  private sayOnce(key: string, line: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.opts.log(line);
  }
}
