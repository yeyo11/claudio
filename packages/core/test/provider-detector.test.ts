import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ProviderLimit, ProvidersSettings } from '@claudio/shared';
import type { ClaudioEventInput } from '../src/events.ts';
import { loadConfig } from '../src/paths.ts';
import { ProviderLimits, type ProviderLimitStore } from '../src/providers/limits.ts';
import { ProviderDetector, satisfiesRange } from '../src/providers/detector.ts';
import { confirmClaudeInit } from '../src/providers/claude-code/handshake.ts';
import { PROVIDER_MANIFESTS, ProviderRegistry } from '../src/providers/registry.ts';
import type { SessionInit } from '../src/providers/driver.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
let root: string;
let bin: string;
let home: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'claudio-detector-'));
});
after(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  n += 1;
  bin = join(root, `bin${n}`);
  home = join(root, `home${n}`);
  await mkdir(bin);
  await mkdir(home);
});

async function fake(name: string, body: string): Promise<string> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

function detector(options: { limits?: ProviderLimits; accountsAtLimit?: () => boolean; settings?: ProvidersSettings | null; events?: ClaudioEventInput[]; probeTimeoutMs?: number; env?: NodeJS.ProcessEnv; registry?: ProviderRegistry } = {}) {
  const env = { PATH: bin, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDIO_DATA_DIR: join(home, 'data'), ...options.env };
  return new ProviderDetector({
    config: loadConfig(env),
    env,
    home,
    platform: 'linux',
    resolvePath: async () => bin,
    settings: () => options.settings ?? null,
    emit: (event) => options.events?.push(event),
    limits: options.limits,
    accountsAtLimit: options.accountsAtLimit,
    registry: options.registry,
    probeTimeoutMs: options.probeTimeoutMs ?? 5_000,
    debounceMs: 50,
    minWatchGapMs: 0,
  });
}

const CLAUDE = (version: string, loggedIn: boolean) =>
  `case "$1" in --version) echo "${version} (Claude Code)";; auth) echo '{"loggedIn": ${String(loggedIn)}, "email": "me@example.com"}';; esac`;

