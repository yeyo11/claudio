import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProcessEntry } from '../src/processes.ts';
import { DEFAULT_ADMISSION, RESOURCE_REFUSAL_PREFIX, admissionLimitsFrom, chatProcessUsage, memoryRefusal, parseCpuSeconds, parseMeminfo, parsePressure, parseRssMb, readSystemLoad } from '../src/system-load.ts';
import { DEFAULT_TASK_MAX_MINUTES, defaultMaxMinutes, effectiveLimits } from '../src/task-limits.ts';

// A fake /proc: the same files, in a folder the test owns, so each reading is what the kernel
// would have said and nothing else is in the way.
function fakeProc(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentry-proc-'));
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const MEMINFO = 'MemTotal:       65536000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n';
const PSI_IDLE = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';

test('pressure is read from the some and full lines of a PSI file, and cpu has no full line', () => {
  assert.deepEqual(parsePressure('some avg10=12.50 avg60=3.00 avg300=1.00 total=9\nfull avg10=4.25 avg60=0 avg300=0 total=1\n'), { some10: 12.5, full10: 4.25 });
  // cpu reports only `some`: its full10 is zero, not unknown, because the kernel never stalls the whole box on cpu
  assert.deepEqual(parsePressure('some avg10=7.00 avg60=0 avg300=0 total=1\n'), { some10: 7, full10: 0 });
  assert.equal(parsePressure(''), null);
});

test('memory is read in MB from MemTotal and MemAvailable, and a missing figure is null rather than zero', () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { totalMb: 64000, availableMb: 8000 });
  assert.equal(parseMeminfo('MemTotal: 1000 kB\n'), null);
});

test('a machine that exposes nothing reads as nulls and admits chats, as it did before it was measured', () => {
  const load = readSystemLoad(DEFAULT_ADMISSION, join(tmpdir(), 'agentry-no-proc-does-not-exist'));
  assert.equal(load.loadavg, null);
  assert.equal(load.memory, null);
  assert.deepEqual(load.pressure, { cpu: null, memory: null, io: null });
  assert.equal(load.admitting, true);
  assert.equal(load.refusal, null);
});

test('a chat is refused while memory is below the floor, and the refusal names the figure', () => {
  const root = fakeProc({
    loadavg: '0.10 0.20 0.30 1/100 1234\n',
    meminfo: 'MemTotal:       4096000 kB\nMemAvailable:     1024000 kB\n',
    'pressure/cpu': PSI_IDLE,
    'pressure/memory': PSI_IDLE,
    'pressure/io': PSI_IDLE,
  });
  const load = readSystemLoad({ memoryPressure: 20, memoryFloorMb: 2048 }, root);
  assert.equal(load.admitting, false);
  assert.ok(load.refusal?.startsWith(RESOURCE_REFUSAL_PREFIX), 'the refusal starts with the prefix the orchestrator waits on');
  assert.match(load.refusal ?? '', /1000 MB available/);
});

test('a chat is refused while memory pressure is at or above the threshold, and admitted just under it', () => {
  const pressure = (some10: number) => ({ some10, full10: 0 });
  assert.match(memoryRefusal({ totalMb: 1, availableMb: 99999 }, pressure(20), DEFAULT_ADMISSION) ?? '', /memory pressure is 20\.0 %/);
  assert.equal(memoryRefusal({ totalMb: 1, availableMb: 99999 }, pressure(19.9), DEFAULT_ADMISSION), null);
});

test('cpu pressure never refuses a chat: it only slows the work down', () => {
  const root = fakeProc({
    loadavg: '90.00 80.00 70.00 1/100 1234\n',
    meminfo: MEMINFO,
    'pressure/cpu': 'some avg10=95.00 avg60=0 avg300=0 total=1\n',
    'pressure/memory': PSI_IDLE,
    'pressure/io': PSI_IDLE,
  });
  assert.equal(readSystemLoad(DEFAULT_ADMISSION, root).admitting, true);
});

