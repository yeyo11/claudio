import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account, AccountConfig, AccountConfigMode, AccountConfigPlan, AccountConfigStart, AccountConfigStep, AccountKind, AccountSignInState, AccountsSettings, ModelOption, RotationPolicy, RotationPolicyRequest } from '@claudio/shared';
import { choose, type Choice, type ChooseOptions } from './choose.ts';
import { ASIDE_DIR, asideStamp, orphanDirs, reconcileAccountDir, removeLinks, type ReconcileReport } from './dirs.ts';
import { applySteps, describeConfig, itemClass, planSwitch, planUseShared } from './config-mode.ts';
import { DEFAULT_ID, SECRET_FILE, type AccountRef } from './env.ts';
import { writeAtomic } from './fs.ts';
import { CREDENTIALS_FILE, identify, readCredentials, type Identity } from './identify.ts';
import { apiKeyOf, checkCredential, usageOf, type CredentialCheck } from './cli-usage.ts';
import { ModelCache, offers, type ModelsOptions } from './models.ts';
import { cliLogin, readCache, Readings, type Reading } from './usage.ts';
import { isRecord, NotFoundError } from '@claudio/shared';

/** The CLI's own config dir: the account a fresh install already has, with nothing to set up. */
export { DEFAULT_ID };

export const DEFAULT_SETTINGS: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'least-used', preferred: null, order: [], newAccountConfig: 'shared' };

const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 99.9;

/**
 * Removing an account a live chat runs on: the chat's next result would fold onto an account that
 * is gone (2026-10-25 the server went down on exactly that). The person stops or moves those chats
 * first; `chats` names them.
 */
export class AccountInUseError extends Error {
  readonly statusCode = 409;
  readonly reason = 'account-in-use';
  constructor(
    readonly account: string,
    readonly chats: readonly string[],
  ) {
    super(`account ${account} runs ${chats.length === 1 ? 'a live chat' : `${chats.length} live chats`} (${chats.join(', ')}); stop them or move them to another account first`);
    this.name = 'AccountInUseError';
  }
}

interface StoredAccount {
  id: string;
  kind: AccountKind;
  alias: string | null;
  enabled: boolean;
  links: string[];
  identity: Identity;
  /** ISO time a run on it failed because the CLI could not authenticate; absent while it can */
  authFailedAt?: string;
  /** ISO time the credential was last checked; absent until it was */
  checkedAt?: string;
  /** sha256 of the API key that was checked, never the key: a changed key is unchecked again */
  checkedFingerprint?: string;
  /** Absent on accounts made before the mode existed, which are all `shared` */
  config?: StoredConfig;
}

interface StoredConfig {
  mode: AccountConfigMode;
  /**
   * A switch begun and not yet ended: recorded before its first step, so a server stopped half-way
   * finishes it at its next start, with the same start and the same dir for what moves aside
   */
  switching?: { to: AccountConfigMode; start: AccountConfigStart; aside: string };
}

const isMode = (v: unknown): v is AccountConfigMode => v === 'shared' || v === 'independent';

function parseConfig(v: unknown): StoredConfig | undefined {
  if (!isRecord(v) || !isMode(v.mode)) return undefined;
  const sw = isRecord(v.switching) ? v.switching : null;
  const start: AccountConfigStart | null = sw?.start === 'copy' || sw?.start === 'empty' ? sw.start : null;
  const switching = sw && isMode(sw.to) && start && typeof sw.aside === 'string' && /^[\w-]+$/.test(sw.aside) ? { to: sw.to, start, aside: sw.aside } : undefined;
  return { mode: v.mode, ...(switching ? { switching } : {}) };
}

/** The default account is the source of the shared configuration: it has no mode to change */
export class DefaultAccountConfigError extends Error {
  readonly statusCode = 400;
  constructor() {
    super("the default account is the CLI's own config dir, the source of the shared configuration: it has no configuration mode");
    this.name = 'DefaultAccountConfigError';
  }
}

interface Stored {
  settings: AccountsSettings;
  /** The CLI's own dir is not stored as an account, only what a person changed about it */
  default: { enabled: boolean; alias: string | null; identity: Identity; authFailedAt?: string; checkedAt?: string; checkedFingerprint?: string };
  accounts: StoredAccount[];
  policies: RotationPolicy[];
}

/** `claude` is read when a call is made, not when the cache is built: the binary can change under a running server */
function modelsOptions(claude: () => string, env: NodeJS.ProcessEnv, onSpawn: ModelsOptions['onSpawn']): ModelsOptions {
  return {
    get claude() {
      return claude();
    },
    env,
    ...(onSpawn ? { onSpawn } : {}),
  };
}

const NO_IDENTITY: Identity = { signedIn: false, email: null, organization: null, plan: null };
/** The CLI's own login is taken as usable until `refresh` learns it is not: a fresh install works with nothing to set up */
const ASSUMED_IDENTITY: Identity = { ...NO_IDENTITY, signedIn: true };

export interface AccountStoreOptions {
  /** Claudio's data dir; `accounts.json`, `limits.json` and `accounts/<id>/` live in it */
  dataDir: string;
  /** The CLI's own config dir; `CLAUDE_CONFIG_DIR` or `~/.claude` when absent */
  defaultDir?: string;
  /** The `claude` binary; `claude` on the PATH when absent */
  claude?: string | (() => string);
  /** The environment the `claude` subprocesses start from; `process.env` when absent */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether the CLI's own login has a key or token in its environment (the container's, or the one
   * Claudio keeps sealed): such a login has no credentials file and is still an account
   */
  defaultEnvCredential?: () => boolean;
  /**
   * The environment the CLI's own login runs in, the vault's credential laid over `env`; `env` when
   * absent. Its `ANTHROPIC_API_KEY` is the one a check judges.
   */
  defaultEnv?: () => NodeJS.ProcessEnv;
  /**
   * Hears of each CLI process the store starts (a models, usage or sign-in read), so its owner can end it
   * on shutdown instead of letting it write the CLI's config into a data dir that is gone
   */
  onSpawn?: (child: ChildProcess) => void;
  /**
   * The ids of the live chats whose process runs on an account; `remove` refuses while there is one.
   * Absent (the terminal's `claudio-accounts`, which runs no chat) nothing is refused.
   */
  liveChatsOn?: (account: string) => string[];
  /** Where the store says what it found and left alone (a conflict, an orphan dir); `console.warn` when absent */
  log?: (message: string) => void;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parseIdentity(v: unknown): Identity {
  if (!isRecord(v)) return { ...NO_IDENTITY };
  return { signedIn: v.signedIn === true, email: str(v.email), organization: str(v.organization), plan: str(v.plan) };
}

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AccountsSettings)[];

