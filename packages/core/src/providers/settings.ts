import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LimitAction, ProviderId, ProvidersSettings, RotationSettings } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import { withoutPaths, type SettingPath } from '../config/setting-paths.ts';
import type { CoreConfig } from '../paths.ts';
import { PROVIDER_MANIFESTS } from './registry.ts';
import { isRecord } from '@claudio/shared';


const LIMIT_ACTIONS: readonly LimitAction[] = ['wait'];
const MAX_WAIT_HOURS = 48;

/** A fresh install waits for the reset at a usage limit and spends only the replayed turn. */
export function defaultRotationSettings(): RotationSettings {
  return { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6 } };
}

const integerIn = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
};

const limitAction = (value: unknown, name: string): LimitAction => {
  if (typeof value !== 'string' || !(LIMIT_ACTIONS as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${LIMIT_ACTIONS.join(', ')}`);
  return value as LimitAction;
};

/**
 * The `onLimit` fields a document sets. Global settings fill the rest from the defaults; a project
 * passes only what it overrides, so a missing field stays missing and inherits. `allowed` always
 * contains `action` when both are known here, so the chosen action is never one a decision point
 * could not pick.
 */
export function parseOnLimit(input: unknown, name: string): Partial<RotationSettings['onLimit']> {
  if (!isRecord(input)) throw new Error(`${name} must be an object`);
  const result: Partial<RotationSettings['onLimit']> = {};
  if (input.action !== undefined) result.action = limitAction(input.action, `${name}.action`);
  if (input.allowed !== undefined) {
    if (!Array.isArray(input.allowed) || input.allowed.length === 0) throw new Error(`${name}.allowed must be a non-empty array`);
    const allowed = input.allowed.map((a) => limitAction(a, `${name}.allowed entry`));
    if (new Set(allowed).size !== allowed.length) throw new Error(`${name}.allowed lists an action twice`);
    result.allowed = allowed;
  }
  if (input.maxWaitHours !== undefined) result.maxWaitHours = integerIn(input.maxWaitHours, `${name}.maxWaitHours`, 1, MAX_WAIT_HOURS);
  if (result.action !== undefined && result.allowed !== undefined && !result.allowed.includes(result.action)) {
    result.allowed = [...result.allowed, result.action];
  }
  return result;
}

/** Every provider on, searched for, in registry order, with no default: what an absent file reads as. */
export function defaultProvidersSettings(ids: readonly ProviderId[] = PROVIDER_MANIFESTS.map((m) => m.id)): ProvidersSettings {
  return {
    providers: Object.fromEntries(ids.map((id) => [id, { enabled: true, binaryPath: null }])),
    order: [...ids],
    defaultProvider: null,
    rotation: defaultRotationSettings(),
  };
}

/**
 * `providers.json` in the data directory: which providers are on, their order, the default and a
 * binary of the person's own. Absent until the first save. It is read on every detection, so the
 * parsed document is kept in memory and replaced by `set`.
 */
export class ProvidersSettingsStore {
  private readonly file: string;
  private readonly ids: readonly ProviderId[];
  private cached: ProvidersSettings | null = null;

  constructor(config: Pick<CoreConfig, 'dataDir'>, ids: readonly ProviderId[] = PROVIDER_MANIFESTS.map((m) => m.id)) {
    this.file = join(config.dataDir, 'providers.json');
    this.ids = ids;
    mkdirSync(config.dataDir, { recursive: true });
  }

  get(): ProvidersSettings {
    this.cached ??= this.read();
    return structuredClone(this.cached);
  }

  /** Replaces the document whole, validated; a provider missing from it keeps the defaults */
  async set(input: unknown): Promise<ProvidersSettings> {
    const parsed = this.parse(input);
    await writeAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cached = parsed;
    return this.get();
  }

  /** The document as stored, before the defaults fill it in; null when there is none or it does not parse */
  stored(): Record<string, unknown> | null {
    if (!existsSync(this.file)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return isRecord(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes the values at `paths` from the stored document, so their defaults apply again. The rest
   * is kept as stored, and the result must still parse, so a reset never leaves a document the
   * store would refuse. A document that does not parse is refused rather than overwritten.
   */
  async resetKeys(paths: readonly SettingPath[]): Promise<ProvidersSettings> {
    if (!existsSync(this.file)) return this.get();
    const raw = this.stored();
    if (!raw) throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    const next = withoutPaths(raw, paths);
    const parsed = this.parse(next, true);
    await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    this.cached = parsed;
    return this.get();
  }

  private read(): ProvidersSettings {
    if (!existsSync(this.file)) return defaultProvidersSettings(this.ids);
    try {
      return this.parse(JSON.parse(readFileSync(this.file, 'utf8')), true);
    } catch {
      // A hand edit that went bad reads as the defaults rather than keeping every provider off
      return defaultProvidersSettings(this.ids);
    }
  }

  private known(id: unknown, name: string): ProviderId {
    if (typeof id !== 'string' || !this.ids.includes(id)) throw new Error(`${name} must be one of ${this.ids.join(', ')}`);
    return id;
  }

  /** `lenient` skips ids of providers this build does not know, so a file written by another build still loads */
  private parse(input: unknown, lenient = false): ProvidersSettings {
    if (!isRecord(input)) throw new Error('settings must be an object');
    const result = defaultProvidersSettings(this.ids);

    if (input.providers !== undefined) {
      if (!isRecord(input.providers)) throw new Error('providers must be an object');
      for (const [id, entry] of Object.entries(input.providers)) {
        if (lenient && !this.ids.includes(id)) continue;
        this.known(id, 'providers key');
        if (!isRecord(entry)) throw new Error(`providers.${id} must be an object`);
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`providers.${id}.enabled must be a boolean`);
        const path = entry.binaryPath ?? null;
        if (path !== null && (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))) {
          throw new Error(`providers.${id}.binaryPath must be an absolute path or null`);
        }
        result.providers[id] = { enabled: entry.enabled ?? true, binaryPath: path };
      }
    }

    if (input.order !== undefined) {
      if (!Array.isArray(input.order)) throw new Error('order must be an array');
      const listed = input.order.filter((id) => !lenient || this.ids.includes(id)).map((id) => this.known(id, 'order entry'));
      if (new Set(listed).size !== listed.length) throw new Error('order lists a provider twice');
      // One left out is appended, so a provider added later is still offered
      result.order = [...listed, ...this.ids.filter((id) => !listed.includes(id))];
    }

    if (input.defaultProvider !== undefined && input.defaultProvider !== null && !(lenient && !this.ids.includes(input.defaultProvider as string))) {
      result.defaultProvider = this.known(input.defaultProvider, 'defaultProvider');
    }

    if (input.rotation !== undefined && input.rotation !== null) result.rotation = this.parseRotation(input.rotation);
    return result;
  }

  private parseRotation(input: unknown): RotationSettings {
    if (!isRecord(input)) throw new Error('rotation must be an object');
    const result = defaultRotationSettings();
    if (input.onLimit !== undefined) {
      const onLimit = { ...result.onLimit, ...parseOnLimit(input.onLimit, 'rotation.onLimit') };
      // `allowed` missing from the document but the action widened: keep the action pickable
      if (!onLimit.allowed.includes(onLimit.action)) onLimit.allowed = [...onLimit.allowed, onLimit.action];
      result.onLimit = onLimit;
    }
    return result;
  }
}
