import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

test('a Core shut down before its chats came back starts nothing once they do, and never queries its closed database', async () => {
  const core = new Core(tempConfig());
  const sql = core.db.connection;
  let closed = false;
  const late: string[] = [];
  // Every query of the boot's continuation goes through these two: a statement is prepared per pass
  for (const name of ['prepare', 'exec'] as const) {
    const original = sql[name].bind(sql) as (text: string) => unknown;
    Object.defineProperty(sql, name, {
      configurable: true,
      value: (text: string) => {
        if (closed) late.push(`${name}: ${text.trim().slice(0, 80)}\n${new Error().stack ?? ''}`);
        return original(text);
      },
    });
  }
  // Before restore settles: the chats it brings back are read on a later turn of the event loop
  const stopping = core.shutdown();
  closed = true;
  await core.restored;
  await stopping;
  // Whatever the boot armed would run its first pass now, on a timer of zero or a promise
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(late, [], 'nothing queried the database after shutdown');
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The server exits once `shutdown` resolves. A `gh` or `glab` probe the detector had started a
// moment before kept running after it and wrote its config home (HOME is the data dir in the
// container and in the packaging test) while that dir was being removed: ENOTEMPTY on a loaded machine.
test('shutting the core down ends the host CLI probes it started, and resolves only once they have exited', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'claudio-shutdown-bin-'));
  const pids = join(bin, 'pids');
  // `exec` keeps the pid: the one written is the process the shutdown has to end
  for (const cli of ['gh', 'glab']) {
    writeFileSync(join(bin, cli), `#!/bin/sh\necho $$ >> '${pids}'\nexec sleep 300\n`);
    chmodSync(join(bin, cli), 0o755);
  }
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before ?? ''}`;
  const core = new Core({ ...tempConfig(), claudeBin: '/nonexistent/claude' });
  try {
    const detected = core.hosts.refresh();
    const started = (): number[] => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    for (let i = 0; i < 200 && started().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const probes = started();
    assert.equal(probes.length, 2, 'both version probes are running');

    await core.shutdown();
    assert.deepEqual(probes.filter(alive), [], 'a probe outlived the shutdown');
    // What the detector was waiting for answers, and nothing new is started after the shutdown
    await detected;
    assert.equal(started().length, 2);
  } finally {
    process.env.PATH = before;
  }
});
