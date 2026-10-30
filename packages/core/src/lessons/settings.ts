import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EFFORT_LEVELS, isRecord, type Effort, type LessonSettings } from '@claudio/shared';
import { writeAtomic } from '../config/files.ts';
import { withoutPaths, type SettingPath } from '../config/setting-paths.ts';
import type { CoreConfig } from '../paths.ts';
import { WorkItemError } from '../work-item-validation.ts';

/*
 * `lessons.json`: the global settings document (docs/plans/lessons.md, "Settings"). Read with
 * defaults for what is missing; a value out of range is refused with the name of its field.
 */

export const DEFAULT_LESSON_SETTINGS: LessonSettings = {
  // The plan's Q1 answer: a person's click mines a chat even while `lesson.mine` is off
  manualMining: true,
  miner: { model: 'haiku', effort: null, maxCostUsd: 0.05, deadlineSeconds: 120 },
  caps: { perProjectDailyUsd: 0.25, globalDailyUsd: 1, perChatMinMinutes: 30, perProjectDailyJobs: 20 },
  confidence: { approveFloor: 0.8, deliverAt: 0.7, seenStep: 0.05, confirmStep: 0.1, max: 0.95 },
  decay: { graceDays: 60, periodDays: 30, step: 0.1, retireBelow: 0.3 },
  delivery: { handoffBytes: 2048, looseChats: true },
  signals: { repeatedErrorsTrigger: true },
};

const MAX_HANDOFF_BYTES = 4096;

function bad(field: string, rule: string): never {
  throw new WorkItemError(`${field} ${rule}`, 400);
}


function group(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = raw[name];
  if (value === undefined) return {};
  if (!isRecord(value)) return bad(name, 'must be an object');
  return value;
}

function bool(source: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = source[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return bad(field, 'must be true or false');
  return value;
}

function num(source: Record<string, unknown>, field: string, fallback: number, min: number, max: number, integer = false): number {
  const value = source[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    return bad(field, integer ? 'must be a whole number' : 'must be a number');
  }
  if (value < min || value > max) return bad(field, `must be between ${min} and ${max}`);
  return value;
}

/** Merges `raw` over `base` and checks every range; throws a 400 naming the field that is out of range */
export function parseLessonSettings(raw: unknown, base: LessonSettings = DEFAULT_LESSON_SETTINGS): LessonSettings {
  if (!isRecord(raw)) return bad('settings', 'must be an object');
  const d = base;
  const miner = group(raw, 'miner');
  const caps = group(raw, 'caps');
  const confidence = group(raw, 'confidence');
  const decay = group(raw, 'decay');
  const delivery = group(raw, 'delivery');
  const signals = group(raw, 'signals');

  const model = miner.model === undefined ? d.miner.model : miner.model;
  if (typeof model !== 'string' || !model.trim()) bad('model', 'must be a model name');
  let effort: Effort | null = d.miner.effort;
  if (miner.effort !== undefined) {
    if (miner.effort !== null && !(EFFORT_LEVELS as readonly unknown[]).includes(miner.effort)) bad('effort', `must be one of ${EFFORT_LEVELS.join(', ')}`);
    effort = miner.effort as Effort | null;
  }
  const next: LessonSettings = {
    manualMining: bool(raw, 'manualMining', d.manualMining),
    miner: {
      model: (model as string).trim(),
      effort,
      maxCostUsd: num(miner, 'maxCostUsd', d.miner.maxCostUsd, 0.01, 1),
      deadlineSeconds: num(miner, 'deadlineSeconds', d.miner.deadlineSeconds, 10, 600, true),
    },
    caps: {
      perProjectDailyUsd: num(caps, 'perProjectDailyUsd', d.caps.perProjectDailyUsd, 0, 100),
      globalDailyUsd: num(caps, 'globalDailyUsd', d.caps.globalDailyUsd, 0, 1000),
      perChatMinMinutes: num(caps, 'perChatMinMinutes', d.caps.perChatMinMinutes, 0, 1440, true),
      perProjectDailyJobs: num(caps, 'perProjectDailyJobs', d.caps.perProjectDailyJobs, 0, 1000, true),
    },
    confidence: {
      approveFloor: num(confidence, 'approveFloor', d.confidence.approveFloor, 0.3, 0.95),
      deliverAt: num(confidence, 'deliverAt', d.confidence.deliverAt, 0.3, 0.9),
      seenStep: num(confidence, 'seenStep', d.confidence.seenStep, 0, 0.5),
      confirmStep: num(confidence, 'confirmStep', d.confidence.confirmStep, 0, 0.5),
      max: num(confidence, 'max', d.confidence.max, 0.5, 0.95),
    },
    decay: {
      graceDays: num(decay, 'graceDays', d.decay.graceDays, 7, 3650, true),
      periodDays: num(decay, 'periodDays', d.decay.periodDays, 7, 3650, true),
      step: num(decay, 'step', d.decay.step, 0.01, 0.5),
      retireBelow: num(decay, 'retireBelow', d.decay.retireBelow, 0, 0.9),
    },
    delivery: {
      handoffBytes: num(delivery, 'handoffBytes', d.delivery.handoffBytes, 512, MAX_HANDOFF_BYTES, true),
      looseChats: bool(delivery, 'looseChats', d.delivery.looseChats),
    },
    signals: { repeatedErrorsTrigger: bool(signals, 'repeatedErrorsTrigger', d.signals.repeatedErrorsTrigger) },
  };
  if (next.decay.retireBelow >= next.confidence.deliverAt) bad('retireBelow', 'must be below deliverAt');
  if (next.confidence.approveFloor > next.confidence.max) bad('approveFloor', 'must not exceed max');
  return next;
}

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isRecord(value) && isRecord(current) ? mergeDeep(current, value) : value;
  }
  return out;
}

