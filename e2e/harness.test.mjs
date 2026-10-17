// The harness's own test: `node --test e2e/harness.test.mjs` (needs `pnpm build` first, like the suite).
// It runs the real runner against specs that hang, crash or wait for a signal, and proves that no
// Chrome and no server outlives the run. Each run gets its own TMPDIR, so the sandbox, the Chrome
// profile and every process's command line can be told apart from anyone else's browser; the test
// only looks at processes, it never kills by pattern (the runner kills by the PID it started).
// The shard tests run the runner with E2E_SHARD=k/N and E2E_SHARDS=N over probe specs (e2e/shards.test.mjs
// covers the split itself, without a browser).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describePage, networkRecorder } from './driver.mjs';
import { groupAlive, killGroup } from './processes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'run.mjs');
const linux = existsSync('/proc/self/cmdline');
const skip = linux ? false : 'needs /proc to look for leftover processes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PIDs whose command line contains `needle`: the way to see a leftover browser without a pattern kill. */
function processesMatching(needle) {
  const found = [];
  for (const entry of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(needle)) found.push(Number(entry));
    } catch {
      // gone already
    }
  }
  return found;
}
const alive = (pids) => pids.filter((pid) => {
  try {
    // a zombie is a finished process nobody has waited for
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/s, '').startsWith('Z');
  } catch {
    return false;
  }
});

// Four ports per run: a sharded run takes E2E_PORT and the ones after it
const PORTS_PER_RUN = 4;
// E2E_HARNESS_PORT pins the first one, for a machine where only some ports are free to take
let nextPort = Number(process.env.E2E_HARNESS_PORT) || 8900 + (process.pid % 25) * PORTS_PER_RUN * 2;

/**
 * Runs the real runner over one spec, or over `specs` (file name → source). `beforeEnd(ctx)` is
 * called once the spec says it started (a file it writes), while the browser is up.
 */
