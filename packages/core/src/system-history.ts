import type { SystemSample } from '@claudio/shared';
import type { Db } from './db.ts';
import { recentProcessTable } from './processes.ts';
import { chatProcessUsage, readSystemLoad, type AdmissionLimits } from './system-load.ts';

/** How often the machine is read: once a minute. A chat's cost shows in that, and 1,440 rows a day stay small. */
export const DEFAULT_SAMPLE_SECONDS = 60;
/** How long a reading is kept: a week, 10,080 rows at the default interval. */
export const DEFAULT_RETENTION_DAYS = 7;

export interface SamplerSettings {
  /** 0 turns the sampler off */
  intervalSeconds: number;
  retentionDays: number;
}

/** `CLAUDIO_MACHINE_SAMPLE_SECONDS` (0 disables) and `CLAUDIO_MACHINE_RETENTION_DAYS`; an unusable value keeps the default. */
export function samplerSettingsFrom(env: NodeJS.ProcessEnv = process.env): SamplerSettings {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const days = number('CLAUDIO_MACHINE_RETENTION_DAYS', DEFAULT_RETENTION_DAYS);
  return { intervalSeconds: number('CLAUDIO_MACHINE_SAMPLE_SECONDS', DEFAULT_SAMPLE_SECONDS), retentionDays: days > 0 ? days : DEFAULT_RETENTION_DAYS };
}

/**
 * Reads the machine on a timer and keeps the readings (`system_samples`) for the Machine page's
 * history. A machine with no `/proc` stores nothing: a row of nulls would only draw an empty chart.
 */
export class SystemSampler {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Immediate | null = null;

  constructor(
    private readonly db: Pick<Db, 'appendSystemSample' | 'pruneSystemSamples'>,
    private readonly chats: () => Array<{ chatId: string; pid: number }>,
    private readonly limits: () => AdmissionLimits,
    private readonly settings: SamplerSettings,
    private readonly root = '/proc',
  ) {}

  start(): void {
    if (this.timer || this.settings.intervalSeconds <= 0) return;
    // On the next turn: a Core starts the sampler while it is still being built, before what it reads exists
    this.first = setImmediate(() => this.sample());
    this.first.unref();
    this.timer = setInterval(() => this.sample(), this.settings.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    // A Core closed before its first turn must not write to a closed database
    if (this.first) clearImmediate(this.first);
    this.timer = null;
    this.first = null;
  }

  /** Reads and stores one sample, then drops what is past the retention. Never throws: a sampler must not take the server down. */
  sample(now: Date = new Date()): SystemSample | null {
    try {
      const load = readSystemLoad(this.limits(), this.root);
      if (load.loadavg === null && load.memory === null && load.pressure.memory === null) return null;
      const usage = chatProcessUsage(this.chats(), recentProcessTable(), this.root);
      const rss = usage.reduce<number | null>((sum, c) => (sum === null || c.rssMb === null ? null : sum + c.rssMb), 0);
      const sample: SystemSample = {
        at: now.toISOString(),
        load1: load.loadavg?.[0] ?? null,
        totalMb: load.memory?.totalMb ?? null,
        availableMb: load.memory?.availableMb ?? null,
        cpuSome10: load.pressure.cpu?.some10 ?? null,
        memorySome10: load.pressure.memory?.some10 ?? null,
        ioSome10: load.pressure.io?.some10 ?? null,
        chats: usage.length,
        rssMb: rss,
        admitting: load.admitting,
      };
      this.db.appendSystemSample(sample);
      this.db.pruneSystemSamples(new Date(now.getTime() - this.settings.retentionDays * 86_400_000).toISOString());
      return sample;
    } catch {
      return null;
    }
  }
}
