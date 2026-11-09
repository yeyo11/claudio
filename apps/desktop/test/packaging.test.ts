import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');

test("the .deb does not depend on a tunnel package: Tailscale is the person's to install, and the tab says how", () => {
  const depends = /^deb:\n(?:.*\n)*?\s+depends:\n((?:\s+- .+\n)+)/m.exec(builder)?.[1] ?? '';
  const packages = depends.split('\n').map((line) => line.trim().replace(/^- /, '')).filter(Boolean);
  assert.ok(packages.includes('libgtk-3-0'), `the list was read: ${packages.join(', ')}`);
  // Not in Debian's archive, so a dependency would make the package uninstallable on a plain system
  assert.ok(!packages.includes('tailscale'), `deb.depends: ${packages.join(', ')}`);
  // localhost.run's ssh went with the old tunnel
  assert.ok(!packages.includes('openssh-client'), `deb.depends: ${packages.join(', ')}`);
});

test('the guard program ships beside the server, and the shell checks it is there', () => {
  assert.match(builder, /^\s+- server\.mjs\n\s+- mcp\.mjs\n\s+- guard\.mjs\n/m);
  const resources = readFileSync(new URL('../src/resources.ts', import.meta.url), 'utf8');
  assert.match(resources, /guardEntry: join\(process\.resourcesPath, 'server', 'guard\.mjs'\)/);
  assert.match(resources, /existsSync\(res\.guardEntry\)\) missing\.push\(res\.guardEntry\)/);
});

test('node-pty ships beside the terminal host, as its own extraResources entry', () => {
  // electron-builder drops node_modules/ from a filtered copy, so a filter line under ../api/dist shipped
  // nothing and the terminal host could not load node-pty in the packaged app
  assert.match(builder, /- from: \.\.\/api\/dist\/node_modules\/node-pty\n\s+to: server\/node_modules\/node-pty\n/);
  assert.doesNotMatch(builder, /^\s+- node_modules\/node-pty\/\*\*$/m);
});

// --- The apt repository and the unified updates (docs/plans/unified-updates.md, D3-D5, D7) ---

const desktopDir = new URL('../', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
const read = (path: string, base: URL = desktopDir): string => readFileSync(new URL(path, base), 'utf8');
const postinst = read('build/linux/after-install.sh');
const postrm = read('build/linux/after-remove.sh');
const installSh = read('scripts/install.sh', repoRoot);
const APT_FINGERPRINT = '33DC4ECFD40612112D06475843E6487D3DF5098F';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudio-packaging-'));
  roots.push(root);
  return root;
}

const SOURCE = `Types: deb
URIs: https://yeyo11.github.io/claudio/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/claudio-archive-keyring.gpg`;

/**
 * Claudio's part of a maintainer script (from its apt marker on: the apt repository, then the update
 * unit), with the system paths moved under `root` so the real script runs without root. Signed-By,
 * inside the source it writes, keeps the real path.
 */
function aptPart(script: string, root: string): string {
  const marker = "# --- Claudio's apt repository";
  assert.ok(script.includes(marker), 'the apt part is marked');
  assert.ok(script.indexOf("# --- Claudio's update unit") > script.indexOf(marker), 'the update unit part comes after it');
  const part = script.slice(script.indexOf(marker))
    .replaceAll('/etc/apt/sources.list.d', `${root}/etc/apt/sources.list.d`)
    .replaceAll('/etc/apt/preferences.d', `${root}/etc/apt/preferences.d`)
    .replaceAll('/etc/default', `${root}/etc/default`)
    .replace('CLAUDIO_KEYRING=/usr/share/keyrings', `CLAUDIO_KEYRING=${root}/usr/share/keyrings`)
    .replaceAll('/run/systemd/system', `${root}/run/systemd/system`)
    .replaceAll('/usr/share/polkit-1/rules.d', `${root}/usr/share/polkit-1/rules.d`)
    .replaceAll('/var/lib/claudio-update', `${root}/var/lib/claudio-update`);
  return `#!/bin/bash\n${part}`;
}

/**
 * groupadd, usermod, groupdel, getent and systemctl for a fake root: they read and write
 * `root/etc/group` and `root/etc/passwd` and log each call to `root/calls`. They come first on PATH,
 * so no test ever touches the machine's own accounts or systemd.
 */
