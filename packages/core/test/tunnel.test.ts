import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AuthMode, TunnelStatus } from '@claudio/shared';
import { RuntimeHosts } from '../src/app-settings.ts';
import type { ClaudioEventInput } from '../src/events.ts';
import { parseTailscaleVersion, readinessFromStatus, servePortUse, TunnelManager, TunnelRefusedError, type TunnelDeps } from '../src/tunnel.ts';

const FAKE_TAILSCALE = fileURLToPath(new URL('./fixtures/fake-tailscale.mjs', import.meta.url));
const NODE = 'claudio-test.tail0000.ts.net';
const TARGET = 'http://127.0.0.1:8787';

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The node's state as the fake CLI keeps it; any key left out is the fake's default. */
interface FakeNode {
  version?: string;
  daemon?: boolean;
  backendState?: string;
  dnsName?: string;
  magicDNS?: boolean;
  certDomains?: string[];
  operator?: boolean;
  serveDisabled?: boolean;
  delayMs?: number;
  serve?: Record<string, unknown>;
}

interface Rig {
  root: string;
  manager: TunnelManager;
  hosts: RuntimeHosts;
  events: TunnelStatus[];
  audit: string[];
  security: { mode: AuthMode };
  /** Every call the CLI received, as one string per call */
  calls: () => string[];
  node: () => Required<Pick<FakeNode, 'serve'>> & FakeNode;
  setNode: (next: FakeNode) => void;
  record: string;
}

function rig(t: TestContext, options: { mode?: AuthMode; enabled?: boolean; managed?: boolean; tailscaleBin?: string; node?: FakeNode; root?: string; timing?: TunnelDeps['timing']; attach?: boolean } = {}): Rig {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'claudio-tunnel-'));
  const log = join(root, 'tailscale.log');
  const stateFile = join(root, 'node.json');
  if (options.node || !existsSync(stateFile)) writeFileSync(stateFile, JSON.stringify({ serve: {}, ...options.node }));
  // The CLI inherits the environment: set per test, and put back once it is done
  const saved = { state: process.env.FAKE_TAILSCALE_STATE, log: process.env.FAKE_TAILSCALE_LOG };
  process.env.FAKE_TAILSCALE_STATE = stateFile;
  process.env.FAKE_TAILSCALE_LOG = log;
  const hosts = new RuntimeHosts();
  const events: TunnelStatus[] = [];
  const audit: string[] = [];
  const security = { mode: options.mode ?? 'token' };
  const manager = new TunnelManager({
    dataDir: join(root, 'data'),
    tailscaleBin: options.tailscaleBin ?? FAKE_TAILSCALE,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.managed === undefined ? {} : { managed: options.managed }),
    security,
    hosts,
    emit: (event: ClaudioEventInput) => {
      if (event.type === 'tunnel.changed') events.push(event.tunnel);
    },
    audit: (row) => audit.push(row.summary),
    timing: { monitorMs: 60_000, probeTtlMs: 0, ...options.timing },
  });
  t.after(async () => {
    await manager.shutdown();
    for (const [key, value] of [['FAKE_TAILSCALE_STATE', saved.state], ['FAKE_TAILSCALE_LOG', saved.log]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  if (options.attach !== false) manager.attach(8787);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' ')) : []);
  const node = () => JSON.parse(readFileSync(stateFile, 'utf8')) as Required<Pick<FakeNode, 'serve'>> & FakeNode;
  const setNode = (next: FakeNode) => writeFileSync(stateFile, JSON.stringify({ ...node(), ...next }));
  return { root, manager, hosts, events, audit, security, calls, node, setNode, record: join(root, 'data', 'tunnel', 'serve-rule.json') };
}

const ours = (port = 8444, target = TARGET) => ({ TCP: { [String(port)]: { HTTPS: true } }, Web: { [`${NODE}:${port}`]: { Handlers: { '/': { Proxy: target } } } } });

