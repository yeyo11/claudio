import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

// Every chat, command and check the server starts inherits its environment, so a secret that a
// deployment seeds there must be gone by the time the first one starts.
test('the owner token seeded through the environment is not handed to what the server starts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-server-env-'));
  const seeded = {
    CLAUDE_BIN: '/nonexistent/claude',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: join(root, 'data'),
    CLAUDIO_AUTH_TOKEN: 'owner-token-for-the-test',
    CLAUDIO_DESKTOP_TOKEN: 'desktop-secret-for-the-test',
    CLAUDIO_SECRET_KEY: '0123456789abcdef'.repeat(4),
  };
  const before = Object.fromEntries(Object.keys(seeded).map((key) => [key, process.env[key]]));
  Object.assign(process.env, seeded);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const server = await startServer({ port: 0, portFallback: false });
  t.after(() => server.close());

  for (const key of ['CLAUDIO_AUTH_TOKEN', 'CLAUDIO_DESKTOP_TOKEN', 'CLAUDIO_SECRET_KEY']) {
    assert.equal(process.env[key], undefined, key);
  }
  const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
    env: process.env,
  });
  const names = JSON.parse(child.toString()) as string[];
  assert.deepEqual(names.filter((name) => name === 'CLAUDIO_AUTH_TOKEN' || name === 'CLAUDIO_DESKTOP_TOKEN' || name === 'CLAUDIO_SECRET_KEY'), []);
});