/** Reads and writes `lessons.json` in the data directory */
export class LessonSettingsStore {
  private readonly file: string;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'lessons.json');
  }

  /** What is on disk over the defaults; a document that is missing, unreadable or out of range reads as the defaults */
  async get(): Promise<LessonSettings> {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_LESSON_SETTINGS);
    try {
      return parseLessonSettings(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      return structuredClone(DEFAULT_LESSON_SETTINGS);
    }
  }

  /** Applies a partial update over the current document, validated as a whole */
  update(patch: unknown): Promise<LessonSettings> {
    if (!isRecord(patch)) return Promise.reject(new WorkItemError('settings must be an object', 400));
    return this.chained(async () => {
      const merged = mergeDeep((await this.get()) as unknown as Record<string, unknown>, patch);
      const next = parseLessonSettings(merged);
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  /** The document as stored, before the defaults fill it in; null when there is none or it does not parse */
  async stored(): Promise<Record<string, unknown> | null> {
    if (!existsSync(this.file)) return null;
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      return isRecord(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes the values at `paths`, so their defaults apply again. What is left must still hold
   * together (`retireBelow` under `deliverAt`, say): a reset that would break it is refused with the
   * field, like an update, rather than leave a document that reads as all defaults.
   */
  resetKeys(paths: readonly SettingPath[]): Promise<LessonSettings> {
    return this.chained(async () => {
      const raw = await this.stored();
      if (!raw) {
        if (existsSync(this.file)) throw new WorkItemError(`${this.file} is not valid JSON; fix or remove it`, 409);
        return this.get();
      }
      const next = withoutPaths(raw, paths);
      const parsed = parseLessonSettings(next);
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      return parsed;
    });
  }

  /** One write at a time, each on top of the one before: a reset and a save made together both land */
  private chained<T>(run: () => Promise<T>): Promise<T> {
    const write = this.writing.then(run);
    this.writing = write.catch(() => undefined);
    return write;
  }
}