async function openTunnel(r: Rig): Promise<TunnelStatus> {
  await r.manager.start();
  await until(() => ['active', 'failed'].includes(r.manager.status().state), 'active or failed');
  return r.manager.status();
}

test('the version and the readiness come from the CLI output as measured on 1.102.4', () => {
  assert.deepEqual(parseTailscaleVersion('1.102.4\n  tailscale commit: 3caf7d9'), [1, 102, 4]);
  assert.equal(parseTailscaleVersion('not a version'), null);
  const running = { BackendState: 'Running', Self: { DNSName: `${NODE}.` }, CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: [NODE] };
  assert.deepEqual(readinessFromStatus(running, '1.102.4'), { state: 'ready', version: '1.102.4', host: NODE, reason: null });
  assert.equal(readinessFromStatus({ ...running, BackendState: 'NeedsLogin' }, '1.102.4').state, 'loggedOut');
  assert.equal(readinessFromStatus({ ...running, BackendState: 'NeedsMachineAuth' }, '1.102.4').state, 'loggedOut');
  const stopped = readinessFromStatus({ ...running, BackendState: 'Stopped' }, '1.102.4');
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.reason?.params, { state: 'Stopped' });
  assert.equal(readinessFromStatus({ ...running, CurrentTailnet: { MagicDNSEnabled: false } }, '1.102.4').reason?.code, 'tunnel.magicDnsOff');
  assert.equal(readinessFromStatus({ ...running, CertDomains: null }, '1.102.4').reason?.code, 'tunnel.httpsOff');
});

