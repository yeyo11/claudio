// The update unit, its helper and the polkit rule the .deb ships (docs/plans/remote-updates.md, D1-D2).
// The helper runs here against a fake root, with apt-get and dpkg-query stubbed on PATH: nothing in
// this file touches apt, dpkg, polkit or systemd on the machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runInNewContext } from 'node:vm';

const desktopDir = new URL('../', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
const read = (path: string, base: URL = desktopDir): string => readFileSync(new URL(path, base), 'utf8');

const ruleFile = read('build/linux/50-claudio-update.rules');
const unitFile = read('build/linux/claudio-update.service');
const helper = read('build/linux/claudio-update');
const builder = read('electron-builder.yml');

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// --- The polkit rule ---

interface Action {
  id: string;
  lookup(key: string): string | undefined;
}
interface Subject {
  user: string;
  isInGroup(group: string): boolean;
}
type Rule = (action: Action, subject: Subject) => unknown;

/** The rule file evaluated the way polkitd does, with a fake `polkit` that keeps the rules it adds */
function loadRules(): Rule[] {
  const rules: Rule[] = [];
  const polkit = {
    Result: { YES: 'yes', NO: 'no', AUTH_ADMIN: 'auth_admin', AUTH_SELF: 'auth_self' },
    addRule: (rule: Rule) => rules.push(rule),
    addAdminRule: () => assert.fail('the rule must not change who counts as an admin'),
    log: () => undefined,
    spawn: () => assert.fail('the rule must not run a program'),
  };
  runInNewContext(ruleFile, { polkit });
  return rules;
}

const action = (id: string, details: Record<string, string>): Action => ({ id, lookup: (key) => details[key] });
const member = (groups: string[]): Subject => ({ user: 'alice', isInGroup: (group) => groups.includes(group) });
const MANAGE = 'org.freedesktop.systemd1.manage-units';

test('the polkit rule lets the claudio-update group start claudio-update.service, and nothing else', () => {
  const rules = loadRules();
  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.ok(rule);
  const inGroup = member(['alice', 'claudio-update']);
  assert.equal(rule(action(MANAGE, { unit: 'claudio-update.service', verb: 'start' }), inGroup), 'yes');

  // Everything else falls through (undefined) to polkit's other rules, which ask for an admin
  const fallThrough: [Action, Subject, string][] = [
    [action(MANAGE, { unit: 'claudio-update.service', verb: 'start' }), member(['alice', 'sudo']), 'outside the group'],
    ...['stop', 'restart', 'reload', 'try-restart', 'reload-or-restart', 'kill', ''].map((verb): [Action, Subject, string] => [
      action(MANAGE, { unit: 'claudio-update.service', verb }), inGroup, `verb ${verb || '(none)'}`,
    ]),
    ...['claudio-update', 'ssh.service', 'claudio-update.service.d', 'claudio-update@x.service', 'claudio-update.timer', ''].map((unit): [Action, Subject, string] => [
      action(MANAGE, { unit, verb: 'start' }), inGroup, `unit ${unit || '(none)'}`,
    ]),
    ...[
      'org.freedesktop.systemd1.manage-unit-files',
      'org.freedesktop.systemd1.reload-daemon',
      'org.freedesktop.systemd1.set-environment',
      'org.freedesktop.packagekit.package-install',
      'org.freedesktop.policykit.exec',
    ].map((id): [Action, Subject, string] => [action(id, { unit: 'claudio-update.service', verb: 'start' }), inGroup, id]),
  ];
  for (const [a, subject, what] of fallThrough) assert.equal(rule(a, subject), undefined, what);
});

test('the polkit rule names the unit, never a program', () => {
  const code = ruleFile.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /program|exec\.path|command_line|pkexec/);
  assert.doesNotMatch(code, /addAdminRule|AUTH_ADMIN|NO\b/);
  assert.equal(code.match(/polkit\.Result\.YES/g)?.length, 1);
});

// --- The unit ---

/** The unit's directives by section, comments dropped; a directive given twice keeps every value */
function parseUnit(text: string): Map<string, Map<string, string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section?.[1]) {
      current = new Map();
      sections.set(section[1], current);
      continue;
    }
    assert.ok(current, `a directive outside a section: ${line}`);
    assert.ok(!line.endsWith('\\'), 'no continued lines, so what is read here is what systemd reads');
    const eq = line.indexOf('=');
    assert.ok(eq > 0, line);
    const key = line.slice(0, eq);
    current.set(key, [...(current.get(key) ?? []), line.slice(eq + 1)]);
  }
  return sections;
}