function checkSettings(next: AccountsSettings): void {
  if (typeof next.rotateOnLimit !== 'boolean') throw new Error('rotateOnLimit must be a boolean');
  if (!(next.threshold >= THRESHOLD_MIN && next.threshold <= THRESHOLD_MAX)) throw new Error(`threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`);
  if (!(next.hysteresis >= 0 && next.hysteresis < next.threshold)) throw new Error('hysteresis must be between 0 and the threshold');
  if (!(next.cooldownSeconds >= 0)) throw new Error('cooldownSeconds must not be negative');
  if (next.strategy !== 'order' && next.strategy !== 'least-used') throw new Error('strategy must be order or least-used');
  if (next.preferred !== null && (typeof next.preferred !== 'string' || !next.preferred)) throw new Error('preferred must be an account id or null');
  if (!Array.isArray(next.order) || next.order.some((id) => typeof id !== 'string' || !id)) throw new Error('order must be a list of account ids');
  if (new Set(next.order).size !== next.order.length) throw new Error('order must name each account once');
  if (!isMode(next.newAccountConfig)) throw new Error('newAccountConfig must be shared or independent');
}

function parseSettings(v: unknown): AccountsSettings {
  const d = DEFAULT_SETTINGS;
  if (!isRecord(v)) return { ...d, order: [...d.order] };
  const n = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
  const order = Array.isArray(v.order) ? v.order.filter((id): id is string => typeof id === 'string' && !!id) : d.order;
  return {
    rotateOnLimit: typeof v.rotateOnLimit === 'boolean' ? v.rotateOnLimit : d.rotateOnLimit,
    threshold: n(v.threshold, d.threshold),
    hysteresis: n(v.hysteresis, d.hysteresis),
    cooldownSeconds: n(v.cooldownSeconds, d.cooldownSeconds),
    strategy: v.strategy === 'order' || v.strategy === 'least-used' ? v.strategy : d.strategy,
    preferred: typeof v.preferred === 'string' && v.preferred ? v.preferred : d.preferred,
    order: [...new Set(order)],
    newAccountConfig: isMode(v.newAccountConfig) ? v.newAccountConfig : d.newAccountConfig,
  };
}

function parse(doc: Record<string, unknown>): Stored {
  const accounts: StoredAccount[] = [];
  if (Array.isArray(doc.accounts)) {
    for (const a of doc.accounts) {
      if (!isRecord(a) || typeof a.id !== 'string' || !(a.kind === 'login' || a.kind === 'token' || a.kind === 'api-key')) continue;
      accounts.push({
        id: a.id,
        kind: a.kind,
        alias: str(a.alias),
        enabled: a.enabled !== false,
        links: Array.isArray(a.links) ? a.links.filter((l): l is string => typeof l === 'string') : [],
        identity: parseIdentity(a.identity),
        ...(typeof a.authFailedAt === 'string' && a.authFailedAt ? { authFailedAt: a.authFailedAt } : {}),
        ...(typeof a.checkedAt === 'string' && a.checkedAt ? { checkedAt: a.checkedAt } : {}),
        ...(typeof a.checkedFingerprint === 'string' && a.checkedFingerprint ? { checkedFingerprint: a.checkedFingerprint } : {}),
        ...(parseConfig(a.config) ? { config: parseConfig(a.config) } : {}),
      });
    }
  }
  const def = isRecord(doc.default) ? doc.default : {};
  const policies = Array.isArray(doc.policies)
    ? doc.policies
        .filter((p): p is RotationPolicy => isRecord(p) && typeof p.id === 'string' && Array.isArray(p.projects))
        .map(({ looseChats, ...p }) => ({ ...p, ...(looseChats === true ? { looseChats: true } : {}) }))
    : [];
  return {
    settings: parseSettings(doc.settings),
    default: { enabled: def.enabled !== false, alias: str(def.alias), identity: isRecord(def.identity) ? parseIdentity(def.identity) : { ...ASSUMED_IDENTITY },
      ...(typeof def.authFailedAt === 'string' && def.authFailedAt ? { authFailedAt: def.authFailedAt } : {}),
      ...(typeof def.checkedAt === 'string' && def.checkedAt ? { checkedAt: def.checkedAt } : {}),
      ...(typeof def.checkedFingerprint === 'string' && def.checkedFingerprint ? { checkedFingerprint: def.checkedFingerprint } : {}),
    },
    accounts,
    policies,
  };
}

/**
 * The accounts of this machine: `accounts.json` (settings-shaped, written atomically), one config
 * dir per account under `<data>/accounts/<id>/`, and the latest usage readings. The CLI of the
 * terminal and the app share the data dir, so an account added in one shows in the other.
 */
export class AccountStore {
  readonly defaultDir: string;
  readonly readings: Readings;
  private readonly modelCache: ModelCache;
  private readonly file: string;
  private readonly claudeOf: () => string;
  private get claude(): string {
    return this.claudeOf();
  }
  private readonly env: NodeJS.ProcessEnv;
  private stored: Stored = { settings: { ...DEFAULT_SETTINGS }, default: { enabled: true, alias: null, identity: { ...ASSUMED_IDENTITY } }, accounts: [], policies: [] };
  private readonly listeners = new Set<() => void>();
  /** The settings keys the file names: what the person stored, as opposed to what the defaults fill in */
  private settingKeys = new Set<keyof AccountsSettings>();

