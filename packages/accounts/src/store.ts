import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account, AccountKind, AccountSignInState, AccountsSettings, ModelOption, RotationPolicy, RotationPolicyRequest } from '@claudio/shared';
import { choose, type Choice, type ChooseOptions } from './choose.ts';
import { prepareAccountDir, removeLinks } from './dirs.ts';
import { DEFAULT_ID, SECRET_FILE, type AccountRef } from './env.ts';
import { isRecord, writeAtomic } from './fs.ts';
import { CREDENTIALS_FILE, identify, readCredentials, type Identity } from './identify.ts';
import { apiKeyOf, checkCredential, usageOf, type CredentialCheck } from './cli-usage.ts';
import { ModelCache, offers, type ModelsOptions } from './models.ts';
import { cliLogin, readCache, Readings, type Reading } from './usage.ts';

/** The CLI's own config dir: the account a fresh install already has, with nothing to set up. */
export { DEFAULT_ID };

export const DEFAULT_SETTINGS: AccountsSettings = { rotateOnLimit: true, threshold: 90, hysteresis: 10, cooldownSeconds: 300, strategy: 'least-used' };

const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 99.9;

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
}

interface Stored {
  settings: AccountsSettings;
  /** The CLI's own dir is not stored as an account, only what a person changed about it */
  default: { enabled: boolean; alias: string | null; identity: Identity; authFailedAt?: string; checkedAt?: string; checkedFingerprint?: string };
  accounts: StoredAccount[];
  policies: RotationPolicy[];
}

