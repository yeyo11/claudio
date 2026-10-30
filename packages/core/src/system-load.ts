import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { ChatProcessUsage, PressureReading, SystemLoad } from '@claudio/shared';
import { descendantsOf, type ProcessEntry } from './processes.ts';

/** The limits a new chat is admitted under. Memory is the one that refuses: CPU saturation only slows work down, memory exhaustion kills it. */
export interface AdmissionLimits {
  /** Refuse while the memory pressure's `some10` is at or above this, in percent */
  memoryPressure: number;
  /** Refuse while less than this many MB of memory is available */
  memoryFloorMb: number;
}

export const DEFAULT_ADMISSION: AdmissionLimits = { memoryPressure: 20, memoryFloorMb: 2048 };

/** Reads the admission limits from the environment; an unset or unusable value keeps the default. */
export function admissionLimitsFrom(env: NodeJS.ProcessEnv = process.env): AdmissionLimits {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    memoryPressure: number('CLAUDIO_ADMIT_MEMORY_PRESSURE', DEFAULT_ADMISSION.memoryPressure),
    memoryFloorMb: number('CLAUDIO_ADMIT_MEMORY_FLOOR_MB', DEFAULT_ADMISSION.memoryFloorMb),
  };
}

/** The words of a refusal for lack of memory; callers tell it by its class, `MemoryRefusal`. */
export const RESOURCE_REFUSAL_PREFIX = 'Not enough memory to start a chat';

/**
 * A PSI file: `some avg10=1.23 avg60=… avg300=… total=…`, and a `full` line where the kernel has one
 * (not for cpu's `some` alone). `full10` is 0 where there is no `full` line, which is the truth for cpu.
 */
export function parsePressure(text: string): PressureReading | null {
  let some: number | null = null;
  let full = 0;
  for (const line of text.split('\n')) {
    const kind = line.split(' ')[0];
    const avg10 = Number(/avg10=([\d.]+)/.exec(line)?.[1]);
    if (!Number.isFinite(avg10)) continue;
    if (kind === 'some') some = avg10;
    else if (kind === 'full') full = avg10;
  }
  return some === null ? null : { some10: some, full10: full };
}

/** The pressure of one resource, or null where `/proc/pressure` does not exist (no PSI in this kernel). */
function pressureOf(root: string, resource: 'cpu' | 'memory' | 'io'): PressureReading | null {
  try {
    return parsePressure(readFileSync(join(root, 'pressure', resource), 'utf8'));
  } catch {
    return null;
  }
}

/** MemTotal and MemAvailable from `meminfo`, in MB; null when either is missing. */
export function parseMeminfo(text: string): { totalMb: number; availableMb: number } | null {
  const kb = (key: string): number | null => {
    const value = Number(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text)?.[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total === null || available === null) return null;
  return { totalMb: Math.round(total / 1024), availableMb: Math.round(available / 1024) };
}

/**
 * The machine as the kernel reports it now. `root` is `/proc` in production; a test points it at a
 * folder holding the same files. Without a `/proc` (macOS, Windows) every reading is null and the
 * machine admits chats as it did before this was measured.
 */
export function readSystemLoad(limits: AdmissionLimits = DEFAULT_ADMISSION, root = '/proc'): SystemLoad {
  const cores = availableParallelism();
  let loadavg: SystemLoad['loadavg'] = null;
  try {
    const [one, five, fifteen] = readFileSync(join(root, 'loadavg'), 'utf8').split(' ').map(Number);
    if (one !== undefined && five !== undefined && fifteen !== undefined && [one, five, fifteen].every(Number.isFinite)) {
      loadavg = [one, five, fifteen];
    }
  } catch {
    // no load file: reported as null
  }
  let memory: SystemLoad['memory'] = null;
  try {
    memory = parseMeminfo(readFileSync(join(root, 'meminfo'), 'utf8'));
  } catch {
    // no meminfo: reported as null
  }
  const pressure = { cpu: pressureOf(root, 'cpu'), memory: pressureOf(root, 'memory'), io: pressureOf(root, 'io') };
  const refusal = memoryRefusal(memory, pressure.memory, limits);
  return { cores, loadavg, memory, pressure, admitting: refusal === null, refusal, limits: { ...limits } };
}

/** Why no chat may start for lack of memory, or null when one may. Unknown memory admits: refusing on a guess would stop a machine that is fine. */
export function memoryRefusal(
  memory: SystemLoad['memory'],
  pressure: PressureReading | null,
  limits: AdmissionLimits,
): string | null {
  if (memory && memory.availableMb < limits.memoryFloorMb) {
    return `${RESOURCE_REFUSAL_PREFIX}: ${String(memory.availableMb)} MB available, below the ${String(limits.memoryFloorMb)} MB floor`;
  }
  if (pressure && pressure.some10 >= limits.memoryPressure) {
    return `${RESOURCE_REFUSAL_PREFIX}: memory pressure is ${pressure.some10.toFixed(1)} %, at or above ${String(limits.memoryPressure)} %`;
  }
  return null;
}

/** Resident memory in MB from a `/proc/<pid>/status`; null when the kernel does not say (a kernel thread, or a process that exited). */
export function parseRssMb(status: string): number | null {
  const kb = Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1]);
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
}

/**
 * CPU seconds a process has used (user plus system) from its `/proc/<pid>/stat`. The command name is
 * in parentheses and may hold spaces, so the fields are read after the last `)`: utime and stime are
 * the 14th and 15th fields, which are the 12th and 13th after the state.
 */
export function parseCpuSeconds(stat: string, ticksPerSecond = 100): number | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[11]) + Number(fields[12]);
  return Number.isFinite(ticks) ? ticks / ticksPerSecond : null;
}

/**
 * What each live chat's process tree uses. The tree is the one the process table already holds, so
 * a process started after the table was read is not counted until the next reading.
 */
export function chatProcessUsage(
  chats: ReadonlyArray<{ chatId: string; pid: number }>,
  table: readonly ProcessEntry[],
  root = '/proc',
): ChatProcessUsage[] {
  return chats.map(({ chatId, pid }) => {
    const members = [pid, ...descendantsOf(table, pid).map((p) => p.pid)];
    let rss: number | null = 0;
    let cpu: number | null = 0;
    for (const member of members) {
      const rssMb = readRss(root, member);
      const cpuSeconds = readCpu(root, member);
      // One member the kernel will not describe makes the total a lower bound, not a total: say so with null
      rss = rss === null || rssMb === null ? null : rss + rssMb;
      cpu = cpu === null || cpuSeconds === null ? null : cpu + cpuSeconds;
    }
    return { chatId, pid, processes: members.length, rssMb: rss, cpuSeconds: cpu };
  });
}

function readRss(root: string, pid: number): number | null {
  try {
    return parseRssMb(readFileSync(join(root, String(pid), 'status'), 'utf8'));
  } catch {
    return null;
  }
}

function readCpu(root: string, pid: number): number | null {
  try {
    return parseCpuSeconds(readFileSync(join(root, String(pid), 'stat'), 'utf8'));
  } catch {
    return null;
  }
}