async function statusOf(d: ProviderDetector, id: string) {
  const status = (await d.refresh()).find((s) => s.id === id);
  assert.ok(status, id);
  return status;
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('satisfiesRange', () => {
  it('reads space-separated comparators', () => {
    assert.equal(satisfiesRange('2.1.285', '>=2.1 <3'), 'in');
    assert.equal(satisfiesRange('2.0.9', '>=2.1 <3'), 'below');
    assert.equal(satisfiesRange('3.0.0', '>=2.1 <3'), 'above');
    assert.equal(satisfiesRange('9.9.9', ''), 'in');
  });
});

describe('ProviderDetector', () => {
  it('lists Claude Code as not installed on an empty machine', async () => {
    const all = await detector().refresh();
    assert.deepEqual(all.map((s) => s.id), ['claude-code']);
    for (const s of all) assert.deepEqual([s.state, s.reason, s.binaryPath], ['not-installed', 'binary-not-found', null]);
  });

  it('says used-before when only the config home is there', async () => {
    await mkdir(join(home, '.claude'));
    const claude = await statusOf(detector(), 'claude-code');
    assert.deepEqual([claude.state, claude.reason, claude.configHome], ['used-before', 'config-home-only', join(home, '.claude')]);
  });

  it('is ready when installed, compatible and signed in, with the account', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const claude = await statusOf(detector(), 'claude-code');
    assert.deepEqual([claude.state, claude.reason, claude.version, claude.account], ['ready', null, '2.1.285', 'me@example.com']);
    assert.equal(claude.binaryPath, join(bin, 'claude'));
    assert.equal(claude.capabilities.length, 15);
  });

  it('is signed-out when the login probe says so', async () => {
    await fake('claude', CLAUDE('2.1.285', false));
    const claude = await statusOf(detector(), 'claude-code');
    assert.deepEqual([claude.state, claude.reason, claude.version], ['signed-out', 'missing-credentials', '2.1.285']);
  });

  it('is incompatible outside the tested range, on either side', async () => {
    await fake('claude', CLAUDE('1.9.0', true));
    const d = detector();
    const low = await statusOf(d, 'claude-code');
    assert.deepEqual([low.state, low.reason], ['incompatible', 'version-below-range']);
    assert.equal(d.knownSignedIn('claude-code'), true, 'the state hides it, /health still needs it');
    await fake('claude', CLAUDE('3.1.0', true));
    assert.equal((await statusOf(detector(), 'claude-code')).reason, 'version-above-range');
  });

  it('keeps a probe that hangs from holding the rest', async () => {
    await fake('claude', 'exec /bin/sleep 30');
    const started = Date.now();
    const claude = await statusOf(detector({ probeTimeoutMs: 1_500 }), 'claude-code');
    assert.ok(Date.now() - started < 8_000);
    assert.deepEqual([claude.state, claude.reason], ['unknown', 'probe-timeout']);
  });

  it('says spawn-failed for a crash', async () => {
    await fake('claude', 'exit 3');
    assert.equal((await statusOf(detector(), 'claude-code')).reason, 'spawn-failed');
  });

  it('uses the binary the person points at before the PATH', async () => {
    await fake('claude', CLAUDE('2.1.100', true));
    const elsewhere = join(root, `elsewhere${n}`);
    await writeFile(elsewhere, `#!/bin/sh\n${CLAUDE('2.1.285', true)}\n`);
    await chmod(elsewhere, 0o755);
    const settings: ProvidersSettings = { providers: { 'claude-code': { enabled: true, binaryPath: elsewhere } }, order: [], defaultProvider: null };
    const claude = await statusOf(detector({ settings }), 'claude-code');
    assert.deepEqual([claude.binaryPath, claude.version], [elsewhere, '2.1.285']);
    const missing: ProvidersSettings = { providers: { 'claude-code': { enabled: true, binaryPath: join(root, 'nope') } }, order: [], defaultProvider: null };
    assert.equal((await statusOf(detector({ settings: missing }), 'claude-code')).reason, 'binary-not-found');
  });

  it('emits providers.changed only when a status changes', async () => {
    const events: ClaudioEventInput[] = [];
    const d = detector({ events });
    await d.refresh();
    assert.equal(events.length, 0, 'the first reading is not a change');
    await d.refresh();
    assert.equal(events.length, 0, 'the same statuses again are not a change');
    await fake('claude', CLAUDE('2.1.285', true));
    await d.refresh();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'providers.changed');
    await d.settingsChanged();
    assert.equal(events.length, 1);
  });

  it('serves the cache inside the TTL and reads once for concurrent refreshes', async () => {
    const counter = join(root, `count${n}`);
    await fake('claude', `echo x >> "${counter}"; ${CLAUDE('2.1.285', true)}`);
    const d = detector();
    await Promise.all([d.refresh(), d.refresh()]);
    const lines = () => readFileSync(counter, 'utf8').trim().split('\n').length;
    const once = lines();
    await d.statuses();
    assert.equal(lines(), once, 'the cache answers inside the TTL');
    await d.refresh();
    assert.ok(lines() > once, 'a refresh reads again');
  });

  it('answers a refresh asked while another runs with a detection that starts after it', async () => {
    const state = join(root, `state${n}`);
    const release = join(root, `release${n}`);
    // Each login probe reads the state as it starts, then the first one waits for the test to let it
    // go, so the first detection is still running when the state changes
    await fake(
      'claude',
      `case "$1" in --version) echo "2.1.285 (Claude Code)";; auth) s=$(/bin/cat "${state}"); while [ ! -e "${release}" ]; do /bin/sleep 0.05; done; echo "{\\"loggedIn\\": $s}";; esac`,
    );
    await writeFile(state, 'false');
    const d = detector();
    const first = d.refresh();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = d.refresh();
    const third = d.refresh();
    assert.equal(second, third, 'everyone asking meanwhile shares one follow-up');
    await writeFile(state, 'true');
    await writeFile(release, '');
    assert.equal((await first).find((s) => s.id === 'claude-code')?.state, 'signed-out');
    assert.equal((await second).find((s) => s.id === 'claude-code')?.state, 'ready', 'the follow-up read the change');
  });

  it('re-detects on its own when a binary lands on the PATH', async () => {
    const events: ClaudioEventInput[] = [];
    const d = detector({ events });
    await d.refresh();
    await d.startWatching();
    try {
      await fake('claude', CLAUDE('2.1.285', true));
      await until(() => events.length > 0);
      assert.equal(events.length, 1);
      assert.equal(d.knownOne('claude-code')?.state, 'ready');
    } finally {
      d.close();
    }
  });

  it('re-detects when a config home appears', async () => {
    const events: ClaudioEventInput[] = [];
    const d = detector({ events });
    await d.refresh();
    await d.startWatching();
    try {
      await mkdir(join(home, '.claude'));
      await until(() => events.length > 0);
      assert.equal(d.knownOne('claude-code')?.state, 'used-before');
    } finally {
      d.close();
    }
  });

  it('takes Claude Code from a reading already made, without spawning it again', async () => {
    await fake('claude', 'echo spawned >> "$0.log"; exit 9');
    const d = detector();
    await d.refresh({
      only: ['claude-code'],
      claude: { cli: { installed: true, version: '2.1.285', path: join(bin, 'claude') }, auth: { loggedIn: true, tokenSource: 'none' } },
    });
    assert.equal(d.knownOne('claude-code')?.state, 'ready');
    assert.equal(d.known()?.length, 1);
    assert.equal(existsSync(join(bin, 'claude.log')), false);
  });
});