test("only an HTTPS listener with one `/` proxy to this server is Claudio's; anything else on the port is the person's", () => {
  assert.equal(servePortUse({}, 8444, NODE, TARGET), 'free');
  assert.equal(servePortUse({ TCP: { '443': { HTTPS: true } }, Web: { [`${NODE}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, 8444, NODE, TARGET), 'free');
  assert.equal(servePortUse(ours(), 8444, NODE, TARGET), 'match');
  assert.equal(servePortUse(ours(8444, `${TARGET}/`), 8444, NODE, TARGET), 'match');
  assert.equal(servePortUse(ours(8444, 'http://127.0.0.1:3000'), 8444, NODE, TARGET), 'other');
  const withPath = { TCP: ours().TCP, Web: { [`${NODE}:8444`]: { Handlers: { '/': { Proxy: TARGET }, '/grafana': { Proxy: 'http://127.0.0.1:3000' } } } } };
  assert.equal(servePortUse(withPath, 8444, NODE, TARGET), 'other');
  assert.equal(servePortUse({ TCP: { '8444': { TCPForward: '127.0.0.1:22' } } }, 8444, NODE, TARGET), 'other');
  assert.equal(servePortUse({ Foreground: { session: ours() } }, 8444, NODE, TARGET), 'other');
});

test('start is refused under mode none, and the Serve config is never touched', async (t) => {
  const r = rig(t, { mode: 'none' });
  await assert.rejects(r.manager.start(), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.authRequired' && error.statusCode === 409);
  assert.equal(r.manager.status().state, 'stopped');
  assert.ok(!r.calls().some((call) => call.startsWith('serve')));
});

test('where the deploy does not offer the tunnel, start is refused and the CLI is never run', async (t) => {
  const r = rig(t, { enabled: false });
  assert.equal((await r.manager.refresh()).enabled, false);
  await assert.rejects(r.manager.start(), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.disabled' && error.statusCode === 409);
  assert.equal(r.manager.status().state, 'stopped');
  assert.deepEqual(r.hosts.list(), []);
  assert.deepEqual(r.calls(), []);
});

test('start with Claudio, saved before the operator turned the tunnel off, does not open it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-'));
  const first = rig(t, { root, attach: false });
  await first.manager.updateSettings({ startWithClaudio: true });
  await first.manager.shutdown();

  const second = rig(t, { root, enabled: false });
  assert.equal(second.manager.status().settings.startWithClaudio, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Stopped, not failed: nothing went wrong, the deploy simply does not offer it
  assert.equal(second.manager.status().state, 'stopped');
  assert.equal(second.manager.status().reason, null);
  assert.ok(!second.calls().some((call) => call.startsWith('serve')));
});

test('each way Tailscale is not ready is a state of its own, and start fails with its reason', async (t) => {
  const cases: { node?: FakeNode; bin?: string; state: string; code: string }[] = [
    { bin: '/nonexistent/tailscale', state: 'missing', code: 'tunnel.tailscaleMissing' },
    { node: { version: '1.50.1' }, state: 'unsupported', code: 'tunnel.tailscaleUnsupported' },
    { node: { daemon: false }, state: 'daemonDown', code: 'tunnel.tailscaleDaemonDown' },
    { node: { backendState: 'NeedsLogin' }, state: 'loggedOut', code: 'tunnel.tailscaleLoggedOut' },
    { node: { backendState: 'Stopped' }, state: 'stopped', code: 'tunnel.tailscaleNotConnected' },
    { node: { magicDNS: false }, state: 'httpsDisabled', code: 'tunnel.magicDnsOff' },
    { node: { certDomains: [] }, state: 'httpsDisabled', code: 'tunnel.httpsOff' },
  ];
  for (const c of cases) {
    const r = rig(t, { ...(c.node ? { node: c.node } : {}), ...(c.bin ? { tailscaleBin: c.bin } : {}) });
    const status = await r.manager.refresh();
    assert.equal(status.tailscale.state, c.state, c.code);
    assert.equal(status.tailscale.reason?.code, c.code);
    const started = await r.manager.start();
    assert.equal(started.state, 'failed', c.code);
    assert.equal(started.reason?.code, c.code);
    assert.ok(!r.calls().some((call) => call.startsWith('serve')), `${c.code}: no Serve call`);
    assert.deepEqual(r.hosts.list(), []);
  }
});

test('the daemon Claudio runs sends the person to its sign-in, never to a terminal they do not have', async (t) => {
  const cases: { node: FakeNode; state: string; code: string }[] = [
    { node: { daemon: false }, state: 'daemonDown', code: 'tunnel.managedDaemonDown' },
    { node: { backendState: 'NeedsLogin' }, state: 'loggedOut', code: 'tunnel.managedLoggedOut' },
    { node: { backendState: 'Stopped' }, state: 'stopped', code: 'tunnel.managedNotConnected' },
  ];
  for (const c of cases) {
    const r = rig(t, { node: c.node, managed: true });
    const status = await r.manager.refresh();
    assert.equal(status.managed, true);
    assert.equal(status.tailscale.state, c.state, c.code);
    assert.equal(status.tailscale.reason?.code, c.code);
    assert.doesNotMatch(status.tailscale.reason?.text ?? '', /terminal|tailscale up/);
  }
  // A machine's own Tailscale says what to run, as before
  assert.equal(rig(t).manager.status().managed, false);
});

test("the node's name joins the allowlist once the rule reads back, and stop leaves the Serve config as it was found", async (t) => {
  // The person's own rule on 443 is there before, and still there after
  const theirs = { TCP: { '443': { HTTPS: true } }, Web: { [`${NODE}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const r = rig(t, { node: { serve: theirs } });
  const ready = await r.manager.refresh();
  assert.deepEqual(ready.tailscale, { state: 'ready', version: '1.102.4', host: NODE, reason: null });
  // The readiness read is news of its own: the page learns that Tailscale is ready
  assert.deepEqual(r.events.splice(0).map((s) => [s.state, s.tailscale.state]), [['stopped', 'ready']]);

  const active = await openTunnel(r);
  assert.equal(active.state, 'active');
  assert.equal(active.url, `https://${NODE}:8444`);
  assert.ok(active.since);
  assert.deepEqual(r.hosts.list(), [NODE]);
  assert.deepEqual(r.node().serve, { TCP: { ...theirs.TCP, ...ours().TCP }, Web: { ...theirs.Web, ...ours().Web } });
  assert.ok(existsSync(r.record), 'the rule is recorded, so a crash cannot leave it behind unnoticed');
  assert.ok(r.calls().includes(`serve --bg --yes --https=8444 ${TARGET}`));
  assert.deepEqual(r.events.map((s) => s.state), ['starting', 'verifying', 'active']);
  assert.ok(r.events.every((s) => (s.state === 'active') === (s.url !== null)));

  const stopped = await r.manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.url, null);
  assert.deepEqual(r.hosts.list(), []);
  assert.deepEqual(r.node().serve, theirs);
  assert.ok(!existsSync(r.record));
  assert.deepEqual(r.audit, [`Tunnel host ${NODE} joined the allowlist`, `Tunnel host ${NODE} left the allowlist`]);
});

test('a port that already serves something else is left alone, and the tunnel says so', async (t) => {
  const theirs = ours(8444, 'http://127.0.0.1:3000');
  const r = rig(t, { node: { serve: theirs } });
  const status = await openTunnel(r);
  assert.equal(status.state, 'failed');
  assert.equal(status.reason?.code, 'tunnel.portTaken');
  // What holds the port, as `serve status` says it: another Claudio shows as its own loopback port
  const holder = `https://${NODE}:8444/ → http://127.0.0.1:3000`;
  assert.deepEqual(status.reason?.params, { port: '8444', holder });
  assert.deepEqual(status.portTaken, { port: 8444, holder, nextFree: 8445 });
  assert.deepEqual(r.node().serve, theirs);
  assert.ok(!r.calls().some((call) => call.includes('--bg') || call.endsWith('off')));
  assert.deepEqual(r.hosts.list(), []);
});

test('the same rule with no record of Claudio adding it is not adopted', async (t) => {
  const r = rig(t, { node: { serve: ours() } });
  const status = await openTunnel(r);
  assert.equal(status.reason?.code, 'tunnel.portTaken');
  await r.manager.stop();
  assert.deepEqual(r.node().serve, ours(), 'a rule Claudio did not add is never removed');
});

test('a user who is not the node operator gets the command that fixes it, and nothing is left behind', async (t) => {
  const r = rig(t, { node: { operator: false } });
  const status = await openTunnel(r);
  assert.equal(status.state, 'failed');
  assert.equal(status.reason?.code, 'tunnel.servePermission');
  assert.match(status.reason?.text ?? '', /tailscale set --operator/);
  await until(() => !existsSync(r.record), 'the record removed');
  assert.deepEqual(r.node().serve, {});
});

test('a rule a crash left behind is taken away on the next start, and one someone else replaced is not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-crash-'));
  const crashed = rig(t, { root, attach: false });
  crashed.manager.attach(8787);
  await openTunnel(crashed);
  assert.deepEqual(crashed.node().serve, ours());
  // A crash: the process is gone without shutdown, so the rule and its record stay
  const record = readFileSync(crashed.record, 'utf8');

  const next = rig(t, { root, attach: false });
  assert.ok(existsSync(next.record));
  next.manager.attach(8787);
  await until(() => !existsSync(next.record), 'the leftover reconciled');
  assert.deepEqual(next.node().serve, {});

  // The same record, but the port now holds the person's rule: the record goes, their rule stays
  writeFileSync(next.record, record);
  next.setNode({ serve: ours(8444, 'http://127.0.0.1:3000') });
  const third = rig(t, { root, attach: false });
  third.manager.attach(8787);
  await until(() => !existsSync(third.record), 'the stale record dropped');
  assert.deepEqual(third.node().serve, ours(8444, 'http://127.0.0.1:3000'));
});

test('shutdown takes the rule away before the process goes', async (t) => {
  const r = rig(t);
  await openTunnel(r);
  await r.manager.shutdown();
  assert.deepEqual(r.node().serve, {});
  assert.deepEqual(r.hosts.list(), []);
  assert.ok(!existsSync(r.record));
});

test('a rule removed in a terminal closes the tunnel, and Tailscale going down does too', async (t) => {
  const removed = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(removed);
  removed.setNode({ serve: {} });
  await until(() => removed.manager.status().state === 'failed', 'failed');
  assert.equal(removed.manager.status().reason?.code, 'tunnel.ruleRemoved');
  assert.deepEqual(removed.hosts.list(), []);

  const down = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(down);
  down.setNode({ backendState: 'Stopped' });
  await until(() => down.manager.status().state === 'failed', 'failed');
  assert.equal(down.manager.status().reason?.code, 'tunnel.tailscaleNotConnected');
  assert.deepEqual(down.hosts.list(), []);
});

test('a rule removed while Tailscale answers says ruleRemoved, also when its record was deleted first, never that the daemon is down', async (t) => {
  // The incident of 2026-10-18: a second server deleted the record and took the rule away; the
  // desktop's monitor read "no record" as the daemon being down
  const r = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(r);
  rmSync(r.record);
  // The rule stands: the tunnel stays open and writes its record again, so a crash can still be reconciled
  await until(() => existsSync(r.record), 'the record written again');
  assert.equal(r.manager.status().state, 'active');
  assert.deepEqual(r.hosts.list(), [NODE]);

  rmSync(r.record);
  r.setNode({ serve: {} });
  await until(() => r.manager.status().state === 'failed', 'failed');
  assert.equal(r.manager.status().reason?.code, 'tunnel.ruleRemoved');
  assert.deepEqual(r.hosts.list(), []);

  // Changed rather than removed: the port now proxies somewhere else
  const changed = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(changed);
  changed.setNode({ serve: ours(8444, 'http://127.0.0.1:3000') });
  await until(() => changed.manager.status().state === 'failed', 'failed');
  assert.equal(changed.manager.status().reason?.code, 'tunnel.ruleRemoved');
  assert.deepEqual(changed.node().serve, ours(8444, 'http://127.0.0.1:3000'), "the rule that replaced Claudio's is left alone");
});

test('a server that never opened the tunnel takes nothing away when it shuts down, whatever the record says', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-second-'));
  const live = rig(t, { root, attach: false });
  live.manager.attach(8787, '127.0.0.1', 'lock-of-the-live-server');
  await openTunnel(live);
  const record = readFileSync(live.record, 'utf8');
  assert.match(record, /"lock":"lock-of-the-live-server"/);

  // A second server on the same directory that failed to bind its port shuts down at once
  const second = rig(t, { root, attach: false });
  await second.manager.shutdown();
  assert.deepEqual(second.node().serve, ours());
  assert.equal(readFileSync(live.record, 'utf8'), record);
  assert.equal(live.manager.status().state, 'active');
});

