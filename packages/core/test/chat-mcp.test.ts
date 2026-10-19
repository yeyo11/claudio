import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ClaudeBranches } from '../src/providers/claude-code/branches.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { liveMcpServers, mcpSetServersResult } from '../src/providers/claude-code/mcp.ts';

/** The answer the CLI gave to `mcp_status` on 2.1.300, trimmed: a user server and a claude.ai connector. */
const STATUS = {
  mcpServers: [
    { name: 'rea', status: 'disabled', config: { type: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.5.0', 'mcp'] }, scope: 'user', source: 'user' },
    {
      name: 'claude.ai Claude Docs',
      status: 'connected',
      serverInfo: { name: 'Claude Docs', version: '0.1.0' },
      config: { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_x' },
      scope: 'claudeai',
      source: 'claudeai',
      tools: [
        { name: 'read', annotations: { readOnly: true } },
        { name: 'delete', annotations: { destructive: true } },
        { name: 'update', annotations: {} },
      ],
    },
  ],
};

test("mcp_status is read into the page's servers, without their config", () => {
  const servers = liveMcpServers(STATUS);
  assert.deepEqual(servers, [
    { name: 'rea', label: 'rea', kind: 'server', status: 'disabled', scope: 'user', tools: [], error: null },
    {
      name: 'claude.ai Claude Docs',
      label: 'Claude Docs',
      kind: 'connector',
      status: 'connected',
      scope: 'claudeai',
      tools: [
        { name: 'read', readOnly: true, destructive: false },
        { name: 'delete', readOnly: false, destructive: true },
        { name: 'update', readOnly: false, destructive: false },
      ],
      error: null,
    },
  ]);
  assert.equal(JSON.stringify(servers).includes('npx'), false);
});

test('a status the page does not know reads as unknown, and malformed entries are skipped', () => {
  const servers = liveMcpServers({ mcpServers: [{ name: 'x', status: 'reconnecting' }, { status: 'connected' }, 'nope', { name: 'y', error: 'boom' }] });
  assert.deepEqual(
    servers.map((s) => [s.name, s.status, s.error]),
    [
      ['x', 'unknown', null],
      ['y', 'unknown', 'boom'],
    ],
  );
  assert.deepEqual(liveMcpServers({}), []);
});

test('the session sends mcp_status and mcp_toggle down stdin and reads their answers', async () => {
  const written: Array<Record<string, unknown>> = [];
  const io = { write: (text: string) => void written.push(JSON.parse(text) as Record<string, unknown>), end: () => {}, up: () => true };
  const session = new ClaudeCodeDriver('claude').attach(io, () => {}, new ClaudeBranches());
  const answer = (response: Record<string, unknown> = {}) => {
    const last = written.at(-1) as { request_id: string };
    session.readLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: last.request_id, response } }));
  };

  const status = session.mcpStatus?.();
  assert.deepEqual((written.at(-1) as { request: unknown }).request, { subtype: 'mcp_status' });
  answer(STATUS);
  assert.deepEqual((await status)?.map((s) => s.name), ['rea', 'claude.ai Claude Docs']);

  const toggled = session.mcpToggle?.('rea', true);
  assert.deepEqual((written.at(-1) as { request: unknown }).request, { subtype: 'mcp_toggle', serverName: 'rea', enabled: true });
  answer();
  await toggled;
});

test("the session sends mcp_set_servers and reads the CLI's added, removed and errors", async () => {
  const written: Array<Record<string, unknown>> = [];
  const io = { write: (text: string) => void written.push(JSON.parse(text) as Record<string, unknown>), end: () => {}, up: () => true };
  const session = new ClaudeCodeDriver('claude').attach(io, () => {}, new ClaudeBranches());
  const servers = { claudio: { type: 'stdio', command: 'node', args: ['mcp.mjs'] } };
  const pushed = session.mcpSetServers?.(servers);
  const last = written.at(-1) as { request_id: string; request: unknown };
  assert.deepEqual(last.request, { subtype: 'mcp_set_servers', servers });
  // The answer CLI 2.1.302 gave for configs it could not start
  const recording = JSON.parse(readFileSync(new URL('./fixtures/recordings/claude/mcp-set-servers.json', import.meta.url), 'utf8')) as { steps: Array<{ response?: Record<string, unknown> }> };
  session.readLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: last.request_id, response: recording.steps[4]?.response } }));
  const result = await pushed;
  assert.deepEqual(result?.added, ['broken', 'weird']);
  assert.deepEqual(result?.removed, ['fromfile']);
  assert.match(result?.errors.broken ?? '', /iterable/);
  assert.deepEqual(mcpSetServersResult({ added: 'x', errors: { a: { why: 1 } } }), { added: [], removed: [], errors: { a: '{"why":1}' } });
});