test('admission limits come from the environment, and an unusable value keeps the default', () => {
  assert.deepEqual(admissionLimitsFrom({}), DEFAULT_ADMISSION);
  assert.deepEqual(admissionLimitsFrom({ CLAUDIO_ADMIT_MEMORY_PRESSURE: '35', CLAUDIO_ADMIT_MEMORY_FLOOR_MB: '4096' }), { memoryPressure: 35, memoryFloorMb: 4096 });
  assert.deepEqual(admissionLimitsFrom({ CLAUDIO_ADMIT_MEMORY_PRESSURE: 'soon', CLAUDIO_ADMIT_MEMORY_FLOOR_MB: '-1' }), DEFAULT_ADMISSION);
});

test('a task with no time limit of its own gets the server default, and 0 turns the default off', () => {
  assert.equal(defaultMaxMinutes({}), DEFAULT_TASK_MAX_MINUTES);
  assert.equal(defaultMaxMinutes({ CLAUDIO_TASK_MAX_MINUTES: '45' }), 45);
  assert.equal(defaultMaxMinutes({ CLAUDIO_TASK_MAX_MINUTES: '0' }), null);
  assert.equal(defaultMaxMinutes({ CLAUDIO_TASK_MAX_MINUTES: 'never' }), DEFAULT_TASK_MAX_MINUTES);
  // A limit the graph or the task names always wins over the server default
  assert.deepEqual(effectiveLimits({ maxMinutes: 30 }, undefined), { maxMinutes: 30 });
});

test('a process\'s resident memory is read in MB from its status, and absent where the kernel says nothing', () => {
  assert.equal(parseRssMb('Name:\tnode\nVmRSS:\t  204800 kB\nThreads:\t9\n'), 200);
  assert.equal(parseRssMb('Name:\tkworker\n'), null);
});

test('CPU seconds are user plus system ticks, read after the command name even when the name holds spaces and parentheses', () => {
  // Field 14 (utime) and 15 (stime) of stat are 300 and 100 ticks: 4 seconds at 100 ticks a second
  const stat = '4242 (my (odd) name) S 1 4242 4242 0 -1 4194560 100 0 0 0 300 100 0 0 20 0 1 0 77 1 1 0';
  assert.equal(parseCpuSeconds(stat), 4);
});

test('a chat\'s tree sums its members, and one member the kernel cannot describe makes the total null', () => {
  const root = fakeProc({
    '100/status': 'VmRSS:\t1048576 kB\n',
    '100/stat': '100 (claude) S 1 100 100 0 -1 0 0 0 0 0 200 0 0 0 20 0 1 0 1 1 1',
    '101/status': 'VmRSS:\t524288 kB\n',
    '101/stat': '101 (npm) S 100 101 101 0 -1 0 0 0 0 0 50 50 0 0 20 0 1 0 2 1 1',
  });
  const table: ProcessEntry[] = [
    { pid: 100, ppid: 1, started: 1, argv: ['claude'] },
    { pid: 101, ppid: 100, started: 2, argv: ['npm', 'test'] },
    { pid: 102, ppid: 101, started: 3, argv: ['vitest'] },
  ];
  // 102 has no files in the fake /proc: it exited between the table and the reading
  const [usage] = chatProcessUsage([{ chatId: 'chat-1', pid: 100 }], table, root);
  assert.deepEqual(usage, { chatId: 'chat-1', pid: 100, processes: 3, rssMb: null, cpuSeconds: null });

  const whole = chatProcessUsage([{ chatId: 'chat-2', pid: 100 }], table.slice(0, 2), root);
  assert.deepEqual(whole, [{ chatId: 'chat-2', pid: 100, processes: 2, rssMb: 1536, cpuSeconds: 3 }]);
});

test('the reading repeats the limits it judged by, so a screen can draw the point where no chat starts', () => {
  const limits = { memoryPressure: 12, memoryFloorMb: 512 };
  assert.deepEqual(readSystemLoad(limits, join(tmpdir(), 'agentry-no-proc-does-not-exist')).limits, limits);
});
