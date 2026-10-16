import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { type GuardLaunch, findUnsafePath, guardArgv, guardCommand, shellQuote } from '../src/guards/command.ts';

const launch: GuardLaunch = { execPath: '/usr/bin/node', entry: '/opt/claudio/guard.mjs', electron: false, nodeVersion: '22.21.0' };
const SHA = 'a'.repeat(64);

describe('guard command', () => {
  it('runs the guard in a clean environment with quoted paths', () => {
    assert.equal(
      guardCommand(launch, '/data/guards/x.rules.json', SHA),
      `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 '/usr/bin/node' '/opt/claudio/guard.mjs' --rules '/data/guards/x.rules.json' --sha256 ${SHA}`,
    );
  });

  it('adds ELECTRON_RUN_AS_NODE only under Electron', () => {
    assert.ok(!guardCommand(launch, '/r', SHA).includes('ELECTRON_RUN_AS_NODE'));
    assert.ok(guardCommand({ ...launch, electron: true }, '/r', SHA).includes(' ELECTRON_RUN_AS_NODE=1 '));
  });

  it('adds the strip-types flags only for a .ts entry on Node older than 23.6', () => {
    const ts = { ...launch, entry: '/src/main.ts' };
    assert.ok(guardCommand(ts, '/r', SHA).includes('--experimental-strip-types --disable-warning=ExperimentalWarning'));
    assert.ok(!guardCommand({ ...ts, nodeVersion: '23.6.0' }, '/r', SHA).includes('strip-types'));
    assert.ok(!guardCommand({ ...ts, nodeVersion: '24.1.0' }, '/r', SHA).includes('strip-types'));
    assert.ok(guardCommand({ ...ts, nodeVersion: '23.5.9' }, '/r', SHA).includes('strip-types'));
    assert.ok(!guardCommand(launch, '/r', SHA).includes('strip-types'));
  });

  it("writes a quote inside a path as '\\''", () => {
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });

  it('keeps a hostile path one word when a shell reads the command', () => {
    const entry = "/tmp/a b'; echo pwned; '$(id)`x`";
    const rules = "/tmp/r' && echo pwned2 '";
    const command = guardCommand({ ...launch, execPath: '/bin/echo', entry }, rules, SHA);
    // `printf` stands in for `env -i`, printing each word it is given on its own line
    const out = spawnSync('/bin/sh', ['-c', command.replace('/usr/bin/env -i', 'printf %s\\\\n')], { encoding: 'utf8' }).stdout.split('\n');
    assert.ok(out.includes(entry));
    assert.ok(out.includes(rules));
    assert.ok(!out.includes('pwned') && !out.includes('pwned2'));
  });

  it('gives the argv the self-test spawns with no shell', () => {
    assert.deepEqual(guardArgv(launch, '/r', SHA).slice(0, 4), ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8']);
    assert.equal(guardArgv(launch, '/r', SHA).at(-1), SHA);
  });

  it('finds a path with a newline or a NUL', () => {
    assert.equal(findUnsafePath(['/a', '/b\nc']), '/b\nc');
    assert.equal(findUnsafePath(['/a\0']), '/a\0');
    assert.equal(findUnsafePath(['/a', '/b']), null);
  });
});