function stubSystem(root: string): string {
  const bin = join(root, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'etc'), { recursive: true });
  for (const db of ['group', 'passwd']) if (!existsSync(join(root, 'etc', db))) writeFileSync(join(root, 'etc', db), '');
  const stubs: Record<string, string> = {
    getent: `file="${root}/etc/$1"
[ -f "$file" ] || exit 2
field=1
if [ "$1" = passwd ] && [[ "$2" =~ ^[0-9]+$ ]]; then field=3; fi
awk -F: -v f="$field" -v k="$2" '$f == k { print; found = 1 } END { exit !found }' "$file" || exit 2`,
    groupadd: `echo "groupadd $*" >> "${root}/calls"
[ -z "$FAIL_GROUPADD" ] || exit 10
name="\${*: -1}"
if grep -q "^$name:" "${root}/etc/group"; then exit 9; fi
echo "$name:x:999:" >> "${root}/etc/group"`,
    usermod: `echo "usermod $*" >> "${root}/calls"
[ "$1 $2" = "-a -G" ] || exit 2
awk -F: -v OFS=: -v g="$3" -v u="$4" '$1 == g { $4 = ($4 == "" ? u : $4 "," u) } { print }' "${root}/etc/group" > "${root}/group.new"
mv "${root}/group.new" "${root}/etc/group"`,
    groupdel: `echo "groupdel $*" >> "${root}/calls"
grep -q "^$1:" "${root}/etc/group" || exit 6
grep -v "^$1:" "${root}/etc/group" > "${root}/group.new"
mv "${root}/group.new" "${root}/etc/group"`,
    systemctl: `echo "systemctl $*" >> "${root}/calls"`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

let scripts = 0;
/** Runs a maintainer script's Claudio part as dpkg would, with `arg`; answers its stdout and stderr */
function runScript(script: string, root: string, arg: string, env: Record<string, string> = {}): string {
  scripts += 1;
  const file = join(root, `script-${String(scripts)}.sh`);
  writeFileSync(file, aptPart(script, root));
  const path = `${stubSystem(root)}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  const run = spawnSync('bash', [file, arg], { env: { PATH: path, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${arg}: ${run.stderr}`);
  rmSync(file);
  return run.stdout + run.stderr;
}

function packageRoot(): { root: string; source: string; defaults: string; keyring: string } {
  const root = tempRoot();
  mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
  mkdirSync(join(root, 'etc/default'), { recursive: true });
  mkdirSync(join(root, 'usr/share/keyrings'), { recursive: true });
  const keyring = join(root, 'usr/share/keyrings/claudio-archive-keyring.gpg');
  writeFileSync(keyring, readFileSync(new URL('packaging/apt/claudio-archive-keyring.gpg', repoRoot)));
  return { root, source: join(root, 'etc/apt/sources.list.d/claudio.sources'), defaults: join(root, 'etc/default/claudio'), keyring };
}

/** A file's lines without comments and blanks */
const body = (file: string): string => readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).join('\n');

test('the .deb runs our postinst and postrm, and ships the apt keyring, shell.json and the bundle keys', () => {
  assert.match(builder, /^deb:\n(?:.*\n)*?\s+afterInstall: build\/linux\/after-install\.sh\n\s+afterRemove: build\/linux\/after-remove\.sh\n/m);
  assert.match(builder, /- dist\/package\/claudio-archive-keyring\.gpg=\/usr\/share\/keyrings\/claudio-archive-keyring\.gpg\n/);
  assert.match(builder, /- from: dist\/package\/shell\.json\n\s+to: shell\.json\n/);
  assert.match(builder, /- from: \.\.\/\.\.\/docker\/keys\n\s+to: keys\n\s+filter:\n\s+- '\*\.pub'\n/);
  // Staged beside the compiled shell, never packed into app.asar
  assert.match(builder, /^\s+- '!dist\/package\/\*\*'$/m);
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const stage = pkg.scripts['package:stage'] ?? '';
  assert.match(stage, /server-bundle\.mjs --shell-json dist\/package\/shell\.json/);
  // 0644 whatever the checkout's umask: dpkg installs it with the mode it has in the package
  assert.match(stage, /install -m 0644 \.\.\/\.\.\/packaging\/apt\/claudio-archive-keyring\.gpg dist\/package\/claudio-archive-keyring\.gpg/);
  assert.match(pkg.scripts['dist:linux'] ?? '', /pnpm run build && pnpm run package:stage && electron-builder /);
});

