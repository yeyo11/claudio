import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_GUARD_SETTINGS,
  MAX_PROTECTED_CONFIGS,
  type GuardMode,
  type GuardOverride,
  type GuardSettings,
  type GuardSwitchableRuleId,
  type UpdateGuardSettingsRequest,
} from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import { withoutPaths, type SettingPath } from '../config/setting-paths.ts';

/** The switchable rules, from the defaults, so a new rule needs no second list here. */
export const SWITCHABLE_RULE_IDS = Object.keys(DEFAULT_GUARD_SETTINGS.rules) as GuardSwitchableRuleId[];

const MODES: readonly GuardMode[] = ['enforce', 'observe'];
const MAX_EXTRA_ROOTS = 50;
const MAX_GLOB_LENGTH = 300;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Fresh copy, so a caller can never change the shared defaults. */
export function defaultGuardSettings(): GuardSettings {
  return {
    mode: DEFAULT_GUARD_SETTINGS.mode,
    automated: DEFAULT_GUARD_SETTINGS.automated,
    rules: { ...DEFAULT_GUARD_SETTINGS.rules },
    protectConfigs: [...DEFAULT_GUARD_SETTINGS.protectConfigs],
    extraRoots: [...DEFAULT_GUARD_SETTINGS.extraRoots],
  };
}