async function run({ spec, specs: sources = { 'probe.spec.mjs': spec }, env = {}, beforeEnd }) {
  const dir = mkdtempSync(join(resolve(tmpdir()), 'claudio-harness-test-'));
  const tmp = join(dir, 'tmp');
  const specs = join(dir, 'specs');
  mkdirSync(tmp);
  mkdirSync(specs);
  const ready = join(dir, 'ready');
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(specs, name), source.replaceAll('READY', JSON.stringify(ready)));
  const port = nextPort;
  nextPort += PORTS_PER_RUN;
  const child = spawn(process.execPath, [runner], {
    // A shard set for the job that runs this test (CI's matrix) is not the test's to inherit
    env: { ...process.env, E2E_SHARD: '', E2E_SHARDS: '', TMPDIR: tmp, E2E_SPECS_DIR: specs, E2E_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const profiles = () => processesMatching(join(tmp, 'claudio-e2e-chrome-'));
  let during = [];
  if (beforeEnd) {
    // Booting a whole wrapper and a browser takes well over 30 s when CI runs the other suites beside
    // it; what this test is about is what happens after the spec starts, so it waits for that, not
    // for a fast machine
    for (let i = 0; i < 1200 && !existsSync(ready); i++) await sleep(100);
    assert.ok(existsSync(ready), `the spec never started:\n${output}`);
    during = alive(profiles());
    await beforeEnd({ child, output: () => output });
  }
  let giveUp;
  const result = await Promise.race([exited, new Promise((r) => (giveUp = setTimeout(() => r({ code: 'harness-test-timeout' }), 90_000)))]);
  clearTimeout(giveUp);
  if (result.code === 'harness-test-timeout') {
    // The runner itself failed to stop: this is what the test exists to catch, but do not leave it running
    killGroup(child.pid);
    assert.fail(`the runner outlived its limits:\n${output}`);
  }
  const answering = await Promise.all(Array.from({ length: PORTS_PER_RUN }, (_, i) => fetch(`http://127.0.0.1:${port + i}/api/system`).then(() => true, () => false)));
  const survivors = { chrome: alive(profiles()), server: answering.some(Boolean) };
  const sandboxLeft = readdirSync(tmp).filter((e) => e.startsWith('claudio-e2e-') && !e.startsWith('claudio-e2e-chrome-'));
  rmSync(dir, { recursive: true, force: true });
  return { ...result, output, during, survivors, sandboxLeft };
}

const hang = `export default async () => { (await import('node:fs')).writeFileSync(READY, ''); await new Promise(() => {}); };`;

test('killGroup ends a whole process group, and only that one', { skip }, async () => {
  const leader = spawn('sh', ['-c', 'sleep 60 & sleep 60 & wait'], { detached: true, stdio: 'ignore' });
  const bystander = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  await sleep(300);
  assert.ok(groupAlive(leader.pid));
  killGroup(leader.pid, { graceMs: 1000 });
  assert.equal(groupAlive(leader.pid), false);
  assert.ok(groupAlive(bystander.pid), 'a process in another group is left alone');
  killGroup(bystander.pid);
  assert.equal(groupAlive(bystander.pid), false);
  killGroup(undefined);
});

test('a spec that hangs trips its limit and leaves no browser or server behind', { skip }, async () => {
  const r = await run({ spec: hang, beforeEnd: () => {}, env: { E2E_SPEC_TIMEOUT: '2500' } });
  assert.equal(r.code, 1);
  assert.match(r.output, /probe\.spec\.mjs took longer than 2\.5s/);
  assert.ok(r.during.length > 0, 'a Chrome was running while the spec hung');
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
});

test('the run limit stops a run even when every spec is within its own', { skip }, async () => {
  // The run limit counts from the runner's start, the API's boot included, and that boot has taken
  // more than 12 s on a loaded machine: the limit has to leave the spec time to start at all
  const r = await run({ spec: hang, beforeEnd: () => {}, env: { E2E_SPEC_TIMEOUT: '600000', E2E_TIMEOUT: '45000' } });
  assert.equal(r.code, 1);
  assert.match(r.output, /the e2e run exceeded 45s/);
  assert.ok(r.during.length > 0);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} closes the browser and the server`, { skip }, async () => {
    const r = await run({ spec: hang, env: { E2E_SPEC_TIMEOUT: '600000' }, beforeEnd: ({ child }) => child.kill(signal) });
    assert.equal(r.code, code);
    assert.ok(r.during.length > 0);
    assert.deepEqual(r.survivors, { chrome: [], server: false });
    assert.deepEqual(r.sandboxLeft, []);
  });
}

test('an uncaught exception closes the browser and the server', { skip }, async () => {
  const spec = `export default async () => { (await import('node:fs')).writeFileSync(READY, ''); setTimeout(() => { throw new Error('boom'); }, 200); await new Promise(() => {}); };`;
  const r = await run({ spec, env: { E2E_SPEC_TIMEOUT: '600000' }, beforeEnd: () => {} });
  assert.equal(r.code, 1);
  assert.match(r.output, /boom/);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});

test('only a spec that asks for the fake CLI gets it, after every other spec', { skip }, async () => {
  // Each says which CLI the server it talks to detected; the fake one is named first but must run last
  const probe = (name, fake) =>
    `${fake ? 'export const fakeCli = true;\n' : ''}export default async ({ api, fakeCli }) => {` +
    ` const { body } = await api.get('/system?refresh=1');` +
    ` console.log('CLI ${name} ' + JSON.stringify({ path: body.cli.path, version: body.cli.version, context: Boolean(fakeCli) })); };`;
  // One shard: the order and the restart are what a single process does
  const r = await run({ specs: { 'a-fake.spec.mjs': probe('a-fake', true), 'b-real.spec.mjs': probe('b-real', false) }, env: { E2E_SHARDS: '1' } });
  assert.equal(r.code, 0, r.output);
  const seen = [...r.output.matchAll(/^CLI (\S+) (.+)$/gm)].map(([, name, json]) => ({ name, ...JSON.parse(json) }));
  assert.deepEqual(seen.map((s) => s.name), ['b-real', 'a-fake']);
  const [real, fake] = seen;
  assert.equal(fake.path, join(here, 'fake-cli', 'claude'));
  assert.match(fake.version, /-fake$/);
  assert.equal(fake.context, true);
  assert.notEqual(real.path, fake.path);
  assert.equal(real.context, false);
  assert.match(r.output, /restarting the server with the fake CLI/);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});

test('a failing spec still ends the run cleanly', { skip }, async () => {
  const r = await run({ spec: `export default () => { throw new Error('nope'); };` });
  assert.equal(r.code, 1);
  assert.match(r.output, /nope/);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
});

// ---------- peers: the other wrappers of a Collaborators spec ----------

/** A spec with two peers that says where they are, and whether each is a wrapper of its own on loopback-only Collaborators */
const peerProbe = (body = '') =>
  `export const peers = ['ben', 'cleo'];\n` +
  `export default async ({ api, peers, page }) => {` +
  ` const seen = {};` +
  ` for (const [name, peer] of Object.entries(peers)) {` +
  `   const health = await peer.api.get('/health');` +
  `   const collab = await peer.api.get('/collaborators');` +
  `   seen[name] = { port: peer.port, health: health.status, collab: collab.body?.connection, data: peer.dirs.dataDir, own: peer.baseUrl !== api.baseUrl };` +
  ` }` +
  ` await peers.ben.page.goto('/collaborators', 300);` +
  ` seen.at = await page.eval('return location.port');` +
  ` console.log('PEERS ' + JSON.stringify(seen)); ${body} };`;
const peerPorts = (output) => {
  const line = /^PEERS (.+)$/m.exec(output);
  return line ? Object.values(JSON.parse(line[1])).flatMap((p) => (p && typeof p === 'object' ? [p.port] : [])) : [];
};
const answers = (port) => fetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false);

test('a spec that asks for peers gets a wrapper of its own per name, and none outlives the run', { skip }, async () => {
  const r = await run({ specs: { 'peers.spec.mjs': peerProbe() }, env: { E2E_SHARDS: '1' } });
  assert.equal(r.code, 0, r.output);
  const seen = JSON.parse(/^PEERS (.+)$/m.exec(r.output)?.[1] ?? 'null');
  assert.ok(seen, r.output);
  for (const name of ['ben', 'cleo']) {
    assert.equal(seen[name].health, 200);
    assert.equal(seen[name].own, true);
    // Off until a spec turns it on; the environment only says how it binds
    assert.equal(seen[name].collab, 'off');
  }
  assert.notEqual(seen.ben.data, seen.cleo.data);
  assert.notEqual(seen.ben.port, seen.cleo.port);
  assert.equal(seen.at, String(seen.ben.port), "the peer's page is the same tab, on the peer's origin");
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
  for (const port of peerPorts(r.output)) assert.equal(await answers(port), false, `the peer on ${port} was stopped`);
});

test('SIGTERM during a spec with peers stops the peers too', { skip }, async () => {
  const spec = peerProbe(`(await import('node:fs')).writeFileSync(READY, ''); await new Promise(() => {});`);
  let ports = [];
  const r = await run({
    specs: { 'peers.spec.mjs': spec },
    env: { E2E_SHARDS: '1', E2E_SPEC_TIMEOUT: '600000' },
    beforeEnd: async ({ child, output }) => {
      ports = peerPorts(output());
      assert.equal(ports.length, 2, output());
      assert.deepEqual(await Promise.all(ports.map(answers)), [true, true], 'both peers answer while the spec runs');
      child.kill('SIGTERM');
    },
  });
  assert.equal(r.code, 143, r.output);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
  for (const port of ports) assert.equal(await answers(port), false, `the peer on ${port} was stopped`);
});

test("a peer's own tab stays on the peer's origin while the main tab moves, and its console errors fail the spec", { skip }, async () => {
  const tabProbe = (extra) =>
    `export const peers = ['ben'];\n` +
    `export default async ({ page, peers: { ben } }) => {` +
    ` const tab = await ben.openTab();` +
    ` await tab.goto('/collaborators', 300);` +
    ` await tab.eval('window.__kept = true; return true');` +
    ` await page.goto('/', 300);` +
    ` const seen = { tab: await tab.eval('return location.port'), kept: await tab.eval('return window.__kept === true'), main: await page.eval('return location.port') };` +
    ` console.log('TAB ' + JSON.stringify(seen)); ${extra} };`;
  const ok = await run({ specs: { 'tab.spec.mjs': tabProbe('') }, env: { E2E_SHARDS: '1' } });
  assert.equal(ok.code, 0, ok.output);
  const seen = JSON.parse(/^TAB (.+)$/m.exec(ok.output)?.[1] ?? 'null');
  assert.ok(seen, ok.output);
  assert.notEqual(seen.tab, seen.main, "the peer's tab is on the peer's origin, the main tab on the main one");
  assert.equal(seen.kept, true, 'the main tab moving does not reload the peer tab');
  assert.deepEqual(ok.survivors, { chrome: [], server: false });

  const noisy = await run({ specs: { 'tab.spec.mjs': tabProbe(`await tab.eval("console.error('peer tab broke'); return true");`) }, env: { E2E_SHARDS: '1' } });
  assert.equal(noisy.code, 1, noisy.output);
  assert.match(noisy.output, /console errors:[\s\S]*\[ben\] peer tab broke/);
  assert.deepEqual(noisy.survivors, { chrome: [], server: false });
});

// ---------- what a failed wait reports ----------

test('a failed wait names the console errors, the failed requests and what is still open, since the last document only', () => {
  const recorder = networkRecorder();
  recorder.mainFrame = 'main';
  const sent = (requestId, url, type = 'Fetch', frameId = 'main') => recorder.event('Network.requestWillBeSent', { requestId, frameId, type, request: { method: 'GET', url } });
  // The page being left: its requests must not speak for the next one
  sent('old-doc', 'http://h/old', 'Document');
  sent('old-404', 'http://h/old.js', 'Script');
  recorder.event('Network.responseReceived', { requestId: 'old-404', response: { status: 404 } });
  sent('old-stream', 'http://h/api/events', 'EventSource');
  // The new document, from the service worker, and what it asked for
  sent('doc', 'http://h/?project=all', 'Document');
  recorder.event('Network.loadingFailed', { requestId: 'old-stream', errorText: 'net::ERR_ABORTED', canceled: true });
  recorder.event('Network.responseReceived', { requestId: 'doc', response: { status: 200, fromServiceWorker: true } });
  recorder.event('Network.loadingFinished', { requestId: 'doc' });
  sent('chunk', 'http://h/assets/Home-abc.js', 'Script');
  recorder.event('Network.responseReceived', { requestId: 'chunk', response: { status: 404 } });
  recorder.event('Network.loadingFinished', { requestId: 'chunk' });
  sent('refused', 'http://h/api/usage', 'Fetch');
  recorder.event('Network.loadingFailed', { requestId: 'refused', errorText: 'net::ERR_CONNECTION_REFUSED' });
  sent('settings', 'http://h/api/settings/app');
  recorder.event('Network.requestWillBeSentExtraInfo', { requestId: 'settings' });
  sent('queued', 'http://h/api/projects');
  // A subframe's document is not a new page
  sent('frame', 'http://h/frame', 'Document', 'child');
  recorder.event('Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'Failed to load resource: the server responded with a status of 404', url: 'http://h/assets/Home-abc.js' } });
  recorder.event('Log.entryAdded', { entry: { level: 'info', source: 'other', text: 'not worth reporting' } });
  recorder.note('Page.navigate to /x answered net::ERR_ABORTED');

  const report = describePage({
    state: { href: 'http://h/?project=all', readyState: 'complete', title: 'Claudio', worker: 'http://h/sw.js', root: '<div id="root"></div>', body: '' },
    errors: ['TypeError: boom\n    at a (x.js:1)', 'TypeError: boom\n    at a (x.js:1)'],
    network: recorder.snapshot(Date.now()),
  });
  assert.match(report, /^page: http:\/\/h\/\?project=all, readyState complete, title "Claudio", service worker http:\/\/h\/sw\.js$/m);
  assert.match(report, /^#root: <div id="root"><\/div>$/m);
  assert.equal(report.match(/TypeError: boom/g)?.length, 1, 'one line per distinct error');
  assert.match(report, /^ {2}404 GET http:\/\/h\/assets\/Home-abc\.js$/m);
  assert.match(report, /^ {2}net::ERR_CONNECTION_REFUSED GET http:\/\/h\/api\/usage$/m);
  assert.match(report, /^ {2}error \(network\) Failed to load resource: the server responded with a status of 404 http:\/\/h\/assets\/Home-abc\.js$/m);
  assert.match(report, /GET http:\/\/h\/api\/settings\/app \(Fetch, sent, no response, /);
  assert.match(report, /GET http:\/\/h\/api\/projects \(Fetch, not sent, /);
  assert.match(report, /^navigation:\n {2}Page\.navigate to \/x answered net::ERR_ABORTED$/m);
  assert.doesNotMatch(report, /old|api\/events|not worth reporting/, 'the document that was left says nothing');
});

test('a page that does not answer is reported as such, with what the network said', () => {
  const recorder = networkRecorder();
  recorder.event('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch', request: { method: 'GET', url: 'http://h/api/x' } });
  const report = describePage({ state: null, errors: [], network: recorder.snapshot(Date.now()) });
  assert.match(report, /^page: did not answer within 5 s/);
  assert.match(report, /still open:\n {2}GET http:\/\/h\/api\/x \(Fetch, not sent, /);
});

test('a wait that times out reports the page, and a failed assertion the console errors it would have failed on', { skip }, async () => {
  // Six event streams hold every connection Chrome allows one host over HTTP/1.1, so a request
  // made after them waits in the browser and is never sent: what a page starved of connections shows
  const blank =
    `export default async ({ page }) => {` +
    ` await page.goto('/', 300);` +
    ` await page.eval("console.error('the page broke'); await fetch('/api/no-such-route').catch(() => {}); for (let i = 0; i < 6; i++) new EventSource('/api/events?probe=' + i); setTimeout(() => fetch('/api/system?probe=queued').catch(() => {}), 500); return true");` +
    ` await page.waitFor('return false', { timeout: 3000, label: 'what never comes' }); };`;
  const asserted = `export default async ({ page, check }) => { await page.goto('/', 300); await page.eval("console.error('logged before the assertion'); return true"); check(false, 'on purpose'); };`;
  const result = await run({ specs: { 'blank.spec.mjs': blank, 'asserted.spec.mjs': asserted }, env: { E2E_SHARDS: '1' } });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /timed out waiting for: what never comes \(at http:\/\/127\.0\.0\.1:\d+\/\)\n {2}page: http:\/\/127\.0\.0\.1:\d+\/, readyState complete/);
  assert.match(result.output, /#root: <div id="root">/);
  assert.match(result.output, /console errors:\n {4}the page broke/);
  assert.match(result.output, /failed requests:\n(?: {4}.*\n)* {4}404 GET http:\/\/127\.0\.0\.1:\d+\/api\/no-such-route/);
  assert.match(result.output, /GET http:\/\/127\.0\.0\.1:\d+\/api\/events\?probe=0 \(EventSource, 200, /);
  assert.match(result.output, /GET http:\/\/127\.0\.0\.1:\d+\/api\/system\?probe=queued \(Fetch, not sent, /);
  assert.match(result.output, /^ {2}server: GET \/api\/health answered 200 in \d+ ms$/m);
  assert.match(result.output, /assertion failed: on purpose\n {2}console errors:\n {4}logged before the assertion/);
  assert.deepEqual(result.survivors, { chrome: [], server: false });
});

// ---------- shards ----------

/** Probe specs that say they ran; two want the fake CLI and must share a shard */
const probe = (name, { fake = false, fail = false } = {}) =>
  `${fake ? 'export const fakeCli = true;\n' : ''}export default async () => { console.log('RAN ${name} ' + process.pid); ${fail ? `throw new Error('${name} failed on purpose');` : ''} };`;
const probes = {
  'a.spec.mjs': probe('a.spec.mjs'),
  'b.spec.mjs': probe('b.spec.mjs'),
  'c.spec.mjs': probe('c.spec.mjs'),
  'x-fake.spec.mjs': probe('x-fake.spec.mjs', { fake: true }),
  'y-fake.spec.mjs': probe('y-fake.spec.mjs', { fake: true }),
};
const ran = (output) => [...output.matchAll(/^RAN (\S+) (\d+)$/gm)].map(([, name, pid]) => ({ name, pid }));

test('E2E_SHARD=k/N: the shards together run every spec once, the fakeCli specs in one, the same k/N the same specs', { skip }, async () => {
  const count = 3;
  const seen = [];
  for (let k = 1; k <= count; k++) {
    const r = await run({ specs: probes, env: { E2E_SHARD: `${k}/${count}` } });
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(r.survivors, { chrome: [], server: false });
    assert.deepEqual(r.sandboxLeft, []);
    seen.push(ran(r.output).map((x) => x.name));
  }
  const all = seen.flat();
  assert.deepEqual([...all].sort(), Object.keys(probes).sort(), `every spec exactly once: ${JSON.stringify(seen)}`);
  const fakeShards = seen.filter((names) => names.some((n) => n.includes('fake')));
  assert.equal(fakeShards.length, 1, `the fakeCli specs share one shard: ${JSON.stringify(seen)}`);
  assert.deepEqual(fakeShards[0]?.filter((n) => n.includes('fake')), ['x-fake.spec.mjs', 'y-fake.spec.mjs']);
  const again = await run({ specs: probes, env: { E2E_SHARD: `2/${count}` } });
  assert.deepEqual(ran(again.output).map((x) => x.name), seen[1], 'the same shard runs the same specs again');
  assert.deepEqual(again.survivors, { chrome: [], server: false });
});

test('an invalid E2E_SHARD or E2E_SHARDS stops before starting anything', { skip }, async () => {
  for (const env of [{ E2E_SHARD: '4/3' }, { E2E_SHARD: 'x' }, { E2E_SHARDS: '0' }, { E2E_SHARDS: 'two' }]) {
    const r = await run({ specs: probes, env });
    assert.equal(r.code, 2, `${JSON.stringify(env)}\n${r.output}`);
    assert.doesNotMatch(r.output, /^RAN /m);
  }
});

test('E2E_SHARDS=N runs the shards side by side and reports them in the order of one run', { skip }, async () => {
  const specs = { ...probes, 'b.spec.mjs': probe('b.spec.mjs', { fail: true }) };
  const r = await run({ specs, env: { E2E_SHARDS: '3' } });
  assert.equal(r.code, 1, r.output);
  const runs = ran(r.output);
  assert.deepEqual(runs.map((x) => x.name).sort(), Object.keys(specs).sort());
  assert.equal(new Set(runs.map((x) => x.pid)).size, 3, 'three runner processes');
  // The report is in a single run's order: the ordinary specs by name, then the fakeCli ones
  const order = [...r.output.matchAll(/^[✓✗] (\S+\.spec\.mjs)/gm)].map(([, f]) => f);
  assert.deepEqual(order.slice(0, 5), ['a.spec.mjs', 'b.spec.mjs', 'c.spec.mjs', 'x-fake.spec.mjs', 'y-fake.spec.mjs']);
  assert.match(r.output, /✗ b\.spec\.mjs\n  b\.spec\.mjs failed on purpose/);
  assert.match(r.output, /failed:\n✗ b\.spec\.mjs\n1 spec\(s\) failed\s*$/);
  assert.match(r.output, /^shard 3\/3: /m);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
});

test('E2E_SHARDS=1 and a single spec run in this process, with no children', { skip }, async () => {
  for (const [env, specs] of [[{ E2E_SHARDS: '1' }, probes], [{ E2E_SHARDS: '4' }, { 'a.spec.mjs': probes['a.spec.mjs'] }]]) {
    const r = await run({ specs, env });
    assert.equal(r.code, 0, r.output);
    assert.doesNotMatch(r.output, /shards in parallel/);
    assert.equal(new Set(ran(r.output).map((x) => x.pid)).size, 1);
  }
});

test('SIGTERM to a sharded run closes every shard’s browser and server', { skip }, async () => {
  const r = await run({ specs: { 'a.spec.mjs': probes['a.spec.mjs'], 'hang.spec.mjs': hang }, env: { E2E_SHARDS: '2', E2E_SPEC_TIMEOUT: '600000' }, beforeEnd: ({ child }) => child.kill('SIGTERM') });
  assert.equal(r.code, 143, r.output);
  assert.ok(r.during.length > 0);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
});

test('the run limit of a sharded run closes every shard’s browser and server', { skip }, async () => {
  // A spec that hangs in each shard, both within their own limit: only E2E_TIMEOUT in the parent ends them
  const r = await run({ specs: { 'hang-a.spec.mjs': hang, 'hang-b.spec.mjs': hang }, env: { E2E_SHARDS: '2', E2E_SPEC_TIMEOUT: '600000', E2E_TIMEOUT: '30000' }, beforeEnd: () => {} });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /the e2e run exceeded 30s/);
  assert.ok(r.during.length > 0);
  assert.deepEqual(r.survivors, { chrome: [], server: false });
  assert.deepEqual(r.sandboxLeft, []);
});
