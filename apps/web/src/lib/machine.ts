/**
 * What the machine's figures say, computed from the API's two readings and kept apart from React so
 * the Home widget and the Machine page word the same verdicts and a test can hold them to the plan
 * (docs/plans/resource-control.md).
 */
import type { PressureReading, ProcessUsageReport, SystemLoad } from '@claudio/shared';
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
