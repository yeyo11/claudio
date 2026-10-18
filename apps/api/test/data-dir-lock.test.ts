import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DATA_DIR_LOCK_FILE } from '@claudio/core';
import { DATA_DIR_LOCKED_EXIT_CODE } from '@claudio/core/launcher/protocol';
import { startServer } from '../src/server.ts';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// On 2026-10-18 a dev server an agent started found the desktop's CLAUDIO_DATA_DIR in its
// environment, opened the desktop's live data, took the desktop's tunnel record for a leftover and
// closed its tunnel. Two real servers on one directory: the second must stop before it reads anything.
test('a second server on a data directory a running one holds exits at once, naming the directory and the holder, and touches nothing', { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claudio-two-servers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const shared = {
    CLAUDE_BIN: '/nonexistent/claude',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
    CLAUDIO_DATA_DIR: dataDir,
    CLAUDIO_CLI_UPDATE_CHECK: 'off',
  };
  const before = Object.fromEntries(Object.keys(shared).map((key) => [key, process.env[key]]));
  Object.assign(process.env, shared);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const first = await startServer({ port: 0, portFallback: false });
  let closed = false;
  t.after(async () => {
    if (!closed) await first.close();
  });
  assert.equal((JSON.parse(readFileSync(join(dataDir, DATA_DIR_LOCK_FILE), 'utf8')) as { pid: number }).pid, process.pid);

  // What the first server's tunnel would have written, and a Tailscale that records any call made to it
  const record = `${JSON.stringify({ port: 8444, host: 'node.tail0000.ts.net', target: first.url })}\n`;
  mkdirSync(join(dataDir, 'tunnel'), { recursive: true });
  writeFileSync(join(dataDir, 'tunnel', 'serve-rule.json'), record);
  const called = join(root, 'tailscale-called');
  const tailscale = join(root, 'tailscale');
  writeFileSync(tailscale, `#!/bin/sh\necho "$@" >> '${called}'\n`);
  chmodSync(tailscale, 0o755);
  const listing = readdirSync(dataDir, { recursive: true }).map(String).sort();

  const second = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: apiRoot,
    env: { PATH: process.env.PATH, HOME: root, PORT: '0', HOST: '127.0.0.1', TAILSCALE_BIN: tailscale, CLAUDIO_TUNNEL: 'on', ...shared },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  second.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  second.stdout.resume();
  const code = await new Promise<number | null>((resolve) => second.once('exit', (exit) => resolve(exit)));

  assert.equal(code, DATA_DIR_LOCKED_EXIT_CODE, stderr);
  assert.ok(stderr.includes(`data directory ${dataDir}`), stderr);
  assert.ok(stderr.includes(`pid ${String(process.pid)}`), stderr);
  assert.ok(!existsSync(called), 'Tailscale was never asked anything');
  assert.equal(readFileSync(join(dataDir, 'tunnel', 'serve-rule.json'), 'utf8'), record);
  assert.deepEqual(readdirSync(dataDir, { recursive: true }).map(String).sort(), listing);

  // The first one still answers, and leaves the directory free when it closes
  assert.equal((await fetch(`${first.url}/api/health`)).status, 200);
  await first.close();
  closed = true;
  assert.ok(!existsSync(join(dataDir, DATA_DIR_LOCK_FILE)));
});