  constructor(private readonly opts: AccountStoreOptions) {
    this.env = opts.env ?? process.env;
    this.defaultDir = opts.defaultDir ?? this.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const claude = opts.claude ?? 'claude';
    this.claudeOf = typeof claude === 'function' ? claude : () => claude;
    this.file = join(opts.dataDir, 'accounts.json');
    this.readings = new Readings(join(opts.dataDir, 'accounts', 'limits.json'));
    this.modelCache = new ModelCache(join(opts.dataDir, 'accounts', 'models'), modelsOptions(() => this.claude, this.env, opts.onSpawn));
    this.reload();
    this.reconcileAll();
  }

  /**
   * Re-reads the file: another process (the binary, the app) may have written it. A file that differs
   * from the last one read or written is a change the listeners hear of, so an account added from
   * the terminal wakes the work waiting for one.
   */
  reload(): void {
    if (!existsSync(this.file)) return;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
      const doc: unknown = JSON.parse(text);
      if (isRecord(doc)) {
        this.stored = parse(doc);
        const settings = isRecord(doc.settings) ? doc.settings : {};
        this.settingKeys = new Set(SETTING_KEYS.filter((key) => settings[key] !== undefined));
      }
    } catch {
      // Overwriting a document that does not parse would drop the accounts in it
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
    const before = this.lastText;
    this.lastText = text;
    if (before !== null && before !== text) this.changed();
  }

  /** The file as last read or written, to tell another process's write from none */
  private lastText: string | null = null;

  private async save(): Promise<void> {
    // Only the settings the person stored: a key left out reads as its default, today's or a later one
    const settings = Object.fromEntries(SETTING_KEYS.filter((key) => this.settingKeys.has(key)).map((key) => [key, this.stored.settings[key]]));
    const text = `${JSON.stringify({ ...this.stored, settings }, null, 2)}\n`;
    await writeAtomic(this.file, text, 0o600);
    this.lastText = text;
    this.changed();
  }

  /**
   * Calls `listener` after any account's reading or stored state changed (a new reading, a sign-in
   * marked or cleared, an account enabled, added or removed, the settings). Work waiting for an
   * account with room listens: the account it waits on is not always the one that comes back first
   * (R10). Returns the unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own: the change is stored all the same
      }
    }
  }

  private dirOf(id: string): string {
    return id === DEFAULT_ID ? this.defaultDir : join(this.opts.dataDir, 'accounts', id);
  }

  private entry(id: string): StoredAccount {
    const a = this.stored.accounts.find((x) => x.id === id);
    if (!a) throw new NotFoundError(`account ${id} not found`);
    return a;
  }

  // ---------- accounts ----------

  /**
   * What a process launcher needs: the account's id, kind and directory. A launcher asks for it
   * before every spawn, so the account's links are brought up to the default dir here: lstat calls,
   * no write when nothing is missing (an item added to `~/.claude` after the account was made
   * reaches a chat on it at its next run).
   */
  ref(id: string): AccountRef {
    if (id === DEFAULT_ID) return { id, kind: 'login', dir: this.defaultDir };
    const a = this.entry(id);
    this.reconcile(id);
    return { id, kind: a.kind, dir: this.dirOf(id) };
  }