test('the AppImage uses the static runtime, which needs fusermount3 and no libfuse2', () => {
  assert.match(builder, /^toolsets:\n\s+appimage: '1\.0\.3'$/m);
});

test('the maintainer scripts keep electron-builder\'s part and use only the macros it defines', () => {
  for (const script of [postinst, postrm]) {
    // electron-builder fails the build on any other ${name}
    const macros = new Set([...script.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]));
    assert.deepEqual([...macros].sort(), ['executable', 'sanitizedProductName']);
  }
  assert.match(postinst, /update-alternatives --install '\/usr\/bin\/\$\{executable\}'/);
  assert.match(postinst, /chmod 4755 '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/);
  assert.match(postinst, /apparmor_parser --replace --write-cache --skip-read-cache/);
  assert.match(postrm, /update-alternatives --remove '\$\{executable\}'/);
  assert.match(postrm, /apparmor_parser --remove/);
  // Root never sources a file someone else wrote
  assert.doesNotMatch(postinst, /^\s*(?:\.|source)\s+\S*default/m);
});

test('postinst configure registers the source once, with its keyring, and records it', () => {
  const { root, source, defaults } = packageRoot();
  runScript(postinst, root, 'configure');
  assert.equal(body(source), SOURCE);
  assert.equal(statSync(source).mode & 0o777, 0o644);
  assert.equal(statSync(defaults).mode & 0o777, 0o644);
  assert.match(readFileSync(defaults, 'utf8'), /^repo_add_once=false$/m);

  // The person deleted it: the next upgrade's configure does not bring it back
  rmSync(source);
  runScript(postinst, root, 'configure');
  assert.equal(existsSync(source), false);
  // No temporary file left beside the sources or the defaults
  assert.deepEqual(readdirSync(join(root, 'etc/apt/sources.list.d')), []);
  assert.deepEqual(readdirSync(join(root, 'etc/default')), ['claudio']);
});

test('postinst runs only on configure, and keeps what an admin wrote in /etc/default/claudio', () => {
  const { root, source, defaults } = packageRoot();
  writeFileSync(defaults, '# mine\nSOMETHING=1\n');
  runScript(postinst, root, 'abort-upgrade');
  assert.equal(existsSync(source), false);
  runScript(postinst, root, 'configure');
  assert.equal(readFileSync(defaults, 'utf8'), '# mine\nSOMETHING=1\nrepo_add_once=false\n');
});

test('CLAUDIO_APT_REPO=off, in the environment or in /etc/default/claudio, skips the registration', () => {
  const env = packageRoot();
  assert.match(runScript(postinst, env.root, 'configure', { CLAUDIO_APT_REPO: 'off' }), /CLAUDIO_APT_REPO=off/);
  assert.equal(existsSync(env.source), false);
  assert.equal(existsSync(env.defaults), false);

  const file = packageRoot();
  writeFileSync(file.defaults, 'CLAUDIO_APT_REPO="off"\n');
  runScript(postinst, file.root, 'configure');
  assert.equal(existsSync(file.source), false);
});

test('postinst writes no source when the keyring is missing, which would break every apt update', () => {
  const { root, source, keyring } = packageRoot();
  rmSync(keyring);
  assert.match(runScript(postinst, root, 'configure'), /is missing, so the apt repository is not registered/);
  assert.equal(existsSync(source), false);
});

test('postrm removes the source on remove and purge, /etc/default/claudio and the apt pin on purge, and nothing on upgrade', () => {
  const { root, source, defaults } = packageRoot();
  // The pin is a file of the package (a conffile): dpkg puts it there, not the postinst
  const pin = join(root, 'etc/apt/preferences.d/claudio.pref');
  mkdirSync(dirname(pin), { recursive: true });
  writeFileSync(pin, read('build/linux/claudio.pref'));
  runScript(postinst, root, 'configure');
  runScript(postrm, root, 'upgrade');
  assert.ok(existsSync(source) && existsSync(defaults) && existsSync(pin), 'an upgrade keeps all three');
  runScript(postrm, root, 'remove');
  assert.equal(existsSync(source), false);
  assert.ok(existsSync(defaults), 'remove keeps /etc/default/claudio');
  assert.ok(existsSync(pin), 'remove keeps the pin, like any conffile');
  runScript(postrm, root, 'purge');
  assert.equal(existsSync(defaults), false);
  assert.equal(existsSync(pin), false, 'purge removes the pin');
});

