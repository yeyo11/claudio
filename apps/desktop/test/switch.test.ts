import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { appImagePaths, desktopEntry, fuseUsable, installAppImage, sandboxRootless, switchState } from '../src/switch.ts';

const root = mkdtempSync(join(tmpdir(), 'claudio-switch-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fake /proc with only the files given */
function fakeProc(files: Record<string, string>): string {
  const proc = join(root, `proc-${String((n += 1))}`);
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(proc, path, '..'), { recursive: true });
    writeFileSync(join(proc, path), `${value}\n`);
  }
  return proc;
}

const RESTRICT = 'sys/kernel/apparmor_restrict_unprivileged_userns';
const CLONE = 'sys/kernel/unprivileged_userns_clone';
const MAX = 'sys/user/max_user_namespaces';

test("sandboxRootless: the AppImage is offered only where Chromium's sandbox starts without root", () => {
  // Ubuntu 24.04 and later, this machine among them: restricted, so no switch
  assert.equal(sandboxRootless(fakeProc({ [RESTRICT]: '1', [MAX]: '63000' })), false);
  assert.equal(sandboxRootless(fakeProc({ [RESTRICT]: '0', [MAX]: '63000' })), true);
  // Debian's own switch
  assert.equal(sandboxRootless(fakeProc({ [CLONE]: '0', [MAX]: '63000' })), false);
  assert.equal(sandboxRootless(fakeProc({ [CLONE]: '1', [MAX]: '63000' })), true);
  assert.equal(sandboxRootless(fakeProc({ [MAX]: '0' })), false);
  // Without the count nothing says namespaces exist
  assert.equal(sandboxRootless(fakeProc({})), false);
});

test('FUSE is usable with /dev/fuse and a fusermount on PATH', () => {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fusermount3'), '#!/bin/sh\n');
  chmodSync(join(bin, 'fusermount3'), 0o755);
  assert.equal(fuseUsable({ PATH: bin }, (p) => p === '/dev/fuse'), true);
  assert.equal(fuseUsable({ PATH: bin }, () => false), false);
  assert.equal(fuseUsable({ PATH: join(root, 'empty') }, (p) => p === '/dev/fuse'), false);
});

test('the switch is offered on a .deb only, and says why not elsewhere', () => {
  const ok = { sandboxRootless: true, fuse: true, debInstalled: true };
  assert.deepEqual(switchState({ ...ok, distribution: 'deb' }), { available: true, reason: null, debStillInstalled: false });
  assert.deepEqual(switchState({ ...ok, distribution: 'deb', sandboxRootless: false }), { available: false, reason: 'sandbox-restricted', debStillInstalled: false });
  assert.deepEqual(switchState({ ...ok, distribution: 'deb', fuse: false }), { available: false, reason: 'no-fuse', debStillInstalled: false });
  // After the switch: the AppImage runs, and the .deb it came from is still there to remove
  assert.deepEqual(switchState({ ...ok, distribution: 'appimage' }), { available: false, reason: 'not-deb', debStillInstalled: true });
  assert.deepEqual(switchState({ ...ok, distribution: 'appimage', debInstalled: false }), { available: false, reason: 'not-deb', debStillInstalled: false });
  assert.deepEqual(switchState({ ...ok, distribution: undefined }), { available: false, reason: 'not-deb', debStillInstalled: false });
});

test("the AppImage goes where install.sh puts it, XDG_DATA_HOME respected", () => {
  assert.deepEqual(appImagePaths({}, '/home/me'), {
    appImage: '/home/me/.local/share/claudio/Claudio.AppImage',
    desktopFile: '/home/me/.local/share/applications/claudio.desktop',
    icon: '/home/me/.local/share/icons/hicolor/512x512/apps/claudio.png',
    link: '/home/me/.local/bin/claudio',
  });
  assert.equal(appImagePaths({ XDG_DATA_HOME: '/data' }, '/home/me').appImage, '/data/claudio/Claudio.AppImage');
});

test('the menu entry quotes the path the way the desktop entry spec asks', () => {
  const entry = desktopEntry('/home/me/My "Apps"/Claudio.AppImage');
  assert.match(entry, /^Exec="\/home\/me\/My \\"Apps\\"\/Claudio\.AppImage" %U$/m);
  assert.match(entry, /^StartupWMClass=claudio$/m);
});

test('installing puts the AppImage in place executable, with the entry, the icon and the link; a file of the person stays', () => {
  const home = join(root, 'home');
  const paths = appImagePaths({}, home);
  mkdirSync(join(home, '.local', 'share', 'claudio'), { recursive: true });
  const verified = join(home, '.local', 'share', 'claudio', '.Claudio-0.8.0.download');
  writeFileSync(verified, 'the AppImage');
  const icon = join(root, 'icon.png');
  writeFileSync(icon, 'png');
  const lines: string[] = [];
  installAppImage(verified, paths, icon, (l) => lines.push(l));
  assert.equal(readFileSync(paths.appImage, 'utf8'), 'the AppImage');
  assert.equal(statSync(paths.appImage).mode & 0o777, 0o755);
  assert.equal(readlinkSync(paths.link), paths.appImage);
  assert.match(readFileSync(paths.desktopFile, 'utf8'), /Exec=".*Claudio\.AppImage" %U/);
  assert.equal(readFileSync(paths.icon, 'utf8'), 'png');

  // Again, over a ~/.local/bin/claudio that is the person's own script
  rmSync(paths.link);
  writeFileSync(paths.link, '#!/bin/sh\necho mine\n');
  writeFileSync(verified, 'the AppImage, newer');
  installAppImage(verified, paths, icon, (l) => lines.push(l));
  assert.equal(readFileSync(paths.appImage, 'utf8'), 'the AppImage, newer');
  assert.equal(lstatSync(paths.link).isSymbolicLink(), false);
  assert.ok(lines.some((l) => /not a link/.test(l)));
});