  /**
   * One pass of the account's links: the missing ones are made, the hand-made ones that point
   * where Claudio would point them are recorded, anything else in the way is reported and left.
   * Never throws: a dir that cannot be written is logged, and the run it precedes goes on.
   */
  reconcile(id: string, opts: { save?: boolean } = {}): ReconcileReport | null {
    if (id === DEFAULT_ID) return null;
    const a = this.entry(id);
    const dir = this.dirOf(id);
    let report: ReconcileReport;
    try {
      report = reconcileAccountDir(dir, this.defaultDir, {
        // An independent account's configuration is its own; while a switch is under way, the switch alone touches it
        config: (a.config?.mode ?? 'shared') === 'shared' && !a.config?.switching,
        recorded: a.links,
        // A file a live process of the account may hold open is not moved; an empty dir is moved
        // only if still empty when it goes (rmdir refuses one that is not)
        moves: { aside: () => join(dir, ASIDE_DIR, asideStamp()), files: this.idle(id) },
      });
    } catch (error) {
      this.say(`accounts: could not link the configuration of ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const fresh = [...report.linked, ...report.adopted].filter((item) => !a.links.includes(item));
    if (fresh.length) {
      a.links = [...a.links, ...fresh];
      if (opts.save !== false) void this.save().catch((error: unknown) => this.say(`accounts: could not record the links of ${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    for (const moved of report.movedAside) {
      this.say(`accounts: ${id} had ${moved.reason === 'empty' ? `an empty ${moved.item}` : `a ${moved.item} identical to the default's`} where the default's is linked; moved it to ${moved.to} and linked the default's`);
    }
    for (const step of report.conflicts) {
      const key = `${id}/${step.item}/${step.reason}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.say(`accounts: ${id} has its own ${step.item} (${step.reason}) where the default's would be linked; left as it is`);
    }
    // A conflict that was solved is told again if it comes back
    for (const key of [...this.reported]) if (key.startsWith(`${id}/`) && !report.conflicts.some((c) => key === `${id}/${c.item}/${c.reason}`)) this.reported.delete(key);
    return report;
  }

  /**
   * Whether no live chat runs on the account. Unknown (the owner's runtime not built yet, at start-up)
   * counts as not idle: a file is moved aside only when nothing can be holding it open.
   */
  private idle(id: string): boolean {
    try {
      return (this.opts.liveChatsOn?.(id) ?? []).length === 0;
    } catch {
      return false;
    }
  }

  /** What was already said, so a conflict is logged once rather than at every spawn */
  private readonly reported = new Set<string>();

  private say(message: string): void {
    (this.opts.log ?? ((line: string) => console.warn(line)))(message);
  }

  /** Every account's links, at start-up, and the directories no account names */
  private reconcileAll(): void {
    for (const a of this.stored.accounts) {
      if (a.config?.switching) this.finishSwitch(a);
      this.reconcile(a.id);
    }
    for (const dir of this.orphans()) this.say(`accounts: ${dir} belongs to no account; left in place (remove it by hand if it holds nothing you need)`);
  }

  /** The dirs under `<data>/accounts/` that no account record names; never removed */
  orphans(): string[] {
    return orphanDirs(join(this.opts.dataDir, 'accounts'), new Set(this.stored.accounts.map((a) => a.id)));
  }

  /**
   * Every account of this machine. The CLI's own login is left out while it has no credential at
   * all: it is assumed signed in until read, so before 2026-10-29 a ghost with no credential could be
   * chosen for work (rank 0.5, an unknown reading) by every path but "in use", which alone excluded it.
   */
  list(now: number = Date.now()): Account[] {
    return this.all(now).filter((a) => a.id !== DEFAULT_ID || this.hasCredential(a.id));
  }

  private all(now: number): Account[] {
    const d = this.stored.default;
    const view = (id: string, kind: AccountKind, alias: string | null, enabled: boolean, identity: Identity, failedAt: string | undefined, checkedAt: string | undefined, fingerprint: string | undefined): Account => {
      const authFailedAt = failedAt !== undefined && !this.signedInSince(id, kind, failedAt) ? failedAt : undefined;
      const signInState = this.signInState(id, kind, identity, authFailedAt);
      // An identity never read from the CLI (the default account starts out assumed signed in) is
      // completed from the account block of the last `initialize` the model cache stored: what the
      // CLI said about this account, read from a file, with no process started for it
      // Only when that block is about the account the CLI is signed in as now: after a new
      // `claude auth login` in the dir it would name the previous one, so the login itself is shown
      const login = identity.email === null && kind === 'login' ? cliLogin(this.ref(id).dir) : null;
      const cached = identity.email === null ? this.modelCache.read(id)?.account : undefined;
      const cli = cached && (!login || cached.email === login.email) ? cached : login ? { email: login.email, organization: login.organization, subscriptionType: null } : undefined;
      const limits = this.readings.limit(id, now);
      return {
        id,
        kind,
        alias,
        email: identity.email ?? cli?.email ?? null,
        organization: identity.organization ?? cli?.organization ?? null,
        // `get_usage` states the plan for token accounts too, which `auth status` leaves out
        plan: identity.plan ?? limits?.cli?.plan ?? cli?.subscriptionType ?? null,
        enabled,
        // `claude auth status` keeps saying logged in after the OAuth session expired: the failed run and the credentials file know better
        signedIn: identity.signedIn && (signInState === 'ok' || signInState === 'unknown'),
        signInState,
        ...(authFailedAt ? { authFailedAt } : {}),
        checkedAt: this.checkIsCurrent(id, fingerprint) ? (checkedAt ?? null) : null,
        limits,
      };
    };
    return [
      view(DEFAULT_ID, 'login', d.alias, d.enabled, d.identity, d.authFailedAt, d.checkedAt, d.checkedFingerprint),
      ...this.stored.accounts.map((a) => view(a.id, a.kind, a.alias, a.enabled, a.identity, a.authFailedAt, a.checkedAt, a.checkedFingerprint)),
    ];
  }

  /**
   * Whether the account has any credential at all. A login account or a token or key one always
   * does; the CLI's own login only when it has a credentials file, a key or token in its
   * environment, or a credential that failed (an expired login is a real account with a problem).
   * An empty default dir is a ghost, which `list` leaves out.
   */
  hasCredential(id: string): boolean {
    if (id !== DEFAULT_ID) return true;
    // A credential that failed, or one a check confirmed (a keychain login has no file to look at)
    if (this.stored.default.authFailedAt !== undefined || this.stored.default.checkedAt !== undefined) return true;
    if (existsSync(join(this.defaultDir, CREDENTIALS_FILE))) return true;
    if (this.opts.defaultEnvCredential) return this.opts.defaultEnvCredential();
    const env = this.envOf(DEFAULT_ID);
    return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
  }

  private signInState(id: string, kind: AccountKind, identity: Identity, authFailedAt: string | undefined): AccountSignInState {
    if (authFailedAt !== undefined) return 'expired';
    const credentials = kind === 'login' ? readCredentials(this.dirOf(id)) : null;
    if (credentials && !credentials.complete) return 'incomplete';
    // A login with no credentials file to look at (a keychain, a signed-out dir) is taken as the CLI said
    return identity.signedIn && (kind !== 'login' || credentials) ? 'ok' : 'unknown';
  }

  /** Whether the credentials file was written after the sign-in failed: `claude auth login` or a copied file. Only its time is read. */
  private signedInSince(id: string, kind: AccountKind, failedAt: string): boolean {
    if (kind !== 'login') return false;
    try {
      return statSync(join(this.dirOf(id), CREDENTIALS_FILE)).mtimeMs > Date.parse(failedAt);
    } catch {
      return false;
    }
  }

  get(id: string): Account {
    const a = this.find(id);
    if (!a) throw new NotFoundError(`account ${id} not found`);
    return a;
  }

  /**
   * The account, or null when there is none by that id (removed since). A read by id is not a
   * listing: the CLI's own login answers here while it has no credential, as `GET /accounts/default`,
   * its models, `PATCH` and its sign-in route must work before the first sign-in ([accounts.md]);
   * only `list()`, and so every choice and every count, leaves that ghost out. What every path that
   * folds a run's output onto its account reads: a removed account is no reason to throw out of a
   * stream handler.
   */
  find(id: string, now: number = Date.now()): Account | null {
    return this.all(now).find((x) => x.id === id) ?? null;
  }

  /** What a write answers: the account as it stands, since it was just changed */
  private view(id: string): Account {
    return this.get(id);
  }

  /**
   * Adds an account. A `login` account is an empty dir waiting for `claude auth login`; a `token` or
   * `api-key` one needs an alias (it has no identity) and its secret, kept in a 0600 file in its own
   * dir, never in `accounts.json`.
   */
  async add(request: { kind: AccountKind; alias?: string | null; secret?: string }): Promise<Account> {
    const alias = request.alias?.trim() || null;
    if (request.kind !== 'login') {
      if (!alias) throw new Error(`a ${request.kind} account needs an alias`);
      if (!request.secret?.trim()) throw new Error(`a ${request.kind} account needs its secret`);
    }
    if (alias && this.list().some((a) => a.alias === alias)) throw new Error(`alias ${alias} is already taken`);
    const id = `acc-${randomUUID().slice(0, 8)}`;
    const dir = this.dirOf(id);
    const mode = this.stored.settings.newAccountConfig;
    this.stored.accounts.push({ id, kind: request.kind, alias, enabled: true, links: [], identity: { ...NO_IDENTITY, signedIn: request.kind !== 'login' }, config: { mode } });
    // The links join the record as they are made; a failure leaves no half-made account behind
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // An account born independent starts where one that turns independent does: from a copy (D2)
      if (mode === 'independent') {
        const aside = join(dir, ASIDE_DIR, asideStamp());
        const failed = applySteps(dir, this.defaultDir, planSwitch(dir, this.defaultDir, 'independent', 'copy', aside), { aside }).filter((s) => s.reason === 'failed');
        if (failed.length) throw new Error(`could not copy the shared configuration into ${dir}: ${failed.map((s) => s.name).join(', ')}`);
      }
      this.reconcile(id, { save: false });
      if (request.kind !== 'login') await writeAtomic(join(dir, SECRET_FILE), `${request.secret?.trim()}\n`, 0o600);
    } catch (error) {
      this.stored.accounts = this.stored.accounts.filter((x) => x.id !== id);
      throw error;
    }
    await this.save();
    return this.get(id);
  }

  // ---------- configuration mode ----------

  /**
   * The accounts with their configuration state, for what is served. Not part of `list()`: reading
   * every item of every dir costs a few milliseconds per account, and `list()` is on the path of
   * every choice of an account.
   */
  withConfig(accounts: readonly Account[]): Account[] {
    return accounts.map((a) => {
      const config = a.id === DEFAULT_ID || !this.stored.accounts.some((x) => x.id === a.id) ? null : this.configOf(a.id);
      return config ? { ...a, config } : a;
    });
  }

  /** One account as `withConfig` serves it */
  getWithConfig(id: string): Account {
    const account = this.get(id);
    const config = this.configOf(id);
    return config ? { ...account, config } : account;
  }

  /** How the account's dir stands against its mode; null for the default account, which has none */
  configOf(id: string): AccountConfig | null {
    if (id === DEFAULT_ID) return null;
    const a = this.entry(id);
    const sw = a.config?.switching;
    return describeConfig(this.dirOf(id), this.defaultDir, a.config?.mode ?? 'shared', sw ? { to: sw.to, start: sw.start } : null);
  }

  private configEntry(id: string): StoredAccount {
    if (id === DEFAULT_ID) throw new DefaultAccountConfigError();
    return this.entry(id);
  }

  /**
   * What `setConfigMode(id, to, start)` would do now, with nothing written. A switch that was cut
   * short towards the same mode is planned as its finish, with the start it began with.
   */
  planConfig(id: string, to: AccountConfigMode, start: AccountConfigStart = 'copy'): AccountConfigPlan {
    const a = this.configEntry(id);
    const dir = this.dirOf(id);
    const pending = a.config?.switching?.to === to ? a.config.switching : undefined;
    const how = pending?.start ?? start;
    const stamp = pending?.aside ?? asideStamp();
    const steps = planSwitch(dir, this.defaultDir, to, how, join(dir, ASIDE_DIR, stamp));
    const moves = steps.some((s) => s.action === 'replace' || s.action === 'move-aside');
    return { account: id, from: a.config?.mode ?? 'shared', to, start: to === 'independent' ? how : null, aside: moves ? `${ASIDE_DIR}/${stamp}` : null, steps };
  }

  /**
   * Switches the account's configuration to `to`, or finishes a switch to it that was cut short.
   * The switch is recorded before its first step, carried out item by item (each atomic, a failure
   * blocking only its item), and the mode is stored once every step ran. Running it again is safe:
   * a step already done plans as `keep` or `skip`.
   */
  async setConfigMode(id: string, to: AccountConfigMode, start: AccountConfigStart = 'copy'): Promise<{ steps: AccountConfigStep[]; aside: string | null }> {
    if (!isMode(to)) throw new Error('mode must be shared or independent');
    if (start !== 'copy' && start !== 'empty') throw new Error('start must be copy or empty');
    this.reload();
    const a = this.configEntry(id);
    const plan = this.planConfig(id, to, start);
    const stamp = plan.aside?.slice(ASIDE_DIR.length + 1) ?? a.config?.switching?.aside ?? asideStamp();
    a.config = { mode: a.config?.mode ?? 'shared', switching: { to, start: plan.start ?? 'copy', aside: stamp } };
    await this.save();
    const steps = this.runSwitch(a, plan.steps, stamp);
    await this.save();
    return { steps, aside: steps.some((s) => (s.action === 'replace' || s.action === 'move-aside')) ? `${ASIDE_DIR}/${stamp}` : null };
  }

  /** Carries out a switch's steps and stores its end; the caller saves */
  private runSwitch(a: StoredAccount, steps: readonly AccountConfigStep[], stamp: string): AccountConfigStep[] {
    const dir = this.dirOf(a.id);
    const to = a.config?.switching?.to ?? a.config?.mode ?? 'shared';
    const done = applySteps(dir, this.defaultDir, steps, {
      aside: join(dir, ASIDE_DIR, stamp),
      onError: (step, error) => this.say(`accounts: switching ${a.id} to ${to}: ${step.name} was left as it is (${error instanceof Error ? error.message : String(error)})`),
    });
    a.config = { mode: to };
    // The links the switch made are Claudio's to undo when the account goes; the ones it replaced are gone
    const linked = done.filter((s) => s.action === 'link' || s.action === 'replace' || s.action === 'keep').map((s) => s.name);
    const unlinked = new Set(done.filter((s) => s.action === 'copy' || s.action === 'unlink' || s.action === 'move-aside').map((s) => s.name));
    a.links = [...new Set([...a.links.filter((l) => !unlinked.has(l)), ...linked])];
    this.reconcile(a.id, { save: false });
    return done;
  }

  /** A switch the last server left half-way, finished at start-up with what it began with */
  private finishSwitch(a: StoredAccount): void {
    const sw = a.config?.switching;
    if (!sw) return;
    const dir = this.dirOf(a.id);
    this.say(`accounts: finishing the switch of ${a.id} to ${sw.to}, cut short before`);
    this.runSwitch(a, planSwitch(dir, this.defaultDir, sw.to, sw.start, join(dir, ASIDE_DIR, sw.aside)), sw.aside);
    void this.save().catch((error: unknown) => this.say(`accounts: could not record the switch of ${a.id}: ${error instanceof Error ? error.message : String(error)}`));
  }

  private checkItem(a: StoredAccount, name: string): void {
    const kind = itemClass(name);
    if (kind === null) throw new Error(`${name} is not a configuration or history item`);
    if (kind === 'config' && a.config?.mode === 'independent') throw new Error(`${a.id} keeps its own configuration: switch it to shared to use the default's ${name}`);
  }

  /** What "use shared" would do for one item, with nothing written */
  planItem(id: string, name: string): AccountConfigPlan {
    const a = this.configEntry(id);
    this.checkItem(a, name);
    const stamp = asideStamp();
    const dir = this.dirOf(id);
    const step = planUseShared(dir, this.defaultDir, name, join(dir, ASIDE_DIR, stamp));
    const mode = a.config?.mode ?? 'shared';
    return { account: id, from: mode, to: mode, start: null, aside: step.action === 'replace' ? `${ASIDE_DIR}/${stamp}` : null, steps: [step] };
  }

  /**
   * "Use shared" for one item: the account's own item (a real `agent-memory/` an older account made,
   * a settings file of its own) is moved aside, never deleted, and the default's linked.
   */
  async useShared(id: string, name: string): Promise<{ steps: AccountConfigStep[]; aside: string | null }> {
    this.reload();
    const a = this.configEntry(id);
    this.checkItem(a, name);
    const stamp = asideStamp();
    const dir = this.dirOf(id);
    const step = planUseShared(dir, this.defaultDir, name, join(dir, ASIDE_DIR, stamp));
    const steps = applySteps(dir, this.defaultDir, [step], {
      aside: join(dir, ASIDE_DIR, stamp),
      onError: (s, error) => this.say(`accounts: ${id}: ${s.name} was left as it is (${error instanceof Error ? error.message : String(error)})`),
    });
    if (steps.some((s) => s.action === 'link' || s.action === 'replace') && !a.links.includes(name)) a.links = [...a.links, name];
    await this.save();
    return { steps, aside: steps.some((s) => s.action === 'replace') ? `${ASIDE_DIR}/${stamp}` : null };
  }

  /** Refused with {@link AccountInUseError} (409) while a live chat runs on the account. */
  async remove(id: string): Promise<void> {
    if (id === DEFAULT_ID) throw new Error('the default account is the CLI\'s own and cannot be removed');
    const a = this.entry(id);
    const live = this.opts.liveChatsOn?.(id) ?? [];
    if (live.length) throw new AccountInUseError(id, live);
    const dir = this.dirOf(id);
    // Links first, so nothing below follows one into the default dir
    removeLinks(dir, this.defaultDir, a.links);
    await rm(dir, { recursive: true, force: true });
    this.stored.accounts = this.stored.accounts.filter((x) => x.id !== id);
    for (const p of this.stored.policies) if (p.order) p.order = p.order.filter((x) => x !== id);
    const { settings } = this.stored;
    if (settings.preferred === id) settings.preferred = null;
    settings.order = settings.order.filter((x) => x !== id);
    await this.readings.forget(id);
    await this.save();
  }

  async setEnabled(id: string, enabled: boolean): Promise<Account> {
    if (id === DEFAULT_ID) this.stored.default.enabled = enabled;
    else this.entry(id).enabled = enabled;
    await this.save();
    return this.view(id);
  }

  async setAlias(id: string, alias: string | null): Promise<Account> {
    const next = alias?.trim() || null;
    if (next && this.list().some((a) => a.id !== id && a.alias === next)) throw new Error(`alias ${next} is already taken`);
    if (id === DEFAULT_ID) this.stored.default.alias = next;
    else {
      const a = this.entry(id);
      if (!next && a.kind !== 'login') throw new Error(`a ${a.kind} account needs an alias`);
      a.alias = next;
    }
    await this.save();
    return this.view(id);
  }

  /** Asks the CLI who the account is and whether it is signed in. `token` and `api-key` accounts have no identity to learn. */
  async refresh(id: string): Promise<Account> {
    const ref = this.ref(id);
    let identity: Identity;
    if (ref.kind === 'login') identity = await identify(ref, { claude: this.claude, env: this.env, ...(this.opts.onSpawn ? { onSpawn: this.opts.onSpawn } : {}) });
    else identity = { ...NO_IDENTITY, signedIn: true };
    const entry = id === DEFAULT_ID ? this.stored.default : this.entry(id);
    entry.identity = identity;
    // A sign-in newer than the failure ends it; the list already reads it so, this drops the stale mark
    if (entry.authFailedAt !== undefined && this.signedInSince(id, ref.kind, entry.authFailedAt)) delete entry.authFailedAt;
    await this.save();
    return this.view(id);
  }

  /** The `ANTHROPIC_API_KEY` this account's runs get, or null (see `apiKeyOf`) */
  private keyOf(id: string): string | null {
    try {
      return apiKeyOf(this.ref(id), this.envOf(id));
    } catch {
      return null;
    }
  }

  /** The CLI's own login also sees what Claudio keeps sealed; every other account has only its own */
  private envOf(id: string): NodeJS.ProcessEnv {
    return id === DEFAULT_ID ? (this.opts.defaultEnv?.() ?? this.env) : this.env;
  }

  /** Whether the account's runs get an API key, which a check can judge for free */
  usesApiKey(id: string): boolean {
    return this.keyOf(id) !== null;
  }

  private fingerprint(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /** A check stands for the key it checked: a changed key lists as never checked */
  private checkIsCurrent(id: string, fingerprint: string | undefined): boolean {
    const key = this.keyOf(id);
    return key === null || fingerprint === undefined || fingerprint === this.fingerprint(key);
  }

  /**
   * Asks whether the credential works, with no turn and no tokens: Anthropic's own `models.list` for
   * an API key, the CLI's `get_usage` for the rest (`checkCredential`). `valid` clears a
   * failed-sign-in mark, since the credential just proved itself. `refused`, which only a key can
   * be, marks the account expired as a run that failed at authentication does. `unknown` changes
   * nothing: it cannot tell a refused credential from an unreachable network.
   */
  async check(id: string, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<CredentialCheck> {
    const result = await checkCredential(this.ref(id), { claude: this.claude, ...opts, env: this.envOf(id) });
    if (result === 'valid') await this.confirm(id);
    else if (result === 'refused') await this.markAuthFailed(id);
    return result;
  }

  /** The credential just proved itself (a key Anthropic accepted, a `get_usage` with the plan's limits, a turn that went through): not expired, checked now. */
  async confirm(id: string, at: number = Date.now()): Promise<void> {
    const entry = id === DEFAULT_ID ? this.stored.default : this.entry(id);
    delete entry.authFailedAt;
    await this.markChecked(id, at);
  }

  /** Records that the credential was checked now (a check that confirmed it, a turn, or a test message). */
  async markChecked(id: string, at: number = Date.now()): Promise<void> {
    const entry = id === DEFAULT_ID ? this.stored.default : this.entry(id);
    entry.checkedAt = new Date(at).toISOString();
    const key = this.keyOf(id);
    if (key) entry.checkedFingerprint = this.fingerprint(key);
    else delete entry.checkedFingerprint;
    await this.save();
  }

  /**
   * A run on the account failed because the CLI could not authenticate (an expired OAuth session, a
   * revoked token): it lists as `expired` and signed out, so `choose` skips it, until it is signed in
   * again. Stored, since `claude auth status` keeps saying it is logged in. False when it was marked
   * already and nothing has signed it in since.
   */
  async markAuthFailed(id: string, at: number = Date.now()): Promise<boolean> {
    const entry = id === DEFAULT_ID ? this.stored.default : this.entry(id);
    if (entry.authFailedAt !== undefined && !this.signedInSince(id, this.ref(id).kind, entry.authFailedAt)) return false;
    entry.authFailedAt = new Date(at).toISOString();
    await this.save();
    return true;
  }

  /** The account authenticated again (a run on it succeeded): it is no longer expired. False when it was not marked. */
  async clearAuthFailed(id: string): Promise<boolean> {
    const entry = id === DEFAULT_ID ? this.stored.default : this.stored.accounts.find((x) => x.id === id);
    if (!entry || entry.authFailedAt === undefined) return false;
    delete entry.authFailedAt;
    await this.save();
    return true;
  }

  /**
   * The models an account can run, from the CLI's `initialize` (no turn, no tokens), cached under
   * `<data>/accounts/models/`; refreshed when the CLI version or the account's plan moves.
   */
  models(id: string, opts: { refresh?: boolean } = {}): Promise<ModelOption[]> {
    return this.modelCache.models(this.ref(id), { plan: this.get(id).plan, ...opts });
  }

  /**
   * Whether the account can run the model, from the stored list. An account whose list was never
   * read is given the benefit of the doubt: the first turn would tell, and `warmModels` reads them.
   */
  canRun(id: string, model: string): boolean {
    return this.canRunAmong(id, model, this.list());
  }

  /**
   * `canRun` against a listing already read. `pick` asks it of every candidate, and a fresh `list()`
   * per candidate read every account's files once per account (R12 of
   * docs/plans/ci-and-regression-open.md).
   */
  private canRunAmong(id: string, model: string, accounts: readonly Account[]): boolean {
    const listed = this.modelCache.cached(id);
    if (!listed || offers(listed, model)) return true;
    // A name no account lists (a model id a chat reported, a custom endpoint's model) is not one the
    // lists can speak for: refusing it everywhere would only stop the chat
    return !accounts.some((a) => {
      const other = a.id === id ? null : this.modelCache.cached(a.id);
      return !!other && offers(other, model);
    });
  }

  /**
   * The stored list of an account without reading it, for the paths that cannot wait. Null when
   * there is none, or when it was read under another CLI version than the one last seen running.
   */
  cachedModels(id: string): ModelOption[] | null {
    return this.modelCache.cached(id);
  }

  /**
   * Reads the lists of every signed-in, enabled account that has none for the running CLI; a failing
   * one is skipped. `checkVersion` asks the CLI its version first (one `claude --version`), which is
   * what the server does at boot and when it sees the CLI change: a list read under the old version
   * then counts as missing and is read again.
   */
  async warmModels(opts: { checkVersion?: boolean } = {}): Promise<void> {
    if (opts.checkVersion) await this.modelCache.learnVersion().catch(() => undefined);
    const missing = this.list().filter((a) => a.enabled && a.signedIn && !this.modelCache.cached(a.id));
    await Promise.all(missing.map((a) => this.models(a.id).catch(() => undefined)));
  }

  /**
   * Asks the CLI for the account's real usage (`get_usage`; no turn, no tokens). The reading is
   * returned, not recorded: the caller hands it to `observe` (the runtime also appends the history).
   * A CLI that fails or times out rejects.
   */
  fetchUsage(id: string, opts: { timeoutMs?: number } = {}): Promise<Reading> {
    return usageOf(this.ref(id), { claude: this.claude, env: this.env, ...(this.opts.onSpawn ? { onSpawn: this.opts.onSpawn } : {}), ...opts });
  }

  /** Records a reading from a run's stream or a failed turn. */
  async observe(id: string, reading: Reading): Promise<boolean> {
    const kept = await this.readings.observe(id, reading);
    if (kept) this.changed();
    return kept;
  }

  /**
   * The CLI's cached usage for an account that has not run a turn lately; a stream reading that is
   * newer is kept. Best-effort: no cache is no reading.
   */
  async readCachedUsage(id: string): Promise<boolean> {
    const reading = readCache(this.dirOf(id));
    return reading ? this.observe(id, reading) : false;
  }

  // ---------- settings and policies ----------

  settings(): AccountsSettings {
    return { ...this.stored.settings, order: [...this.stored.settings.order] };
  }

  /**
   * Merges `patch` over the stored settings, validated. A `preferred` given must be an enabled
   * account; an `order` given must name every enabled account once (a disabled one may be named
   * too). Checked only when given: an account added or enabled since the order was stored goes after
   * the ones it names, and is no reason to refuse a change of the threshold.
   */
  async setSettings(patch: Partial<AccountsSettings>): Promise<AccountsSettings> {
    const next = { ...this.stored.settings, ...patch };
    checkSettings(next);
    const accounts = this.list();
    if (patch.preferred !== undefined && patch.preferred !== null) {
      const preferred = accounts.find((a) => a.id === patch.preferred);
      // Worded as the refusal it is (400): a message that says "not found" answers 404
      if (!preferred) throw new Error(`preferred must be an account's id; ${patch.preferred} is none`);
      if (!preferred.enabled) throw new Error(`preferred must be an enabled account; ${patch.preferred} is disabled`);
    }
    if (patch.order !== undefined && next.order.length) {
      const known = new Set(accounts.map((a) => a.id));
      const unknown = next.order.find((id) => !known.has(id));
      if (unknown) throw new Error(`order must name accounts only; ${unknown} is none`);
      const missing = accounts.find((a) => a.enabled && !next.order.includes(a.id));
      if (missing) throw new Error(`order must name every enabled account; ${missing.id} is missing`);
    }
    this.stored.settings = { ...next, order: [...next.order] };
    for (const key of SETTING_KEYS) if (patch[key] !== undefined) this.settingKeys.add(key);
    await this.save();
    return this.settings();
  }

  /** The settings `accounts.json` holds, the ones the defaults do not fill in */
  storedSettingKeys(): ReadonlySet<keyof AccountsSettings> {
    return new Set(this.settingKeys);
  }

  /**
   * Removes the stored value of each key (one key per path), so the default applies again; the
   * result is held to the rules of `setSettings`. Told to the listeners like any other save.
   */
  async resetSettings(paths: readonly (readonly string[])[]): Promise<AccountsSettings> {
    const keys = paths.map((path) => {
      const key = SETTING_KEYS.find((known) => known === path[0]);
      if (path.length !== 1 || key === undefined) throw new Error(`unknown accounts setting: ${path.join('.')}`);
      return key;
    });
    if (!keys.some((key) => this.settingKeys.has(key))) return this.settings();
    const next: AccountsSettings = { ...this.stored.settings };
    for (const key of keys) Object.assign(next, { [key]: DEFAULT_SETTINGS[key] });
    checkSettings(next);
    this.stored.settings = next;
    for (const key of keys) this.settingKeys.delete(key);
    await this.save();
    return this.settings();
  }

  policies(): RotationPolicy[] {
    return this.stored.policies.map((p) => ({ ...p, projects: [...p.projects], ...(p.order ? { order: [...p.order] } : {}) }));
  }

  policyFor(projectId: string | null): RotationPolicy | null {
    if (projectId === null) return this.stored.policies.find((p) => p.looseChats === true) ?? null;
    return this.stored.policies.find((p) => p.projects.includes(projectId)) ?? null;
  }

  private validPolicy(request: RotationPolicyRequest, id: string | null): Omit<RotationPolicy, 'id'> {
    if (request.threshold !== undefined) {
      const t = Number(request.threshold);
      if (!Number.isFinite(t) || t < THRESHOLD_MIN || t > THRESHOLD_MAX) throw new Error(`threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`);
    }
    if (request.looseChats !== undefined && typeof request.looseChats !== 'boolean') throw new Error('looseChats must be a boolean');
    const looseChats = request.looseChats === true;
    if (!Array.isArray(request.projects) || request.projects.some((p) => typeof p !== 'string' || !p)) throw new Error('projects must be a list of project ids');
    // A policy that governs nothing would sit in the list and never be applied
    if (!request.projects.length && !looseChats) throw new Error('projects must list at least one project id, or looseChats must be true');
    if (looseChats) {
      const other = this.stored.policies.find((p) => p.id !== id && p.looseChats === true);
      if (other) throw new Error(`chats without a project are already governed by policy ${other.id}`);
    }
    const projects = [...new Set(request.projects)];
    for (const project of projects) {
      const other = this.stored.policies.find((p) => p.id !== id && p.projects.includes(project));
      if (other) throw new Error(`project ${project} is already governed by policy ${other.id}`);
    }
    let order: string[] | undefined;
    if (request.order !== undefined) {
      const known = new Set(this.list().map((a) => a.id));
      if (!Array.isArray(request.order) || !request.order.length || request.order.some((x) => !known.has(x))) throw new Error('order must list account ids');
      order = [...new Set(request.order)];
    }
    return {
      ...(request.threshold !== undefined ? { threshold: Math.round(Number(request.threshold) * 10) / 10 } : {}),
      projects,
      ...(order ? { order } : {}),
      ...(looseChats ? { looseChats: true } : {}),
    };
  }

  async createPolicy(request: RotationPolicyRequest): Promise<RotationPolicy> {
    const policy: RotationPolicy = { id: randomUUID(), ...this.validPolicy(request, null) };
    this.stored.policies.push(policy);
    await this.save();
    return policy;
  }

  async updatePolicy(id: string, request: RotationPolicyRequest): Promise<RotationPolicy> {
    const index = this.stored.policies.findIndex((p) => p.id === id);
    if (index === -1) throw new NotFoundError('policy not found');
    const policy: RotationPolicy = { id, ...this.validPolicy(request, id) };
    this.stored.policies[index] = policy;
    await this.save();
    return policy;
  }

  async deletePolicy(id: string): Promise<void> {
    const before = this.stored.policies.length;
    this.stored.policies = this.stored.policies.filter((p) => p.id !== id);
    if (this.stored.policies.length === before) throw new NotFoundError('policy not found');
    await this.save();
  }

  // ---------- choosing ----------

  /**
   * `choose` over this machine's accounts and their latest readings. `accounts` is a `list(now)` the
   * caller has already read, which is then the only listing: `accountView` shows the accounts and
   * picks among the same ones, and it used to read every account's files twice per view (R12).
   */
  pick(opts: Omit<ChooseOptions, 'now'> & { now?: number; accounts?: readonly Account[] } = { current: null }): Choice {
    const { accounts: given, ...rest } = opts;
    const now = rest.now ?? Date.now();
    const accounts = given ?? this.list(now);
    const limits = Object.fromEntries(accounts.map((a) => [a.id, a.limits]));
    return choose(accounts, limits, this.stored.settings, { canRun: (id, model) => this.canRunAmong(id, model, accounts), ...rest, now });
  }
}
