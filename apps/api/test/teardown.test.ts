import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// A Core holds a database, watchers, timers and child processes; a test file that builds one and
// never shuts it down can keep the test runner alive after its last test (CW-27: `apps/api` hung in
// CI after documents.test.ts, whose teardown only closed the app). `app.close()` does not shut the
// Core down, so every file that makes one says `.shutdown()` too.
const dir = new URL('.', import.meta.url);
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.ts') && name !== 'teardown.test.ts')
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));

test('every test file that builds a Core shuts one down', () => {
  const missing = files
    .filter(({ text }) => {
      const built = text.split('new Core(').length - 1;
      const shut = text.split('.shutdown()').length - 1;
      return built > 0 && shut === 0;
    })
    .map(({ name }) => name);
  assert.deepEqual(missing, []);
});

// `shutdown()` returns once timers and chats are told to stop, and its promise settles once the
// database is closed (R18 of docs/plans/ci-and-regression-open.md). Left unawaited, the next test,
// or the next Core on the same data dir, runs against a database still being closed, and the runner
// can finish the file while rows are still being written. So every call is awaited, on its own line
// or through the `await Promise.all(...)` that holds it.
test('every shutdown() in a test file is awaited', () => {
  const unawaited = files.flatMap(({ name, text }) =>
    text
      .split('\n')
      .map((line, index) => ({ line, at: `${name}:${index + 1}` }))
      .filter(({ line }) => {
        const call = line.indexOf('.shutdown()');
        return call >= 0 && !line.slice(0, call).includes('await ');
      })
      .map(({ at }) => at),
  );
  assert.deepEqual(unawaited, []);
});