export function parseGuardMode(value: unknown): GuardMode {
  if (typeof value !== 'string' || !(MODES as readonly string[]).includes(value)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  return value as GuardMode;
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  return value;
}

/** Rule switches. An unknown key is refused; `integrity` is one, since nobody can switch it off. */
export function parseRuleSwitches(value: unknown, name = 'rules'): Partial<Record<GuardSwitchableRuleId, boolean>> {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const out: Partial<Record<GuardSwitchableRuleId, boolean>> = {};
  for (const [key, on] of Object.entries(value)) {
    if (!(SWITCHABLE_RULE_IDS as string[]).includes(key)) throw new Error(`${name}.${key} is not a rule that can be switched; known are ${SWITCHABLE_RULE_IDS.join(', ')}`);
    out[key as GuardSwitchableRuleId] = parseBoolean(on, `${name}.${key}`);
  }
  return out;
}

/** A graph's or a stage's override: only `enabled` and `rules`; anything else, `integrity` included, is refused. */
export function parseGuardOverride(value: unknown, name = 'guards'): GuardOverride {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const unknownKeys = Object.keys(value).filter((key) => key !== 'enabled' && key !== 'rules');
  if (unknownKeys.length) throw new Error(`${name}: unknown keys ${unknownKeys.join(', ')}; known are enabled, rules`);
  const out: GuardOverride = {};
  if (value.enabled !== undefined) out.enabled = parseBoolean(value.enabled, `${name}.enabled`);
  if (value.rules !== undefined) out.rules = parseRuleSwitches(value.rules, `${name}.rules`);
  return out;
}

function parseProtectConfigs(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('protectConfigs must be an array of globs');
  if (value.length > MAX_PROTECTED_CONFIGS) throw new Error(`protectConfigs has more than ${MAX_PROTECTED_CONFIGS} entries`);
  const globs = value.map((glob) => {
    if (typeof glob !== 'string') throw new Error('protectConfigs must be an array of globs');
    const text = glob.trim();
    if (!text) throw new Error('protectConfigs: a glob cannot be empty');
    if (text.length > MAX_GLOB_LENGTH) throw new Error(`protectConfigs: a glob is longer than ${MAX_GLOB_LENGTH} characters`);
    if (/[\0\n\r]/.test(text)) throw new Error('protectConfigs: a glob cannot hold a newline or NUL');
    if (isAbsolute(text) || text.startsWith('/') || /^[a-z]:[\\/]/i.test(text)) throw new Error(`protectConfigs: '${text}' must be relative to a root, not absolute`);
    if (text.split(/[\\/]/).includes('..')) throw new Error(`protectConfigs: '${text}' cannot hold '..'`);
    return text;
  });
  return [...new Set(globs)];
}

function parseExtraRoots(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('extraRoots must be an array of absolute directories');
  if (value.length > MAX_EXTRA_ROOTS) throw new Error(`extraRoots has more than ${MAX_EXTRA_ROOTS} entries`);
  const roots = value.map((root) => {
    if (typeof root !== 'string') throw new Error('extraRoots must be an array of absolute directories');
    const text = root.trim();
    if (!isAbsolute(text)) throw new Error(`extraRoots: '${text}' must be an absolute directory`);
    if (/[\0\n\r]/.test(text)) throw new Error('extraRoots: a path cannot hold a newline or NUL');
    if (text.split(/[\\/]/).includes('..')) throw new Error(`extraRoots: '${text}' cannot hold '..'`);
    const trimmed = text.replace(/[\\/]+$/, '');
    // A filesystem root would make `destructive` allow everything
    if (trimmed === '' || /^[a-z]:$/i.test(trimmed)) throw new Error('extraRoots: the filesystem root cannot be a root for the guard');
    return trimmed;
  });
  return [...new Set(roots)];
}

/** Checks the keys of a `PUT` body; the whole body is refused when one is bad. */
export function parseGuardSettingsUpdate(input: unknown): UpdateGuardSettingsRequest {
  if (!isObject(input)) throw new Error('guard settings must be a JSON object');
  const known = ['mode', 'automated', 'rules', 'protectConfigs', 'extraRoots'];
  const unknownKeys = Object.keys(input).filter((key) => !known.includes(key));
  if (unknownKeys.length) throw new Error(`unknown guard settings: ${unknownKeys.join(', ')}; known are ${known.join(', ')}`);
  const out: UpdateGuardSettingsRequest = {};
  if (input.mode !== undefined) out.mode = parseGuardMode(input.mode);
  if (input.automated !== undefined) out.automated = parseBoolean(input.automated, 'automated');
  if (input.rules !== undefined) out.rules = parseRuleSwitches(input.rules);
  if (input.protectConfigs !== undefined) out.protectConfigs = parseProtectConfigs(input.protectConfigs);
  if (input.extraRoots !== undefined) out.extraRoots = parseExtraRoots(input.extraRoots);
  return out;
}

function apply(base: GuardSettings, update: UpdateGuardSettingsRequest): GuardSettings {
  return {
    mode: update.mode ?? base.mode,
    automated: update.automated ?? base.automated,
    rules: { ...base.rules, ...update.rules },
    protectConfigs: [...(update.protectConfigs ?? base.protectConfigs)],
    extraRoots: [...(update.extraRoots ?? base.extraRoots)],
  };
}

/**
 * What a stored document is worth: each key a `PUT` would refuse is dropped and the default stands
 * in for it, and unknown keys are dropped. The defaults are on, so a hand-edited file can only
 * lose a setting to the safe value.
 */
function sanitize(raw: unknown): GuardSettings {
  let settings = defaultGuardSettings();
  if (!isObject(raw)) return settings;
  const keep = (parse: () => UpdateGuardSettingsRequest) => {
    try {
      settings = apply(settings, parse());
    } catch {
      // Dropped: the default stands in for it
    }
  };
  if (raw.mode !== undefined) keep(() => ({ mode: parseGuardMode(raw.mode) }));
  if (raw.automated !== undefined) keep(() => ({ automated: parseBoolean(raw.automated, 'automated') }));
  if (isObject(raw.rules)) {
    // Per rule, so one bad switch does not take the others with it
    for (const [key, on] of Object.entries(raw.rules)) keep(() => ({ rules: parseRuleSwitches({ [key]: on }) }));
  }
  if (raw.protectConfigs !== undefined) keep(() => ({ protectConfigs: parseProtectConfigs(raw.protectConfigs) }));
  if (raw.extraRoots !== undefined) keep(() => ({ extraRoots: parseExtraRoots(raw.extraRoots) }));
  return settings;
}

export interface GuardSettingsDeps {
  /** Told after a write, with the new document (the `guards.changed` event) */
  onChange?: (settings: GuardSettings) => void;
}

/**
 * `guards.json` in the data directory. There is no environment layer: whoever wants guards off
 * says so in the UI, where it is visible. The file is read once, this store is its only writer, and
 * a file that is not valid JSON gives the defaults (guards on) and refuses every write, so a broken
 * file can never weaken anything and a write never overwrites what the person meant to keep.
 */
export class GuardSettingsStore {
  readonly file: string;
  private current: GuardSettings;
  /** What the file holds, before the defaults fill it in: which keys the person stored */
  private raw: Record<string, unknown> = {};
  /** Why the file could not be read; every write is refused until someone fixes or removes it */
  private readonly broken: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly deps: GuardSettingsDeps = {},
  ) {
    this.file = join(dataDir, 'guards.json');
    this.current = defaultGuardSettings();
    if (existsSync(this.file)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        this.current = sanitize(raw);
        if (isObject(raw)) this.raw = raw;
      } catch {
        this.broken = `${this.file} is not valid JSON; fix or remove it`;
      }
    }
  }

  /** A copy: the caller cannot change what the store holds. */
  get(): GuardSettings {
    return apply(this.current, {});
  }

  /** Null when the file reads fine, else why writes are refused. */
  get problem(): string | null {
    return this.broken;
  }

  /** Changes only what the body names; `rules` merges over the stored ones. The whole body is checked first. */
  async update(input: unknown): Promise<GuardSettings> {
    const update = parseGuardSettingsUpdate(input);
    if (this.broken) throw new Error(this.broken);
    if (!Object.keys(update).length) return this.get();
    // Chained, so two writes land in the order they were made and each builds on the one before
    const write = this.writing.then(async () => {
      const next = apply(this.current, update);
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.current = next;
      this.raw = structuredClone(next) as unknown as Record<string, unknown>;
    });
    this.writing = write.catch(() => undefined);
    await write;
    const settings = this.get();
    this.deps.onChange?.(settings);
    return settings;
  }

  /** The document as stored, before the defaults fill it in; empty when there is no file */
  stored(): Record<string, unknown> {
    return structuredClone(this.raw);
  }

  /**
   * Removes the values at `paths` (`['mode']`, `['rules', 'push']`), so their defaults apply again.
   * Chained with `update`, and told as `guards.changed` like it.
   */
  async resetKeys(paths: readonly SettingPath[]): Promise<GuardSettings> {
    if (this.broken) throw new Error(this.broken);
    const write = this.writing.then(async () => {
      const raw = withoutPaths(this.raw, paths);
      const settings = sanitize(raw);
      await writeAtomic(this.file, `${JSON.stringify(raw, null, 2)}\n`);
      this.raw = raw;
      this.current = settings;
    });
    this.writing = write.catch(() => undefined);
    await write;
    const settings = this.get();
    this.deps.onChange?.(settings);
    return settings;
  }
}