test('at start, a record from before the lock is left alone while its target answers, and one under a previous lock is reconciled', async (t) => {
  // Something answering where the old record points: a Claudio that still runs, which wrote no lock
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const address = listener.address();
  const otherTarget = `http://127.0.0.1:${typeof address === 'object' && address ? String(address.port) : '0'}`;

  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-legacy-'));
  const r = rig(t, { root, attach: false, node: { serve: ours(8444, otherTarget) } });
  mkdirSync(join(root, 'data', 'tunnel'), { recursive: true });
  writeFileSync(r.record, JSON.stringify({ port: 8444, host: NODE, target: otherTarget }));
  r.manager.attach(8787, '127.0.0.1', 'lock-now');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(existsSync(r.record), 'the live server\'s record stays');
  assert.deepEqual(r.node().serve, ours(8444, otherTarget));
  assert.ok(!r.calls().some((call) => call.endsWith('off')));

  // The same rule, written under a lock: its holder is gone, since this server holds the lock now
  writeFileSync(r.record, JSON.stringify({ port: 8444, host: NODE, target: otherTarget, lock: 'lock-before' }));
  const next = rig(t, { root, attach: false });
  next.manager.attach(8787, '127.0.0.1', 'lock-now');
  await until(() => !existsSync(next.record), 'the leftover reconciled');
  assert.deepEqual(next.node().serve, {});
});

