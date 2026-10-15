import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account, AccountKind, AccountsSettings, ModelOption, RotationPolicy, RotationPolicyRequest } from '@agentry/shared';
import { choose, type Choice, type ChooseOptions } from './choose.ts';
import { prepareAccountDir, removeLinks } from './dirs.ts';
import { SECRET_FILE, type AccountRef } from './env.ts';
import { isRecord, writeAtomic } from './fs.ts';
import { identify, type Identity } from './identify.ts';
import { ModelCache } from './models.ts';
import { readCache, Readings, type Reading } from './usage.ts';

/** The CLI's own config dir: the account a fresh install already has, with nothing to set up. */
export const DEFAULT_ID = 'default';

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
}

interface Stored {
  settings: AccountsSettings;
  /** The CLI's own dir is not stored as an account, only what a person changed about it */
  default: { enabled: boolean; alias: string | null; identity: Identity };
  accounts: StoredAccount[];
  policies: RotationPolicy[];
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
  claude?: string;
  /** The environment the `claude` subprocesses start from; `process.env` when absent */
  env?: NodeJS.ProcessEnv;
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
    default: { enabled: def.enabled !== false, alias: str(def.alias), identity: isRecord(def.identity) ? parseIdentity(def.identity) : { ...ASSUMED_IDENTITY } },
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
  private readonly claude: string;
  private readonly env: NodeJS.ProcessEnv;
  private stored: Stored = { settings: { ...DEFAULT_SETTINGS }, default: { enabled: true, alias: null, identity: { ...ASSUMED_IDENTITY } }, accounts: [], policies: [] };

  constructor(private readonly opts: AccountStoreOptions) {
    this.env = opts.env ?? process.env;
    this.defaultDir = opts.defaultDir ?? this.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    this.claude = opts.claude ?? 'claude';
    this.file = join(opts.dataDir, 'accounts.json');
    this.readings = new Readings(join(opts.dataDir, 'accounts', 'limits.json'));
    this.modelCache = new ModelCache(join(opts.dataDir, 'accounts', 'models'), { claude: this.claude, env: this.env });
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

  private save(): Promise<void> {
    return writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`, 0o600);
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
    const view = (id: string, kind: AccountKind, alias: string | null, enabled: boolean, identity: Identity): Account => ({
      id,
      kind,
      alias,
      email: identity.email,
      organization: identity.organization,
      plan: identity.plan,
      enabled,
      signedIn: identity.signedIn,
      limits: this.readings.limit(id, now),
    });
    return [
      view(DEFAULT_ID, 'login', d.alias, d.enabled, d.identity),
      ...this.stored.accounts.map((a) => view(a.id, a.kind, a.alias, a.enabled, a.identity)),
    ];
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
    if (id === DEFAULT_ID) this.stored.default.identity = identity;
    else this.find(id).identity = identity;
    await this.save();
    return this.get(id);
  }

  /**
   * The models an account can run, from the CLI's `initialize` (no turn, no tokens), cached under
   * `<data>/accounts/models/`; refreshed when the CLI version or the account's plan moves.
   */
  models(id: string, opts: { refresh?: boolean } = {}): Promise<ModelOption[]> {
    return this.modelCache.models(this.ref(id), { plan: this.get(id).plan, ...opts });
  }

  /** Records a reading from a run's stream or a failed turn. */
  observe(id: string, reading: Reading): Promise<boolean> {
    return this.readings.observe(id, reading);
  }

  /**
   * The CLI's cached usage for an account that has not run a turn lately; a stream reading that is
   * newer is kept. Best-effort: no cache is no reading.
   */
  async readCachedUsage(id: string): Promise<boolean> {
    const reading = readCache(this.dirOf(id));
    return reading ? this.readings.observe(id, reading) : false;
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
    return choose(accounts, limits, this.stored.settings, { ...opts, now });
  }
}
