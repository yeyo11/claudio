import assert from 'node:assert/strict';
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
  core.shutdown();
  closed = true;
  await core.restored;
  // Whatever the boot armed would run its first pass now, on a timer of zero or a promise
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(late, [], 'nothing queried the database after shutdown');
});