// --- The update unit's group (docs/plans/remote-updates.md, D2) ---

/** A fake root with two people, a running systemd and the files the package ships */
function unitRoot(): { root: string; group: () => string; calls: () => string[]; rule: string; state: string } {
  const { root } = packageRoot();
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/passwd'), 'root:x:0:0::/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash\nbob:x:1001:1001::/home/bob:/bin/bash\n');
  writeFileSync(join(root, 'etc/group'), 'root:x:0:\nsudo:x:27:alice\n');
  mkdirSync(join(root, 'run/systemd/system'), { recursive: true });
  const rules = join(root, 'usr/share/polkit-1/rules.d');
  mkdirSync(rules, { recursive: true });
  const rule = join(rules, '50-claudio-update.rules');
  writeFileSync(rule, read('build/linux/50-claudio-update.rules'));
  const state = join(root, 'var/lib/claudio-update');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'status.json'), '{}\n');
  const callsFile = join(root, 'calls');
  return {
    root,
    rule,
    state,
    group: () => readFileSync(join(root, 'etc/group'), 'utf8').split('\n').find((line) => line.startsWith('claudio-update:')) ?? '',
    calls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : []),
  };
}

test('postinst creates the claudio-update group, adds the person behind sudo, reloads systemd, and is idempotent', () => {
  const { root, group, calls } = unitRoot();
  assert.match(runScript(postinst, root, 'configure', { SUDO_USER: 'alice' }), /alice may now update Claudio from the app, from their next login on/);
  assert.equal(group(), 'claudio-update:x:999:alice');
  assert.deepEqual(calls(), ['groupadd --system claudio-update', 'usermod -a -G claudio-update alice', 'systemctl --system daemon-reload']);

  // Every upgrade runs configure again: no second group, no second membership
  runScript(postinst, root, 'configure', { SUDO_USER: 'alice' });
  assert.equal(group(), 'claudio-update:x:999:alice');
  assert.deepEqual(calls().slice(3), ['systemctl --system daemon-reload']);

  // Someone else installing later joins beside the first
  runScript(postinst, root, 'configure', { PKEXEC_UID: '1001' });
  assert.equal(group(), 'claudio-update:x:999:alice,bob');
});

test('postinst adds the user behind pkexec, and nobody for root, an unknown account or no installer at all', () => {
  const pkexec = unitRoot();
  runScript(postinst, pkexec.root, 'configure', { PKEXEC_UID: '1001' });
  assert.equal(pkexec.group(), 'claudio-update:x:999:bob');

  const both = unitRoot();
  runScript(postinst, both.root, 'configure', { SUDO_USER: 'alice', PKEXEC_UID: '1001' });
  assert.equal(both.group(), 'claudio-update:x:999:alice', 'SUDO_USER first');

  // The update unit's own upgrade runs as root with neither, and must add nobody
  const nobody: Record<string, string>[] = [{}, { SUDO_USER: 'root' }, { PKEXEC_UID: '0' }, { SUDO_USER: 'ghost' }, { PKEXEC_UID: '4242' }, { SUDO_USER: 'alice:x' }];
  for (const env of nobody) {
    const fake = unitRoot();
    runScript(postinst, fake.root, 'configure', env);
    assert.equal(fake.group(), 'claudio-update:x:999:', JSON.stringify(env));
    assert.ok(!fake.calls().some((call) => call.startsWith('usermod')), JSON.stringify(env));
  }
});

test('postinst survives a groupadd that fails, skips the reload without systemd, and does nothing on abort-*', () => {
  const failing = unitRoot();
  assert.match(runScript(postinst, failing.root, 'configure', { SUDO_USER: 'alice', FAIL_GROUPADD: '1' }), /could not create the claudio-update group/);
  assert.equal(failing.group(), '');
  assert.ok(!failing.calls().some((call) => call.startsWith('usermod')));

  const chroot = unitRoot();
  rmSync(join(chroot.root, 'run/systemd/system'), { recursive: true });
  runScript(postinst, chroot.root, 'configure', { SUDO_USER: 'alice' });
  assert.equal(chroot.group(), 'claudio-update:x:999:alice');
  assert.ok(!chroot.calls().some((call) => call.startsWith('systemctl')));

  const aborted = unitRoot();
  runScript(postinst, aborted.root, 'abort-upgrade', { SUDO_USER: 'alice' });
  assert.deepEqual(aborted.calls(), []);
});

