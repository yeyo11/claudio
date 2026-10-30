import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { RESULT_BUDGET_CHARS } from '../src/render.ts';
import { seed, writeTranscript, type Seeded, type TranscriptLine } from './fixture.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const NO_URL = 'claudio-mcp: CLAUDIO_API_URL is not set; this server only talks to the Claudio that started the chat\n';

let s: Seeded;
let url: string;
before(async () => {
  s = await seed();
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}/api`;
});
after(() => s.close());

function start(env: Record<string, string>): ChildProcessWithoutNullStreams {
  // Only what the test names: nothing of the real environment reaches the child
  return spawn(process.execPath, ['--import', 'tsx', MAIN], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
}

/** The next `count` lines the child writes to stdout */
function lines(child: ChildProcessWithoutNullStreams, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`only got: ${buffer}`)), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const got = buffer.split('\n').filter(Boolean);
      if (got.length >= count) {
        clearTimeout(timer);
        resolve(got);
      }
    });
  });
}

test('over stdio: initialize, tools/list and a call, a bad line, and an exit when stdin closes', async () => {
  const child = start({ CLAUDIO_API_URL: url, CLAUDIO_CHAT_ID: 'chat-1' });
  const got = lines(child, 4);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.write('this is not json\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_work_item', arguments: { item: s.item.key } } })}\n`);
  const [init, list, bad, call] = (await got).map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(init?.result.serverInfo.name, 'claudio');
  assert.equal(list?.result.tools.length, 39, 'nineteen read tools and twenty write tools');
  assert.equal(bad?.error.code, -32700);
  assert.equal(call?.result.isError, false, JSON.stringify(call));
  assert.match(call?.result.content[0].text, /Cart loses items/);
  assert.equal(child.exitCode, null, 'a malformed line must not end the process');
  child.stdin.end();
  assert.deepEqual(await once(child, 'exit'), [0, null]);
});

test('without a usable CLAUDIO_API_URL it exits with 1, says why on stderr and writes nothing to stdout', async () => {
  const envs: Array<Record<string, string>> = [{}, { CLAUDIO_API_URL: '' }, { CLAUDIO_API_URL: 'not-a-url' }, { CLAUDIO_API_URL: 'ftp://x/api' }];
  for (const env of envs) {
    const child = start(env);
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, JSON.stringify(env));
    assert.equal(err, NO_URL);
    assert.equal(out, '');
  }
});

test('over stdio, a 3 000-entry chat and the chat list answer valid JSON under the budget, whatever is asked', async () => {
  const turns = Array.from({ length: 750 }, (_, i): TranscriptLine[] => [
    { role: 'user', content: `step ${i}: ${'u'.repeat(400)}` },
    { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${i}`, name: 'Bash', input: { command: `run ${'c'.repeat(1_500)}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: `out ${'r'.repeat(6_000)}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `done ${i} ${'t'.repeat(2_500)}` }] },
  ]).flat();
  assert.equal(turns.length, 3_000);
  writeTranscript(s.core, s.project.path, 'chat-3000', turns);
  for (let i = 0; i < 40; i++) writeTranscript(s.core, s.project.path, `other-${i}`, [{ role: 'user', content: `${i} ${'q'.repeat(3_000)}` }]);

  const child = start({ CLAUDIO_API_URL: url });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['get_chat', { chatId: 'chat-3000' }],
    ['get_chat', { chatId: 'chat-3000', limit: 50, entries: 'full' }],
    ['get_chat', { chatId: 'chat-3000', limit: 50, before: 100 }],
    ['list_chats', {}],
    ['list_chats', { limit: 50 }],
  ];
  const got = lines(child, calls.length);
  for (const [i, [name, args]] of calls.entries()) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  const replies = (await got).map((l) => JSON.parse(l) as { id: number; result: { isError: boolean; content: Array<{ text: string }> } });
  for (const reply of replies) {
    const [name, args] = calls[reply.id - 1] ?? [];
    const label = `${name} ${JSON.stringify(args)}`;
    assert.equal(reply.result.isError, false, `${label}: ${reply.result.content[0]?.text}`);
    const text = reply.result.content[0]?.text ?? '';
    assert.ok(text.length <= RESULT_BUDGET_CHARS, `${label}: ${text.length} characters`);
    assert.doesNotThrow(() => JSON.parse(text), label);
  }
  // Fifty whole entries cannot fit: the answer says it was cut and how to page
  const full = JSON.parse(replies[1]?.result.content[0]?.text ?? '') as { truncated?: { arrays: number }; hint?: string; result?: { transcript: { total: number } } };
  assert.ok(full.truncated && full.truncated.arrays >= 1, 'the full page was cut by its lists');
  assert.match(full.hint ?? '', /before/);
  assert.equal(full.result?.transcript.total, 3_000);
  const summary = JSON.parse(replies[0]?.result.content[0]?.text ?? '') as { transcript: { entries: unknown[]; olderBefore: number } };
  assert.equal(summary.transcript.entries.length, 10);
  assert.equal(summary.transcript.olderBefore, 2_990);
  child.stdin.end();
  await once(child, 'exit');
});