test('a Tailscale that is slow to answer keeps the tunnel, its rule and its host, and says it is checking', async (t) => {
  const r = rig(t, { timing: { monitorMs: 30, maxBackoffMs: 90, commandTimeoutMs: 400, stalledAfterMs: 400 } });
  await openTunnel(r);
  const opened = r.calls().length;
  assert.equal(r.manager.status().state, 'active');
  assert.equal(r.manager.status().checking, false);

  r.setNode({ delayMs: 1500 });
  await until(() => r.manager.status().checking, 'checking');
  const slow = r.manager.status();
  assert.equal(slow.state, 'active');
  assert.equal(slow.url, `https://${NODE}:8444`);
  assert.deepEqual(r.hosts.list(), [NODE]);

  // Nothing but unknowns for longer than the limit: a warning, not a failure
  await until(() => r.manager.status().reason?.code === 'tunnel.tailscaleNotAnswering', 'the not-answering reason');
  assert.equal(r.manager.status().state, 'active');
  assert.deepEqual(r.hosts.list(), [NODE]);
  assert.ok(r.events.some((event) => event.checking), 'the feed carried the checking flag');

  // The rule is still there, and no reading ever asked for it to be taken away
  assert.deepEqual(r.node().serve, ours());
  assert.deepEqual(r.calls().slice(opened).filter((call) => call.endsWith('off')), []);

  r.setNode({ delayMs: 0 });
  await until(() => !r.manager.status().checking, 'answers again');
  assert.equal(r.manager.status().state, 'active');
  assert.equal(r.manager.status().reason, null);
  assert.deepEqual(r.hosts.list(), [NODE]);
});