test('postrm keeps the group and the rule on upgrade, removes both on remove, the status on purge, and runs twice cleanly', () => {
  const { root, group, calls, rule, state } = unitRoot();
  runScript(postinst, root, 'configure', { SUDO_USER: 'alice' });
  const configured = calls().length;

  runScript(postrm, root, 'upgrade');
  assert.equal(group(), 'claudio-update:x:999:alice', 'an upgrade keeps the members');
  assert.ok(existsSync(rule) && existsSync(state));
  assert.equal(calls().length, configured);

  runScript(postrm, root, 'remove');
  assert.equal(group(), '');
  assert.equal(existsSync(rule), false);
  assert.ok(existsSync(state), 'remove keeps the last outcome');
  assert.deepEqual(calls().slice(configured), ['groupdel claudio-update', 'systemctl --system daemon-reload']);

  // purge after remove: the group is gone already, so no groupdel and no failure
  runScript(postrm, root, 'purge');
  assert.equal(existsSync(state), false);
  assert.deepEqual(calls().slice(configured + 2), ['systemctl --system daemon-reload']);
});

/** One of install.sh's functions, with the file sourced under CLAUDIO_INSTALL_LIB=1 */
function installFn(script: string, env: Record<string, string> = {}): { code: number; out: string } {
  const run = spawnSync('bash', ['-c', `CLAUDIO_INSTALL_LIB=1 source "$0"; ${script}`, fileURLToPath(new URL('scripts/install.sh', repoRoot))], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  return { code: run.status ?? 1, out: run.stdout };
}

function fakeProc(files: Record<string, string>): string {
  const proc = tempRoot();
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(proc, path)), { recursive: true });
    writeFileSync(join(proc, path), `${value}\n`);
  }
  return proc;
}

test('sourcing install.sh for its functions installs nothing', () => {
  assert.deepEqual(installFn('echo sourced'), { code: 0, out: 'sourced\n' });
});

test('sandboxRootless: the AppImage is the default only where Chromium can sandbox without root', () => {
  const cases: [Record<string, string>, boolean, string][] = [
    [{ 'sys/kernel/apparmor_restrict_unprivileged_userns': '1', 'sys/user/max_user_namespaces': '63000' }, false, 'Ubuntu 24.04 and later'],
    [{ 'sys/kernel/apparmor_restrict_unprivileged_userns': '0', 'sys/user/max_user_namespaces': '63000' }, true, 'the restriction lifted'],
    [{ 'sys/user/max_user_namespaces': '63000' }, true, 'no AppArmor knob (Fedora, Arch)'],
    [{ 'sys/kernel/unprivileged_userns_clone': '0', 'sys/user/max_user_namespaces': '63000' }, false, 'Debian with the clone switch off'],
    [{ 'sys/kernel/unprivileged_userns_clone': '1', 'sys/user/max_user_namespaces': '63000' }, true, 'Debian with it on'],
    [{ 'sys/user/max_user_namespaces': '0' }, false, 'no user namespaces allowed'],
    [{}, false, 'no user namespaces at all'],
  ];
  for (const [files, rootless, what] of cases) {
    assert.equal(installFn(`sandbox_rootless "${fakeProc(files)}"`).code === 0, rootless, what);
  }
});

test('install.sh pins the apt key and every key the release signs with', () => {
  assert.match(installSh, new RegExp(`^APT_FINGERPRINT="${APT_FINGERPRINT}"$`, 'm'));
  const pinned = /<<'KEYS' \|\| true\n([\s\S]*?)\nKEYS\n/.exec(installSh)?.[1] ?? '';
  const keysDir = new URL('docker/keys/', repoRoot);
  const shipped = readdirSync(keysDir).filter((name) => name.endsWith('.pub')).map((name) => readFileSync(new URL(name, keysDir), 'utf8').trim());
  assert.ok(shipped.length > 0);
  for (const key of shipped) assert.ok(pinned.includes(key), 'every docker/keys/*.pub is pinned in install.sh');
});

test('the committed apt keyring holds exactly the pinned key', (t) => {
  if (spawnSync('gpg', ['--version']).status !== 0) {
    t.skip('gpg is not installed');
    return;
  }
  const keyring = fileURLToPath(new URL('packaging/apt/claudio-archive-keyring.gpg', repoRoot));
  assert.equal(installFn(`keyring_fingerprint "${keyring}"`).out.trim(), APT_FINGERPRINT);
});