describe('capabilities confirmed by a session', () => {
  const init = (over: Partial<SessionInit> = {}): SessionInit => ({
    version: '2.1.285',
    tools: ['Read', 'Task', 'Workflow'],
    mcpServers: [{ name: 'pando', status: 'connected' }],
    structuredOutput: false,
    ...over,
  });

  it('confirms what the init shows and leaves the rest declared', () => {
    const c = confirmClaudeInit(init());
    assert.deepEqual(c.confirmed, ['subagents', 'workflowTool', 'mcp']);
    assert.deepEqual(c.missing, []);
    assert.deepEqual(confirmClaudeInit(init({ structuredOutput: true })).confirmed.slice(-1), ['structuredOutput']);
  });

  it('reads Agent as the subagent tool, and contradicts only from a tool list it could read', () => {
    assert.ok(confirmClaudeInit(init({ tools: ['Agent'] })).confirmed.includes('subagents'));
    assert.deepEqual(confirmClaudeInit(init({ tools: ['Read'] })).missing, ['subagents']);
    assert.deepEqual(confirmClaudeInit(init({ tools: [] })).missing, []);
  });

  it('never degrades on a missing Workflow tool, which 2.1.287 leaves out of the init', () => {
    const c = confirmClaudeInit(init({ version: '2.1.287', tools: ['Read', 'Agent'] }));
    assert.deepEqual(c.missing, []);
    assert.ok(!c.confirmed.includes('workflowTool'));
  });

  it('confirms nothing for a version outside the range', () => {
    assert.deepEqual(confirmClaudeInit(init({ version: '1.0.0' })), { version: '1.0.0', confirmed: [], missing: [] });
  });

  it('records it on the status and emits providers.changed only when that changes', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const events: ClaudioEventInput[] = [];
    const d = detector({ events });
    assert.equal((await statusOf(d, 'claude-code')).confirmed, null);

    d.confirm('claude-code', confirmClaudeInit(init()));
    const confirmed = d.knownOne('claude-code');
    assert.equal(confirmed?.state, 'ready');
    assert.deepEqual(confirmed?.confirmed?.capabilities, ['subagents', 'workflowTool', 'mcp']);
    assert.equal(confirmed?.confirmed?.version, '2.1.285');
    assert.equal(events.filter((e) => e.type === 'providers.changed').length, 1);

    d.confirm('claude-code', confirmClaudeInit(init()));
    assert.equal(events.filter((e) => e.type === 'providers.changed').length, 1, 'the same answer is not a change');
  });

  it('degrades a provider whose declared capability the init contradicts, and survives a re-detection', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const d = detector();
    await statusOf(d, 'claude-code');
    d.confirm('claude-code', confirmClaudeInit(init({ tools: ['Read'] })));
    const degraded = d.knownOne('claude-code');
    assert.deepEqual([degraded?.state, degraded?.reason], ['degraded', 'capability-missing']);
    assert.ok(!degraded?.capabilities.includes('subagents'));
    // A missing Workflow tool never contradicts, so the capability stays declared
    assert.ok(d.capabilities('claude-code').includes('workflowTool'));

    const again = await statusOf(d, 'claude-code');
    assert.deepEqual([again.state, again.reason], ['degraded', 'capability-missing']);
  });

  it('drops the confirmation when the installed version is no longer the one confirmed', async () => {
    await fake('claude', CLAUDE('2.1.300', true));
    const d = detector();
    d.confirm('claude-code', confirmClaudeInit(init({ version: '2.1.285', tools: ['Read'] })));
    const status = await statusOf(d, 'claude-code');
    assert.deepEqual([status.state, status.confirmed], ['ready', null]);
  });

  it('answers with the declared set before any session', () => {
    assert.equal(detector().capabilities('claude-code').length, 15);
  });
});

describe('provider limits in the status', () => {
  const memory = (): ProviderLimitStore => {
    const rows = new Map<string, ProviderLimit>();
    return { upsertProviderLimit: (l) => !!rows.set(l.provider, l), providerLimit: (p) => rows.get(p) ?? null, providerLimits: () => [...rows.values()] };
  };
  /** A chat's real rejection: the five-hour window is spent until an hour from now */
  const reject = (limits: ProviderLimits): void =>
    limits.observe('claude-code', { kind: 'rate-limit', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600, windows: {}, observedAt: new Date().toISOString() } });

  it('serves a limit a chat reported without a detection, and announces it', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const limits = new ProviderLimits(memory());
    const events: ClaudioEventInput[] = [];
    const d = detector({ limits, events });
    await d.refresh();
    events.length = 0;
    reject(limits);
    const status = d.knownOne('claude-code');
    assert.deepEqual([status?.state, status?.reason], ['degraded', 'limit-reached']);
    assert.equal(events.filter((e) => e.type === 'providers.changed').length, 1);
  });

  it('keeps Claude ready at its limit while another account has room, with the limit on the status', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const limits = new ProviderLimits(memory());
    let allOut = false;
    const d = detector({ limits, accountsAtLimit: () => allOut });
    await d.refresh();
    reject(limits);
    const status = d.knownOne('claude-code');
    assert.deepEqual([status?.state, status?.limit?.state], ['ready', 'exhausted']);
    allOut = true;
    assert.deepEqual([d.knownOne('claude-code')?.state, d.knownOne('claude-code')?.reason], ['degraded', 'limit-reached']);
  });

  it('reads a provider whose limit was never reported as having none', async () => {
    const status = await statusOf(detector({ limits: new ProviderLimits(memory()) }), 'claude-code');
    assert.equal(status.limit, null);
  });
});