test('Tailscale signed out closes the tunnel, and it opens again by itself once Tailscale is ready', async (t) => {
  const r = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(r);
  r.setNode({ backendState: 'NeedsLogin' });
  await until(() => r.manager.status().state === 'failed', 'failed');
  assert.equal(r.manager.status().reason?.code, 'tunnel.tailscaleLoggedOut');
  assert.deepEqual(r.hosts.list(), []);

  r.setNode({ backendState: 'Running' });
  await until(() => r.manager.status().state === 'active', 'active again');
  assert.deepEqual(r.hosts.list(), [NODE]);
  assert.ok(r.audit.includes('Start the tunnel again: Tailscale is ready'));
});

test('a tunnel the person stopped never restarts, even once Tailscale is ready', async (t) => {
  const r = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(r);
  r.setNode({ backendState: 'Stopped' });
  await until(() => r.manager.status().state === 'failed', 'failed');
  await r.manager.stop();
  assert.equal(r.manager.status().state, 'stopped');
  r.setNode({ backendState: 'Running' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(r.manager.status().state, 'stopped');
  assert.deepEqual(r.hosts.list(), []);
});

test('a node renamed while the tunnel is open moves the allowed host with it', async (t) => {
  const r = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(r);
  const renamed = 'renamed.tail0000.ts.net';
  const serve = r.node().serve as { TCP: unknown; Web: Record<string, unknown> };
  r.setNode({ dnsName: `${renamed}.`, certDomains: [renamed], serve: { TCP: serve.TCP, Web: { [`${renamed}:8444`]: serve.Web[`${NODE}:8444`] } } });
  await until(() => r.manager.status().url === `https://${renamed}:8444`, 'the new name');
  assert.deepEqual(r.hosts.list(), [renamed]);
  await r.manager.stop();
  assert.deepEqual(r.node().serve, {});
});

test('start with Claudio set under its name before the rename is still read, from the file and from a request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-legacy-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'tunnel-settings.json'), JSON.stringify({ startWithAgentry: true }));
  const first = rig(t, { root, attach: false });
  assert.equal(first.manager.status().settings.startWithClaudio, true);
  const off = await first.manager.updateSettings({ startWithAgentry: false });
  assert.equal(off.settings.startWithClaudio, false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'tunnel-settings.json'), 'utf8')), { startWithClaudio: false }, 'the next save writes only the new name');
  const both = await first.manager.updateSettings({ startWithClaudio: true, startWithAgentry: false });
  assert.equal(both.settings.startWithClaudio, true, 'the new name wins when a request sends both');
  await first.manager.shutdown();
});