test('install.sh checks an AppImage against the signed desktop manifest: one line per key, any trusted key passes', () => {
  const dir = tempRoot();
  const trusted = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const manifest = join(dir, 'manifest.json');
  const bytes = Buffer.from(`${JSON.stringify({
    schema: 1,
    version: '0.7.0',
    files: {
      'Claudio-0.7.0-x86_64.AppImage': { size: 3, sha256: 'a'.repeat(64), sha512: 'x' },
      'Claudio-0.7.0-amd64.deb': { size: 4, sha256: 'b'.repeat(64), sha512: 'y' },
    },
  }, null, 2)}\n`);
  writeFileSync(manifest, bytes);
  type Pair = { publicKey: KeyObject; privateKey: KeyObject };
  const keyId = (key: KeyObject): string => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  const line = (pair: Pair, data: Buffer = bytes): string => `${keyId(pair.publicKey)} ${sign(null, data, pair.privateKey).toString('base64')}`;
  const env = { MANIFEST_KEYS_TEST: trusted.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  let checks = 0;
  const check = (sig: string): number => {
    checks += 1;
    const sigFile = join(dir, `${String(checks)}.sig`);
    const keys = join(dir, `keys-${String(checks)}`);
    writeFileSync(sigFile, sig);
    mkdirSync(keys);
    return installFn(`MANIFEST_KEYS="$MANIFEST_KEYS_TEST"; manifest_signed "${manifest}" "${sigFile}" "${keys}"`, env).code;
  };

  assert.equal(check(`${line(trusted)}\n`), 0, 'a keyId line');
  assert.equal(check(`${sign(null, bytes, trusted.privateKey).toString('base64')}\n`), 0, "phase 1's bare base64 line");
  assert.equal(check(`${line(other)}\n${line(trusted)}\n`), 0, 'a rotation: an unknown key first, then a trusted one');
  assert.notEqual(check(`${line(other)}\n`), 0, 'only an unknown key');
  assert.notEqual(check(`${line(trusted, Buffer.from('another manifest'))}\n`), 0, 'a signature over other bytes');
  assert.notEqual(check(''), 0, 'no signature at all');

  assert.equal(installFn(`manifest_sha256 "${manifest}" Claudio-0.7.0-x86_64.AppImage`).out, 'a'.repeat(64));
  assert.equal(installFn(`manifest_sha256 "${manifest}" Claudio-0.7.0-amd64.deb`).out, 'b'.repeat(64));
  assert.equal(installFn(`manifest_sha256 "${manifest}" Claudio-0.6.0-x86_64.AppImage`).out, '');
});

test("install.sh's fallback reads the sha512 electron-builder writes in latest-linux.yml", () => {
  const dir = tempRoot();
  const appImage = createHash('sha512').update('appimage').digest();
  const deb = createHash('sha512').update('deb').digest();
  const yml = join(dir, 'latest-linux.yml');
  writeFileSync(yml, `version: 0.7.0
files:
  - url: Claudio-0.7.0-x86_64.AppImage
    sha512: ${appImage.toString('base64')}
    size: 3
    blockMapSize: 1
  - url: Claudio-0.7.0-amd64.deb
    sha512: ${deb.toString('base64')}
    size: 4
path: Claudio-0.7.0-x86_64.AppImage
sha512: ${appImage.toString('base64')}
releaseDate: '2026-10-18T00:00:00.000Z'
`);
  assert.equal(installFn(`yml_sha512 "${yml}" Claudio-0.7.0-x86_64.AppImage`).out, appImage.toString('hex'));
  assert.equal(installFn(`yml_sha512 "${yml}" Claudio-0.7.0-amd64.deb`).out, deb.toString('hex'));
  assert.equal(installFn(`yml_sha512 "${yml}" missing.AppImage`).out, '');
});

test('neither the shell nor install.sh ever turns off the renderer sandbox', () => {
  const src = new URL('src/', desktopDir);
  for (const name of readdirSync(src).filter((file) => file.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(new URL(name, src), 'utf8'), /no-sandbox/, name);
  }
  assert.doesNotMatch(installSh.replace(/^\s*#.*$/gm, ''), /no-sandbox/);
});
