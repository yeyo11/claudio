// The fake CLI's `mcp:` step: `node --test e2e/fake-cli/mcp.test.mjs`. A file of its own, beside
// claude.test.mjs, so it runs without the git repositories that one makes. It speaks to the fake as the
// wrapper does, with a stub stdio server standing in for Claudio's own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), 'claude');

// Answers `initialize`, refuses the tool `boom` as the API refuses a read, and echoes any other call with the env it was given
const STUB = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } }
    : m.params.name === 'boom' ? { content: [{ type: 'text', text: 'refused by the API' }], isError: true }
    : { content: [{ type: 'text', text: m.params.name + ' ' + JSON.stringify(m.params.arguments) + ' as ' + process.env.STUB_CHAT }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

test('mcp: calls the tool on the server --mcp-config names, with ${VAR} expanded, and refuses what the CLI would', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'claudio-fake-mcp-'));
  writeFileSync(join(dir, 'server.cjs'), STUB);
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [join(dir, 'server.cjs')], env: { STUB_CHAT: '${STUB_CHAT_ID}' } } } }));
  const proc = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', `--mcp-config=${config}`, '--allowedTools=mcp__stub__read,mcp__stub__boom'], {
    cwd: dir,
    env: { ...process.env, STUB_CHAT_ID: 'chat-7', CLAUDIO_FAKE_CLI_SCRIPTS: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((r) => proc.on('exit', r));
  t.after(async () => {
    proc.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const events = [];
  const ended = new Promise((resolveEnd) =>
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'result') resolveEnd(event);
    }),
  );
  proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'mcp: stub read {"owner":"a"}\nmcp: stub boom {}\nmcp: stub write {}\nmcp: other read {}\nsay: Read' } })}\n`);
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error(`no result; saw ${JSON.stringify(events)}`)), 10_000).unref());
  const result = await Promise.race([ended, late]);
  assert.equal(result.result, 'Read');

  const blocks = events.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  const answerOf = (name) => {
    const call = blocks.find((b) => b.type === 'tool_use' && b.name === name);
    assert.ok(call, `a call of ${name}`);
    return blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === call.id);
  };
  const read = answerOf('mcp__stub__read');
  assert.deepEqual([read.content, read.is_error], ['read {"owner":"a"} as chat-7', false]);
  const boom = answerOf('mcp__stub__boom');
  assert.deepEqual([boom.content, boom.is_error], ['refused by the API', true]);
  const write = answerOf('mcp__stub__write');
  assert.deepEqual([write.content, write.is_error], ['Permission to use mcp__stub__write was denied', true]);
  const other = answerOf('mcp__other__read');
  assert.equal(other.is_error, true);
  assert.match(other.content, /No such tool available: mcp__other__read/);
});
