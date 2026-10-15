import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption, ModelTier } from '@claudio/shared';
import { envFor, type AccountRef } from './env.ts';
import { isRecord, writeAtomic } from './fs.ts';

/** What `initialize` says about the account besides its models. */
export interface InitializeAccount {
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  apiProvider: string | null;
}

export interface Initialized {
  models: ModelOption[];
  account: InitializeAccount;
}

/** What is stored per account: stamped with what the list depends on, so a change of either refreshes it. */
export interface ModelsEntry extends Initialized {
  cliVersion: string;
  fetchedAt: string;
}

export interface ModelsOptions {
  claude?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The CLI does not rank its models; the family in the id does, which is how the picker groups them. */
function tierOf(id: string): ModelTier | undefined {
  if (/haiku/i.test(id)) return 'fast';
  if (/sonnet/i.test(id)) return 'balanced';
  if (/opus|fable/i.test(id)) return 'strong';
  return undefined;
}

/** The `response` of an `initialize` control request, as the options `--model` takes. */
export function parseInitialize(response: unknown): Initialized {
  if (!isRecord(response)) throw new Error('initialize answered with no object');
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(response.models) ? (response.models as unknown[]) : []) {
    if (!isRecord(raw)) continue;
    const value = str(raw.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const resolved = str(raw.resolvedModel);
    const label = str(raw.displayName);
    const description = str(raw.description);
    const tier = tierOf(resolved ?? value);
    const levels = Array.isArray(raw.supportedEffortLevels) ? raw.supportedEffortLevels.filter((l): l is string => typeof l === 'string') : null;
    models.push({
      value,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(resolved ? { resolvedModel: resolved } : {}),
      ...(typeof raw.supportsEffort === 'boolean' ? { supportsEffort: raw.supportsEffort } : {}),
      ...(levels ? { supportedEffortLevels: levels } : {}),
      ...(tier ? { tier } : {}),
    });
  }
  const a = isRecord(response.account) ? response.account : {};
  return {
    models,
    account: { email: str(a.email), organization: str(a.organization), subscriptionType: str(a.subscriptionType), apiProvider: str(a.apiProvider) },
  };
}

/**
 * Sends the CLI an `initialize` control request in the account's own environment and reads the
 * answer: no prompt, no turn, no tokens. The process is ended as soon as it has answered.
 */
export function readInitialize(account: AccountRef, opts: ModelsOptions = {}): Promise<Initialized> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.claude ?? 'claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      env: envFor(account, opts.env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const requestId = 'claudio-initialize';
    let buffer = '';
    let settled = false;
    const finish = (err: Error | null, value?: Initialized): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value as Initialized);
    };
    const timer = setTimeout(() => finish(new Error('the CLI did not answer initialize in time')), opts.timeoutMs ?? 20_000);
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(new Error('the CLI ended without answering initialize')));
    child.stdin.on('error', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(msg) || msg.type !== 'control_response' || !isRecord(msg.response) || msg.response.request_id !== requestId) continue;
        if (msg.response.subtype === 'error') return finish(new Error(str(msg.response.error) ?? 'the CLI refused initialize'));
        try {
          finish(null, parseInitialize(msg.response.response));
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
        return;
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`);
  });
}

/** `claude --version`, the half of the cache key that moves with a CLI update. */
export function cliVersion(opts: ModelsOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(opts.claude ?? 'claude', ['--version'], { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 20_000 }, (err, stdout) => {
      const out = stdout.trim();
      if (out) resolve(out);
      else reject(err ?? new Error('claude --version printed nothing'));
    });
  });
}

function parseEntry(doc: unknown): ModelsEntry | null {
  if (!isRecord(doc) || typeof doc.cliVersion !== 'string' || typeof doc.fetchedAt !== 'string' || !Array.isArray(doc.models) || !isRecord(doc.account)) return null;
  return doc as unknown as ModelsEntry;
}

/** `auth status` says `max`, `initialize` says `Claude Max`: they name the same plan. */
function samePlan(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/^claude\s+/, '').trim();
  return norm(a) === norm(b);
}

/** The per-account lists, one JSON file each under `<dir>/<account id>.json`. */
export class ModelCache {
  constructor(
    private readonly dir: string,
    private readonly opts: ModelsOptions = {},
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** The stored entry, whatever its age; null when there is none or it does not parse. */
  read(id: string): ModelsEntry | null {
    const file = this.file(id);
    if (!existsSync(file)) return null;
    try {
      return parseEntry(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /**
   * The models the account can run. Served from the cache while the CLI version and the plan are
   * the ones it was read under; `plan` is the account's known `subscriptionType` (the accounts list
   * carries it), and a different one refreshes. `refresh` forces a read.
   */
  /** What the account can run according to the stored list, or null before it was ever read. Synchronous: `choose` runs in the launch path. */
  cached(id: string): ModelOption[] | null {
    return this.read(id)?.models ?? null;
  }

  async models(account: AccountRef, opts: { plan?: string | null; refresh?: boolean } = {}): Promise<ModelOption[]> {
    return (await this.entry(account, opts)).models;
  }

  async entry(account: AccountRef, opts: { plan?: string | null; refresh?: boolean } = {}): Promise<ModelsEntry> {
    const version = await cliVersion({ ...this.opts, env: envFor(account, this.opts.env) });
    const hit = this.read(account.id);
    const planMoved = !!opts.plan && !!hit?.account.subscriptionType && !samePlan(opts.plan, hit.account.subscriptionType);
    if (hit && !opts.refresh && hit.cliVersion === version && !planMoved) return hit;
    const read = await readInitialize(account, this.opts);
    const entry: ModelsEntry = { ...read, cliVersion: version, fetchedAt: new Date().toISOString() };
    await writeAtomic(this.file(account.id), `${JSON.stringify(entry, null, 2)}\n`, 0o600);
    return entry;
  }
}

/** Whether a model name (an alias or an id) is one of the listed options; case does not matter. */
export function offers(models: readonly ModelOption[], model: string): boolean {
  // `claude-opus-5-5[1m]` is the 1M-context variant of `claude-opus-5-5`: either names the same model
  const bare = (name: string): string => name.toLowerCase().replace(/\[[^\]]*\]$/, '');
  const wanted = bare(model);
  return models.some((m) => [m.value, m.resolvedModel, ...(m.ids ?? [])].some((name) => !!name && bare(name) === wanted));
}
