/**
 * What the machine's figures say, computed from the API's two readings and kept apart from React so
 * the Home widget and the Machine page word the same verdicts and a test can hold them to the plan
 * (docs/plans/resource-control.md).
 */
import type { PressureReading, ProcessUsageReport, SystemLoad, SystemSample } from '@claudio/shared';
import { usageTone, type UsageTone } from '@claudio/ui/components/motion';

/** Memory pressure below this share of the last 10 s is calm; it is not yet worth a colour. */
export const PRESSURE_CALM_BELOW = 10;

export type PressureLevel = 'ok' | 'warn' | 'bad';

/**
 * Calm below 10 %, rising up to the point where Claudio stops starting chats, high from there. The
 * admission threshold comes from the server, so a changed `CLAUDIO_ADMIT_MEMORY_PRESSURE` moves it.
 */
export function pressureLevel(some10: number, admitAt: number): PressureLevel {
  if (some10 >= admitAt) return 'bad';
  if (some10 >= PRESSURE_CALM_BELOW) return 'warn';
  return 'ok';
}

export interface MemoryReading {
  availableMb: number;
  totalMb: number;
  /** Share of memory in use, 0 to 100 */
  usedPercent: number;
  tone: UsageTone;
}

export function memoryReading(memory: SystemLoad['memory']): MemoryReading | null {
  if (!memory || memory.totalMb <= 0) return null;
  const usedPercent = Math.max(0, Math.min(100, ((memory.totalMb - memory.availableMb) / memory.totalMb) * 100));
  return { availableMb: memory.availableMb, totalMb: memory.totalMb, usedPercent, tone: usageTone(usedPercent) };
}

/** Why no chat starts, as the figure that decided it; the server's own sentence stays on the API. */
export type RefusalCause = { kind: 'memory'; availableMb: number; floorMb: number } | { kind: 'pressure'; some10: number; admitAt: number };

export interface MachineReading {
  /** Nothing at all is exposed (no `/proc`): the card says so and draws no verdict */
  exposed: boolean;
  memory: MemoryReading | null;
  pressure: { some10: number; level: PressureLevel } | null;
  admitting: boolean;
  cause: RefusalCause | null;
  /** `null` while the process report is unknown */
  chats: { count: number; rssMb: number | null } | null;
}

export function machineReading(load: SystemLoad, usage: ProcessUsageReport | undefined): MachineReading {
  const memory = memoryReading(load.memory);
  const p: PressureReading | null = load.pressure.memory;
  const pressure = p ? { some10: p.some10, level: pressureLevel(p.some10, load.limits.memoryPressure) } : null;
  let cause: RefusalCause | null = null;
  if (!load.admitting) {
    // The same order the server decides in: the floor first, then the pressure
    if (load.memory && load.memory.availableMb < load.limits.memoryFloorMb) {
      cause = { kind: 'memory', availableMb: load.memory.availableMb, floorMb: load.limits.memoryFloorMb };
    } else if (p) {
      cause = { kind: 'pressure', some10: p.some10, admitAt: load.limits.memoryPressure };
    }
  }
  return {
    exposed: memory !== null || pressure !== null || load.loadavg !== null,
    memory,
    pressure,
    admitting: load.admitting,
    cause,
    chats: usage ? { count: usage.chats.length, rssMb: usage.rssMb } : null,
  };
}

// ---------- history ----------

export type MachineRange = '1h' | '6h' | '24h' | '7d';
export const MACHINE_RANGES: readonly MachineRange[] = ['1h', '6h', '24h', '7d'];

const RANGE_MS: Record<MachineRange, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 };
export const rangeMs = (range: MachineRange): number => RANGE_MS[range];

/** The server stores one reading a minute; a chart has no use for more than about 300 points. */
export const SAMPLE_SECONDS = 60;
const MAX_POINTS = 300;

/** Seconds per point for a range: a whole number of minutes, so a point is never finer than a reading. */
export function bucketFor(range: MachineRange): number {
  return Math.max(SAMPLE_SECONDS, Math.ceil(RANGE_MS[range] / 1000 / MAX_POINTS / SAMPLE_SECONDS) * SAMPLE_SECONDS);
}

export interface ChartPoint {
  t: number;
  v: number | null;
}

/** One figure of the samples as a series; a sample the kernel left blank is a null, which breaks the line. */
export function pointsOf(samples: readonly SystemSample[], pick: (sample: SystemSample) => number | null): ChartPoint[] {
  return samples.flatMap((sample): ChartPoint[] => {
    const t = Date.parse(sample.at);
    return Number.isFinite(t) ? [{ t, v: pick(sample) }] : [];
  });
}

/** Memory in use, as a share of the total, 0 to 100. */
export const memoryUsedPercent = (sample: SystemSample): number | null =>
  sample.totalMb && sample.availableMb !== null ? Math.max(0, Math.min(100, ((sample.totalMb - sample.availableMb) / sample.totalMb) * 100)) : null;

/** A top for the y axis that holds the data and the reference line, in steps a person reads (10, 25, 50, 100…). */
export function niceMax(peak: number, floor: number): number {
  const wanted = Math.max(peak, floor);
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  return steps.find((step) => step >= wanted) ?? Math.ceil(wanted / 1000) * 1000;
}

export interface ChartFrame {
  from: number;
  to: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  yMax: number;
}

export const chartX = (frame: ChartFrame, t: number): number =>
  frame.left + ((t - frame.from) / Math.max(1, frame.to - frame.from)) * (frame.width - frame.left - frame.right);

export const chartY = (frame: ChartFrame, v: number): number =>
  frame.top + (1 - Math.min(frame.yMax, Math.max(0, v)) / frame.yMax) * (frame.height - frame.top - frame.bottom);

// design-lint-ok: SVG path coordinates, never shown as a number
const fixed = (n: number) => Number(n.toFixed(1));

/** The path of a series: lifted at a null and across a silence longer than `gapMs` (the server was off). */
export function chartPath(points: readonly ChartPoint[], frame: ChartFrame, gapMs: number): string {
  const parts: string[] = [];
  let previous: ChartPoint | null = null;
  for (const point of points) {
    if (point.v === null || point.t < frame.from || point.t > frame.to) {
      previous = null;
      continue;
    }
    const command = previous && point.t - previous.t <= gapMs ? 'L' : 'M';
    parts.push(`${command}${fixed(chartX(frame, point.t))} ${fixed(chartY(frame, point.v))}`);
    previous = point;
  }
  return parts.join(' ');
}

/** The largest value of a series, 0 when it has none. */
export const peakOf = (points: readonly ChartPoint[]): number => points.reduce((peak, p) => (p.v !== null && p.v > peak ? p.v : peak), 0);