/** `claude` is read when a call is made, not when the cache is built: the binary can change under a running server */
function modelsOptions(claude: () => string, env: NodeJS.ProcessEnv): ModelsOptions {
  return {
    get claude() {
      return claude();
    },
    env,
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
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parseIdentity(v: unknown): Identity {
  if (!isRecord(v)) return { ...NO_IDENTITY };
  return { signedIn: v.signedIn === true, email: str(v.email), organization: str(v.organization), plan: str(v.plan) };
}

function parseSettings(v: unknown): AccountsSettings {
  const d = DEFAULT_SETTINGS;
  if (!isRecord(v)) return { ...d };
  const n = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
  return {
    rotateOnLimit: typeof v.rotateOnLimit === 'boolean' ? v.rotateOnLimit : d.rotateOnLimit,
    threshold: n(v.threshold, d.threshold),
    hysteresis: n(v.hysteresis, d.hysteresis),
    cooldownSeconds: n(v.cooldownSeconds, d.cooldownSeconds),
    strategy: v.strategy === 'order' || v.strategy === 'least-used' ? v.strategy : d.strategy,
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

  constructor(private readonly opts: AccountStoreOptions) {
    this.env = opts.env ?? process.env;
    this.defaultDir = opts.defaultDir ?? this.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const claude = opts.claude ?? 'claude';
    this.claudeOf = typeof claude === 'function' ? claude : () => claude;
    this.file = join(opts.dataDir, 'accounts.json');
    this.readings = new Readings(join(opts.dataDir, 'accounts', 'limits.json'));
    this.modelCache = new ModelCache(join(opts.dataDir, 'accounts', 'models'), modelsOptions(() => this.claude, this.env));
    this.reload();
  }

  /** Re-reads the file: another process (the binary, the app) may have written it. */
  reload(): void {
    if (!existsSync(this.file)) return;
    try {
      const doc: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (isRecord(doc)) this.stored = parse(doc);
    } catch {
      // Overwriting a document that does not parse would drop the accounts in it
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
  }

  private async save(): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`, 0o600);
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

  private find(id: string): StoredAccount {
    const a = this.stored.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`account ${id} not found`);
    return a;
  }

  // ---------- accounts ----------

  /** What a process launcher needs: the account's id, kind and directory. */
  ref(id: string): AccountRef {
    if (id === DEFAULT_ID) return { id, kind: 'login', dir: this.defaultDir };
    const a = this.find(id);
    return { id, kind: a.kind, dir: this.dirOf(id) };
  }

  list(now: number = Date.now()): Account[] {
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
   * An empty default dir is a ghost, which `listed` leaves out.
   */
  hasCredential(id: string): boolean {
    if (id !== DEFAULT_ID) return true;
    if (this.stored.default.authFailedAt !== undefined) return true;
    if (existsSync(join(this.defaultDir, CREDENTIALS_FILE))) return true;
    return this.opts.defaultEnvCredential?.() ?? Boolean(this.env.CLAUDE_CODE_OAUTH_TOKEN || this.env.ANTHROPIC_API_KEY);
  }

  /** `list` without the CLI's own login while it has no credential at all */
  listed(now: number = Date.now()): Account[] {
    return this.list(now).filter((a) => a.id !== DEFAULT_ID || this.hasCredential(a.id));
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
    const a = this.list().find((x) => x.id === id);
    if (!a) throw new Error(`account ${id} not found`);
    return a;
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
    const links = prepareAccountDir(dir, this.defaultDir);
    if (request.kind !== 'login') await writeAtomic(join(dir, SECRET_FILE), `${request.secret?.trim()}\n`, 0o600);
    this.stored.accounts.push({ id, kind: request.kind, alias, enabled: true, links, identity: { ...NO_IDENTITY, signedIn: request.kind !== 'login' } });
    await this.save();
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    if (id === DEFAULT_ID) throw new Error('the default account is the CLI\'s own and cannot be removed');
    const a = this.find(id);
    const dir = this.dirOf(id);
    // Links first, so nothing below follows one into the default dir
    removeLinks(dir, this.defaultDir, a.links);
    await rm(dir, { recursive: true, force: true });
    this.stored.accounts = this.stored.accounts.filter((x) => x.id !== id);
    for (const p of this.stored.policies) if (p.order) p.order = p.order.filter((x) => x !== id);
    await this.readings.forget(id);
    await this.save();
  }

  async setEnabled(id: string, enabled: boolean): Promise<Account> {
    if (id === DEFAULT_ID) this.stored.default.enabled = enabled;
    else this.find(id).enabled = enabled;
    await this.save();
    return this.get(id);
  }

  async setAlias(id: string, alias: string | null): Promise<Account> {
    const next = alias?.trim() || null;
    if (next && this.list().some((a) => a.id !== id && a.alias === next)) throw new Error(`alias ${next} is already taken`);
    if (id === DEFAULT_ID) this.stored.default.alias = next;
    else {
      const a = this.find(id);
      if (!next && a.kind !== 'login') throw new Error(`a ${a.kind} account needs an alias`);
      a.alias = next;
    }
    await this.save();
    return this.get(id);
  }

  /** Asks the CLI who the account is and whether it is signed in. `token` and `api-key` accounts have no identity to learn. */
  async refresh(id: string): Promise<Account> {
    const ref = this.ref(id);
    let identity: Identity;
    if (ref.kind === 'login') identity = await identify(ref, { claude: this.claude, env: this.env });
    else identity = { ...NO_IDENTITY, signedIn: true };
    const entry = id === DEFAULT_ID ? this.stored.default : this.find(id);
    entry.identity = identity;
    // A sign-in newer than the failure ends it; the list already reads it so, this drops the stale mark
    if (entry.authFailedAt !== undefined && this.signedInSince(id, ref.kind, entry.authFailedAt)) delete entry.authFailedAt;
    await this.save();
    return this.get(id);
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
    const entry = id === DEFAULT_ID ? this.stored.default : this.find(id);
    delete entry.authFailedAt;
    await this.markChecked(id, at);
  }

  /** Records that the credential was checked now (a check that confirmed it, a turn, or a test message). */
  async markChecked(id: string, at: number = Date.now()): Promise<void> {
    const entry = id === DEFAULT_ID ? this.stored.default : this.find(id);
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
    const entry = id === DEFAULT_ID ? this.stored.default : this.find(id);
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
    const listed = this.modelCache.cached(id);
    if (!listed || offers(listed, model)) return true;
    // A name no account lists (a model id a chat reported, a custom endpoint's model) is not one the
    // lists can speak for: refusing it everywhere would only stop the chat
    return !this.list().some((a) => {
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
    return usageOf(this.ref(id), { claude: this.claude, env: this.env, ...opts });
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
    return { ...this.stored.settings };
  }

  async setSettings(patch: Partial<AccountsSettings>): Promise<AccountsSettings> {
    const next = { ...this.stored.settings, ...patch };
    if (typeof next.rotateOnLimit !== 'boolean') throw new Error('rotateOnLimit must be a boolean');
    if (!(next.threshold >= THRESHOLD_MIN && next.threshold <= THRESHOLD_MAX)) throw new Error(`threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`);
    if (!(next.hysteresis >= 0 && next.hysteresis < next.threshold)) throw new Error('hysteresis must be between 0 and the threshold');
    if (!(next.cooldownSeconds >= 0)) throw new Error('cooldownSeconds must not be negative');
    if (next.strategy !== 'order' && next.strategy !== 'least-used') throw new Error('strategy must be order or least-used');
    this.stored.settings = next;
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
    if (index === -1) throw new Error('policy not found');
    const policy: RotationPolicy = { id, ...this.validPolicy(request, id) };
    this.stored.policies[index] = policy;
    await this.save();
    return policy;
  }

  async deletePolicy(id: string): Promise<void> {
    const before = this.stored.policies.length;
    this.stored.policies = this.stored.policies.filter((p) => p.id !== id);
    if (this.stored.policies.length === before) throw new Error('policy not found');
    await this.save();
  }

  // ---------- choosing ----------

  /** `choose` over this machine's accounts and their latest readings. */
  pick(opts: Omit<ChooseOptions, 'now'> & { now?: number } = { current: null }): Choice {
    const now = opts.now ?? Date.now();
    const accounts = this.list(now);
    const limits = Object.fromEntries(accounts.map((a) => [a.id, a.limits]));
    return choose(accounts, limits, this.stored.settings, { canRun: (id, model) => this.canRun(id, model), ...opts, now });
  }
}