test('start with Claudio is off by default, is kept, and opens the tunnel on the next attach', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-settings-'));
  const first = rig(t, { root });
  assert.equal(first.manager.status().settings.startWithClaudio, false);
  assert.equal(first.manager.status().state, 'stopped');
  await assert.rejects(first.manager.updateSettings({ startWithClaudio: 'yes' }), /must be a boolean/);
  await assert.rejects(first.manager.updateSettings({ provider: 'ngrok' }), /unknown tunnel settings/);
  const updated = await first.manager.updateSettings({ startWithClaudio: true });
  assert.equal(updated.settings.startWithClaudio, true);
  assert.equal(first.events.at(-1)?.settings.startWithClaudio, true);
  assert.equal(first.events.at(-1)?.tailscale.state, 'ready', 'the event carries a readiness that was read');
  await first.manager.shutdown();

  const second = rig(t, { root });
  assert.equal(second.manager.status().settings.startWithClaudio, true);
  await until(() => second.manager.status().state === 'active', 'active');
  await second.manager.shutdown();
  assert.deepEqual(second.node().serve, {});

  // Asked to start with Claudio on a wrapper without authentication: says why instead of opening
  const third = rig(t, { root, mode: 'none' });
  await until(() => third.manager.status().state === 'failed', 'failed');
  assert.equal(third.manager.status().reason?.code, 'tunnel.authRequired');
  assert.deepEqual(third.node().serve, {});
});

test('another port can be chosen, and the address carries it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-port-'));
  writeFileSync(join(root, 'node.json'), JSON.stringify({ serve: {} }));
  process.env.FAKE_TAILSCALE_STATE = join(root, 'node.json');
  const hosts = new RuntimeHosts();
  const manager = new TunnelManager({ dataDir: join(root, 'data'), tailscaleBin: FAKE_TAILSCALE, port: 10443, security: { mode: 'token' }, hosts, timing: { monitorMs: 60_000 } });
  t.after(async () => {
    await manager.shutdown();
    delete process.env.FAKE_TAILSCALE_STATE;
  });
  manager.attach(8787);
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  assert.equal(manager.status().url, `https://${NODE}:10443`);
  assert.equal(manager.status().port, 10443);
  await manager.stop();
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'node.json'), 'utf8')).serve, {});
});

test('two starts at once open one rule, and neither takes the other\'s rule for someone else\'s', async (t) => {
  const r = rig(t);
  // A click racing "start with Claudio": both pass every check before either has read Tailscale
  const [a, b] = await Promise.all([r.manager.start(), r.manager.start('claudio')]);
  assert.equal(a.state, 'starting');
  assert.equal(b.state, 'starting');
  await until(() => ['active', 'failed'].includes(r.manager.status().state), 'active or failed');
  assert.equal(r.manager.status().state, 'active');
  assert.equal(r.calls().filter((call) => call.includes('--bg')).length, 1, 'one rule was added');
  assert.deepEqual(r.node().serve, ours());
  assert.ok(!r.calls().some((call) => call.endsWith('off')), 'nothing was taken away');
});

test('a stop sent while a start is still reading Tailscale is not lost', async (t) => {
  const r = rig(t, { node: { delayMs: 150 } });
  const starting = r.manager.start();
  const stopped = await r.manager.stop();
  await starting;
  assert.equal(stopped.state, 'stopped');
  // Whatever the start was doing when the stop came, nothing is left open after it
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(r.manager.status().state, 'stopped');
  assert.deepEqual(r.node().serve, {});
  assert.deepEqual(r.hosts.list(), []);
});

