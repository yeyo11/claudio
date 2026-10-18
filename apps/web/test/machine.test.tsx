/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProcessUsageReport, SystemLoad } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { keys } from '../src/api';
import { formatNumber } from '@claudio/ui/lib/format';
import i18n from '../src/i18n';
import { machineReading, pressureLevel } from '../src/lib/machine';
import { MachineWidget } from '../src/pages/dashboard/widgets/machine';

const load = (over: Partial<SystemLoad> = {}): SystemLoad => ({
  cores: 8,
  loadavg: [0.5, 0.4, 0.3],
  memory: { totalMb: 16000, availableMb: 12000 },
  pressure: { cpu: { some10: 1, full10: 0 }, memory: { some10: 2, full10: 0 }, io: null },
  admitting: true,
  refusal: null,
  limits: { memoryPressure: 20, memoryFloorMb: 2048 },
  ...over,
});

const usage = (over: Partial<ProcessUsageReport> = {}): ProcessUsageReport => ({
  chats: [
    { chatId: 'a', pid: 10, processes: 3, rssMb: 700, cpuSeconds: 4 },
    { chatId: 'b', pid: 20, processes: 1, rssMb: 300, cpuSeconds: 1 },
  ],
  processes: 4,
  rssMb: 1000,
  ...over,
});

test('pressure: calm below 10, rising up to the admission limit, high from it', () => {
  assert.equal(pressureLevel(9.9, 20), 'ok');
  assert.equal(pressureLevel(10, 20), 'warn');
  assert.equal(pressureLevel(19.9, 20), 'warn');
  assert.equal(pressureLevel(20, 20), 'bad');
  // The limit is the server's: a lower one moves the verdict
  assert.equal(pressureLevel(12, 12), 'bad');
});

test('memory takes the usage colours: neutral below 60 %, warn from 60, bad from 75', () => {
  const tone = (availableMb: number) => machineReading(load({ memory: { totalMb: 1000, availableMb } }), undefined).memory?.tone;
  assert.equal(tone(500), 'neutral');
  assert.equal(tone(400), 'warn');
  assert.equal(tone(250), 'bad');
  assert.equal(machineReading(load({ memory: { totalMb: 1000, availableMb: 250 } }), undefined).memory?.usedPercent, 75);
});

test('a refusal names the figure that decided it, the floor before the pressure', () => {
  const floor = machineReading(load({ admitting: false, refusal: 'x', memory: { totalMb: 8000, availableMb: 1500 } }), undefined);
  assert.deepEqual(floor.cause, { kind: 'memory', availableMb: 1500, floorMb: 2048 });
  const pressure = machineReading(load({ admitting: false, refusal: 'x', pressure: { cpu: null, memory: { some10: 25, full10: 3 }, io: null } }), undefined);
  assert.deepEqual(pressure.cause, { kind: 'pressure', some10: 25, admitAt: 20 });
  assert.equal(machineReading(load(), undefined).cause, null);
});

test('a machine without /proc exposes nothing; a missing figure is null, not zero', () => {
  const bare = machineReading(load({ loadavg: null, memory: null, pressure: { cpu: null, memory: null, io: null } }), undefined);
  assert.equal(bare.exposed, false);
  assert.equal(bare.memory, null);
  assert.equal(bare.pressure, null);
  assert.equal(machineReading(load({ memory: null }), undefined).exposed, true);
  assert.equal(machineReading(load(), undefined).chats, null, 'chats are unknown until the process report arrives');
  assert.deepEqual(machineReading(load(), usage({ rssMb: null })).chats, { count: 2, rssMb: null });
});

function render(seed: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MachineWidget project={null} size="s" title="Machine" id="w" />
    </QueryClientProvider>,
  );
}

test('the widget: memory bar, pressure, admission and the chats with their memory, each with a word', async () => {
  await i18n.changeLanguage('en');
  const html = render((qc) => {
    qc.setQueryData(keys.systemLoad, load());
    qc.setQueryData(keys.systemProcesses, usage());
  });
  assert.ok(html.includes(`${formatNumber(12000)} MB free`));
  assert.ok(html.includes(`of ${formatNumber(16000)} MB`));
  assert.match(html, /class="meter-fill"[^>]*style="width:25%"/);
  assert.match(html, /Low/);
  assert.match(html, /Admits chats/);
  assert.match(html, /2 chats/);
  assert.ok(html.includes(`${formatNumber(1000)} MB resident`));
});

test('the widget refused: the admission is bad with its cause, and the memory bar stays in view', async () => {
  await i18n.changeLanguage('en');
  const html = render((qc) => {
    qc.setQueryData(keys.systemLoad, load({ admitting: false, refusal: 'x', memory: { totalMb: 8000, availableMb: 1500 } }));
    qc.setQueryData(keys.systemProcesses, usage({ chats: [], processes: 0, rssMb: 0 }));
  });
  assert.match(html, /badge-bad[^>]*>.*No new chats/);
  assert.ok(html.includes(`${formatNumber(1500)} MB free, floor ${formatNumber(2048)} MB`));
  assert.match(html, /meter-fill is-bad/);
  assert.match(html, /None running/);
});

test('the widget on a machine with no figures says so, with no bar and no verdict', async () => {
  await i18n.changeLanguage('en');
  const html = render((qc) => qc.setQueryData(keys.systemLoad, load({ loadavg: null, memory: null, pressure: { cpu: null, memory: null, io: null } })));
  assert.match(html, /does not expose its figures/);
  assert.doesNotMatch(html, /meter-track|badge/);
});

test('the widget shows a dash for the one figure that is missing, and nothing while loading or unreachable', async () => {
  await i18n.changeLanguage('en');
  const dash = render((qc) => {
    qc.setQueryData(keys.systemLoad, load({ pressure: { cpu: null, memory: null, io: null } }));
    qc.setQueryData(keys.systemProcesses, usage());
  });
  assert.match(dash, /meter-track/, 'the memory bar is still there');
  assert.match(dash, /Memory pressure<\/span><span class="machine-figure tnum">—/);
  const loading = render(() => {});
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /badge/);
});

test('the Spanish copy reads from the glossary', async () => {
  await i18n.changeLanguage('es');
  const html = render((qc) => {
    qc.setQueryData(keys.systemLoad, load());
    qc.setQueryData(keys.systemProcesses, usage());
  });
  assert.match(html, /Admite chats/);
  assert.match(html, /MB libres/);
  assert.match(html, /residentes/);
  await i18n.changeLanguage('en');
});