test('the unit is a root oneshot, started on demand only, that runs the helper with no argument', () => {
  const unit = parseUnit(unitFile);
  assert.deepEqual([...unit.keys()], ['Unit', 'Service'], 'no [Install]: never enabled, only started');
  const service = unit.get('Service');
  assert.ok(service);
  assert.deepEqual(service.get('Type'), ['oneshot']);
  assert.deepEqual(service.get('ExecStart'), ['/usr/lib/claudio/claudio-update']);
  // Root: no User=, Group= or DynamicUser=, and no other command that could take what a caller says
  for (const key of ['User', 'Group', 'DynamicUser', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecReload', 'Environment', 'EnvironmentFile', 'PassEnvironment']) {
    assert.equal(service.has(key), false, key);
  }
  assert.doesNotMatch(unitFile, /%[a-zA-Z]/, 'no specifier: a template instance name could carry text');
  assert.deepEqual(service.get('StateDirectory'), ['claudio-update']);
  assert.deepEqual(service.get('StateDirectoryMode'), ['0755']);
  assert.ok(service.has('TimeoutStartSec'));
  // A loop cannot hammer apt: the limit lives in [Unit] (systemd ignores it in [Service] since v230)
  const limits = unit.get('Unit');
  assert.ok(limits);
  assert.deepEqual(limits.get('StartLimitIntervalSec'), ['600']);
  assert.deepEqual(limits.get('StartLimitBurst'), ['4']);
});

// --- The helper, against a fake root ---

const UPDATE_LINE = '-q -o Dir::Etc::sourcelist=sources.list.d/claudio.sources -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 update';
// --only-upgrade: never a downgrade nor a first install; --no-remove: never another package taken off
const INSTALL_LINE = '-q -y --no-remove -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install --only-upgrade claudio';

interface Fake {
  root: string;
  source: string;
  status: string;
  state: string;
  /** apt-get's calls: its arguments, then DEBIAN_FRONTEND and LC_ALL as it saw them */
  calls: () => string[];
  version: (value: string) => void;
}

/**
 * A root with Claudio's source registered and claudio `from` installed. apt-get's stub logs its
 * arguments; `fake/locks` holds how many calls still find the lock held, `fake/fail-update` a reason
 * for `update` to fail, and `fake/next` the version `install` leaves installed.
 */
function fakeRoot(from: string): Fake {
  const root = mkdtempSync(join(tmpdir(), 'claudio-update-unit-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const fake = join(root, 'fake');
  for (const dir of [bin, fake, join(root, 'etc/apt/sources.list.d')]) mkdirSync(dir, { recursive: true });
  const source = join(root, 'etc/apt/sources.list.d/claudio.sources');
  writeFileSync(source, 'Types: deb\n');
  writeFileSync(join(fake, 'version'), from);
  const stubs: Record<string, string> = {
    'apt-get': `echo "$* | $DEBIAN_FRONTEND $LC_ALL" >> "${fake}/calls"
locks=$(cat "${fake}/locks" 2>/dev/null || echo 0)
if [ "$locks" -gt 0 ]; then
  echo $((locks - 1)) > "${fake}/locks"
  echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (unattended-upgr)" >&2
  exit 100
fi
if [ "\${*: -1}" = update ] && [ -f "${fake}/fail-update" ]; then
  echo "Hit:1 file:/srv/repo stable InRelease"
  cat "${fake}/fail-update" >&2
  exit 100
fi
if [ "\${*: -1}" = claudio ] && [ -f "${fake}/next" ]; then cp "${fake}/next" "${fake}/version"; fi
echo "done"`,
    'dpkg-query': `[ "$*" = "-W -f=\\\${Version} claudio" ] || { echo "unexpected: $*" >&2; exit 2; }
cat "${fake}/version"`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const state = join(root, 'var/lib/claudio-update');
  return {
    root,
    source,
    state,
    status: join(state, 'status.json'),
    calls: () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean) : []),
    version: (value) => writeFileSync(join(fake, 'next'), value),
  };
}

/** The helper with its system paths under the fake root, the stubs first on PATH and a short lock wait */
function runHelper(fake: Fake, args: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  const swaps: [string, string][] = [
    ['export PATH=/usr/sbin:/usr/bin:/sbin:/bin', `export PATH=${fake.root}/bin:/usr/sbin:/usr/bin:/sbin:/bin`],
    ['SOURCE=/etc/apt/sources.list.d/claudio.sources', `SOURCE=${fake.source}`],
    ['STATE_DIR=/var/lib/claudio-update', `STATE_DIR=${fake.state}`],
    ['LOCK_TRIES=60', 'LOCK_TRIES=3'],
    ['LOCK_PAUSE=5', 'LOCK_PAUSE=0'],
  ];
  let script = helper;
  for (const [from, to] of swaps) {
    assert.equal(script.split(from).length, 2, `the helper sets ${from} once`);
    script = script.replace(from, to);
  }
  const file = join(fake.root, 'claudio-update');
  writeFileSync(file, script);
  const run = spawnSync('bash', [file, ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: fake.root, ...env }, encoding: 'utf8' });
  return { code: run.status ?? 1, out: run.stdout + run.stderr };
}

interface Status {
  result: string;
  from: string | null;
  to: string | null;
  startedAt: string | null;
  endedAt: string | null;
  code: string | null;
  error: string | null;
}
function readStatus(fake: Fake): Status {
  const status = JSON.parse(readFileSync(fake.status, 'utf8')) as Status;
  assert.deepEqual(Object.keys(status), ['result', 'from', 'to', 'startedAt', 'endedAt', 'code', 'error']);
  // Root-owned on the machine, world-readable: the app reads it as the person
  assert.equal(statSync(fake.status).mode & 0o777, 0o644);
  assert.equal(statSync(fake.state).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(fake.state), ['status.json'], 'no temporary file left beside it');
  return status;
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('the helper updates the one source, then upgrades only claudio, noninteractively, and records from and to', () => {
  const fake = fakeRoot('0.14.2');
  fake.version('0.15.0');
  // What the caller's environment says does not reach apt: the helper sets both itself
  const run = runHelper(fake, [], { DEBIAN_FRONTEND: 'dialog', LC_ALL: 'es_ES.UTF-8' });
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(fake.calls(), [`${UPDATE_LINE} | noninteractive C`, `${INSTALL_LINE} | noninteractive C`]);
  const status = readStatus(fake);
  assert.equal(status.result, 'installed');
  assert.equal(status.from, '0.14.2');
  assert.equal(status.to, '0.15.0');
  assert.match(status.startedAt ?? '', ISO);
  assert.match(status.endedAt ?? '', ISO);
  assert.ok((status.startedAt ?? '') <= (status.endedAt ?? ''));
  assert.equal(status.code, null);
  assert.equal(status.error, null);
});

test('the helper ignores any argument: the command line apt gets is always the same', () => {
  const plain = fakeRoot('0.14.2');
  runHelper(plain);
  const crafted = fakeRoot('0.14.2');
  const run = runHelper(crafted, ['claudio=0.1.0', '--allow-downgrades', '-o', 'APT::Get::allow-downgrades=1', '$(id)']);
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(crafted.calls(), plain.calls());
  // and the source is written exactly as install.sh's own update of it, so both stay one command
  const installSh = read('scripts/install.sh', repoRoot);
  assert.ok(installSh.includes(`apt-get update ${UPDATE_LINE.replace(/^-q /, '').replace(/ update$/, '')}`), 'install.sh updates the same single source');
  // No positional parameter read outside a function, no file sourced, and no downgrade switch
  const topLevel = helper.replace(/^[a-z_]+\(\) \{\n[\s\S]*?^\}\n/gm, '').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(topLevel, /\$[@*1-9]|\$\{[@*1-9]/);
  assert.doesNotMatch(helper, /^\s*(?:\.|source)\s/m);
  assert.doesNotMatch(helper.replace(/^\s*#.*$/gm, ''), /allow-downgrades|--reinstall|claudio=/);
});

test('an upgrade with nothing new records up-to-date, with to equal to from', () => {
  const fake = fakeRoot('0.15.0');
  assert.equal(runHelper(fake).code, 0);
  const status = readStatus(fake);
  assert.equal(status.result, 'up-to-date');
  assert.equal(status.from, '0.15.0');
  assert.equal(status.to, '0.15.0');
});

test('the helper waits for a held apt lock, a bounded number of times', () => {
  const freed = fakeRoot('0.14.2');
  writeFileSync(join(freed.root, 'fake/locks'), '2');
  freed.version('0.15.0');
  assert.equal(runHelper(freed).code, 0);
  assert.deepEqual(freed.calls().map((call) => call.split(' | ')[0]), [UPDATE_LINE, UPDATE_LINE, UPDATE_LINE, INSTALL_LINE]);
  assert.equal(readStatus(freed).result, 'installed');

  const held = fakeRoot('0.14.2');
  writeFileSync(join(held.root, 'fake/locks'), '99');
  const run = runHelper(held);
  assert.equal(run.code, 1);
  assert.equal(held.calls().length, 3, 'LOCK_TRIES attempts, then it gives up');
  const status = readStatus(held);
  assert.equal(status.result, 'failed');
  assert.equal(status.code, 'update.apt-locked');
  assert.equal(status.to, '0.14.2');
  assert.match(status.endedAt ?? '', ISO);

  // The lock held at the install, after a good update, is the same failure
  const atInstall = fakeRoot('0.14.2');
  const stub = join(atInstall.root, 'bin/apt-get');
  writeFileSync(stub, readFileSync(stub, 'utf8').replace('locks=$(', `[ "\${*: -1}" = update ] && { echo done; exit 0; }\nlocks=$(`));
  writeFileSync(join(atInstall.root, 'fake/locks'), '99');
  assert.equal(runHelper(atInstall).code, 1);
  assert.equal(readStatus(atInstall).code, 'update.apt-locked');
});

test("a failed apt-get update stops before the install and keeps apt's reason, as valid JSON", () => {
  const fake = fakeRoot('0.14.2');
  fake.version('0.15.0');
  writeFileSync(join(fake.root, 'fake/fail-update'), 'W: Failed to fetch "https://yeyo11.github.io/claudio/apt" \\ 404\tNot Found\nE: Some index files failed to download.\n');
  const run = runHelper(fake);
  assert.equal(run.code, 1);
  assert.deepEqual(fake.calls().map((call) => call.split(' | ')[0]), [UPDATE_LINE]);
  const status = readStatus(fake);
  assert.equal(status.result, 'failed');
  assert.equal(status.code, 'update.apt-failed');
  assert.equal(status.error, 'W: Failed to fetch "https://yeyo11.github.io/claudio/apt" \\ 404 Not Found\nE: Some index files failed to download.');
  assert.equal(status.to, '0.14.2');
});

test('without the registered source the helper runs no apt at all', () => {
  const fake = fakeRoot('0.14.2');
  rmSync(fake.source);
  assert.equal(runHelper(fake).code, 1);
  assert.deepEqual(fake.calls(), []);
  const status = readStatus(fake);
  assert.equal(status.result, 'failed');
  assert.equal(status.code, 'update.source-missing');
});

test('while it runs, status.json says installing, with from and startedAt', () => {
  const fake = fakeRoot('0.14.2');
  // The stub copies the status apt-get sees mid-run
  const stub = join(fake.root, 'bin/apt-get');
  writeFileSync(stub, readFileSync(stub, 'utf8').replace('locks=$(', `cp "${fake.status}" "${fake.root}/fake/mid-run.json"\nlocks=$(`));
  assert.equal(runHelper(fake).code, 0);
  const mid = JSON.parse(readFileSync(join(fake.root, 'fake/mid-run.json'), 'utf8')) as Status;
  assert.equal(mid.result, 'installing');
  assert.equal(mid.from, '0.14.2');
  assert.match(mid.startedAt ?? '', ISO);
  assert.equal(mid.to, null);
  assert.equal(mid.endedAt, null);
});

// --- The package ---

test('the .deb ships the unit, the helper and the rule, staged with fixed modes', () => {
  const fpm = [
    'dist/package/claudio-update.service=/usr/lib/systemd/system/claudio-update.service',
    'dist/package/claudio-update=/usr/lib/claudio/claudio-update',
    'dist/package/50-claudio-update.rules=/usr/share/polkit-1/rules.d/50-claudio-update.rules',
  ];
  const deb = /^deb:\n((?:\s+.*\n|\n)*)/m.exec(builder)?.[1] ?? '';
  for (const entry of fpm) assert.ok(deb.includes(`    - ${entry}\n`), entry);
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const stage = pkg.scripts['package:stage'] ?? '';
  assert.match(stage, /install -m 0644 build\/linux\/claudio-update\.service build\/linux\/50-claudio-update\.rules dist\/package\//);
  assert.match(stage, /install -m 0755 build\/linux\/claudio-update dist\/package\/claudio-update/);
  // Committed executable too, so a by-hand run of the helper in a test container works from the checkout
  assert.ok(statSync(new URL('build/linux/claudio-update', desktopDir)).mode & 0o100);
  assert.match(helper, /^#!\/bin\/bash\n/);
});