test('the port is a setting: kept, refused while the tunnel is open, and the tunnel opens on the next free one', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-port-setting-'));
  // Another Claudio on this node (the desktop beside a dev server) holds 8444
  const theirs = ours(8444, 'http://127.0.0.1:41985');
  const r = rig(t, { root, node: { serve: theirs } });
  assert.deepEqual(r.manager.settingsView(), { settings: { startWithClaudio: false, port: 8444 }, sources: { startWithClaudio: 'default', port: 'default' }, defaults: { startWithClaudio: false, port: 8444 } });
  const failed = await openTunnel(r);
  assert.equal(failed.reason?.code, 'tunnel.portTaken');
  assert.equal(failed.portTaken?.nextFree, 8445);

  await assert.rejects(r.manager.updateSettings({ port: 80 }), /port must be a whole number from 1024 to 65535/);
  await assert.rejects(r.manager.updateSettings({ port: 8444.5 }), /port must be a whole number/);
  const moved = await r.manager.updateSettings({ port: 8445 });
  assert.equal(moved.state, 'stopped', 'a failure about the old port says nothing about the new one');
  assert.equal(moved.portTaken, null);
  assert.equal(moved.port, 8445);
  assert.equal(moved.portSource, 'file');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'tunnel-settings.json'), 'utf8')), { port: 8445 }, 'only what the person set is written');

  const active = await openTunnel(r);
  assert.equal(active.state, 'active');
  assert.equal(active.url, `https://${NODE}:8445`);
  assert.deepEqual(r.node().serve, { TCP: { ...theirs.TCP, ...ours(8445).TCP }, Web: { ...theirs.Web, ...ours(8445).Web } });
  await assert.rejects(r.manager.updateSettings({ port: 9000 }), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.portWhileRunning');
  await assert.rejects(r.manager.resetSettings(['port']), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.portWhileRunning', 'a reset never moves the port from under the rule');
  await r.manager.stop();
  assert.deepEqual(r.node().serve, theirs, 'the other rule is never touched');

  // Kept for the next run; a reset brings the default back
  const next = rig(t, { root, attach: false });
  assert.equal(next.manager.status().port, 8445);
  const reset = await next.manager.resetSettings(['port']);
  assert.equal(reset.port, 8444);
  assert.equal(reset.portSource, 'default');
});

test('a port the environment fixes is read-only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-tunnel-port-env-'));
  const manager = new TunnelManager({ dataDir: join(root, 'data'), tailscaleBin: FAKE_TAILSCALE, port: 10443, security: { mode: 'token' }, hosts: new RuntimeHosts() });
  t.after(() => manager.shutdown());
  assert.equal(manager.status().portSource, 'env');
  assert.equal(manager.settingsView().sources.port, 'env');
  await assert.rejects(manager.updateSettings({ port: 9000 }), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.portFromEnv');
  // Sending the port it already has changes nothing and is not an error
  assert.equal((await manager.updateSettings({ port: 10443, startWithClaudio: true })).port, 10443);
  assert.ok(!('port' in (JSON.parse(readFileSync(join(root, 'data', 'tunnel-settings.json'), 'utf8')) as object)));
});

test('a refusal from tailscale serve keeps the address it gives on a later line', async (t) => {
  const r = rig(t, { node: { serveDisabled: true } });
  const status = await openTunnel(r);
  assert.equal(status.reason?.code, 'tunnel.serveFailed');
  assert.equal(status.reason?.params?.detail, 'Serve is not enabled on your tailnet. https://login.tailscale.com/f/serve?node=nFAKE0000');
  await until(() => !existsSync(r.record), 'the record removed');
});

test('shutdown takes no longer than its bound, and leaves the record when Tailscale does not answer in time', async (t) => {
  const r = rig(t, { timing: { commandTimeoutMs: 30_000 } });
  await openTunnel(r);
  r.setNode({ delayMs: 10_000 });
  const began = Date.now();
  await r.manager.shutdown();
  const took = Date.now() - began;
  assert.ok(took < 5_000, `shutdown took ${String(took)} ms`);
  assert.deepEqual(r.hosts.list(), [], 'the host left the allowlist at once');
  assert.ok(existsSync(r.record), 'the record stays for the next start to reconcile');
  r.setNode({ delayMs: 0 });
});
