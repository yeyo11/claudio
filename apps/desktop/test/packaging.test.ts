import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
